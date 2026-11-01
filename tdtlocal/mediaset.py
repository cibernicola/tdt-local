"""Directos de Mediaset (Telecinco, Cuatro...) para reproducir en el navegador con su Widevine.

Solo resuelve el manifiesto DASH y la URL de licencia. No toca claves ni descifra nada: el
navegador pide la licencia a través de ``relay_license`` y la CDM de Chrome hace el resto.
"""

from __future__ import annotations

import datetime
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .net import Net

APPNAME = "web//mediasetplay-web/1.2.1-d1b2024"
BASE = "https://services-ott-prod-fe.mediaset.net/esp"
LICENSE = (
    "https://widevine.entitlement.theplatform.eu/wv/web/ModularDrm/getRawWidevineLicense"
    "?releasePid={pid}&account=http%3A%2F%2Faccess.auth.theplatform.com%2Fdata%2FAccount%2F{aid}"
    "&schema=1.0&token={token}"
)
HEADERS = {
    "Origin": "https://www.mediasetinfinity.es",
    "Referer": "https://www.mediasetinfinity.es/",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    ),
}
CHANNELS = {
    "telecinco": "T5",
    "cuatro": "CT",
    "fdf": "FD",
    "energy": "EN",
    "bemad": "BM",
    "boing": "BO",
    "divinity": "DV",
}
LICENSE_HOST = "widevine.entitlement.theplatform.eu"


def _call(net: Net, url: str, body: dict[str, Any] | None = None, token: str = "", raw: bool = False) -> Any:
    headers = dict(HEADERS)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with net.open(url, headers, False, 15, data) as resp:  # fixed https hosts; Net still checks the address
        payload = resp.read()
    return payload if raw else json.loads(payload)


def _tracking(smil: bytes) -> tuple[str, dict[str, str]]:
    root = ET.fromstring(smil)  # noqa: S314 - response from the Mediaset API
    manifest = ""
    for tag in ("video", "ref"):
        node = root.find(f".//{{*}}{tag}")
        if node is not None and node.get("src"):
            manifest = node.get("src", "")
            break
    info: dict[str, str] = {}
    for param in root.findall(".//{*}param"):
        if param.get("name") == "trackingData":
            info = dict(p.split("=", 1) for p in param.get("value", "").split("|") if "=" in p)
    return manifest, info


def resolve(net: Net, channel: str) -> dict[str, str]:
    """Devuelve ``{"mpd": ..., "license": ...}`` para ``telecinco``, ``cuatro``..."""
    code = CHANNELS.get(channel.lower())
    if not code:
        raise ValueError(f"canal desconocido: {channel}")
    login = _call(net, f"{BASE}/idm/v3.0/anonymous/login", {"client_id": "mediasetplay", "appName": APPNAME})[
        "response"
    ]
    sid = login["sid"]
    jwt = login.get("beToken") or login.get("token") or sid
    check = _call(
        net,
        f"{BASE}/playback/v3.0/check?sid={urllib.parse.quote_plus(sid)}",
        {
            "channelCode": code,
            "streamType": "LIVE",
            "delivery": "Streaming",
            "createDevice": True,
            "overrideAppName": APPNAME,
        },
        token=jwt,
    )["response"]["mediaSelector"]
    query = {"format": check.get("format", "SMIL"), "auth": jwt}
    for field in ("formats", "assetTypes", "balance", "auto", "tracking", "delivery"):
        if check.get(field) not in (None, ""):
            query[field] = str(check[field])
    smil = _call(net, f"{check['url']}?{urllib.parse.urlencode(query)}", raw=True)
    manifest, info = _tracking(smil)
    pid = info.get("pid") or info.get("releasePid") or info.get("mediaPid")
    aid = info.get("aid") or info.get("accountID") or info.get("accountId")
    if not manifest or not pid or not aid:
        raise RuntimeError("Mediaset no devolvió manifiesto o datos de licencia")
    lic = LICENSE.format(
        pid=urllib.parse.quote_plus(pid), aid=urllib.parse.quote_plus(aid), token=urllib.parse.quote_plus(jwt)
    )
    return {"mpd": manifest, "license": lic}


