"""Outbound HTTP with SSRF protection.

Everything the browser asks the proxy to fetch goes through :class:`Net`: only hosts that appear in
the channel lists (or that a validated stream redirected to) are allowed, and addresses that are not
globally routable are always refused.
"""

from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections.abc import Iterable
from email.message import Message
from pathlib import Path
from typing import IO, Any

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
DEFAULT_HEADERS = {"User-Agent": USER_AGENT, "Accept": "*/*", "Accept-Encoding": "identity"}
DNS_CACHE_SECONDS = 30


# Where Linux distributions and macOS keep the system CA bundle (used when Python's own default path is empty,
# as in a frozen app built against another machine's OpenSSL).
CA_BUNDLES = (
    "/etc/ssl/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
)


def create_ssl_context(bundles: tuple[str, ...] = CA_BUNDLES) -> ssl.SSLContext:
    """A verifying TLS context that also works in a frozen app.

    Windows loads its certificate store by itself. Elsewhere, if OpenSSL's default location holds no
    certificates, fall back to the system bundles above and then to ``certifi`` when it is installed.
    """
    context = ssl.create_default_context()
    paths = ssl.get_default_verify_paths()
    has_default = (paths.cafile and Path(paths.cafile).is_file()) or (paths.capath and Path(paths.capath).is_dir())
    if has_default or sys.platform == "win32":
        return context
    for bundle in bundles:
        if Path(bundle).is_file():
            context.load_verify_locations(cafile=bundle)
            return context
    try:
        import certifi  # type: ignore[import-not-found]  # optional: bundled by the macOS installer
    except ImportError:
        return context
    context.load_verify_locations(cafile=certifi.where())
    return context


# Opener that ignores system proxies: used for the AI and Whisper servers (local, or a hosted OpenAI-style API).
LOCAL_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=create_ssl_context())
)


class Blocked(Exception):
    """The URL was refused by the safety rules (message is shown to the user)."""


