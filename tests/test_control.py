"""The control bus: what a client may ask, the token, the levels, and the round trip of a command through the page."""

from __future__ import annotations

import http.client
import json
import queue
import threading
import time
import unittest
from typing import Any

from tdtlocal import control
from tdtlocal.config import Config
from tdtlocal.control import COMMAND_TIMEOUTS, ControlBus, ControlError, clean_command, clean_state, command_level
from tdtlocal.control_routes import _client

from .helpers import AppCase, ServerCase


def bus_in(tmp_path: Any, **values: Any) -> ControlBus:
    return ControlBus(Config(data_dir=tmp_path, **values))


class StateTests(unittest.TestCase):
    def test_anything_that_is_not_an_object_is_refused(self) -> None:
        for raw in (None, [], "x", 5, True):
            self.assertIsNone(clean_state(raw))

    def test_unknown_or_wrong_values_fall_back_to_safe_ones(self) -> None:
        state = clean_state(
            {
                "kind": "satélite",
                "mode": 5,
                "layout": None,
                "focus": 99,
                "vol": {"v": float("nan"), "m": "yes"},
                "rot": {"on": 1, "secs": -4},
                "tiles": "no",
                "extra": "ignored",
            }
        )
        assert state is not None
        self.assertEqual(
            state,
            {
                "kind": "tv",
                "mode": "single",
                "layout": "mosaic",
                "focus": 3,
                "vol": {"v": 1, "m": False},
                "rot": {"on": False, "secs": 5},
                "tiles": [],
                "u7d": None,
            },
        )

    def test_a_good_snapshot_is_kept_and_text_and_tiles_are_bounded(self) -> None:
        tiles = [{"slot": i, "id": "x" * 500, "name": "N" * 500, "kind": "radio"} for i in range(10)] + ["junk", 3]
        state = clean_state(
            {
                "kind": "radio",
                "mode": "multi",
                "layout": "focus",
                "focus": 2,
                "vol": {"v": 0.456789, "m": True},
                "rot": {"on": True, "secs": 30},
                "tiles": tiles,
                "u7d": {"channel": "La 1"},
            }
        )
        assert state is not None
        self.assertEqual(
            (state["kind"], state["mode"], state["layout"], state["focus"]), ("radio", "multi", "focus", 2)
        )
        self.assertEqual(state["vol"], {"v": 0.457, "m": True})
        self.assertEqual(len(state["tiles"]), control.MAX_TILES)
        self.assertEqual(len(state["tiles"][0]["id"]), control.MAX_ID)
        self.assertEqual(len(state["tiles"][0]["name"]), control.MAX_NAME)
        self.assertEqual(state["u7d"], {"channel": "La 1"})


class CommandValidationTests(unittest.TestCase):
    def test_each_command_is_reduced_to_its_known_fields(self) -> None:
        self.assertEqual(clean_command({"do": "play", "channel": "  La 2 ", "x": 1}), {"do": "play", "channel": "La 2"})
        self.assertEqual(clean_command({"do": "kind", "kind": "radio"}), {"do": "kind", "kind": "radio"})
        self.assertEqual(clean_command({"do": "volume", "value": 0.5}), {"do": "volume", "value": 0.5})
        self.assertEqual(clean_command({"do": "volume", "value": 1}), {"do": "volume", "value": 1.0})
        self.assertEqual(clean_command({"do": "mute", "on": True}), {"do": "mute", "on": True})
        self.assertEqual(
            clean_command({"do": "multi", "channels": ["La 1", "La 2"], "rotate": 30}),
            {"do": "multi", "channels": ["La 1", "La 2"], "rotate": 30},
        )
        self.assertEqual(clean_command({"do": "multi", "channels": ["La 1"]})["rotate"], None)

    def test_what_is_not_on_the_list_or_is_malformed_is_refused_with_a_reason(self) -> None:
        bad: list[Any] = [
            None,
            [],
            "play",
            {},
            {"do": "quit"},
            {"do": "settings", "x": 1},
            {"do": "play"},
            {"do": "play", "channel": ""},
            {"do": "play", "channel": 5},
            {"do": "kind", "kind": "vhs"},
            {"do": "volume", "value": 2},
            {"do": "volume", "value": "high"},
            {"do": "volume", "value": True},
            {"do": "mute", "on": "yes"},
            {"do": "multi", "channels": []},
            {"do": "multi", "channels": ["a"] * 5},
            {"do": "multi", "channels": ["a", ""]},
            {"do": "multi", "channels": ["a"], "rotate": 1},
            {"do": "multi", "channels": ["a"], "rotate": 2.5},
        ]
        for raw in bad:
            with self.assertRaises(ControlError, msg=repr(raw)) as ctx:
                clean_command(raw)
            self.assertEqual(ctx.exception.code, 400)
            self.assertTrue(str(ctx.exception))


