import unittest

from tdtlocal.custom import build_custom_entry, guess_fmt, is_youtube
from tdtlocal.parser import fmt_of, parse_markdown
from tdtlocal.util import normalize, slugify

from .helpers import fixture


class UtilTests(unittest.TestCase):
    def test_normalize_strips_accents_and_case(self):
        self.assertEqual(normalize("CANCIÓN Ñandú"), "cancion nandu")

    def test_slugify(self):
        self.assertEqual(slugify("La 2 HD"), "la-2-hd")
        self.assertEqual(slugify("Teledeporte (Nacional)"), "teledeporte-nacional")

    def test_slugify_never_returns_empty(self):
        self.assertEqual(slugify("***"), "canal")


class ParseMarkdownTests(unittest.TestCase):
    def setUp(self):
        self.tv = parse_markdown(fixture("TELEVISION.md"), "tv")
        self.by_id = {c["id"]: c for c in self.tv}

    def test_extracts_expected_channels(self):
        self.assertEqual(
            [c["id"] for c in self.tv],
            ["la-1", "la-2", "canal-sin-directo", "la-1-andalucia", "canal-sur"],
        )

    def test_ignores_text_before_the_first_heading_and_short_rows(self):
        self.assertNotIn("fila-corta", self.by_id)

    def test_fields(self):
        la1 = self.by_id["la-1"]
        self.assertEqual(la1["name"], "La 1")
        self.assertEqual(la1["kind"], "tv")
        self.assertEqual(la1["category"], "Nacionales")
        self.assertEqual(la1["group"], "")
        self.assertEqual(la1["sources"], ["https://a.example/la1.m3u8", "https://b.example/la1.m3u8"])
        self.assertEqual(la1["web"], "https://web.example/la1")
        self.assertEqual(la1["logo"], "https://logo.example/la1.png")
        self.assertEqual(la1["epg"], "La1.TV")
        self.assertEqual(la1["tags"], ["GEO", "1080p"])

    def test_dash_means_empty(self):
        no_stream = self.by_id["canal-sin-directo"]
        self.assertEqual(no_stream["sources"], [])
        self.assertEqual(no_stream["epg"], "")
        self.assertEqual(no_stream["logo"], "")
        self.assertEqual(no_stream["tags"], [])

    def test_duplicate_names_get_unique_ids_using_the_group(self):
        andalucia = self.by_id["la-1-andalucia"]
        self.assertEqual(andalucia["group"], "Andalucía")
        self.assertEqual(andalucia["category"], "Autonómicas")

    def test_urls_with_unfilled_macros_go_last(self):
        self.assertEqual(
            self.by_id["canal-sur"]["sources"], ["https://b.example/sur.m3u8", "https://a.example/sur.m3u8?ip=[IP]"]
        )

    def test_ids_are_unique(self):
        ids = [c["id"] for c in self.tv]
        self.assertEqual(len(ids), len(set(ids)))

    def test_radio_uses_stream_column_and_formats(self):
        radios = parse_markdown(fixture("RADIO.md"), "radio")
        self.assertEqual([c["id"] for c in radios], ["radio-radio-uno", "radio-radio-dos"])
        uno = radios[0]
        self.assertEqual(uno["kind"], "radio")
        self.assertEqual(uno["sources"], ["https://r.example/uno.mp3", "https://r.example/uno.m3u8"])
        self.assertEqual(uno["fmts"], ["mp3", "m3u8"])
        self.assertEqual(radios[1]["fmts"], ["aac"])

    def test_empty_and_garbage_input(self):
        self.assertEqual(parse_markdown(""), [])
        self.assertEqual(parse_markdown("| Canal | M3U8 |\n| a | b |"), [])  # no category heading yet

    def test_fmt_of(self):
        self.assertEqual(fmt_of("mp3 # 2"), "mp3")
        self.assertEqual(fmt_of("  AAC"), "aac")
        self.assertEqual(fmt_of(""), "")


class CustomEntryTests(unittest.TestCase):
    def test_minimal_entry(self):
        e = build_custom_entry({"name": "La Sexta", "sources": ["https://x.example/a.m3u8"]})
        self.assertEqual(e["id"], "custom-la-sexta")
        self.assertEqual(e["category"], "Propios")
        self.assertTrue(e["custom"])
        self.assertEqual(e["kind"], "tv")
        self.assertEqual(e["headers"], {})

    def test_requires_name_and_a_valid_link(self):
        with self.assertRaises(ValueError):
            build_custom_entry({"name": "", "sources": ["https://x.example/a.m3u8"]})
        with self.assertRaises(ValueError):
            build_custom_entry({"name": "X", "sources": ["ftp://x.example/a", "javascript:alert(1)", "no es url"]})
        with self.assertRaises(ValueError):
            build_custom_entry("no es un dict")

    def test_a_channel_that_only_has_a_web_page_is_allowed(self):
        e = build_custom_entry({"name": "Telecinco", "web": "https://www.mediasetinfinity.es/directo/telecinco/"})
        self.assertEqual(e["sources"], [])
        self.assertEqual(e["web"], "https://www.mediasetinfinity.es/directo/telecinco/")
        with self.assertRaises(ValueError):  # a web page that is not http(s) is not one
            build_custom_entry({"name": "Telecinco", "web": "javascript:alert(1)"})
        with self.assertRaises(ValueError):
            build_custom_entry({"name": "", "web": "https://www.mediasetinfinity.es/directo/telecinco/"})

    def test_headers_are_checked_and_cannot_inject_lines(self):
        e = build_custom_entry(
            {
                "name": "X",
                "sources": ["https://x.example/a.m3u8"],
                "headers": {
                    "Origin": "https://o.example",
                    "Referer": "https://o.example/\r\nX-Evil: 1",
                    "Cookie": "a=b",
                    "Host": "otro.example",
                    "User-Agent": 5,
                },
            }
        )
        # any valid name is kept; a value with a line break, one that is not text and transport headers are dropped
        self.assertEqual(e["headers"], {"Origin": "https://o.example", "Cookie": "a=b"})

    def test_radio_guesses_formats(self):
        e = build_custom_entry(
            {"name": "R", "kind": "radio", "sources": ["https://x.example/a.mp3?x=1", "https://x.example/live"]}
        )
        self.assertEqual(e["fmts"], ["mp3", "stream"])

    def test_limits(self):
        e = build_custom_entry({"name": "N" * 200, "sources": [f"https://x.example/{i}" for i in range(20)]})
        self.assertEqual(len(e["name"]), 80)
        self.assertEqual(len(e["sources"]), 6)

    def test_web_and_logo_must_be_http(self):
        e = build_custom_entry(
            {"name": "X", "sources": ["https://x.example/a"], "web": "javascript:1", "logo": "https://l.example/x.png"}
        )
        self.assertEqual(e["web"], "")
        self.assertEqual(e["logo"], "https://l.example/x.png")

    def test_guess_fmt_and_youtube(self):
        self.assertEqual(guess_fmt("https://x/a.m3u?t=1"), "m3u8")
        self.assertEqual(guess_fmt("https://x/a.AAC"), "aac")
        self.assertTrue(is_youtube("https://www.youtube.com/watch?v=abcdefghijk"))
        self.assertTrue(is_youtube("https://youtu.be/abcdefghijk"))
        self.assertFalse(is_youtube("https://notyoutube.com/"))
        self.assertFalse(is_youtube(None))


if __name__ == "__main__":
    unittest.main()
