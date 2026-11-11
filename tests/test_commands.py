"""The single specification of orders and events (static/commands.json) and everyone who has to agree with it."""

from __future__ import annotations

import json
import unittest
from typing import Any

from tdtlocal import control_data, rules
from tdtlocal.control import CLEANERS, ControlError, clean_command, command_level
from tdtlocal.mcp import McpServer

from .test_mcp import FakeBackend, rpc

SPEC = control_data.commands_spec()
PLUGIN_API = control_data.plugin_api()


class SpecAgreementTests(unittest.TestCase):
    def test_every_order_is_known_to_the_rules_and_every_rule_action_is_in_the_spec(self) -> None:
        self.assertEqual({c["rule"] for c in SPEC["commands"].values()}, set(rules.ACTIONS))

    def test_every_order_with_a_command_of_the_bus_has_its_checker_and_the_rest_are_the_pages_own(self) -> None:
        for name, command in SPEC["commands"].items():
            if command["bus"]:
                self.assertIn(command["bus"], CLEANERS, name)
            else:
                self.assertNotIn(name.split(".")[-1], CLEANERS, name)
        in_the_spec = {c["bus"] for c in SPEC["commands"].values() if c["bus"]}
        self.assertEqual({k for k in CLEANERS if k in in_the_spec}, in_the_spec)

    def test_the_example_of_each_order_is_accepted_by_the_rules_and_by_the_bus(self) -> None:
        for name, command in SPEC["commands"].items():
            action = {"action": command["rule"], **command["example"]}
            self.assertEqual(rules.clean_action(action), action, name)
            if command["bus"]:
                cleaned = clean_command({"do": command["bus"], **command["example"]})
                for key, value in command["example"].items():
                    self.assertEqual(cleaned[key], value, f"{name}: {key}")

    def test_the_arguments_of_the_spec_are_the_ones_the_example_uses_and_the_rules_refuse_what_the_spec_forbids(
        self,
    ) -> None:
        for name, command in SPEC["commands"].items():
            self.assertLessEqual(set(command["example"]), set(command["args"]), name)
            required = {a for a, spec in command["args"].items() if spec.get("required")}
            self.assertLessEqual(required, set(command["example"]), f"{name}: the example gives what is required")
            for missing in required:
                broken = {"action": command["rule"], **{k: v for k, v in command["example"].items() if k != missing}}
                with self.assertRaises(ValueError, msg=f"{name} without {missing}"):
                    rules.clean_action(broken)
            with self.assertRaises(ValueError, msg=f"{name} with an argument that does not exist"):
                rules.clean_action({"action": command["rule"], **command["example"], "inventado": 1})

    def test_the_numbers_and_choices_of_the_spec_are_the_limits_of_the_rules(self) -> None:
        volume = SPEC["commands"]["player.volume"]["args"]["value"]
        for value in (volume["min"] - 0.1, volume["max"] + 0.1):
            with self.assertRaises(ValueError):
                rules.clean_action({"action": "volume", "value": value})
        rotate = SPEC["commands"]["player.multi"]["args"]["rotate"]
        for value in (rotate["min"] - 1, rotate["max"] + 1):
            with self.assertRaises(ValueError):
                rules.clean_action({"action": "multi", "channels": ["a"], "rotate": value})
        self.assertEqual(SPEC["commands"]["player.multi"]["args"]["channels"]["max"], rules.MAX_TILES)
        self.assertEqual(SPEC["commands"]["ui.toast"]["args"]["text"]["max"], rules.MAX_TEXT)
        self.assertEqual(set(SPEC["commands"]["player.kind"]["args"]["kind"]["enum"]), set(rules.KINDS))

    def test_every_plugin_method_of_an_order_exists_and_every_event_has_a_permission_that_exists(self) -> None:
        for name, command in SPEC["commands"].items():
            self.assertIn(command["plugin"], PLUGIN_API["methods"], name)
        for name, event in SPEC["events"].items():
            self.assertEqual(PLUGIN_API["events"][name]["permission"], event["permission"], name)
            self.assertIn(event["permission"], PLUGIN_API["permissions"], name)

    def test_the_events_the_rules_wait_for_are_in_the_spec(self) -> None:
        by_rule = {e["rule"] for e in SPEC["events"].values() if "rule" in e}
        self.assertEqual(by_rule, {"channel", "programme"})
        self.assertTrue(by_rule <= set(rules.TRIGGERS))