class TokenAndLevelTests(AppCase):
    def test_the_token_is_made_once_kept_in_a_file_and_replaced_on_request(self) -> None:
        bus = bus_in(self.tmp / "data")
        token = bus.token()
        self.assertGreaterEqual(len(token), 32)
        self.assertEqual(bus.token(), token)
        self.assertEqual((self.tmp / "data" / control.TOKEN_FILE).read_text("ascii").strip(), token)
        self.assertEqual(bus_in(self.tmp / "data").token(), token)  # a new run finds the same one
        new = bus.regenerate()
        self.assertNotEqual(new, token)
        self.assertFalse(bus.check("Bearer " + token))
        self.assertTrue(bus.check("Bearer " + new))
        self.assertEqual(bus_in(self.tmp / "data").token(), new)

    def test_a_broken_token_file_is_replaced(self) -> None:
        folder = self.tmp / "data"
        folder.mkdir()
        (folder / control.TOKEN_FILE).write_text("short")
        self.assertGreaterEqual(len(bus_in(folder).token()), 32)

    def test_only_the_exact_bearer_token_passes(self) -> None:
        bus = bus_in(self.tmp / "data")
        token = bus.token()
        self.assertTrue(bus.check(f"Bearer {token}"))
        for header in (
            None,
            "",
            token,
            f"bearer {token}",
            f"Basic {token}",
            f"Bearer {token}x",
            f"Bearer {token[:-1]}",
            "Bearer ",
            "Bearer é",
        ):
            self.assertFalse(bus.check(header), header)

    def test_levels_off_read_control(self) -> None:
        folder = self.tmp / "data"
        off = bus_in(folder)
        self.assertFalse(off.allows("read") or off.allows("control"))
        read = bus_in(folder, control_enabled=True)
        self.assertTrue(read.allows("read"))
        self.assertFalse(read.allows("control"))
        both = bus_in(folder, control_enabled=True, control_level="control")
        self.assertTrue(both.allows("read") and both.allows("control"))
        self.assertFalse(both.allows("admin"))  # there is no such level yet


