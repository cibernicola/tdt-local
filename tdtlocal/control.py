"""The control bus: how something that is not the page (an AI, a plugin) sees what is being watched and asks the page
to do things. Design and limits in docs/PLUGINS.md.

The state of the player lives in the page, not here, so the bus has two halves:

- the **page** (same origin, like the rest of the API) publishes a snapshot of its state and listens for commands on an
  event stream, and answers each one;
- a **client** (anything with the token) reads that snapshot and sends commands, which wait for the page's answer.

Everything is off until the user turns it on (``control_enabled``) and a client only gets what the chosen level allows:
``read`` (what is on) or ``control`` (also play, volume...). The token lives in a file of the data folder: it keeps web
pages and other users out, not another program running as the same user (that one could read the file; this is a
local tool).
"""

from __future__ import annotations

import collections
import contextlib
import hmac
import json
import logging
import os
import queue
import re
import secrets
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import control_data
from . import headers as hdr
from . import rules as rules_mod

if TYPE_CHECKING:
    from .config import Config

log = logging.getLogger(__name__)

TOKEN_FILE = "control-token"  # noqa: S105 - the name of a file, not a password
LEVELS = ("read", "control", "dev")  # each one includes the ones before it
LEVEL_RANK = {level: rank for rank, level in enumerate(LEVELS)}
KINDS = ("tv", "radio", "u7d")
MAX_NAME = 120
MAX_ID = 200
MAX_TILES = 4
COMMAND_TIMEOUT = 8.0  # seconds a client waits for the page to answer
# commands that end in a question to the user, who needs time to read the code before answering
COMMAND_TIMEOUTS = {
    "dev_write": 180.0,
    "dev_activate": 180.0,
    "dev_read": 20.0,
    "dev_list": 20.0,
    "dev_logs": 20.0,
    "plugin_enable": 180.0,  # ends in a question to the user
    "plugin_permission": 180.0,
    "plugin_config": 180.0,  # ends in a question to the user
    "plugin_write": 180.0,  # ends in a question to the user, who reads the code
    "headers_set": 180.0,  # ends in a question to the user, who reads the headers
    "headers_get": 20.0,
    "rules_set": 180.0,  # ends in a question to the user, who reads the rules
    "rules_get": 20.0,
    "events_get": 20.0,
    "plugin_calls": 20.0,
    "plugin_read": 20.0,
    "plugin_list": 20.0,
    "plugin_logs": 20.0,
    "plugin_disable": 20.0,
}
MAX_DATA = 300_000  # bytes of JSON the page may send back with an answer (the files of a plugin)

# development plugins (docs/PLUGINS.md): what a client may name and how much it may send
DEV_ID = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$")  # a folder name: no dots at the start, so no «..»
DEV_FILE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*){0,2}$")
DEV_EXTENSIONS = (".js", ".mjs", ".json", ".css", ".html", ".svg", ".txt", ".md")
DEV_MAX_FILES = 12
DEV_MAX_FILE_BYTES = 65_536
DEV_MAX_TOTAL_BYTES = 262_144
DEV_MAX_NAME = 100
# plugins with permissions (docs/HACER-PLUGINS.md): the id of a plugin is a folder name in lowercase,
# and a permission is a name or «network:host»
PLUGIN_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
PLUGIN_PERMISSION = re.compile(
    r"^(?:[a-z]+(?:\.[a-z]+)?|provide:(?:channels|epg)|network:[a-z0-9.*-]{1,120}|embed:[a-z0-9.-]{1,120})$"
)
PLUGIN_READS = (
    "plugin_list",
    "plugin_logs",
    "headers_get",
    "rules_get",
    "events_get",
    "plugin_calls",
)  # these only look: the level «read» is enough
RECENT_SECONDS = 60  # a client that asked within this time counts as connected
AUDIT_KEEP = 50
MAX_DETAIL = 300


class ControlError(Exception):
    """A request the bus refuses; ``code`` is the HTTP status that fits."""

    def __init__(self, message: str, code: int = 400) -> None:
        super().__init__(message)
        self.code = code


