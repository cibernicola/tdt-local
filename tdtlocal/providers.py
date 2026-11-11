"""Channels that a plugin provides (a list from somewhere else, turned into TDT local channels). The plugin does the reading (it asks for
``network:`` and ``provide:channels``); this module only decides what a channel from a plugin may be, so that a plugin can add channels but
nothing more: no headers, no replacing the user's own channels, no more than a fixed number, only http(s) links.
"""

# ruff: noqa: E501 - prose for a reader, not code

from __future__ import annotations

import re
from typing import Any

from .custom import MAX_SOURCES, build_custom_entry
from .util import slugify

MAX_PROVIDED = 500  # channels per plugin
MAX_PROVIDERS = 10  # plugins that provide at the same time
MAX_GUIDE_IDS = 500  # channels with a guide, per plugin
MAX_GUIDE_PROGRAMMES = 60  # programmes per channel (the page shows the next three, the guide dialog forty)
MAX_PROGRAMME_SECONDS = 24 * 3600
PROVIDER_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
ALLOWED = ("name", "sources", "logo", "web", "kind", "category", "group", "epg")


def clean_provider(raw: Any) -> str:
    if not isinstance(raw, str) or not PROVIDER_ID.match(raw):
        raise ValueError("el id del plugin: minúsculas, números y guiones")
    return raw


def clean_channels(provider: str, raw: Any) -> list[dict[str, Any]]:
    """The channels a plugin gave, as channels of the list: checked all or nothing (``ValueError`` saying which one is wrong).

    Their ids are made from the plugin and the name (``prov-<plugin>-<name>``), so one plugin cannot take the id of a channel of the lists or of
    the user; a repeated name gets a number. ``headers`` is not accepted (a plugin cannot make TDT local send a credential), and what the
    page shows as category is the plugin's own unless it gave one.
    """
    if not isinstance(raw, list):
        raise ValueError("los canales tienen que ser una lista")
    if len(raw) > MAX_PROVIDED:
        raise ValueError(f"hasta {MAX_PROVIDED} canales por plugin")
    out: list[dict[str, Any]] = []
    taken: set[str] = set()
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"el canal {i + 1} tiene que ser un objeto")
        extra = [k for k in item if k not in ALLOWED]
        if extra:
            raise ValueError(f"el canal {i + 1}: «{str(extra[0])[:30]}» no se admite (campos: {', '.join(ALLOWED)})")
        if isinstance(item.get("sources"), list) and len(item["sources"]) > MAX_SOURCES:
            raise ValueError(f"el canal {i + 1}: hasta {MAX_SOURCES} enlaces")
        try:
            entry = build_custom_entry({k: v for k, v in item.items() if k in ALLOWED})
        except ValueError as exc:
            raise ValueError(f"el canal {i + 1}: {exc}") from exc
        base = f"prov-{provider}-{slugify(entry['name']) or i + 1}"
        cid, n = base, 2
        while cid in taken:
            cid = f"{base}-{n}"
            n += 1
        taken.add(cid)
        category = str(item.get("category") or "").strip()[:60] if isinstance(item.get("category"), str) else ""
        entry.update(
            id=cid,
            category=category or f"Plugin · {provider}",
            group=str(item.get("group") or "").strip()[:60] if isinstance(item.get("group"), str) else "",
            custom=False,
            provider=provider,
            headers={},
        )
        out.append(entry)
    return out


def clean_guide(provider: str, raw: Any, now: float) -> dict[str, list[list[Any]]]:
    """The programme guide a plugin gave: ``{channel: [[start, end, title, description, category], ...]}`` with times in seconds since 1970.
    Checked all or nothing (``ValueError`` saying which channel and which programme). What is already over is dropped. The guide of a plugin
    lives under ``<plugin>:<channel>``, so it can never replace the guide of a channel of the lists: a channel of the plugin names it in its
    ``epg`` field."""
    if not isinstance(raw, dict):
        raise ValueError("la guía tiene que ser un objeto {canal: [programas]}")
    if len(raw) > MAX_GUIDE_IDS:
        raise ValueError(f"la guía pasa de {MAX_GUIDE_IDS} canales")
    out: dict[str, list[list[Any]]] = {}
    for channel, items in raw.items():
        if (
            not isinstance(channel, str)
            or not channel.strip()
            or len(channel) > 80
            or any(ord(c) < 32 for c in channel)
        ):
            raise ValueError("el nombre de un canal de la guía: un texto de hasta 80 caracteres sin saltos de línea")
        if not isinstance(items, list) or len(items) > MAX_GUIDE_PROGRAMMES:
            raise ValueError(f"«{channel[:40]}»: una lista de hasta {MAX_GUIDE_PROGRAMMES} programas")
        rows: list[list[Any]] = []
        for i, item in enumerate(items):
            at = f"«{channel[:40]}», programa {i + 1}"
            if not isinstance(item, list) or not 3 <= len(item) <= 5:
                raise ValueError(f"{at}: [inicio, fin, título, descripción?, categoría?]")
            start, end, title = item[0], item[1], item[2]
            if any(isinstance(t, bool) or not isinstance(t, (int, float)) or t != t for t in (start, end)):
                raise ValueError(f"{at}: inicio y fin son segundos desde 1970")
            if not 0 < end - start <= MAX_PROGRAMME_SECONDS:
                raise ValueError(f"{at}: el fin tiene que ser posterior al inicio y no pasar de 24 horas después")
            if not isinstance(title, str) or not title.strip() or len(title) > 200:
                raise ValueError(f"{at}: el título es un texto de hasta 200 caracteres")
            extras = []
            for value, limit in zip(item[3:], (500, 60), strict=False):
                if value is not None and (not isinstance(value, str) or len(value) > limit):
                    raise ValueError(f"{at}: descripción (500) y categoría (60) son textos cortos")
                extras.append((value or "").strip())
            if end <= now:
                continue
            rows.append([int(start), int(end), title.strip(), *(extras + [""] * (2 - len(extras)))])
        if rows:
            out[f"{provider}:{channel.strip()}"] = sorted(rows, key=lambda r: r[0])
    return out
