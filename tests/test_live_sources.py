"""Mediaset and Atresplayer sources: channel injection and manifest rewriting (no network)."""

import io
import json
import unittest

from tdtlocal import atresplayer, mediaset


class FakeNet:
    """Answers by URL fragment, records what was asked, and never touches the network."""

    def __init__(self, answers: dict[str, bytes]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, dict[str, str], bytes | None]] = []

    def open(self, url, headers=None, require_allowed=True, timeout=20, data=None):
        self.calls.append((url, dict(headers or {}), data))
        for fragment, body in self.answers.items():
            if fragment in url:
                return io.BytesIO(body)
        raise AssertionError(f"unexpected request: {url}")


MPD = b"""<MPD type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z">
<Period id="1" start="PT0S"><BaseURL>dash/</BaseURL>
<SegmentTemplate
    timescale="48000"
    media="x-$Time$.dash">
    <!-- a comment -->
    <SegmentTimeline>
      <S t="96000000" d="92160" r="2" />
    </SegmentTimeline>
</SegmentTemplate></Period></MPD>"""


class MediasetTests(unittest.TestCase):
    def test_attach_puts_the_source_first_on_known_channels_only(self) -> None:
        listed = [
            {"id": "telecinco", "kind": "tv", "sources": [], "fmts": []},
            {"id": "be-mad", "kind": "tv", "sources": ["https://x/a.m3u8"], "fmts": ["m3u8"]},
            {"id": "la-1", "kind": "tv", "sources": [], "fmts": []},
        ]
        out = mediaset.attach(listed)
        self.assertEqual(out[0]["sources"], ["mediaset:telecinco"])
        self.assertEqual(out[1]["sources"], ["mediaset:bemad", "https://x/a.m3u8"])
        self.assertEqual(out[1]["fmts"], ["", "m3u8"])
        self.assertEqual(out[2]["sources"], [])
        self.assertEqual(listed[0]["sources"], [])  # inputs are not mutated

    def test_prepare_mpd_makes_base_absolute_and_rebases_the_timeline(self) -> None:
        url = "https://directos.mediasetinfinity.es/a/web.mpd"
        out = mediaset.prepare_mpd(MPD, url).decode()
        self.assertIn("<BaseURL>https://directos.mediasetinfinity.es/a/dash/</BaseURL>", out)
        self.assertIn('availabilityStartTime="1970-01-01T00:33:20Z"', out)  # 96000000 / 48000 = 2000 s
        self.assertIn('presentationTimeOffset="96000000"', out)
        again = mediaset.prepare_mpd(MPD.replace(b"96000000", b"97000000"), url).decode()
        self.assertIn('presentationTimeOffset="96000000"', again)  # the offset must not move between refreshes

    def test_hosts_outside_mediaset_are_refused(self) -> None:
        with self.assertRaises(ValueError):
            mediaset.open_media(FakeNet({}), "https://evil.example/web.mpd")
        with self.assertRaises(ValueError):
            mediaset.relay_license(FakeNet({}), "https://evil.example/lic", b"x")

    def test_resolve_follows_login_playback_check_and_smil(self) -> None:
        smil = (
            b'<smil xmlns="http://www.w3.org/2005/SMIL21/Language"><body><seq>'
            b'<video src="https://directos.mediasetinfinity.es/a/web.mpd">'
            b'<param name="trackingData" value="pid=P1|aid=A1"/></video></seq></body></smil>'
        )
        net = FakeNet(
            {
                "anonymous/login": json.dumps({"response": {"sid": "S", "beToken": "J"}}).encode(),
                "playback/v3.0/check": json.dumps(
                    {"response": {"mediaSelector": {"url": "https://link.theplatform.eu/s/x", "format": "SMIL"}}}
                ).encode(),
                "link.theplatform.eu": smil,
            }
        )
        out = mediaset.resolve(net, "telecinco")
        self.assertEqual(out["mpd"], "https://directos.mediasetinfinity.es/a/web.mpd")
        self.assertIn("releasePid=P1", out["license"])
        self.assertIn("token=J", out["license"])
        login = net.calls[0]
        self.assertEqual(login[1]["Origin"], "https://www.mediasetinfinity.es")
        self.assertIn(b'"mediasetplay"', login[2])

    def test_relay_license_posts_the_challenge_unchanged(self) -> None:
        net = FakeNet({"theplatform.eu": b"licence"})
        url = "https://widevine.entitlement.theplatform.eu/wv/web/ModularDrm/getRawWidevineLicense?x=1"
        self.assertEqual(mediaset.relay_license(net, url, b"\x08\x04"), b"licence")
        self.assertEqual(net.calls[0][2], b"\x08\x04")


