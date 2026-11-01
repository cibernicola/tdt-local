"""HTTP layer: static files, the JSON API and the HLS/audio proxy."""

from __future__ import annotations

import json
import logging
import os
import threading
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import __version__, atresplayer, mediaset
from .ads import web_origin
from .ai import ModelError
from .app import App
from .hls import rewrite_playlist
from .net import Blocked
from .scte_routes import handle_get as scte_get
from .scte_routes import handle_post as scte_post
from .settings_routes import handle_get, handle_post

log = logging.getLogger(__name__)
access_log = logging.getLogger("tdtlocal.access")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json",
}
CSP = (
    "default-src 'self'; img-src 'self' data:; media-src 'self' blob: data:; connect-src 'self'; "
    "worker-src 'self' blob:; script-src 'self'; style-src 'self'; base-uri 'none'; "
    "frame-src https://www.youtube-nocookie.com https://www.youtube.com{web}; "
    "form-action 'none'; frame-ancestors 'none'"
)
MAX_BODY = 16384
MAX_PLAYLIST = 4_000_000
MAX_PROXY_URL = 4096
CHUNK = 65536
PLAYLIST_TYPE = "application/vnd.apple.mpegurl"


class TdtServer(ThreadingHTTPServer):
    """``ThreadingHTTPServer`` that carries the :class:`App` for its handlers."""

    daemon_threads = True
    allow_reuse_address = os.name != "nt"  # on Windows SO_REUSEADDR would allow a second bind to the same port

    def __init__(self, address: tuple[str, int], app: App) -> None:
        self.app = app
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = f"TDTLocal/{__version__}"
    sys_version = ""
    server: TdtServer  # type: ignore[assignment]
    _body_read = False  # the request body was read: otherwise it is dropped before the connection closes

    @property
    def app(self) -> App:
        return self.server.app

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - signature of the base class
        access_log.debug("%s " + format, self.address_string(), *args)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        origin = web_origin(self.app.config)  # the one web the user chose to show during ad breaks
        self.send_header("Content-Security-Policy", CSP.format(web=" " + origin if origin else ""))
        super().end_headers()

    # ---- helpers
    def _send(
        self,
        code: int,
        body: bytes = b"",
        ctype: str = "application/json; charset=utf-8",
        extra: dict[str, str] | None = None,
    ) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj: Any) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), extra={"Cache-Control": "no-store"})

    def _body(self) -> dict[str, Any]:
        self._body_read = True
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if 0 < length <= MAX_BODY:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                return data if isinstance(data, dict) else {}
        except (ValueError, UnicodeDecodeError):
            pass
        return {}

    def _guard(self) -> bool:
        """Reject requests that do not come from our own page (DNS rebinding and cross-site requests)."""
        host = self.headers.get("Host", "")
        if self.app.config.loopback_only:
            try:
                name = (urllib.parse.urlsplit("//" + host).hostname or "").lower()
            except ValueError:
                name = ""
            if name not in ("localhost", "127.0.0.1", "::1"):
                self._json(403, {"error": "host no permitido"})
                return False
        if self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
            self._json(403, {"error": "petición de otro origen"})
            return False
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + host:
            self._json(403, {"error": "origen no permitido"})
            return False
        return True

    # ---- GET
    def do_GET(self) -> None:
        parts = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parts.query)
        if not self._guard():
            return

        def arg(name: str, limit: int = 4096) -> str:
            return query.get(name, [""])[0][:limit]

        app = self.app
        path = parts.path
        if handle_get(self, path) or scte_get(self, path):
            return
        if path == "/api/channels":
            self._json(200, app.channels_payload())
        elif path == "/api/version":
            self._json(200, {"version": __version__, "name": "tdt-local"})
        elif path == "/api/check":
            with app.store.lock:
                self._json(200, dict(app.store.health))
        elif path == "/api/stt":
            try:
                after = int(arg("after", 20))
            except ValueError:
                after = 0
            self._json(200, app.transcriber.poll(arg("s", 40), after))
        elif path == "/api/epg":
            self._json(200, app.epg.payload(arg("id", 200)))
        elif path == "/api/mediaset":
            self._mediaset_resolve(arg("c", 30))
        elif path == "/api/atres":
            self._atres_resolve(arg("c", 30))
        elif path == "/api/mediaset/p":
            self._mediaset_media(arg("u", MAX_PROXY_URL + 1))
        elif path == "/proxy":
            self._proxy(arg("u", MAX_PROXY_URL + 1), arg("c", 100), arg("s", 40))
        elif path == "/logo":
            self._logo(arg("u"))
        else:
            self._static(path)

    do_HEAD = do_GET

    # ---- POST
    def do_POST(self) -> None:
        try:
            self._post()
        finally:
            if not self._body_read:
                self._discard_body()

    def _discard_body(self) -> None:
        """Drop a request body nobody read (a refused request).

        Closing a connection with unread data makes the system reset it, and on Windows the client may then lose the
        response (a 403) it was about to read.
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if 0 < length <= MAX_BODY:
                self.connection.settimeout(5)
                self.rfile.read(length)
        except (ValueError, OSError):
            pass

    def _post(self) -> None:
        if not self._guard():
            return
        parts = urllib.parse.urlsplit(self.path)
        app = self.app
        path = parts.path
        if handle_post(self, path) or scte_post(self, path):
            return
        if path == "/api/stt":
            if not app.transcriber.available():
                self._json(404, {"error": "la transcripción no está disponible"})
                return
            body = self._body()
            app.transcriber.set_session(str(body.get("s") or ""), bool(body.get("on")))
            self._json(200, {"ok": True})
        elif path == "/api/ai":
            self._ask_ai()
        elif path == "/api/mediaset/license":
            self._mediaset_license(urllib.parse.parse_qs(parts.query).get("u", [""])[0][:MAX_PROXY_URL])
        elif path == "/api/custom":
            try:
                self._json(200, {"ok": True, "id": app.store.add_custom(self._body())})
            except ValueError as exc:
                self._json(400, {"ok": False, "error": str(exc)})
        elif path == "/api/quit":
            if not app.config.allow_quit:
                self._json(404, {"error": "no existe"})
                return
            self._json(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True, name="quit").start()
        elif path == "/api/custom/delete":
            self._json(200, {"ok": app.store.delete_custom(str(self._body().get("id") or ""))})
        elif path == "/api/refresh":
            try:
                result = dict(app.feeds.sync(force=True), ok=True)
                if app.config.epg_enabled:
                    app.epg.sync(force=True)
                self._json(200, result)
            except Exception as exc:
                self._json(502, {"ok": False, "error": str(exc)})
        elif path == "/api/check":
            kind = urllib.parse.parse_qs(parts.query).get("kind", ["tv"])[0]
            self._json(200, {"started": app.health.start(kind if kind in ("tv", "radio", "all") else "tv")})
        else:
            self._json(404, {"error": "no existe"})

    def _ask_ai(self) -> None:
        app = self.app
        if not app.config.ai_enabled:
            self._json(404, {"error": "la IA está desactivada (--no-ai)"})
            return
        body = self._body()
        try:
            self._json(200, app.assistant.ask(body.get("q"), body.get("kind") or "tv"))
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except urllib.error.HTTPError as exc:
            self._json(502, {"error": f"el modelo devolvió HTTP {exc.code}"})
        except ModelError as exc:
            self._json(502, {"error": str(exc)})
        except OSError:
            self._json(502, {"error": f"el modelo no responde en {app.config.llm_url}"})
        except Exception as exc:
            self._json(502, {"error": f"respuesta del modelo no válida ({type(exc).__name__})"})

    # ---- Mediaset (the browser's own Widevine does the decrypting; we only relay opaque bytes)
    def _mediaset_resolve(self, channel: str) -> None:
        try:
            self._json(200, mediaset.resolve(self.app.net, channel))
        except ValueError as exc:
            self._json(404, {"error": str(exc)})
        except Exception as exc:
            self._json(502, {"error": f"Mediaset: {type(exc).__name__}: {exc}"})

    def _atres_resolve(self, channel: str) -> None:
        try:
            url = atresplayer.resolve(self.app.net, channel)
        except ValueError as exc:
            self._json(404, {"error": str(exc)})
            return
        except Exception as exc:
            self._json(502, {"error": f"Atresplayer: {type(exc).__name__}: {exc}"})
            return
        self.app.net.allow(url)  # the proxy only serves hosts it has been told about
        self._json(200, {"url": url})

    def _mediaset_media(self, url: str) -> None:
        try:
            response = mediaset.open_media(self.app.net, url, self.headers.get("Range", ""))
        except ValueError as exc:
            self._json(403, {"error": str(exc)})
            return
        except urllib.error.HTTPError as exc:
            self._json(exc.code if 400 <= exc.code < 600 else 502, {"error": f"origen: HTTP {exc.code}"})
            return
        except Exception as exc:
            self._json(502, {"error": f"origen: {type(exc).__name__}"})
            return
        try:
            with response:
                body = response.read()
            if urllib.parse.urlsplit(url).path.lower().endswith(".mpd"):
                body = mediaset.prepare_mpd(body, url)
            self._send(
                200,
                body,
                response.headers.get("Content-Type", "application/octet-stream"),
                {"Cache-Control": "no-store"},
            )
        except OSError:
            pass

    def _mediaset_license(self, url: str) -> None:
        self._body_read = True
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= MAX_BODY:
                raise ValueError("petición no válida")
            licence = mediaset.relay_license(self.app.net, url, self.rfile.read(length))
            self._send(200, licence, "application/octet-stream", {"Cache-Control": "no-store"})
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except urllib.error.HTTPError as exc:
            self._json(exc.code if 400 <= exc.code < 600 else 502, {"error": f"licencia: HTTP {exc.code}"})
        except Exception as exc:
            self._json(502, {"error": f"licencia: {type(exc).__name__}"})

    # ---- static files and logos
    def _static(self, path: str) -> None:
        root = self.app.config.static_dir.resolve()
        try:
            target = (root / (urllib.parse.unquote(path).lstrip("/") or "index.html")).resolve()
            target.relative_to(root)
            if not target.is_file():
                raise FileNotFoundError
            stat = target.stat()
        except (ValueError, OSError):
            self._send(404, b'{"error":"no existe"}')
            return
        etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        self._send(
            200,
            target.read_bytes(),
            CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream"),
            {"ETag": etag, "Cache-Control": "no-cache"},
        )

    def _logo(self, url: str) -> None:
        logo = self.app.logos.get(url)
        if logo is None:
            self._send(404, b"")
            return
        self._send(200, logo[1], logo[0], {"Cache-Control": "public, max-age=86400"})

    # ---- proxy
    def _proxy(self, url: str, channel_tag: str = "", session_tag: str = "") -> None:
        if not url or len(url) > MAX_PROXY_URL:
            self._json(400, {"error": "falta u"})
            return
        app = self.app
        headers = {}
        if self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]
        headers.update(app.store.custom_headers.get(channel_tag, {}))
        try:
            response = app.net.open(url, headers, True, 20)
        except Blocked as exc:
            self._json(403, {"error": str(exc)})
            return
        except urllib.error.HTTPError as exc:
            self._json(exc.code if 400 <= exc.code < 600 else 502, {"error": f"origen: HTTP {exc.code}"})
            return
        except Exception as exc:
            self._json(502, {"error": f"origen: {type(exc).__name__}"})
            return
        try:
            with response:
                final = response.geturl()
                app.net.allow(final)
                ctype = response.headers.get("Content-Type", "")
                head = b""
                is_playlist = (
                    urllib.parse.urlsplit(final).path.lower().endswith((".m3u8", ".m3u")) or "mpegurl" in ctype.lower()
                )
                if not is_playlist:
                    head = response.read(7)
                    is_playlist = head == b"#EXTM3U"
                if is_playlist:
                    text = (head + response.read(MAX_PLAYLIST)).decode("utf-8", "replace").lstrip("﻿")
                    app.scte.observe(final, text, channel_tag)
                    out = rewrite_playlist(text, final, channel_tag, session_tag, on_url=app.net.allow)
                    self._send(200, out.encode("utf-8"), PLAYLIST_TYPE, {"Cache-Control": "no-store"})
                else:
                    self._relay(response, ctype, head, final, session_tag)
        except (OSError, ValueError):
            pass  # the browser switched channel or the origin dropped the connection

    def _relay(self, response: Any, ctype: str, head: bytes, final: str, session_tag: str) -> None:
        """Pass a segment or audio stream through, copying it to the transcriber if the session asked for it."""
        self.send_response(response.status)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        for key in ("Content-Length", "Content-Range", "Accept-Ranges"):
            if response.headers.get(key):
                self.send_header(key, response.headers[key])
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        tap = None
        if session_tag and response.status == 200:
            has_length = bool(response.headers.get("Content-Length"))
            tap = self.app.transcriber.tap(session_tag, final, ctype, has_length, head)
        if head:
            self.wfile.write(head)
        while True:
            chunk = response.read(CHUNK)
            if not chunk:
                break
            self.wfile.write(chunk)
            if tap:
                tap.feed(chunk)
        if tap:
            tap.finish()


def create_server(app: App) -> TdtServer:
    """Bind the HTTP server. Raises :class:`OSError` if the port is taken."""
    return TdtServer((app.config.host, app.config.port), app)
