import socket
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from tdtlocal import __version__, desktop
from tdtlocal.config import PROJECT_DIR, Config
from tdtlocal.paths import default_data_dir, default_models_dir, is_source_checkout, user_data_dir

from .helpers import ServerCase


class PathsTests(unittest.TestCase):
    home = Path("/home/ana")

    def test_user_data_dir_per_platform(self):
        win = user_data_dir("win32", {"LOCALAPPDATA": "C:/Users/Ana/AppData/Local"}, self.home)
        self.assertEqual(win, Path("C:/Users/Ana/AppData/Local") / "TDT local")
        self.assertEqual(user_data_dir("win32", {}, self.home), self.home / "AppData" / "Local" / "TDT local")
        self.assertEqual(
            user_data_dir("darwin", {}, self.home), self.home / "Library" / "Application Support" / "TDT local"
        )
        self.assertEqual(user_data_dir("linux", {}, self.home), self.home / ".local" / "share" / "tdt-local")
        self.assertEqual(user_data_dir("linux", {"XDG_DATA_HOME": "/x"}, self.home), Path("/x") / "tdt-local")

    def test_a_source_checkout_keeps_data_next_to_the_code(self):
        self.assertTrue(is_source_checkout(PROJECT_DIR))
        self.assertEqual(default_data_dir(PROJECT_DIR), PROJECT_DIR / "data")
        self.assertEqual(default_models_dir(PROJECT_DIR), PROJECT_DIR / "models")

    def test_an_installed_copy_uses_the_user_directory(self):
        elsewhere = Path("/usr/lib/python3/site-packages")  # no pyproject.toml there
        self.assertFalse(is_source_checkout(elsewhere))
        self.assertEqual(default_data_dir(elsewhere), user_data_dir())
        self.assertEqual(default_models_dir(elsewhere), user_data_dir() / "models")

    def test_a_frozen_app_is_never_a_checkout(self):
        with mock.patch("sys.frozen", True, create=True):
            self.assertFalse(is_source_checkout(PROJECT_DIR))


class DesktopTests(ServerCase):
    def test_version_endpoint_identifies_the_server(self):
        status, data = self.get_json("/api/version")
        self.assertEqual((status, data), (200, {"version": __version__, "name": "tdt-local"}))

    def test_running_instance_detection(self):
        self.assertTrue(desktop.running_instance(self.port))
        self.origin.routes["/api/version"] = (200, {}, b'{"name": "otra-cosa"}')
        self.assertFalse(desktop.running_instance(self.origin.httpd.server_address[1]))
        self.origin.routes["/api/version"] = (200, {}, b"not json")
        self.assertFalse(desktop.running_instance(self.origin.httpd.server_address[1]))

    def test_port_is_free(self):
        self.assertFalse(desktop.port_is_free(self.port))
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            free = s.getsockname()[1]
        self.assertTrue(desktop.port_is_free(free))

    def test_quit_is_disabled_by_default(self):
        status, _ = self.post_json("/api/quit")
        self.assertEqual(status, 404)
        _, data = self.get_json("/api/channels")
        self.assertFalse(data["meta"]["quit"])
        self.assertEqual(data["meta"]["version"], __version__)

    def test_quit_stops_the_server_when_enabled(self):
        self.app.config.allow_quit = True
        stopped = threading.Event()
        original = self.httpd.shutdown

        def shutdown():
            original()
            stopped.set()

        with mock.patch.object(self.httpd, "shutdown", shutdown):
            status, data = self.post_json("/api/quit")
        self.assertEqual((status, data), (200, {"ok": True}))
        self.assertTrue(stopped.wait(5))

    def test_quit_still_requires_a_same_origin_request(self):
        self.app.config.allow_quit = True
        status, _ = self.post_json("/api/quit", headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.post_json("/api/quit", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)

    def test_desktop_main_shows_an_existing_instance_instead_of_starting_another(self):
        with (
            mock.patch.object(desktop, "running_instance", return_value=True),
            mock.patch.object(desktop, "run") as run,
            mock.patch.object(desktop, "configure_logging"),
            mock.patch.object(desktop.webbrowser, "open") as browser,
            mock.patch.object(desktop, "Config", return_value=Config(data_dir=self.tmp)),
        ):
            desktop.main()
        run.assert_not_called()
        browser.assert_called_once()

    def test_desktop_main_picks_another_port_when_the_default_is_taken(self):
        config = Config(data_dir=self.tmp, port=self.port)
        with (
            mock.patch.object(desktop, "running_instance", return_value=False),
            mock.patch.object(desktop, "run") as run,
            mock.patch.object(desktop, "configure_logging"),
            mock.patch.object(desktop, "Config", return_value=config) as make_config,
        ):
            desktop.main()
        self.assertEqual(config.port, 0)
        run.assert_called_once_with(config, open_browser=True)
        make_config.assert_called_once_with(allow_quit=True)  # the app has no console: it needs the Salir button


class CreditsTests(ServerCase):
    """The Apache-2.0 licence asks for attribution: it must be in the repository and visible to users."""

    def test_notice_and_about_page_name_what_we_are_based_on(self):
        notice = (PROJECT_DIR / "NOTICE").read_text(encoding="utf-8")
        _, _, about = self.request("GET", "/about.html")
        for text in (notice, about.decode("utf-8")):
            for name in ("TDTChannels", "hls.js", "Shaka Player", "dobleM", "Apache"):
                self.assertIn(name, text)

    def test_licence_is_apache_2(self):
        licence = (PROJECT_DIR / "LICENSE").read_text(encoding="utf-8")
        self.assertIn("Apache License", licence)
        self.assertIn("Version 2.0, January 2004", licence)
        self.assertIn('license = "Apache-2.0"', (PROJECT_DIR / "pyproject.toml").read_text(encoding="utf-8"))

    def test_the_vendored_library_ships_with_its_licence(self):
        vendor = PROJECT_DIR / "tdtlocal" / "static" / "vendor"
        for licence in ("hls.js-LICENSE.txt", "shaka-player-LICENSE.txt"):
            self.assertIn("Apache License", (vendor / licence).read_text(encoding="utf-8"))

    def test_main_page_links_to_the_credits(self):
        _, _, html = self.request("GET", "/")
        self.assertIn(b'href="/about.html"', html)
        self.assertEqual(self.request("GET", "/icon.svg")[0], 200)
        self.assertEqual(self.request("GET", "/js/about.js")[0], 200)


if __name__ == "__main__":
    time.sleep(0)
    unittest.main()
