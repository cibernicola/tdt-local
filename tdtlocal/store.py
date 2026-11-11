"""In-memory state of the application and its persistence under ``data/``."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

from . import headers as hdr
from . import u7d
from .config import Config
from .custom import MAX_SOURCES, build_custom_entry, guess_fmt, is_youtube
from .net import Net, host_of
from .parser import Channel
from .providers import ALLOWED, MAX_PROVIDERS, clean_channels, clean_guide, clean_provider
from .util import normalize

log = logging.getLogger(__name__)

Programme = list  # [start, end, title, description, category]


def write_json(path: Path, obj: Any, private: bool = False) -> None:
    """Atomic write: a crash never leaves a half-written file. ``private``: for a file that may hold a credential (a
    cookie in the headers of a channel), readable only by the user from the moment it exists (the mode is ignored on
    Windows, where the folder of the user is already private)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    text = json.dumps(obj, ensure_ascii=False)
    if private:
        tmp.unlink(missing_ok=True)  # a leftover from a crash could have wider permissions
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
    else:
        tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def read_json(path: Path) -> dict[str, Any] | None:
    """Return the JSON object stored in ``path``, or ``None`` if missing or unreadable."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def source_ok(channel: Channel, url: str, status: dict[str, dict]) -> bool | None:
    """Last health result of one source. YouTube and custom channels are never checked."""
    if is_youtube(url) or u7d.is_u7d(url) or channel.get("custom"):
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
        self.epg_plugins: dict[
            str, dict[str, list[Programme]]
        ] = {}  # plugin id -> its guide (in memory: the plugin gives it again)
        self.provided: dict[str, list[Channel]] = {}  # plugin id -> the channels that plugin provides (providers.json)
        self.epg: dict[str, dict[str, list[Programme]]] = {"tv": {}, "radio": {}, "extra": {}}
        self.epg_meta: dict[str, Any] = {"checked": None, "updated": None, "error": None, "etag": {}}
        self.status: dict[str, dict] = {}  # stream url -> {ok, ts, ms | err}
        self.health: dict[str, Any] = {"running": False, "done": 0, "total": 0, "finished": None}
        self.logo_urls: set[str] = set()
        self.cover_urls: set[str] = set()  # U7D programme covers, learnt as the listings are read
        self.custom_headers: dict[
            str, dict[str, str]
        ] = {}  # channel id -> request headers (its own, or set by the user)
        self.overrides: dict[str, dict[str, str]] = {}  # channel of a public list -> the headers the user set for it
        self.header_hosts: dict[str, set[str]] = {}  # channel id -> hosts of its links: where the credentials may go

    # ---- derived views
    def all_channels(self) -> list[Channel]:
        with self.lock:
            tv = u7d.channels(self.channels) if self.channels else []
            provided = [c for channels in self.provided.values() for c in channels]
            return self.channels + tv + self.radios + self.custom + provided

    def sources(self, kind: str) -> dict[str, str]:
        """``url -> format`` of the checkable streams of ``"tv"``, ``"radio"`` or ``"all"``."""
        with self.lock:
            pool = self.channels if kind == "tv" else self.radios if kind == "radio" else self.channels + self.radios
            out: dict[str, str] = {}
            for ch in pool:
                fmts = ch.get("fmts") or []
                for i, url in enumerate(ch["sources"]):
                    if not is_youtube(url):
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
            merged = {cid: dict(h) for cid, h in self.overrides.items() if h}
            merged.update({ch["id"]: ch["headers"] for ch in self.custom if ch.get("headers")})
            self.custom_headers = merged
            self.header_hosts = {
                ch["id"]: {host_of(u) for u in ch["sources"]} for ch in self.all_channels() if ch["id"] in merged
            }

    # ---- persistence
    @property
    def _paths(self) -> dict[str, Path]:
        d = self.config.data_dir
        return {
            "tv": d / "tv.json",
            "radio": d / "radio.json",
            "custom": d / "custom.json",
            "headers": d / "headers.json",
            "providers": d / "providers.json",
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
            write_json(
                self._paths["custom"], {"channels": self.custom}, private=True
            )  # their headers may hold a cookie

    def save_providers(self) -> None:
        with self.lock:
            write_json(self._paths["providers"], {"providers": self.provided})

    # ---- channels that plugins provide
    def set_provided(self, provider: str, raw: Any) -> int:
        """Replace the channels a plugin provides (all or nothing: ``ValueError`` and nothing changes).
        An empty list removes them. Returns how many it provides now."""
        provider = clean_provider(provider)
        channels = clean_channels(provider, raw)
        with self.lock:
            if channels and provider not in self.provided and len(self.provided) >= MAX_PROVIDERS:
                raise ValueError(f"ya hay {MAX_PROVIDERS} plugins que aportan canales")
            if channels:
                self.provided[provider] = channels
            else:
                self.provided.pop(provider, None)
        self.rebuild_allowlists()
        self.save_providers()
        return len(channels)

    def set_provided_epg(self, provider: str, raw: Any) -> int:
        """Replace the guide a plugin provides (all or nothing); empty removes it. Returns how many channels."""
        provider = clean_provider(provider)
        guide = clean_guide(provider, raw, time.time())
        with self.lock:
            if guide:
                self.epg_plugins[provider] = guide
            else:
                self.epg_plugins.pop(provider, None)
        return len(guide)

    def provided_epg_counts(self) -> dict[str, int]:
        with self.lock:
            return {pid: len(guide) for pid, guide in self.epg_plugins.items()}

    def plugin_guide(self) -> dict[str, list[Programme]]:
        """The guides of every plugin as one ``{plugin:channel: programmes}`` (called with the lock held)."""
        return {key: programmes for guide in self.epg_plugins.values() for key, programmes in guide.items()}

    def provided_counts(self) -> dict[str, int]:
        with self.lock:
            return {pid: len(channels) for pid, channels in self.provided.items()}

    def save_headers(self) -> None:
        with self.lock:
            write_json(self._paths["headers"], {"overrides": self.overrides}, private=True)

    # ---- headers of a channel
    def headers_for(self, tag: str, url: str) -> dict[str, str]:
        """The headers a request for ``url`` of channel ``tag`` may carry: the plain ones always, the ones that may
        be credentials
        only if ``url`` is on a host of the channel's own links."""
        with self.lock:
            current = self.custom_headers.get(tag)
            if not current:
                return {}
            return hdr.for_host(current, host_of(url), self.header_hosts.get(tag, ()))

    def credential_names(self, tag: str) -> list[str]:
        with self.lock:
            return [k for k in self.custom_headers.get(tag, {}) if hdr.is_sensitive(k)]

    def find_channel(self, channel_id: str) -> Channel | None:
        with self.lock:
            return next((c for c in self.all_channels() if c["id"] == channel_id), None)

    def get_headers(self, channel_id: str) -> dict[str, Any] | None:
        """The headers of a channel as the page and the MCP may see them (``headers.describe``), or ``None`` if the
        channel does not exist."""
        channel = self.find_channel(channel_id)
        if channel is None:
            return None
        with self.lock:
            current = channel["headers"] if channel.get("custom") else self.overrides.get(channel_id, {})
            return {
                "id": channel_id,
                "name": channel["name"],
                "kind": channel.get("kind") or "tv",
                "own": bool(channel.get("custom")),
                "headers": hdr.describe(current),
            }

    def set_headers(self, channel_id: str, changes: Any, replace: bool = False) -> dict[str, Any]:
        """Change the headers of a channel (own, or of a public list: those are kept apart and survive a list update).
        ``changes`` is ``{name: value}``; a ``null`` removes one. ``ValueError`` if a header is not valid or the
        channel does not exist."""
        channel = self.find_channel(channel_id)
        if channel is None:
            raise ValueError("no hay ningún canal con ese id")
        with self.lock:
            current = (
                {}
                if replace
                else dict(channel["headers"] if channel.get("custom") else self.overrides.get(channel_id, {}))
            )
            updated = hdr.merge(current, changes)
            if channel.get("custom"):
                channel["headers"] = updated
            elif updated:
                self.overrides[channel_id] = updated
            else:
                self.overrides.pop(channel_id, None)
        self.rebuild_allowlists()
        if channel.get("custom"):
            self.save_custom()
        else:
            self.save_headers()
        return self.get_headers(channel_id) or {}

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
        saved = read_json(paths["providers"])
        if saved and isinstance(saved.get("providers"), dict):
            for pid, raw in list(saved["providers"].items())[:MAX_PROVIDERS]:
                try:
                    # only the fields a plugin may give: the id, the category and the rest are made again
                    kept = [{k: v for k, v in c.items() if k in ALLOWED} for c in raw if isinstance(c, dict)]
                    self.provided[clean_provider(pid)] = clean_channels(pid, kept)
                except ValueError:
                    log.warning("canales de un plugin descartados por no ser válidos")
        stored = read_json(paths["headers"])
        if stored and isinstance(stored.get("overrides"), dict):
            for cid, raw in stored["overrides"].items():
                cleaned = hdr.clean(raw)
                if isinstance(cid, str) and cleaned:
                    self.overrides[cid] = cleaned
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

    def add_or_merge_custom(self, data: dict[str, Any]) -> tuple[str, bool]:
        """Add a user channel; but if the user already has one with the same name, its links become more sources of it.

        Returns ``(id, merged)``. A channel can then have a stream and a player that is only embedded: the page tries
        them in turn. Raises :class:`ValueError` on bad input.
        """
        entry = build_custom_entry({k: v for k, v in (data or {}).items() if k != "id"})
        with self.lock:
            same = next(
                (
                    c
                    for c in self.custom
                    if c["kind"] == entry["kind"] and normalize(c["name"]) == normalize(entry["name"])
                ),
                None,
            )
            if same is None:
                merged = False
            else:
                merged = True
                for url in entry["sources"]:
                    if url not in same["sources"] and len(same["sources"]) < MAX_SOURCES:
                        same["sources"].append(url)
                same["fmts"] = [guess_fmt(u) if same["kind"] == "radio" else "" for u in same["sources"]]
                for key in ("web", "logo", "epg"):
                    same[key] = same[key] or entry[key]
                same["headers"] = same["headers"] or entry["headers"]
        if merged and same is not None:
            self.rebuild_allowlists()
            self.save_custom()
            return same["id"], True
        return self.add_custom(data), False

    def delete_custom(self, cid: str) -> bool:
        with self.lock:
            before = len(self.custom)
            self.custom = [c for c in self.custom if c["id"] != cid]
            removed = len(self.custom) != before
        if removed:
            self.rebuild_allowlists()
            self.save_custom()
        return removed
