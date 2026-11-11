"""HTTP routes of the control bus (see ``control.py``).

Two kinds of caller, two kinds of route:

- **The page** (same origin, like the rest of the API): ``/api/control/status``, the event stream, ``state`` and
  ``result``. They only work while the bus is on.
- **A client** (an AI, a plugin): ``/api/control/v1/...``, which need ``Authorization: Bearer <token>`` and the level
  the user chose. They only answer to the machine the server runs on, even with ``--lan``.

The token itself is handed (and renewed) only to the page, only from this machine.
"""

from __future__ import annotations

import json
import queue
import select
import socket
import time
import urllib.parse
from typing import TYPE_CHECKING, Any

from . import control_data
from .control import ControlError
from .mcp import PARSE_ERROR, LocalBackend, McpServer
from .settings_routes import _from_this_machine

if TYPE_CHECKING:
    from .server import Handler

PING_SECONDS = 15
WATCH_SECONDS = 0.5  # how often a silent stream looks at whether the page closed it
# the routes that need the token take bigger bodies than the rest of the API: the files of a plugin travel in them
MAX_CONTROL_BODY = 400_000


def _client(handler: Handler, level: str) -> bool:
    """Is this a client allowed to do something of ``level``? Answers the refusal itself when it is not."""
    bus = handler.app.control
    if not _from_this_machine(handler):
        handler._json(403, {"error": "solo se puede hacer desde el propio equipo"})
        return False
    if not bus.check(handler.headers.get("Authorization")):
        handler._send(
            401, json.dumps({"error": "falta el token o no es válido"}).encode(), extra={"WWW-Authenticate": "Bearer"}
        )
        return False
    if not bus.enabled():
        handler._json(403, {"error": "el acceso de IAs está apagado (Ajustes ▸ Acceso de IAs)"})
        return False
    if not bus.allows(level):
        handler._json(403, {"error": f"el nivel elegido no permite esto: hace falta «{level}»"})
        return False
    bus.touch_client()
    return True


def _page(handler: Handler) -> bool:
    if not handler.app.control.enabled():
        handler._json(403, {"error": "el acceso de IAs está apagado"})
        return False
    return True


def _closed(sock: socket.socket) -> bool:
    """Has the other end closed the connection? (Readable with nothing to read is how a close shows.)"""
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        return bool(readable) and sock.recv(1, socket.MSG_PEEK) == b""
    except (OSError, ValueError):
        return True


def _events(handler: Handler) -> None:
    """Server-sent events: the page listens here for the commands clients send."""
    bus = handler.app.control
    sub = bus.subscribe()
    handler.close_connection = True
    try:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        handler.wfile.write(b": conectado\n\n")
        handler.wfile.flush()
        pinged = time.monotonic()
        while bus.enabled() and not handler.app.stop.is_set():
            try:
                item = sub.get(timeout=WATCH_SECONDS)
            except queue.Empty:
                # a page that reloads or goes away must not stay as a ghost that swallows commands until the next ping
                if _closed(handler.connection):
                    break
                if time.monotonic() - pinged >= PING_SECONDS:
                    handler.wfile.write(b": ping\n\n")
                    handler.wfile.flush()
                    pinged = time.monotonic()
                continue
            if item is None:
                break
            data = json.dumps(item, ensure_ascii=False).encode("utf-8")
            handler.wfile.write(b"event: command\ndata: " + data + b"\n\n")
            handler.wfile.flush()
    except (OSError, ValueError):
        pass
    finally:
        bus.unsubscribe(sub)


def _read(handler: Handler, path: str) -> None:
    """The reading routes of a client: channels, the guide of one and the latest ad markers."""
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query)

    def arg(name: str, limit: int = 200) -> str:
        return query.get(name, [""])[0][:limit]

    def number(name: str, default: int) -> int:
        try:
            return int(arg(name, 10))
        except ValueError:
            return default

    app = handler.app
    if path.endswith("/channels"):
        data = control_data.search_channels(
            app, arg("q"), arg("kind", 10), number("limit", control_data.DEFAULT_RESULTS)
        )
        handler._json(200, data)
    elif path.endswith("/guide"):
        try:
            handler._json(200, control_data.guide(app, arg("channel")))
        except ValueError as exc:
            handler._json(404, {"error": str(exc)})
    else:
        handler._json(200, control_data.markers(app, number("limit", 20)))


def _mcp(handler: Handler) -> None:
    """``POST /mcp``: the MCP tools in the app's own process. One JSON-RPC message in; the answer, or 202 if none."""
    handler._body_read = True
    try:
        length = int(handler.headers.get("Content-Length") or 0)
        message = json.loads(handler.rfile.read(length).decode("utf-8")) if 0 < length <= MAX_CONTROL_BODY else None
    except (ValueError, UnicodeDecodeError):
        message = None
    if message is None:
        handler._json(400, McpServer._error(None, PARSE_ERROR, "el cuerpo no es JSON o es demasiado grande"))
        return
    answer = McpServer(LocalBackend(handler.app)).handle(message)
    if answer is None:
        handler._send(202)
    else:
        handler._json(200, answer)


def handle_get(handler: Handler, path: str) -> bool:
    """Answer the control routes that read. ``False`` if ``path`` is not one of them."""
    bus = handler.app.control
    if path == "/api/control/status":
        handler._json(200, bus.status())
    elif path == "/api/control/events":
        if _page(handler):
            _events(handler)
    elif path == "/api/control/token":
        if not _from_this_machine(handler):
            handler._json(403, {"error": "solo se puede hacer desde el propio equipo"})
        elif _page(handler):
            handler._json(200, {"token": bus.token()})
    elif path in ("/api/control/v1/channels", "/api/control/v1/guide", "/api/control/v1/markers"):
        if _client(handler, "read"):
            _read(handler, path)
    elif path == "/mcp":  # the MCP endpoint is for POST: there is no stream of server messages to open
        handler._send(405, json.dumps({"error": "usa POST"}).encode(), extra={"Allow": "POST"})
    elif path == "/api/control/v1/state":
        if _client(handler, "read"):
            state = bus.state()
            if state is None:
                handler._json(503, {"error": "la página de TDT local aún no ha enviado su estado"})
            else:
                handler._json(200, state)
    else:
        return False
    return True


def handle_post(handler: Handler, path: str) -> bool:
    """Answer the control routes that change something. ``False`` if ``path`` is not one of them."""
    bus = handler.app.control
    if path == "/api/control/state":
        if _page(handler):
            handler._json(200, {"ok": bus.accept_state(handler._body() or None)})
    elif path == "/api/control/result":
        if _page(handler):
            body: dict[str, Any] = handler._body(MAX_CONTROL_BODY)
            handler._json(200, {"ok": bus.report(body.get("id"), body.get("ok"), body.get("detail"), body.get("data"))})
    elif path == "/api/control/token/regenerate":
        if not _from_this_machine(handler):
            handler._json(403, {"error": "solo se puede hacer desde el propio equipo"})
        else:
            handler._json(200, {"token": bus.regenerate()})
    elif path == "/mcp":
        if _client(handler, "read"):
            _mcp(handler)
    elif path == "/api/control/v1/command":
        if _client(handler, "read"):  # the level each command needs is checked by the bus
            try:
                handler._json(200, bus.command(handler._body(MAX_CONTROL_BODY)))
            except ControlError as exc:
                handler._json(exc.code, {"error": str(exc)})
    else:
        return False
    return True