def relay_license(net: Net, url: str, challenge: bytes) -> bytes:
    """Reenvía la petición de licencia de la CDM con el Origin de Mediaset. Bytes opacos."""
    if urllib.parse.urlsplit(url).hostname != LICENSE_HOST or not re.match(r"^https://", url):
        raise ValueError("servidor de licencias no permitido")
    headers = {**HEADERS, "Content-Type": "application/octet-stream"}
    with net.open(url, headers, False, 15, challenge) as resp:  # host checked above
        return resp.read()


def open_media(net: Net, url: str, byte_range: str = "") -> Any:
    """Abre un manifiesto o segmento de Mediaset con sus cabeceras (siguen cifrados: no se tocan)."""
    host = urllib.parse.urlsplit(url).hostname or ""
    if not url.startswith("https://") or not (host == "mediasetinfinity.es" or host.endswith(".mediasetinfinity.es")):
        raise ValueError("origen no permitido")
    headers = dict(HEADERS)
    if byte_range:
        headers["Range"] = byte_range
    return net.open(url, headers, False, 20)  # host checked above


_rebase: dict[str, int] = {}  # manifest URL -> seconds subtracted from its timeline (must not change between refreshes)


def _origin_seconds(text: str) -> int:
    """Start (whole seconds) of the first video segment: the timeline is counted from 1970, so this is huge."""
    template = re.search(
        r'<SegmentTemplate[^>]*timescale="(\d+)"[^>]*>(?:\s|<!--.*?-->)*<SegmentTimeline>\s*<S t="(\d+)"', text
    )
    return int(template.group(2)) // int(template.group(1)) if template else 0


def prepare_mpd(body: bytes, url: str) -> bytes:
    """Make the manifest usable from our proxy and give it a small timeline.

    * Relative ``BaseURL`` become absolute (the manifest arrives via our proxy, they would resolve there).
    * Timestamps count from 1970, so the browser's clock showed ~500000 hours. Subtracting a fixed offset
      (``presentationTimeOffset``) and moving ``availabilityStartTime`` by the same amount keeps the wall-clock
      mapping intact but makes the media clock start near zero, like the HLS channels.
    """
    text = body.decode("utf-8", "replace")

    def fix(match: re.Match[str]) -> str:
        return f"{match.group(1)}{urllib.parse.urljoin(url, match.group(2).strip())}</BaseURL>"

    text = re.sub(r"(<BaseURL[^>]*>)([^<]*)</BaseURL>", fix, text)
    start = re.search(r'availabilityStartTime="1970-01-01T00:00:00Z"', text)
    offset = _rebase.setdefault(url, _origin_seconds(text)) if start else 0
    if offset:
        moved = datetime.datetime.fromtimestamp(offset, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        text = text.replace(start.group(0), f'availabilityStartTime="{moved}"', 1)
        text = re.sub(
            r'<SegmentTemplate([^>]*?)timescale="(\d+)"',
            lambda m: (
                f'<SegmentTemplate{m.group(1)}timescale="{m.group(2)}" '
                f'presentationTimeOffset="{offset * int(m.group(2))}"'
            ),
            text,
        )
    return text.encode("utf-8")


SCHEME = "mediaset:"
KEYS = {"be-mad": "bemad"}  # channel id in the TDTChannels list -> key in CHANNELS


def is_mediaset(url: str | None) -> bool:
    return (url or "").startswith(SCHEME)


def attach(channels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Copies of ``channels`` where Mediaset's own channels get a ``mediaset:<key>`` source first."""
    out = []
    for ch in channels:
        key = KEYS.get(ch["id"], ch["id"])
        if ch.get("kind") == "tv" and key in CHANNELS and not any(is_mediaset(u) for u in ch["sources"]):
            ch = dict(ch, sources=[SCHEME + key, *ch["sources"]], fmts=["", *(ch.get("fmts") or [])])
        out.append(ch)
    return out