class DevCommandTests(AppCase):
    """The commands about development plugins: what they may name and send, who may send them, and what comes back."""

    def make_bus(self, level: str = "dev") -> ControlBus:
        return bus_in(self.tmp / "data", control_enabled=True, control_level=level)

    def test_the_levels_include_the_ones_below(self) -> None:
        for level, expected in (
            ("read", (True, False, False)),
            ("control", (True, True, False)),
            ("dev", (True, True, True)),
        ):
            bus = self.make_bus(level)
            self.assertEqual((bus.allows("read"), bus.allows("control"), bus.allows("dev")), expected, level)
        self.assertFalse(self.make_bus("admin").allows("control"))  # a level that does not exist is the lowest one

    def test_each_command_is_reduced_to_its_known_fields(self) -> None:
        self.assertEqual(clean_command({"do": "dev_list", "x": 1}), {"do": "dev_list"})
        self.assertEqual(clean_command({"do": "dev_read", "id": "mi-plugin"}), {"do": "dev_read", "id": "mi-plugin"})
        self.assertEqual(clean_command({"do": "dev_activate", "id": "a.b_c"}), {"do": "dev_activate", "id": "a.b_c"})
        self.assertEqual(clean_command({"do": "dev_logs", "id": "x"}), {"do": "dev_logs", "id": "x", "limit": 50})
        self.assertEqual(clean_command({"do": "dev_logs", "id": "x", "limit": 7})["limit"], 7)
        written = clean_command(
            {"do": "dev_write", "id": "x", "files": {"page.js": "1", "old/a.json": None, "m.mjs": ""}}
        )
        self.assertEqual(
            written,
            {
                "do": "dev_write",
                "id": "x",
                "files": {"page.js": "1", "old/a.json": None, "m.mjs": ""},
                "dry_run": False,
            },
        )
        self.assertIs(
            clean_command({"do": "dev_write", "id": "x", "files": {"a.js": "1"}, "dry_run": True})["dry_run"], True
        )
        self.assertIs(
            clean_command({"do": "dev_write", "id": "x", "files": {"a.js": "1"}, "dry_run": "yes"})["dry_run"], False
        )

    def test_names_that_could_leave_the_folder_or_hide_are_refused(self) -> None:
        for bad_id in ("", "..", ".", ".oculto", "a/b", "a\\b", "../x", "con espacio", "ñu", "x" * 65, 5, None, ["a"]):
            with self.assertRaises(ControlError, msg=repr(bad_id)):
                clean_command({"do": "dev_read", "id": bad_id})
        for bad_name in (
            "..",
            "../x.js",
            "/etc/x.js",
            "a/../x.js",
            "a\\b.js",
            ".oculto.js",
            "a/.b.js",
            "a//b.js",
            "C:/x.js",
            "a/b/c/d.js",
            "sin_extension",
            "x.exe",
            "x.js.exe",
            "x" * 200 + ".js",
            "",
            5,
        ):
            with self.assertRaises(ControlError, msg=repr(bad_name)):
                clean_command({"do": "dev_write", "id": "x", "files": {bad_name: "1"}})

    def test_how_much_a_write_may_carry(self) -> None:
        for bad in (
            None,
            [],
            "x",
            {},
            {f"f{i}.js": "1" for i in range(13)},
            {"a.js": 5},
            {"a.js": ["x"]},
            {"a.js": "x" * 65_537},
            {f"f{i}.js": "x" * 60_000 for i in range(5)},
        ):
            with self.assertRaises(ControlError, msg=str(bad)[:40]):
                clean_command({"do": "dev_write", "id": "x", "files": bad})
        clean_command({"do": "dev_write", "id": "x", "files": {"a.js": "x" * 65_536}})  # exactly the limit
        clean_command(
            {"do": "dev_write", "id": "x", "files": {f"f{i}.js": "x" * 40_000 for i in range(6)}}
        )  # 240 KB: under the total
        with self.assertRaises(ControlError):
            clean_command({"do": "dev_logs", "id": "x", "limit": 0})
        with self.assertRaises(ControlError):
            clean_command({"do": "dev_logs", "id": "x", "limit": True})

    def test_a_dev_command_needs_the_dev_level_even_if_it_reaches_the_bus(self) -> None:
        bus = self.make_bus("control")
        FakePage(bus).start()
        for cmd in (
            {"do": "dev_list"},
            {"do": "dev_write", "id": "x", "files": {"a.js": "1"}},
            {"do": "dev_activate", "id": "x"},
        ):
            with self.assertRaises(ControlError) as ctx:
                bus.command(cmd)
            self.assertEqual(ctx.exception.code, 403)
            self.assertIn("dev", str(ctx.exception))
        bus.close()
        low = self.make_bus("read")
        with self.assertRaises(ControlError) as ctx:
            low.command({"do": "mute", "on": True})  # the bus itself also refuses a control command at the lowest level
        self.assertEqual(ctx.exception.code, 403)

    def test_what_the_page_sends_back_travels_as_data_and_is_bounded(self) -> None:
        bus = self.make_bus()
        FakePage(bus, data={"files": {"page.js": "x" * 100_000}}).start()
        result = bus.command({"do": "dev_read", "id": "x"})
        self.assertEqual(result["ok"], True)
        self.assertEqual(len(result["data"]["files"]["page.js"]), 100_000)
        bus.close()
        big = self.make_bus()
        FakePage(big, data={"x": "y" * 400_000}).start()
        refused = big.command({"do": "dev_read", "id": "x"})
        self.assertEqual(refused["ok"], False)
        self.assertNotIn("data", refused)
        self.assertIn("demasiado grande", refused["detail"])
        big.close()
        weird = self.make_bus()
        FakePage(weird, data={"x": {1, 2}}).start()
        self.assertEqual(weird.command({"do": "dev_read", "id": "x"})["ok"], False)
        weird.close()

    def test_a_write_waits_as_long_as_the_user_needs_but_a_read_does_not(self) -> None:
        self.assertGreaterEqual(control.COMMAND_TIMEOUTS["dev_write"], 120)
        self.assertGreaterEqual(control.COMMAND_TIMEOUTS["dev_activate"], 120)
        self.assertLessEqual(control.COMMAND_TIMEOUTS["dev_logs"], 30)
        self.assertLess(control.COMMAND_TIMEOUT, 10)

    def test_the_audit_trail_names_the_files_but_never_holds_their_code(self) -> None:
        bus = self.make_bus()
        FakePage(bus).start()
        bus.command({"do": "dev_write", "id": "p", "files": {"page.js": "SECRETO = 1", "b.js": None}})
        text = " ".join(entry["text"] for entry in bus.status()["audit"])
        self.assertIn("page.js", text)
        self.assertIn("b.js", text)
        self.assertNotIn("SECRETO", text)
        bus.close()


class FakePage(threading.Thread):
    """What the page does: listen for commands and answer each one."""

    def __init__(self, bus: ControlBus, ok: bool = True, answer: bool = True, data: Any = None) -> None:
        super().__init__(daemon=True)
        self.bus, self.ok, self.answer, self.data = bus, ok, answer, data
        self.sub = bus.subscribe()
        self.seen: list[dict[str, Any]] = []

    def run(self) -> None:
        while True:
            item = self.sub.get()
            if item is None:
                return
            self.seen.append(item)
            if self.answer:
                self.bus.report(item["id"], self.ok, "hecho" if self.ok else "no hay ese canal", self.data)