def _text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _number(value: Any, low: float, high: float, default: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:  # a NaN is not equal to itself
        return default
    return max(low, min(high, float(value)))


def clean_state(raw: Any) -> dict[str, Any] | None:
    """What the page said, reduced to known fields of known types and sizes. ``None`` if it is not even an object."""
    if not isinstance(raw, dict):
        return None
    tiles = []
    for item in (raw.get("tiles") if isinstance(raw.get("tiles"), list) else [])[:MAX_TILES]:
        if not isinstance(item, dict):
            continue
        tiles.append(
            {
                "slot": int(_number(item.get("slot"), 0, MAX_TILES - 1, 0)),
                "id": _text(item.get("id"), MAX_ID),
                "name": _text(item.get("name"), MAX_NAME),
                "kind": item.get("kind") if item.get("kind") in KINDS else "tv",
            }
        )
    vol = raw.get("vol") if isinstance(raw.get("vol"), dict) else {}
    rot = raw.get("rot") if isinstance(raw.get("rot"), dict) else {}
    u7d = raw.get("u7d") if isinstance(raw.get("u7d"), dict) else None
    return {
        "kind": raw.get("kind") if raw.get("kind") in KINDS else "tv",
        "mode": raw.get("mode") if raw.get("mode") in ("single", "multi") else "single",
        "layout": raw.get("layout") if raw.get("layout") in ("mosaic", "focus") else "mosaic",
        "focus": int(_number(raw.get("focus"), 0, MAX_TILES - 1, 0)),
        "vol": {"v": round(_number(vol.get("v"), 0, 1, 1), 3), "m": vol.get("m") is True},
        "rot": {"on": rot.get("on") is True, "secs": int(_number(rot.get("secs"), 5, 600, 20))},
        "tiles": tiles,
        "u7d": {"channel": _text(u7d.get("channel"), MAX_NAME)} if u7d else None,
    }


def _dev_id(raw: dict[str, Any]) -> str:
    value = raw.get("id")
    if not isinstance(value, str) or not DEV_ID.match(value):
        raise ControlError("«id» es el nombre de la carpeta del plugin: letras, números, punto, guion y guion bajo")
    return value


def _channel_ref(raw: dict[str, Any]) -> str:
    value = _text(raw.get("channel"), MAX_NAME)
    if not value:
        raise ControlError("«channel» es el id o el nombre del canal")
    return value


def _plugin_id(raw: dict[str, Any]) -> str:
    value = raw.get("id")
    if not isinstance(value, str) or not PLUGIN_ID.match(value):
        raise ControlError("«id» es el nombre de la carpeta del plugin: minúsculas, números y guiones")
    return value


def _dev_files(raw: dict[str, Any]) -> dict[str, str | None]:
    files = raw.get("files")
    if not isinstance(files, dict) or not 1 <= len(files) <= DEV_MAX_FILES:
        raise ControlError(f"«files» necesita de 1 a {DEV_MAX_FILES} archivos (nombre: texto; null para borrar)")
    clean: dict[str, str | None] = {}
    total = 0
    for name, content in files.items():
        if not isinstance(name, str) or len(name) > DEV_MAX_NAME or not DEV_FILE.match(name):
            raise ControlError(
                f"nombre de archivo no válido: «{str(name)[:60]}» (sin «..», sin rutas absolutas, hasta 3 niveles)"
            )
        if not name.lower().endswith(DEV_EXTENSIONS):
            raise ControlError(f"«{name}»: solo se admiten archivos {', '.join(DEV_EXTENSIONS)}")
        if content is not None and not isinstance(content, str):
            raise ControlError(f"«{name}» tiene que ser texto (o null para borrarlo)")
        size = len(content.encode("utf-8")) if content else 0
        if size > DEV_MAX_FILE_BYTES:
            raise ControlError(f"«{name}» pesa más de {DEV_MAX_FILE_BYTES // 1024} KB")
        total += size
        clean[name] = content
    if total > DEV_MAX_TOTAL_BYTES:
        raise ControlError(f"los archivos pesan más de {DEV_MAX_TOTAL_BYTES // 1024} KB en total")
    return clean


def command_level(cmd: dict[str, Any]) -> str:
    """The level a clean command needs: looking at the plugins needs «read»; the ones that change them or are about
    development plugins need «dev»; the rest «control»."""
    do = str(cmd.get("do", ""))
    if do in PLUGIN_READS:
        return "read"
    return "dev" if do.startswith(("dev_", "plugin_", "headers_")) else "control"


def _limit(raw: dict[str, Any]) -> int:
    limit = raw.get("limit", 50)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
        raise ControlError("«limit» son las líneas que quieres, de 1 a 200")
    return limit


def _play(raw: dict[str, Any]) -> dict[str, Any]:
    channel = _text(raw.get("channel"), MAX_NAME)
    if not channel:
        raise ControlError("«play» necesita «channel» (nombre o id del canal)")
    return {"do": "play", "channel": channel}


def _kind(raw: dict[str, Any]) -> dict[str, Any]:
    if raw.get("kind") not in KINDS:
        raise ControlError("«kind» tiene que ser tv, radio o u7d")
    return {"do": "kind", "kind": raw["kind"]}


def _volume(raw: dict[str, Any]) -> dict[str, Any]:
    value = raw.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
        raise ControlError("«volume» necesita «value» entre 0 y 1")
    return {"do": "volume", "value": round(float(value), 3)}


def _mute(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw.get("on"), bool):
        raise ControlError("«mute» necesita «on» (true o false)")
    return {"do": "mute", "on": raw["on"]}


def _multi(raw: dict[str, Any]) -> dict[str, Any]:
    channels = raw.get("channels")
    if not isinstance(channels, list) or not 1 <= len(channels) <= MAX_TILES:
        raise ControlError(f"«multi» necesita «channels»: de 1 a {MAX_TILES} nombres o ids")
    names = [_text(c, MAX_NAME) for c in channels]
    if not all(names):
        raise ControlError("«channels» solo puede llevar nombres o ids de canal")
    rotate = raw.get("rotate")
    if rotate is not None and (isinstance(rotate, bool) or not isinstance(rotate, int) or not 5 <= rotate <= 600):
        raise ControlError("«rotate» son los segundos entre canales, de 5 a 600")
    return {"do": "multi", "channels": names, "rotate": rotate}


def _headers_set(raw: dict[str, Any]) -> dict[str, Any]:
    changes = raw.get("headers")
    if not isinstance(changes, dict) or not changes:
        raise ControlError("«headers» necesita al menos una cabecera: {nombre: valor}; con null se quita una")
    try:
        hdr.merge({}, changes)  # the same checks as the server applies when it saves them
    except ValueError as exc:
        raise ControlError(str(exc)) from exc
    return {
        "do": "headers_set",
        "channel": _channel_ref(raw),
        "headers": {str(k): (None if v is None else str(v)) for k, v in changes.items()},
        "replace": raw.get("replace") is True,
    }


def _plugin_permission(raw: dict[str, Any]) -> dict[str, Any]:
    permission = raw.get("permission")
    if not isinstance(permission, str) or not PLUGIN_PERMISSION.match(permission):
        raise ControlError("«permission» es un permiso del plugin, como storage o network:api.ejemplo.com")
    if not isinstance(raw.get("on"), bool):
        raise ControlError("«on» tiene que ser true (volver a darlo) o false (quitarlo)")
    return {"do": "plugin_permission", "id": _plugin_id(raw), "permission": permission, "on": raw["on"]}


def _rules_set(raw: dict[str, Any]) -> dict[str, Any]:
    try:
        # the same checks as the server applies when it saves them
        rules = rules_mod.clean_rules(raw.get("rules"), strict=True)
    except ValueError as exc:
        raise ControlError(str(exc)) from exc
    return {"do": "rules_set", "rules": rules}


def _events_get(raw: dict[str, Any]) -> dict[str, Any]:
    limit = raw.get("limit", 30)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ControlError("«limit» son los eventos que quieres, de 1 a 100")
    name = raw.get("name", "")
    if not isinstance(name, str) or (name and name not in control_data.commands_spec()["events"]):
        raise ControlError("«name» es un evento de los que hay: " + ", ".join(control_data.commands_spec()["events"]))
    return {"do": "events_get", "limit": limit, "name": name}


def _plugin_config(raw: dict[str, Any]) -> dict[str, Any]:
    values = raw.get("values")
    if not isinstance(values, dict) or not 1 <= len(values) <= 20:
        raise ControlError("«values» necesita de 1 a 20 ajustes: {ajuste: valor}")
    for name, value in values.items():
        if not isinstance(name, str) or not re.match(r"^[a-z][A-Za-z0-9_]{0,31}$", name):
            raise ControlError("el nombre de un ajuste: letra minúscula al principio, y letras, números o _ (hasta 32)")
        if not isinstance(value, (str, int, float, bool)) or (isinstance(value, str) and len(value) > 500):
            raise ControlError(f"el valor de «{name}» tiene que ser un texto (hasta 500), un número o true/false")
    return {"do": "plugin_config", "id": _plugin_id(raw), "values": dict(values)}


def _plugin_calls(raw: dict[str, Any]) -> dict[str, Any]:
    limit = raw.get("limit", 50)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
        raise ControlError("«limit» son las llamadas que quieres, de 1 a 200")
    out: dict[str, Any] = {"do": "plugin_calls", "limit": limit}
    if raw.get("id") is not None:
        out["id"] = _plugin_id(raw)
    return out


def _with_id(do: str, check_id: Callable[[dict[str, Any]], str]) -> Cleaner:
    return lambda raw: {"do": do, "id": check_id(raw)}


def _with_files(do: str, check_id: Callable[[dict[str, Any]], str]) -> Cleaner:
    return lambda raw: {"do": do, "id": check_id(raw), "files": _dev_files(raw), "dry_run": raw.get("dry_run") is True}


def _with_limit(do: str, check_id: Callable[[dict[str, Any]], str]) -> Cleaner:
    return lambda raw: {"do": do, "id": check_id(raw), "limit": _limit(raw)}


Cleaner = Callable[[dict[str, Any]], dict[str, Any]]
# every command a client may send, with what checks it: nothing else reaches the page
CLEANERS: dict[str, Cleaner] = {
    "play": _play,
    "kind": _kind,
    "volume": _volume,
    "mute": _mute,
    "multi": _multi,
    "dev_list": lambda raw: {"do": "dev_list"},
    "dev_read": _with_id("dev_read", _dev_id),
    "dev_write": _with_files("dev_write", _dev_id),
    "dev_logs": _with_limit("dev_logs", _dev_id),
    "dev_activate": _with_id("dev_activate", _dev_id),
    "plugin_list": lambda raw: {"do": "plugin_list"},
    "plugin_logs": _with_limit("plugin_logs", _plugin_id),
    "plugin_read": _with_id("plugin_read", _plugin_id),
    "plugin_write": _with_files("plugin_write", _plugin_id),
    "plugin_enable": _with_id("plugin_enable", _plugin_id),
    "plugin_disable": _with_id("plugin_disable", _plugin_id),
    "plugin_permission": _plugin_permission,
    "plugin_config": _plugin_config,
    "headers_get": lambda raw: {"do": "headers_get", "channel": _channel_ref(raw)},
    "headers_set": _headers_set,
    "rules_get": lambda raw: {"do": "rules_get"},
    "rules_set": _rules_set,
    "events_get": _events_get,
    "plugin_calls": _plugin_calls,
}


def clean_command(raw: Any) -> dict[str, Any]:
    """A command from a client, checked against the short list the page can do. ``ControlError`` if it is not one."""
    if not isinstance(raw, dict):
        raise ControlError("la orden tiene que ser un objeto JSON")
    do = raw.get("do")
    cleaner = CLEANERS.get(do) if isinstance(do, str) else None
    if cleaner is None:
        raise ControlError("orden desconocida; hay: " + ", ".join(CLEANERS))
    return cleaner(raw)


def _summary(cmd: dict[str, Any]) -> str:
    """A command for the audit trail: what was asked, without the contents of the files (long, and code)."""
    shown = {k: v for k, v in cmd.items() if k != "do"}
    if "files" in shown:
        shown["files"] = sorted(shown["files"])
    return f"{cmd['do']} {json.dumps(shown, ensure_ascii=False)}"


class ControlBus:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._lock = threading.Lock()
        self._token: str | None = None
        self._state: dict[str, Any] | None = None
        self._state_at = 0.0
        self._subscribers: set[queue.Queue[dict[str, Any] | None]] = set()
        self._pending: dict[str, dict[str, Any]] = {}
        self._seen = 0.0  # last time a client with the token asked for something
        self._audit: collections.deque[tuple[int, str]] = collections.deque(maxlen=AUDIT_KEEP)

    # ---- what is allowed
    def enabled(self) -> bool:
        return bool(self.config.control_enabled)

    def allows(self, level: str) -> bool:
        """``read`` when the bus is on; ``control`` and ``dev`` only if the user chose a level that includes them."""
        if not self.enabled() or level not in LEVEL_RANK:
            return False
        return LEVEL_RANK[level] <= LEVEL_RANK.get(self.config.control_level, 0)

    # ---- the token
    @property
    def _path(self) -> Path:
        return Path(self.config.data_dir) / TOKEN_FILE

    def token(self) -> str:
        with self._lock:
            if self._token is None:
                try:
                    saved = self._path.read_text(encoding="ascii").strip()
                except (OSError, ValueError):
                    saved = ""
                self._token = saved if len(saved) >= 32 else self._write_token()
            return self._token

    def _write_token(self) -> str:
        token = secrets.token_urlsafe(32)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # not readable by other users (the mode is ignored on Windows, where the folder of the user is already private)
        fd = os.open(self._path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as handle:
            handle.write(token + "\n")
        return token

    def regenerate(self) -> str:
        """A new token: whoever had the old one is out. Answers waiting for the page are not affected."""
        with self._lock:
            self._token = self._write_token()
            self._note("token regenerado")
            return self._token

    def check(self, header: str | None) -> bool:
        """Does an ``Authorization: Bearer <token>`` header carry the token? Compared in constant time."""
        if not header or not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].strip().encode("utf-8", "replace"), self.token().encode("ascii"))

    def announce(self) -> None:
        """At start-up, when the bus is on: make sure the token exists and say where it is (people read the log)."""
        if self.enabled():
            self.token()
            level = self.config.control_level
            log.info("control: acceso de IAs encendido (nivel %s); el token está en %s", level, self._path)

    def touch_client(self) -> None:
        self._seen = time.monotonic()

    # ---- the page's half
    def accept_state(self, raw: Any) -> bool:
        cleaned = clean_state(raw)
        if cleaned is None:
            return False
        with self._lock:
            self._state, self._state_at = cleaned, time.monotonic()
        return True

    def state(self) -> dict[str, Any] | None:
        """The last snapshot of the page with how old it is, or ``None`` if the page has not sent one."""
        with self._lock:
            if self._state is None:
                return None
            return {**self._state, "age_seconds": round(time.monotonic() - self._state_at, 1)}

    def subscribe(self) -> queue.Queue[dict[str, Any] | None]:
        """A page listens. It is handed what was sent to pages that went away before answering (a page that reloads)."""
        sub: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=50)
        with self._lock:
            self._subscribers.add(sub)
            for command_id, waiting in self._pending.items():
                if waiting["orphan"]:
                    with contextlib.suppress(queue.Full):
                        sub.put_nowait({"id": command_id, "cmd": waiting["cmd"]})
                    waiting["targets"].add(sub)
                    waiting["orphan"] = False
        return sub

    def unsubscribe(self, sub: queue.Queue[dict[str, Any] | None]) -> None:
        """A page stopped listening. A command only it had, and that it did not answer, waits for the next page."""
        with self._lock:
            self._subscribers.discard(sub)
            for command_id, waiting in self._pending.items():
                waiting["targets"].discard(sub)
                if not waiting["targets"] and waiting["result"] is None:
                    waiting["orphan"] = True
                    # a page that reloads connects again BEFORE the old stream is seen to be gone, so there may
                    # already be a page that never got this command: hand it over now, not when the next one connects
                    for other in self._subscribers:
                        with contextlib.suppress(queue.Full):
                            other.put_nowait({"id": command_id, "cmd": waiting["cmd"]})
                        waiting["targets"].add(other)
                        waiting["orphan"] = False

    def report(self, command_id: Any, ok: Any, detail: Any, data: Any = None) -> bool:
        """The page's answer to a command, with the data it returns if any. ``False`` if nobody is waiting for it."""
        with self._lock:
            waiting = self._pending.get(command_id) if isinstance(command_id, str) else None
        if waiting is None:
            return False
        result: dict[str, Any] = {"ok": ok is True, "detail": _text(detail, MAX_DETAIL)}
        if data is not None:
            try:
                fits = len(json.dumps(data, ensure_ascii=False).encode("utf-8")) <= MAX_DATA
            except (TypeError, ValueError):
                fits = False
            if fits:
                result["data"] = data
            else:
                result.update(ok=False, detail="la respuesta de la ventana es demasiado grande o no es JSON")
        waiting["result"] = result
        waiting["event"].set()
        return True

    # ---- the client's half
    def command(self, raw: Any, timeout: float | None = None) -> dict[str, Any]:
        """Send a command to the page and wait for its answer: ``{"ok", "detail"}`` and ``data`` if it has any."""
        cmd = clean_command(raw)
        needed = command_level(cmd)
        if not self.allows(needed):
            raise ControlError(f"el nivel elegido no permite esto: hace falta «{needed}»", 403)
        if timeout is None:
            timeout = COMMAND_TIMEOUTS.get(cmd["do"], COMMAND_TIMEOUT)
        with self._lock:
            targets = list(self._subscribers)
        if not targets:
            raise ControlError("la página de TDT local no está conectada (¿está abierta la aplicación?)", 503)
        command_id = secrets.token_hex(8)
        waiting: dict[str, Any] = {
            "event": threading.Event(),
            "result": None,
            "cmd": cmd,
            "targets": set(targets),  # the pages it was sent to; if they all go away unanswered, it is an orphan
            "orphan": False,
        }
        with self._lock:
            self._pending[command_id] = waiting
        try:
            for sub in targets:
                with contextlib.suppress(queue.Full):
                    sub.put_nowait({"id": command_id, "cmd": cmd})
            if not waiting["event"].wait(timeout):
                self._note(f"{cmd['do']}: sin respuesta de la página")
                raise ControlError("la página no ha respondido a tiempo", 504)
        finally:
            with self._lock:
                self._pending.pop(command_id, None)
        result: dict[str, Any] = waiting["result"]
        self._note(f"{_summary(cmd)}: " + ("hecho" if result["ok"] else "falló (" + result["detail"] + ")"))
        return result

    # ---- what happened, and where things stand
    def _note(self, text: str) -> None:
        self._audit.append((int(time.time()), text))
        log.info("control: %s", text)

    def note(self, text: str) -> None:
        self._note(text)

    def status(self) -> dict[str, Any]:
        with self._lock:
            connected = bool(self._subscribers)
        return {
            "enabled": self.enabled(),
            "level": self.config.control_level if self.config.control_level in LEVELS else "read",
            "page_connected": connected,
            "client_recent": self._seen > 0 and time.monotonic() - self._seen < RECENT_SECONDS,
            "audit": [{"t": t, "text": text} for t, text in list(self._audit)[-20:]],
        }

    def close(self) -> None:
        """Let the open event streams end (the app is closing)."""
        with self._lock:
            targets = list(self._subscribers)
        for sub in targets:
            with contextlib.suppress(queue.Full):
                sub.put_nowait(None)
