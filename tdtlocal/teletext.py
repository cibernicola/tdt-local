"""Teletext service: pages built from public news feeds, the weather and the programme guide.

A page is a list of subpages; each subpage is "output lines" (``OL,<row>,<text>``: 40 cells per row, a control code is
written as ESC followed by ``code | 0x40``, the format of the MRG ``.tti`` files). Text uses the Spanish/Portuguese
national character set of the teletext standard (ETSI EN 300 706), which the page decodes in ``js/lib/teletext.js``.
The pages are rebuilt in the background only while ``config.teletext_enabled`` is on (it fetches from the internet).
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import unicodedata
import xml.etree.ElementTree as ET
from html import unescape
from typing import Any

from .config import Config
from .net import Net
from .store import Store

log = logging.getLogger(__name__)

INTERVAL = 20 * 60  # how often the pages are rebuilt
RETRY = 5 * 60
FIRST_DELAY = 8  # let the lists and the guide arrive first
TICK_SECONDS = 2  # how often the loop re-reads the settings
MAX_FEED = 3_000_000
ES_FEED = "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/"
# (index page, name, feed url, first article page, items). Fixed by the program, not by the user.
SOURCES = (
    ("101", "EL PAIS", ES_FEED + "portada", 111, 8),
    ("102", "EL MUNDO", "https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml", 121, 8),
    ("103", "EUROPA PRESS", "https://www.europapress.es/rss/rss.aspx", 131, 8),
    ("200", "DEPORTES", ES_FEED + "section/deportes/portada", 211, 8),
    ("300", "ECONOMIA", ES_FEED + "section/economia/portada", 311, 8),
)
FASTEXT = {"red": "101", "green": "200", "yellow": "300", "blue": "400", "index": "100"}
CITIES = (
    ("Barcelona", 41.39, 2.17),
    ("Madrid", 40.42, -3.70),
    ("Valencia", 39.47, -0.38),
    ("Sevilla", 37.39, -5.98),
    ("Bilbao", 43.26, -2.93),
    ("Zaragoza", 41.65, -0.89),
    ("Palma", 39.57, 2.65),
    ("Las Palmas", 28.12, -15.43),
)
WMO = {
    0: "Despejado",
    1: "Poco nuboso",
    2: "Intervalos",
    3: "Nublado",
    45: "Niebla",
    48: "Niebla",
    51: "Llovizna",
    53: "Llovizna",
    55: "Llovizna",
    61: "Lluvia",
    63: "Lluvia",
    65: "Lluvia fuerte",
    71: "Nieve",
    73: "Nieve",
    75: "Nieve fuerte",
    80: "Chubascos",
    81: "Chubascos",
    82: "Chubascos+",
    95: "Tormenta",
    96: "Tormenta",
    99: "Tormenta",
}
# Spanish/Portuguese national subset: these ASCII codes are drawn as accented letters by a teletext decoder.
NATIONAL = {"ñ": "|", "á": "[", "é": "\\", "í": "]", "ó": "^", "ú": "_", "¿": "`", "¡": "@", "ç": "#", "ü": "{"}
REVERSE = {v: k for k, v in NATIONAL.items()}
UNSAFE = {
    "#": "n",
    "@": "a",
    "[": "(",
    "]": ")",
    "\\": "/",
    "^": " ",
    "_": "-",
    "`": "'",
    "{": "(",
    "|": "/",
    "}": ")",
    "~": "-",
}
PUNCT = str.maketrans({"’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "«": '"', "»": '"', "\xa0": " "})


def teletext_text(text: str) -> str:
    """Plain text -> the 7-bit characters of the Spanish teletext set (capitals lose their accent)."""
    out = []
    for ch in unescape(text).translate(PUNCT).replace("…", "..."):
        if ch in NATIONAL:
            out.append(NATIONAL[ch])
        elif ch in UNSAFE:
            out.append(UNSAFE[ch])
        elif " " <= ch < "\x7f":
            out.append(ch)
        else:
            folded = unicodedata.normalize("NFKD", ch).encode("ascii", "ignore").decode()
            out.append(folded if folded and folded not in UNSAFE else " ")
    return re.sub(r"\s+", " ", "".join(out)).strip()


def wrap(text: str, width: int) -> list[str]:
    lines: list[str] = []
    cur = ""
    for word in text.split(" "):
        if len(cur) + len(word) + (1 if cur else 0) <= width:
            cur = (cur + " " + word).strip()
        else:
            if cur:
                lines.append(cur)
            cur = word[:width]
    if cur:
        lines.append(cur)
    return lines


def ctl(code: int) -> str:
    return "\x1b" + chr(0x40 + code)


RED, GREEN, YELLOW, BLUE, MAGENTA, CYAN, WHITE = (ctl(i) for i in range(1, 8))
DOUBLE, NEW_BACKGROUND = ctl(0x0D), ctl(0x1D)


def clip(row: str, cells: int = 40) -> str:
    """Keep ``cells`` cells of a row; a control code takes two characters but one cell."""
    out, n, i = "", 0, 0
    while i < len(row) and n < cells:
        step = 2 if row[i] == "\x1b" else 1
        out += row[i : i + step]
        i += step
        n += 1
    return out


def plain(row: str) -> str:
    """A row as readable text (control codes are blanks, national characters are accented again)."""
    return "".join(REVERSE.get(c, c) for c in re.sub(r"\x1b.", " ", row))


class Page:
    """One 40x24 subpage: a blue title bar on row 1, content, and the fastext labels on row 24."""

    def __init__(self, left: str, right: str = "") -> None:
        body = (" " + left).ljust(36 - len(right)) + right + " "
        self.rows = [BLUE + NEW_BACKGROUND + WHITE + body[:37]]

    def add(self, row: str) -> None:
        self.rows.append(clip(row))

    def blank(self) -> None:
        self.rows.append("")

    def space(self) -> int:
        return 23 - len(self.rows)

    def done(self) -> dict[str, Any]:
        rows = (self.rows + [""] * 23)[:23]
        rows.append(RED + "Portada" + GREEN + "Deport." + YELLOW + "Econom." + CYAN + "Tiempo")
        lines = "\n".join(f"OL,{i + 1},{r}" for i, r in enumerate(rows) if r)
        return {"outputLines": lines, "fastext": dict(FASTEXT), "_text": [plain(r).rstrip() for r in rows]}


def parse_feed(data: bytes, limit: int) -> list[tuple[str, str, str]]:
    """``[(title, summary, published)]`` of an RSS feed. Documents declaring entities are rejected."""
    if b"<!ENTITY" in data:
        raise ValueError("el RSS declara entidades XML")
    root = ET.fromstring(data)  # noqa: S314 - entities rejected above
    items: list[tuple[str, str, str]] = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        summary = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", item.findtext("description") or "")).strip()
        if title:
            items.append((title, summary, (item.findtext("pubDate") or "").strip()))
        if len(items) >= limit:
            break
    return items


def short_date(pub: str) -> str:
    m = re.search(r"(\d{1,2}) (\w{3}) \d{4} (\d\d:\d\d)", pub)
    return f"{int(m.group(1)):02d} {m.group(2)} {m.group(3)}" if m else ""


def index_pages(src: tuple, items: list[tuple[str, str, str]]) -> dict[str, Any]:
    subs: list[dict[str, Any]] = []
    page: Page | None = None
    for i, (title, _summary, _pub) in enumerate(items):
        lines = wrap(teletext_text(title), 34)
        if len(lines) > 3:
            lines = [*lines[:2], lines[2][:31] + "..."]
        if page is None or page.space() < len(lines) + 2:
            if page:
                subs.append(page.done())
            page = Page(src[1], "titulares")
        page.add(CYAN + str(src[3] + i) + WHITE + " " + lines[0])
        for line in lines[1:]:
            page.add("     " + line)
        page.blank()
    if page:
        subs.append(page.done())
    return {src[0]: {"subpages": subs}}


def article_pages(src: tuple, items: list[tuple[str, str, str]]) -> dict[str, Any]:
    pages: dict[str, Any] = {}
    for i, (title, summary, pub) in enumerate(items):
        number = str(src[3] + i)
        title_lines = wrap(teletext_text(title), 37)[:3]
        body = wrap(teletext_text(summary), 38) if summary else ["(sin resumen: mira la web de la fuente)"]
        subs: list[dict[str, Any]] = []
        capacity = [23 - 4 - 2 * len(title_lines) - 1] + [20] * 6
        for k, cap in enumerate(capacity):
            if not body and subs:
                break
            take, body = body[:cap], body[cap:]
            page = Page(src[1], number)
            if k == 0:
                for line in title_lines:
                    page.add(DOUBLE + YELLOW + line)
                    page.blank()
                page.add(CYAN + (short_date(pub) or "hoy") + "  " + WHITE + src[1].title()[:14])
                page.blank()
            for line in take:
                page.add(WHITE + line)
            if body:
                page.blank()
                page.add(CYAN + "continua en la siguiente subpagina")
            subs.append(page.done())
        pages[number] = {"subpages": subs}
    return pages


def weather_page(data: Any) -> dict[str, Any]:
    reports = data if isinstance(data, list) else [data]
    page = Page("EL TIEMPO", "ahora")
    page.blank()
    page.add(CYAN + "Ciudad".ljust(10) + " " + "Cielo".ljust(12) + " " + "  T" + " " + "Mn/Mx" + " " + "Vto")
    page.blank()
    for (name, _lat, _lon), report in zip(CITIES, reports):
        cur, day = report["current"], report["daily"]
        sky = teletext_text(WMO.get(cur["weather_code"], "-"))[:12].ljust(12)
        low, high = day["temperature_2m_min"][0], day["temperature_2m_max"][0]
        temperature = f"{cur['temperature_2m']:>3.0f}"
        span = f"{low:>3.0f}/{high:<2.0f}"[:6]
        page.add(
            YELLOW
            + name[:10].ljust(10)
            + WHITE
            + sky
            + GREEN
            + temperature
            + WHITE
            + span
            + MAGENTA
            + f"{cur['wind_speed_10m']:>3.0f}"
        )
    page.blank()
    page.add(CYAN + "Temperaturas en C, viento en km/h")
    page.add(CYAN + "Datos: Open-Meteo.com")
    return {"400": {"subpages": [page.done()]}}


def tv_pages(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """``rows``: ``{"name", "now": [start, end, title] | None, "next": [...] | None}`` for each channel."""

    def hm(ts: float) -> str:
        return time.strftime("%H:%M", time.localtime(ts))

    page = Page("TELEVISION", "ahora")
    page.blank()
    subs: list[dict[str, Any]] = []
    for row in rows:
        if page.space() < 3:
            subs.append(page.done())
            page = Page("TELEVISION", "ahora")
            page.blank()
        now, nxt = row.get("now"), row.get("next")
        page.add(CYAN + teletext_text(row["name"])[:14])
        page.add(WHITE + (hm(now[0]) + " " + teletext_text(now[2])[:32] if now else "sin guia"))
        if nxt:
            page.add(GREEN + hm(nxt[0]) + " " + teletext_text(nxt[2])[:32])
    subs.append(page.done())
    return {"500": {"subpages": subs}}


def index_page(have: set[str], stamp: str) -> dict[str, Any]:
    page = Page("INDICE", "100")
    page.blank()
    page.add(DOUBLE + YELLOW + "TELETEXTO")
    page.blank()
    sections = (
        ("101", "Portada: EL PAIS"),
        ("102", "Portada: EL MUNDO"),
        ("103", "Portada: EUROPA PRESS"),
        ("200", "Deportes"),
        ("300", "Economia"),
        ("400", "El tiempo"),
        ("500", "Television ahora"),
    )
    for number, name in sections:
        if number in have:
            page.add(CYAN + number + WHITE + "  " + name)
    page.blank()
    page.add(GREEN + "Teclas roja/verde/amarilla/azul:")
    page.add(GREEN + "acceso directo. Escribe 3 cifras para")
    page.add(GREEN + "ir a una pagina.")
    page.blank()
    page.add(MAGENTA + "Actualizado " + stamp)
    page.add(MAGENTA + "Fuentes: RSS publicos y Open-Meteo")
    return {"100": {"subpages": [page.done()]}}


class Teletext:
    """Builds the pages in the background and serves them to the page."""

    def __init__(self, config: Config, net: Net, store: Store, epg: Any) -> None:
        self.config, self.net, self.store, self.epg = config, net, store, epg
        self.lock = threading.Lock()
        self.magazines: dict[str, dict[str, Any]] = {}
        self.text: dict[str, list[list[str]]] = {}
        self.updated = 0
        self.errors: list[str] = []
        self._wake = threading.Event()
        self._path = config.data_dir / "teletext.json"

    # ---- persistence
    def load(self) -> None:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            with self.lock:
                self.magazines, self.text = data["magazines"], data["text"]
                self.updated, self.errors = int(data["updated"]), list(data.get("errors") or [])
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def _save(self) -> None:
        tmp = self._path.with_suffix(".tmp")
        payload = {"updated": self.updated, "errors": self.errors, "magazines": self.magazines, "text": self.text}
        try:
            tmp.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(self._path)
        except OSError as exc:
            log.warning("teletexto: no se pudo guardar la caché: %s", exc)

    # ---- building
    def _fetch(self, url: str) -> bytes:
        body, _headers = self.net.fetch_trusted(url, timeout=15, limit=MAX_FEED)
        if len(body) > MAX_FEED:
            raise ValueError("respuesta demasiado grande")
        return body

    def _tv_rows(self) -> list[dict[str, Any]]:
        now = time.time()
        with self.store.lock:
            channels = [
                c
                for c in self.store.all_channels()
                if c.get("kind", "tv") == "tv" and c.get("category") == "Nacionales" and c.get("epg")
            ]
        guide = self.epg.payload().get("now") or {}
        rows = []
        for ch in channels:
            progs = guide.get(ch["epg"], [])
            cur = next((p for p in progs if p[0] <= now < p[1]), None)
            nxt = next((p for p in progs if p[0] >= (cur[1] if cur else now)), None)
            rows.append({"name": ch["name"], "now": cur, "next": nxt})
        return rows

    def build(self) -> None:
        pages: dict[str, Any] = {}
        errors: list[str] = []
        for src in SOURCES:
            try:
                items = parse_feed(self._fetch(src[2]), src[4])
                pages.update(index_pages(src, items))
                pages.update(article_pages(src, items))
            except Exception as exc:  # a feed that fails must not stop the others
                errors.append(f"{src[1]}: {exc}")
        try:
            lat = ",".join(str(c[1]) for c in CITIES)
            lon = ",".join(str(c[2]) for c in CITIES)
            url = (
                f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
                "&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min"
                "&forecast_days=1&timezone=auto"
            )
            pages.update(weather_page(json.loads(self._fetch(url))))
        except Exception as exc:
            errors.append(f"tiempo: {exc}")
        try:
            pages.update(tv_pages(self._tv_rows()))
        except Exception as exc:
            errors.append(f"television: {exc}")
        if not pages:
            raise RuntimeError("; ".join(errors) or "sin páginas")
        pages.update(index_page(set(pages), time.strftime("%d/%m %H:%M")))
        text = {n: [sub.pop("_text") for sub in p["subpages"]] for n, p in pages.items()}
        magazines: dict[str, dict[str, Any]] = {}
        for number, page in pages.items():
            magazines.setdefault(number[0], {})[number] = page
        with self.lock:
            self.magazines, self.text, self.errors, self.updated = magazines, text, errors, int(time.time())
        self._save()
        log.info("teletexto: %d páginas%s", len(pages), f" ({len(errors)} fuentes con error)" if errors else "")

    def refresh_soon(self) -> None:
        self._wake.set()

    def run(self, stop: threading.Event) -> None:
        """Background loop: rebuild every ``INTERVAL`` seconds (or sooner after :meth:`refresh_soon`) while enabled."""
        self.load()
        due = time.time() + FIRST_DELAY
        while not stop.wait(TICK_SECONDS):
            if not self.config.teletext_enabled or (time.time() < due and not self._wake.is_set()):
                continue
            self._wake.clear()
            try:
                self.build()
                due = time.time() + INTERVAL
            except Exception as exc:
                log.warning("teletexto: %s", exc)
                due = time.time() + RETRY

    # ---- what the routes serve
    def magazine(self, digit: str) -> dict[str, Any] | None:
        with self.lock:
            pages = self.magazines.get(digit)
            return {"pages": pages} if pages else None

    def page_text(self, number: str) -> list[list[str]] | None:
        with self.lock:
            return self.text.get(number)

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "enabled": self.config.teletext_enabled,
                "updated": self.updated,
                "pages": sorted(self.text),
                "errors": list(self.errors),
            }
