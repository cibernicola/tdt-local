"""Rules: what a valid rule is, how they are kept, the routes that read and replace them, the bus commands."""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from tdtlocal import rules
from tdtlocal.control import COMMAND_TIMEOUTS, ControlError, clean_command, command_level

from .helpers import ServerCase

GOOD: dict[str, Any] = {
    "id": "noticias",
    "name": "Noticias a las 21",
    "enabled": True,
    "when": {"type": "time", "at": "21:00", "days": [5, 1, 1, 3]},
    "do": [
        {"action": "play", "channel": "La 1"},
        {"action": "volume", "value": 0.4},
        {"action": "toast", "text": "Telediario"},
    ],
}


def rule(**changes: Any) -> dict[str, Any]:
    return {**GOOD, **changes}


class RuleCheckTests(unittest.TestCase):
    def test_a_rule_is_normalised(self) -> None:
        done = rules.clean_rule(rule(name="  Noticias  "))
        self.assertEqual(done["name"], "Noticias")
        self.assertEqual(done["when"]["days"], [1, 3, 5], "sorted, no repeats")
        self.assertEqual(
            rules.clean_rule({"id": "a", "when": GOOD["when"], "do": GOOD["do"]})["name"],
            "a",
            "the id is the default name",
        )
        self.assertIs(rules.clean_rule({"id": "a", "when": GOOD["when"], "do": GOOD["do"]})["enabled"], True)

    def test_every_trigger_and_every_action_is_understood(self) -> None:
        whens = [
            {"type": "time", "at": "00:00"},
            {"type": "channel", "channel": "La 2"},
            {"type": "programme", "title": "Telediario"},
            {"type": "programme", "title": "fútbol", "channel": "Teledeporte"},
        ]
        actions = [
            {"action": "play", "channel": "La 1"},
            {"action": "kind", "kind": "radio"},
            {"action": "volume", "value": 0},
            {"action": "mute", "on": True},
            {"action": "multi", "channels": ["a", "b"], "rotate": 30},
            {"action": "toast", "text": "hola"},
        ]
        for when in whens:
            self.assertEqual(rules.clean_when(when), when)
        for action in actions:
            self.assertEqual(rules.clean_action(action), action)

    def test_what_is_wrong_is_said_in_words(self) -> None:
        bad: list[Any] = [
            rule(id="Mayúsculas"),
            rule(id=""),
            rule(id="x" * 41),
            rule(enabled="yes"),
            rule(name=5),
            rule(extra=1),
            rule(when={"type": "time", "at": "25:00"}),
            rule(when={"type": "time", "at": "9:00"}),
            rule(when={"type": "time", "at": "21:00", "days": [7]}),
            rule(when={"type": "time", "at": "21:00", "days": []}),
            rule(when={"type": "time", "at": "21:00", "days": [True]}),
            rule(when={"type": "channel"}),
            rule(when={"type": "programme", "title": ""}),
            rule(when={"type": "teleport"}),
            rule(when={"type": "time", "at": "21:00", "script": "x"}),
            rule(do=[]),
            rule(do=[{"action": "toast", "text": "x"}] * 6),
            rule(do=[{"action": "eval", "code": "1"}]),
            rule(do=[{"action": "volume", "value": 2}]),
            rule(do=[{"action": "volume", "value": True}]),
            rule(do=[{"action": "mute"}]),
            rule(do=[{"action": "kind", "kind": "dvd"}]),
            rule(do=[{"action": "multi", "channels": []}]),
            rule(do=[{"action": "multi", "channels": ["a"] * 5}]),
            rule(do=[{"action": "multi", "channels": ["a"], "rotate": 1}]),
            rule(do=[{"action": "toast", "text": "dos\nlíneas"}]),
            rule(do=[{"action": "toast", "text": "x" * 201}]),
            rule(do=[{"action": "play", "channel": "La 1", "also": 1}]),
            "no es un objeto",
        ]
        for item in bad:
            with self.assertRaises(ValueError, msg=repr(item)[:90]):
                rules.clean_rule(item)

    def test_the_message_names_the_rule(self) -> None:
        with self.assertRaises(ValueError) as caught:
            rules.clean_rule(rule(do=[{"action": "volume", "value": 2}]))
        self.assertIn("noticias", str(caught.exception))
        self.assertIn("volume", str(caught.exception))

    def test_a_list_is_checked_strictly_from_a_person_and_leniently_from_disk(self) -> None:
        other = rule(id="otra")
        self.assertEqual([r["id"] for r in rules.clean_rules([GOOD, other])], ["noticias", "otra"])
        with self.assertRaises(ValueError):
            rules.clean_rules([GOOD, rule(id="malo", do=[])])
        with self.assertRaises(ValueError):
            rules.clean_rules([GOOD, GOOD])
        with self.assertRaises(ValueError):
            rules.clean_rules([rule(id=f"r{i}") for i in range(rules.MAX_RULES + 1)])
        with self.assertRaises(ValueError):
            rules.clean_rules({"a": 1})
        self.assertEqual(
            [r["id"] for r in rules.clean_rules([GOOD, rule(id="malo", do=[]), GOOD], strict=False)], ["noticias"]
        )
        self.assertEqual(rules.clean_rules("x", strict=False), [])

    def test_a_rule_is_described_in_a_sentence(self) -> None:
        text = rules.describe_rule(rules.clean_rule(GOOD))
        self.assertIn("a las 21:00 (lun, mié, vie)", text)
        self.assertIn("poner «La 1»", text)
        self.assertIn("volumen al 40 %", text)
        self.assertIn("avisar «Telediario»", text)
        off = rules.describe_rule(
            rules.clean_rule(rule(enabled=False, when={"type": "programme", "title": "Cine", "channel": "La 2"}))
        )
        self.assertIn("cuando empiece un programa con «Cine» en «La 2»", off)
        self.assertTrue(off.endswith("(apagada)"))


