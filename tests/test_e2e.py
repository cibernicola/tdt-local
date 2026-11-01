"""End to end: the real command (``python -m tdtlocal``) against a fake list server."""

import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tdtlocal.config import PROJECT_DIR

from .helpers import FakeOrigin, ServerProcess, fixture, make_tv_markdown


class CommandLineTests(unittest.TestCase):
    def test_server_starts_downloads_the_lists_and_stops_cleanly(self):
        origin = FakeOrigin()
        self.addCleanup(origin.close)
        radio = fixture("RADIO.md") + "\n".join(
            f"| R{i} | [mp3](https://r.example/{i}.mp3) | - | - | - | - |" for i in range(40)
        )
        origin.routes["/TELEVISION.md"] = (200, {}, make_tv_markdown(60).encode())
        origin.routes["/RADIO.md"] = (200, {}, radio.encode())
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        server = ServerProcess(
            self,
            tmp.name,
            "--no-epg",
            "--no-ai",
            "--no-stt",
            "--source",
            origin.url("/TELEVISION.md"),
            "--radio-source",
            origin.url("/RADIO.md"),
        )

        data = server.get_json_when("/api/channels", lambda d: len(d["channels"]) >= 102)  # TV, then radio
        self.assertEqual(len([c for c in data["channels"] if c["kind"] == "tv"]), 66)  # 60 listed + Atresmedia's 6
        self.assertEqual(len([c for c in data["channels"] if c["kind"] == "radio"]), 42)
        self.assertFalse(data["meta"]["ai"])
        self.assertFalse(data["meta"]["stt"])
        self.assertEqual(server.get("/")[0], 200)
        self.assertTrue((Path(tmp.name) / "tv.json").exists())  # the cache for the next start

        server.proc.terminate()
        try:
            server.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.fail("the server did not stop after SIGTERM")

    def test_a_busy_port_is_reported_instead_of_a_traceback(self):
        with socket.socket() as taken:
            taken.bind(("127.0.0.1", 0))
            taken.listen()
            port = taken.getsockname()[1]
            tmp = tempfile.TemporaryDirectory()
            self.addCleanup(tmp.cleanup)
            result = subprocess.run(
                [sys.executable, "-m", "tdtlocal", "--port", str(port), "--data-dir", tmp.name, "--no-epg"],
                cwd=PROJECT_DIR,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--port", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
