"""HTTP routes of the teletext: the magazines the page fetches, a plain-text view for scripts, and a rebuild.

Reading is open to the page like the rest of the API. The rebuild only accepts requests from this machine.
"""

from __future__ import annotations

import re
import urllib.parse
from typing import TYPE_CHECKING

from .settings_routes import _from_this_machine

if TYPE_CHECKING:
    from .server import Handler

MAGAZINE = re.compile(r"^/api/teletext/([1-8])\.json$")
PAGE = re.compile(r"^[1-8][0-9]{2}$")


def handle_get(handler: Handler, path: str) -> bool:
    """Read-only routes. Returns ``False`` if ``path`` is not one of them."""
    if not path.startswith("/api/teletext"):
        return False
    teletext = handler.app.teletext
    if path == "/api/teletext":
        handler._json(200, teletext.status())
        return True
    match = MAGAZINE.match(path)
    if match:
        body = teletext.magazine(match.group(1))
        if body is None:
            handler._json(404, {"error": "esa revista no existe todavía"})
        else:
            handler._json(200, body)
        return True
    if path == "/api/teletext/page":
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query)
        number = (query.get("n") or [""])[0]
        subpages = teletext.page_text(number) if PAGE.match(number) else None
        if subpages is None:
            handler._json(404, {"error": "página no encontrada", "pages": teletext.status()["pages"]})
        else:
            handler._json(200, {"page": number, "subpages": subpages, "updated": teletext.status()["updated"]})
        return True
    return False


def handle_post(handler: Handler, path: str) -> bool:
    """``POST /api/teletext/refresh``: rebuild the pages now (only from this machine)."""
    if path != "/api/teletext/refresh":
        return False
    if not _from_this_machine(handler):
        handler._json(403, {"ok": False, "error": "solo desde este equipo"})
        return True
    handler.app.teletext.refresh_soon()
    handler._json(200, {"ok": True})
    return True
