"""What the page may do during an ad break: its settings, the web panel's CSP and the check of that web."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from tdtlocal.ads import embed_verdict, payload, web_origin
from tdtlocal.config import Config
from tdtlocal.scte import scan_playlist

from .helpers import AppCase, ServerCase


def config(**values) -> Config:
    return Config(**{"ad_enabled": True, "scte_enabled": True, **values})


class PayloadTests(unittest.TestCase):
    def test_nothing_is_sent_while_off(self):
        self.assertIsNone(payload(Config()))
        self.assertIsNone(payload(config(ad_enabled=False)))

    def test_it_does_not_need_the_watcher(self):  # the bridge script of Atresplayer's player also reports breaks
        self.assertIsNotNone(payload(config(scte_enabled=False)))

    def test_muting_is_enough_to_react(self):
        sent = payload(config())
        self.assertEqual(sent["audio"], "mute")
        self.assertEqual(sent["screen"], "keep")
        self.assertEqual(sent["on_touch"], "respect")
        self.assertEqual(sent["min_seconds"], 10)

    def test_with_nothing_to_do_nothing_is_sent(self):
        self.assertIsNone(payload(config(ad_audio="keep", ad_flag=False)))
        self.assertEqual(payload(config(ad_audio="keep"))["flag"], True)  # the notice alone is something to do

    def test_a_screen_action_without_its_target_is_dropped(self):
        self.assertEqual(payload(config(ad_screen="channel", ad_channel=""))["screen"], "keep")
        self.assertEqual(payload(config(ad_screen="web", ad_web_url=""))["screen"], "keep")
        self.assertEqual(payload(config(ad_screen="channel", ad_channel="La 2"))["screen"], "channel")
        self.assertEqual(payload(config(ad_screen="web", ad_web_url="https://a.example/x"))["screen"], "web")

    def test_only_the_reaction_settings_are_sent(self):
        sent = payload(config(llm_api_key="secret"))
        self.assertNotIn("secret", json.dumps(sent))
        self.assertTrue(all(not key.startswith(("scte", "llm")) for key in sent))


class OriginTests(unittest.TestCase):
    def test_only_a_web_that_will_be_shown_has_an_origin(self):
        self.assertEqual(
            web_origin(config(ad_screen="web", ad_web_url="https://Example.org/a/b?c=1")), "https://example.org"
        )
        self.assertEqual(
            web_origin(config(ad_screen="web", ad_web_url="http://h.example:8080/")), "http://h.example:8080"
        )
        self.assertEqual(web_origin(config(ad_screen="keep", ad_web_url="https://example.org/")), "")
        self.assertEqual(web_origin(config(ad_enabled=False, ad_screen="web", ad_web_url="https://example.org/")), "")
        self.assertEqual(web_origin(config(ad_screen="web", ad_web_url="")), "")

    def test_nothing_that_could_add_a_directive_gets_into_the_header(self):
        for url in (
            "https://a.example;script-src *",
            "https://a.example, x",
            "https://user@a.example;x/",
            "ftp://a.example/",
        ):
            origin = web_origin(config(ad_screen="web", ad_web_url=url))
            self.assertNotIn(";", origin, msg=url)
            self.assertNotIn(",", origin, msg=url)
            self.assertNotIn(" ", origin, msg=url)

    def test_an_address_without_port_or_with_ipv6(self):
        self.assertEqual(web_origin(config(ad_screen="web", ad_web_url="http://[::1]:9000/p")), "http://[::1]:9000")


class EmbedTests(unittest.TestCase):
    OURS = "http://127.0.0.1:8765"

    def test_a_plain_page_can_be_shown(self):
        self.assertEqual(embed_verdict({"Content-Type": "text/html"}, self.OURS), (True, ""))

    def test_x_frame_options_refuses(self):
        for value in ("DENY", "sameorigin", "SAMEORIGIN, x"):
            ok, why = embed_verdict({"X-Frame-Options": value}, self.OURS)
            self.assertFalse(ok, msg=value)
            self.assertIn("X-Frame-Options", why)

    def test_frame_ancestors(self):
        refused = [
            "frame-ancestors 'none'",
            "frame-ancestors 'self'",
            "default-src 'self'; frame-ancestors https://other.example",
        ]
        for policy in refused:
            self.assertFalse(embed_verdict({"Content-Security-Policy": policy}, self.OURS)[0], msg=policy)
        allowed = ["frame-ancestors *", f"frame-ancestors {self.OURS}", "frame-ancestors https:", "default-src 'self'"]
        for policy in allowed:
            self.assertTrue(embed_verdict({"content-security-policy": policy}, self.OURS)[0], msg=policy)


class MarkerPlaceTests(unittest.TestCase):
    """The page waits for the segment a marker belongs to, so every marker says which one that is."""

    def test_every_marker_knows_its_segment(self):
        out, cont, end = scan_playlist(
            "#EXT-X-CUE-OUT:30\n#EXTINF:6,\nseg1.ts?token=a\n#EXT-X-CUE-OUT-CONT:ElapsedTime=6,Duration=30\n"
            "#EXTINF:6,\nseg2.ts\n#EXT-X-CUE-IN\n#EXTINF:6,\nseg3.ts\n"
        )
        self.assertEqual((out["seg"], cont["seg"], end["seg"]), ("seg1.ts", "seg2.ts", "seg3.ts"))

    def test_a_marker_with_its_own_identity_also_has_one(self):
        (marker,) = scan_playlist(
            '#EXT-X-DATERANGE:ID="x1",START-DATE="2026-01-01T00:00:00Z",SCTE35-OUT=0xFC\n#EXTINF:6,\ns9.ts\n'
        )
        self.assertEqual(marker["seg"], "s9.ts")

    def test_the_continuation_says_how_far_it_is(self):
        (cont,) = scan_playlist("#EXT-X-CUE-OUT-CONT:ElapsedTime=45,Duration=60\n#EXTINF:6,\nseg.ts\n")
        self.assertEqual((cont["elapsed"], cont["duration"]), (45, 60))

    def test_a_marker_at_the_end_of_the_playlist_has_no_segment_yet(self):
        (marker,) = scan_playlist("#EXTINF:6,\na.ts\n#EXT-X-CUE-OUT:30\n")
        self.assertNotIn("seg", marker)


class EventTests(AppCase):
    config_overrides = {"scte_enabled": True}  # noqa: RUF012

    def test_events_carry_what_a_reaction_needs(self):
        self.app.scte.observe(
            "https://h.example/a.m3u8",
            "#EXT-X-CUE-OUT:30\n#EXTINF:6,\nseg1.ts\n#EXT-X-CUE-IN\n#EXTINF:6,\nseg2.ts\n",
        )
        out, end = self.app.scte.log.all()
        self.assertEqual((out["seg"], out["duration"]), ("seg1.ts", 30))
        self.assertEqual(end["seg"], "seg2.ts")
        self.assertNotIn("duration", end)


class RouteTests(ServerCase):
    def csp(self) -> str:
        return self.request("GET", "/")[1]["content-security-policy"]

    def test_the_csp_lets_in_only_the_chosen_web(self):
        base = (
            "frame-src https://www.youtube-nocookie.com https://www.youtube.com "
            "https://www.atresplayer.com https://player.twitch.tv"
        )
        self.assertIn(base + ";", self.csp())
        self.post_json(
            "/api/settings",
            {"ad_enabled": True, "ad_screen": "web", "ad_web_url": "https://noticias.example/portada"},
        )
        self.assertIn(base + " https://noticias.example;", self.csp())
        self.post_json("/api/settings", {"ad_screen": "keep"})
        self.assertNotIn("noticias.example", self.csp())

    def test_the_page_is_told_when_there_is_something_to_do(self):
        self.assertIsNone(self.get_json("/api/channels")[1]["meta"]["ads"])
        self.post_json("/api/settings", {"scte_enabled": True, "ad_enabled": True, "ad_audio": "lower"})
        ads = self.get_json("/api/channels")[1]["meta"]["ads"]
        self.assertEqual((ads["audio"], ads["lower_percent"]), ("lower", 25))

    def test_wrong_values_are_refused(self):
        status, data = self.post_json(
            "/api/settings",
            {
                "ad_audio": "ruido",
                "ad_screen": "otra",
                "ad_web_url": "ftp://x",
                "ad_on_touch": "?",
                "ad_lower_percent": 99,
            },
        )
        self.assertEqual(status, 400)
        self.assertEqual(
            set(data["errors"]), {"ad_audio", "ad_screen", "ad_web_url", "ad_on_touch", "ad_lower_percent"}
        )

    def test_an_empty_web_is_fine(self):
        self.assertEqual(self.post_json("/api/settings", {"ad_web_url": ""})[0], 200)

    def test_it_is_off_by_default_and_a_touch_is_respected(self):
        c = self.app.config
        self.assertEqual((c.ad_enabled, c.ad_audio, c.ad_screen, c.ad_on_touch), (False, "mute", "keep", "respect"))

    def test_the_web_check_reports_whether_it_can_be_shown(self):
        self.origin.routes["/ok"] = (200, {"Content-Type": "text/html"}, b"<html></html>")
        self.origin.routes["/no"] = (200, {"Content-Type": "text/html", "X-Frame-Options": "DENY"}, b"x")
        good = self.post_json("/api/settings/test/web", {"url": self.origin.url("/ok")})[1]
        bad = self.post_json("/api/settings/test/web", {"url": self.origin.url("/no")})[1]
        gone = self.post_json("/api/settings/test/web", {"url": self.origin.url("/falta")})[1]
        self.assertTrue(good["ok"])
        self.assertFalse(bad["ok"])
        self.assertIn("X-Frame-Options", bad["error"])
        self.assertIn("404", gone["error"])

    def test_a_channel_with_only_a_web_can_be_added_and_is_listed(self):
        web = "https://www.mediasetinfinity.es/directo/telecinco/"
        status, data = self.post_json("/api/custom", {"name": "Telecinco", "kind": "tv", "sources": [], "web": web})
        self.assertEqual((status, data["ok"], data["id"]), (200, True, "custom-telecinco"))
        channel = next(c for c in self.get_json("/api/channels")[1]["channels"] if c["id"] == "custom-telecinco")
        self.assertEqual((channel["sources"], channel["web"], channel["custom"]), ([], web, True))
        status, data = self.post_json("/api/custom", {"name": "Nada", "sources": []})
        self.assertEqual(status, 400)

    def test_a_channel_with_a_stream_and_an_embedded_player_is_one_channel(self):
        stream = "https://cdn.example/lasexta/master.m3u8"
        player = "https://www.atresplayer.com/embed/live/lasexta/"
        web = "https://www.atresplayer.com/directos/lasexta/"
        first = self.post_json("/api/custom", {"name": "La Sexta", "sources": [stream], "merge": True})[1]
        self.assertEqual((first["ok"], first["merged"], first["id"]), (True, False, "custom-la-sexta"))
        second = self.post_json("/api/custom", {"name": " la sexta ", "sources": [player], "web": web, "merge": True})[
            1
        ]
        self.assertEqual(
            (second["id"], second["merged"]), ("custom-la-sexta", True)
        )  # same name: more sources, not a copy
        own = [c for c in self.get_json("/api/channels")[1]["channels"] if c["custom"]]
        self.assertEqual(len(own), 1)
        self.assertEqual([s["u"] for s in own[0]["sources"]], [stream, player])
        self.assertEqual(own[0]["web"], web)
        # the same link again changes nothing, and without `merge` a copy is still made
        self.post_json("/api/custom", {"name": "La Sexta", "sources": [player], "merge": True})
        self.assertEqual(len(self.app.store.custom[0]["sources"]), 2)
        copy = self.post_json("/api/custom", {"name": "La Sexta", "sources": [stream]})[1]
        self.assertEqual(copy["id"], "custom-la-sexta-2")

    def test_merging_keeps_the_headers_and_does_not_mix_tv_with_radio(self):
        headers = {"Origin": "https://o.example"}
        self.post_json(
            "/api/custom", {"name": "Canal", "sources": ["https://a.example/a.m3u8"], "headers": headers, "merge": True}
        )
        self.post_json("/api/custom", {"name": "Canal", "sources": ["https://b.example/b.m3u8"], "merge": True})
        self.assertEqual(self.app.store.custom[0]["headers"], headers)
        radio = self.post_json(
            "/api/custom", {"name": "Canal", "kind": "radio", "sources": ["https://c.example/c.mp3"], "merge": True}
        )[1]
        self.assertEqual((radio["merged"], len(self.app.store.custom)), (False, 2))

    def test_the_web_check_refuses_nonsense(self):
        self.assertIn("dirección", self.post_json("/api/settings/test/web", {"url": ""})[1]["error"])
        self.assertFalse(self.post_json("/api/settings/test/web", {"url": "ftp://x"})[1]["ok"])

    def test_the_web_check_only_serves_this_machine(self):
        with mock.patch("tdtlocal.settings_routes._from_this_machine", return_value=False):
            status, _ = self.post_json("/api/settings/test/web", {"url": self.origin.url("/ok")})
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
