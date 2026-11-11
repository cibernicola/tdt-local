"""What a client of the control bus may read besides the state of the page: channels, the guide and the ad markers.

Everything here is a reduced copy of data the app already shows: no stream addresses, no headers, no addresses of ours.
The texts (names of channels, titles of programmes) come from the internet and are data: whoever reads them must
not take them for instructions.
"""

from __future__ import annotations

import datetime
import functools
import json
import unicodedata
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .app import App

MAX_RESULTS = 50
DEFAULT_RESULTS = 25
MAX_PROGRAMMES = 12
MAX_MARKERS = 100
MAX_TEXT = 200
KINDS = ("tv", "radio")


def fold(text: str) -> str:
    """Lowercase without accents: «La Sexta» and «la sexta» and «Teléfono» and «telefono» are the same to a search."""
    return "".join(c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c)).strip()


def _playable(channels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [c for c in channels if c.get("sources") and c.get("ok") is not False and c.get("kind") in KINDS]


def search_channels(app: App, query: str = "", kind: str = "", limit: int = DEFAULT_RESULTS) -> dict[str, Any]:
    """Channels that can be played whose name or category has every word of ``query``, in the order of the list."""
    limit = max(1, min(MAX_RESULTS, limit))
    words = fold(query).split()
    found = []
    for c in _playable(app.channels_payload()["channels"]):
        if kind in KINDS and c["kind"] != kind:
            continue
        haystack = fold(f"{c.get('name', '')} {c.get('cat', '')}")
        if all(w in haystack for w in words):
            found.append(c)
    return {
        "total": len(found),
        "shown": min(len(found), limit),
        "channels": [
            {
                "id": str(c["id"])[:MAX_TEXT],
                "name": str(c.get("name", ""))[:MAX_TEXT],
                "kind": c["kind"],
                "category": str(c.get("cat", ""))[:MAX_TEXT],
                "has_guide": bool(c.get("epg")),
            }
            for c in found[:limit]
        ],
    }


def _find(app: App, ref: str) -> dict[str, Any] | None:
    """A channel by id, by its exact name or by a name that starts with ``ref`` and only one does."""
    channels = _playable(app.channels_payload()["channels"])
    key = fold(ref)
    if not key:
        return None
    for c in channels:
        if str(c["id"]) == ref or fold(str(c.get("name", ""))) == key:
            return c
    starts = [c for c in channels if fold(str(c.get("name", ""))).startswith(key)]
    return starts[0] if len(starts) == 1 else None


def _iso(ts: float) -> str:
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat(timespec="seconds")


def guide(app: App, ref: str) -> dict[str, Any]:
    """What is on and what comes next on a channel. ``ValueError`` if there is no such channel."""
    channel = _find(app, ref)
    if channel is None:
        raise ValueError(f"no hay ningún canal «{ref[:60]}» (usa tdt_search_channels para ver los nombres)")
    programmes = []
    if channel.get("epg"):
        for p in app.epg.payload(str(channel["epg"]))["programmes"][:MAX_PROGRAMMES]:
            programmes.append(
                {
                    "start": _iso(p[0]),
                    "end": _iso(p[1]),
                    "title": str(p[2])[:MAX_TEXT],
                    "start_ts": int(p[0]),
                    "end_ts": int(p[1]),
                }
            )
    return {"channel": {"id": str(channel["id"]), "name": str(channel.get("name", ""))}, "programmes": programmes}


def markers(app: App, limit: int = 20) -> dict[str, Any]:
    """The latest ad markers the app has seen (without their addresses). Empty unless the watcher is on."""
    limit = max(1, min(MAX_MARKERS, limit))
    events = app.scte.log.all()[-limit:]
    return {
        "enabled": bool(app.config.scte_enabled),
        "events": [
            {
                "id": e["id"],
                "ts": int(e["ts"]),
                "time": _iso(e["ts"]),
                "channel": str(e.get("name", ""))[:MAX_TEXT],
                "kind": str(e.get("kind", ""))[:40],
                "detail": str(e.get("detail", ""))[:MAX_TEXT],
                "source": str(e.get("source", ""))[:40],
            }
            for e in events
        ],
    }


API_FILE = Path(__file__).parent / "static" / "plugin-api.json"


@functools.lru_cache(maxsize=1)
def _plugin_spec() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(API_FILE.read_text(encoding="utf-8"))
    return loaded


COMMANDS_FILE = API_FILE.with_name("commands.json")


@functools.lru_cache(maxsize=1)
def commands_spec() -> dict[str, Any]:
    """What TDT local can do and what it tells (``static/commands.json``): the one list that the rules, the plugins, the
    control bus and the MCP all agree on (the tests check it)."""
    loaded: dict[str, Any] = json.loads(COMMANDS_FILE.read_text(encoding="utf-8"))
    return loaded


def plugin_api(method: str = "") -> dict[str, Any]:
    """The specification of the API of the plugins with permissions (the same file the page and the documentation
    read): all of it, or one method with the text of the permission it needs. ``ValueError`` if there is no such
    method."""
    spec = _plugin_spec()
    if not method:
        return spec
    if method not in spec["methods"]:
        raise ValueError(f"no hay ningún método «{method[:60]}»; hay: {', '.join(spec['methods'])}")
    found = spec["methods"][method]
    need = found["permission"]
    permission = spec["permissions"].get(need) if need else None
    return {"api": spec["api"], "method": method, **found, "permission_info": permission}
