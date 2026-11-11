# ruff: noqa: E501 - the docstrings are prose
"""The hooks of the server: the way the application lets others look at, change or replace what it does (docs/HACKEABLE.md).

The same three pieces as in the page (``static/js/lib/hooks.js``), with the same rules:

* **action**: ``on(name, fn, priority)`` / ``do(name, data)``: something happened, whoever listens reacts;
* **filter**: ``filter(name, fn, priority)`` / ``apply(name, value, ctx)``: a value goes through a chain and each link may change it;
* **registry**: ``register(registry, id, entry, priority)`` / ``get`` / ``list``: things the application treats alike whoever brought them.

Every way of adding something returns the way to take it away, and taking it away puts back what was there before. The lowest priority
number goes first (actions, filters) or wins (registries); with the same number, the one that came last wins and the first one goes first.
A link that raises is skipped and reported; it never breaks the chain. Safe to use from several threads.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any, Callable

log = logging.getLogger("tdtlocal.hooks")

DEFAULT_PRIORITY = 10

Undo = Callable[[], None]


@dataclass
class _Link:
    fn: Callable[..., Any]
    priority: int
    seq: int


@dataclass
class _Entry:
    entry: Any
    priority: int
    seq: int


def _report(name: str, error: BaseException) -> None:
    log.warning("un gancho de «%s» falló: %s: %s", name, type(error).__name__, error)


class Hooks:
    """Actions, filters and registries of the server."""

    def __init__(self, on_error: Callable[[str, BaseException], None] = _report) -> None:
        self._lock = threading.Lock()
        self._seq = 0
        self._on_error = on_error
        self._actions: dict[str, list[_Link]] = {}
        self._filters: dict[str, list[_Link]] = {}
        self._registries: dict[str, dict[str, list[_Entry]]] = {}

    def _next(self) -> int:
        self._seq += 1
        return self._seq

    # ---- actions
    def on(self, name: str, fn: Callable[..., Any], priority: int = DEFAULT_PRIORITY) -> Undo:
        """Listen to an action: ``fn(data)`` is called every time it is told."""
        return self._add(self._actions, name, fn, priority)

    def do(self, name: str, data: Any = None) -> None:
        """Tell that something happened. A listener that raises does not stop the others."""
        for link in self._chain(self._actions, name):
            try:
                link.fn(data)
            except Exception as error:
                self._on_error(name, error)

    # ---- filters
    def filter(self, name: str, fn: Callable[..., Any], priority: int = DEFAULT_PRIORITY) -> Undo:
        """Add a link to a chain: ``fn(value, ctx)`` returns the new value, or ``None`` to leave it as it is."""
        return self._add(self._filters, name, fn, priority)

    def apply(self, name: str, value: Any, ctx: Any = None) -> Any:
        """Pass a value through the chain. A link that raises is skipped (and reported): the chain never breaks."""
        for link in self._chain(self._filters, name):
            try:
                out = link.fn(value, ctx)
            except Exception as error:
                self._on_error(name, error)
                continue
            if out is not None:
                value = out
        return value

    def chains(self) -> list[dict[str, Any]]:
        """The filters in use and how many links each has (to see them in the inspector)."""
        with self._lock:
            return [{"name": n, "links": len(links)} for n, links in self._filters.items() if links]

    # ---- registries
    def register(self, registry: str, ident: str, entry: Any, priority: int = DEFAULT_PRIORITY) -> Undo:
        """Add a thing to a registry. The one with the lowest priority number is used; with the same number, the last one added."""
        item = _Entry(entry, int(priority), 0)
        with self._lock:
            item.seq = self._next()
            self._registries.setdefault(registry, {}).setdefault(ident, []).append(item)

        def undo() -> None:
            with self._lock:
                ids = self._registries.get(registry, {})
                items = ids.get(ident, [])
                if item in items:
                    items.remove(item)
                if not items:
                    ids.pop(ident, None)

        return undo

    @staticmethod
    def _winner(items: list[_Entry]) -> _Entry:
        return min(items, key=lambda i: (i.priority, -i.seq))

    def get(self, registry: str, ident: str) -> Any:
        """The thing in force under this name, or ``None``."""
        with self._lock:
            items = self._registries.get(registry, {}).get(ident)
            return self._winner(items).entry if items else None

    def list(self, registry: str) -> list[tuple[str, Any]]:
        """Everything in force in a registry, as ``(id, entry)``."""
        with self._lock:
            return [
                (ident, self._winner(items).entry)
                for ident, items in self._registries.get(registry, {}).items()
                if items
            ]

    # ---- inside
    def _add(self, table: dict[str, list[_Link]], name: str, fn: Callable[..., Any], priority: int) -> Undo:
        if not callable(fn):
            raise TypeError("hace falta una función")
        link = _Link(fn, int(priority), 0)
        with self._lock:
            link.seq = self._next()
            table.setdefault(name, []).append(link)

        def undo() -> None:
            with self._lock:
                links = table.get(name, [])
                if link in links:
                    links.remove(link)

        return undo

    def _chain(self, table: dict[str, list[_Link]], name: str) -> list[_Link]:
        with self._lock:
            return sorted(table.get(name, []), key=lambda link: (link.priority, link.seq))
