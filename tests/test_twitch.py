from tdtlocal.store import channel_ok, source_ok

from .helpers import AppCase


class TwitchTests(AppCase):
    def test_embedded_players_are_not_probed_as_hls_or_hidden_by_old_failures(self):
        url = "https://player.twitch.tv/?channel=ibai&parent=play.tdtchannels.com"
        channel = {"sources": [url], "fmts": [""], "kind": "tv"}
        status = {url: {"ok": False}}
        self.assertIsNone(source_ok(channel, url, status))
        self.assertIsNone(channel_ok(channel, status))
        self.app.store.channels = [channel]
        self.assertEqual(self.app.store.sources("tv"), {})

    def test_twitch_lookalike_is_not_exempt_from_probes(self):
        url = "https://player.twitch.tv.evil.example/?channel=ibai"
        self.assertFalse(source_ok({"sources": [url]}, url, {url: {"ok": False}}))
