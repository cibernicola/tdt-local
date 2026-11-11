"""The MCP server: the JSON-RPC core, its tools by level, stdio, the app's own /mcp route and a real stdio process."""

from __future__ import annotations

import http.client
import io
import json
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path
from typing import Any, ClassVar

from tdtlocal import control_data, mcp
from tdtlocal.mcp import BackendError, LocalBackend, McpServer, RemoteBackend, check, discover, serve_stdio

from .helpers import AppCase, ServerCase
from .test_control import FakePage

ROOT = Path(__file__).resolve().parent.parent


def channel(cid: str, name: str, kind: str = "tv", **extra: Any) -> dict[str, Any]:
    return {
        "id": cid,
        "name": name,
        "kind": kind,
        "cat": "Nacionales",
        "sources": ["http://x/" + cid],
        "epg": cid,
        **extra,
    }


class FakeBackend:
    """What the tools need, with canned answers and a record of what was asked."""

    def __init__(self, level: str | None = "control") -> None:
        self._level = level
        self.calls: list[tuple[str, Any]] = []
        self.command_result: dict[str, Any] = {"ok": True, "detail": "La 2"}

    def level(self) -> str | None:
        return self._level

    def state(self) -> dict[str, Any]:
        self.calls.append(("state", None))
        return {"kind": "tv", "tiles": []}

    def channels(self, query: str, kind: str, limit: int) -> dict[str, Any]:
        self.calls.append(("channels", (query, kind, limit)))
        return {"total": 0, "shown": 0, "channels": []}

    def guide(self, channel_ref: str) -> dict[str, Any]:
        self.calls.append(("guide", channel_ref))
        if channel_ref == "nada":
            raise BackendError("no hay ningún canal «nada»")
        return {"channel": {"id": "a", "name": "A"}, "programmes": []}

    def markers(self, limit: int) -> dict[str, Any]:
        self.calls.append(("markers", limit))
        return {"enabled": False, "events": []}

    def command(self, cmd: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("command", cmd))
        return self.command_result


def rpc(server: McpServer, method: str, params: Any = None, mid: Any = 1) -> dict[str, Any]:
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": mid, "method": method}
    if params is not None:
        message["params"] = params
    answer = server.handle(message)
    assert answer is not None
    return answer


class SchemaTests(unittest.TestCase):
    schema: ClassVar[dict[str, Any]] = {
        "type": "object",
        "properties": {
            "s": {"type": "string", "minLength": 1, "maxLength": 5, "enum": ["a", "bb"]},
            "n": {"type": "integer", "minimum": 1, "maximum": 3},
            "x": {"type": "number", "minimum": 0, "maximum": 1},
            "b": {"type": "boolean"},
            "l": {"type": "array", "minItems": 1, "maxItems": 2, "items": {"type": "string", "minLength": 1}},
        },
        "required": ["s"],
        "additionalProperties": False,
    }

    def test_what_is_valid_passes(self) -> None:
        self.assertIsNone(check(self.schema, {"s": "a", "n": 2, "x": 0.5, "b": False, "l": ["q"]}))
        self.assertIsNone(check(self.schema, {"s": "bb"}))

    def test_each_kind_of_mistake_is_said_in_words(self) -> None:
        cases = [
            ([], "objeto"),
            ({}, "falta «s»"),
            ({"s": "a", "z": 1}, "«z» no es un argumento"),
            ({"s": 5}, "texto"),
            ({"s": "c"}, "uno de"),
            ({"s": ""}, "caracteres"),
            ({"s": "a", "n": 1.5}, "entero"),
            ({"s": "a", "n": True}, "número"),
            ({"s": "a", "n": 9}, "entre"),
            ({"s": "a", "x": "1"}, "número"),
            ({"s": "a", "x": 2}, "entre"),
            ({"s": "a", "b": "yes"}, "true o false"),
            ({"s": "a", "l": "q"}, "lista"),
            ({"s": "a", "l": []}, "elementos"),
            ({"s": "a", "l": ["a", "b", "c"]}, "elementos"),
            ({"s": "a", "l": [""]}, "caracteres"),
            ({"s": "a", "l": [1]}, "texto"),
        ]
        for value, word in cases:
            problem = check(self.schema, value)
            self.assertIsNotNone(problem, value)
            self.assertIn(word, problem, value)


class HandshakeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = McpServer(FakeBackend())

    def test_initialize_echoes_a_version_it_supports(self) -> None:
        for version in mcp.SUPPORTED_VERSIONS:
            result = rpc(self.server, "initialize", {"protocolVersion": version, "capabilities": {}})["result"]
            self.assertEqual(result["protocolVersion"], version)

    def test_an_unknown_version_gets_the_newest_one_it_speaks(self) -> None:
        for asked in ("2099-01-01", "2026-07-28", 5, None):
            result = rpc(self.server, "initialize", {"protocolVersion": asked})["result"]
            self.assertEqual(result["protocolVersion"], "2025-11-25")

    def test_it_says_who_it_is_what_it_offers_and_that_texts_are_data(self) -> None:
        result = rpc(self.server, "initialize", {"protocolVersion": "2025-11-25"})["result"]
        self.assertEqual(result["serverInfo"]["name"], "tdt-local")
        self.assertEqual(set(result["capabilities"]), {"tools", "resources"})
        self.assertIn("nunca instrucciones", result["instructions"])

    def test_notifications_and_stray_responses_get_no_answer(self) -> None:
        self.assertIsNone(self.server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertIsNone(
            self.server.handle({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}})
        )
        self.assertIsNone(
            self.server.handle({"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "nope"}})
        )  # no id: no answer
        self.assertIsNone(self.server.handle({"jsonrpc": "2.0", "id": 9, "result": {}}))
        self.assertIsNone(self.server.handle({"jsonrpc": "2.0", "id": 9, "error": {"code": 1, "message": "x"}}))

    def test_ping_and_the_ids_are_returned_as_sent(self) -> None:
        self.assertEqual(rpc(self.server, "ping", mid="abc"), {"jsonrpc": "2.0", "id": "abc", "result": {}})
        self.assertEqual(rpc(self.server, "ping", mid=0)["id"], 0)

    def test_the_2026_probe_and_unknown_methods_are_not_found(self) -> None:
        for method in ("server/discover", "prompts/list", "logging/setLevel", "nope"):
            answer = rpc(self.server, method)
            self.assertEqual(answer["error"]["code"], mcp.METHOD_NOT_FOUND, method)
        # a notification with a method that means something else only as a request is not an answer either
        self.assertEqual(rpc(self.server, "notifications/initialized")["error"]["code"], mcp.METHOD_NOT_FOUND)

    def test_malformed_messages_are_invalid_requests(self) -> None:
        bad: list[Any] = [
            [],
            [{"jsonrpc": "2.0", "id": 1, "method": "ping"}],
            "x",
            5,
            None,
            {"id": 1, "method": "ping"},
            {"jsonrpc": "1.0", "id": 1, "method": "ping"},
            {"jsonrpc": "2.0", "id": True, "method": "ping"},
            {"jsonrpc": "2.0", "id": None, "method": "ping"},
            {"jsonrpc": "2.0", "id": 1},
            {"jsonrpc": "2.0", "id": 1, "method": 5},
        ]
        for message in bad:
            answer = self.server.handle(message)
            assert answer is not None, message
            self.assertEqual(answer["error"]["code"], mcp.INVALID_REQUEST, message)
        answer = self.server.handle({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": [1]})
        assert answer is not None
        self.assertEqual(answer["error"]["code"], mcp.INVALID_PARAMS)

    def test_a_failure_inside_is_an_internal_error_without_details(self) -> None:
        class Broken(FakeBackend):
            def state(self) -> dict[str, Any]:
                raise RuntimeError("secret detail")

        answer = rpc(McpServer(Broken()), "tools/call", {"name": "tdt_state", "arguments": {}})
        self.assertEqual(answer["error"]["code"], mcp.INTERNAL_ERROR)
        self.assertEqual(answer["error"]["message"], "error interno")
        self.assertNotIn("secret detail", json.dumps(answer))


READ_TOOLS = [
    "tdt_state",
    "tdt_search_channels",
    "tdt_guide",
    "tdt_ad_markers",
    "tdt_headers_get",
    "tdt_rules_get",
    "tdt_commands",
    "tdt_plugin_calls",
    "tdt_events",
    "tdt_plugins",
    "tdt_plugin_logs",
    "tdt_plugin_api",
]


class ToolListTests(unittest.TestCase):
    def names(self, level: str | None) -> list[str]:
        return [t["name"] for t in rpc(McpServer(FakeBackend(level)), "tools/list")["result"]["tools"]]

    def test_read_level_lists_only_the_reading_tools(self) -> None:
        self.assertEqual(self.names("read"), READ_TOOLS)

    def test_control_level_lists_the_reading_and_the_control_tools(self) -> None:
        self.assertEqual(len(self.names("control")), 18)
        self.assertEqual(self.names("control"), [t.name for t in mcp.TOOLS if t.level != "dev"])

    def test_dev_level_lists_everything_including_the_plugin_tools(self) -> None:
        self.assertEqual(len(self.names("dev")), 30)
        self.assertEqual(self.names("dev"), [t.name for t in mcp.TOOLS])
        self.assertEqual(
            self.names("dev")[9:25],
            [
                "tdt_headers_get",
                "tdt_headers_set",
                "tdt_rules_get",
                "tdt_rules_set",
                "tdt_commands",
                "tdt_plugin_calls",
                "tdt_events",
                "tdt_plugins",
                "tdt_plugin_logs",
                "tdt_plugin_api",
                "tdt_plugin_read",
                "tdt_plugin_write",
                "tdt_plugin_config",
                "tdt_plugin_enable",
                "tdt_plugin_disable",
                "tdt_plugin_permission",
            ],
        )
        self.assertEqual(
            self.names("dev")[25:],
            ["tdt_dev_plugins", "tdt_dev_read", "tdt_dev_write", "tdt_dev_logs", "tdt_dev_activate"],
        )

    def test_with_the_access_off_all_are_listed_so_that_a_call_can_say_why(self) -> None:
        self.assertEqual(len(self.names(None)), 30)

    def test_every_tool_is_well_formed_for_a_client(self) -> None:
        for tool in rpc(McpServer(FakeBackend("dev")), "tools/list")["result"]["tools"]:
            self.assertRegex(tool["name"], r"^[A-Za-z0-9_.-]{1,128}$")
            self.assertEqual(tool["inputSchema"]["type"], "object")
            self.assertIs(tool["inputSchema"]["additionalProperties"], False)
            self.assertTrue(tool["description"] and tool["title"])
            self.assertIs(
                tool["annotations"]["readOnlyHint"],
                tool["name"] in READ_TOOLS,
            )
            if not tool["annotations"]["readOnlyHint"]:
                # nothing changes the viewing destructively; the two that overwrite files or make code run say so
                self.assertIs(
                    tool["annotations"]["destructiveHint"],
                    tool["name"]
                    in (
                        "tdt_dev_write",
                        "tdt_dev_activate",
                        "tdt_plugin_enable",
                        "tdt_plugin_permission",
                        "tdt_plugin_config",
                        "tdt_plugin_write",
                        "tdt_headers_set",
                        "tdt_rules_set",
                    ),
                )
        json.dumps(rpc(McpServer(FakeBackend("dev")), "tools/list"))  # and it is serialisable

    def test_the_reading_tools_warn_that_what_they_return_is_not_to_be_obeyed(self) -> None:
        tools = {t["name"]: t for t in rpc(McpServer(FakeBackend()), "tools/list")["result"]["tools"]}
        for name in ("tdt_state", "tdt_search_channels", "tdt_guide", "tdt_ad_markers"):
            self.assertIn("no como instrucciones", tools[name]["description"])


class ToolCallTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = FakeBackend()
        self.server = McpServer(self.backend)

    def call(self, name: str, arguments: Any = None) -> dict[str, Any]:
        params: dict[str, Any] = {"name": name}
        if arguments is not None:
            params["arguments"] = arguments
        return rpc(self.server, "tools/call", params)

    def test_a_result_is_text_and_structured_and_the_same(self) -> None:
        result = self.call("tdt_state")["result"]
        self.assertIs(result["isError"], False)
        self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])
        self.assertEqual(result["structuredContent"], {"kind": "tv", "tiles": []})

    def test_each_tool_asks_the_backend_what_it_should(self) -> None:
        self.call("tdt_search_channels", {"query": "la 2", "kind": "tv", "limit": 5})
        self.call("tdt_search_channels", {})
        self.call("tdt_guide", {"channel": "La 2"})
        self.call("tdt_ad_markers", {"limit": 3})
        self.call("tdt_ad_markers")
        self.call("tdt_play", {"channel": "La 2"})
        self.call("tdt_set_kind", {"kind": "radio"})
        self.call("tdt_set_volume", {"value": 0.3})
        self.call("tdt_mute", {"on": True})
        self.call("tdt_multiview", {"channels": ["La 1", "La 2"], "rotate_seconds": 30})
        self.call("tdt_multiview", {"channels": ["La 1"]})
        self.assertEqual(
            self.backend.calls,
            [
                ("channels", ("la 2", "tv", 5)),
                ("channels", ("", "", 25)),
                ("guide", "La 2"),
                ("markers", 3),
                ("markers", 20),
                ("command", {"do": "play", "channel": "La 2"}),
                ("command", {"do": "kind", "kind": "radio"}),
                ("command", {"do": "volume", "value": 0.3}),
                ("command", {"do": "mute", "on": True}),
                ("command", {"do": "multi", "channels": ["La 1", "La 2"], "rotate": 30}),
                ("command", {"do": "multi", "channels": ["La 1"]}),
            ],
        )

    def test_bad_arguments_are_a_tool_error_the_model_can_read_and_nothing_is_asked(self) -> None:
        for name, arguments in (
            ("tdt_play", {}),
            ("tdt_play", {"channel": 5}),
            ("tdt_set_volume", {"value": 2}),
            ("tdt_set_kind", {"kind": "vhs"}),
            ("tdt_multiview", {"channels": []}),
            ("tdt_state", {"x": 1}),
            ("tdt_play", {"channel": "a", "extra": 1}),
            ("tdt_play", "no"),
        ):
            result = self.call(name, arguments)["result"]
            self.assertIs(result["isError"], True, (name, arguments))
            self.assertIn("argumentos no válidos", result["content"][0]["text"])
        self.assertEqual(self.backend.calls, [])

    def test_an_unknown_tool_is_a_protocol_error(self) -> None:
        for name in ("nope", "", 5, None):
            answer = rpc(self.server, "tools/call", {"name": name})
            self.assertEqual(answer["error"]["code"], mcp.INVALID_PARAMS, name)

    def test_what_the_backend_refuses_is_a_tool_error_with_its_reason(self) -> None:
        result = self.call("tdt_guide", {"channel": "nada"})["result"]
        self.assertIs(result["isError"], True)
        self.assertIn("no hay ningún canal", result["content"][0]["text"])

    def test_a_page_that_could_not_do_it_is_a_tool_error_and_one_that_did_is_not(self) -> None:
        self.backend.command_result = {"ok": False, "detail": "no hay ningún canal «x» que se pueda reproducir"}
        result = self.call("tdt_play", {"channel": "x"})["result"]
        self.assertIs(result["isError"], True)
        self.assertIn("«x»", result["content"][0]["text"])
        self.backend.command_result = {"ok": True, "detail": "La 2"}
        ok = self.call("tdt_play", {"channel": "La 2"})["result"]
        self.assertIs(ok["isError"], False)
        self.assertEqual(ok["structuredContent"], {"ok": True, "detail": "La 2"})

    def test_the_state_is_also_a_resource(self) -> None:
        listed = rpc(self.server, "resources/list")["result"]["resources"]
        self.assertEqual(
            [r["uri"] for r in listed], [mcp.STATE_URI, mcp.GUIDE_URI, mcp.PLUGINS_URI, mcp.PLUGIN_API_URI]
        )
        contents = rpc(self.server, "resources/read", {"uri": mcp.STATE_URI})["result"]["contents"]
        self.assertEqual(json.loads(contents[0]["text"]), {"kind": "tv", "tiles": []})
        self.assertEqual(
            rpc(self.server, "resources/read", {"uri": "file:///etc/passwd"})["error"]["code"], mcp.INVALID_PARAMS
        )
        self.assertEqual(rpc(self.server, "resources/templates/list")["result"], {"resourceTemplates": []})


class SlowAppTests(unittest.TestCase):
    """With the app closed every request to it is slow to fail on Windows (about two seconds): listing must ask once."""

    def test_the_tools_list_asks_the_app_for_the_level_only_once(self) -> None:
        asked: list[int] = []

        class Counting(FakeBackend):
            def level(self) -> str | None:
                asked.append(1)
                return super().level()

        rpc(McpServer(Counting("dev")), "tools/list")
        self.assertEqual(len(asked), 1)


class StrippedEnvironmentTests(unittest.TestCase):
    """Some MCP clients start a server with almost no environment variables (some do): it must still answer."""

    def test_the_remote_backend_does_not_need_an_ssl_context(self) -> None:
        import ssl
        from unittest import mock

        with mock.patch.object(ssl, "_create_default_https_context", side_effect=ssl.SSLError("sin SYSTEMROOT")):
            backend = RemoteBackend("http://127.0.0.1:1", "token")  # it used to raise here
        with self.assertRaises(BackendError):  # nothing listens there: a clear error, not a crash
            backend.state()

    def test_the_server_answers_initialize_with_only_the_variables_python_needs_to_start(self) -> None:
        import subprocess
        import sys

        env = {"PYTHONPATH": str(ROOT)}
        if os.name == "nt":  # Python itself cannot start on Windows without this one
            env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", "C:\\Windows")
        init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}
        done = subprocess.run(
            [sys.executable, "-m", "tdtlocal.mcp", "--url", "http://127.0.0.1:1"],
            input=json.dumps(init) + "\n",
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            env=env,
            check=False,
        )
        self.assertEqual(
            json.loads(done.stdout.splitlines()[0])["result"]["serverInfo"]["name"], "tdt-local", done.stderr[-300:]
        )
        self.assertNotIn("�", done.stderr, "the log is UTF-8 even when the console of the machine is not")


class HeaderToolTests(unittest.TestCase):
    """The headers of a channel through the MCP: seeing them needs «read», changing them needs «plugins»."""

    def setUp(self) -> None:
        self.backend = FakeBackend("dev")
        self.server = McpServer(self.backend)

    def call(self, name: str, arguments: Any) -> dict[str, Any]:
        return rpc(self.server, "tools/call", {"name": name, "arguments": arguments})["result"]

    def test_each_tool_sends_the_command_the_bus_expects(self) -> None:
        self.call("tdt_headers_get", {"channel": "La 2"})
        self.call("tdt_headers_set", {"channel": "la-2", "headers": {"Referer": "https://r/", "Cookie": None}})
        self.call("tdt_headers_set", {"channel": "la-2", "headers": {"Origin": "https://o/"}, "replace": True})
        self.assertEqual(
            self.backend.calls,
            [
                ("command", {"do": "headers_get", "channel": "La 2"}),
                (
                    "command",
                    {
                        "do": "headers_set",
                        "channel": "la-2",
                        "headers": {"Referer": "https://r/", "Cookie": None},
                        "replace": False,
                    },
                ),
                (
                    "command",
                    {"do": "headers_set", "channel": "la-2", "headers": {"Origin": "https://o/"}, "replace": True},
                ),
            ],
        )

    def test_seeing_needs_read_and_changing_needs_the_plugins_level(self) -> None:
        names = lambda level: {t["name"] for t in rpc(McpServer(FakeBackend(level)), "tools/list")["result"]["tools"]}  # noqa: E731
        self.assertIn("tdt_headers_get", names("read"))
        self.assertNotIn("tdt_headers_set", names("read"))
        self.assertNotIn("tdt_headers_set", names("control"))
        self.assertIn("tdt_headers_set", names("dev"))

    def test_the_arguments_are_checked_before_anything_is_sent(self) -> None:
        for name, arguments in (
            ("tdt_headers_get", {}),
            ("tdt_headers_get", {"channel": ""}),
            ("tdt_headers_set", {"channel": "a"}),
            ("tdt_headers_set", {"channel": "a", "headers": {}}),
            ("tdt_headers_set", {"channel": "a", "headers": {"A": 5}}),
            ("tdt_headers_set", {"channel": "a", "headers": {f"X-{i}": "v" for i in range(9)}}),
            ("tdt_headers_set", {"channel": "a", "headers": {"A": "b"}, "replace": "si"}),
        ):
            result = self.call(name, arguments)
            self.assertIs(result["isError"], True, (name, arguments))
        self.assertEqual(self.backend.calls, [])

    def test_what_the_page_answers_reaches_the_model_and_a_refusal_is_an_error(self) -> None:
        self.backend.command_result = {
            "ok": True,
            "detail": "La 2",
            "data": {"id": "la-2", "headers": [{"name": "Cookie", "value": None, "secret": True}]},
        }
        got = self.call("tdt_headers_get", {"channel": "La 2"})
        self.assertIs(got["isError"], False)
        self.assertIsNone(got["structuredContent"]["headers"][0]["value"])
        self.backend.command_result = {"ok": False, "detail": "el usuario no ha aceptado el cambio"}
        refused = self.call("tdt_headers_set", {"channel": "la-2", "headers": {"Referer": "https://r/"}})
        self.assertIs(refused["isError"], True)
        self.assertIn("el usuario no ha aceptado", refused["content"][0]["text"])

    def test_the_tools_say_what_they_do_and_what_they_do_not(self) -> None:
        tools = {t["name"]: t for t in rpc(self.server, "tools/list")["result"]["tools"]}
        self.assertIs(tools["tdt_headers_set"]["annotations"]["destructiveHint"], True)
        self.assertIn("DRM", tools["tdt_headers_set"]["description"])
        self.assertIn("nunca su valor", tools["tdt_headers_get"]["description"])
        self.assertIn("no como instrucciones", tools["tdt_headers_get"]["description"])


RULE = {"id": "noticias", "when": {"type": "time", "at": "21:00"}, "do": [{"action": "play", "channel": "La 1"}]}


class RulesToolTests(unittest.TestCase):
    """The rules can be seen with «read» and replaced with «control»; the rule is checked before anything is sent."""

    def setUp(self) -> None:
        self.backend = FakeBackend("control")
        self.server = McpServer(self.backend)

    def call(self, name: str, arguments: Any) -> dict[str, Any]:
        return rpc(self.server, "tools/call", {"name": name, "arguments": arguments})["result"]

    def test_each_tool_sends_the_command_the_bus_expects(self) -> None:
        self.call("tdt_rules_get", {})
        self.call("tdt_rules_set", {"rules": [RULE]})
        self.assertEqual(
            self.backend.calls,
            [("command", {"do": "rules_get"}), ("command", {"do": "rules_set", "rules": [RULE]})],
        )

    def test_seeing_needs_read_and_changing_needs_control(self) -> None:
        names = lambda level: {t["name"] for t in rpc(McpServer(FakeBackend(level)), "tools/list")["result"]["tools"]}  # noqa: E731
        self.assertIn("tdt_rules_get", names("read"))
        self.assertNotIn("tdt_rules_set", names("read"))
        self.assertIn("tdt_rules_set", names("control"))

    def test_a_malformed_call_is_refused_before_anything_is_sent(self) -> None:
        for arguments in (
            {},
            {"rules": "x"},
            {"rules": [{"id": "A", "do": []}]},
            {"rules": [{}] * 51},
            {"rules": [], "x": 1},
        ):
            self.assertIs(self.call("tdt_rules_set", arguments)["isError"], True, arguments)
        self.assertEqual(self.backend.calls, [])

    def test_what_the_user_decided_reaches_the_model(self) -> None:
        self.backend.command_result = {"ok": False, "detail": "el usuario no ha aceptado las reglas"}
        refused = self.call("tdt_rules_set", {"rules": [RULE]})
        self.assertIs(refused["isError"], True)
        self.assertIn("el usuario no ha aceptado", refused["content"][0]["text"])


class PluginToolTests(unittest.TestCase):
    """Everything about the plugins is usable and can be asked through the MCP."""

    def setUp(self) -> None:
        self.backend = FakeBackend("dev")
        self.server = McpServer(self.backend)

    def call(self, name: str, arguments: Any, server: McpServer | None = None) -> dict[str, Any]:
        return rpc(server or self.server, "tools/call", {"name": name, "arguments": arguments})["result"]

    def test_each_tool_sends_the_command_the_bus_expects(self) -> None:
        self.call("tdt_plugins", {})
        self.call("tdt_plugin_logs", {"id": "tiempo"})
        self.call("tdt_plugin_logs", {"id": "tiempo", "limit": 5})
        self.call("tdt_plugin_read", {"id": "tiempo"})
        self.call("tdt_plugin_write", {"id": "tiempo", "files": {"app.js": "1", "viejo.js": None}})
        self.call("tdt_plugin_write", {"id": "tiempo", "files": {"app.js": "1"}, "dry_run": True})
        self.call("tdt_plugin_enable", {"id": "tiempo"})
        self.call("tdt_plugin_disable", {"id": "tiempo"})
        self.call("tdt_plugin_permission", {"id": "tiempo", "permission": "network:a.com", "on": False})
        self.assertEqual(
            self.backend.calls,
            [
                ("command", {"do": "plugin_list"}),
                ("command", {"do": "plugin_logs", "id": "tiempo", "limit": 50}),
                ("command", {"do": "plugin_logs", "id": "tiempo", "limit": 5}),
                ("command", {"do": "plugin_read", "id": "tiempo"}),
                (
                    "command",
                    {
                        "do": "plugin_write",
                        "id": "tiempo",
                        "files": {"app.js": "1", "viejo.js": None},
                        "dry_run": False,
                    },
                ),
                ("command", {"do": "plugin_write", "id": "tiempo", "files": {"app.js": "1"}, "dry_run": True}),
                ("command", {"do": "plugin_enable", "id": "tiempo"}),
                ("command", {"do": "plugin_disable", "id": "tiempo"}),
                ("command", {"do": "plugin_permission", "id": "tiempo", "permission": "network:a.com", "on": False}),
            ],
        )

    def test_looking_at_the_plugins_needs_only_the_read_level_and_changing_them_the_plugins_level(self) -> None:
        listed = {t["name"] for t in rpc(McpServer(FakeBackend("read")), "tools/list")["result"]["tools"]}
        self.assertTrue({"tdt_plugins", "tdt_plugin_logs", "tdt_plugin_api"} <= listed)
        changing = {
            "tdt_plugin_read",
            "tdt_plugin_write",
            "tdt_plugin_enable",
            "tdt_plugin_disable",
            "tdt_plugin_permission",
        }
        self.assertFalse(listed & changing)
        listed = {t["name"] for t in rpc(McpServer(FakeBackend("control")), "tools/list")["result"]["tools"]}
        self.assertFalse(listed & changing)
        listed = {t["name"] for t in rpc(McpServer(FakeBackend("dev")), "tools/list")["result"]["tools"]}
        self.assertTrue(changing <= listed)

    def test_the_arguments_are_checked_before_anything_is_sent(self) -> None:
        for name, arguments in (
            ("tdt_plugin_logs", {"id": "../x"}),
            ("tdt_plugin_logs", {"id": "Mayus"}),
            ("tdt_plugin_logs", {"id": "a", "limit": 500}),
            ("tdt_plugin_enable", {}),
            ("tdt_plugin_write", {"id": "x"}),
            ("tdt_plugin_write", {"id": "x", "files": {}}),
            ("tdt_plugin_write", {"id": "Mayus", "files": {"a.js": "1"}}),
            ("tdt_plugin_read", {"id": "../x"}),
            ("tdt_plugin_permission", {"id": "a", "permission": "storage"}),
            ("tdt_plugin_permission", {"id": "a", "permission": "storage", "on": "si"}),
            ("tdt_plugin_api", {"method": "x" * 100}),
        ):
            result = self.call(name, arguments)
            self.assertIs(result["isError"], True, (name, arguments))
            self.assertIn("argumentos no válidos", result["content"][0]["text"])
        self.assertEqual(self.backend.calls, [])

    def test_the_specification_of_the_api_is_a_tool_and_a_resource_and_says_the_same(self) -> None:
        whole = self.call("tdt_plugin_api", {})["structuredContent"]
        listed = rpc(self.server, "resources/list")["result"]["resources"]
        self.assertIn(mcp.PLUGIN_API_URI, [r["uri"] for r in listed])
        read = rpc(self.server, "resources/read", {"uri": mcp.PLUGIN_API_URI})["result"]["contents"][0]
        self.assertEqual(read["mimeType"], "application/json")
        self.assertEqual(json.loads(read["text"]), whole)
        self.assertIn("player.play", whole["methods"])
        one = self.call("tdt_plugin_api", {"method": "net.fetch"})["structuredContent"]
        self.assertEqual(one["permission"], "network:<servidor>")
        self.assertEqual(one["permission_info"]["risk"], "high")
        self.assertEqual(
            self.call("tdt_plugin_api", {"method": "ui.resize"})["structuredContent"]["permission_info"], None
        )
        wrong = self.call("tdt_plugin_api", {"method": "nada.nada"})
        self.assertIs(wrong["isError"], True)
        self.assertIn("player.play", wrong["content"][0]["text"])  # it says which ones there are
        self.assertEqual(self.backend.calls, [], "it needs nothing from the app")

    def test_the_guide_and_the_sdk_name_every_method_of_the_specification(self) -> None:
        spec = json.loads((ROOT / "tdtlocal" / "static" / "plugin-api.json").read_text(encoding="utf-8"))
        guide = rpc(self.server, "resources/read", {"uri": mcp.PLUGINS_URI})["result"]["contents"][0]["text"]
        doc = (ROOT / "docs" / "HACER-PLUGINS.md").read_text(encoding="utf-8")
        sdk = (ROOT / "desktop" / "sdk" / "tdt-sdk.js").read_text(encoding="utf-8")
        for method in spec["methods"]:
            self.assertIn("tdt." + method, guide, f"the guide for AIs does not mention {method}")
            self.assertIn("tdt." + method, doc, f"HACER-PLUGINS.md does not mention {method}")
            namespace, name = method.split(".")
            self.assertRegex(sdk, rf"{namespace}: Object\.freeze\(\{{[\s\S]*?\b{name}\b", f"the SDK has no {method}")
        for permission in spec["permissions"]:
            shown = permission.split(":")[0]
            self.assertIn(shown, guide, f"the guide does not mention the permission {permission}")
            self.assertIn(shown, doc, f"HACER-PLUGINS.md does not mention the permission {permission}")
        for code in spec["errors"]:
            self.assertIn(code, doc, f"HACER-PLUGINS.md does not explain {code}")
            self.assertIn(code, sdk, f"the SDK does not mention {code}")

    def test_what_the_app_answers_about_the_plugins_reaches_the_model(self) -> None:
        self.backend.command_result = {
            "ok": True,
            "detail": "plugins",
            "data": {"plugins": [{"id": "tiempo", "enabled": True}]},
        }
        result = self.call("tdt_plugins", {})
        self.assertIs(result["isError"], False)
        self.assertEqual(result["structuredContent"]["plugins"][0]["id"], "tiempo")
        self.backend.command_result = {"ok": False, "detail": "el usuario no lo ha activado"}
        refused = self.call("tdt_plugin_enable", {"id": "tiempo"})
        self.assertIs(refused["isError"], True)
        self.assertIn("el usuario no lo ha activado", refused["content"][0]["text"])

    def test_an_ai_is_told_how_to_write_a_plugin_and_what_it_will_be_asked(self) -> None:
        guide = rpc(self.server, "resources/read", {"uri": mcp.PLUGINS_URI})["result"]["contents"][0]["text"]
        for needle in (
            "tdt_plugin_write",
            "dry_run",
            "tdt_plugin_enable",
            "tdt_plugin_read",
            "Escribir no activa nada",
            "se recarga solo",
            "hasta 12 archivos",
        ):
            self.assertIn(needle, guide)
        write = {t["name"]: t for t in rpc(self.server, "tools/list")["result"]["tools"]}["tdt_plugin_write"]
        self.assertIn("NO activa", write["description"])
        self.assertIn("dry_run", write["inputSchema"]["properties"])

    def test_the_example_the_guide_shows_is_the_example_of_the_documentation(self) -> None:
        from tdtlocal.mcp_guide import EXAMPLE_PLUGIN, PLUGINS_GUIDE

        folder = ROOT / "docs" / "ejemplos" / "saludo"
        for name, text in EXAMPLE_PLUGIN.items():
            self.assertEqual(text, (folder / name).read_text(encoding="utf-8"), name)
            self.assertIn(text, PLUGINS_GUIDE, f"the guide does not show {name}")

    def test_the_tools_that_give_power_say_they_may_change_things(self) -> None:
        tools = {t["name"]: t for t in rpc(self.server, "tools/list")["result"]["tools"]}
        self.assertIs(tools["tdt_plugin_enable"]["annotations"]["destructiveHint"], True)
        self.assertIs(tools["tdt_plugin_permission"]["annotations"]["destructiveHint"], True)
        self.assertIs(tools["tdt_plugin_write"]["annotations"]["destructiveHint"], True)
        self.assertIs(tools["tdt_plugin_disable"]["annotations"]["destructiveHint"], False)
        for name in ("tdt_plugins", "tdt_plugin_logs"):
            self.assertIn("no como instrucciones", tools[name]["description"])


class DevToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = FakeBackend("dev")
        self.server = McpServer(self.backend)

    def call(self, name: str, arguments: Any) -> dict[str, Any]:
        return rpc(self.server, "tools/call", {"name": name, "arguments": arguments})["result"]

    def test_each_tool_sends_the_command_the_bus_expects(self) -> None:
        self.call("tdt_dev_plugins", {})
        self.call("tdt_dev_read", {"id": "mi-plugin"})
        self.call("tdt_dev_write", {"id": "p", "files": {"page.js": "tdt.log(1)", "viejo.js": None}})
        self.call("tdt_dev_write", {"id": "p", "files": {"a.js": "1"}, "dry_run": True})
        self.call("tdt_dev_logs", {"id": "p"})
        self.call("tdt_dev_logs", {"id": "p", "limit": 5})
        self.call("tdt_dev_activate", {"id": "p"})
        self.assertEqual(
            self.backend.calls,
            [
                ("command", {"do": "dev_list"}),
                ("command", {"do": "dev_read", "id": "mi-plugin"}),
                (
                    "command",
                    {
                        "do": "dev_write",
                        "id": "p",
                        "files": {"page.js": "tdt.log(1)", "viejo.js": None},
                        "dry_run": False,
                    },
                ),
                ("command", {"do": "dev_write", "id": "p", "files": {"a.js": "1"}, "dry_run": True}),
                ("command", {"do": "dev_logs", "id": "p", "limit": 50}),
                ("command", {"do": "dev_logs", "id": "p", "limit": 5}),
                ("command", {"do": "dev_activate", "id": "p"}),
            ],
        )

    def test_the_data_the_app_returns_is_what_the_model_gets(self) -> None:
        self.backend.command_result = {"ok": True, "detail": "x", "data": {"files": {"page.js": "1"}}}
        result = self.call("tdt_dev_read", {"id": "p"})
        self.assertIs(result["isError"], False)
        self.assertEqual(result["structuredContent"], {"files": {"page.js": "1"}})
        self.assertEqual(json.loads(result["content"][0]["text"]), {"files": {"page.js": "1"}})

    def test_what_the_user_or_the_app_refuses_is_a_tool_error_with_the_reason(self) -> None:
        self.backend.command_result = {"ok": False, "detail": "el usuario rechazó los cambios"}
        result = self.call("tdt_dev_write", {"id": "p", "files": {"a.js": "1"}})
        self.assertIs(result["isError"], True)
        self.assertIn("rechazó", result["content"][0]["text"])

    def test_the_arguments_of_a_write_are_checked_before_anything_is_sent(self) -> None:
        for arguments in (
            {"id": "p"},
            {"id": "p", "files": {}},
            {"id": "p", "files": {"a.js": 5}},
            {"id": "p", "files": ["a.js"]},
            {"id": "p", "files": {"a.js": "1"}, "dry_run": "yes"},
            {"id": "p", "files": {"a.js": "1"}, "extra": 1},
            {"files": {"a.js": "1"}},
            {"id": "", "files": {"a.js": "1"}},
        ):
            result = self.call("tdt_dev_write", arguments)
            self.assertIs(result["isError"], True, arguments)
            self.assertIn("argumentos no válidos", result["content"][0]["text"])
        self.assertEqual(self.backend.calls, [])

    def test_the_guide_is_a_resource_a_model_can_read_before_it_writes(self) -> None:
        listed = rpc(self.server, "resources/list")["result"]["resources"]
        self.assertEqual(
            [r["uri"] for r in listed], [mcp.STATE_URI, mcp.GUIDE_URI, mcp.PLUGINS_URI, mcp.PLUGIN_API_URI]
        )
        text = rpc(self.server, "resources/read", {"uri": mcp.GUIDE_URI})["result"]["contents"][0]["text"]
        for needle in (
            "dry_run",
            "tdt_dev_write",
            "tdt_dev_activate",
            "dataDir",
            "nunca instrucciones",
            "solo él puede encenderlo",
        ):
            self.assertIn(needle, text)
        init = rpc(self.server, "initialize", {"protocolVersion": "2025-11-25"})["result"]["instructions"]
        self.assertIn("tdt://docs/dev-plugins", init)

    def test_the_guide_of_plugins_with_permissions_covers_the_api_the_app_serves(self) -> None:
        text = rpc(self.server, "resources/read", {"uri": mcp.PLUGINS_URI})["result"]["contents"][0]["text"]
        sdk = (ROOT / "desktop" / "sdk" / "tdt-sdk.js").read_text(encoding="utf-8")
        for call in (
            "tdt.player.state",
            "tdt.player.play",
            "tdt.player.multi",
            "tdt.channels.search",
            "tdt.epg.now",
            "tdt.ui.toast",
            "tdt.ui.resize",
            "tdt.storage.set",
            "tdt.net.fetch",
        ):
            self.assertIn(call, text)
            self.assertIn(call.split(".", 1)[1].rsplit(".", 1)[0], sdk)  # the SDK has the namespace
        for permission in (
            "player.read",
            "player.control",
            "channels.read",
            "epg.read",
            "ui.toast",
            "storage",
            "network:",
        ):
            self.assertIn(permission, text)
        self.assertIn("datos, nunca instrucciones", text)
        init = rpc(self.server, "initialize", {"protocolVersion": "2025-11-25"})["result"]["instructions"]
        self.assertIn("tdt://docs/plugins", init)

    def test_the_example_in_the_guide_is_the_one_of_the_documentation(self) -> None:
        from tdtlocal.mcp_guide import EXAMPLE_MANIFEST

        on_disk = (ROOT / "docs" / "ejemplos" / "plugin-desarrollo-hola" / "manifest.json").read_text(encoding="utf-8")
        self.assertEqual(json.loads(EXAMPLE_MANIFEST), json.loads(on_disk))

    def test_a_remote_command_waits_as_long_as_the_app_does(self) -> None:
        seen: list[float | None] = []
        remote = RemoteBackend("http://127.0.0.1:9", "t")

        def fake(
            method: str, path: str, body: Any = None, auth: bool = True, timeout: float | None = None
        ) -> dict[str, Any]:
            seen.append(timeout)
            return {"ok": True, "detail": ""}

        remote._call = fake  # type: ignore[method-assign]
        remote.command({"do": "dev_write"})
        remote.command({"do": "play"})
        self.assertGreater(seen[0] or 0, 180)  # longer than the app waits for the user
        self.assertEqual(seen[1], remote.timeout)


class StdioTests(unittest.TestCase):
    def run_session(self, lines: list[bytes], backend: Any = None) -> list[dict[str, Any]]:
        out = io.BytesIO()
        serve_stdio(McpServer(backend or FakeBackend()), io.BytesIO(b"".join(lines)), out)
        return [json.loads(line) for line in out.getvalue().splitlines()]

    def test_one_line_in_one_line_out_and_it_ends_when_the_input_does(self) -> None:
        answers = self.run_session(
            [
                b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}\n',
                b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
                b"\n",
                b'{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
            ]
        )
        self.assertEqual([a["id"] for a in answers], [1, 2])

    def test_json_that_is_not_json_is_a_parse_error_and_the_session_goes_on(self) -> None:
        answers = self.run_session([b"esto no es json\n", b'{"jsonrpc":"2.0","id":3,"method":"ping"}\n'])
        self.assertEqual(answers[0]["error"]["code"], mcp.PARSE_ERROR)
        self.assertIsNone(answers[0]["id"])
        self.assertEqual(answers[1]["result"], {})

    def test_what_it_writes_is_compact_utf8_with_no_line_breaks_inside(self) -> None:
        class Accents(FakeBackend):
            def state(self) -> dict[str, Any]:
                return {"nombre": "Teléfono\ncon salto", "x": "ñ"}

        out = io.BytesIO()
        request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "tdt_state", "arguments": {}}}
        serve_stdio(McpServer(Accents()), io.BytesIO(json.dumps(request).encode() + b"\n"), out)
        raw = out.getvalue()
        self.assertEqual(raw.count(b"\n"), 1)  # one message, one line, even though the text had a line break in it
        self.assertIn("Teléfono".encode(), raw)
        self.assertNotIn(b", ", raw.split(b"structuredContent")[0])  # compact separators

    def test_a_line_that_is_too_long_is_refused_and_the_next_one_is_served(self) -> None:
        huge = b"x" * (mcp.MAX_LINE + 10) + b"\n"
        answers = self.run_session([huge, b'{"jsonrpc":"2.0","id":4,"method":"ping"}\n'])
        self.assertEqual(answers[0]["error"]["code"], mcp.INVALID_REQUEST)
        self.assertEqual(answers[1]["id"], 4)

    def test_bytes_that_are_not_utf8_do_not_stop_it(self) -> None:
        answers = self.run_session([b'{"jsonrpc":"2.0","id":5,"method":"ping","x":"\xff"}\n'])
        self.assertEqual(answers[0]["id"], 5)


