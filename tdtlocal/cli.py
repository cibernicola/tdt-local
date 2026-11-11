"""Command line interface: argument parsing and the main loop."""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
import webbrowser
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from . import __version__
from .app import App
from .config import DEFAULT_LLM_URL, DEFAULT_PORT, Config
from .server import create_server
from .settings import BY_NAME, FIELDS, Field, set_value

log = logging.getLogger("tdtlocal")


# Command-line flag -> setting it fixes. Every setting can also be fixed with an environment variable
# named TDT_<SETTING> (TDT_LLM_API_KEY, TDT_WHISPER_BIN...), which is how secrets should be passed.
VALUE_FLAGS = {
    "--interval": ("update_hours", "horas entre actualizaciones de la lista"),
    "--source": ("tv_source", "URL de TELEVISION.md"),
    "--radio-source": ("radio_source", "URL de RADIO.md"),
    "--epg-source": ("epg_tv_source", "URL del XMLTV (.xml o .xml.gz) de la tele"),
    "--radio-epg-source": ("epg_radio_source", "URL del XMLTV de la radio"),
    "--llm-url": ("llm_url", f"servidor de IA compatible con OpenAI, p. ej. llama.cpp ({DEFAULT_LLM_URL})"),
    "--llm-model": ("llm_model", "nombre del modelo, si el servidor lo exige"),
    "--whisper-url": ("whisper_url", "whisper-server de whisper.cpp; si no responde se lanza uno"),
    "--models-dir": ("models_dir", "carpeta donde se guardan los modelos de Whisper"),
    "--whisper-bin": ("whisper_bin", "ruta de whisper-server (por defecto, el del PATH)"),
    "--whisper-model": ("whisper_model", "modelo ggml (por defecto, el primer ggml-*.bin de la carpeta models)"),
    "--whisper-lang": ("whisper_lang", "idioma del audio (es, en, ca... o auto)"),
}
# Flag -> (setting, value it sets)
SWITCH_FLAGS = {
    "--no-epg": ("epg_enabled", False, "no descargar la guía de programación"),
    "--no-ai": ("ai_enabled", False, "desactivar el asistente de IA"),
    "--no-stt": ("stt_enabled", False, "desactivar subtítulos y alertas por voz"),
    "--auto-check": ("auto_check", True, "comprobar los streams tras cada actualización"),
}
TRUE_WORDS = ("1", "true", "yes", "on", "si", "sí")
FALSE_WORDS = ("0", "false", "no", "off")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="tdtlocal",
        description="Visor local de las listas de TDTChannels (tele y radio). Lo que fijas aquí o con variables "
        "TDT_<AJUSTE> manda sobre lo guardado en la pantalla de ajustes.",
    )
    ap.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"puerto ({DEFAULT_PORT})")
    ap.add_argument("--host", default="127.0.0.1", help="dirección donde escuchar (127.0.0.1)")
    ap.add_argument("--lan", action="store_true", help="escuchar en toda la red local (0.0.0.0), sin autenticación")
    ap.add_argument("--open", action="store_true", help="abrir el navegador")
    ap.add_argument("--quit-button", action="store_true", help="mostrar el botón «Salir» que cierra el servidor")
    ap.add_argument("--verbose", action="store_true", help="registrar cada petición HTTP")
    ap.add_argument(
        "--data-dir",
        type=Path,
        default=os.environ.get("TDT_DATA_DIR"),
        help="carpeta de datos (por defecto ./data, o la carpeta de usuario si está instalado)",
    )
    for flag, (setting, text) in VALUE_FLAGS.items():
        ap.add_argument(
            flag, dest=setting, default=None, type=float if BY_NAME[setting].kind == "float" else str, help=text
        )
    for flag, (setting, _, text) in SWITCH_FLAGS.items():
        ap.add_argument(flag, dest=setting, action="store_true", default=False, help=text)
    return ap