class DialOrderTests(unittest.TestCase):
    def test_main_channels_go_first_in_dial_order(self) -> None:
        from tdtlocal.store import dial_order

        ids = ["fdf", "telecinco", "la-2", "x", "lasexta", "cuatro", "la-1", "antena3", "neox", "y", "energy"]
        out = dial_order([{"id": i, "kind": "tv"} for i in ids])
        self.assertEqual(
            [c["id"] for c in out],
            ["la-1", "la-2", "antena3", "cuatro", "telecinco", "lasexta", "fdf", "energy", "neox", "x", "y"],
        )


class AtresplayerTests(unittest.TestCase):
    def test_channels_have_atres_sources(self) -> None:
        chans = atresplayer.channels()
        self.assertEqual({c["id"] for c in chans}, set(atresplayer.CHANNELS))
        self.assertTrue(all(atresplayer.is_atres(c["sources"][0]) for c in chans))

    def test_unknown_channel(self) -> None:
        with self.assertRaises(ValueError):
            atresplayer.resolve(FakeNet({}), "nope")

    def test_resolve_picks_the_clear_hls_source(self) -> None:
        net = FakeNet(
            {
                "info/channels": json.dumps([{"id": "X1", "link": {"url": "/antena3/"}}]).encode(),
                "player/v1/live/X1": json.dumps(
                    {"sourcesLive": [{"src": "https://cdn/a.mpd"}, {"src": "https://cdn/a.m3u8?x=1"}]}
                ).encode(),
            }
        )
        self.assertEqual(atresplayer.resolve(net, "antena3"), "https://cdn/a.m3u8?x=1")
        self.assertIn("NODRM=true", net.calls[1][0])


if __name__ == "__main__":
    unittest.main()


class ExtraGuideTests(unittest.TestCase):
    XML = b"""<tv>
      <channel id="Antena 3 HD"><display-name>Antena 3</display-name></channel>
      <programme start="20261101120000 +0100" stop="20261101130000 +0100" channel="Antena 3 HD">
        <title>Noticias</title><desc>d</desc><category>Informativos</category></programme>
      <programme start="20261101100000 +0100" stop="20261101110000 +0100" channel="Antena 3 HD">
        <title>Pasado</title></programme>
      <programme start="20261101120000 +0100" stop="20261101130000 +0100" channel="Otro">
        <title>Ajeno</title></programme>
    </tv>"""

    def test_subset_keeps_only_wanted_channels_and_renames_them(self) -> None:
        from tdtlocal.epg import parse_xmltv_subset

        now = 1793530000  # 2026-11-01 11:26 UTC+1
        out = parse_xmltv_subset(self.XML, {"Antena3.TV": "Antena 3 HD"}, now=now)
        self.assertEqual(list(out), ["Antena3.TV"])
        self.assertEqual([p[2] for p in out["Antena3.TV"]], ["Noticias"])
        self.assertEqual(out["Antena3.TV"][0][4], "Informativos")

    def test_subset_rejects_entities(self) -> None:
        from tdtlocal.epg import parse_xmltv_subset

        with self.assertRaises(ValueError):
            parse_xmltv_subset(b'<!DOCTYPE x [<!ENTITY a "b">]><tv/>', {})


if __name__ == "__main__":
    unittest.main()
