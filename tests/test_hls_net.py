import socket
import unittest
import urllib.error
import urllib.request
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from tdtlocal.hls import proxy_url, rewrite_playlist
from tdtlocal.net import Blocked, Net, _RedirectGuard, host_of

from .helpers import FakeOrigin

PLAYLIST = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/a.m3u8"
#EXT-X-MAP:URI="data:text/plain;base64,AAAA"

#EXTINF:6.0,
seg1.ts
#EXTINF:6.0,
https://cdn.example/abs/seg2.ts?token=a b&x=1
"""


class RewritePlaylistTests(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.out = rewrite_playlist(PLAYLIST, "https://o.example/live/index.m3u8", on_url=self.seen.append)

    def target_of(self, line):
        return parse_qs(urlsplit(line).query)["u"][0]

    def test_segments_and_uris_go_through_the_proxy(self):
        lines = self.out.splitlines()
        segs = [line for line in lines if line.startswith("/proxy")]
        self.assertEqual(self.target_of(segs[0]), "https://o.example/live/seg1.ts")
        self.assertEqual(self.target_of(segs[1]), "https://cdn.example/abs/seg2.ts?token=a b&x=1")
        key = next(line for line in lines if "EXT-X-KEY" in line)
        self.assertIn('URI="/proxy?u=https%3A%2F%2Fo.example%2Flive%2Fkey.bin"', key)

    def test_tags_blank_lines_and_data_uris_are_preserved(self):
        self.assertIn("#EXTINF:6.0,", self.out)
        self.assertIn('URI="data:text/plain;base64,AAAA"', self.out)
        self.assertIn("\n\n", self.out)
        self.assertTrue(self.out.endswith("\n"))

    def test_every_absolute_url_is_reported_for_the_allow_list(self):
        self.assertIn("https://cdn.example/abs/seg2.ts?token=a b&x=1", self.seen)
        self.assertIn("https://o.example/live/audio/a.m3u8", self.seen)
        self.assertFalse(any(u.startswith("data:") for u in self.seen))

    def test_channel_and_session_tags_are_propagated(self):
        out = rewrite_playlist("#EXTM3U\nseg.ts\n", "https://o.example/", "custom-x", "sabc")
        query = parse_qs(urlsplit(out.splitlines()[1]).query)
        self.assertEqual((query["c"], query["s"]), (["custom-x"], ["sabc"]))

    def test_proxy_url_leaves_non_http_alone(self):
        self.assertEqual(proxy_url("data:,WEBVTT"), "data:,WEBVTT")
        self.assertEqual(proxy_url("HTTP://x.example/a"), "/proxy?u=HTTP%3A%2F%2Fx.example%2Fa")


class NetTests(unittest.TestCase):
    def setUp(self):
        self.origin = FakeOrigin()
        self.addCleanup(self.origin.close)
        self.net = Net(allow_private=True)

    def test_host_of(self):
        self.assertEqual(host_of("HTTPS://Example.COM:8080/x"), "example.com")
        self.assertEqual(host_of("no url"), "")

    def test_rejects_non_http_schemes(self):
        for url in ("file:///etc/passwd", "ftp://x.example/a", "javascript:alert(1)", "http:///nohost"):
            with self.assertRaises(Blocked, msg=url):
                self.net.check_url(url, require_allowed=False)

    def test_allow_list_is_enforced_when_required(self):
        url = self.origin.url("/x")
        with self.assertRaises(Blocked):
            self.net.check_url(url, require_allowed=True)
        self.net.allow(url)
        self.net.check_url(url, require_allowed=True)

    def test_private_addresses_are_blocked_by_default(self):
        strict = Net(allow_private=False)
        for url in (
            "http://127.0.0.1/",
            "http://localhost/",
            "http://10.0.0.5/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
        ):
            strict.allow(url)
            with self.assertRaises(Blocked, msg=url):
                strict.check_url(url, require_allowed=True)

    def test_a_host_that_turns_private_after_the_check_is_never_connected_to(self):
        """DNS rebinding: public when the URL is checked, the loopback address when the connection is made."""
        self.origin.routes["/secret"] = (200, {}, b"internal")
        port = self.origin.httpd.server_address[1]
        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]
        loopback = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]
        strict = Net(allow_private=False)
        with (
            mock.patch("tdtlocal.net.socket.getaddrinfo", side_effect=[public, loopback]),
            mock.patch("tdtlocal.net.urllib.request.getproxies", return_value={}),
        ):
            strict.check_url(f"http://rebind.example:{port}/secret", require_allowed=False)
            strict._dns.clear()  # the answer was kept for a moment: let it expire, as it would for a slow request
            with self.assertRaises(Blocked):
                strict.open(f"http://rebind.example:{port}/secret", require_allowed=False)
        self.assertEqual(self.origin.requests, [], "nothing reached the private address")

    def test_the_connection_uses_the_address_that_was_checked(self):
        """What the check resolved is what is connected to, without asking DNS again."""
        self.origin.routes["/ok"] = (200, {}, b"fine")
        port = self.origin.httpd.server_address[1]
        local = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]
        with (
            mock.patch("tdtlocal.net.socket.getaddrinfo", return_value=local) as lookup,
            mock.patch("tdtlocal.net.urllib.request.getproxies", return_value={}),
            self.net.open(f"http://some-name.example:{port}/ok", require_allowed=False) as response,
        ):
            self.assertEqual(response.read(), b"fine")
        self.assertEqual(lookup.call_count, 1)

    def test_unresolvable_host_is_blocked(self):
        with (
            mock.patch("tdtlocal.net.socket.getaddrinfo", side_effect=socket.gaierror),
            mock.patch("tdtlocal.net.urllib.request.getproxies", return_value={}),
            self.assertRaises(Blocked),
        ):
            Net().check_url("http://no-such-host.example/", require_allowed=False)

    def test_open_sends_default_and_extra_headers(self):
        self.origin.routes["/h"] = (200, {}, b"ok")
        with self.net.open(self.origin.url("/h"), {"Referer": "https://r.example/"}, require_allowed=False) as r:
            self.assertEqual(r.read(), b"ok")
        headers = self.origin.requests[-1][1]
        self.assertEqual(headers["referer"], "https://r.example/")
        self.assertIn("mozilla", headers["user-agent"].lower())

    def test_redirects_are_followed_and_their_hosts_allowed(self):
        self.origin.routes["/go"] = (302, {"Location": "/dest"}, b"")
        self.origin.routes["/dest"] = (200, {}, b"arrived")
        with self.net.open(self.origin.url("/go"), require_allowed=False) as r:
            self.assertEqual(r.read(), b"arrived")
        self.assertTrue(self.net.is_allowed("127.0.0.1"))

    def test_redirect_guard_blocks_private_targets_and_allows_public_ones(self):
        strict = Net(allow_private=False)
        guard = _RedirectGuard(strict)
        request = urllib.request.Request("http://example.com/")
        with self.assertRaises(Blocked):
            guard.redirect_request(request, None, 302, "Found", {}, "http://10.0.0.5/secret")
        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80))]
        with mock.patch("tdtlocal.net.socket.getaddrinfo", return_value=public):
            guard.redirect_request(request, None, 302, "Found", {}, "http://cdn.example.org/ok")
        self.assertTrue(strict.is_allowed("cdn.example.org"))

    def test_fetch_trusted_returns_body_headers_and_raises_on_304(self):
        self.origin.routes["/f"] = (200, {"ETag": '"abc"'}, b"hello")
        self.origin.routes["/nm"] = (304, {}, b"")
        body, headers = self.net.fetch_trusted(self.origin.url("/f"))
        self.assertEqual((body, headers["ETag"]), (b"hello", '"abc"'))
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.net.fetch_trusted(self.origin.url("/nm"))
        self.assertEqual(ctx.exception.code, 304)
        ctx.exception.close()

    def test_fetch_trusted_reads_one_byte_past_the_limit(self):
        self.origin.routes["/big"] = (200, {}, b"x" * 100)
        body, _ = self.net.fetch_trusted(self.origin.url("/big"), limit=10)
        self.assertEqual(len(body), 11)


if __name__ == "__main__":
    unittest.main()
