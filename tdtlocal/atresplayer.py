"""Directos de Atresplayer (Antena 3, laSexta...): la API pública del reproductor web da el HLS en claro.

Solo resuelve la URL; el vídeo va por el proxy HLS de siempre.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .net import Net

API = "https://api.atresplayer.com"
HEADERS = {
    "Accept": "application/json",
    "Origin": "https://www.atresplayer.com",
    "Referer": "https://www.atresplayer.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
}
SCHEME = "atres:"
LOGOS = "https://raw.githubusercontent.com/davidmuma/picons_dobleM/master/icon/"
# key -> (name, guide id, api slug, logo file)
CHANNELS = {
    "antena3": ("Antena 3", "Antena3.TV", "antena3", "Antena 3"),
    "lasexta": ("laSexta", "LaSexta.TV", "lasexta", "La Sexta"),
    "neox": ("Neox", "Neox.TV", "neox", "Neox"),
    "nova": ("Nova", "Nova.TV", "nova", "Nova"),
    "mega": ("Mega", "Mega.TV", "mega", "Mega"),
    "atreseries": ("Atreseries", "Atreseries.TV", "atreseries", "Atreseries"),
}


def is_atres(url: str | None) -> bool:
    return (url or "").startswith(SCHEME)


def channels() -> list[dict[str, Any]]:
    return [
        {
            "id": key,
            "name": name,
            "kind": "tv",
            "category": "Nacionales",
            "group": "",
            "sources": [SCHEME + key],
            "fmts": [""],
            "web": f"https://www.atresplayer.com/directos/{slug}/",
            "logo": LOGOS + urllib.parse.quote(logo + ".png"),
            "epg": epg,
            "tags": [],
        }
        for key, (name, epg, slug, logo) in CHANNELS.items()
    ]


def _get(net: Net, url: str) -> Any:
    with net.open(url, HEADERS, False, 15) as resp:  # fixed https host; Net still checks the address
        return json.load(resp)


def resolve(net: Net, key: str) -> str:
    """HLS master URL of a live channel."""
    if key not in CHANNELS:
        raise ValueError(f"canal desconocido: {key}")
    slug = CHANNELS[key][2]
    channel_id = next(
        (c["id"] for c in _get(net, f"{API}/client/v1/info/channels") if c.get("link", {}).get("url") == f"/{slug}/"),
        None,
    )
    if not channel_id:
        raise RuntimeError("Atresplayer no lista este canal")
    data = _get(net, f"{API}/player/v1/live/{channel_id}?NODRM=true")
    for source in data.get("sourcesLive") or []:
        src = source.get("src", "")
        if re.search(r"\.m3u8(\?|$)", src):
            return src
    raise RuntimeError("Atresplayer no devolvió un HLS en claro")
