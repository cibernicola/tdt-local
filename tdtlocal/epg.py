"""Programme guide (EPG): XMLTV download, parsing and the "now / next" views served to the browser."""

from __future__ import annotations

import calendar
import gzip
import io
import logging
import re
import threading
import time
import urllib.error
import xml.etree.ElementTree as ET
from typing import Any

from .config import Config
from .net import Net
from .store import Programme, Store

log = logging.getLogger(__name__)

EPG_INTERVAL = 3600  # the source is regenerated hourly; with an ETag we only download when it changes
EPG_RETRY = 600
TICK_SECONDS = 30  # how often the background loop re-reads the settings
MAX_GZ = 12_000_000
MAX_XML = 60_000_000
MAX_EXTRA_XML = 80_000_000  # a community guide of every channel in Spain is some 35 MB of plain XML
EXTRA_INTERVAL = 6 * 3600  # it is big: look at it a few times a day, and with its ETag
DESCRIPTION_LIMIT = 600
XMLTV_TS = re.compile(r"(\d{14})(?:\s*(Z|[+-]\d{4}))?")


def xmltv_ts(value: str | None) -> int:
    """``"20261030065000 +0100"`` -> epoch seconds (UTC). Raises :class:`ValueError` if malformed."""
    match = XMLTV_TS.match(value or "")
    if not match:
        raise ValueError("fecha XMLTV no válida")
    ts = calendar.timegm(time.strptime(match.group(1), "%Y%m%d%H%M%S"))
    zone = match.group(2)
    if zone and zone != "Z":
        sign = 1 if zone[0] == "+" else -1
        ts -= sign * (int(zone[1:3]) * 3600 + int(zone[3:5]) * 60)
    return ts


def _programmes_of(data: bytes, only: set[str]):
    """The ``<programme>`` elements of the channels in ``only``, one at a time: the rest is never kept in memory."""
    for _event, element in ET.iterparse(io.BytesIO(data), events=("end",)):  # noqa: S314 - entities rejected by the caller
        if element.tag == "programme":
            if element.get("channel") in only:
                yield element
            element.clear()


def parse_xmltv(data: bytes, now: float | None = None, only: set[str] | None = None) -> dict[str, list[Programme]]:
    """``{epg_id: [[start, end, title, description, category], ...]}`` without programmes already over.

    ``only``: keep just these channels (for a big guide of which a few channels are wanted).
    Documents declaring entities are rejected (billion-laughs protection).
    """
    if b"<!entity" in data.lower():
        raise ValueError("XML con entidades: rechazado")
    if b"\x00" in data[:512]:  # UTF-16 or UTF-32: the check above could not see an entity declaration written in them
        raise ValueError("XML que no está en UTF-8: rechazado")
    now = time.time() if now is None else now
    out: dict[str, list[Programme]] = {}
    if only is None:
        root = ET.fromstring(data)  # noqa: S314 - entities rejected above, size capped by the caller
        programmes = root.iter("programme")
    else:
        programmes = _programmes_of(data, only)
    for programme in programmes:
        channel = programme.get("channel")
        try:
            start, end = xmltv_ts(programme.get("start")), xmltv_ts(programme.get("stop"))
        except ValueError:
            continue
        title = (programme.findtext("title") or "").strip()
        if not channel or not title or end <= start or end <= now:
            continue
        category = (programme.findtext("category") or "").strip()
        out.setdefault(channel, []).append(
            [
                start,
                end,
                title,
                (programme.findtext("desc") or "").strip()[:DESCRIPTION_LIMIT],
                "" if category == "Desconocido" else category,
            ]
        )
    for items in out.values():
        items.sort(key=lambda p: p[0])
    return out


