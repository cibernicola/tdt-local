#!/usr/bin/env python3
"""tdtv: control TDT local y mpv desde la terminal, un widget o un agente de IA. Solo biblioteca estándar.

Pide los canales y la guía al servidor de TDT local (127.0.0.1:8788) y reproduce con mpv, al que gobierna por su
socket IPC; mpv se anuncia por MPRIS, así que los controles multimedia del escritorio lo ven. Con ``--json`` la
salida es estructurada. Variables: ``TDTV_URL`` (servidor), ``TDTV_MPV_ARGS`` (opciones extra de mpv),
``TDTV_FX_DIR`` (carpeta de los efectos), ``TDTV_OPEN`` (orden para abrir la app, con ``{url}``).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any, NoReturn

BASE = os.environ.get("TDTV_URL", "http://127.0.0.1:8788")
RUN = Path(os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()) / "tdtv"
SOCK, STATE = RUN / "mpv.sock", RUN / "state.json"
FX_DIR = Path(os.environ.get("TDTV_FX_DIR") or Path(__file__).resolve().parent.parent / "tdtlocal" / "static" / "fx")
UNIT = "tdt-local.service"


# ---- output
def out(data: Any, as_json: bool, text: str) -> None:
    print(json.dumps(data, ensure_ascii=False) if as_json else text)


def die(message: str, as_json: bool = False, code: int = 1) -> NoReturn:
    if as_json:
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    else:
        print("ERROR: " + message, file=sys.stderr)
    sys.exit(code)


def norm(text: str) -> str:
    """Lower case, no accents, letters and digits only: ``"La 1"`` and ``"la-1"`` are the same."""
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", text.lower()).encode("ascii", "ignore").decode())


def hhmm(ts: float) -> str:
    return time.strftime("%H:%M", time.localtime(ts))


# ---- the TDT local server
def request(path: str) -> tuple[int, Any]:
    """GET ``path``: ``(status, json)``. ``(0, None)`` if the server does not answer."""
    try:
        with urllib.request.urlopen(BASE + path, timeout=8) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.load(exc)
        except ValueError:
            return exc.code, None
    except (OSError, ValueError):
        return 0, None


def get(path: str) -> Any:
    """The JSON of ``path``. If the server is down it tries to start it (systemd user unit) and waits a little."""
    status, data = request(path)
    if status == 0 and shutil.which("systemctl"):
        subprocess.run(["systemctl", "--user", "start", UNIT], check=False, capture_output=True)
        for _ in range(20):
            time.sleep(1)
            status, data = request(path)
            if status:
                break
    if status == 0:
        die(f"el servidor de TDT local no responde en {BASE} (¿está en marcha?)")
    if status >= 400:
        die(f"{path}: el servidor contestó {status}")
    return data


def channels() -> list[dict[str, Any]]:
    return get("/api/channels")["channels"]


def epg_now() -> dict[str, dict[str, Any]]:
    """``{epg_id: {"now": {...}, "next": {...}}}`` from the next programmes of every channel."""
    now = time.time()
    result: dict[str, dict[str, Any]] = {}
    for key, programmes in (get("/api/epg").get("now") or {}).items():
        current = next((p for p in programmes if p[0] <= now < p[1]), None)
        following = next((p for p in programmes if p[0] >= (current[1] if current else now)), None)
        result[key] = {
            "now": current and {"title": current[2], "start": current[0], "end": current[1]},
            "next": following and {"title": following[2], "start": following[0]},
        }
    return result


def find(chs: list[dict[str, Any]], query: str, kind: str | None = None) -> list[dict[str, Any]]:
    """Channels named like ``query``: exact name or id first, then names that start with it, then that contain it.

    Without ``kind`` the television is searched first and, if nothing matches, the radio.
    """
    wanted = norm(query)
    tests = (
        lambda c: wanted in (norm(c["id"]), norm(c["name"])),
        lambda c: norm(c["name"]).startswith(wanted),
        lambda c: wanted in norm(c["name"]),
    )
    for pool_kind in [kind] if kind else ["tv", "radio"]:
        pool = [c for c in chs if c["kind"] == pool_kind]
        for test in tests:
            hits = [c for c in pool if test(c)]
            if hits:
                return hits
    return []


# ---- mpv
def mpv(command: list[Any], sock: Path | None = None) -> Any:
    """Send one command to mpv's IPC socket. Returns its ``data`` (``None`` on failure or if it has none)."""
    try:
        conn = socket.socket(socket.AF_UNIX)
        conn.settimeout(2)
        conn.connect(str(sock or SOCK))
    except (OSError, AttributeError):
        return None
    with conn:
        try:
            conn.sendall(json.dumps({"command": command}).encode() + b"\n")
            buffer = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    return None
                *lines, buffer = (buffer + chunk).split(b"\n")
                for line in lines:  # mpv also sends events: the answer is the line with "error"
                    try:
                        message = json.loads(line)
                    except ValueError:
                        continue
                    if "error" in message:
                        return message.get("data") if message["error"] == "success" else None
        except OSError:
            return None