def host_of(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


class _RedirectGuard(urllib.request.HTTPRedirectHandler):
    """Re-validates every redirect target and adds it to the allowed hosts."""

    def __init__(self, net: Net, strip: Iterable[str] = ()) -> None:
        self.net = net
        self.strip = {name.lower() for name in strip}  # headers that must not follow a redirect to another host

    def redirect_request(
        self, req: Any, fp: IO[bytes], code: int, msg: str, headers: Message, newurl: str
    ) -> urllib.request.Request | None:
        self.net.check_url(newurl, require_allowed=False)
        self.net.allow(newurl)
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and self.strip and host_of(newurl) != host_of(req.full_url):
            for store in (new.headers, new.unredirected_hdrs):
                for name in [k for k in store if k.lower() in self.strip]:
                    del store[name]
        return new


def _connect(net: Net, host: str, port: int, timeout: Any, source_address: Any) -> socket.socket:
    """A socket to ``host`` that only ever uses the addresses ``net`` has checked (see :meth:`Net.resolve`)."""
    failure: OSError | None = None
    for family, kind, proto, _name, address in net.resolve(host, port):
        sock = socket.socket(family, kind, proto)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:  # type: ignore[attr-defined]
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(address)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            return sock
        except OSError as exc:
            sock.close()
            failure = exc
    raise failure or OSError(f"sin direcciones para {host}")


def _pinned(base: type[http.client.HTTPConnection], net: Net) -> type[http.client.HTTPConnection]:
    """``base`` (plain or TLS) with a ``connect`` that goes through :func:`_connect`."""

    class Pinned(base):  # type: ignore[valid-type, misc]
        def connect(self) -> None:
            sock = _connect(net, self.host, self.port, self.timeout, self.source_address)
            if isinstance(self, http.client.HTTPSConnection):
                sock = self._context.wrap_socket(sock, server_hostname=self.host)  # type: ignore[attr-defined]
            self.sock = sock

    return Pinned


class _PinnedHTTP(urllib.request.HTTPHandler):
    def __init__(self, net: Net) -> None:
        super().__init__()
        self._connection = _pinned(http.client.HTTPConnection, net)

    def http_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(self._connection, req)  # type: ignore[arg-type]


class _PinnedHTTPS(urllib.request.HTTPSHandler):
    def __init__(self, net: Net, context: ssl.SSLContext) -> None:
        super().__init__(context=context)
        self._connection = _pinned(http.client.HTTPSConnection, net)

    def https_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(self._connection, req, context=self._context)  # type: ignore[arg-type, attr-defined]


class Net:
    """Allow-list of hosts plus a guarded ``urlopen``."""

    def __init__(self, allow_private: bool = False) -> None:
        self.allow_private = allow_private
        self.hosts: set[str] = set()
        self._ctx = create_ssl_context()
        self._dns: dict[tuple[str, int], tuple[float, list[Any]]] = {}
        self._lock = threading.Lock()

    def allow(self, url: str) -> None:
        host = host_of(url)
        if host:
            with self._lock:
                self.hosts.add(host)

    def is_allowed(self, host: str) -> bool:
        with self._lock:
            return host in self.hosts

    def check_url(self, url: str, require_allowed: bool) -> urllib.parse.SplitResult:
        """Validate scheme, host allow-list and resolved addresses. Raises :class:`Blocked`."""
        try:
            parts = urllib.parse.urlsplit(url)
            port = parts.port
        except ValueError as exc:
            raise Blocked("URL no válida") from exc
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise Blocked("esquema no permitido")
        host = parts.hostname.lower()
        if require_allowed and not self.is_allowed(host):
            raise Blocked(f"host fuera de las listas: {host}")
        try:
            self.resolve(host, port or (443 if parts.scheme == "https" else 80))
        except socket.gaierror as exc:
            if urllib.request.getproxies().get(parts.scheme):
                return parts  # the system proxy resolves it
            raise Blocked(f"no resuelve: {host}") from exc
        return parts

    def resolve(self, host: str, port: int) -> list[Any]:
        """The addresses of ``host``, every one checked to be public (unless private ones are allowed), kept for a short
        while so that a segment does not cost a DNS lookup. A connection made by :meth:`open` uses exactly these, so a
        host that answers a public address now and a private one a moment later (DNS rebinding) is never reached.
        Raises :class:`Blocked`, or ``socket.gaierror`` if the name does not resolve."""
        key = (host, port)
        with self._lock:
            hit = self._dns.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        for info in infos:
            if not self.allow_private and not ipaddress.ip_address(info[4][0].split("%")[0]).is_global:
                raise Blocked("dirección no pública")
        with self._lock:
            self._dns[key] = (time.time() + DNS_CACHE_SECONDS, infos)
        return infos

    def open(
        self,
        url: str,
        headers: dict[str, str] | None = None,
        require_allowed: bool = True,
        timeout: float = 20,
        strip_on_redirect: Iterable[str] = (),
    ) -> Any:
        """Open ``url`` after validating it. The caller must close the response. The headers in ``strip_on_redirect``
        (the ones that may be credentials) are not sent on to another host if the origin redirects there."""
        url = url.replace(" ", "%20")
        self.check_url(url, require_allowed)
        handlers: list[Any] = [_RedirectGuard(self, strip_on_redirect)]
        if urllib.request.getproxies().get(urllib.parse.urlsplit(url).scheme):
            handlers.append(urllib.request.HTTPSHandler(context=self._ctx))  # a system proxy makes the connection
        else:
            handlers += [_PinnedHTTP(self), _PinnedHTTPS(self, self._ctx)]
        opener = urllib.request.build_opener(*handlers)
        merged = dict(DEFAULT_HEADERS)
        merged.update(headers or {})
        return opener.open(urllib.request.Request(url, headers=merged), timeout=timeout)

    def stream_trusted(self, url: str, headers: dict[str, str] | None = None, timeout: float = 30) -> Any:
        """Open a fixed, program-defined URL (a model download) for streaming. The caller closes the response."""
        merged = dict(DEFAULT_HEADERS)
        merged.update(headers or {})
        return urllib.request.urlopen(urllib.request.Request(url, headers=merged), timeout=timeout, context=self._ctx)

    def fetch_trusted(
        self, url: str, headers: dict[str, str] | None = None, timeout: float = 30, limit: int = 8_000_000
    ) -> tuple[bytes, Message]:
        """Download an operator-configured source (lists, guides). No allow-list: the URL comes from the CLI.

        Returns ``(body, headers)``; the body is read up to ``limit + 1`` bytes so callers can detect overflow.
        Raises :class:`urllib.error.HTTPError` on HTTP errors (including 304).
        """
        merged = dict(DEFAULT_HEADERS)
        merged.update(headers or {})
        request = urllib.request.Request(url, headers=merged)
        with urllib.request.urlopen(request, timeout=timeout, context=self._ctx) as response:
            return response.read(limit + 1), response.headers