def _from_environment(field: Field, environ: Mapping[str, str]) -> Any:
    """The ``TDT_<NAME>`` value coerced to the setting's type, or ``None`` if it is not set."""
    raw = environ.get("TDT_" + field.name.upper())
    if raw is None:
        return None
    if field.kind == "bool":
        word = raw.strip().lower()
        if word not in TRUE_WORDS + FALSE_WORDS:
            raise ValueError("usa 1/0, true/false o yes/no")
        return word in TRUE_WORDS
    if field.kind in ("int", "float"):
        try:
            return int(raw) if field.kind == "int" else float(raw)
        except ValueError as exc:
            raise ValueError("debe ser un número") from exc
    return raw


def config_from_args(args: argparse.Namespace, environ: Mapping[str, str] | None = None) -> Config:
    """Build the configuration. Settings fixed by a flag or ``TDT_*`` variable are *locked* (see settings.py)."""
    environ = os.environ if environ is None else environ
    config = Config(
        host="0.0.0.0" if args.lan else args.host,  # noqa: S104 - explicit opt-in with --lan
        port=args.port,
        allow_quit=args.quit_button,
        verbose=args.verbose,
    )
    flags = {setting: flag for flag, (setting, _) in VALUE_FLAGS.items()}
    switches = {setting: (flag, value) for flag, (setting, value, _) in SWITCH_FLAGS.items()}
    locked: set[str] = set()
    for field in FIELDS:
        origin: str | None = None
        value: Any = None
        if field.name in switches:
            if getattr(args, field.name):
                origin, value = switches[field.name]
        elif getattr(args, field.name, None) is not None:
            origin, value = flags[field.name], getattr(args, field.name)
        try:
            if value is None:  # no flag: look for TDT_<NAME> in the environment
                origin = "TDT_" + field.name.upper()
                value = _from_environment(field, environ)
            if value is None:
                continue
            set_value(config, field.name, field.validate(value))
        except ValueError as exc:
            raise SystemExit(f"{origin}: {exc}") from exc
        locked.add(field.name)
    config.locked = frozenset(locked)
    if args.data_dir:
        config.data_dir = Path(args.data_dir).expanduser().resolve()
    return config


def configure_logging(config: Config, log_file: Path | None = None) -> None:
    """Log to the console, or to ``log_file`` when there is no console (windowed desktop app)."""
    for stream in (sys.stdout, sys.stderr):  # a console that cannot show an accent must not break logging
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handler: logging.Handler = logging.FileHandler(log_file, encoding="utf-8")
    else:
        handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%H:%M:%S"))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
    logging.getLogger("tdtlocal.access").setLevel(logging.DEBUG if config.verbose else logging.WARNING)


def run(config: Config, open_browser: bool = False) -> None:
    """Start the server and block until it is stopped (Ctrl+C, SIGTERM or ``POST /api/quit``)."""
    app = App(config)
    try:
        httpd = create_server(app)
    except OSError as exc:
        sys.exit(f"No se puede abrir {config.host}:{config.port} ({exc}). Prueba con --port.")
    app.start_background()

    port = httpd.server_address[1]  # differs from config.port when 0 was requested
    shown_host = "127.0.0.1" if config.host == "0.0.0.0" else config.host  # noqa: S104
    url = f"http://{shown_host}:{port}/"
    log.info(
        "TDT local en %s  (%d canales en caché, actualización cada %g h)",
        url,
        len(app.store.channels),
        config.update_hours,
    )
    if not config.loopback_only:
        log.warning("AVISO: accesible desde la red local; sin autenticación")
    if open_browser:
        threading.Timer(0.6, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.close()
        httpd.server_close()


def main(argv: Sequence[str] | None = None) -> None:
    words = list(sys.argv[1:] if argv is None else argv)
    if words[:1] == ["mcp"]:  # `tdt-local mcp`: the MCP server by standard input and output (an AI client starts it)
        from .mcp import main as mcp_main

        sys.exit(mcp_main(words[1:]))
    args = build_parser().parse_args(words)
    config = config_from_args(args)
    configure_logging(config)
    run(config, open_browser=args.open)


if __name__ == "__main__":
    main()
