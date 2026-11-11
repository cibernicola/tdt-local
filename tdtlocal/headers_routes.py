"""HTTP routes of the headers of a channel: see them (credentials as «set», never their value) and change them.

Changing them only accepts requests from the machine the server runs on (see ``settings_routes``), even with ``--lan``.
"""

from __future__ import annotations

import urllib.parse
from typing import TYPE_CHECKING

from .settings_routes import _from_this_machine

if TYPE_CHECKING:
    from .server import Handler


def headers_get(handler: Handler, path: str) -> bool:
    if path != "/api/headers":
        return False
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query)
    found = handler.app.store.get_headers(query.get("id", [""])[0][:200])
    if found is None:
        handler._json(404, {"error": "no hay ningún canal con ese id"})
    else:
        handler._json(200, found)
    return True


def headers_post(handler: Handler, path: str) -> bool:
    if path != "/api/headers":
        return False
    if not _from_this_machine(handler):
        handler._json(403, {"error": "solo se puede hacer desde el propio equipo"})
        return True
    body = handler._body()
    try:
        done = handler.app.store.set_headers(
            str(body.get("id") or "")[:200], body.get("headers"), replace=body.get("replace") is True
        )
    except ValueError as exc:
        handler._json(400, {"ok": False, "error": str(exc)})
    else:
        handler._json(200, {"ok": True, **done})
    return True
