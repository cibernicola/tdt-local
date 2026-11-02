"""Teletext: Spanish national characters, wrapping, row clipping, feed parsing, page building and the HTTP routes."""

from __future__ import annotations

import json
import threading
import time
import unittest

from tdtlocal import teletext as t
from tests.helpers import ServerCase

RSS = (
    b"<rss><channel>"
    b"<item><title>Primer titular del d\xc3\xada</title>"
    b"<description>&lt;p&gt;Resumen &lt;b&gt;uno&lt;/b&gt;&lt;/p&gt;</description>"
    b"<pubDate>Mon, 02 Nov 2026 01:43:21 GMT</pubDate></item>"
    b"<item><title>Segundo</title><description></description></item>"
    b"</channel></rss>"
)
WEATHER = [
    {
        "current": {"temperature_2m": 14.2, "weather_code": 3, "wind_speed_10m": 9.1},
        "daily": {"temperature_2m_min": [11.0], "temperature_2m_max": [17.0]},
    }
    for _ in t.CITIES
]


class Text(unittest.TestCase):
    def test_spanish_national_set(self):
        self.assertEqual(t.teletext_text("Año ¿qué? ¡Sí!"), "A|o `qu\\? @S]!")
        self.assertEqual(t.plain(t.teletext_text("Año ¿qué?")), "Año ¿qué?")

    def test_codes_that_would_be_drawn_as_something_else_are_replaced(self):
        out = t.teletext_text("a#b @c [d] ~e “f” €")
        for bad in "#[]~":
            self.assertNotIn(bad, out)

    def test_wrap(self):
        lines = t.wrap("uno dos tres cuatro cinco", 9)
        self.assertTrue(all(len(x) <= 9 for x in lines))
        self.assertEqual(" ".join(lines), "uno dos tres cuatro cinco")

    def test_clip_counts_cells_not_characters(self):
        self.assertEqual(len(t.plain(t.clip(t.CYAN + "x" * 60))), 40)

    def test_page_has_a_title_bar_and_the_fastext_row(self):
        page = t.Page("PRUEBA", "100")
        page.add(t.WHITE + "hola")
        done = page.done()
        self.assertIn("OL,1,", done["outputLines"])
        self.assertIn("OL,24,", done["outputLines"])
        self.assertEqual(done["fastext"]["red"], "101")
        self.assertEqual(len(done["_text"]), 24)
        self.assertTrue(done["_text"][0].startswith("    PRUEBA"))


class Feed(unittest.TestCase):
    def test_parse(self):
        items = t.parse_feed(RSS, 5)
        self.assertEqual([i[0] for i in items], ["Primer titular del día", "Segundo"])
        self.assertEqual(items[0][1], "Resumen uno")
        self.assertEqual(t.short_date(items[0][2]), "02 Nov 01:43")

    def test_limit(self):
        self.assertEqual(len(t.parse_feed(RSS, 1)), 1)

    def test_entities_are_rejected(self):
        with self.assertRaises(ValueError):
            t.parse_feed(b'<!DOCTYPE x [<!ENTITY a "b">]><rss/>', 5)

    def test_index_and_article_pages(self):
        src = ("101", "EL PAIS", "", 111, 8)
        items = [("Titular " + str(i), "Texto " * 200, "") for i in range(3)]
        index = t.index_pages(src, items)
        self.assertIn("111", index["101"]["subpages"][0]["_text"][1])
        articles = t.article_pages(src, items)
        self.assertEqual(sorted(articles), ["111", "112", "113"])
        self.assertGreater(len(articles["111"]["subpages"]), 1)  # a long summary continues on another subpage


class Built(ServerCase):
    config_overrides = {"teletext_enabled": True}  # noqa: RUF012

    def setUp(self):
        super().setUp()
        self.fetched: list[str] = []

        def fake_fetch(url: str) -> bytes:
            self.fetched.append(url)
            return json.dumps(WEATHER).encode() if "open-meteo" in url else RSS

        self.app.teletext._fetch = fake_fetch
        now = time.time()
        self.app.store.channels = [
            {"id": "la-1", "name": "La 1", "kind": "tv", "category": "Nacionales", "epg": "La1.TV", "sources": []}
        ]
        self.app.store.epg["tv"]["La1.TV"] = [
            [now - 600, now + 600, "Informativo", "", ""],
            [now + 600, now + 1200, "Serie", "", ""],
        ]

    def test_nothing_is_served_before_the_first_build(self):
        self.assertEqual(self.get_json("/api/teletext/1.json")[0], 404)
        status, body = self.get_json("/api/teletext")
        self.assertEqual((status, body["updated"], body["enabled"]), (200, 0, True))

    def test_build_and_serve(self):
        self.app.teletext.build()
        status, body = self.get_json("/api/teletext/1.json")
        self.assertEqual(status, 200)
        self.assertIn("101", body["pages"])
        self.assertTrue(body["pages"]["101"]["subpages"][0]["outputLines"].startswith("OL,1,"))
        self.assertEqual(
            self.get_json("/api/teletext/4.json")[1]["pages"]["400"]["subpages"][0]["fastext"]["blue"], "400"
        )
        status, page = self.get_json("/api/teletext/page?n=500")
        self.assertEqual(status, 200)
        text = "\n".join(page["subpages"][0])
        self.assertIn("La 1", text)
        self.assertIn("Informativo", text)
        self.assertIn("Serie", text)

    def test_the_text_view_rejects_bad_numbers(self):
        self.app.teletext.build()
        self.assertEqual(self.get_json("/api/teletext/page?n=999")[0], 404)
        self.assertEqual(self.get_json("/api/teletext/page?n=abc")[0], 404)
        self.assertEqual(self.get_json("/api/teletext/page")[0], 404)

    def test_a_failing_source_does_not_stop_the_others(self):
        def flaky(url: str) -> bytes:
            if "elmundo" in url:
                raise OSError("sin red")
            return json.dumps(WEATHER).encode() if "open-meteo" in url else RSS

        self.app.teletext._fetch = flaky
        self.app.teletext.build()
        status = self.app.teletext.status()
        self.assertIn("101", status["pages"])
        self.assertNotIn("102", status["pages"])
        self.assertTrue(any("EL MUNDO" in e for e in status["errors"]))

    def test_the_cache_survives_a_restart(self):
        self.app.teletext.build()
        again = type(self.app.teletext)(self.app.config, self.app.net, self.app.store, self.app.epg)
        self.assertIsNone(again.magazine("1"))
        again.load()
        self.assertIsNotNone(again.magazine("1"))
        self.assertEqual(again.updated, self.app.teletext.updated)

    def test_refresh_is_accepted_from_this_machine(self):
        self.assertEqual(self.post_json("/api/teletext/refresh")[0], 200)
        self.assertTrue(self.app.teletext._wake.is_set())


class Gate(ServerCase):
    def test_it_is_off_by_default_and_the_loop_does_not_download(self):
        self.assertFalse(self.app.config.teletext_enabled)
        self.assertFalse(self.get_json("/api/channels")[1]["meta"]["teletext"])
        calls: list[str] = []
        self.app.teletext._fetch = lambda url: calls.append(url) or b""
        t.FIRST_DELAY = 0
        stop = threading.Event()
        worker = threading.Thread(target=self.app.teletext.run, args=(stop,), daemon=True)
        worker.start()
        time.sleep(t.TICK_SECONDS + 0.5)
        stop.set()
        worker.join(5)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