class EventsCommandTests(unittest.TestCase):
    def test_what_just_happened_is_a_reading_command_with_limits(self) -> None:
        self.assertEqual(clean_command({"do": "events_get"}), {"do": "events_get", "limit": 30, "name": ""})
        self.assertEqual(
            clean_command({"do": "events_get", "limit": 5, "name": "kind.changed"})["name"], "kind.changed"
        )
        self.assertEqual(command_level({"do": "events_get"}), "read")
        for bad in ({"limit": 0}, {"limit": 101}, {"limit": True}, {"limit": "5"}, {"name": "inventado"}, {"name": 5}):
            with self.assertRaises(ControlError, msg=str(bad)):
                clean_command({"do": "events_get", **bad})


class CommandsToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = FakeBackend("read")
        self.server = McpServer(self.backend)

    def call(self, name: str, arguments: Any) -> dict[str, Any]:
        return rpc(self.server, "tools/call", {"name": name, "arguments": arguments})["result"]

    def test_the_whole_list_of_orders_and_events_is_one_call_away(self) -> None:
        got = self.call("tdt_commands", {})
        self.assertIs(got["isError"], False)
        self.assertEqual(json.dumps(got["structuredContent"], sort_keys=True), json.dumps(SPEC, sort_keys=True))
        self.assertEqual(self.backend.calls, [], "it is a file, it does not need the window")

    def test_the_latest_events_are_asked_of_the_window(self) -> None:
        self.call("tdt_events", {})
        self.call("tdt_events", {"limit": 5, "name": "channel.changed"})
        self.assertEqual(
            self.backend.calls,
            [
                ("command", {"do": "events_get"}),
                ("command", {"do": "events_get", "limit": 5, "name": "channel.changed"}),
            ],
        )

    def test_a_wrong_call_is_refused_before_anything_is_sent(self) -> None:
        for arguments in ({"limit": 0}, {"limit": 500}, {"name": "inventado"}, {"otro": 1}):
            self.assertIs(self.call("tdt_events", arguments)["isError"], True, arguments)
        self.assertEqual(self.backend.calls, [])


if __name__ == "__main__":
    unittest.main()


class PluginCallsCommandTests(unittest.TestCase):
    def test_the_calls_of_the_plugins_are_a_reading_command_with_limits(self) -> None:
        self.assertEqual(clean_command({"do": "plugin_calls"}), {"do": "plugin_calls", "limit": 50})
        self.assertEqual(
            clean_command({"do": "plugin_calls", "limit": 5, "id": "mi-plugin"}),
            {"do": "plugin_calls", "limit": 5, "id": "mi-plugin"},
        )
        self.assertEqual(command_level({"do": "plugin_calls"}), "read")
        for bad in ({"limit": 0}, {"limit": 201}, {"limit": True}, {"limit": "5"}, {"id": "Mal Id"}, {"id": 5}):
            with self.assertRaises(ControlError, msg=str(bad)):
                clean_command({"do": "plugin_calls", **bad})

    def test_the_tool_sends_the_command_and_refuses_a_wrong_call_before_sending(self) -> None:
        backend = FakeBackend("read")
        server = McpServer(backend)
        rpc(server, "tools/call", {"name": "tdt_plugin_calls", "arguments": {}})
        rpc(server, "tools/call", {"name": "tdt_plugin_calls", "arguments": {"id": "mi-plugin", "limit": 20}})
        self.assertEqual(
            backend.calls,
            [("command", {"do": "plugin_calls"}), ("command", {"do": "plugin_calls", "id": "mi-plugin", "limit": 20})],
        )
        backend.calls.clear()
        for arguments in ({"limit": 0}, {"limit": 500}, {"id": "Mal Id"}, {"otro": 1}):
            self.assertIs(
                rpc(server, "tools/call", {"name": "tdt_plugin_calls", "arguments": arguments})["result"]["isError"],
                True,
                arguments,
            )
        self.assertEqual(backend.calls, [])
