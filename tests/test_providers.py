"""Channels that a plugin provides: what they may be, how they are kept, and the routes that replace them."""

from __future__ import annotations

import json
import unittest
from typing import Any

from tdtlocal import providers
from tdtlocal.store import Store

from .helpers import AppCase, ServerCase


def channel(name: str = "Canal Uno", **extra: Any) -> dict[str, Any]:
    return {"name": name, "sources": ["https://a.example/live.m3u8"], **extra}


class CleanChannelsTests(unittest.TestCase):
    def test_a_channel_becomes_a_channel_of_the_list_that_belongs_to_the_plugin(self) -> None:
        done = providers.clean_channels(
            "mi-lista", [channel(logo="https://a.example/l.png", web="https://a.example/", group="Noticias")]
        )[0]
        self.assertEqual(done["id"], "prov-mi-lista-canal-uno")
        self.assertEqual((done["category"], done["group"]), ("Plugin · mi-lista", "Noticias"))
        self.assertEqual((done["provider"], done["custom"], done["headers"]), ("mi-lista", False, {}))
        self.assertEqual(done["sources"], ["https://a.example/live.m3u8"])
        self.assertEqual(providers.clean_channels("p", [channel(category="Mis cosas")])[0]["category"], "Mis cosas")

    def test_the_ids_are_the_plugins_own_and_a_repeated_name_gets_a_number(self) -> None:
        ids = [c["id"] for c in providers.clean_channels("p", [channel(), channel(), channel("Otro")])]
        self.assertEqual(ids, ["prov-p-canal-uno", "prov-p-canal-uno-2", "prov-p-otro"])
        with self.assertRaises(
            ValueError, msg="a plugin cannot choose an id: it could take the one of another channel"
        ):
            providers.clean_channels("q", [channel(id="la-1")])

    def test_a_plugin_cannot_make_tdt_local_send_a_credential_nor_add_what_a_channel_does_not_have(self) -> None:
        for extra in (
            {"headers": {"Cookie": "a=b"}},
            {"custom": True},
            {"provider": "otro"},
            {"id": "x"},
            {"script": "1"},
        ):
            with self.assertRaises(ValueError, msg=str(extra)):
                providers.clean_channels("p", [channel(**extra)])

    def test_what_is_wrong_is_said_with_the_number_of_the_channel_and_nothing_is_kept(self) -> None:
        bad: list[Any] = [
            "x",
            [5],
            [channel(), {"name": "", "sources": ["https://a.example/x"]}],
            [{"name": "Sin enlace"}],
            [channel(sources=["file:///etc/passwd"])],
            [channel(sources=["https://a.example/x"] * (providers.MAX_SOURCES + 1))],
            [channel(name="x") for _ in range(providers.MAX_PROVIDED + 1)],
        ]
        for raw in bad:
            with self.assertRaises(ValueError, msg=str(raw)[:70]):
                providers.clean_channels("p", raw)
        with self.assertRaises(ValueError) as caught:
            providers.clean_channels("p", [channel(), {"name": "", "sources": ["https://a.example/x"]}])
        self.assertIn("canal 2", str(caught.exception))

    def test_the_id_of_a_plugin_is_checked(self) -> None:
        self.assertEqual(providers.clean_provider("mi-lista"), "mi-lista")
        for bad in ("", "Mayus", "con espacio", "x" * 41, "../x", 5, None):
            with self.assertRaises(ValueError, msg=repr(bad)):
                providers.clean_provider(bad)


class StoreProvidersTests(AppCase):
    def test_they_join_the_list_open_the_proxy_to_their_hosts_and_come_back_after_a_restart(self) -> None:
        store = self.app.store
        self.assertEqual(
            store.set_provided("mi-lista", [channel("A"), channel("B", sources=["https://otro.example/b.m3u8"])]), 2
        )
        ids = {c["id"] for c in store.all_channels()}
        self.assertLessEqual({"prov-mi-lista-a", "prov-mi-lista-b"}, ids)
        self.assertTrue(self.app.net.is_allowed("otro.example"))
        again = Store(self.app.config, self.app.net)
        again.load()
        self.assertEqual(again.provided_counts(), {"mi-lista": 2})

    def test_replacing_changes_all_of_them_and_an_empty_list_removes_them(self) -> None:
        store = self.app.store
        store.set_provided("p", [channel("A"), channel("B")])
        store.set_provided("p", [channel("C")])
        self.assertEqual([c["name"] for c in store.provided["p"]], ["C"])
        store.set_provided("p", [])
        self.assertEqual(store.provided_counts(), {})
        self.assertFalse([c for c in store.all_channels() if c.get("provider")])

    def test_a_wrong_list_changes_nothing_and_there_is_a_limit_of_plugins(self) -> None:
        store = self.app.store
        store.set_provided("p", [channel("A")])
        with self.assertRaises(ValueError):
            store.set_provided("p", [channel("B"), {"name": ""}])
        self.assertEqual([c["name"] for c in store.provided["p"]], ["A"])
        for i in range(providers.MAX_PROVIDERS - 1):
            store.set_provided(f"p{i}", [channel("X")])
        with self.assertRaises(ValueError):
            store.set_provided("de-mas", [channel("X")])
        store.set_provided("p", [channel("Z")])  # one that already provides can still replace its own