class RulesStoreTests(unittest.TestCase):
    def test_they_are_kept_on_disk_and_come_back(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "rules.json"
            store = rules.RulesStore(path)
            store.load()
            self.assertEqual(store.get(), [])
            store.set([GOOD])
            again = rules.RulesStore(path)
            again.load()
            self.assertEqual(again.get()[0]["id"], "noticias")

    def test_a_wrong_replacement_changes_nothing(self) -> None:
        with TemporaryDirectory() as folder:
            store = rules.RulesStore(Path(folder) / "rules.json")
            store.set([GOOD])
            with self.assertRaises(ValueError):
                store.set([GOOD, rule(id="malo", do=[])])
            self.assertEqual([r["id"] for r in store.get()], ["noticias"])

    def test_a_damaged_file_is_not_a_crash(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "rules.json"
            for text in ("{", "[]", '{"rules": "x"}', '{"rules": [1, {"id": "A"}]}'):
                path.write_text(text, encoding="utf-8")
                store = rules.RulesStore(path)
                store.load()
                self.assertEqual(store.get(), [], text)


class RulesRouteTests(ServerCase):
    def test_the_page_reads_and_replaces_them(self) -> None:
        status, _, body = self.request("GET", "/api/rules")
        self.assertEqual((status, json.loads(body)["rules"]), (200, []))
        status, _, body = self.request("POST", "/api/rules", {"rules": [GOOD]})
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["rules"][0]["when"]["days"], [1, 3, 5])
        status, _, body = self.request("GET", "/api/rules")
        self.assertEqual([r["id"] for r in json.loads(body)["rules"]], ["noticias"])
        self.assertTrue((self.app.config.data_dir / "rules.json").is_file())

    def test_a_wrong_replacement_is_a_400_and_changes_nothing(self) -> None:
        self.request("POST", "/api/rules", {"rules": [GOOD]})
        status, _, body = self.request("POST", "/api/rules", {"rules": [rule(id="malo", do=[])]})
        self.assertEqual(status, 400)
        self.assertIn("malo", json.loads(body)["error"])
        self.assertEqual([r["id"] for r in self.app.rules.get()], ["noticias"])
        status, _, _ = self.request("POST", "/api/rules", {"nada": 1})
        self.assertEqual(status, 400)

    def test_a_cross_site_request_is_refused_like_the_rest_of_the_api(self) -> None:
        status, _, _ = self.request("POST", "/api/rules", {"rules": []}, {"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("POST", "/api/rules", {"rules": []}, {"Origin": "http://evil.example"})
        self.assertEqual(status, 403)


class RulesCommandTests(unittest.TestCase):
    def test_the_commands_are_checked_and_cleaned(self) -> None:
        self.assertEqual(clean_command({"do": "rules_get"}), {"do": "rules_get"})
        done = clean_command({"do": "rules_set", "rules": [GOOD]})
        self.assertEqual(done["rules"][0]["when"]["days"], [1, 3, 5])
        for bad in (
            {"do": "rules_set"},
            {"do": "rules_set", "rules": "x"},
            {"do": "rules_set", "rules": [rule(do=[{"action": "eval"}])]},
            {"do": "rules_set", "rules": [GOOD, GOOD]},
        ):
            with self.assertRaises(ControlError, msg=str(bad)[:80]):
                clean_command(bad)

    def test_seeing_needs_read_and_changing_needs_control(self) -> None:
        self.assertEqual(command_level({"do": "rules_get"}), "read")
        self.assertEqual(command_level({"do": "rules_set"}), "control")
        self.assertGreaterEqual(COMMAND_TIMEOUTS["rules_set"], 120, "it ends in a question to the user")
        self.assertLess(COMMAND_TIMEOUTS["rules_get"], 60)


if __name__ == "__main__":
    unittest.main()


class PluginConfigCommandTests(unittest.TestCase):
    """Changing the settings of a plugin through the bus: checked here, then the app asks the user."""

    def test_the_command_is_checked_and_cleaned(self) -> None:
        done = clean_command(
            {"do": "plugin_config", "id": "mi-plugin", "values": {"ciudad": "Madrid", "grande": True, "segundos": 30}}
        )
        self.assertEqual(
            done,
            {"do": "plugin_config", "id": "mi-plugin", "values": {"ciudad": "Madrid", "grande": True, "segundos": 30}},
        )
        for bad in (
            {"id": "mi-plugin"},
            {"id": "mi-plugin", "values": {}},
            {"id": "mi-plugin", "values": "x"},
            {"id": "Mi Plugin", "values": {"a": 1}},
            {"id": "mi-plugin", "values": {"Mayúscula": 1}},
            {"id": "mi-plugin", "values": {"a": [1]}},
            {"id": "mi-plugin", "values": {"a": {"b": 1}}},
            {"id": "mi-plugin", "values": {"a": "x" * 501}},
            {"id": "mi-plugin", "values": {f"a{i}": 1 for i in range(21)}},
        ):
            with self.assertRaises(ControlError, msg=str(bad)[:80]):
                clean_command({"do": "plugin_config", **bad})

    def test_changing_settings_needs_the_plugins_level_and_time_for_the_question(self) -> None:
        self.assertEqual(command_level({"do": "plugin_config"}), "dev")
        self.assertGreaterEqual(COMMAND_TIMEOUTS["plugin_config"], 120)


class KeyTriggerTests(unittest.TestCase):
    def test_a_key_is_written_in_one_way_and_always_has_ctrl_or_alt(self) -> None:
        good = {
            "Alt+1": "Alt+1",
            "ctrl+shift+f5": "Ctrl+Shift+F5",
            "alt+ctrl+a": "Ctrl+Alt+A",
            "Alt+Ctrl+Shift+Z": "Ctrl+Alt+Shift+Z",
            "Ctrl+K": "Ctrl+K",
        }
        for given, canonical in good.items():
            self.assertEqual(rules.clean_when({"type": "key", "key": given}), {"type": "key", "key": canonical}, given)
        for bad in (
            "Shift+A",
            "1",
            "A",
            "Alt",
            "Alt+F13",
            "Alt+ab",
            "Alt+Alt+1",
            "Ctrl+Meta+1",
            "Alt+",
            "+Alt+1",
            5,
            None,
            "Alt+1+2",
        ):
            with self.assertRaises(ValueError, msg=repr(bad)):
                rules.clean_when({"type": "key", "key": bad})
        with self.assertRaises(ValueError):
            rules.clean_when({"type": "key", "key": "Alt+1", "extra": 1})

    def test_a_rule_by_key_is_a_rule_and_reads_as_a_sentence(self) -> None:
        done = rules.clean_rule(rule(id="uno", when={"type": "key", "key": "alt+1"}))
        self.assertEqual(done["when"], {"type": "key", "key": "Alt+1"})
        self.assertIn("al pulsar Alt+1", rules.describe_rule(done))


class PluginRulesTests(unittest.TestCase):
    def test_a_plugin_brings_rules_that_are_off_until_the_user_turns_them_on(self) -> None:
        with TemporaryDirectory() as folder:
            store = rules.RulesStore(Path(folder) / "rules.json")
            store.load()
            self.assertEqual(store.set_plugin("mi-plugin", [rule(id="uno", when={"type": "key", "key": "Alt+1"})]), 1)
            listed = store.plugin_rules()
            self.assertEqual(
                [(r["plugin"], r["enabled"], r["rule"]["id"]) for r in listed], [("mi-plugin", False, "uno")]
            )
            self.assertIn("al pulsar Alt+1", listed[0]["text"])
            self.assertTrue(store.set_plugin_enabled("mi-plugin", "uno", True))
            self.assertTrue(store.plugin_rules()[0]["enabled"])
            again = rules.RulesStore(Path(folder) / "rules.json")
            again.load()
            again.set_plugin("mi-plugin", [rule(id="uno", when={"type": "key", "key": "Alt+1"})])
            self.assertTrue(
                again.plugin_rules()[0]["enabled"],
                "the choice of the user is kept, and the plugin cannot make it for them",
            )
            store.set(store.get())  # saving the rules of the user keeps what was turned on
            self.assertEqual(
                json.loads((Path(folder) / "rules.json").read_text(encoding="utf-8"))["plugin_enabled"],
                ["mi-plugin/uno"],
            )

    def test_what_is_wrong_is_refused_and_empty_removes_them(self) -> None:
        store = rules.RulesStore(Path("unused.json"))
        store.set_plugin("p", [rule(id="a")])
        for bad in (
            [rule(id="b"), rule(id="b")],
            [rule(id="c", do=[])],
            [rule(id=f"r{i}") for i in range(rules.MAX_PLUGIN_RULES + 1)],
            "x",
        ):
            with self.assertRaises(ValueError, msg=str(bad)[:60]):
                store.set_plugin("p", bad)
        self.assertEqual(store.plugin_counts(), {"p": 1}, "a wrong list changes nothing")
        with self.assertRaises(ValueError):
            store.set_plugin("Mal Id", [rule(id="a")])
        self.assertEqual(store.set_plugin("p", []), 0)
        self.assertEqual(store.plugin_rules(), [])

    def test_only_a_rule_that_the_plugin_brings_can_be_turned_on(self) -> None:
        with TemporaryDirectory() as folder:
            store = rules.RulesStore(Path(folder) / "rules.json")
            store.set_plugin("p", [rule(id="a")])
            for args in (("p", "otra", True), ("nadie", "a", True), ("p", "a", "si")):
                with self.assertRaises(ValueError, msg=str(args)):
                    store.set_plugin_enabled(*args)


class PluginRulesRouteTests(ServerCase):
    def test_the_page_gives_the_rules_of_a_plugin_and_the_user_turns_one_on(self) -> None:
        brought = rule(id="uno", when={"type": "key", "key": "alt+1"})
        status, _, body = self.request("POST", "/api/rules/plugin", {"id": "mi-plugin", "rules": [brought]})
        self.assertEqual((status, json.loads(body)["count"]), (200, 1))
        listed = json.loads(self.request("GET", "/api/rules")[2])["plugin_rules"]
        self.assertEqual(
            (listed[0]["plugin"], listed[0]["enabled"], listed[0]["rule"]["when"]["key"]), ("mi-plugin", False, "Alt+1")
        )
        status, _, body = self.request(
            "POST", "/api/rules/plugin/enable", {"plugin": "mi-plugin", "rule": "uno", "on": True}
        )
        self.assertEqual((status, json.loads(body)["enabled"]), (200, True))
        self.assertTrue(json.loads(self.request("GET", "/api/rules")[2])["plugin_rules"][0]["enabled"])
        self.request("POST", "/api/rules/plugin", {"id": "mi-plugin", "rules": []})
        self.assertEqual(json.loads(self.request("GET", "/api/rules")[2])["plugin_rules"], [])

    def test_a_wrong_request_is_a_400_and_a_cross_site_one_is_refused(self) -> None:
        self.assertEqual(self.request("POST", "/api/rules/plugin", {"id": "p", "rules": [rule(do=[])]})[0], 400)
        self.assertEqual(
            self.request("POST", "/api/rules/plugin/enable", {"plugin": "p", "rule": "x", "on": True})[0], 400
        )
        for path in ("/api/rules/plugin", "/api/rules/plugin/enable"):
            self.assertEqual(
                self.request("POST", path, {"id": "p", "rules": []}, {"Sec-Fetch-Site": "cross-site"})[0], 403, path
            )
