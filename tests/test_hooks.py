"""The hooks of the server and the loader of the plugins with all the power (tdtlocal/hooks.py, tdtlocal/trusted.py)."""

from __future__ import annotations

import logging
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from tdtlocal.config import Config
from tdtlocal.hooks import Hooks
from tdtlocal.net import Net
from tdtlocal.scte_watch import ScteWatcher
from tdtlocal.store import Store
from tdtlocal.trusted import Loader


def make() -> tuple[Hooks, list[tuple[str, str]]]:
    errors: list[tuple[str, str]] = []
    return Hooks(on_error=lambda name, error: errors.append((name, str(error)))), errors


class HooksTests(unittest.TestCase):
    def test_actions_are_heard_by_priority_then_by_arrival(self) -> None:
        hooks, _ = make()
        heard: list[str] = []
        hooks.on("ad.marker", lambda d: heard.append("b"), 20)
        hooks.on("ad.marker", lambda d: heard.append("a1"), 5)
        hooks.on("ad.marker", lambda d: heard.append("a2"), 5)
        hooks.on("ad.marker", lambda d: heard.append("default"))
        hooks.do("ad.marker", {"channel": "la-1"})
        self.assertEqual(heard, ["a1", "a2", "default", "b"])

    def test_stopping_an_action_and_a_listener_that_raises(self) -> None:
        hooks, errors = make()
        heard: list[int] = []
        off = hooks.on("x", lambda d: heard.append(1))

        def boom(data: Any) -> None:
            raise ValueError("malo")

        hooks.on("x", boom)
        hooks.on("x", lambda d: heard.append(3), 50)
        hooks.do("x")
        off()
        hooks.do("x")
        self.assertEqual(heard, [1, 3, 3])
        self.assertEqual(errors, [("x", "malo"), ("x", "malo")])

    def test_a_filter_passes_the_value_through_the_chain(self) -> None:
        hooks, errors = make()
        hooks.filter("v", lambda v, c: [*v, "late"], 30)
        hooks.filter("v", lambda v, c: [*v, "first"], 1)
        hooks.filter("v", lambda v, c: None)  # nothing: leaves it as it is

        def boom(v: Any, c: Any) -> Any:
            raise ValueError("roto")

        hooks.filter("v", boom)
        hooks.filter("v", lambda v, c: [*v, c["channel"]])
        self.assertEqual(hooks.apply("v", [], {"channel": "la-1"}), ["first", "la-1", "late"])
        self.assertEqual(errors, [("v", "roto")])
        self.assertEqual(hooks.apply("nobody", 7), 7)
        self.assertEqual(hooks.chains(), [{"name": "v", "links": 5}])

    def test_a_registry_uses_the_lowest_number_and_gives_back_what_was_there(self) -> None:
        hooks, _ = make()
        off_core = hooks.register("sources", "hls", {"who": "core"})
        off_mine = hooks.register("sources", "hls", {"who": "mine"})  # same priority: the last one
        hooks.register("sources", "hls", {"who": "late"}, 99)
        self.assertEqual(hooks.get("sources", "hls")["who"], "mine")
        off_first = hooks.register("sources", "hls", {"who": "first"}, 1)
        self.assertEqual(hooks.get("sources", "hls")["who"], "first")
        off_first()
        off_mine()
        self.assertEqual(hooks.get("sources", "hls")["who"], "core")
        off_core()
        self.assertEqual(hooks.get("sources", "hls")["who"], "late")
        self.assertIsNone(hooks.get("sources", "no"))
        self.assertEqual([(i, e["who"]) for i, e in hooks.list("sources")], [("hls", "late")])
        self.assertEqual(hooks.list("nothing"), [])

    def test_a_link_has_to_be_a_function(self) -> None:
        hooks, _ = make()
        with self.assertRaises(TypeError):
            hooks.on("x", "no es una función")  # type: ignore[arg-type]


