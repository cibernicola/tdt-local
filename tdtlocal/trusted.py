# ruff: noqa: E501 - the docstrings are prose
"""The plugins with all the power, on the server: code that runs inside the application and gets the hooks.

The loader gives each plugin its own ``tdt``, remembers everything the plugin added so it can all be taken away, and keeps its mistakes from
reaching the application: a plugin that raises is reported, and one that keeps doing it is switched off (the rest go on). It is the
counterpart of ``static/js/lib/trusted.js``. A plugin is a Python file with ``setup(tdt)``; it may return a function to call when it is taken away.
"""

from __future__ import annotations

import importlib.util
import logging
import threading
from pathlib import Path
from typing import Any, Callable

from .hooks import DEFAULT_PRIORITY, Hooks

log = logging.getLogger("tdtlocal.trusted")

MAX_ERRORS = 5  # mistakes of a plugin before it is switched off


class _Plugin:
    def __init__(self) -> None:
        self.state = "on"
        self.errors = 0
        self.error = ""
        self.offs: list[Callable[[], None]] = []
        self.cleanup: Callable[[], None] | None = None


class Tdt:
    """What a plugin is given: the hooks, each thing it adds remembered under its name."""

    def __init__(self, loader: Loader, plugin_id: str, plugin: _Plugin) -> None:
        self.id = plugin_id
        self._loader = loader
        self._plugin = plugin

    def _keep(self, off: Callable[[], None]) -> Callable[[], None]:
        self._plugin.offs.append(off)
        return off

    def on(self, name: str, fn: Callable[..., Any], priority: int = DEFAULT_PRIORITY) -> Callable[[], None]:
        return self._keep(self._loader.hooks.on(name, self._loader.guard(self.id, f"on({name})", fn), priority))

    def do(self, name: str, data: Any = None) -> None:
        self._loader.hooks.do(name, data)

    def filter(self, name: str, fn: Callable[..., Any], priority: int = DEFAULT_PRIORITY) -> Callable[[], None]:
        return self._keep(self._loader.hooks.filter(name, self._loader.guard(self.id, f"filter({name})", fn), priority))

    def apply(self, name: str, value: Any, ctx: Any = None) -> Any:
        return self._loader.hooks.apply(name, value, ctx)

    def register(self, registry: str, ident: str, entry: Any, priority: int = DEFAULT_PRIORITY) -> Callable[[], None]:
        guarded = self._loader.guard_entry(self.id, f"{registry}/{ident}", entry)
        return self._keep(self._loader.hooks.register(registry, ident, guarded, priority))

    def get(self, registry: str, ident: str) -> Any:
        return self._loader.hooks.get(registry, ident)

    def list(self, registry: str) -> list[tuple[str, Any]]:
        return self._loader.hooks.list(registry)

    def log(self, message: Any) -> None:
        log.info("plugin «%s»: %s", self.id, message)


class Loader:
    """Starts and stops the plugins with all the power."""

    def __init__(self, hooks: Hooks, max_errors: int = MAX_ERRORS) -> None:
        self.hooks = hooks
        self.max_errors = max_errors
        self._plugins: dict[str, _Plugin] = {}
        self._lock = threading.RLock()

    # ---- life cycle
    def load(self, plugin_id: str, setup: Callable[[Tdt], Any]) -> bool:
        """Start a plugin: ``setup(tdt)`` adds what it brings. Returns ``False`` if it failed (what it had added is gone)."""
        with self._lock:
            if plugin_id in self._plugins and self._plugins[plugin_id].state == "on":
                self.unload(plugin_id)
            plugin = self._plugins[plugin_id] = _Plugin()
        try:
            cleanup = setup(Tdt(self, plugin_id, plugin))
        except Exception as error:
            plugin.errors += 1
            plugin.error = f"al arrancar: {error}"
            log.warning("plugin «%s»: %s", plugin_id, plugin.error)
            self.unload(plugin_id, "failed")
            return False
        if plugin.state != "on":
            return False  # it switched itself off while starting
        if callable(cleanup):
            plugin.cleanup = cleanup
        return True

    def load_file(self, plugin_id: str, path: Path) -> bool:
        """Start the plugin that is in this Python file (it must have ``setup(tdt)``)."""
        try:
            spec = importlib.util.spec_from_file_location(f"tdt_plugin_{plugin_id}", path)
            if spec is None or spec.loader is None:
                raise ImportError("no se puede leer el archivo")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            setup = module.setup
        except Exception as error:
            with self._lock:
                plugin = self._plugins[plugin_id] = _Plugin()
                plugin.state, plugin.errors, plugin.error = "failed", 1, f"al cargar el archivo: {error}"
            log.warning("plugin «%s»: %s", plugin_id, plugin.error)
            return False
        return self.load(plugin_id, setup)

    def unload(self, plugin_id: str, state: str = "off") -> bool:
        """Take a plugin away: everything it added goes, and what was there before comes back."""
        with self._lock:
            plugin = self._plugins.get(plugin_id)
            if plugin is None or plugin.state != "on":
                return False
            plugin.state = state
            offs, plugin.offs = plugin.offs, []
            cleanup, plugin.cleanup = plugin.cleanup, None
        for off in reversed(offs):
            off()
        if cleanup is not None:
            try:
                cleanup()
            except Exception as error:
                log.warning("plugin «%s»: al apagar: %s", plugin_id, error)
        return True

    def list(self) -> list[dict[str, Any]]:
        """What there is: ``[{id, state: on|off|failed, errors, error}]``."""
        with self._lock:
            return [
                {"id": pid, "state": p.state, "errors": p.errors, "error": p.error} for pid, p in self._plugins.items()
            ]

    # ---- keeping the mistakes of a plugin to itself
    def _fail(self, plugin_id: str, where: str, error: BaseException) -> None:
        with self._lock:
            plugin = self._plugins.get(plugin_id)
            if plugin is None or plugin.state != "on":
                return
            plugin.errors += 1
            plugin.error = f"{where}: {error}"
            count = plugin.errors
        log.warning("plugin «%s»: %s", plugin_id, plugin.error)
        if count >= self.max_errors:
            log.warning("plugin «%s»: se apaga tras %d fallos", plugin_id, count)
            self.unload(plugin_id, "failed")

    def guard(self, plugin_id: str, where: str, fn: Callable[..., Any]) -> Callable[..., Any]:
        """The same function, but a mistake of the plugin is counted (and swallowed) instead of reaching the application."""

        def guarded(*args: Any, **kwargs: Any) -> Any:
            try:
                return fn(*args, **kwargs)
            except Exception as error:
                self._fail(plugin_id, where, error)
                return None

        return guarded

    def guard_entry(self, plugin_id: str, where: str, entry: Any) -> Any:
        """A thing for a registry: if it is a function, or a dict with functions, they are guarded too."""
        if callable(entry):
            return self.guard(plugin_id, where, entry)
        if isinstance(entry, dict):
            return {
                key: self.guard(plugin_id, f"{where}.{key}", value) if callable(value) else value
                for key, value in entry.items()
            }
        return entry
