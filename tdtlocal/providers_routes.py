"""HTTP routes of the channels that plugins provide: which plugins provide how many, and replace what one provides (only from this machine)."""

# ruff: noqa: E501 - prose for a reader, not code

from __future__ import annotations

from typing import TYPE_CHECKING

from .settings_routes import _from_this_machine

if TYPE_CHECKING:
    from .server import Handler

MAX_PROVIDER_BODY = 400_000  # five hundred channels of the biggest size


def providers_get(handler: Handler, path: str) -> bool:
    if path != "/api/providers":
        return False
    store = handler.app.store
    handler._json(200, {"providers": store.provided_counts(), "epg": store.provided_epg_counts()})
    return True


def providers_post(handler: Handler, path: str) -> bool:
    if path not in ("/api/providers", "/api/providers/epg"):
        return False
    if not _from_this_machine(handler):
        handler._json(403, {"error": "solo se puede hacer desde el propio equipo"})
        return True
    body = handler._body(MAX_PROVIDER_BODY)
    try:
        if path.endswith("/epg"):
            count = handler.app.store.set_provided_epg(body.get("id"), body.get("guide"))
        else:
            count = handler.app.store.set_provided(body.get("id"), body.get("channels"))
    except ValueError as exc:
        handler._json(400, {"ok": False, "error": str(exc)})
    else:
        handler.app.epg.refresh_soon()  # a channel may name a guide of the extra source
        handler._json(200, {"ok": True, "count": count})
    return True