class LoaderTests(unittest.TestCase):
    def test_taking_a_plugin_away_removes_everything_it_added(self) -> None:
        hooks, _ = make()
        loader = Loader(hooks)
        heard: list[str] = []

        def setup(tdt: Any) -> Any:
            self.assertEqual(tdt.id, "mine")
            tdt.on("a", lambda d: heard.append("a"))
            tdt.filter("f", lambda v, c: v + 1)
            tdt.register("actions", "beep", {"run": lambda: "beep"})
            return lambda: heard.append("cleanup")

        self.assertTrue(loader.load("mine", setup))
        hooks.do("a")
        self.assertEqual(hooks.apply("f", 1), 2)
        self.assertEqual(hooks.get("actions", "beep")["run"](), "beep")
        self.assertTrue(loader.unload("mine"))
        hooks.do("a")
        self.assertEqual(hooks.apply("f", 1), 1)
        self.assertIsNone(hooks.get("actions", "beep"))
        self.assertEqual(heard, ["a", "cleanup"])
        self.assertEqual(loader.list(), [{"id": "mine", "state": "off", "errors": 0, "error": ""}])
        self.assertFalse(loader.unload("mine"))

    def test_a_plugin_that_replaces_a_thing_gives_it_back_when_it_goes(self) -> None:
        hooks, _ = make()
        loader = Loader(hooks)
        hooks.register("actions", "beep", {"run": lambda: "core"})
        loader.load("mine", lambda tdt: tdt.register("actions", "beep", {"run": lambda: "mine"}))
        self.assertEqual(hooks.get("actions", "beep")["run"](), "mine")
        loader.unload("mine")
        self.assertEqual(hooks.get("actions", "beep")["run"](), "core")

    def test_the_mistakes_of_a_plugin_stay_with_it_and_five_switch_it_off(self) -> None:
        hooks, _ = make()
        loader = Loader(hooks)

        def bad(tdt: Any) -> None:
            def broken(v: Any, c: Any) -> Any:
                raise ValueError("mal")

            def boom() -> None:
                raise ValueError("mal también")

            tdt.filter("f", broken)
            tdt.register("actions", "boom", {"run": boom})

        loader.load("bad", bad)
        loader.load("good", lambda tdt: tdt.filter("f", lambda v, c: v * 2))
        with self.assertLogs("tdtlocal.trusted", level=logging.WARNING) as logged:
            for _ in range(3):
                self.assertEqual(hooks.apply("f", 1), 2)
            self.assertIsNone(hooks.get("actions", "boom")["run"]())
            state = {p["id"]: p for p in loader.list()}
            self.assertEqual(state["bad"]["state"], "on")
            hooks.get("actions", "boom")["run"]()
        self.assertEqual({p["id"]: p["state"] for p in loader.list()}, {"bad": "failed", "good": "on"})
        self.assertIsNone(hooks.get("actions", "boom"))
        self.assertEqual(hooks.apply("f", 1), 2)
        self.assertTrue(any("se apaga tras 5 fallos" in line for line in logged.output))

    def test_a_plugin_that_fails_to_start_leaves_nothing_behind(self) -> None:
        hooks, _ = make()
        loader = Loader(hooks)

        def setup(tdt: Any) -> None:
            tdt.filter("f", lambda v, c: v + 100)
            raise RuntimeError("no arranca")

        with self.assertLogs("tdtlocal.trusted", level=logging.WARNING):
            self.assertFalse(loader.load("broken", setup))
        self.assertEqual(hooks.apply("f", 1), 1)
        self.assertEqual(
            [(p["id"], p["state"], p["error"]) for p in loader.list()],
            [("broken", "failed", "al arrancar: no arranca")],
        )
        self.assertTrue(loader.load("broken", lambda tdt: None))

    def test_a_plugin_is_loaded_from_a_python_file(self) -> None:
        hooks, _ = make()
        loader = Loader(hooks)
        with TemporaryDirectory() as tmp:
            good = Path(tmp) / "server.py"
            good.write_text("def setup(tdt):\n    tdt.filter('f', lambda v, c: v + 10)\n", encoding="utf8")
            broken = Path(tmp) / "broken.py"
            broken.write_text("def setup(tdt:\n", encoding="utf8")
            nothing = Path(tmp) / "nothing.py"
            nothing.write_text("X = 1\n", encoding="utf8")
            self.assertTrue(loader.load_file("fromfile", good))
            self.assertEqual(hooks.apply("f", 1), 11)
            with self.assertLogs("tdtlocal.trusted", level=logging.WARNING):
                self.assertFalse(loader.load_file("broken", broken))
                self.assertFalse(loader.load_file("nothing", nothing))
        states = {p["id"]: p["state"] for p in loader.list()}
        self.assertEqual(states, {"fromfile": "on", "broken": "failed", "nothing": "failed"})


class MarkerHookTests(unittest.TestCase):
    def test_a_marker_that_is_found_is_told_as_an_action(self) -> None:
        hooks, _ = make()
        heard: list[dict[str, Any]] = []
        hooks.on("ad.marker", heard.append)
        with TemporaryDirectory() as tmp:
            config = Config(data_dir=Path(tmp))
            net = Net()
            watcher = ScteWatcher(config, Store(config, net), net, path=Path(tmp) / "scte.jsonl", hooks=hooks)
            marker = {"kind": "cue-out", "ident": "1", "detail": "30 s", "raw": "#EXT-X-CUE-OUT:30", "duration": 30}
            found = watcher._record(("la-1", "La 1"), [marker], "playlist", "https://example.test/a.m3u8")
        self.assertEqual(found, 1)
        self.assertEqual(len(heard), 1)
        self.assertEqual((heard[0]["channel"], heard[0]["name"], heard[0]["kind"]), ("la-1", "La 1", "cue-out"))
        self.assertEqual(heard[0]["duration"], 30)
        self.assertIn("id", heard[0])


if __name__ == "__main__":
    unittest.main()