class BusFlowTests(AppCase):
    def make_bus(self, **values: Any) -> ControlBus:
        return bus_in(self.tmp / "data", control_enabled=True, control_level="control", **values)

    def test_a_command_without_a_page_connected_says_so(self) -> None:
        with self.assertRaises(ControlError) as ctx:
            self.make_bus().command({"do": "mute", "on": True})
        self.assertEqual(ctx.exception.code, 503)

    def test_a_command_that_only_a_page_that_went_away_had_goes_to_the_next_one(self) -> None:
        bus = self.make_bus()
        old = bus.subscribe()
        result: queue.Queue[Any] = queue.Queue()
        threading.Thread(
            target=lambda: result.put(bus.command({"do": "mute", "on": True}, timeout=10)), daemon=True
        ).start()
        first = old.get(timeout=5)
        bus.unsubscribe(old)  # the page reloaded before answering
        new = bus.subscribe()
        again = new.get(timeout=5)
        self.assertEqual(again, first)  # the same command, with the same id: the client is still waiting for it
        self.assertTrue(bus.report(again["id"], True, "hecho"))
        self.assertEqual(result.get(timeout=5), {"ok": True, "detail": "hecho"})
        bus.close()

    def test_a_page_that_connected_before_the_old_one_was_seen_to_leave_still_gets_the_command(self) -> None:
        bus = self.make_bus()
        old = bus.subscribe()
        result: queue.Queue[Any] = queue.Queue()
        threading.Thread(
            target=lambda: result.put(bus.command({"do": "mute", "on": True}, timeout=10)), daemon=True
        ).start()
        first = old.get(timeout=5)
        new = (
            bus.subscribe()
        )  # the reloaded page connects first: nothing is handed over yet, the old one may still answer
        with self.assertRaises(queue.Empty):
            new.get(timeout=0.2)
        bus.unsubscribe(old)  # and now the old one is seen to be gone
        again = new.get(timeout=5)
        self.assertEqual(again, first)
        bus.report(again["id"], True, "hecho")
        self.assertEqual(result.get(timeout=5), {"ok": True, "detail": "hecho"})
        bus.close()

    def test_a_command_is_not_repeated_to_a_page_if_another_one_still_has_it(self) -> None:
        bus = self.make_bus()
        a, b = bus.subscribe(), bus.subscribe()
        result: queue.Queue[Any] = queue.Queue()
        threading.Thread(
            target=lambda: result.put(bus.command({"do": "mute", "on": True}, timeout=10)), daemon=True
        ).start()
        sent = a.get(timeout=5)
        b.get(timeout=5)
        bus.unsubscribe(a)  # one page left, the other still has the command
        late = bus.subscribe()
        with self.assertRaises(queue.Empty):
            late.get(timeout=0.3)  # nothing is handed over twice
        bus.report(sent["id"], True, "hecho")
        result.get(timeout=5)
        bus.close()

    def test_an_answered_command_is_not_handed_over(self) -> None:
        bus = self.make_bus()
        FakePage(bus).start()
        bus.command({"do": "mute", "on": True})
        late = bus.subscribe()
        with self.assertRaises(queue.Empty):
            late.get(timeout=0.3)
        bus.close()

    def test_a_command_goes_to_the_page_and_its_answer_comes_back(self) -> None:
        bus = self.make_bus()
        page = FakePage(bus)
        page.start()
        self.assertEqual(bus.command({"do": "play", "channel": "La 2"}), {"ok": True, "detail": "hecho"})
        self.assertEqual(page.seen[0]["cmd"], {"do": "play", "channel": "La 2"})
        self.assertTrue(page.seen[0]["id"])
        bus.close()

    def test_a_failure_the_page_reports_is_a_result_not_an_error(self) -> None:
        bus = self.make_bus()
        FakePage(bus, ok=False).start()
        self.assertEqual(bus.command({"do": "play", "channel": "Nada"}), {"ok": False, "detail": "no hay ese canal"})
        bus.close()

    def test_a_page_that_does_not_answer_times_out_and_leaves_nothing_pending(self) -> None:
        bus = self.make_bus()
        FakePage(bus, answer=False).start()
        with self.assertRaises(ControlError) as ctx:
            bus.command({"do": "mute", "on": False}, timeout=0.2)
        self.assertEqual(ctx.exception.code, 504)
        self.assertEqual(bus._pending, {})
        bus.close()

    def test_an_invalid_command_never_reaches_the_page(self) -> None:
        bus = self.make_bus()
        page = FakePage(bus)
        page.start()
        with self.assertRaises(ControlError):
            bus.command({"do": "settings"})
        self.assertEqual(page.seen, [])
        bus.close()

    def test_an_answer_nobody_waits_for_is_ignored(self) -> None:
        bus = self.make_bus()
        for command_id in ("nope", None, 5, ["x"]):
            self.assertFalse(bus.report(command_id, True, "x"))

    def test_the_snapshot_is_kept_with_its_age_and_the_status_tells_who_is_there(self) -> None:
        bus = self.make_bus()
        self.assertIsNone(bus.state())
        self.assertTrue(bus.accept_state({"kind": "radio"}))
        self.assertFalse(bus.accept_state("no"))
        state = bus.state()
        assert state is not None
        self.assertEqual(state["kind"], "radio")
        self.assertGreaterEqual(state["age_seconds"], 0)
        status = bus.status()
        self.assertEqual(
            (status["enabled"], status["level"], status["page_connected"], status["client_recent"]),
            (True, "control", False, False),
        )
        sub = bus.subscribe()
        bus.touch_client()
        status = bus.status()
        self.assertTrue(status["page_connected"] and status["client_recent"])
        bus.unsubscribe(sub)
        self.assertFalse(bus.status()["page_connected"])

    def test_what_happened_is_noted_for_the_user(self) -> None:
        bus = self.make_bus()
        FakePage(bus).start()
        bus.command({"do": "volume", "value": 0.3})
        bus.regenerate()
        texts = [entry["text"] for entry in bus.status()["audit"]]
        self.assertTrue(any("volume" in t and "hecho" in t for t in texts), texts)
        self.assertTrue(any("token" in t for t in texts), texts)
        bus.close()

    def test_closing_ends_the_streams(self) -> None:
        bus = self.make_bus()
        sub = bus.subscribe()
        bus.close()
        self.assertIsNone(sub.get(timeout=1))


