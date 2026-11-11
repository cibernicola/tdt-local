"""The headers of a channel: what is allowed, where they are sent, how they are kept and how they are changed."""

from __future__ import annotations

import json
import sys
import unittest
import urllib.parse

from tdtlocal import headers as hdr
from tdtlocal.store import Store

from .helpers import AppCase, ServerCase

PUBLIC = {
    "id": "la-2",
    "name": "La 2",
    "kind": "tv",
    "category": "Nacionales",
    "group": "",
    "sources": ["http://127.0.0.1:1/live/a.m3u8"],
    "fmts": [""],
    "web": "",
    "logo": "",
    "epg": "",
    "tags": [],
    "headers": {},
}


class HeaderRulesTests(unittest.TestCase):  # pure functions: no application needed
    def test_names_and_values_are_checked(self) -> None:
        self.assertEqual(hdr.check_name("X-Token"), "X-Token")
        for bad in ("", "con espacio", "tilde-á", "x" * 41, 5, None, "a:b", "a\r\nb"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                hdr.check_name(bad)
        for forbidden in (
            "Host",
            "host",
            "Content-Length",
            "Transfer-Encoding",
            "Connection",
            "Range",
            "Accept-Encoding",
            "Sec-Fetch-Mode",
            "Proxy-Foo",
        ):
            with self.assertRaises(ValueError, msg=forbidden):
                hdr.check_name(forbidden)
        self.assertEqual(hdr.check_value("A", "  valor  "), "valor")
        for bad in ("", "   ", None, 3, "a\nb", "a\rb", "a\x00b", "x" * 601):
            with self.assertRaises(ValueError, msg=repr(bad)):
                hdr.check_value("A", bad)

    def test_a_set_is_cleaned_leniently_from_disk_and_strictly_from_a_person(self) -> None:
        raw = {
            "Origin": "https://o.example",
            "Referer": "https://o/\r\nX-Evil: 1",
            "Host": "x",
            "User-Agent": 5,
            "Cookie": "a=b",
            "cookie": "otra",
        }
        self.assertEqual(hdr.clean(raw), {"Origin": "https://o.example", "Cookie": "a=b"})
        with self.assertRaises(ValueError):
            hdr.clean(raw, strict=True)
        self.assertEqual(hdr.clean(None), {})
        self.assertEqual(hdr.clean([1, 2]), {})
        with self.assertRaises(ValueError):
            hdr.clean([1], strict=True)
        many = {f"X-H{i}": "v" for i in range(12)}
        self.assertEqual(len(hdr.clean(many)), hdr.MAX_HEADERS)
        with self.assertRaises(ValueError):
            hdr.clean(many, strict=True)
        with self.assertRaises(ValueError):
            hdr.clean({"Origin": "a", "origin": "b"}, strict=True)

    def test_merging_sets_replaces_and_removes_whatever_the_case(self) -> None:
        now = {"Referer": "https://a/", "Cookie": "a=b"}
        self.assertEqual(hdr.merge(now, {"referer": "https://b/"}), {"Cookie": "a=b", "referer": "https://b/"})
        self.assertEqual(hdr.merge(now, {"COOKIE": None}), {"Referer": "https://a/"})
        self.assertEqual(hdr.merge(now, {"X-Nada": None}), now, "removing what is not there is harmless")
        self.assertEqual(hdr.merge({}, {"Origin": "https://o/"}), {"Origin": "https://o/"})
        for bad in ({"Host": "x"}, {"Origin": ""}, {"Origin": 5}, "no es un objeto", {3: "x"}):
            with self.assertRaises(ValueError, msg=repr(bad)):
                hdr.merge(now, bad)

    def test_the_credentials_only_go_to_the_hosts_of_the_channel(self) -> None:
        headers = {
            "Origin": "https://o/",
            "Referer": "https://r/",
            "User-Agent": "UA",
            "Cookie": "a=b",
            "X-Token": "t",
            "Authorization": "Bearer x",
        }
        own = hdr.for_host(headers, "cdn.example.com", ["origin.example.com"])
        self.assertEqual(sorted(own), ["Origin", "Referer", "User-Agent"], "a CDN gets the plain ones only")
        mine = hdr.for_host(headers, "ORIGIN.example.com", ["origin.example.com"])
        self.assertEqual(sorted(mine), sorted(headers), "its own host gets everything, whatever the case of the name")
        self.assertTrue(hdr.is_sensitive("Cookie") and hdr.is_sensitive("X-Token") and not hdr.is_sensitive("REFERER"))

    def test_what_the_page_sees_hides_the_value_of_a_credential(self) -> None:
        shown = hdr.describe({"Referer": "https://r/", "Cookie": "a=secreto"})
        self.assertEqual(shown[0], {"name": "Referer", "value": "https://r/", "secret": False, "set": True})
        self.assertEqual(shown[1], {"name": "Cookie", "value": None, "secret": True, "set": True})
        self.assertNotIn("secreto", json.dumps(shown))


class StoreHeaderTests(AppCase):
    def setUp(self) -> None:
        super().setUp()
        self.app.store.channels = [dict(PUBLIC)]
        self.app.store.rebuild_allowlists()

    def test_a_channel_of_a_public_list_gets_headers_that_survive_a_list_update(self) -> None:
        store = self.app.store
        done = store.set_headers("la-2", {"Referer": "https://www.rtve.es/", "Cookie": "a=b"})
        self.assertFalse(done["own"])
        self.assertEqual([h["name"] for h in done["headers"]], ["Referer", "Cookie"])
        self.assertEqual(store.custom_headers["la-2"], {"Referer": "https://www.rtve.es/", "Cookie": "a=b"})
        store.channels = [dict(PUBLIC, name="La 2 (nueva lista)")]  # the list is downloaded again
        store.rebuild_allowlists()
        self.assertEqual(store.custom_headers["la-2"]["Referer"], "https://www.rtve.es/")
        again = Store(self.app.config, self.app.net)
        again.load()
        self.assertEqual(again.overrides["la-2"], {"Referer": "https://www.rtve.es/", "Cookie": "a=b"}, "kept on disk")
        store.set_headers("la-2", {"Referer": None, "Cookie": None})
        self.assertNotIn("la-2", store.custom_headers)
        self.assertEqual(store.get_headers("la-2")["headers"], [])

    def test_an_own_channel_keeps_its_headers_with_the_channel(self) -> None:
        store = self.app.store
        cid = store.add_custom(
            {"name": "Mío", "sources": ["https://x.example/a.m3u8"], "headers": {"Origin": "https://o.example"}}
        )
        done = store.set_headers(cid, {"User-Agent": "VLC/3", "Origin": None})
        self.assertTrue(done["own"])
        self.assertEqual(store.custom_headers[cid], {"User-Agent": "VLC/3"})
        self.assertEqual(next(c for c in store.custom if c["id"] == cid)["headers"], {"User-Agent": "VLC/3"})
        self.assertEqual(
            store.set_headers(cid, {"Referer": "https://r/"}, replace=True)["headers"][0]["name"], "Referer"
        )
        self.assertEqual(store.custom_headers[cid], {"Referer": "https://r/"}, "replace drops what was there")

    @unittest.skipIf(
        sys.platform == "win32", "Windows ignores the file mode: the folder of the user is already private"
    )
    def test_the_files_that_may_hold_a_cookie_are_only_readable_by_the_user(self) -> None:
        store = self.app.store
        cid = store.add_custom({"name": "Mío", "sources": ["https://x.example/a.m3u8"]})
        store.set_headers(cid, {"Cookie": "a=b"})
        store.set_headers("la-2", {"Cookie": "c=d"})
        for name in ("custom.json", "headers.json"):
            mode = (self.app.config.data_dir / name).stat().st_mode & 0o777
            self.assertEqual(mode, 0o600, name)

    def test_what_is_wrong_is_refused_and_changes_nothing(self) -> None:
        store = self.app.store
        with self.assertRaises(ValueError):
            store.set_headers("no-existe", {"Origin": "https://o/"})
        for bad in ({"Host": "x"}, {"Origin": "a\r\nb"}, {"Origin": "https://o/", "Host": "x"}):
            with self.assertRaises(ValueError, msg=repr(bad)):
                store.set_headers("la-2", bad)
        self.assertNotIn("la-2", store.custom_headers)
        self.assertIsNone(store.get_headers("no-existe"))

    def test_the_headers_are_only_sent_to_the_hosts_that_may_have_them(self) -> None:
        store = self.app.store
        store.set_headers("la-2", {"Referer": "https://r/", "Cookie": "a=b"})
        self.assertEqual(
            store.headers_for("la-2", "http://127.0.0.1:1/live/seg.ts"), {"Referer": "https://r/", "Cookie": "a=b"}
        )
        self.assertEqual(store.headers_for("la-2", "http://cdn.example/seg.ts"), {"Referer": "https://r/"})
        self.assertEqual(store.headers_for("otro", "http://127.0.0.1:1/x"), {})
        self.assertEqual(store.credential_names("la-2"), ["Cookie"])


class HeaderRouteTests(ServerCase):
    def setUp(self) -> None:
        super().setUp()
        self.app.store.channels = [dict(PUBLIC, sources=[self.origin.base + "/live/a.m3u8"])]
        self.app.store.rebuild_allowlists()

    def test_the_page_can_read_and_change_them_and_never_gets_a_credential_back(self) -> None:
        status, data = self.get_json("/api/headers?id=la-2")
        self.assertEqual((status, data["headers"], data["own"]), (200, [], False))
        status, data = self.post_json(
            "/api/headers", {"id": "la-2", "headers": {"Referer": "https://r/", "Cookie": "a=secreto"}}
        )
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        _, data = self.get_json("/api/headers?id=la-2")
        self.assertEqual(
            [(h["name"], h["value"], h["secret"]) for h in data["headers"]],
            [("Referer", "https://r/", False), ("Cookie", None, True)],
        )
        raw = self.request("GET", "/api/headers?id=la-2")[2].decode()
        self.assertNotIn("secreto", raw)
        self.assertNotIn("secreto", json.dumps(self.get_json("/api/channels")[1]), "nor does the list of channels")
        status, data = self.post_json("/api/headers", {"id": "la-2", "headers": {"Host": "x"}})
        self.assertEqual(status, 400)
        self.assertIn("no se puede cambiar", data["error"])
        self.assertEqual(self.post_json("/api/headers", {"id": "no-existe", "headers": {"A": "b"}})[0], 400)
        self.assertEqual(self.get_json("/api/headers?id=no-existe")[0], 404)

    def test_a_channel_with_headers_is_marked_so_that_the_page_tells_the_proxy(self) -> None:
        channels = lambda: {c["id"]: c for c in self.get_json("/api/channels")[1]["channels"]}  # noqa: E731
        self.assertFalse(channels()["la-2"]["hdr"])
        self.post_json("/api/headers", {"id": "la-2", "headers": {"Referer": "https://r/"}})
        self.assertTrue(channels()["la-2"]["hdr"])

    def test_the_proxy_sends_them_to_the_origin_and_the_credentials_only_to_its_own_host(self) -> None:
        port = self.origin.httpd.server_address[1]
        self.origin.routes["/live/a.m3u8"] = (
            200,
            {"Content-Type": "application/vnd.apple.mpegurl"},
            b"#EXTM3U\n#EXTINF:1,\nseg.ts\n",
        )
        self.origin.routes["/live/seg.ts"] = (200, {"Content-Type": "video/mp2t"}, b"x" * 20)
        self.origin.routes["/otro"] = (200, {"Content-Type": "video/mp2t"}, b"y" * 20)
        self.origin.routes["/salta"] = (302, {"Location": f"http://localhost:{port}/otro"}, b"")
        self.post_json(
            "/api/headers",
            {"id": "la-2", "headers": {"Referer": "https://r.example/", "Cookie": "a=b", "X-Token": "t"}},
        )
        self.app.net.allow(f"http://localhost:{port}/otro")

        def ask(url: str) -> dict[str, str]:
            before = len(self.origin.requests)
            status = self.request("GET", "/proxy?u=" + urllib.parse.quote(url, safe="") + "&c=la-2&s=t")[0]
            self.assertEqual(status, 200, url)
            return self.origin.requests[before][1]

        own = ask(self.origin.base + "/live/a.m3u8")
        self.assertEqual(
            (own.get("referer"), own.get("cookie"), own.get("x-token")), ("https://r.example/", "a=b", "t")
        )
        other = ask(f"http://localhost:{port}/otro")  # another host: the same machine under another name
        self.assertEqual(
            other.get("referer"), "https://r.example/", "the plain header goes to every host of the channel"
        )
        self.assertIsNone(other.get("cookie"))
        self.assertIsNone(other.get("x-token"))
        # a redirect from its own host to another one: the credentials are dropped on the way, the plain header stays
        before = len(self.origin.requests)
        self.assertEqual(
            self.request("GET", "/proxy?u=" + urllib.parse.quote(self.origin.base + "/salta", safe="") + "&c=la-2&s=t")[
                0
            ],
            200,
        )
        first, second = (r[1] for r in self.origin.requests[before : before + 2])
        self.assertEqual((first.get("cookie"), first.get("x-token")), ("a=b", "t"))
        self.assertEqual(second.get("referer"), "https://r.example/")
        self.assertIsNone(second.get("cookie"))
        self.assertIsNone(second.get("x-token"))