class ProvidersRouteTests(ServerCase):
    def test_the_page_replaces_what_a_plugin_provides_and_the_list_shows_it(self) -> None:
        status, _, body = self.request(
            "POST", "/api/providers", {"id": "mi-lista", "channels": [channel("A"), channel("B")]}
        )
        self.assertEqual((status, json.loads(body)["count"]), (200, 2))
        status, _, body = self.request("GET", "/api/providers")
        self.assertEqual(json.loads(body)["providers"], {"mi-lista": 2})
        _, _, body = self.request("GET", "/api/channels")
        mine = [c for c in json.loads(body)["channels"] if c.get("provider") == "mi-lista"]
        self.assertEqual(sorted(c["name"] for c in mine), ["A", "B"])
        self.assertTrue(all(c["category"] == "Plugin · mi-lista" for c in mine))
        self.request("POST", "/api/providers", {"id": "mi-lista", "channels": []})
        self.assertEqual(json.loads(self.request("GET", "/api/providers")[2])["providers"], {})

    def test_a_wrong_request_is_a_400_and_a_cross_site_one_is_refused(self) -> None:
        status, _, body = self.request("POST", "/api/providers", {"id": "mi-lista", "channels": [{"name": ""}]})
        self.assertEqual(status, 400)
        self.assertIn("canal 1", json.loads(body)["error"])
        self.assertEqual(self.request("POST", "/api/providers", {"id": "X", "channels": []})[0], 400)
        self.assertEqual(
            self.request("POST", "/api/providers", {"id": "p", "channels": []}, {"Sec-Fetch-Site": "cross-site"})[0],
            403,
        )
        self.assertEqual(
            self.request("POST", "/api/providers", {"id": "p", "channels": []}, {"Origin": "http://evil.example"})[0],
            403,
        )


if __name__ == "__main__":
    unittest.main()


NOW = 1_800_000_000


def programme(start: int = NOW, minutes: int = 30, title: str = "Telediario", *extra: Any) -> list[Any]:
    return [start, start + minutes * 60, title, *extra]


class CleanGuideTests(unittest.TestCase):
    def test_a_guide_lives_under_the_plugin_name_and_what_is_over_is_dropped(self) -> None:
        guide = providers.clean_guide(
            "mi-lista",
            {
                "uno": [
                    programme(NOW + 1800, 30, "Cine", "Una peli", "Cine"),
                    programme(NOW - 7200, 30, "Viejo"),
                    programme(NOW, 30, "Ahora"),
                ]
            },
            NOW,
        )
        self.assertEqual(list(guide), ["mi-lista:uno"])
        self.assertEqual([p[2] for p in guide["mi-lista:uno"]], ["Ahora", "Cine"], "sorted by start, the old one gone")
        self.assertEqual(guide["mi-lista:uno"][1], [NOW + 1800, NOW + 3600, "Cine", "Una peli", "Cine"])
        self.assertEqual(
            guide["mi-lista:uno"][0][3:], ["", ""], "no description or category: empty, like the guides of the lists"
        )
        self.assertEqual(
            providers.clean_guide("p", {"x": [programme(NOW - 9000)]}, NOW),
            {},
            "a channel with nothing left is not kept",
        )

    def test_what_is_wrong_is_said_with_the_channel_and_the_programme_and_nothing_is_kept(self) -> None:
        bad: list[Any] = [
            [],
            {"": [programme()]},
            {"x" * 81: [programme()]},
            {"a\nb": [programme()]},
            {"a": "no"},
            {"a": [programme()] * (providers.MAX_GUIDE_PROGRAMMES + 1)},
            {"a": [[NOW, NOW + 60]]},
            {"a": [[NOW, NOW + 60, "t", "d", "c", "extra"]]},
            {"a": [["x", NOW + 60, "t"]]},
            {"a": [[True, NOW + 60, "t"]]},
            {"a": [[NOW, NOW - 60, "t"]]},
            {"a": [[NOW, NOW, "t"]]},
            {"a": [[NOW, NOW + 25 * 3600, "t"]]},
            {"a": [[NOW, NOW + 60, ""]]},
            {"a": [[NOW, NOW + 60, 5]]},
            {"a": [[NOW, NOW + 60, "t" * 201]]},
            {"a": [[NOW, NOW + 60, "t", "d" * 501]]},
            {"a": [[NOW, NOW + 60, "t", "d", "c" * 61]]},
            {"a": [[NOW, NOW + 60, "t", 7]]},
            {f"c{i}": [programme()] for i in range(providers.MAX_GUIDE_IDS + 1)},
        ]
        for raw in bad:
            with self.assertRaises(ValueError, msg=str(raw)[:70]):
                providers.clean_guide("p", raw, NOW)
        with self.assertRaises(ValueError) as caught:
            providers.clean_guide("p", {"uno": [programme(), [NOW, NOW - 1, "t"]]}, NOW)
        self.assertIn("«uno», programa 2", str(caught.exception))


