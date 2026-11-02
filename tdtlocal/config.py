"""Runtime configuration: defaults, paths and the :class:`Config` container."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .paths import default_data_dir, default_models_dir

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PACKAGE_DIR.parent

TV_SOURCE = "https://raw.githubusercontent.com/LaQuay/TDTChannels/master/TELEVISION.md"
RADIO_SOURCE = "https://raw.githubusercontent.com/LaQuay/TDTChannels/master/RADIO.md"
# XMLTV guides published by TDTChannels; the "EPG ID" column of the lists matches their channel ids.
EPG_SOURCES = {
    "tv": "https://www.tdtchannels.com/epg/TV.xml.gz",
    "radio": "https://www.ondachannels.com/epg/RADIO.xml.gz",
}

# A community guide (XMLTV) with channels the TDTChannels one lacks, such as Atresmedia's. Only the channels the user
# added that need it are read from it, and only if the user turns it on.
EPG_EXTRA_SOURCE = "https://raw.githubusercontent.com/davidmuma/EPG_dobleM/master/guiatv.xml"

DEFAULT_PORT = 8788
DEFAULT_LLM_URL = "http://127.0.0.1:8080/v1"
DEFAULT_WHISPER_URL = "http://127.0.0.1:8178"

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


@dataclass
class Config:
    """Everything the server needs to know before it starts. Plain data, no globals."""

    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    update_hours: float = 6.0
    auto_check: bool = False
    verbose: bool = False
    allow_quit: bool = False  # expose POST /api/quit and the "Salir" button (desktop app without a console)

    tv_source: str = TV_SOURCE
    radio_source: str = RADIO_SOURCE
    epg_enabled: bool = True
    epg_sources: dict[str, str] = field(default_factory=lambda: dict(EPG_SOURCES))
    epg_extra_enabled: bool = False  # also read the programme of own channels from epg_extra_source
    epg_extra_source: str = EPG_EXTRA_SOURCE

    data_dir: Path = field(default_factory=lambda: default_data_dir(PROJECT_DIR))
    models_dir: Path = field(default_factory=lambda: default_models_dir(PROJECT_DIR))
    static_dir: Path = PACKAGE_DIR / "static"

    ai_enabled: bool = True
    llm_url: str = DEFAULT_LLM_URL
    llm_model: str = ""
    llm_api_key: str = ""  # sent as a Bearer token; only needed for hosted endpoints
    llm_temperature: float = 0.2
    llm_max_tokens: int = 700
    llm_timeout: float = 120.0
    llm_disable_thinking: bool = True  # ask reasoning models not to "think": latency matters more here
    llm_extra_params: str = ""  # JSON object merged into every chat request (top_p, top_k...)

    stt_enabled: bool = True
    whisper_url: str = DEFAULT_WHISPER_URL
    whisper_bin: str = ""
    whisper_model: str = ""
    whisper_lang: str = "es"
    whisper_threads: int = 8
    whisper_idle_minutes: int = 10  # a whisper-server we launched stops after this long without work
    whisper_autostart: bool = True  # launch our own whisper-server when none answers

    # teletext (see teletext.py): downloads news feeds and the weather, so it is opt-in
    teletext_enabled: bool = False

    # SCTE-35 / ad-break watcher (see scte_watch.py)
    scte_enabled: bool = False
    scte_scope: str = "viewing"  # "viewing" (what is being played), "list" (scte_channels) or "all"
    scte_channels: str = ""  # comma-separated channel names or ids, for scope "list"
    scte_interval: int = 60  # seconds between active scans
    scte_inspect_segments: bool = False  # also download the start of one segment per stream (MPEG-TS PID, emsg)
    scte_notify: bool = True  # on-screen notice when a new marker is found
    scte_keep: int = 2000  # events kept in the log

    # what the page does while an ad break is on (see static/js/adbreak.js); needs scte_enabled
    ad_enabled: bool = False
    ad_flag: bool = True  # a fixed "PUBLICIDAD" notice over the picture while the break lasts
    ad_audio: str = "mute"  # "keep", "mute" or "lower" (to ad_lower_percent of the volume)
    ad_lower_percent: int = 25
    ad_screen: str = "keep"  # "keep", "channel" (switch to ad_channel) or "web" (show ad_web_url over the picture)
    ad_channel: str = ""  # name or id of the channel to switch to
    ad_web_url: str = ""
    ad_min_seconds: int = 10  # shorter breaks (when they say how long they are) are ignored
    ad_unknown_seconds: int = 120  # assumed length of a break that does not say how long it lasts
    ad_on_touch: str = "respect"  # volume or channel changed by hand during a break: "respect" it or "restore" after

    allow_private: bool = False  # tests only: lets the proxy reach loopback/private addresses
    # settings fixed by a command-line flag or environment variable: the saved value is ignored
    # and the interface shows them read-only
    locked: frozenset[str] = frozenset()

    @property
    def loopback_only(self) -> bool:
        """True when the server only listens on this machine (enables the Host header check)."""
        return self.host in LOOPBACK_HOSTS

    @property
    def update_seconds(self) -> float:
        return self.update_hours * 3600