def alive() -> bool:
    return SOCK.exists() and mpv(["get_property", "pid"]) is not None


def need() -> None:
    if not alive():
        die("no hay nada reproduciéndose (tdtv play <canal>)")


def state() -> dict[str, Any]:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def lavfi(graph: str) -> str:
    """An ffmpeg filter graph as an mpv ``--af`` value (length-prefixed, so its commas and colons are safe)."""
    return f"lavfi=graph=%{len(graph)}%{graph}"


def fx_defs() -> dict[str, Any]:
    try:
        return json.loads((FX_DIR / "fx.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        die(f"no encuentro los efectos de imagen en {FX_DIR} (TDTV_FX_DIR; ¿tu TDT local los incluye?)")


def fx_plan(names: list[str]) -> tuple[list[str], str]:
    """The shader files and the audio filter graph of the effects in ``names``."""
    defs = fx_defs()
    shaders = [str(FX_DIR / defs[n]["shader"]) for n in names if n in defs]
    audio = ",".join(defs[n]["af"] for n in names if n in defs and defs[n].get("af"))
    return shaders, audio


def start_mpv(channel: dict[str, Any], source: int, audio_only: bool) -> str:
    sources = [s for s in channel["sources"] if "[" not in s["u"] and s.get("ok") is not False] or channel["sources"]
    if source >= len(sources):
        die(f"{channel['name']} solo tiene {len(sources)} fuentes")
    url = sources[source]["u"]
    if channel.get("custom") or channel.get("headers"):  # its request headers are added by the server's proxy
        url = f"{BASE}/proxy?u={urllib.parse.quote(url, safe='')}&c={urllib.parse.quote(channel['id'])}"
    now = epg_now().get(channel.get("epg") or "", {}).get("now")
    title = channel["name"] + (f" — {now['title']}" if now else "")
    RUN.mkdir(mode=0o700, parents=True, exist_ok=True)
    running = alive()
    effects = state().get("fx", []) if running else []  # a channel change keeps the volume and the effects
    volume = mpv(["get_property", "volume"]) if running else None
    if running:
        mpv(["quit"])
        time.sleep(0.4)
    SOCK.unlink(missing_ok=True)
    args = [
        "mpv", f"--input-ipc-server={SOCK}", f"--force-media-title={title}", "--title=TDT · ${media-title}",
        "--really-quiet", "--no-terminal", "--profile=low-latency", "--cache=yes", "--demuxer-max-bytes=64MiB",
        "--keep-open=no", "--force-window=yes", "--geometry=50%x50%", "--ytdl=no", "--osc=yes",
    ]  # fmt: skip
    if volume is not None:
        args.append(f"--volume={volume:g}")
    if effects:
        shaders, audio = fx_plan(effects)
        if shaders:
            args.append("--glsl-shaders=" + ":".join(shaders))
        if audio:
            args.append("--af=" + lavfi(audio))
    if audio_only:
        args += ["--no-video", "--force-window=no"]
    args += [*os.environ.get("TDTV_MPV_ARGS", "").split(), url]
    subprocess.Popen(
        args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True
    )
    for _ in range(40):
        time.sleep(0.25)
        if alive():
            break
    else:
        die("mpv no arrancó")
    keep = {k: channel.get(k) for k in ("id", "name", "kind", "category", "epg")}
    STATE.write_text(json.dumps({**keep, "source": source, "since": int(time.time()), "fx": effects}), encoding="utf-8")
    return title


# ---- commands
def cmd_list(a: argparse.Namespace) -> None:
    chs = [c for c in channels() if c["kind"] == a.kind]
    if a.cat:
        chs = [c for c in chs if norm(a.cat) in norm(c["category"])]
    if a.q:
        chs = [c for c in chs if norm(a.q) in norm(c["name"])]
    rows = [{"id": c["id"], "name": c["name"], "category": c["category"], "epg": bool(c.get("epg"))} for c in chs]
    if a.limit:
        rows = rows[: a.limit]
    out(rows, a.json, "\n".join(f"{r['id']:28} {r['name']:34} {r['category']}" for r in rows) or "sin resultados")


def cmd_cats(a: argparse.Namespace) -> None:
    counts = Counter(c["category"] for c in channels() if c["kind"] == a.kind)
    out(dict(counts), a.json, "\n".join(f"{n:5} {name}" for name, n in counts.most_common()))


def cmd_now(a: argparse.Namespace) -> None:
    chs, guide = channels(), epg_now()
    if a.q:
        picked = [c for q in a.q for c in find(chs, q, "tv")[: 3 if len(a.q) == 1 else 1]]
    else:
        picked = [c for c in chs if c["kind"] == "tv" and c["category"] == "Nacionales" and c.get("epg")]
    rows = [
        {"id": c["id"], "name": c["name"], **guide.get(c.get("epg") or "", {"now": None, "next": None})} for c in picked
    ]

    def line(row: dict[str, Any]) -> str:
        now, nxt = row["now"], row["next"]
        text = f"{row['name']:22} " + (f"{hhmm(now['start'])}-{hhmm(now['end'])} {now['title']}" if now else "sin guía")
        return text + (f"   → {hhmm(nxt['start'])} {nxt['title']}" if nxt else "")

    out(rows, a.json, "\n".join(map(line, rows)) or "sin coincidencias")


def cmd_play(a: argparse.Namespace) -> None:
    if not shutil.which("mpv"):
        die("falta mpv", a.json)
    hits = find(channels(), a.canal, "radio" if a.radio else None)
    if not hits:
        die(f"no encuentro «{a.canal}» (prueba: tdtv list --q {a.canal})", a.json, 2)
    exact = [c for c in hits if norm(c["name"]) == norm(a.canal)]
    if len(hits) > 1 and not exact and not a.first:
        names = [c["name"] for c in hits[:8]]
        if a.json:
            print(json.dumps({"ok": False, "ambiguous": names}, ensure_ascii=False))
            sys.exit(3)
        die("ambiguo, elige uno: " + " | ".join(names), code=3)
    channel = (exact or hits)[0]
    title = start_mpv(channel, a.source, a.radio or channel["kind"] == "radio")
    out({"ok": True, "playing": channel["name"], "id": channel["id"], "title": title}, a.json, f"▶ {title}")


def cmd_status(a: argparse.Namespace) -> None:
    if not alive():
        out({"playing": False}, a.json, "parado")
        return
    saved = state()
    paused, muted = mpv(["get_property", "pause"]), mpv(["get_property", "mute"])
    volume, title = mpv(["get_property", "volume"]), mpv(["get_property", "media-title"])
    guide = epg_now().get(saved.get("epg") or "", {})
    now = guide.get("now")
    data = {
        "playing": True, "paused": bool(paused), "muted": bool(muted), "volume": volume, "channel": saved.get("name"),
        "id": saved.get("id"), "kind": saved.get("kind"), "title": title, "now": now, "next": guide.get("next"),
    }  # fmt: skip
    text = f"{'⏸' if paused else '▶'} {saved.get('name')}"
    text += f" · {now['title']} ({hhmm(now['start'])}-{hhmm(now['end'])})" if now else ""
    text += f" · vol {(volume or 0):.0f}%" + (" · mute" if muted else "")
    out(data, a.json, text)


def cmd_ctl(a: argparse.Namespace) -> None:
    need()
    commands = {
        "pause": ["set_property", "pause", True],
        "resume": ["set_property", "pause", False],
        "toggle": ["cycle", "pause"],
        "mute": ["cycle", "mute"],
        "fullscreen": ["cycle", "fullscreen"],
        "stop": ["quit"],
    }
    mpv(commands[a.cmd])
    if a.cmd == "stop":
        STATE.unlink(missing_ok=True)
        out({"ok": True}, a.json, "■ parado")
    else:
        cmd_status(a)


def cmd_vol(a: argparse.Namespace) -> None:
    need()
    try:
        amount = float(a.value)
    except ValueError:
        die("volumen: un número (60) o un cambio (+5, -5)", a.json, 2)
    mpv(["add", "volume", amount] if a.value[0] in "+-" else ["set_property", "volume", amount])
    cmd_status(a)


def cmd_zap(a: argparse.Namespace) -> None:
    need()
    saved = state()
    pool = [c for c in channels() if c["kind"] == saved["kind"] and c["category"] == saved["category"]]
    index = next((i for i, c in enumerate(pool) if c["id"] == saved["id"]), 0)
    channel = pool[(index + (1 if a.cmd == "next" else -1)) % len(pool)]
    title = start_mpv(channel, 0, saved["kind"] == "radio")
    out({"ok": True, "playing": channel["name"]}, a.json, f"▶ {title}")


def cmd_fx(a: argparse.Namespace) -> None:
    defs, current = fx_defs(), state().get("fx", [])
    verb = a.args[0] if a.args else "list"
    names = a.args[1:] if verb in ("on", "add", "toggle") else a.args
    if verb == "list":
        rows = [{"name": n, "desc": d["desc"], "active": n in current} for n, d in defs.items()]
        out(rows, a.json, "\n".join(f"{'●' if r['active'] else '○'} {r['name']:12} {r['desc']}" for r in rows))
        return
    if verb == "off":
        chosen: list[str] = []
    elif verb == "toggle":
        chosen = [n for n in current if n not in names] + [n for n in names if n not in current]
    elif verb == "add":
        chosen = current + [n for n in names if n not in current]
    else:
        chosen = list(names)
    unknown = [n for n in chosen if n not in defs]
    if unknown:
        die("efecto desconocido: " + ", ".join(unknown) + " (tdtv fx list)", a.json, 2)
    need()
    shaders, audio = fx_plan(chosen)
    mpv(["set_property", "glsl-shaders", shaders])
    mpv(["af", "set", lavfi(audio)] if audio else ["af", "clr", ""])
    STATE.write_text(json.dumps({**state(), "fx": chosen}), encoding="utf-8")
    out({"ok": True, "fx": chosen}, a.json, "efectos: " + (", ".join(chosen) or "ninguno"))


def open_app(url: str) -> None:
    """Open TDT local as an app window. On Omarchy an open window is closed first so the new one lands on ``url``."""
    custom = os.environ.get("TDTV_OPEN")
    if custom:
        command = [part.replace("{url}", url) for part in custom.split()]
    elif shutil.which("omarchy"):
        if shutil.which("hyprctl"):
            close_windows("TDT local")
        command = ["omarchy", "launch", "or", "focus", "webapp", "TDT", url]
    else:
        command = ["xdg-open", url]
    subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def close_windows(title_prefix: str) -> None:
    """Close the Hyprland windows whose title starts with ``title_prefix`` (Omarchy drives Hyprland with Lua)."""
    try:
        clients = json.loads(
            subprocess.run(["hyprctl", "clients", "-j"], capture_output=True, text=True, timeout=5).stdout
        )
        for client in clients:
            if client.get("title", "").startswith(title_prefix):
                code = f'hl.dsp.window.close({{ window = "address:{client["address"]}" }})'
                subprocess.run(["hyprctl", "dispatch", code], capture_output=True, timeout=5)
        time.sleep(0.6)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass


def cmd_web(a: argparse.Namespace) -> None:
    open_app(BASE + "/")
    out({"ok": True, "url": BASE + "/"}, a.json, "abriendo " + BASE)


def cmd_ttx(a: argparse.Namespace) -> None:
    page = (a.page or "100").strip()
    if not re.fullmatch(r"[1-8][0-9]{2}", page):
        die("página: 3 cifras, entre 100 y 899", a.json, 2)
    if not (a.text or a.json):
        open_app(f"{BASE}/#ttx={page}")
        out({"ok": True, "url": f"{BASE}/#ttx={page}"}, a.json, f"teletexto {page} en la app de TDT local")
        return
    status, data = request(f"/api/teletext/page?n={page}")
    if status == 0:
        die(f"el servidor de TDT local no responde en {BASE}", a.json)
    if status == 404 and not (data or {}).get("pages"):
        die(
            "el teletexto no está activado (Ajustes ▸ Listas y guía) o esta versión de TDT local no lo tiene", a.json, 2
        )
    if status != 200:
        die(f"no existe la página {page}; hay: {', '.join((data or {}).get('pages', []))}", a.json, 2)
    index = min(max(a.sub, 1), len(data["subpages"])) - 1
    rows = data["subpages"][index]
    result = {
        "page": page,
        "subpage": index + 1,
        "subpages": len(data["subpages"]),
        "updated": data["updated"],
        "rows": rows,
    }
    out(
        result,
        a.json,
        f"── Teletexto {page}  subpágina {index + 1}/{len(data['subpages'])} ──\n" + "\n".join(rows).rstrip(),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tdtv", description="Controla TDT local y mpv: canales, guía, volumen, efectos y teletexto."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name: str, func: Any, help_text: str, **defaults: Any) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--json", action="store_true", help="salida estructurada")
        p.set_defaults(func=func, **defaults)
        return p

    kinds = ["tv", "radio", "u7d"]
    p = add("list", cmd_list, "listar canales")
    p.add_argument("--kind", default="tv", choices=kinds)
    p.add_argument("--cat")
    p.add_argument("--q")
    p.add_argument("--limit", type=int, default=0)
    add("cats", cmd_cats, "categorías").add_argument("--kind", default="tv", choices=kinds)
    add("now", cmd_now, "qué hay en la tele según la guía; sin canal, los nacionales").add_argument("q", nargs="*")
    p = add("play", cmd_play, "poner un canal o una emisora")
    p.add_argument("canal")
    p.add_argument("--radio", action="store_true")
    p.add_argument("--source", type=int, default=0, help="otra fuente del canal si la primera falla")
    p.add_argument("--first", action="store_true", help="si hay varios candidatos, el primero")
    add("status", cmd_status, "qué suena ahora")
    for name in ("pause", "resume", "toggle", "mute", "stop", "fullscreen"):
        add(name, cmd_ctl, name, cmd=name)
    add("vol", cmd_vol, "volumen: 60, +5, -5").add_argument("value")
    for name in ("next", "prev"):
        add(name, cmd_zap, "canal siguiente o anterior de la misma categoría", cmd=name)
    add("fx", cmd_fx, "efectos de imagen y audio en mpv: list | <efectos…> | add/toggle <efecto> | off").add_argument(
        "args", nargs="*"
    )
    p = add("ttx", cmd_ttx, "teletexto: abrir la app en una página, o --text para leerla aquí")
    p.add_argument("page", nargs="?")
    p.add_argument("--text", action="store_true")
    p.add_argument("--sub", type=int, default=1)
    add("web", cmd_web, "abrir la interfaz de TDT local como app")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