class StoreGuideTests(AppCase):
    def test_the_guide_of_a_plugin_joins_the_payload_and_never_replaces_the_one_of_the_lists(self) -> None:
        store = self.app.store
        store.epg["tv"]["La1.TV"] = [programme(int(__import__("time").time()) - 60, 60, "De la lista")]
        now = int(__import__("time").time())
        self.assertEqual(
            store.set_provided_epg(
                "mi-lista", {"La1.TV": [programme(now - 60, 60, "Del plugin")], "uno": [programme(now - 60, 60, "Mío")]}
            ),
            2,
        )
        payload = self.app.epg.payload()
        self.assertEqual(
            payload["now"]["La1.TV"][0][2], "De la lista", "the plugin cannot take over a channel of the lists"
        )
        self.assertEqual(payload["now"]["mi-lista:La1.TV"][0][2], "Del plugin")
        self.assertEqual(self.app.epg.payload("mi-lista:uno")["programmes"][0][2], "Mío")
        self.assertEqual(store.provided_epg_counts(), {"mi-lista": 2})
        self.assertEqual(store.set_provided_epg("mi-lista", {}), 0)
        self.assertNotIn("mi-lista:uno", self.app.epg.payload()["now"])

    def test_a_wrong_guide_changes_nothing(self) -> None:
        store = self.app.store
        now = int(__import__("time").time())
        store.set_provided_epg("p", {"a": [programme(now, 30, "Uno")]})
        with self.assertRaises(ValueError):
            store.set_provided_epg("p", {"a": [programme(now, 30, "Dos")], "b": "mal"})
        self.assertEqual(store.epg_plugins["p"]["p:a"][0][2], "Uno")


class GuideRouteTests(ServerCase):
    def test_the_page_replaces_the_guide_of_a_plugin(self) -> None:
        now = int(__import__("time").time())
        status, _, body = self.request(
            "POST", "/api/providers/epg", {"id": "mi-lista", "guide": {"uno": [programme(now - 60, 60, "Mío")]}}
        )
        self.assertEqual((status, json.loads(body)["count"]), (200, 1))
        self.assertEqual(json.loads(self.request("GET", "/api/providers")[2])["epg"], {"mi-lista": 1})
        self.assertEqual(json.loads(self.request("GET", "/api/epg?id=mi-lista:uno")[2])["programmes"][0][2], "Mío")
        self.request("POST", "/api/providers/epg", {"id": "mi-lista", "guide": {}})
        self.assertEqual(json.loads(self.request("GET", "/api/providers")[2])["epg"], {})

    def test_a_wrong_guide_is_a_400_and_a_cross_site_request_is_refused(self) -> None:
        self.assertEqual(self.request("POST", "/api/providers/epg", {"id": "p", "guide": {"a": "mal"}})[0], 400)
        self.assertEqual(
            self.request("POST", "/api/providers/epg", {"id": "p", "guide": {}}, {"Sec-Fetch-Site": "cross-site"})[0],
            403,
        )
