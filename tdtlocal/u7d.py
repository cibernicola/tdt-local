"""U7D ("últimos 7 días"): what the channels with catch-up broadcast recently, newest first, ready to play.

Today only RTVE (La 1, La 2, 24 horas, Teledeporte, Clan): its public schedule JSON lists the programmes of the last
week and its public resolver gives each one as HLS in the clear. Programmes with DRM are refused with a clear message.
Everything goes through :class:`~tdtlocal.net.Net` with the application's usual headers; nothing here pretends to be
another site's web player (no ``Origin``, no ``Referer``).

Other broadcasters fit the same two steps: a *lister* (channel -> programmes) and a *resolver* (programme -> something
the page can play). Add them to ``LISTERS`` and ``RESOLVERS`` only if they offer it without impersonating their web.
"""

from __future__ import annotations

import calendar
import datetime
import json
import re
import threading
import time
import urllib.parse
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, NamedTuple
from zoneinfo import ZoneInfo

if TYPE_CHECKING:
    from .net import Net

DAYS = 7
CACHE_SECONDS = 600  # a listing changes slowly
MAX_ITEMS = 400
MAX_JSON = 4_000_000  # a week of one channel is a few hundred KB: more than this is not a schedule
REF = re.compile(r"[\w.-]{1,80}")

RTVE_SCHEDULE = "https://www.rtve.es/api/schedule/{slug}.json?pastDays=" + str(DAYS) + "&nextDays=0"
RTVE_RESOLVER = "https://ztnr.rtve.es/ztnr/{asset}.m3u8"
RTVE_THUMB = "https://img.rtve.es/v/{asset}/?w=320"  # 12-23 KB


class U7dChannel(NamedTuple):
    name: str
    provider: str  # "rtve"
    ref: str  # the provider's own id of the channel (RTVE: the schedule slug)
    logo_id: str  # id of the live channel whose logo it reuses


# The ids of the live channels, in the order of the dial.
CHANNELS: dict[str, U7dChannel] = {
    "la-1": U7dChannel("La 1", "rtve", "tv1", "la-1"),
    "la-2": U7dChannel("La 2", "rtve", "la2", "la-2"),
    "24h": U7dChannel("24 Horas", "rtve", "24h", "24h"),
    "teledeporte": U7dChannel("Teledeporte", "rtve", "dep", "teledeporte"),
    "clan": U7dChannel("Clan", "rtve", "clan", "clan"),
}
SCHEME = "u7d:"
# Covers the page may hand over (the desktop app reads Atresplayer's own list, whose images the server cannot learn
# from a listing): only this host, only https, and a bounded number.
COVER_HOSTS = frozenset({"imagenes.atresplayer.com"})
MAX_COVERS = 300


def is_u7d(url: str | None) -> bool:
    return (url or "").startswith(SCHEME)


