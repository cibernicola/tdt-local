"""Rules: «when this happens, do that», written as data by the user (or by an AI, with the user's consent). No code runs.

A rule has a **trigger** (``when``) and up to five **actions** (``do``)::

    {"id": "noticias", "name": "Noticias a las 21", "enabled": true,
     "when": {"type": "time", "at": "21:00", "days": [1, 2, 3, 4, 5]},
     "do": [{"action": "play", "channel": "La 1"}, {"action": "toast", "text": "Telediario"}]}

Triggers: ``time`` (a time of the day, optionally on some days: 0 is Sunday), ``channel`` (this channel becomes the active one) and
``programme`` (a programme whose title contains a text starts, on one channel or on any). Actions: ``play``, ``kind``, ``volume``,
``mute``, ``multi`` and ``toast``: the same things the control bus lets an AI do, and nothing else.

The page runs them (it is the one that plays things); this module only decides what a valid rule is and keeps them in
``data/rules.json``. What a person or an AI sends is checked strictly (``ValueError`` saying what is wrong); what is read from disk
is checked leniently (what is wrong is dropped), like the headers of a channel.
"""

# ruff: noqa: E501 - prose for a reader, not code: its lines are as long as the sentences

from __future__ import annotations

import logging
import re
import threading
from pathlib import Path
from typing import Any

from .providers import clean_provider
from .store import read_json, write_json

log = logging.getLogger(__name__)

MAX_RULES = 50
MAX_PLUGIN_RULES = 10  # rules a plugin may bring
MAX_PLUGIN_ENABLED = 500
MAX_ACTIONS = 5
MAX_TILES = 4
MAX_TEXT = 200
MAX_REF = 120
ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
KINDS = ("tv", "radio", "u7d")
TRIGGERS = ("time", "channel", "programme", "key")
# a key is «Ctrl+Alt+Shift+K»: at least Ctrl or Alt (so it never clashes with the plain keys of the page nor with typing), then a letter, a digit or F1-F12
KEY = re.compile(r"^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?([A-Z0-9]|F(?:[1-9]|1[0-2]))$")
ACTIONS = ("play", "kind", "volume", "mute", "multi", "toast")


def _text(value: Any, what: str, limit: int, required: bool = True) -> str:
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValueError(f"{what} tiene que ser un texto" + (" que no esté vacío" if required else ""))
    if len(value.strip()) > limit:
        raise ValueError(f"{what} pasa de {limit} caracteres")
    if any(ord(c) < 32 for c in value):
        raise ValueError(f"{what} no puede llevar saltos de línea ni caracteres de control")
    return value.strip()


def _only(raw: dict[str, Any], allowed: tuple[str, ...], what: str) -> None:
    extra = [k for k in raw if k not in allowed]
    if extra:
        raise ValueError(f"{what}: «{str(extra[0])[:40]}» no es un campo que se admita")


