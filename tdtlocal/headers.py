"""The request headers a channel may carry: which ones are allowed, how they are checked, and where they may be sent.

A channel can ask the origin for its streams with headers the user chose (``Referer``, ``Origin``, ``User-Agent``, or any other
the user needs, even a ``Cookie``). Nothing here changes what TDT local does by default: a channel has no headers until its owner
sets some, and no value is ever invented. The rules are about keeping that safe:

* the **name** has to be a valid HTTP header name, and the ones that belong to the transport (``Host``, ``Content-Length``,
  ``Connection``, ``Range``…) cannot be set: they would break the request or smuggle another one;
* the **value** cannot contain line breaks or control characters (that would add headers of its own) and has a size limit;
* ``Origin``, ``Referer`` and ``User-Agent`` go to every host that serves the channel (its playlist and its segments, which
  are often on a CDN); **any other header is a credential in the making** (a ``Cookie``, an ``Authorization``, a token) and goes only to the
  hosts of the channel's own links, and is dropped if a redirect leaves them;
* the page never gets the value of those other headers back: it can say that one is set, and replace it or remove it.
"""

# ruff: noqa: E501 - prose for a reader, not code: its lines are as long as the sentences

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

NAME = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,40}$")
MAX_HEADERS = 8
MAX_VALUE = 600
PLAIN = ("origin", "referer", "user-agent")  # sent to every host of the channel
# set by the transport or the proxy itself: letting a channel override them breaks the request or hides another one
FORBIDDEN = frozenset(
    {
        "host",
        "connection",
        "keep-alive",
        "content-length",
        "content-type",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "expect",
        "range",
        "if-range",
        "accept-encoding",
        "proxy-authorization",
        "proxy-authenticate",
        "proxy-connection",
    }
)


def is_sensitive(name: str) -> bool:
    """A header that is not one of the three plain ones: it may hold a credential, so it only goes to the channel's own hosts."""
    return name.lower() not in PLAIN


def check_name(name: Any) -> str:
    """The name as it will be sent, or ``ValueError`` saying why not (in words for the user)."""
    if not isinstance(name, str) or not NAME.match(name):
        raise ValueError(
            f"«{str(name)[:40]}» no es un nombre de cabecera válido (letras, números y -_.; hasta 40 caracteres)"
        )
    low = name.lower()
    if low in FORBIDDEN or low.startswith(("sec-", "proxy-")):
        raise ValueError(f"la cabecera «{name}» la pone el propio programa y no se puede cambiar")
    return name


def check_value(name: str, value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"«{name}» necesita un valor (para quitarla, null)")
    if len(value) > MAX_VALUE:
        raise ValueError(f"el valor de «{name}» pasa de {MAX_VALUE} caracteres")
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(f"el valor de «{name}» no puede llevar saltos de línea ni caracteres de control")
    return value.strip()


def clean(raw: Any, strict: bool = False) -> dict[str, str]:
    """A set of headers checked. Lenient (what is saved on disk, an older file): what is wrong is dropped. Strict (what a person or an AI
    sends): ``ValueError`` on the first thing that is wrong. At most ``MAX_HEADERS``; the same name twice (any case) counts once."""
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        if strict:
            raise ValueError("las cabeceras tienen que ser un objeto {nombre: valor}")
        return {}
    out: dict[str, str] = {}
    seen: set[str] = set()
    for name, value in raw.items():
        try:
            checked = check_name(name)
            text = check_value(checked, value)
        except ValueError:
            if strict:
                raise
            continue
        key = checked.lower()
        if key in seen:
            if strict:
                raise ValueError(f"«{checked}» está repetida")
            continue
        seen.add(key)
        out[checked] = text
    if len(out) > MAX_HEADERS:
        if strict:
            raise ValueError(f"hasta {MAX_HEADERS} cabeceras por canal")
        out = dict(list(out.items())[:MAX_HEADERS])
    return out


def merge(current: Mapping[str, str], changes: Any) -> dict[str, str]:
    """``current`` with the changes of a person or an AI: ``{name: value}`` sets one, ``{name: null}`` removes it (any case)."""
    if not isinstance(changes, Mapping):
        raise ValueError("las cabeceras tienen que ser un objeto {nombre: valor}; null quita una")
    result = dict(current)
    for name, value in changes.items():
        if not isinstance(name, str):
            raise ValueError("el nombre de una cabecera tiene que ser texto")
        for existing in [k for k in result if k.lower() == name.lower()]:
            del result[existing]
        if value is None:
            continue
        result[check_name(name)] = check_value(name, value)
    return clean(result, strict=True)


def for_host(headers: Mapping[str, str], host: str, own_hosts: Iterable[str]) -> dict[str, str]:
    """What may be sent to ``host``: the plain headers always, the others only if it is one of the channel's own hosts."""
    own = {h.lower() for h in own_hosts}
    return {k: v for k, v in headers.items() if not is_sensitive(k) or host.lower() in own}


def describe(headers: Mapping[str, str]) -> list[dict[str, Any]]:
    """What the page and the MCP may see: every header, with its value only if it is a plain one. A credential shows that it is set."""
    return [
        {"name": k, "value": None if is_sensitive(k) else v, "secret": is_sensitive(k), "set": True}
        for k, v in headers.items()
    ]
