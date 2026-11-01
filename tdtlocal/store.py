"""In-memory state of the application and its persistence under ``data/``."""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

from . import atresplayer, mediaset
from .config import Config
from .custom import build_custom_entry, is_youtube
from .net import Net
from .parser import Channel

log = logging.getLogger(__name__)

Programme = list  # [start, end, title, description, category]


def write_json(path: Path, obj: Any) -> None:
    """Atomic write: a crash never leaves a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def read_json(path: Path) -> dict[str, Any] | None:
    """Return the JSON object stored in ``path``, or ``None`` if missing or unreadable."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


DIAL = ("la-1", "la-2", "antena3", "cuatro", "telecinco", "lasexta")  # the number each has on the TDT dial
# then the rest of Mediaset and Atresmedia
THEN = ("fdf", "energy", "divinity", "be-mad", "boing", "neox", "nova", "mega", "atreseries")


def dial_order(channels: list[Channel]) -> list[Channel]:
    """The main national channels first, in their TDT numbering (1 La 1 ... 6 laSexta), then the rest of
    Mediaset and Atresmedia; everything else keeps its order."""
    by_id = {ch["id"]: ch for ch in channels if ch.get("kind") == "tv"}
    head = [by_id[i] for i in DIAL + THEN if i in by_id]
    return head + [ch for ch in channels if ch not in head]


def source_ok(channel: Channel, url: str, status: dict[str, dict]) -> bool | None:
    """Last health result of one source. YouTube and custom channels are never checked."""
    if is_youtube(url) or mediaset.is_mediaset(url) or atresplayer.is_atres(url) or channel.get("custom"):
        return None
    result = status.get(url)
    return result["ok"] if result else None


def channel_ok(channel: Channel, status: dict[str, dict]) -> bool | None:
    """``True`` if any source responds, ``False`` if all checked sources fail, ``None`` if unknown."""
    oks = [source_ok(channel, u, status) for u in channel["sources"]]
    if True in oks:
        return True
    if oks and all(o is False for o in oks):
        return False
    return None


class Store:
    """Channels, guides, health results and user data, guarded by one re-entrant lock."""

    def __init__(self, config: Config, net: Net) -> None:
        self.config = config
        self.net = net
        self.lock = threading.RLock()
        self.meta: dict[str, Any] = {
            "updated": None,
            "checked": None,
            "etag": None,
            "error": None,
            "source": config.tv_source,
        }
        self.channels: list[Channel] = []
        self.radio_meta: dict[str, Any] = {"updated": None, "checked": None, "etag": None, "error": None}
        self.radios: list[Channel] = []
        self.custom: list[Channel] = []
        self.epg: dict[str, dict[str, list[Programme]]] = {"tv": {}, "radio": {}}
        self.epg_meta: dict[str, Any] = {"checked": None, "updated": None, "error": None, "etag": {}}
        self.status: dict[str, dict] = {}  # stream url -> {ok, ts, ms | err}
        self.health: dict[str, Any] = {"running": False, "done": 0, "total": 0, "finished": None}
        self.logo_urls: set[str] = set()
        self.custom_headers: dict[str, dict[str, str]] = {}  # custom channel id -> extra request headers

    # ---- derived views
    def all_channels(self) -> list[Channel]:
        with self.lock:
            listed = mediaset.attach(self.channels)
            have = {ch["id"] for ch in listed}
            extra = [ch for ch in atresplayer.channels() if ch["id"] not in have] if listed else []
            return dial_order(listed + extra) + self.radios + self.custom

    def sources(self, kind: str) -> dict[str, str]:
        """``url -> format`` of the checkable streams of ``"tv"``, ``"radio"`` or ``"all"``."""
        with self.lock:
            pool = self.channels if kind == "tv" else self.radios if kind == "radio" else self.channels + self.radios
            out: dict[str, str] = {}
            for ch in pool:
                fmts = ch.get("fmts") or []
                for i, url in enumerate(ch["sources"]):
                    if not is_youtube(url) and not mediaset.is_mediaset(url):
                        out.setdefault(url, fmts[i] if i < len(fmts) else "")
        return out

    def rebuild_allowlists(self) -> None:
        """Make every known stream host reachable through the proxy and index logos/custom headers."""
        with self.lock:
            for ch in self.all_channels():
                for url in ch["sources"]:
                    self.net.allow(url)
                if ch["logo"]:
                    self.logo_urls.add(ch["logo"])
            self.custom_headers = {ch["id"]: ch["headers"] for ch in self.custom if ch.get("headers")}

    # ---- persistence
    @property
    def _paths(self) -> dict[str, Path]:
        d = self.config.data_dir
        return {
            "tv": d / "tv.json",
            "radio": d / "radio.json",
            "custom": d / "custom.json",
            "status": d / "status.json",
        }

    def save_feed(self, kind: str) -> None:
        with self.lock:
            if kind == "radio":
                write_json(self._paths["radio"], {"meta": self.radio_meta, "channels": self.radios})
            else:
                write_json(self._paths["tv"], {"meta": self.meta, "channels": self.channels})

    def save_status(self) -> None:
        with self.lock:
            write_json(self._paths["status"], {"status": self.status, "finished": self.health["finished"]})

    def save_custom(self) -> None:
        with self.lock:
            write_json(self._paths["custom"], {"channels": self.custom})

    def load(self) -> None:
        """Load whatever was cached by a previous run. Missing or corrupt files are ignored."""
        paths = self._paths
        tv = read_json(paths["tv"])
        if tv:
            self.meta.update(tv.get("meta", {}))
            self.meta["source"] = self.config.tv_source
            self.channels = tv.get("channels", [])
        radio = read_json(paths["radio"])
        if radio:
            self.radio_meta.update(radio.get("meta", {}))
            self.radios = radio.get("channels", [])
        custom = read_json(paths["custom"])
        if custom:
            for item in custom.get("channels", []):
                try:
                    self.custom.append(build_custom_entry(item))
                except ValueError:
                    log.warning("canal propio descartado por no ser válido")
        status = read_json(paths["status"])
        if status:
            self.status = status.get("status", {})
            self.health["finished"] = status.get("finished")
        self.rebuild_allowlists()

    # ---- custom channels
    def add_custom(self, data: dict[str, Any]) -> str:
        """Validate and store a user channel; returns its id. Raises :class:`ValueError` on bad input."""
        entry = build_custom_entry({k: v for k, v in (data or {}).items() if k != "id"})
        with self.lock:
            taken = {c["id"] for c in self.all_channels()}
            base, n = entry["id"], 2
            while entry["id"] in taken:
                entry["id"] = f"{base}-{n}"
                n += 1
            self.custom.append(entry)
        self.rebuild_allowlists()
        self.save_custom()
        return entry["id"]

    def delete_custom(self, cid: str) -> bool:
        with self.lock:
            before = len(self.custom)
            self.custom = [c for c in self.custom if c["id"] != cid]
            removed = len(self.custom) != before
        if removed:
            self.rebuild_allowlists()
            self.save_custom()
        return removed