def channels(live: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """List entries (``kind: "u7d"``) for the channels with catch-up, with the logo of their live channel."""
    by_id = {ch["id"]: ch for ch in live}
    out = []
    for key, chan in CHANNELS.items():
        base = by_id.get(chan.logo_id) or {}
        out.append(
            {
                "id": "u7d-" + key,
                "name": chan.name,
                "kind": "u7d",
                "category": "Últimos 7 días",
                "group": "",
                "sources": [SCHEME + key],
                "fmts": [""],
                "web": "",
                "logo": base.get("logo", ""),
                "epg": "",
                "tags": [],
            }
        )
    return out


def cover_ok(url: Any) -> bool:
    """Is this a cover address the logo proxy may fetch for the page?"""
    if not isinstance(url, str) or len(url) > 400:
        return False
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return parts.scheme == "https" and parts.hostname in COVER_HOSTS and not parts.username and parts.port is None


def _item(ref: str, title: str, subtitle: str, ts: int, image: str = "") -> dict[str, Any]:
    return {"id": ref, "title": title, "subtitle": subtitle, "ts": ts, "image": image}


def _newest_first(items: list[dict[str, Any]], now: float) -> list[dict[str, Any]]:
    """Drop duplicates and what has not been broadcast yet, newest first, capped."""
    seen: set[str] = set()
    out = []
    for it in sorted(items, key=lambda i: i["ts"], reverse=True):
        if it["id"] in seen or not it["id"] or it["ts"] > now:
            continue
        seen.add(it["id"])
        out.append(it)
    return out[:MAX_ITEMS]


# ---- RTVE
def _rtve_ts(begin: str) -> int:
    """``"20261101213000"`` (Madrid time) -> epoch seconds, or 0 if it is not a time."""
    try:
        parts = (
            int(begin[0:4]),
            int(begin[4:6]),
            int(begin[6:8]),
            int(begin[8:10]),
            int(begin[10:12]),
            int(begin[12:14]),
        )
        tz = ZoneInfo("Europe/Madrid")
    except ValueError:
        return 0
    except Exception:  # no time zone database (Windows without tzdata): the order is right, the clock may be 1-2 h off
        try:
            return calendar.timegm((*parts, 0, 0, 0))
        except (ValueError, OverflowError):
            return 0
    try:
        return int(datetime.datetime(*parts, tzinfo=tz).timestamp())
    except (ValueError, OverflowError):
        return 0


def parse_rtve(data: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for it in data.get("items") or []:
        asset = str(it.get("idAsset") or "")
        if not REF.fullmatch(asset):
            continue
        episode = str(it.get("episode_name") or "")
        out.append(
            _item(
                asset,
                str(it.get("name") or it.get("original_event_name") or "Sin título"),
                "" if episode in ("", "None") else episode,
                _rtve_ts(str(it.get("begintime") or "")),
                RTVE_THUMB.format(asset=asset),
            )
        )
    return out


def _get_json(net: Net, url: str) -> dict[str, Any]:
    with net.open(url, {"Accept": "application/json"}, False, 20) as resp:
        raw = resp.read(MAX_JSON + 1)
    if len(raw) > MAX_JSON:
        raise ValueError("la respuesta es demasiado grande")
    data = json.loads(raw)
    return data if isinstance(data, dict) else {}


def _list_rtve(net: Net, ref: str) -> list[dict[str, Any]]:
    return parse_rtve(_get_json(net, RTVE_SCHEDULE.format(slug=urllib.parse.quote(ref))))


LISTERS: dict[str, Callable[[Net, str], list[dict[str, Any]]]] = {"rtve": _list_rtve}


class U7d:
    """Listings with a short cache (one lock: a second request for the same channel waits for the first)."""

    def __init__(self, net: Net, allow_image: Callable[[str], None] = lambda _url: None) -> None:
        self.net = net
        self._allow_image = allow_image  # the logo proxy only serves URLs it has been told about
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}

    def programmes(self, key: str, now: float | None = None) -> list[dict[str, Any]]:
        if key not in CHANNELS:
            raise ValueError(f"canal desconocido: {key}")
        now = time.time() if now is None else now
        with self._lock:
            hit = self._cache.get(key)
            if hit and now - hit[0] < CACHE_SECONDS:
                return hit[1]
            chan = CHANNELS[key]
            items = _newest_first(LISTERS[chan.provider](self.net, chan.ref), now)
            for item in items:
                if item["image"]:
                    self._allow_image(item["image"])
            self._cache[key] = (now, items)
            return items


# ---- playing
def _resolve_rtve(net: Net, asset: str) -> dict[str, str]:
    with net.open(RTVE_RESOLVER.format(asset=urllib.parse.quote(asset)), {}, False, 15) as resp:
        final, text = resp.geturl(), resp.read(65536).decode("utf-8", "replace")
    if "#EXTM3U" not in text[:64]:
        raise RuntimeError("RTVE no devolvió una lista HLS")
    if "hls_drm" in text or "rtvedrmstaging" in text:
        raise RuntimeError("este programa de RTVE lleva DRM")
    return {"url": final}


RESOLVERS: dict[str, Callable[[Net, str], dict[str, str]]] = {"rtve": _resolve_rtve}


def resolve(net: Net, key: str, ref: str) -> dict[str, str]:
    """``{"url": hls}`` of one programme."""
    if key not in CHANNELS or not REF.fullmatch(ref):
        raise ValueError("programa no válido")
    return RESOLVERS[CHANNELS[key].provider](net, ref)
