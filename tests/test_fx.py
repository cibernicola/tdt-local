"""Image effects: every effect in fx.json has its shader, in the form both WebGL2 and mpv can use."""

from __future__ import annotations

import json
import unittest

from tdtlocal.config import PROJECT_DIR

FX = PROJECT_DIR / "tdtlocal" / "static" / "fx"


class Effects(unittest.TestCase):
    def setUp(self):
        self.defs = json.loads((FX / "fx.json").read_text(encoding="utf-8"))

    def test_the_list_is_not_empty_and_each_entry_is_complete(self):
        self.assertGreaterEqual(len(self.defs), 10)
        for name, d in self.defs.items():
            with self.subTest(name):
                self.assertTrue(d["label"] and d["desc"])
                self.assertTrue((FX / d["shader"]).is_file())

    def test_every_shader_is_a_hook_the_page_can_wrap(self):
        files = {d["shader"] for d in self.defs.values()}
        self.assertEqual(files, {p.name for p in FX.glob("*.glsl")})  # nothing unused, nothing missing
        for shader in files:
            with self.subTest(shader):
                text = (FX / shader).read_text(encoding="utf-8")
                self.assertTrue(text.startswith("//!HOOK OUTPUT\n//!BIND HOOKED\n"))
                self.assertIn("vec4 hook()", text)
                self.assertNotIn("#version", text)  # the page adds it
                self.assertNotIn("void main", text)


if __name__ == "__main__":
    unittest.main()
