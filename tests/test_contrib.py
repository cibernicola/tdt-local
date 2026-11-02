"""contrib/omarchy: the files that go to the user's desktop are consistent with each other."""

from __future__ import annotations

import json
import re
import unittest

from tdtlocal.config import PROJECT_DIR

OMARCHY = PROJECT_DIR / "contrib" / "omarchy"


def jsonc(path):
    """JSON with ``//`` comment lines."""
    text = path.read_text(encoding="utf-8")
    return json.loads("\n".join(line for line in text.splitlines() if not line.lstrip().startswith("//")))


class Omarchy(unittest.TestCase):
    def test_the_widget_manifest_matches_its_folder_and_its_qml(self):
        folder = OMARCHY / "plugin" / "tdtlocal.tdtv"
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["id"], folder.name)
        self.assertEqual(manifest["kinds"], ["bar-widget"])
        self.assertTrue((folder / manifest["entryPoints"]["barWidget"]).is_file())
        qml = (folder / manifest["entryPoints"]["barWidget"]).read_text(encoding="utf-8")
        self.assertIn(f'moduleName: "{manifest["id"]}"', qml)

    def test_the_menu_entries_are_valid_and_every_child_has_a_parent(self):
        entries = jsonc(OMARCHY / "menu.jsonc")
        for key, entry in entries.items():
            with self.subTest(key):
                self.assertTrue(entry["label"])
                if "." in key:
                    self.assertIn(key.rsplit(".", 1)[0], entries)  # "tv.fx.vhs" lives under "tv.fx"
                if not any(other.startswith(key + ".") for other in entries):  # a submenu has no action, a leaf does
                    self.assertIn("action", entry)
                if "action" in entry:
                    self.assertTrue(entry["action"].startswith("tdtv "))

    def test_the_unit_runs_the_server_on_localhost_only(self):
        unit = (OMARCHY / "tdt-local.service").read_text(encoding="utf-8")
        self.assertRegex(unit, r"(?m)^ExecStart=.* -m tdtlocal .*--host 127\.0\.0\.1")
        self.assertNotIn("--lan", unit)

    def test_the_skill_names_only_commands_that_exist(self):
        skill = (OMARCHY / "skill" / "SKILL.md").read_text(encoding="utf-8")
        self.assertTrue(skill.startswith("---\nname: tdtv\n"))
        commands = {
            "list",
            "cats",
            "now",
            "play",
            "status",
            "pause",
            "resume",
            "toggle",
            "mute",
            "stop",
            "fullscreen",
            "vol",
            "next",
            "prev",
            "fx",
            "ttx",
            "web",
        }
        mentioned = set(re.findall(r"`tdtv ([a-z]+)", skill))
        self.assertTrue(mentioned)
        self.assertLessEqual(mentioned, commands)


if __name__ == "__main__":
    unittest.main()
