import json
import time
import urllib.error
from unittest import mock

from tdtlocal.config import PACKAGE_DIR, Config

from .helpers import ServerCase, fixture, make_tv_markdown

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
LIVE = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6,\nseg0.ts\n"


class ConfigTests(ServerCase):
    def test_loopback_detection(self):
        self.assertTrue(Config().loopback_only)
        self.assertTrue(Config(host="localhost").loopback_only)
        self.assertFalse(Config(host="0.0.0.0").loopback_only)  # noqa: S104
        self.assertEqual(Config(update_hours=2).update_seconds, 7200)


class StaticAndGuardTests(ServerCase):
    def test_index_is_served_with_security_headers(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<title>TDT local</title>", body)
        self.assertEqual(headers["content-type"], "text/html; charset=utf-8")
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertEqual(headers["referrer-policy"], "no-referrer")
        csp = headers["content-security-policy"]
        self.assertIn("script-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertNotIn("unsafe-inline", csp)
        self.assertNotIn("unsafe-eval", csp)

    def test_twitch_csp_only_allows_the_official_sdk_script_and_player_frame(self):
        _, headers, _ = self.request("GET", "/")
        directives = dict(part.strip().split(" ", 1) for part in headers["content-security-policy"].split("; "))
        self.assertEqual(directives["script-src"].split(), ["'self'", "https://player.twitch.tv/js/embed/v1.js"])
        self.assertIn("https://player.twitch.tv", directives["frame-src"].split())
        self.assertEqual(directives["connect-src"], "'self'")

    def test_content_types_and_conditional_requests(self):
        status, headers, _ = self.request("GET", "/style.css")
        self.assertEqual((status, headers["content-type"]), (200, "text/css; charset=utf-8"))
        etag = headers["etag"]
        _, js_headers, _ = self.request("GET", "/js/app.js")
        self.assertEqual(js_headers["content-type"], "text/javascript; charset=utf-8")
        status, _, body = self.request("GET", "/style.css", headers={"If-None-Match": etag})
        self.assertEqual((status, body), (304, b""))
        status, _, _ = self.request("GET", "/style.css", headers={"If-None-Match": '"other"'})
        self.assertEqual(status, 200)

    def test_head_has_no_body(self):
        status, headers, body = self.request("HEAD", "/")
        self.assertEqual((status, body), (200, b""))
        self.assertGreater(int(headers["content-length"]), 0)

    def test_missing_files_and_path_traversal(self):
        for path in (
            "/nope.js",
            "/../pyproject.toml",
            "/%2e%2e/pyproject.toml",
            "/..%2f..%2fpyproject.toml",
            "/static/../../pyproject.toml",
            "/js",
            "//etc/passwd",
            "/%00",
        ):
            status, _, body = self.request("GET", path)
            self.assertEqual(status, 404, msg=path)
            self.assertNotIn(b"[project]", body, msg=path)

    def test_foreign_host_is_rejected(self):
        status, body = self.get_json("/api/channels", headers={"Host": "evil.example"})
        self.assertEqual(status, 403)
        self.assertIn("host", body["error"])

    def test_dns_rebinding_with_port_is_rejected(self):
        status, _ = self.get_json("/api/channels", headers={"Host": "attacker.example:8788"})
        self.assertEqual(status, 403)

    def test_localhost_host_header_is_accepted(self):
        status, _ = self.get_json("/api/channels", headers={"Host": f"localhost:{self.port}"})
        self.assertEqual(status, 200)

    def test_cross_site_requests_are_rejected(self):
        status, _body = self.get_json("/api/channels", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)
        status, _ = self.post_json(
            "/api/custom", {"name": "x", "sources": ["https://x/a"]}, headers={"Sec-Fetch-Site": "same-site"}
        )
        self.assertEqual(status, 403)

    def test_foreign_origin_is_rejected_and_same_origin_accepted(self):
        status, _ = self.post_json("/api/custom/delete", {"id": "x"}, headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.post_json(
            "/api/custom/delete", {"id": "x"}, headers={"Origin": f"http://127.0.0.1:{self.port}"}
        )
        self.assertEqual(status, 200)

    def test_unknown_post_route(self):
        status, _ = self.post_json("/api/nope")
        self.assertEqual(status, 404)

    def test_oversized_or_invalid_json_bodies_are_treated_as_empty(self):
        status, _body = self.post_json("/api/custom", {"name": "x" * 50_000, "sources": ["https://x/a"]})
        self.assertEqual(status, 400)
        status, _, _data = self.request("POST", "/api/custom", headers={"Content-Type": "application/json"})
        self.assertEqual(status, 400)


class ApiTests(ServerCase):
    def setUp(self):
        super().setUp()
        store = self.app.store
        store.channels = [
            {
                "id": "la-1",
                "name": "La 1",
                "kind": "tv",
                "category": "N",
                "group": "",
                "epg": "La1.TV",
                "sources": [self.origin.url("/a.m3u8"), self.origin.url("/b.m3u8")],
                "fmts": ["", ""],
                "logo": "",
                "web": "",
                "tags": [],
            },
        ]
        store.status = {self.origin.url("/a.m3u8"): {"ok": False}, self.origin.url("/b.m3u8"): {"ok": True}}
        store.rebuild_allowlists()

    def test_channels_payload(self):
        status, data = self.get_json("/api/channels")
        self.assertEqual(status, 200)
        channel = data["channels"][0]
        self.assertTrue(channel["ok"])
        self.assertEqual([s["ok"] for s in channel["sources"]], [False, True])
        self.assertNotIn("fmts", channel)
        self.assertNotIn("etag", data["meta"])
        self.assertTrue(data["meta"]["ai"])
        self.assertFalse(data["meta"]["stt"])  # no ffmpeg/whisper in the test configuration
        self.assertEqual(set(data["health"]), {"running", "done", "total", "finished"})

    def test_custom_headers_never_reach_the_browser(self):
        status, data = self.post_json(
            "/api/custom",
            {"name": "La Sexta", "sources": ["https://x.example/a.m3u8"], "headers": {"Referer": "https://r.example/"}},
        )
        self.assertEqual((status, data["ok"]), (200, True))
        _, listing = self.get_json("/api/channels")
        own = next(c for c in listing["channels"] if c["id"] == data["id"])
        self.assertNotIn("headers", own)
        self.assertIsNone(own["sources"][0]["ok"])  # custom channels are never health-checked
        self.assertNotIn("r.example", json.dumps(listing))

    def test_custom_add_validation_and_delete(self):
        status, data = self.post_json("/api/custom", {"name": "", "sources": []})
        self.assertEqual((status, data["ok"]), (400, False))
        _, added = self.post_json("/api/custom", {"name": "Mi canal", "sources": ["https://x.example/a.m3u8"]})
        _, removed = self.post_json("/api/custom/delete", {"id": added["id"]})
        self.assertTrue(removed["ok"])
        _, again = self.post_json("/api/custom/delete", {"id": added["id"]})
        self.assertFalse(again["ok"])

    def test_epg_endpoints(self):
        self.app.store.epg["tv"] = {
            "La1.TV": [[1, 2, "Pasado", "", ""], [time.time() - 10, time.time() + 600, "Ahora", "d", "c"]]
        }
        _, overview = self.get_json("/api/epg")
        self.assertEqual([p[2] for p in overview["now"]["La1.TV"]], ["Ahora"])
        _, detail = self.get_json("/api/epg?id=La1.TV")
        self.assertEqual(detail["programmes"][0][2], "Ahora")

    def test_health_status_and_start(self):
        status, health = self.get_json("/api/check")
        self.assertEqual((status, health["running"]), (200, False))
        with mock.patch.object(self.app.health, "start", return_value=True) as start:
            _, data = self.post_json("/api/check?kind=radio")
            self.assertEqual((data, start.call_args.args), ({"started": True}, ("radio",)))
            self.post_json("/api/check?kind=bogus")
            self.assertEqual(start.call_args.args, ("tv",))

    def test_refresh_downloads_the_lists(self):
        self.origin.routes["/TELEVISION.md"] = (200, {}, make_tv_markdown(60).encode())
        self.origin.routes["/RADIO.md"] = (
            200,
            {},
            (
                fixture("RADIO.md")
                + "\n".join(f"| R{i} | [mp3](https://r.example/{i}.mp3) | - | - | - | - |" for i in range(40))
            ).encode(),
        )
        self.app.config.tv_source = self.origin.url("/TELEVISION.md")
        self.app.config.radio_source = self.origin.url("/RADIO.md")
        self.app.config.epg_enabled = False
        status, data = self.post_json("/api/refresh")
        self.assertEqual((status, data["ok"], data["count"]), (200, True, 60))

    def test_refresh_reports_failures(self):
        self.origin.routes["/TELEVISION.md"] = (500, {}, b"")
        self.app.config.tv_source = self.origin.url("/TELEVISION.md")
        self.app.config.epg_enabled = False
        status, data = self.post_json("/api/refresh")
        self.assertEqual((status, data["ok"]), (502, False))

    def test_stt_is_unavailable_without_ffmpeg_and_whisper(self):
        self.assertEqual(self.post_json("/api/stt", {"s": "abc", "on": True})[0], 404)
        status, data = self.get_json("/api/stt?s=abc&after=zz")
        self.assertEqual((status, data["active"]), (200, False))


class AssistantApiTests(ServerCase):
    def test_disabled(self):
        self.app.config.ai_enabled = False
        status, data = self.post_json("/api/ai", {"q": "hola"})
        self.assertEqual(status, 404)
        self.assertIn("--no-ai", data["error"])

    def test_model_down(self):
        with mock.patch("tdtlocal.ai.LOCAL_OPENER.open", side_effect=urllib.error.URLError("refused")):
            status, data = self.post_json("/api/ai", {"q": "hola"})
        self.assertEqual(status, 502)
        self.assertIn("no responde", data["error"])

    def test_model_http_error(self):
        self.app.config.llm_url = self.origin.url("/v1")
        self.origin.routes["/v1/chat/completions"] = (500, {}, b"boom")
        status, data = self.post_json("/api/ai", {"q": "hola"})
        self.assertEqual((status, data["error"]), (502, "el modelo devolvió HTTP 500"))

    def test_model_returns_nonsense(self):
        self.app.config.llm_url = self.origin.url("/v1")
        self.origin.routes["/v1/chat/completions"] = (200, {}, b"<html>")
        status, data = self.post_json("/api/ai", {"q": "hola"})
        self.assertEqual(status, 502)
        self.assertIn("no se entiende", data["error"])

    def test_empty_question(self):
        status, _ = self.post_json("/api/ai", {"q": "  "})
        self.assertEqual(status, 400)

    def test_success(self):
        self.app.config.llm_url = self.origin.url("/v1")
        reply = {"say": "Hecho", "actions": [{"do": "guide"}], "results": []}
        body = {"choices": [{"message": {"content": json.dumps(reply)}, "finish_reason": "stop"}]}
        self.origin.routes["/v1/chat/completions"] = (200, {}, json.dumps(body).encode())
        status, data = self.post_json("/api/ai", {"q": "abre la guía"})
        self.assertEqual((status, data["actions"]), (200, [{"do": "guide"}]))


class ProxyTests(ServerCase):
    def setUp(self):
        super().setUp()
        o = self.origin
        o.routes["/live.m3u8"] = (200, {"Content-Type": "application/vnd.apple.mpegurl"}, LIVE.encode())
        o.routes["/seg0.ts"] = lambda h: (
            (206, {"Content-Type": "video/mp2t"}, b"\x47" * 10)
            if h.headers.get("Range")
            else (200, {"Content-Type": "video/mp2t"}, b"\x47" + b"s" * 999)
        )
        o.routes["/go"] = (302, {"Location": "/live.m3u8"}, b"")
        o.routes["/plain"] = (200, {"Content-Type": "text/plain"}, LIVE.encode())  # playlist detected by its magic
        o.routes["/radio.mp3"] = (200, {"Content-Type": "audio/mpeg"}, b"ID3" + b"\x00" * 500)
        self.app.net.allow(o.url("/"))

    def proxy(self, url, extra="", **kwargs):
        from urllib.parse import quote

        return self.request("GET", f"/proxy?u={quote(url, safe='')}{extra}", **kwargs)

    def test_playlist_is_rewritten_through_the_proxy(self):
        status, headers, body = self.proxy(self.origin.url("/live.m3u8"))
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/vnd.apple.mpegurl")
        self.assertEqual(headers["cache-control"], "no-store")
        text = body.decode()
        self.assertIn("/proxy?u=http%3A%2F%2F127.0.0.1%3A", text)
        self.assertNotIn("\nseg0.ts", text)

    def test_segment_is_relayed_byte_for_byte(self):
        status, headers, body = self.proxy(self.origin.url("/seg0.ts"))
        self.assertEqual((status, len(body)), (200, 1000))
        self.assertEqual(headers["content-type"], "video/mp2t")
        self.assertEqual(headers["content-length"], "1000")

    def test_range_requests_are_forwarded(self):
        self.proxy(self.origin.url("/seg0.ts"), headers={"Range": "bytes=0-9"})
        self.assertEqual(self.origin.requests[-1][1]["range"], "bytes=0-9")

    def test_playlist_detected_by_content_even_with_a_wrong_type(self):
        _status, headers, body = self.proxy(self.origin.url("/plain"))
        self.assertEqual(headers["content-type"], "application/vnd.apple.mpegurl")
        self.assertIn(b"/proxy?u=", body)

    def test_redirects_are_followed(self):
        status, _, body = self.proxy(self.origin.url("/go"))
        self.assertEqual(status, 200)
        self.assertIn(b"/proxy?u=", body)

    def test_hosts_outside_the_lists_are_refused(self):
        status, _, body = self.proxy("http://other.example/live.m3u8")
        self.assertEqual(status, 403)
        self.assertIn("fuera de las listas", json.loads(body)["error"])

    def test_bad_requests(self):
        self.assertEqual(self.request("GET", "/proxy")[0], 400)
        self.assertEqual(self.request("GET", "/proxy?u=" + "a" * 5000)[0], 400)
        self.assertEqual(self.proxy("file:///etc/passwd")[0], 403)
        self.assertEqual(self.proxy("javascript:alert(1)")[0], 403)

    def test_private_addresses_are_refused_in_strict_mode(self):
        self.app.net.allow_private = False
        status, _, body = self.proxy(self.origin.url("/live.m3u8"))
        self.assertEqual(status, 403)
        self.assertIn("no pública", json.loads(body)["error"])

    def test_origin_errors_keep_their_status(self):
        self.assertEqual(self.proxy(self.origin.url("/missing"))[0], 404)
        self.origin.routes["/forbidden"] = (403, {}, b"no")
        self.assertEqual(self.proxy(self.origin.url("/forbidden"))[0], 403)
        self.origin.routes["/boom"] = (500, {}, b"no")
        self.assertEqual(self.proxy(self.origin.url("/boom"))[0], 500)

    def test_unreachable_origin_is_a_bad_gateway(self):
        with mock.patch.object(self.app.net, "open", side_effect=urllib.error.URLError("refused")):
            status, _, body = self.proxy(self.origin.url("/live.m3u8"))
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body)["error"], "origen: URLError")

    def test_custom_channel_headers_travel_with_playlist_and_segments(self):
        def protected(handler):
            if handler.headers.get("Referer") != "https://www.atresplayer.com/directos/lasexta/":
                return 403, {}, b"forbidden"
            return 200, {"Content-Type": "application/vnd.apple.mpegurl"}, LIVE.encode()

        def protected_segment(handler):
            ok = handler.headers.get("Origin") == "https://www.atresplayer.com"
            return (200, {}, b"segment") if ok else (403, {}, b"forbidden")

        self.origin.routes["/lasexta.m3u8"] = protected
        self.origin.routes["/seg0.ts"] = protected_segment
        cid = self.app.store.add_custom(
            {
                "name": "La Sexta",
                "sources": [self.origin.url("/lasexta.m3u8")],
                "headers": {
                    "Origin": "https://www.atresplayer.com",
                    "Referer": "https://www.atresplayer.com/directos/lasexta/",
                },
            }
        )
        self.assertEqual(self.proxy(self.origin.url("/lasexta.m3u8"))[0], 403)
        status, _, body = self.proxy(self.origin.url("/lasexta.m3u8"), extra=f"&c={cid}")
        self.assertEqual(status, 200)
        self.assertIn(f"&c={cid}".encode(), body)  # segment URLs keep the channel tag
        self.assertEqual(self.proxy(self.origin.url("/seg0.ts"), extra=f"&c={cid}")[0], 200)
        self.assertEqual(self.proxy(self.origin.url("/seg0.ts"))[0], 403)
        self.assertEqual(self.proxy(self.origin.url("/seg0.ts"), extra="&c=unknown")[0], 403)

    def test_transcription_tap_receives_complete_segments_only_when_enabled(self):
        # The browser has the whole segment before the server thread has queued it, so the test waits for it.
        hub = self.app.transcriber
        with mock.patch.object(hub, "submit") as submit, mock.patch.object(hub, "_work"):
            self.proxy(self.origin.url("/seg0.ts"), extra="&s=abc")
            time.sleep(0.3)
            submit.assert_not_called()  # the session was never enabled
            hub.set_session("abc", True)
            self.proxy(self.origin.url("/seg0.ts"), extra="&s=abc")
            self.wait_until(lambda: submit.call_count == 1)
            self.assertEqual(len(submit.call_args.kwargs["data"]), 1000)
            self.proxy(self.origin.url("/seg0.ts"), extra="&s=abc", headers={"Range": "bytes=0-9"})
            time.sleep(0.3)
            self.assertEqual(submit.call_count, 1)  # partial responses are not transcribed (only status 200)

    @staticmethod
    def wait_until(condition, timeout=5.0):
        end = time.time() + timeout
        while time.time() < end and not condition():
            time.sleep(0.02)

    def test_playlist_session_tag_is_propagated(self):
        _, _, body = self.proxy(self.origin.url("/live.m3u8"), extra="&s=sess1")
        self.assertIn(b"&s=sess1", body)


class LogoTests(ServerCase):
    def setUp(self):
        super().setUp()
        self.origin.routes["/ok.png"] = (200, {}, PNG)
        self.origin.routes["/page.png"] = (200, {}, b"<html>not an image</html>")
        self.origin.routes["/big.png"] = (200, {}, PNG + b"x" * 1_100_000)
        for name in ("ok", "page", "big", "gone"):
            self.app.store.logo_urls.add(self.origin.url(f"/{name}.png"))

    def logo(self, name):
        from urllib.parse import quote

        return self.request("GET", f"/logo?u={quote(self.origin.url(f'/{name}.png'), safe='')}")

    def test_logo_is_fetched_cached_and_typed(self):
        status, headers, body = self.logo("ok")
        self.assertEqual((status, headers["content-type"], body), (200, "image/png", PNG))
        hits = len(self.origin.requests)
        self.logo("ok")
        self.assertEqual(len(self.origin.requests), hits)  # served from disk

    def test_a_burst_of_connections_is_not_refused(self):
        """A page asks for dozens of modules at once: the listening queue must hold them (it did not on Windows)."""
        import socket
        import threading

        from tdtlocal.server import TdtServer

        self.assertGreaterEqual(TdtServer.request_queue_size, 64)
        port = self.port
        refused = []

        def hit():
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=10) as conn:
                    conn.sendall(b"GET /api/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                    conn.recv(64)
            except OSError as exc:
                refused.append(exc)

        threads = [threading.Thread(target=hit) for _ in range(100)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(refused, [])

    def test_unknown_urls_are_not_fetched(self):
        status, _, _ = self.request("GET", "/logo?u=http%3A%2F%2F127.0.0.1%3A1%2Fx.png")
        self.assertEqual(status, 404)
        self.assertEqual(self.origin.requests, [])

    def test_non_images_and_big_files_are_rejected_and_remembered(self):
        for name in ("page", "big", "gone"):
            self.assertEqual(self.logo(name)[0], 404, msg=name)
        hits = len(self.origin.requests)
        self.logo("page")
        self.assertEqual(len(self.origin.requests), hits)  # failure marker: no retry for hours

    def test_sniff_image(self):
        from tdtlocal.logos import sniff_image

        self.assertEqual(sniff_image(PNG), ("image/png", ".png"))
        self.assertEqual(sniff_image(b"\xff\xd8\xff\xe0abc"), ("image/jpeg", ".jpg"))
        self.assertEqual(sniff_image(b"GIF89a"), ("image/gif", ".gif"))
        self.assertEqual(sniff_image(b"RIFF\x00\x00\x00\x00WEBPVP8 "), ("image/webp", ".webp"))
        self.assertIsNone(sniff_image(b"<svg onload=alert(1)>"))


class StaticAssetsExistTests(ServerCase):
    def test_every_script_and_style_referenced_by_index_is_served(self):
        import re

        _, _, html = self.request("GET", "/")
        refs = re.findall(r'(?:src|href)="(/[^"]+)"', html.decode())
        self.assertTrue(refs)
        for ref in refs:
            if ref.startswith("//"):
                continue
            self.assertEqual(self.request("GET", ref)[0], 200, msg=ref)

    def test_package_ships_its_static_directory(self):
        self.assertTrue((PACKAGE_DIR / "static" / "index.html").is_file())
