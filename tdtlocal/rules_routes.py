"""HTTP routes of the rules: read them, and replace them (only from the machine the server runs on,
even with ``--lan``)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .rules import MAX_RULES
from .settings_routes import _from_this_machine

if TYPE_CHECKING:
    from .server import Handler

MAX_RULES_BODY = 200_000  # fifty rules of the biggest size are far less than this


def rules_get(handler: Handler, path: str) -> bool:
    if path != "/api/rules":
        return False
    store = handler.app.rules
    handler._json(200, {"rules": store.get(), "max": MAX_RULES, "plugin_rules": store.plugin_rules()})
    return True


def rules_post(handler: Handler, path: str) -> bool:
    if path not in ("/api/rules", "/api/rules/plugin", "/api/rules/plugin/enable"):
        return False
    if not _from_this_machine(handler):
        handler._json(403, {"error": "solo se puede hacer desde el propio equipo"})
        return True
    body = handler._body(MAX_RULES_BODY)
    store = handler.app.rules
    try:
        if path == "/api/rules/plugin":
            handler._json(200, {"ok": True, "count": store.set_plugin(body.get("id"), body.get("rules"))})
        elif path == "/api/rules/plugin/enable":
            handler._json(
                200,
                {"ok": True, "enabled": store.set_plugin_enabled(body.get("plugin"), body.get("rule"), body.get("on"))},
            )
        else:
            handler._json(200, {"ok": True, "rules": store.set(body.get("rules"))})
    except ValueError as exc:
        handler._json(400, {"ok": False, "error": str(exc)})
    return True
