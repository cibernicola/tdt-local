"""Stream health checks: does the playlist, a variant and a segment actually answer?"""

from __future__ import annotations

import logging
import re
import threading
import time
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

from .net import Blocked, Net
from .store import Store

log = logging.getLogger(__name__)

AUDIO_FMTS = ("aac", "mp3", "stream", "ogg", "opus")  # radio: direct audio, no HLS playlist
HLS_URL = re.compile(r"\.m3u8?(\?|$)", re.I)
MAX_PLAYLIST = 4_000_000
CHECK_WORKERS = 24
PROBE_TIMEOUT = 8

Result = dict[str, object]


class HealthChecker:
    def __init__(
        self, store: Store, net: Net, workers: int = CHECK_WORKERS, stop: threading.Event | None = None
    ) -> None:
        self.store = store
        self.net = net
        self.workers = workers
        self.stop = stop or threading.Event()  # the app's: set when it closes, so a check under way skips what is left

    # ---- single probes
    def _read_playlist(self, url: str) -> tuple[list[str], str]:
        with self.net.open(url, require_allowed=False, timeout=PROBE_TIMEOUT) as response:
            body = response.read(MAX_PLAYLIST)
            final = response.geturl()
        text = body.decode("utf-8", "replace").lstrip("\ufeff \r\n\t")
        if not text.startswith("#EXTM3U"):
            raise ValueError("no es una lista m3u8")
        return [line.strip() for line in text.splitlines() if line.strip()], final

    @staticmethod
    def _failure(exc: Exception) -> Result:
        if isinstance(exc, urllib.error.HTTPError):
            err = f"HTTP {exc.code}"
        elif isinstance(exc, Blocked):
            err = f"bloqueado: {exc}"
        else:
            err = type(exc).__name__
        return {"ok": False, "err": err, "ts": int(time.time())}

    def probe_audio(self, url: str) -> Result:
        started = time.time()
        try:
            with self.net.open(url, require_allowed=False, timeout=PROBE_TIMEOUT) as response:
                ctype = (response.headers.get("Content-Type") or "").lower()
                head = response.read(2048)
            if not head:
                raise ValueError("sin datos")
            if "html" in ctype or head.lstrip()[:7] == b"#EXTM3U":
                raise ValueError("no es audio")
            return {"ok": True, "ms": int((time.time() - started) * 1000), "ts": int(time.time())}
        except Exception as exc:
            return self._failure(exc)

    def probe(self, url: str, fmt: str = "") -> Result:
        """Check one stream. HLS: playlist -> first variant -> last segment. Radio: first bytes of audio."""
        if fmt in AUDIO_FMTS and not HLS_URL.search(url):
            return self.probe_audio(url)
        started = time.time()
        try:
            lines, base = self._read_playlist(url)
            index = next((k for k, line in enumerate(lines) if line.startswith("#EXT-X-STREAM-INF")), None)
            if index is not None:
                variant = next((line for line in lines[index + 1 :] if not line.startswith("#")), None)
                if not variant:
                    raise ValueError("lista maestra sin variantes")
                lines, base = self._read_playlist(urllib.parse.urljoin(base, variant))
            segments = [line for line in lines if not line.startswith("#")]
            if not segments:
                raise ValueError("lista sin segmentos")
            with self.net.open(
                urllib.parse.urljoin(base, segments[-1]), {"Range": "bytes=0-1023"}, False, PROBE_TIMEOUT
            ) as response:
                response.read(1024)
            return {"ok": True, "ms": int((time.time() - started) * 1000), "ts": int(time.time())}
        except Exception as exc:
            return self._failure(exc)

    # ---- batch
    def start(self, kind: str = "tv") -> bool:
        """Launch a background check of ``"tv"``, ``"radio"`` or ``"all"``. False if one is already running."""
        store = self.store
        with store.lock:
            if store.health["running"]:
                return False
            items = list(store.sources(kind).items())
            store.health.update(running=True, done=0, total=len(items))
        threading.Thread(target=self._run, args=(items,), daemon=True, name="health-check").start()
        return True

    def _run(self, items: list[tuple[str, str]]) -> None:
        store = self.store
        results: dict[str, Result] = {}

        def work(item: tuple[str, str]) -> None:
            if self.stop.is_set():  # the pool's threads keep the process alive until its queue is empty: empty it
                return
            results[item[0]] = self.probe(*item)
            with store.lock:
                store.health["done"] += 1

        try:
            with ThreadPoolExecutor(self.workers) as pool:
                list(pool.map(work, items))
            with store.lock:
                # keep what was already checked for the other kind; drop URLs that no longer exist
                valid = store.sources("all")
                store.status = {u: r for u, r in {**store.status, **results}.items() if u in valid}
                store.health["finished"] = int(time.time())
            store.save_status()
            log.info("comprobación: %d/%d streams responden", sum(1 for r in results.values() if r["ok"]), len(results))
        finally:
            with store.lock:
                store.health["running"] = False