def clean_when(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("type") not in TRIGGERS:
        raise ValueError("«when» necesita un «type»: " + ", ".join(TRIGGERS))
    kind = raw["type"]
    if kind == "time":
        _only(raw, ("type", "at", "days"), "«when»")
        at = raw.get("at")
        if not isinstance(at, str) or not TIME.match(at):
            raise ValueError("«at» es una hora como 21:30")
        out: dict[str, Any] = {"type": "time", "at": at}
        days = raw.get("days")
        if days is not None:
            if (
                not isinstance(days, list)
                or not 1 <= len(days) <= 7
                or any(isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= 6 for d in days)
            ):
                raise ValueError("«days» son los días de la semana, de 0 (domingo) a 6 (sábado)")
            out["days"] = sorted(set(days))
        return out
    if kind == "key":
        _only(raw, ("type", "key"), "«when»")
        key = raw.get("key")
        if not isinstance(key, str):
            raise ValueError("«key» es una tecla como Alt+1 o Ctrl+Shift+F5")
        parts = [p.strip() for p in key.split("+")]
        canonical = "+".join(
            [m for m in ("Ctrl", "Alt", "Shift") if m.lower() in [p.lower() for p in parts[:-1]]] + [parts[-1].upper()]
        )
        if (
            not KEY.match(canonical)
            or not {"Ctrl", "Alt"} & set(canonical.split("+"))
            or len(parts) != len(canonical.split("+"))
        ):
            raise ValueError(
                "«key» es una tecla como Alt+1 o Ctrl+Shift+F5 (con Ctrl o Alt, y una letra, un número o F1 a F12)"
            )
        return {"type": "key", "key": canonical}
    if kind == "channel":
        _only(raw, ("type", "channel"), "«when»")
        return {"type": "channel", "channel": _text(raw.get("channel"), "«channel»", MAX_REF)}
    _only(raw, ("type", "title", "channel"), "«when»")
    out = {"type": "programme", "title": _text(raw.get("title"), "«title»", 80)}
    if raw.get("channel") is not None:
        out["channel"] = _text(raw["channel"], "«channel»", MAX_REF)
    return out


def clean_action(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("action") not in ACTIONS:
        raise ValueError("cada acción necesita un «action»: " + ", ".join(ACTIONS))
    do = raw["action"]
    if do == "play":
        _only(raw, ("action", "channel"), "«play»")
        return {"action": "play", "channel": _text(raw.get("channel"), "«channel»", MAX_REF)}
    if do == "kind":
        _only(raw, ("action", "kind"), "«kind»")
        if raw.get("kind") not in KINDS:
            raise ValueError("«kind» tiene que ser tv, radio o u7d")
        return {"action": "kind", "kind": raw["kind"]}
    if do == "volume":
        _only(raw, ("action", "value"), "«volume»")
        value = raw.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
            raise ValueError("«volume» necesita «value» entre 0 y 1")
        return {"action": "volume", "value": round(float(value), 3)}
    if do == "mute":
        _only(raw, ("action", "on"), "«mute»")
        if not isinstance(raw.get("on"), bool):
            raise ValueError("«mute» necesita «on» (true o false)")
        return {"action": "mute", "on": raw["on"]}
    if do == "multi":
        _only(raw, ("action", "channels", "rotate"), "«multi»")
        channels = raw.get("channels")
        if not isinstance(channels, list) or not 1 <= len(channels) <= MAX_TILES:
            raise ValueError(f"«multi» necesita «channels»: de 1 a {MAX_TILES} canales")
        out: dict[str, Any] = {
            "action": "multi",
            "channels": [_text(c, "cada canal de «channels»", MAX_REF) for c in channels],
        }
        rotate = raw.get("rotate")
        if rotate is not None:
            if isinstance(rotate, bool) or not isinstance(rotate, int) or not 5 <= rotate <= 600:
                raise ValueError("«rotate» son los segundos entre canales, de 5 a 600")
            out["rotate"] = rotate
        return out
    _only(raw, ("action", "text"), "«toast»")
    return {"action": "toast", "text": _text(raw.get("text"), "«text»", MAX_TEXT)}


def clean_rule(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("cada regla tiene que ser un objeto")
    _only(raw, ("id", "name", "enabled", "when", "do"), "una regla")
    rule_id = raw.get("id")
    if not isinstance(rule_id, str) or not ID.match(rule_id):
        raise ValueError("«id» de una regla: minúsculas, números y guiones (hasta 40)")
    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ValueError(f"«enabled» de «{rule_id}» tiene que ser true o false")
    actions = raw.get("do")
    if not isinstance(actions, list) or not 1 <= len(actions) <= MAX_ACTIONS:
        raise ValueError(f"«do» de «{rule_id}» necesita de 1 a {MAX_ACTIONS} acciones")
    try:
        return {
            "id": rule_id,
            "name": _text(raw.get("name", rule_id), "«name»", 80),
            "enabled": enabled,
            "when": clean_when(raw.get("when")),
            "do": [clean_action(a) for a in actions],
        }
    except ValueError as exc:
        raise ValueError(f"regla «{rule_id}»: {exc}") from exc


def clean_rules(raw: Any, strict: bool = True) -> list[dict[str, Any]]:
    """A list of rules checked. Strict (a person or an AI): ``ValueError`` on the first problem. Lenient (disk): drop what is wrong."""
    if not isinstance(raw, list):
        if strict:
            raise ValueError("las reglas tienen que ser una lista")
        return []
    if strict and len(raw) > MAX_RULES:
        raise ValueError(f"hasta {MAX_RULES} reglas")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw[:MAX_RULES]:
        try:
            rule = clean_rule(item)
        except ValueError:
            if strict:
                raise
            continue
        if rule["id"] in seen:
            if strict:
                raise ValueError(f"la regla «{rule['id']}» está repetida")
            continue
        seen.add(rule["id"])
        out.append(rule)
    return out


DAY_NAMES = ("dom", "lun", "mar", "mié", "jue", "vie", "sáb")


def describe_action(action: dict[str, Any]) -> str:
    do = action["action"]
    if do == "play":
        return f"poner «{action['channel']}»"
    if do == "kind":
        return {"tv": "cambiar a televisión", "radio": "cambiar a radio", "u7d": "cambiar a los últimos 7 días"}[
            action["kind"]
        ]
    if do == "volume":
        return f"volumen al {round(action['value'] * 100)} %"
    if do == "mute":
        return "silenciar" if action["on"] else "quitar el silencio"
    if do == "multi":
        return "multivisión con " + ", ".join(f"«{c}»" for c in action["channels"])
    return f"avisar «{action['text']}»"


def describe_rule(rule: dict[str, Any]) -> str:
    """One line in words for the question to the user and for the list."""
    when = rule["when"]
    if when["type"] == "time":
        days = f" ({', '.join(DAY_NAMES[d] for d in when['days'])})" if "days" in when else ""
        text = f"a las {when['at']}{days}"
    elif when["type"] == "key":
        text = f"al pulsar {when['key']}"
    elif when["type"] == "channel":
        text = f"cuando se ponga «{when['channel']}»"
    else:
        where = f" en «{when['channel']}»" if "channel" in when else ""
        text = f"cuando empiece un programa con «{when['title']}»{where}"
    return (
        f"{rule['name']}: {text} → "
        + "; ".join(describe_action(a) for a in rule["do"])
        + ("" if rule["enabled"] else " (apagada)")
    )


class RulesStore:
    """The rules of the user, in ``rules.json``, and the rules that plugins bring.

    A rule a plugin brings is **off until the user turns it on** (that choice is kept in ``rules.json``): the plugin proposes, the user decides, and
    what the user sees is the sentence of the rule, not code. They live in memory (the plugin brings them again when it starts)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._rules: list[dict[str, Any]] = []
        self._plugin: dict[str, list[dict[str, Any]]] = {}
        self._plugin_on: set[str] = set()  # «plugin/rule» the user turned on

    def _save(self) -> None:
        write_json(self.path, {"rules": self._rules, "plugin_enabled": sorted(self._plugin_on)})

    def load(self) -> None:
        data = read_json(self.path)
        with self._lock:
            self._rules = clean_rules(data.get("rules") if data else None, strict=False)
            on = data.get("plugin_enabled") if data else None
            self._plugin_on = {
                k for k in (on if isinstance(on, list) else []) if isinstance(k, str) and 0 < len(k) <= 90
            }
            self._plugin_on = set(sorted(self._plugin_on)[:MAX_PLUGIN_ENABLED])

    def get(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._rules]

    def set(self, raw: Any) -> list[dict[str, Any]]:
        """Replace all the rules (checked strictly). ``ValueError`` and nothing changes if one is wrong."""
        rules = clean_rules(raw, strict=True)
        with self._lock:
            self._rules = rules
            self._save()
        return self.get()

    # ---- the rules that plugins bring
    def set_plugin(self, provider: str, raw: Any) -> int:
        """Replace the rules a plugin brings (checked strictly, all or nothing); empty removes them. Returns how many."""
        provider = clean_provider(provider)
        rules = clean_rules(raw if raw else [], strict=True)
        if len(rules) > MAX_PLUGIN_RULES:
            raise ValueError(f"un plugin trae hasta {MAX_PLUGIN_RULES} reglas")
        with self._lock:
            if rules:
                self._plugin[provider] = rules
            else:
                self._plugin.pop(provider, None)
        return len(rules)

    def plugin_rules(self) -> list[dict[str, Any]]:
        """Every rule a plugin brings: ``{plugin, enabled, rule, text}`` (``enabled`` is the user's choice, off by default)."""
        with self._lock:
            return [
                {
                    "plugin": pid,
                    "enabled": f"{pid}/{r['id']}" in self._plugin_on,
                    "rule": {**r, "enabled": True},
                    "text": describe_rule(r),
                }
                for pid, rules in self._plugin.items()
                for r in rules
            ]

    def plugin_counts(self) -> dict[str, int]:
        with self._lock:
            return {pid: len(rules) for pid, rules in self._plugin.items()}

    def set_plugin_enabled(self, provider: str, rule_id: Any, on: Any) -> bool:
        """The user turns a rule of a plugin on or off. ``ValueError`` if the plugin does not bring it."""
        provider = clean_provider(provider)
        if not isinstance(on, bool):
            raise ValueError("«on» tiene que ser true o false")
        with self._lock:
            if not any(r["id"] == rule_id for r in self._plugin.get(provider, [])):
                raise ValueError("ese plugin no trae esa regla")
            key = f"{provider}/{rule_id}"
            if on:
                if len(self._plugin_on) >= MAX_PLUGIN_ENABLED and key not in self._plugin_on:
                    raise ValueError("demasiadas reglas de plugins encendidas")
                self._plugin_on.add(key)
            else:
                self._plugin_on.discard(key)
            self._save()
        return on