class EpgSyncer:
    """Keeps ``store.epg`` fresh and builds the JSON the browser asks for."""

    def __init__(self, config: Config, store: Store, net: Net) -> None:
        self.config = config
        self.store = store
        self.net = net
        self._lock = threading.Lock()
        self._next_due = 0.0
        self._extra_due = 0.0
        self._extra_wanted: frozenset[str] = frozenset()  # the channels the extra guide was last read for

    def _fetch(self, kind: str, force: bool) -> tuple[dict[str, list[Programme]], str | None] | None:
        """``(guide, etag)``, or ``None`` when the source did not change."""
        store = self.store
        headers = {}
        etag = store.epg_meta["etag"].get(kind)
        if etag and store.epg[kind] and not force:
            headers["If-None-Match"] = etag
        try:
            body, response_headers = self.net.fetch_trusted(self.config.epg_sources[kind], headers, limit=MAX_GZ)
        except urllib.error.HTTPError as exc:
            if exc.code == 304:
                return None
            raise
        if len(body) > MAX_GZ:
            raise ValueError("la guía es demasiado grande")
        if body[:2] == b"\x1f\x8b":
            body = gzip.GzipFile(fileobj=io.BytesIO(body)).read(MAX_XML + 1)
        if len(body) > MAX_XML:
            raise ValueError("la guía descomprimida es demasiado grande")
        return parse_xmltv(body), response_headers.get("ETag")

    def sync(self, force: bool = False) -> dict[str, Any]:
        """Download the TV and radio guides. A failure in one does not discard the other."""
        with self._lock:
            store = self.store
            now = int(time.time())
            errors: list[str] = []
            changed = False
            for kind in ("tv", "radio"):
                try:
                    fetched = self._fetch(kind, force)
                except Exception as exc:
                    if isinstance(exc, urllib.error.HTTPError):
                        errors.append(f"{kind}: HTTP {exc.code}")
                    else:
                        errors.append(f"{kind}: {type(exc).__name__} {exc}")
                    continue
                if fetched is None:
                    continue
                with store.lock:
                    store.epg[kind] = fetched[0]
                    store.epg_meta["etag"][kind] = fetched[1]
                changed = True
            with store.lock:
                store.epg_meta.update(checked=now, error="; ".join(errors) or None)
                if changed:
                    store.epg_meta["updated"] = now
                channels = sum(len(v) for v in store.epg.values())
            return {"changed": changed, "channels": channels, "error": errors or None}

    def extra_ids(self) -> set[str]:
        """Guide ids of the own channels that the lists' guides do not have: what the extra guide is read for."""
        with self.store.lock:
            known = set(self.store.epg["tv"]) | set(self.store.epg["radio"])
            return {c["epg"] for c in self.store.custom if c.get("epg") and c["epg"] not in known}

    def sync_extra(self, force: bool = False) -> dict[str, Any]:
        """Read, from the extra guide, the programme of the own channels that have a guide id the lists lack."""
        with self._lock:
            store = self.store
            wanted = self.extra_ids()
            if not wanted:
                with store.lock:
                    store.epg["extra"] = {}
                return {"changed": False, "channels": 0, "error": None}
            headers = {}
            etag = store.epg_meta["etag"].get("extra")
            if etag and store.epg["extra"] and not force and frozenset(wanted) == self._extra_wanted:
                headers["If-None-Match"] = etag
            try:
                body, response_headers = self.net.fetch_trusted(
                    self.config.epg_extra_source, headers, timeout=60, limit=MAX_EXTRA_XML
                )
                if len(body) > MAX_EXTRA_XML:
                    raise ValueError("la guía extra es demasiado grande")
                if body[:2] == b"\x1f\x8b":
                    body = gzip.GzipFile(fileobj=io.BytesIO(body)).read(MAX_EXTRA_XML + 1)
                    if len(body) > MAX_EXTRA_XML:
                        raise ValueError("la guía extra descomprimida es demasiado grande")
                guide = parse_xmltv(body, only=wanted)
            except urllib.error.HTTPError as exc:
                exc.close()
                if exc.code == 304:
                    return {"changed": False, "channels": len(store.epg["extra"]), "error": None}
                return {"changed": False, "channels": 0, "error": [f"extra: HTTP {exc.code}"]}
            except Exception as exc:
                return {"changed": False, "channels": 0, "error": [f"extra: {type(exc).__name__} {exc}"]}
            with store.lock:
                store.epg["extra"] = guide
                store.epg_meta["etag"]["extra"] = response_headers.get("ETag")
                store.epg_meta["updated"] = int(time.time())
            self._extra_wanted = frozenset(wanted)
            return {"changed": True, "channels": len(guide), "error": None}

    def refresh_soon(self) -> None:
        """Ask the background loop to download the guides at its next tick (enabled, or sources changed)."""
        self._next_due = 0.0
        self._extra_due = 0.0

    def run(self, stop: threading.Event) -> None:
        """Background loop. Runs even when the guide is disabled, so enabling it later needs no restart."""
        while True:
            if self.config.epg_enabled and time.time() >= self._next_due:
                result = self.sync(force=self._next_due == 0.0)
                if result["error"]:
                    log.warning("guía de programación: %s", "; ".join(result["error"]))
                    self._next_due = time.time() + EPG_RETRY
                else:
                    if result["changed"]:
                        log.info("guía de programación: %d canales", result["channels"])
                    self._next_due = time.time() + EPG_INTERVAL
            if self.config.epg_enabled and self.config.epg_extra_enabled and time.time() >= self._extra_due:
                result = self.sync_extra(force=self._extra_due == 0.0)
                if result["error"]:
                    log.warning("guía extra: %s", "; ".join(result["error"]))
                    self._extra_due = time.time() + EPG_RETRY
                else:
                    if result["changed"]:
                        log.info("guía extra: %d canales", result["channels"])
                    self._extra_due = time.time() + EXTRA_INTERVAL
            if stop.wait(TICK_SECONDS):
                return

    def payload(self, epg_id: str = "", now: float | None = None) -> dict[str, Any]:
        """Without an id: the next three programmes of every channel. With an id: that channel's full guide."""
        now = time.time() if now is None else now
        store = self.store
        with store.lock:
            if epg_id:
                items = (
                    store.epg["tv"].get(epg_id)
                    or store.epg["radio"].get(epg_id)
                    or store.epg["extra"].get(epg_id)
                    or store.plugin_guide().get(epg_id)
                    or []
                )
                return {"id": epg_id, "programmes": [p for p in items if p[1] > now][:40]}
            upcoming: dict[str, list[Programme]] = {}
            for guide in (store.epg["tv"], store.epg["radio"], store.epg["extra"], store.plugin_guide()):
                for key, programmes in guide.items():
                    head = [p[:3] for p in programmes if p[1] > now][:3]
                    if head:
                        upcoming[key] = head
            return {
                "updated": store.epg_meta["updated"],
                "checked": store.epg_meta["checked"],
                "error": store.epg_meta["error"],
                "now": upcoming,
            }