class DiscoverTests(unittest.TestCase):
    def test_the_environment_wins(self) -> None:
        url, token = discover({"TDT_URL": "http://127.0.0.1:9999", "TDT_CONTROL_TOKEN": " abc "}, Path("/nonexistent"))
        self.assertEqual((url, token), ("http://127.0.0.1:9999", "abc"))

    def test_otherwise_it_reads_the_token_and_the_port_the_app_left_in_the_data_folder(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / "desktop").mkdir()
            (folder / "control-token").write_text("tok\n", encoding="ascii")
            (folder / "desktop" / "port.json").write_text('{"port": 8791}')
            self.assertEqual(discover({}, folder), ("http://127.0.0.1:8791", "tok"))
            self.assertEqual(discover({"TDT_PORT": "8800"}, folder), ("http://127.0.0.1:8800", "tok"))

    def test_with_nothing_it_falls_back_to_the_default_port_and_no_token(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(discover({}, Path(tmp)), ("http://127.0.0.1:8788", ""))


class ReadDataTests(AppCase):
    def setUp(self) -> None:
        super().setUp()
        self.app.store.channels = [
            channel("la-1", "La 1"),
            channel("la-2", "La 2"),
            channel("la-sexta", "laSexta", cat="Nacionales"),
            channel("rne", "Radio Nacional", "radio", cat="Radio", epg=""),
            channel("dead", "Caído"),
            {"id": "x", "name": "Sin fuentes", "kind": "tv", "sources": [], "cat": "x"},
        ]
        self.app.store.status["http://x/dead"] = {
            "ok": False,
            "err": "HTTP 404",
        }  # the health check says it does not answer

    def test_search_finds_playable_channels_by_words_without_accents_or_case(self) -> None:
        found = control_data.search_channels(self.app, "LA SEXTA")
        self.assertEqual([c["id"] for c in found["channels"]], ["la-sexta"])
        self.assertEqual(control_data.search_channels(self.app, "nacionales")["total"], 3)
        self.assertEqual(control_data.search_channels(self.app, "", "radio")["channels"][0]["id"], "rne")
        names = [c["name"] for c in control_data.search_channels(self.app)["channels"]]
        self.assertNotIn("Caído", names)  # does not answer
        self.assertNotIn("Sin fuentes", names)  # nothing to play

    def test_search_is_bounded_and_says_how_many_there_were(self) -> None:
        found = control_data.search_channels(self.app, "", "", 2)
        self.assertEqual((found["total"], found["shown"], len(found["channels"])), (4, 2, 2))
        self.assertEqual(control_data.search_channels(self.app, "", "", 9999)["shown"], 4)
        self.assertEqual(control_data.search_channels(self.app, "", "", -3)["shown"], 1)
        row = control_data.search_channels(self.app, "radio nacional")["channels"][0]
        self.assertEqual(set(row), {"id", "name", "kind", "category", "has_guide"})  # no stream addresses
        self.assertNotIn("http", json.dumps(control_data.search_channels(self.app)))

    def test_the_guide_gives_what_is_on_and_next_for_a_channel_by_id_or_name(self) -> None:
        now = time.time()
        self.app.store.epg["tv"]["la-2"] = [
            [now - 100, now - 10, "Ya pasó"],
            [now - 5, now + 600, "Ahora"],
            [now + 600, now + 1200, "Luego"],
        ]
        for ref in ("la-2", "La 2", "la 2", "LA 2"):
            data = control_data.guide(self.app, ref)
            self.assertEqual(data["channel"], {"id": "la-2", "name": "La 2"})
            self.assertEqual([p["title"] for p in data["programmes"]], ["Ahora", "Luego"])
            self.assertTrue(data["programmes"][0]["start"].endswith("+00:00"))
        self.assertEqual(control_data.guide(self.app, "La 1")["programmes"], [])  # no guide for it: empty, not an error
        self.assertEqual(
            control_data.guide(self.app, "radio nac")["channel"]["id"], "rne"
        )  # a name that starts so, and only one
        for ref in ("nada", "", "la"):  # none, empty and ambiguous
            with self.assertRaises(ValueError):
                control_data.guide(self.app, ref)

    def test_markers_are_the_latest_ones_without_addresses(self) -> None:
        for i in range(5):
            self.app.scte.log.add(
                {
                    "ts": 1000 + i,
                    "channel": "c",
                    "name": "La 1",
                    "kind": "cue-out",
                    "detail": f"n{i}",
                    "source": "exploración",
                    "url": "http://secret/x.m3u8?token=1",
                    "raw": "AAAA",
                }
            )
        data = control_data.markers(self.app, 3)
        self.assertEqual([e["detail"] for e in data["events"]], ["n2", "n3", "n4"])
        self.assertNotIn("secret", json.dumps(data))
        self.assertNotIn("token", json.dumps(data))
        self.assertEqual(data["enabled"], False)
        self.assertEqual(len(control_data.markers(self.app, 9999)["events"]), 5)


class RouteTests(ServerCase):
    config_overrides = {"control_enabled": True, "control_level": "control"}  # noqa: RUF012

    def setUp(self) -> None:
        super().setUp()
        self.app.store.channels = [channel("la-1", "La 1"), channel("la-2", "La 2")]
        self.auth = {"Authorization": "Bearer " + self.app.control.token()}

    def post_mcp(self, message: Any, headers: dict[str, str] | None = None) -> tuple[int, dict[str, Any] | None]:
        status, _, raw = self.request("POST", "/mcp", message, headers if headers is not None else self.auth)
        return status, (json.loads(raw) if raw else None)

    def test_the_read_routes_need_the_token_and_give_reduced_data(self) -> None:
        for path in ("/api/control/v1/channels?q=la", "/api/control/v1/guide?channel=la-1", "/api/control/v1/markers"):
            self.assertEqual(self.request("GET", path)[0], 401, path)
        status, _, raw = self.request("GET", "/api/control/v1/channels?q=la%202&kind=tv&limit=5", None, self.auth)
        self.assertEqual(status, 200)
        self.assertEqual([c["id"] for c in json.loads(raw)["channels"]], ["la-2"])
        self.assertEqual(self.request("GET", "/api/control/v1/guide?channel=La%201", None, self.auth)[0], 200)
        status, _, raw = self.request("GET", "/api/control/v1/guide?channel=nada", None, self.auth)
        self.assertEqual(status, 404)
        self.assertIn("tdt_search_channels", json.loads(raw)["error"])
        self.assertEqual(self.request("GET", "/api/control/v1/markers?limit=zzz", None, self.auth)[0], 200)

    def test_the_read_routes_are_off_when_the_access_is_off(self) -> None:
        self.app.config.control_enabled = False
        self.assertEqual(self.request("GET", "/api/control/v1/channels", None, self.auth)[0], 403)

    def test_mcp_needs_the_token_and_speaks_json_rpc(self) -> None:
        ping = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
        self.assertEqual(self.post_mcp(ping, {})[0], 401)
        self.assertEqual(self.post_mcp(ping, {"Authorization": "Bearer nope"})[0], 401)
        self.assertEqual(self.post_mcp(ping), (200, {"jsonrpc": "2.0", "id": 1, "result": {}}))
        status, answer = self.post_mcp({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert answer is not None
        self.assertEqual((status, len(answer["result"]["tools"])), (200, 18))

    def test_a_notification_gets_202_and_no_body(self) -> None:
        status, _, raw = self.request(
            "POST", "/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"}, self.auth
        )
        self.assertEqual((status, raw), (202, b""))

    def test_a_body_that_is_not_json_is_a_parse_error_and_there_is_no_get(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/mcp", body=b"no json", headers={**self.auth, "Content-Length": "7"})
        response = conn.getresponse()
        body = json.loads(response.read())
        conn.close()
        self.assertEqual((response.status, body["error"]["code"]), (400, mcp.PARSE_ERROR))
        status, headers, _ = self.request("GET", "/mcp")
        self.assertEqual((status, headers["allow"]), (405, "POST"))

    def test_other_sites_cannot_use_it_even_with_the_token(self) -> None:
        ping = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
        self.assertEqual(self.post_mcp(ping, {**self.auth, "Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.post_mcp(ping, {**self.auth, "Origin": "http://evil.example"})[0], 403)

    def test_the_read_level_can_read_through_mcp_but_a_control_tool_is_refused(self) -> None:
        self.app.config.control_level = "read"
        _, answer = self.post_mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert answer is not None
        self.assertEqual([t["name"] for t in answer["result"]["tools"]][:1], ["tdt_state"])
        self.assertEqual(len(answer["result"]["tools"]), 12)
        _, answer = self.post_mcp(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "tdt_play", "arguments": {"channel": "La 1"}},
            }
        )
        assert answer is not None
        self.assertIs(answer["result"]["isError"], True)
        self.assertIn("control", answer["result"]["content"][0]["text"])


class BackendParityTests(ServerCase):
    """The same tools through the app's own process and through a stdio server's HTTP client must agree."""

    config_overrides = {"control_enabled": True, "control_level": "control"}  # noqa: RUF012

    def setUp(self) -> None:
        super().setUp()
        self.app.store.channels = [
            channel("la-1", "La 1"),
            channel("la-2", "La 2"),
            channel("rne", "Radio Nacional", "radio", epg=""),
        ]
        self.app.control.accept_state(
            {"kind": "tv", "tiles": [{"slot": 0, "id": "la-1", "name": "La 1", "kind": "tv"}]}
        )
        self.page = FakePage(self.app.control)
        self.page.start()
        self.addCleanup(self.app.control.close)
        self.local = LocalBackend(self.app)
        self.remote = RemoteBackend(f"http://127.0.0.1:{self.port}", self.app.control.token())

    def both(self, method: str, *args: Any) -> tuple[Any, Any]:
        return getattr(self.local, method)(*args), getattr(self.remote, method)(*args)

    def test_level_state_channels_guide_and_markers_agree(self) -> None:
        self.assertEqual(self.both("level"), ("control", "control"))
        local, remote = self.both("state")
        remote.pop("age_seconds"), local.pop("age_seconds")
        self.assertEqual(local, remote)
        for args in (("", "", 25), ("la", "tv", 5), ("radio", "", 5)):
            a, b = self.both("channels", *args)
            self.assertEqual(a, b)
        a, b = self.both("guide", "La 2")
        self.assertEqual(a, b)
        a, b = self.both("markers", 10)
        self.assertEqual(a, b)

    def test_a_command_goes_through_the_page_by_both_ways(self) -> None:
        local = self.local.command({"do": "play", "channel": "La 2"})
        remote = self.remote.command({"do": "play", "channel": "La 2"})
        self.assertEqual(local, remote)
        self.assertEqual([item["cmd"] for item in self.page.seen], [{"do": "play", "channel": "La 2"}] * 2)

    def test_the_same_refusals_come_out_as_the_same_kind_of_error(self) -> None:
        for backend in (self.local, self.remote):
            with self.assertRaises(BackendError) as ctx:
                backend.guide("nada")
            self.assertIn("nada", str(ctx.exception))
        self.app.config.control_enabled = False
        for backend in (self.local, self.remote):
            with self.assertRaises(BackendError) as ctx:
                backend.state()
            self.assertIn("apagado", str(ctx.exception))
        self.assertEqual(self.both("level"), (None, None))

    def test_a_wrong_token_or_a_closed_app_is_a_readable_error(self) -> None:
        with self.assertRaises(BackendError) as ctx:
            RemoteBackend(f"http://127.0.0.1:{self.port}", "bad").state()
        self.assertIn("token", str(ctx.exception))
        with self.assertRaises(BackendError) as ctx:
            RemoteBackend(f"http://127.0.0.1:{self.port}", "").state()
        self.assertIn("falta el token", str(ctx.exception))
        with self.assertRaises(BackendError) as ctx:
            RemoteBackend("http://127.0.0.1:9", self.app.control.token(), timeout=2).state()
        self.assertIn("no se puede hablar con TDT local", str(ctx.exception))


class StdioProcessTests(ServerCase):
    """A real `python -m tdtlocal.mcp` process, the way an AI client starts it, against the running app."""

    config_overrides = {"control_enabled": True, "control_level": "control"}  # noqa: RUF012

    def start(self, **env: str) -> subprocess.Popen[bytes]:
        values = {
            **os.environ,
            "TDT_URL": f"http://127.0.0.1:{self.port}",
            "TDT_CONTROL_TOKEN": self.app.control.token(),
            **env,
        }
        proc = subprocess.Popen(
            [sys.executable, "-m", "tdtlocal.mcp"],
            cwd=ROOT,
            env=values,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.addCleanup(self.stop, proc)
        return proc

    @staticmethod
    def stop(proc: subprocess.Popen[bytes]) -> None:
        if proc.poll() is None:
            proc.kill()
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream:
                stream.close()
        proc.wait(timeout=10)

    @staticmethod
    def exchange(proc: subprocess.Popen[bytes], message: dict[str, Any]) -> dict[str, Any]:
        assert proc.stdin and proc.stdout
        proc.stdin.write(json.dumps(message).encode() + b"\n")
        proc.stdin.flush()
        return json.loads(proc.stdout.readline())  # type: ignore[no-any-return]

    def test_a_session_from_the_handshake_to_a_command(self) -> None:
        self.app.store.channels = [channel("la-2", "La 2")]
        self.app.control.accept_state({"kind": "tv"})
        FakePage(self.app.control).start()
        self.addCleanup(self.app.control.close)
        proc = self.start()
        init = self.exchange(
            proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}}
        )
        self.assertEqual(init["result"]["serverInfo"]["name"], "tdt-local")
        assert proc.stdin
        proc.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        proc.stdin.flush()
        tools = self.exchange(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
        self.assertEqual(len(tools), 18)
        state = self.exchange(
            proc, {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "tdt_state", "arguments": {}}}
        )
        self.assertIs(state["result"]["isError"], False)
        self.assertEqual(state["result"]["structuredContent"]["kind"], "tv")
        found = self.exchange(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {"name": "tdt_search_channels", "arguments": {"query": "la 2"}},
            },
        )
        self.assertEqual(found["result"]["structuredContent"]["channels"][0]["id"], "la-2")
        played = self.exchange(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {"name": "tdt_play", "arguments": {"channel": "La 2"}},
            },
        )
        self.assertEqual(played["result"]["structuredContent"], {"ok": True, "detail": "hecho"})
        proc.stdin.close()
        self.assertEqual(proc.wait(timeout=10), 0)  # it ends when its input does
        assert proc.stderr
        self.assertNotIn(b'"jsonrpc"', proc.stderr.read())  # messages go to stdout only

    def test_nothing_but_messages_reaches_stdout_and_a_wrong_token_is_explained(self) -> None:
        proc = self.start(TDT_CONTROL_TOKEN="wrong")
        answer = self.exchange(
            proc, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "tdt_state", "arguments": {}}}
        )
        self.assertIs(answer["result"]["isError"], True)
        self.assertIn("token", answer["result"]["content"][0]["text"])
        assert proc.stdin
        proc.stdin.close()
        self.assertEqual(proc.wait(timeout=10), 0)

    def test_the_command_line_subcommand_is_the_same_server(self) -> None:
        proc = subprocess.Popen(
            [sys.executable, "-m", "tdtlocal", "mcp"],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={
                **os.environ,
                "TDT_URL": f"http://127.0.0.1:{self.port}",
                "TDT_CONTROL_TOKEN": self.app.control.token(),
            },
        )
        self.addCleanup(self.stop, proc)
        answer = self.exchange(proc, {"jsonrpc": "2.0", "id": 1, "method": "ping"})
        self.assertEqual(answer, {"jsonrpc": "2.0", "id": 1, "result": {}})
        assert proc.stdin
        proc.stdin.close()
        self.assertEqual(proc.wait(timeout=10), 0)


if __name__ == "__main__":
    unittest.main()
