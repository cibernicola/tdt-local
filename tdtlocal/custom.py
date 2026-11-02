"""User-defined channels (``data/custom.json``): validation of what the user pastes."""

from __future__ import annotations

import re
from typing import Any

from .parser import Channel
from .util import slugify

YOUTUBE = re.compile(r"^https?://(?:www\.|m\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)/", re.I)
TWITCH = re.compile(r"^https://(?:(?:www\.|m\.)?twitch\.tv/[a-z0-9_]+/?(?:[?#]|$)|player\.twitch\.tv/\?)", re.I)
HTTP_URL = re.compile(r"https?://\S+$")
CUSTOM_HEADERS = ("Origin", "Referer", "User-Agent")
MAX_SOURCES = 6
MAX_EPG_ID = 80
MAX_HEADER_LEN = 300


def is_youtube(url: str | None) -> bool:
    return bool(YOUTUBE.match(url or ""))


def is_twitch(url: str | None) -> bool:
    return bool(TWITCH.match(url or ""))


def guess_fmt(url: str) -> str:
    """Audio format from the file extension; anything else is a generic ``"stream"``."""
    match = re.search(r"\.(m3u8?|mp3|aac)(?:\?|$)", url, re.I)
    if not match:
        return "stream"
    ext = match.group(1).lower()
    return "m3u8" if ext == "m3u" else ext


def _clean_headers(raw: Any) -> dict[str, str]:
    headers: dict[str, str] = {}
    source = raw if isinstance(raw, dict) else {}
    for key in CUSTOM_HEADERS:
        value = source.get(key)
        if isinstance(value, str) and 0 < len(value) <= MAX_HEADER_LEN and "\r" not in value and "\n" not in value:
            headers[key] = value
    return headers


def build_custom_entry(data: Any) -> Channel:
    """Validate user input and return a channel dict.

    Raises :class:`ValueError` (with a message meant for the user) when the name is missing, or there is neither a
    stream link nor a web page (a channel that can only be watched on its own web has no sources).
    Only ``http(s)`` links are kept, and header values cannot contain line breaks.
    """
    if not isinstance(data, dict):
        raise ValueError("entrada no válida")
    name = str(data.get("name") or "").strip()[:80]
    sources = [u.strip() for u in (data.get("sources") or []) if isinstance(u, str)]
    sources = [u for u in sources if HTTP_URL.match(u)][:MAX_SOURCES]
    web, logo = str(data.get("web") or ""), str(data.get("logo") or "")
    epg = str(data.get("epg") or "").strip()
    if len(epg) > MAX_EPG_ID or any(ord(c) < 32 for c in epg):
        epg = ""
    if not name or not (sources or HTTP_URL.match(web)):
        raise ValueError("falta el nombre o el enlace")
    kind = "radio" if data.get("kind") == "radio" else "tv"
    return {
        "id": str(data.get("id") or "custom-" + slugify(name)),
        "name": name,
        "kind": kind,
        "category": "Propios",
        "group": "",
        "sources": sources,
        "fmts": [guess_fmt(u) if kind == "radio" else "" for u in sources],
        "web": web if HTTP_URL.match(web) else "",
        "logo": logo if HTTP_URL.match(logo) else "",
        "epg": epg,
        "tags": [],
        "custom": True,
        "headers": _clean_headers(data.get("headers")),
    }
