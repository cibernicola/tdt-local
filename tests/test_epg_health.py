import gzip
import time
import unittest

from tdtlocal.epg import parse_xmltv, xmltv_ts

from .helpers import AppCase, fixture

LIVE_HLS = "#EXTM3U\n#EXTINF:6,\nseg0.ts\n"
MASTER = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8\n"


class XmltvTests(unittest.TestCase):
    def test_timestamps(self):
        self.assertEqual(xmltv_ts("20000101000000 +0000"), 946684800)
        self.assertEqual(xmltv_ts("20000101010000 +0100"), 946684800)
        self.assertEqual(xmltv_ts("20000101000000 -0230"), 946684800 + 2 * 3600 + 30 * 60)
        self.assertEqual(xmltv_ts("20000101000000"), 946684800)
        self.assertEqual(xmltv_ts("20000101000000Z"), 946684800)

    def test_bad_timestamp(self):
        for bad in ("", None, "basura", "2000"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                xmltv_ts(bad)

    def test_parse_keeps_only_valid_future_programmes_sorted(self):
        guide = parse_xmltv(fixture("guide.xml").encode(), now=time.time())
        self.assertEqual(list(guide), ["La1.TV"])
        self.assertEqual([p[2] for p in guide["La1.TV"]], ["Informativo", "Telediario"])
        news = guide["La1.TV"][1]
        self.assertEqual(news[3:], ["Las noticias del día.", "Noticias"])
        self.assertEqual(guide["La1.TV"][0][4], "")  # "Desconocido" is no category

    def test_finished_programmes_are_dropped(self):
        guide = parse_xmltv(fixture("guide.xml").encode(), now=xmltv_ts("20990101195500 +0100"))
        self.assertEqual(len(guide["La1.TV"]), 2)
        guide = parse_xmltv(fixture("guide.xml").encode(), now=xmltv_ts("20990101203000 +0100"))
        self.assertEqual([p[2] for p in guide["La1.TV"]], ["Telediario"])

    def test_entities_are_rejected(self):
        evil = b'<?xml version="1.0"?><!DOCTYPE tv [<!ENTITY a "aaaa">]><tv>&a;</tv>'
        with self.assertRaises(ValueError):
            parse_xmltv(evil)

    def test_a_document_in_utf16_cannot_hide_an_entity_declaration(self):
        evil = '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE tv [<!ENTITY a "aaaa">]><tv>&a;</tv>'.encode("utf-16")
        self.assertNotIn(b"<!entity", evil.lower())  # the plain byte check cannot see it
        with self.assertRaises(ValueError):
            parse_xmltv(evil)

    def test_malformed_xml(self):
        import xml.etree.ElementTree as ET

        with self.assertRaises(ET.ParseError):
            parse_xmltv(b"<tv><programme>")


class EpgSyncTests(AppCase):
    def setUp(self):
        super().setUp()
        self.xml = fixture("guide.xml").encode()
        self.origin.routes["/tv.xml.gz"] = lambda h: (
            (304, {}, b"")
            if h.headers.get("If-None-Match") == '"g1"'
            else (200, {"ETag": '"g1"'}, gzip.compress(self.xml))
        )
        # plain (uncompressed) XML is accepted too
        self.origin.routes["/radio.xml"] = lambda h: (
            (304, {}, b"") if h.headers.get("If-None-Match") == '"r1"' else (200, {"ETag": '"r1"'}, self.xml)
        )
        self.app = self.make_app(
            epg_sources={"tv": self.origin.url("/tv.xml.gz"), "radio": self.origin.url("/radio.xml")}
        )

    def test_sync_loads_both_guides(self):
        result = self.app.epg.sync()
        self.assertTrue(result["changed"])
        self.assertIsNone(result["error"])
        self.assertIn("La1.TV", self.app.store.epg["tv"])
        self.assertIn("La1.TV", self.app.store.epg["radio"])
        self.assertIsNotNone(self.app.store.epg_meta["updated"])

    def test_not_modified_keeps_the_guide(self):
        self.app.epg.sync()
        result = self.app.epg.sync()
        self.assertFalse(result["changed"])
        self.assertIn("La1.TV", self.app.store.epg["tv"])

    def test_one_failing_guide_does_not_discard_the_other(self):
        self.origin.routes["/radio.xml"] = (500, {}, b"boom")
        result = self.app.epg.sync()
        self.assertIn("La1.TV", self.app.store.epg["tv"])
        self.assertEqual(result["error"], ["radio: HTTP 500"])
        self.assertEqual(self.app.store.epg_meta["error"], "radio: HTTP 500")

    def test_payload_now_next_and_per_channel(self):
        self.app.epg.sync()
        overview = self.app.epg.payload()
        self.assertEqual([p[2] for p in overview["now"]["La1.TV"]], ["Informativo", "Telediario"])
        self.assertTrue(all(len(p) == 3 for p in overview["now"]["La1.TV"]))
        detail = self.app.epg.payload("La1.TV")
        self.assertEqual(detail["id"], "La1.TV")
        self.assertEqual(len(detail["programmes"]), 2)
        self.assertEqual(self.app.epg.payload("Nope")["programmes"], [])

    def test_payload_hides_programmes_that_ended(self):
        self.app.epg.sync()
        later = xmltv_ts("20990101203000 +0100")
        self.assertEqual([p[2] for p in self.app.epg.payload("La1.TV", now=later)["programmes"]], ["Telediario"])


class HealthTests(AppCase):
    def setUp(self):
        super().setUp()
        self.health = self.app.health
        o = self.origin
        o.routes["/ok.m3u8"] = (200, {}, LIVE_HLS.encode())
        o.routes["/seg0.ts"] = (200, {}, b"\x47" * 2048)
        o.routes["/master.m3u8"] = (200, {}, MASTER.encode())
        o.routes["/variant.m3u8"] = (200, {}, LIVE_HLS.encode())
        o.routes["/html.m3u8"] = (200, {}, b"<html>login</html>")
        o.routes["/empty.m3u8"] = (200, {}, b"#EXTM3U\n#EXT-X-VERSION:3\n")
        o.routes["/novariant.m3u8"] = (200, {}, b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n")
        o.routes["/audio.mp3"] = (200, {"Content-Type": "audio/mpeg"}, b"ID3" + b"\x00" * 3000)
        o.routes["/page"] = (200, {"Content-Type": "text/html"}, b"<html></html>")
        o.routes["/playlist-as-audio"] = (200, {"Content-Type": "audio/mpeg"}, b"#EXTM3U\n")

    def probe(self, path, fmt=""):
        return self.health.probe(self.origin.url(path), fmt)

    def test_media_playlist(self):
        self.assertTrue(self.probe("/ok.m3u8")["ok"])

    def test_master_playlist_follows_first_variant(self):
        self.assertTrue(self.probe("/master.m3u8")["ok"])
        self.assertIn("/variant.m3u8", [p for p, _ in self.origin.requests])

    def test_failures_are_classified(self):
        self.assertEqual(self.probe("/missing.m3u8")["err"], "HTTP 404")
        self.assertEqual(self.probe("/html.m3u8")["err"], "ValueError")
        self.assertEqual(self.probe("/empty.m3u8")["err"], "ValueError")
        self.assertEqual(self.probe("/novariant.m3u8")["err"], "ValueError")

    def test_segment_failure_fails_the_stream(self):
        self.origin.routes["/seg0.ts"] = (403, {}, b"")
        self.assertEqual(self.probe("/ok.m3u8")["err"], "HTTP 403")

    def test_audio_streams(self):
        self.assertTrue(self.probe("/audio.mp3", "mp3")["ok"])
        self.assertFalse(self.probe("/page", "stream")["ok"])
        self.assertFalse(self.probe("/playlist-as-audio", "stream")["ok"])
        self.assertFalse(self.probe("/missing.mp3", "mp3")["ok"])

    def test_hls_radio_is_probed_as_hls(self):
        self.assertTrue(self.probe("/ok.m3u8", "aac")["ok"])

    def test_blocked_addresses_report_why(self):
        strict = self.make_app(allow_private=False)
        result = strict.health.probe(self.origin.url("/ok.m3u8"))
        self.assertFalse(result["ok"])
        self.assertTrue(result["err"].startswith("bloqueado"))

    def test_batch_check_updates_status_and_progress(self):
        store = self.app.store
        store.channels = [
            {"id": "a", "sources": [self.origin.url("/ok.m3u8")], "fmts": [""], "logo": "", "kind": "tv"},
            {"id": "b", "sources": [self.origin.url("/missing.m3u8")], "fmts": [""], "logo": "", "kind": "tv"},
        ]
        self.assertTrue(self.health.start("tv"))
        deadline = time.time() + 10
        while store.health["running"] and time.time() < deadline:
            time.sleep(0.02)
        self.assertFalse(store.health["running"])
        self.assertEqual((store.health["done"], store.health["total"]), (2, 2))
        self.assertTrue(store.status[self.origin.url("/ok.m3u8")]["ok"])
        self.assertFalse(store.status[self.origin.url("/missing.m3u8")]["ok"])
        self.assertTrue((self.app.config.data_dir / "status.json").exists())

    def test_a_check_skips_what_is_left_once_the_app_closes(self):
        """The pool's threads hold the process open until the whole queue is done, so closing must drain it."""
        store = self.app.store
        store.channels = [{"id": "a", "sources": [self.origin.url("/ok.m3u8")], "fmts": [""], "logo": "", "kind": "tv"}]
        self.app.close()
        self.assertTrue(self.health.start("tv"))
        deadline = time.time() + 10
        while store.health["running"] and time.time() < deadline:
            time.sleep(0.02)
        self.assertFalse(store.health["running"])
        self.assertEqual(store.health["done"], 0)
        self.assertNotIn("/ok.m3u8", [p for p, _ in self.origin.requests])

    def test_only_one_check_at_a_time(self):
        self.app.store.health["running"] = True
        self.assertFalse(self.health.start("tv"))


if __name__ == "__main__":
    unittest.main()
