"""HTTP routes of the ad-marker log: read it, export it, scan now and clear it.

Reading is open to the page like the rest of the API. Anything that changes something only accepts requests
from the machine the server runs on (see ``settings_routes``), even with ``--lan``.
"""

from __future__ import annotations

import csv
import io
import json
import time
import urllib.parse
from typing import TYPE_CHECKING, Any

from .settings_routes import _from_this_machine

if TYPE_CHECKING:
    from .server import Handler

MAX_EVENTS = 1000
SUMMARY_ROWS = 100
CSV_COLUMNS = ("id", "fecha", "canal", "tipo", "detalle", "origen", "url", "etiqueta")
FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def _public(event: dict[str, Any]) -> dict[str, Any]:
    """An event as the page sees it: without the internal dedupe key."""
    return {k: v for k, v in event.items() if k != "key"}


def _number(values: list[str] | None, default: int, low: int, high: int) -> int:
    try:
        return max(low, min(high, int((values or [""])[0])))
    except ValueError:
        return default


def _cell(value: Any) -> str:
    """Spreadsheets run text that starts with ``=`` or ``+`` as a formula: the log holds text from remote streams."""
    text = str(value)
    return "'" + text if text.startswith(FORMULA_START) else text


def to_csv(events: list[dict[str, Any]]) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(CSV_COLUMNS)
    for e in events:
        writer.writerow(
            _cell(v)
            for v in (
                e["id"],
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(e["ts"])),
                e.get("name", ""),
                e["kind"],
                e.get("detail", ""),
                e.get("source", ""),
                e.get("url", ""),
                e.get("raw", ""),
            )
        )
    return out.getvalue()


def handle_get(handler: Handler, path: str) -> bool:
    """Answer the read-only routes. Returns ``False`` if ``path`` is not one of them."""
    if path not in ("/api/scte", "/api/scte/export"):
        return False
    app = handler.app
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query)
    log = app.scte.log
    if path == "/api/scte":
        after = _number(query.get("after"), 0, 0, 2**62)
        limit = _number(query.get("limit"), 200, 0, MAX_EVENTS)
        body: dict[str, Any] = {
            "enabled": app.config.scte_enabled,
            "notify": app.config.scte_notify,
            "status": app.scte.status(),
            "last_id": log.last_id,
            "events": [_public(e) for e in log.since(after, limit)],
        }
        if query.get("summary") == ["1"]:
            body["summary"] = log.summary()[:SUMMARY_ROWS]
        handler._json(200, body)
        return True
    events = [_public(e) for e in log.all()]
    if query.get("fmt") == ["csv"]:
        payload = ("\ufeff" + to_csv(events)).encode("utf-8")
        ctype, name = "text/csv; charset=utf-8", "tdt-local-scte35.csv"
    else:
        payload = json.dumps(events, ensure_ascii=False, indent=2).encode("utf-8")
        ctype, name = "application/json; charset=utf-8", "tdt-local-scte35.json"
    handler._send(
        200, payload, ctype, {"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"}
    )
    return True


def handle_post(handler: Handler, path: str) -> bool:
    """Answer the routes that change something. ``False`` if ``path`` is not one of them."""
    if path not in ("/api/scte/scan", "/api/scte/clear"):
        return False
    if not _from_this_machine(handler):
        handler._json(403, {"error": "solo se puede hacer desde el propio equipo"})
        return True
    watcher = handler.app.scte
    if path == "/api/scte/scan":
        accepted, reason = watcher.request_scan()
        handler._json(200 if accepted else 409, {"ok": accepted, "error": reason})
    else:
        handler._json(200, {"ok": True, "removed": watcher.clear()})
    return True
