"""scripts/tdtv.py: fuzzy channel search, the guide, the mpv IPC and the teletext commands (against fake servers)."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from tdtlocal.config import PROJECT_DIR
from tests.helpers import FakeOrigin

spec = importlib.util.spec_from_file_location("tdtv", PROJECT_DIR / "scripts" / "tdtv.py")
tdtv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tdtv)

CHANNELS = [
    {"id": "la-1", "name": "La 1", "kind": "tv", "category": "Nacionales"},
    {"id": "la-2", "name": "La 2", "kind": "tv", "category": "Nacionales"},
    {"id": "antena-3", "name": "Antena 3", "kind": "tv", "category": "Nacionales"},
    {"id": "antena-aragon", "name": "Antena Aragón", "kind": "tv", "category": "Autonómicos"},
    {"id": "radio-5", "name": "Radio 5", "kind": "radio", "category": "Nacionales"},
    {"id": "la-1-radio", "name": "La 1 FM", "kind": "radio", "category": "Nacionales"},
]


def run(argv: list[str]) -> tuple[int, str, str]:
    """Run the command line; returns ``(exit code, stdout, stderr)``."""
    stdout, stderr = io.StringIO(), io.StringIO()
    code = 0
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            tdtv.main(argv)
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
    return code, stdout.getvalue(), stderr.getvalue()


class Search(unittest.TestCase):
    def names(self, query, kind=None):
        return [c["name"] for c in tdtv.find(CHANNELS, query, kind)]

    def test_norm(self):
        self.assertEqual(tdtv.norm("La 1"), tdtv.norm("la-1"))
        self.assertEqual(tdtv.norm("Antena Aragón"), "antenaaragon")

    def test_exact_name_or_id_wins(self):
        self.assertEqual(self.names("la1"), ["La 1"])
        self.assertEqual(self.names("antena-3"), ["Antena 3"])

    def test_then_prefix_then_contains(self):
        self.assertEqual(self.names("antena"), ["Antena 3", "Antena Aragón"])
        self.assertEqual(self.names("aragon"), ["Antena Aragón"])

    def test_television_first_unless_asked_for_radio(self):
        self.assertEqual(self.names("radio 5"), ["Radio 5"])  # nothing on TV: the radio is used
        self.assertEqual(self.names("la 1"), ["La 1"])  # the television wins over "La 1 FM"
        self.assertEqual(self.names("la 1", "radio"), ["La 1 FM"])
        self.assertEqual(self.names("zzz"), [])


class Pieces(unittest.TestCase):
    def test_lavfi_protects_commas_and_colons(self):
        self.assertEqual(tdtv.lavfi("a=1:2,b"), "lavfi=graph=%7%a=1:2,b")

    def test_fx_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "fx.json").write_text(
                json.dumps({"a": {"shader": "a.glsl", "af": "lowpass=f=3000"}, "b": {"shader": "b.glsl", "af": ""}}),
                encoding="utf-8",
            )
            with mock.patch.object(tdtv, "FX_DIR", Path(tmp)):
                shaders, audio = tdtv.fx_plan(["a", "b", "nope"])
        self.assertEqual([Path(s).name for s in shaders], ["a.glsl", "b.glsl"])
        self.assertEqual(audio, "lowpass=f=3000")

    def test_epg_now_picks_the_current_and_the_next_programme(self):
        now = time.time()
        guide = {"now": {"X": [[now - 60, now + 60, "Ahora", "", ""], [now + 60, now + 120, "Luego"]]}}
        with mock.patch.object(tdtv, "get", return_value=guide):
            result = tdtv.epg_now()["X"]
        self.assertEqual((result["now"]["title"], result["next"]["title"]), ("Ahora", "Luego"))


@unittest.skipUnless(hasattr(socket, "AF_UNIX"), "needs unix sockets")
class MpvIpc(unittest.TestCase):
    """A fake mpv: it sends an event first, as the real one does, then the answer."""

    def serve(self, answer: dict):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        path = Path(self.tmp.name, "m.sock")
        server = socket.socket(socket.AF_UNIX)
        server.bind(str(path))
        server.listen(1)
        self.addCleanup(server.close)
        self.received: list[dict] = []

        def handle():
            conn, _ = server.accept()
            with conn:
                self.received.append(json.loads(conn.recv(4096)))
                conn.sendall(b'{"event":"property-change"}\n' + json.dumps(answer).encode() + b"\n")

        threading.Thread(target=handle, daemon=True).start()
        return path

    def test_returns_the_data_of_the_answer(self):
        path = self.serve({"error": "success", "data": 42.5})
        self.assertEqual(tdtv.mpv(["get_property", "volume"], path), 42.5)
        self.assertEqual(self.received, [{"command": ["get_property", "volume"]}])

    def test_an_error_answer_is_none(self):
        self.assertIsNone(tdtv.mpv(["get_property", "nope"], self.serve({"error": "property not found"})))

    def test_nothing_listening_is_none(self):
        self.assertIsNone(tdtv.mpv(["get_property", "pid"], Path(tempfile.gettempdir(), "no-such-mpv.sock")))


class Teletext(unittest.TestCase):
    def setUp(self):
        self.origin = FakeOrigin()
        self.addCleanup(self.origin.close)
        patcher = mock.patch.object(tdtv, "BASE", self.origin.url("").rstrip("/"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_reads_a_page_as_text(self):
        body = json.dumps({"page": "400", "subpages": [["", "  EL TIEMPO", "  Madrid 8"]], "updated": 1}).encode()
        self.origin.routes["/api/teletext/page"] = (200, {"Content-Type": "application/json"}, body)
        code, stdout, _ = run(["ttx", "400", "--text"])
        self.assertEqual(code, 0)
        self.assertIn("Teletexto 400", stdout)
        self.assertIn("Madrid 8", stdout)
        code, stdout, _ = run(["ttx", "400", "--json"])
        self.assertEqual(json.loads(stdout)["rows"][1], "  EL TIEMPO")

    def test_off_or_unknown_pages_explain_themselves(self):
        self.origin.routes["/api/teletext/page"] = (404, {"Content-Type": "application/json"}, b'{"pages": []}')
        code, _, stderr = run(["ttx", "100", "--text"])
        self.assertEqual(code, 2)
        self.assertIn("no está activado", stderr)
        self.origin.routes["/api/teletext/page"] = (404, {"Content-Type": "application/json"}, b'{"pages": ["100"]}')
        code, _, stderr = run(["ttx", "999", "--text"])
        self.assertEqual(code, 2)
        code, _, stderr = run(["ttx", "250", "--text"])
        self.assertIn("hay: 100", stderr)

    def test_a_bad_page_number(self):
        self.assertEqual(run(["ttx", "42", "--text"])[0], 2)


class Play(unittest.TestCase):
    def test_nothing_playing(self):
        with mock.patch.object(tdtv, "alive", return_value=False):
            code, stdout, _ = run(["status", "--json"])
            self.assertEqual((code, json.loads(stdout)), (0, {"playing": False}))
            self.assertEqual(run(["pause"])[0], 1)

    def test_ambiguous_names_exit_with_3(self):
        with (
            mock.patch.object(tdtv, "channels", return_value=CHANNELS),
            mock.patch.object(tdtv.shutil, "which", return_value="/usr/bin/mpv"),
        ):
            code, stdout, _ = run(["play", "antena", "--json"])
        self.assertEqual(code, 3)
        self.assertEqual(json.loads(stdout)["ambiguous"], ["Antena 3", "Antena Aragón"])

    def test_unknown_channel_exits_with_2(self):
        with (
            mock.patch.object(tdtv, "channels", return_value=CHANNELS),
            mock.patch.object(tdtv.shutil, "which", return_value="/usr/bin/mpv"),
        ):
            self.assertEqual(run(["play", "canal inexistente"])[0], 2)


if __name__ == "__main__":
    unittest.main()