class StubHandler:
    """Just enough of a request handler to ask `_client` about a caller that is not this machine."""

    def __init__(self, app: Any, address: str, auth: str | None) -> None:
        self.app = app
        self.client_address = (address, 5000)
        self.headers = {"Authorization": auth} if auth else {}
        self.answer: tuple[int, Any] | None = None

    def _json(self, code: int, obj: Any) -> None:
        self.answer = (code, obj)

    def _send(self, code: int, body: bytes = b"", **_: Any) -> None:
        self.answer = (code, json.loads(body))


class FromAnotherMachineTests(AppCase):
    config_overrides = {"control_enabled": True, "control_level": "control"}  # noqa: RUF012

    def test_a_client_that_is_not_this_machine_is_refused_even_with_the_token(self) -> None:
        token = self.app.control.token()
        stub = StubHandler(self.app, "192.168.1.50", f"Bearer {token}")
        self.assertFalse(_client(stub, "read"))  # type: ignore[arg-type]
        assert stub.answer is not None
        self.assertEqual(stub.answer[0], 403)
        local = StubHandler(self.app, "127.0.0.1", f"Bearer {token}")
        self.assertTrue(_client(local, "control"))  # type: ignore[arg-type]


class RouteTests(ServerCase):
    config_overrides = {"control_enabled": True, "control_level": "control"}  # noqa: RUF012

    def auth(self) -> dict[str, str]:
        return {"Authorization": "Bearer " + self.app.control.token()}

    def test_the_status_is_open_and_says_what_is_on(self) -> None:
        status, data = self.get_json("/api/control/status")
        self.assertEqual(status, 200)
        self.assertEqual((data["enabled"], data["level"]), (True, "control"))
        self.assertNotIn("token", json.dumps(data))

    def test_without_the_token_a_client_gets_nothing(self) -> None:
        for method, path in (("GET", "/api/control/v1/state"), ("POST", "/api/control/v1/command")):
            for headers in ({}, {"Authorization": "Bearer nope"}, {"Authorization": "Bearer "}):
                status, response, _ = self.request(
                    method, path, {"do": "mute", "on": True} if method == "POST" else None, headers
                )
                self.assertEqual(status, 401, (method, headers))
                self.assertEqual(response["www-authenticate"], "Bearer")

    def test_other_sites_cannot_use_it_even_with_the_token(self) -> None:
        body = {"do": "mute", "on": True}
        status, _, _ = self.request(
            "POST", "/api/control/v1/command", body, {**self.auth(), "Sec-Fetch-Site": "cross-site"}
        )
        self.assertEqual(status, 403)
        status, _, _ = self.request(
            "POST", "/api/control/v1/command", body, {**self.auth(), "Origin": "http://evil.example"}
        )
        self.assertEqual(status, 403)
        status, _, _ = self.request("GET", "/api/control/v1/state", None, {**self.auth(), "Host": "evil.example"})
        self.assertEqual(status, 403)

    def test_the_page_publishes_its_state_and_a_client_reads_it(self) -> None:
        self.assertEqual(self.request("GET", "/api/control/v1/state", None, self.auth())[0], 503)  # nothing sent yet
        status, data = self.post_json(
            "/api/control/state",
            {"kind": "radio", "mode": "multi", "tiles": [{"slot": 0, "id": "a", "name": "La 2", "kind": "tv"}]},
        )
        self.assertEqual((status, data), (200, {"ok": True}))
        status, _, raw = self.request("GET", "/api/control/v1/state", None, self.auth())
        self.assertEqual(status, 200)
        state = json.loads(raw)
        self.assertEqual((state["kind"], state["mode"], state["tiles"][0]["name"]), ("radio", "multi", "La 2"))
        self.assertIn("age_seconds", state)
        self.assertTrue(self.get_json("/api/control/status")[1]["client_recent"])

    def test_a_bad_state_is_not_taken(self) -> None:
        self.assertEqual(self.post_json("/api/control/state", {})[1], {"ok": False})

    def test_the_token_is_for_the_page_on_this_machine_only(self) -> None:
        status, data = self.get_json("/api/control/token")
        self.assertEqual((status, data["token"]), (200, self.app.control.token()))
        status, data = self.post_json("/api/control/token/regenerate")
        self.assertEqual(status, 200)
        self.assertNotEqual(data["token"], "")
        self.assertEqual(
            self.request("GET", "/api/control/v1/state", None, {"Authorization": "Bearer " + data["token"]})[0], 503
        )
        status, _, _ = self.request("GET", "/api/control/token", None, {"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)

    def test_a_command_without_a_page_is_a_503_and_a_bad_one_a_400(self) -> None:
        status, _, raw = self.request("POST", "/api/control/v1/command", {"do": "mute", "on": True}, self.auth())
        self.assertEqual(status, 503)
        self.assertIn("conectada", json.loads(raw)["error"])
        status, _, raw = self.request("POST", "/api/control/v1/command", {"do": "format_disk"}, self.auth())
        self.assertEqual(status, 400)
        self.assertIn("orden desconocida", json.loads(raw)["error"])

    def test_a_page_that_closes_its_stream_is_gone_at_once_and_not_a_ghost_for_fifteen_seconds(self) -> None:
        stream = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        stream.request("GET", "/api/control/events")
        response = stream.getresponse()
        response.readline()
        self.assertTrue(self.get_json("/api/control/status")[1]["page_connected"])
        response.close()  # the response keeps the socket open until it is closed too
        stream.close()  # a page that reloads
        deadline = time.time() + 3
        while self.get_json("/api/control/status")[1]["page_connected"] and time.time() < deadline:
            time.sleep(0.1)
        self.assertFalse(self.get_json("/api/control/status")[1]["page_connected"])
        status, _, raw = self.request("POST", "/api/control/v1/command", {"do": "mute", "on": True}, self.auth())
        self.assertEqual(status, 503)  # an answer at once, so that the client asks again, and not 20 seconds of nothing
        self.assertIn("conectada", json.loads(raw)["error"])

    def test_a_command_makes_the_round_trip_through_the_event_stream(self) -> None:
        stream = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        self.addCleanup(stream.close)
        stream.request("GET", "/api/control/events")
        response = stream.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn("text/event-stream", response.getheader("Content-Type"))
        self.assertIn(b"conectado", response.readline())
        results: queue.Queue[tuple[int, Any]] = queue.Queue()

        def client() -> None:
            status, _, raw = self.request(
                "POST", "/api/control/v1/command", {"do": "play", "channel": "La 2"}, self.auth()
            )
            results.put((status, json.loads(raw)))

        threading.Thread(target=client, daemon=True).start()
        event = data = b""
        while not data:
            line = response.readline()
            if line.startswith(b"event:"):
                event = line
            elif line.startswith(b"data:"):
                data = line[5:]
        self.assertEqual(event.strip(), b"event: command")
        command = json.loads(data)
        self.assertEqual(command["cmd"], {"do": "play", "channel": "La 2"})
        self.assertEqual(
            self.post_json("/api/control/result", {"id": command["id"], "ok": True, "detail": "La 2"})[1], {"ok": True}
        )
        self.assertEqual(results.get(timeout=10), (200, {"ok": True, "detail": "La 2"}))

    def test_the_read_level_cannot_send_commands(self) -> None:
        self.app.config.control_level = "read"
        status, _, raw = self.request("POST", "/api/control/v1/command", {"do": "mute", "on": True}, self.auth())
        self.assertEqual(status, 403)
        self.assertIn("control", json.loads(raw)["error"])
        self.post_json("/api/control/state", {"kind": "tv"})
        self.assertEqual(self.request("GET", "/api/control/v1/state", None, self.auth())[0], 200)  # reading is allowed


class DevRouteTests(ServerCase):
    config_overrides = {"control_enabled": True, "control_level": "dev"}  # noqa: RUF012

    def auth(self) -> dict[str, str]:
        return {"Authorization": "Bearer " + self.app.control.token()}

    def test_a_write_of_over_a_hundred_kilobytes_in_two_files_goes_through_and_so_does_the_data_back(self) -> None:
        page = FakePage(self.app.control, data={"written": ["page.js"]})
        page.start()
        self.addCleanup(self.app.control.close)
        body = {
            "do": "dev_write",
            "id": "grande",
            "files": {"a.js": "// " + "x" * 60_000, "b.js": "// " + "y" * 60_000},
            "dry_run": True,
        }
        status, _, raw = self.request("POST", "/api/control/v1/command", body, self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), {"ok": True, "detail": "hecho", "data": {"written": ["page.js"]}})
        self.assertEqual(sum(len(v) for v in page.seen[0]["cmd"]["files"].values()), 120_006)

    def test_the_page_can_answer_with_a_large_body_too(self) -> None:
        sub = self.app.control.subscribe()
        results: queue.Queue[Any] = queue.Queue()
        threading.Thread(
            target=lambda: results.put(self.app.control.command({"do": "dev_read", "id": "x"}, timeout=10)), daemon=True
        ).start()
        item = sub.get(timeout=5)
        status, data = self.post_json(
            "/api/control/result", {"id": item["id"], "ok": True, "detail": "x", "data": {"f": "y" * 200_000}}
        )
        self.assertEqual((status, data), (200, {"ok": True}))
        self.assertEqual(len(results.get(timeout=5)["data"]["f"]), 200_000)

    def test_a_body_too_big_is_not_taken_and_a_refusal_still_reaches_a_client_that_sent_a_big_one(self) -> None:
        huge = {"do": "dev_write", "id": "x", "files": {"a.js": "x"}, "padding": "p" * 450_000}
        try:
            refused = self.request("POST", "/api/control/v1/command", huge, self.auth())[0]
        except (OSError, http.client.HTTPException):
            refused = None  # a body this big may also just get the connection closed: the point is that it is not taken
        self.assertNotEqual(refused, 200)
        status, _, _ = self.request(
            "POST", "/api/control/v1/command", {"do": "dev_write", "id": "x", "files": {"a.js": "x" * 100_000}}
        )
        self.assertEqual(status, 401)  # no token: a clear refusal, not a connection that is reset

    def test_a_control_level_token_cannot_send_a_dev_command(self) -> None:
        self.app.config.control_level = "control"
        status, _, raw = self.request("POST", "/api/control/v1/command", {"do": "dev_list"}, self.auth())
        self.assertEqual(status, 403)
        self.assertIn("dev", json.loads(raw)["error"])

    def test_a_bad_dev_command_is_a_400_with_the_reason(self) -> None:
        status, _, raw = self.request(
            "POST", "/api/control/v1/command", {"do": "dev_write", "id": "..", "files": {"a.js": "1"}}, self.auth()
        )
        self.assertEqual(status, 400)
        self.assertIn("carpeta", json.loads(raw)["error"])


class OffByDefaultTests(ServerCase):
    def test_nothing_works_until_the_user_turns_it_on(self) -> None:
        self.assertFalse(self.get_json("/api/control/status")[1]["enabled"])
        token = {"Authorization": "Bearer " + self.app.control.token()}
        self.assertEqual(self.request("GET", "/api/control/v1/state", None, token)[0], 403)
        self.assertEqual(self.request("POST", "/api/control/v1/command", {"do": "mute", "on": True}, token)[0], 403)
        self.assertEqual(self.request("GET", "/api/control/v1/state", None)[0], 401)
        self.assertEqual(self.post_json("/api/control/state", {"kind": "tv"})[0], 403)
        self.assertEqual(self.post_json("/api/control/result", {"id": "x"})[0], 403)
        self.assertEqual(self.get_json("/api/control/events")[0], 403)
        self.assertEqual(self.get_json("/api/control/token")[0], 403)

    def test_turning_it_on_from_the_settings_takes_effect_at_once_and_is_remembered(self) -> None:
        status, _ = self.post_json("/api/settings", {"control_enabled": True, "control_level": "control"})
        self.assertEqual(status, 200)
        self.assertEqual(self.get_json("/api/control/status")[1]["level"], "control")
        self.assertEqual(self.get_json("/api/control/token")[0], 200)
        self.assertEqual(self.post_json("/api/settings", {"control_level": "admin"})[0], 400)  # not a level
        saved = json.loads((self.tmp / "data" / "settings.json").read_text("utf-8"))
        self.assertIn("control_enabled", json.dumps(saved))


if __name__ == "__main__":
    unittest.main()


class HeaderCommandTests(unittest.TestCase):
    def test_the_commands_are_checked_and_cleaned(self) -> None:
        self.assertEqual(
            clean_command({"do": "headers_get", "channel": " La 2 "}), {"do": "headers_get", "channel": "La 2"}
        )
        self.assertEqual(
            clean_command(
                {"do": "headers_set", "channel": "la-2", "headers": {"Referer": "https://r/", "Cookie": None}}
            ),
            {
                "do": "headers_set",
                "channel": "la-2",
                "headers": {"Referer": "https://r/", "Cookie": None},
                "replace": False,
            },
        )
        self.assertIs(
            clean_command({"do": "headers_set", "channel": "a", "headers": {"A": "b"}, "replace": True})["replace"],
            True,
        )
        for bad in (
            {"do": "headers_get"},
            {"do": "headers_get", "channel": ""},
            {"do": "headers_set", "channel": "a"},
            {"do": "headers_set", "channel": "a", "headers": {}},
            {"do": "headers_set", "channel": "a", "headers": {"Host": "x"}},
            {"do": "headers_set", "channel": "a", "headers": {"A": "b\r\nC: d"}},
            {"do": "headers_set", "channel": "a", "headers": {"con espacio": "b"}},
            {"do": "headers_set", "channel": "a", "headers": {"A": 5}},
            {"do": "headers_set", "channel": "a", "headers": {f"X-{i}": "v" for i in range(9)}},
        ):
            with self.assertRaises(ControlError, msg=str(bad)[:80]):
                clean_command(bad)

    def test_seeing_needs_read_and_changing_needs_the_plugins_level(self) -> None:
        self.assertEqual(command_level({"do": "headers_get"}), "read")
        self.assertEqual(command_level({"do": "headers_set"}), "dev")
        self.assertGreaterEqual(COMMAND_TIMEOUTS["headers_set"], 120)
        self.assertLess(COMMAND_TIMEOUTS["headers_get"], 60)


class PluginCommandTests(unittest.TestCase):
    """The commands about the plugins with permissions: what a client may name, and which level each one needs."""

    def test_the_commands_are_checked_and_cleaned(self) -> None:
        self.assertEqual(clean_command({"do": "plugin_list", "x": 1}), {"do": "plugin_list"})
        self.assertEqual(
            clean_command({"do": "plugin_enable", "id": "tiempo"}), {"do": "plugin_enable", "id": "tiempo"}
        )
        self.assertEqual(
            clean_command({"do": "plugin_disable", "id": "a-b-2"}), {"do": "plugin_disable", "id": "a-b-2"}
        )
        self.assertEqual(
            clean_command({"do": "plugin_logs", "id": "tiempo"}), {"do": "plugin_logs", "id": "tiempo", "limit": 50}
        )
        self.assertEqual(clean_command({"do": "plugin_read", "id": "tiempo"}), {"do": "plugin_read", "id": "tiempo"})
        self.assertEqual(
            clean_command(
                {"do": "plugin_write", "id": "tiempo", "files": {"app.js": "1", "index.html": None}, "dry_run": True}
            ),
            {"do": "plugin_write", "id": "tiempo", "files": {"app.js": "1", "index.html": None}, "dry_run": True},
        )
        self.assertIs(clean_command({"do": "plugin_write", "id": "t", "files": {"a.svg": "<svg/>"}})["dry_run"], False)
        self.assertEqual(
            clean_command({"do": "plugin_permission", "id": "t", "permission": "network:api.a.com", "on": False}),
            {"do": "plugin_permission", "id": "t", "permission": "network:api.a.com", "on": False},
        )
        for bad in (
            {"do": "plugin_enable"},
            {"do": "plugin_enable", "id": "../x"},
            {"do": "plugin_enable", "id": "Mayus"},
            {"do": "plugin_enable", "id": "a" * 41},
            {"do": "plugin_enable", "id": 3},
            {"do": "plugin_logs", "id": "t", "limit": 0},
            {"do": "plugin_write", "id": "t"},
            {"do": "plugin_write", "id": "t", "files": {}},
            {"do": "plugin_write", "id": "Mayus", "files": {"a.js": "1"}},
            {"do": "plugin_write", "id": "t", "files": {"../a.js": "1"}},
            {"do": "plugin_write", "id": "t", "files": {"a.exe": "1"}},
            {"do": "plugin_write", "id": "t", "files": {"a.js": "x" * 70_000}},
            {"do": "plugin_read", "id": "../x"},
            {"do": "plugin_logs", "id": "t", "limit": True},
            {"do": "plugin_permission", "id": "t", "permission": "storage"},
            {"do": "plugin_permission", "id": "t", "permission": "storage", "on": "si"},
            {"do": "plugin_permission", "id": "t", "permission": "../x", "on": True},
            {"do": "plugin_permission", "id": "t", "permission": "network:" + "a" * 200, "on": True},
        ):
            with self.assertRaises(ControlError, msg=str(bad)):
                clean_command(bad)

    def test_looking_needs_read_and_changing_needs_the_plugins_level(self) -> None:
        self.assertEqual(command_level({"do": "plugin_list"}), "read")
        self.assertEqual(command_level({"do": "plugin_logs"}), "read")
        for do in (
            "plugin_enable",
            "plugin_disable",
            "plugin_permission",
            "plugin_read",
            "plugin_write",
            "dev_write",
            "dev_activate",
        ):
            self.assertEqual(command_level({"do": do}), "dev", do)
        for do in ("play", "volume", "multi"):
            self.assertEqual(command_level({"do": do}), "control", do)

    def test_the_questions_to_the_user_get_time_to_be_answered(self) -> None:
        self.assertGreaterEqual(COMMAND_TIMEOUTS["plugin_enable"], 120)
        self.assertGreaterEqual(COMMAND_TIMEOUTS["plugin_permission"], 120)
        self.assertGreaterEqual(COMMAND_TIMEOUTS["plugin_write"], 120)
        self.assertLess(COMMAND_TIMEOUTS["plugin_list"], 60)
