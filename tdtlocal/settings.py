"""User settings: what can be changed from the interface, validated and kept in ``settings.json``.

The :class:`Config` object holds the live values. Order of precedence, lowest to highest: built-in defaults,
``settings.json`` (what the user saved in the interface), command-line flags and ``TDT_*`` environment
variables. A setting fixed by the last group is *locked*: shown read-only and never written to disk.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import (
    DEFAULT_LLM_URL,
    DEFAULT_WHISPER_URL,
    EPG_EXTRA_SOURCE,
    EPG_SOURCES,
    PROJECT_DIR,
    RADIO_SOURCE,
    TV_SOURCE,
    Config,
)
from .paths import default_models_dir
from .store import read_json, write_json

log = logging.getLogger(__name__)

FILE_VERSION = 1
SECTIONS = ("ai", "stt", "lists", "scte", "ads", "control")
LANGUAGES = ("es", "ca", "gl", "eu", "en", "fr", "pt", "de", "it", "auto")
SCTE_SCOPES = ("viewing", "list", "all")
AD_AUDIO = ("keep", "mute", "lower")
AD_SCREEN = ("keep", "channel", "web")
AD_TOUCH = ("respect", "restore")
CONTROL_LEVELS = ("read", "control", "dev")
URL = re.compile(r"https?://[^\s]+$")
MAX_URL = 400
MAX_PATH = 500
MAX_EXTRA_JSON = 4000
RESERVED_PARAMS = ("messages", "stream")  # the assistant sets these itself


@dataclass(frozen=True)
class Field:
    """One setting. ``kind`` is bool, int, float, text, url, optional_url, path, choice or json."""

    name: str
    section: str
    kind: str
    default: Any
    minimum: float | None = None
    maximum: float | None = None
    max_length: int = 120
    choices: tuple[str, ...] = ()
    secret: bool = False
    # when the value changes, these Config-independent services must be told (see App.apply_settings)
    affects: tuple[str, ...] = field(default=())

    def validate(self, value: Any) -> Any:
        """Return the cleaned value or raise :class:`ValueError` with a message for the user."""
        return _VALIDATORS[self.kind](self, value)


def _bool(f: Field, value: Any) -> bool:
    if not isinstance(value, bool):
        raise ValueError("debe ser sí o no")
    return value


def _number(f: Field, value: Any) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("debe ser un número")
    if value != value or value in (float("inf"), float("-inf")):  # NaN and infinities
        raise ValueError("debe ser un número")
    if f.kind == "int":
        if value != int(value):
            raise ValueError("debe ser un número entero")
        value = int(value)
    else:
        value = float(value)
    if (f.minimum is not None and value < f.minimum) or (f.maximum is not None and value > f.maximum):
        raise ValueError(f"debe estar entre {f.minimum:g} y {f.maximum:g}")
    return value


def _clean_text(f: Field, value: Any, allow_empty: bool = True) -> str:
    if not isinstance(value, str):
        raise ValueError("debe ser texto")
    text = value.strip()
    if len(text) > f.max_length:
        raise ValueError(f"máximo {f.max_length} caracteres")
    if any(ord(c) < 32 for c in text):
        raise ValueError("no puede llevar saltos de línea ni caracteres de control")
    if not text and not allow_empty:
        raise ValueError("no puede estar vacío")
    return text


def _text(f: Field, value: Any) -> str:
    return _clean_text(f, value)


def _url(f: Field, value: Any) -> str:
    text = _clean_text(f, value, allow_empty=False)
    if not URL.match(text):
        raise ValueError("debe ser una dirección http:// o https://")
    return text


def _optional_url(f: Field, value: Any) -> str:
    """Like ``url``, but empty means "none"."""
    text = _clean_text(f, value)
    if text and not URL.match(text):
        raise ValueError("debe ser una dirección http:// o https://")
    return text


def _path(f: Field, value: Any) -> str:
    return _clean_text(f, value)


def _choice(f: Field, value: Any) -> str:
    if value not in f.choices:
        raise ValueError("opción no válida")
    return str(value)


def _json_object(f: Field, value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("debe ser texto JSON")
    text = value.strip()
    if len(text) > MAX_EXTRA_JSON:
        raise ValueError(f"máximo {MAX_EXTRA_JSON} caracteres")
    if not text:
        return ""
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise ValueError("no es JSON válido") from exc
    if not isinstance(data, dict):
        raise ValueError('debe ser un objeto JSON, por ejemplo {"top_p": 0.9}')
    bad = [k for k in RESERVED_PARAMS if k in data]
    if bad:
        raise ValueError(f"no se puede cambiar: {', '.join(bad)}")
    return text


_VALIDATORS: dict[str, Callable[[Field, Any], Any]] = {
    "bool": _bool,
    "int": _number,
    "float": _number,
    "text": _text,
    "url": _url,
    "optional_url": _optional_url,
    "path": _path,
    "choice": _choice,
    "json": _json_object,
}

FIELDS: tuple[Field, ...] = (
    # assistant
    Field("ai_enabled", "ai", "bool", True),
    Field("llm_url", "ai", "url", DEFAULT_LLM_URL, max_length=MAX_URL),
    Field("llm_model", "ai", "text", "", max_length=120),
    Field("llm_api_key", "ai", "text", "", max_length=400, secret=True),
    Field("llm_temperature", "ai", "float", 0.2, 0, 2),
    Field("llm_max_tokens", "ai", "int", 700, 16, 8192),
    Field("llm_timeout", "ai", "float", 120.0, 5, 900),
    Field("llm_disable_thinking", "ai", "bool", True),
    Field("llm_extra_params", "ai", "json", ""),
    # live subtitles and voice alerts
    Field("stt_enabled", "stt", "bool", True, affects=("stt",)),
    Field("whisper_url", "stt", "url", DEFAULT_WHISPER_URL, max_length=MAX_URL, affects=("stt",)),
    Field("whisper_autostart", "stt", "bool", True, affects=("stt",)),
    Field("models_dir", "stt", "path", "", max_length=MAX_PATH, affects=("stt",)),
    Field("whisper_bin", "stt", "path", "", max_length=MAX_PATH, affects=("stt",)),
    Field("whisper_model", "stt", "path", "", max_length=MAX_PATH, affects=("stt",)),
    Field("whisper_lang", "stt", "choice", "es", choices=LANGUAGES, affects=("stt",)),
    Field("whisper_threads", "stt", "int", 8, 1, 64, affects=("stt",)),
    Field("whisper_idle_minutes", "stt", "int", 10, 1, 1440),
    # channel lists and programme guide
    Field("update_hours", "lists", "float", 6.0, 0.5, 168),
    Field("auto_check", "lists", "bool", False),
    Field("epg_enabled", "lists", "bool", True, affects=("epg",)),
    Field("epg_extra_enabled", "lists", "bool", False, affects=("epg",)),
    Field("epg_extra_source", "lists", "url", EPG_EXTRA_SOURCE, max_length=MAX_URL, affects=("epg",)),
    Field("tv_source", "lists", "url", TV_SOURCE, max_length=MAX_URL, affects=("feeds",)),
    Field("radio_source", "lists", "url", RADIO_SOURCE, max_length=MAX_URL, affects=("feeds",)),
    Field("epg_tv_source", "lists", "url", EPG_SOURCES["tv"], max_length=MAX_URL, affects=("epg",)),
    Field("epg_radio_source", "lists", "url", EPG_SOURCES["radio"], max_length=MAX_URL, affects=("epg",)),
    # ad-break markers (SCTE-35)
    Field("scte_enabled", "scte", "bool", False, affects=("scte",)),
    Field("scte_scope", "scte", "choice", "viewing", choices=SCTE_SCOPES, affects=("scte",)),
    Field("scte_channels", "scte", "text", "", max_length=MAX_URL, affects=("scte",)),
    Field("scte_interval", "scte", "int", 60, 10, 3600, affects=("scte",)),
    Field("scte_inspect_segments", "scte", "bool", False, affects=("scte",)),
    Field("scte_notify", "scte", "bool", True),
    Field("scte_keep", "scte", "int", 2000, 100, 50000, affects=("scte",)),
    # what to do while an ad break is on (read by the page)
    Field("ad_enabled", "ads", "bool", False),
    Field("ad_flag", "ads", "bool", True),
    Field("ad_audio", "ads", "choice", "mute", choices=AD_AUDIO),
    Field("ad_lower_percent", "ads", "int", 25, 0, 90),
    Field("ad_screen", "ads", "choice", "keep", choices=AD_SCREEN),
    Field("ad_channel", "ads", "text", "", max_length=120),
    Field("ad_web_url", "ads", "optional_url", "", max_length=MAX_URL),
    Field("ad_min_seconds", "ads", "int", 10, 0, 600),
    Field("ad_unknown_seconds", "ads", "int", 120, 10, 900),
    Field("ad_on_touch", "ads", "choice", "respect", choices=AD_TOUCH),
    # access for AIs and plugins (control.py): off until the user turns it on
    Field("control_enabled", "control", "bool", False),
    Field("control_level", "control", "choice", "read", choices=CONTROL_LEVELS),
)
BY_NAME = {f.name: f for f in FIELDS}


def get_value(config: Config, name: str) -> Any:
    if name == "models_dir":  # "" means the automatic location, so that it can follow the installation
        return "" if Path(config.models_dir) == default_models_dir(PROJECT_DIR) else str(config.models_dir)
    if name == "epg_tv_source":
        return config.epg_sources["tv"]
    if name == "epg_radio_source":
        return config.epg_sources["radio"]
    return getattr(config, name)


def set_value(config: Config, name: str, value: Any) -> None:
    if name == "models_dir":
        config.models_dir = Path(value).expanduser() if value else default_models_dir(PROJECT_DIR)
        return
    if name == "epg_tv_source":
        config.epg_sources = {**config.epg_sources, "tv": value}
    elif name == "epg_radio_source":
        config.epg_sources = {**config.epg_sources, "radio": value}
    else:
        setattr(config, name, value)


class SettingsStore:
    """Loads, validates, applies and saves the settings. Thread-safe."""

    def __init__(self, config: Config, path: Path | None = None) -> None:
        self.config = config
        self.path = path or config.data_dir / "settings.json"
        self._lock = threading.Lock()

    # ---- reading
    def load(self) -> None:
        """Apply the saved values. Unknown or invalid entries are ignored (and logged), never fatal."""
        data = read_json(self.path)
        if not data or not isinstance(data.get("values"), dict):
            return
        for name, raw in data["values"].items():
            field_ = BY_NAME.get(name)
            if field_ is None or name in self.config.locked:
                continue
            try:
                set_value(self.config, name, field_.validate(raw))
            except ValueError as exc:
                log.warning("ajuste guardado descartado (%s): %s", name, exc)

    def snapshot(self) -> dict[str, Any]:
        """What the interface needs. Secrets are never included: only whether they are set."""
        values: dict[str, Any] = {}
        secrets_set: dict[str, bool] = {}
        for f in FIELDS:
            current = get_value(self.config, f.name)
            if f.secret:
                values[f.name] = ""
                secrets_set[f.name] = bool(current)
            else:
                values[f.name] = current
        return {
            "values": values,
            "defaults": {f.name: f.default for f in FIELDS if not f.secret},
            "locked": sorted(self.config.locked),
            "secrets_set": secrets_set,
            "limits": {
                f.name: {"min": f.minimum, "max": f.maximum, "choices": list(f.choices)}
                for f in FIELDS
                if f.minimum is not None or f.choices
            },
            "path": str(self.path),
        }

    # ---- writing
    def validate(self, changes: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
        """``(clean values, errors per field)`` for a partial update. Nothing is applied."""
        clean: dict[str, Any] = {}
        errors: dict[str, str] = {}
        for name, raw in changes.items():
            f = BY_NAME.get(name)
            if f is None:
                errors[name] = "ajuste desconocido"
            elif name in self.config.locked:
                errors[name] = "fijado por la línea de comandos o una variable de entorno"
            elif f.secret and raw is None:
                continue  # an omitted secret means "keep the saved one"
            else:
                try:
                    clean[name] = f.validate(raw)
                except ValueError as exc:
                    errors[name] = str(exc)
        return clean, errors

    def update(self, changes: dict[str, Any]) -> tuple[list[str], dict[str, str]]:
        """Validate, apply and persist. All or nothing: returns ``(changed names, errors)``."""
        with self._lock:
            clean, errors = self.validate(changes)
            if errors:
                return [], errors
            changed = [n for n, v in clean.items() if get_value(self.config, n) != v]
            for name in changed:
                set_value(self.config, name, clean[name])
            if changed:
                self._save()
            return changed, {}

    def reset(self, section: str | None = None) -> list[str]:
        """Back to the defaults for one section (or all). Locked settings are left alone."""
        with self._lock:
            names = [
                f.name for f in FIELDS if (section is None or f.section == section) and f.name not in self.config.locked
            ]
            changed = [n for n in names if get_value(self.config, n) != BY_NAME[n].default]
            for name in changed:
                set_value(self.config, name, BY_NAME[name].default)
            if changed:
                self._save()
            return changed

    def _save(self) -> None:
        """Persist only what differs from the defaults, so a new default reaches users who never touched it."""
        values = {
            f.name: get_value(self.config, f.name)
            for f in FIELDS
            if f.name not in self.config.locked and get_value(self.config, f.name) != f.default
        }
        write_json(self.path, {"version": FILE_VERSION, "values": values})
        with contextlib.suppress(OSError):  # Windows ACLs / unusual filesystems
            self.path.chmod(0o600)  # may hold an API key
