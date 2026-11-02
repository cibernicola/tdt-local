// One tile = one <video> with its own hls.js player, notice and chain of fallback sources.
// In single view only the active tile is visible; in multi-view there are four and only the active one has sound.
import { postStt } from './api.js';
import { el, fillLogo } from './dom.js';
import { audioTarget, audioTouched } from './lib/adbreak.js';
import { chainFor } from './audio.js';
import { ATRES_ORIGIN, ContentClock, audioMessage, fxMessage, parseBridge } from './lib/bridge.js';
import { buildPlan, originNote, usesHls } from './lib/plan.js';
import { atresEmbed } from './lib/embeds.js';
import { ytEmbed } from './lib/youtube.js';
import { loadTwitchSdk, syncTwitchAudio, twitchChannel, twitchWeb } from './lib/twitch.js';
import { parseU7d } from './lib/u7d.js';

const ATTEMPT_TIMEOUT_MS = 15000;
const MAX_NETWORK_RETRIES = 3;
const BRIDGE_WAIT_MS = 6000; // how long to wait for the bridge script before saying it was not detected

/**
 * What a tile needs from the application (keeps this file independent of the page's global state).
 * @typedef {object} TileHost
 * @property {() => ('single'|'multi')} mode
 * @property {() => number} focus - index of the tile that owns the audio
 * @property {() => {v: number, m: boolean}} volume
 * @property {(v: {v: number, m: boolean}) => void} setVolume - the user changed the volume of the single view
 * @property {(i: number) => void} requestFocus
 * @property {() => void} toggleFull
 * @property {(c: object) => number} numOf - number of the channel in the visible list
 * @property {(c: object) => string} epgLine
 * @property {() => void} deckChanged - the active tile's information changed
 * @property {() => void} cleared - the user emptied a tile
 * @property {(c: object) => ({u: string}|undefined)} preferred - source that worked last time
 * @property {(c: object, url: string) => void} remember
 * @property {(f: string) => boolean} canPlayFmt
 * @property {(tile: Tile, text: string) => void} spoke - text transcribed on this tile (for voice alerts)
 * @property {(tile: Tile) => void} fragSeen - the player asked for a segment (an ad-break marker may be waiting for it)
 * @property {(tile: Tile, v: {v: number, m: boolean}) => void} adVolume - the user changed the audio during an ad break
 * @property {(tile: Tile, on: boolean, contentSeconds: number) => void} adExternal - the player inside the tile says an ad
 *   break starts or ends (and how long it had been showing programme)
 * @property {(c: object | null) => ({level: object, eq: object} | null)} audioFx - leveler and equalizer settings of a channel
 */

export class Tile {
  /** @param {number} i @param {TileHost} host */
  constructor(i, host) {
    this.i = i;
    this.host = host;
    this.c = null; // assigned channel
    this.running = false; // playback of this.c was started
    this.failed = false; // no signal: the rotation skips it
    this.info = '';
    this.token = 0;
    this.hls = null;
    this.timer = null;
    this.session = null;
    this.duck = null; // audio changed for an ad break: {muted} or {gain}
    this.adBox = null; // the web shown during an ad break
    this.chain = null; // Web Audio chain (leveler, equalizer), made when a channel needs it
    this.failCode = 0; // HTTP status the origin last answered with an error (to tell the user why it failed)

    const root = (this.root = el('div', 'tile'));
    root.tabIndex = 0;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Casilla ' + (i + 1));
    const video = (this.video = el('video'));
    video.playsInline = true;
    video.controls = true;

    const bar = el('div', 'tile-bar');
    this.numEl = el('span', 'tile-num');
    this.nameEl = el('span', 'tile-name');
    this.epgEl = el('span', 'tile-epg');
    const x = el('button', 'tile-clear', '✕');
    x.type = 'button';
    x.title = 'Vaciar casilla';
    x.setAttribute('aria-label', 'Vaciar casilla ' + (i + 1));
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clear();
      host.cleared();
    });
    bar.append(this.numEl, this.nameEl, this.epgEl, x);
    const twitchActions = el('span', 'twitch-actions');
    const listen = el('button', 'btn', 'Escuchar');
    listen.type = 'button';
    listen.setAttribute('aria-label', 'Escuchar Twitch en la casilla ' + (i + 1));
    listen.addEventListener('click', () => host.requestFocus(i));
    this.twitchLink = el('a', 'btn', 'Abrir en Twitch');
    this.twitchLink.target = '_blank';
    this.twitchLink.rel = 'noopener noreferrer';
    twitchActions.append(listen, this.twitchLink);
    bar.append(twitchActions);

    this.noticeEl = el('div', 'notice');
    this.noticeEl.hidden = true;
    this.noticeText = el('p');
    this.noticeActions = el('div', 'notice-actions');
    this.noticeEl.append(this.noticeText, this.noticeActions);

    // radio has no picture: show its logo and name instead of the video
    const cover = (this.cover = el('div', 'tile-cover'));
    this.coverLogo = el('span', 'tile-cover-logo');
    this.coverName = el('span', 'tile-cover-name');
    cover.append(this.coverLogo, this.coverName);
    this.coverFor = null;

    // YouTube lives in an <iframe> that swallows clicks: on inactive tiles an overlay catches them
    this.frame = null;
    this.twitch = null;
    this.frameKind = ''; // 'youtube' (it takes commands) or 'atres' (its own player: only through the bridge script)
    this.onBridge = null; // listener of the messages of the bridge script inside Atresplayer's player
    this.bridged = false;
    this.contentClock = new ContentClock();
    this.atresMeter = null; // what the leveler inside Atresplayer's player last said: {loudness, gainDb, at}
    this.bridgeTimer = 0; // tells the user when the bridge script has not shown up
    this.flagEl = null; // the "PUBLICIDAD" notice
    // transcription (Whisper): session tag, subtitles and the timeline position of each segment
    this.tag = '';
    this.stt = false;
    this.sttSeq = 0;
    this.sttMsg = '';
    this.polling = false;
    this.liveText = '';
    this.subTimer = null;
    this.fragStart = new Map();
    this.track = null;
    this.subEl = el('div', 'tile-sub');
    this.subEl.hidden = true;
    root.append(video, cover, el('div', 'tile-hit'), this.subEl, bar, this.noticeEl, el('div', 'tile-prog'));

    root.addEventListener('click', (e) => {
      if (host.mode() === 'multi' && !e.target.closest('button, a')) host.requestFocus(i);
    });
    root.addEventListener('keydown', (e) => {
      if (host.mode() === 'multi' && e.target === root && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        host.requestFocus(i);
      }
    });
    video.addEventListener('dblclick', () => host.toggleFull());
    video.addEventListener('volumechange', () => {
      // only what the user does with the single view's controls counts
      if (host.mode() !== 'single' || this.i !== host.focus()) return;
      const now = { v: video.volume, m: video.muted };
      if (!this.duck) { host.setVolume(now); return; }
      // during an ad break the audio is not the user's: a different value than the one set is the user's doing
      if (audioTouched(now, this.audioWanted())) host.adVolume(this, now);
    });
  }

  audioWanted() {
    return audioTarget(this.host.volume(), this.duck, this.i === this.host.focus());
  }

  syncAudio() {
    const want = this.audioWanted();
    this.video.volume = want.v;
    this.video.muted = want.m;
    if (this.frame && this.frameKind === 'youtube') this.ytCmd(want.m ? 'mute' : 'unMute');
    if (this.frame && this.frameKind === 'atres') this.atresAudio(want);
    if (this.twitch) syncTwitchAudio(this.twitch, want);
    this.syncFx();
  }

  /** The leveler and equalizer of this tile's channel. The chain is only made when something needs it. */
  syncFx() {
    if (this.frame) { // Atresplayer's player processes its own sound, if the bridge came as an extension
      if (this.frameKind === 'atres') this.atresFx(this.host.audioFx(this.c));
      return;
    }
    const fx = this.host.audioFx(this.c);
    if (!this.chain && fx && (fx.level.on || fx.eq.on)) this.chain = chainFor(this.video);
    if (this.chain && fx) this.chain.configure(fx);
  }

  /** Change the audio for an ad break (`{muted: true}` or `{gain: 0.25}`), or give it back with `null`. */
  setDuck(duck) {
    this.duck = duck;
    this.syncAudio();
  }

  /** Atresplayer's player has no API: the bridge script inside it (if the user installed it) can silence it. */
  atresAudio(want) {
    try {
      this.frame.contentWindow.postMessage(audioMessage(want), ATRES_ORIGIN);
    } catch { /* it has not loaded yet */ }
  }

  /** The leveler and equalizer for the sound of Atresplayer's player: the bridge applies them inside it. */
  atresFx(fx) {
    if (!fx) return;
    try {
      this.frame.contentWindow.postMessage(fxMessage(fx), ATRES_ORIGIN);
    } catch { /* it has not loaded yet */ }
  }

  /** What the bridge script inside Atresplayer's player said. */
  fromBridge(message) {
    if (message.kind === 'ready') {
      this.bridged = true;
      this.setInfo('Reproductor de Atresplayer · puente activo (se avisa de la publicidad)');
      this.syncAudio();
    } else if (message.kind === 'ad') {
      this.host.adExternal(this, message.on, this.contentClock.update(message, Date.now()));
    } else if (message.kind === 'meter') {
      this.atresMeter = { loudness: message.loudness, gainDb: message.gainDb, at: Date.now() };
    }
  }

  /** The fixed "PUBLICIDAD" notice over the picture, while an ad break lasts. */
  setAdFlag(on) {
    if (!on) {
      if (this.flagEl) this.flagEl.remove();
      this.flagEl = null;
      return;
    }
    if (this.flagEl) return;
    this.flagEl = el('div', 'tile-adflag', 'PUBLICIDAD');
    this.flagEl.setAttribute('role', 'status');
    this.root.append(this.flagEl);
  }

  /** Show a web over the picture (it stays until it is closed, the break ends or the channel changes). */
  showAdFrame(url) {
    this.hideAdFrame();
    const box = el('div', 'tile-ad');
    const bar = el('div', 'tile-ad-bar');
    const open = el('a', 'btn', 'Abrir aparte');
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    const close = el('button', 'btn', '✕');
    close.type = 'button';
    close.title = 'Cerrar';
    close.setAttribute('aria-label', 'Cerrar la web de la pausa');
    close.addEventListener('click', () => this.hideAdFrame());
    bar.append(el('span', '', 'Pausa de anuncios'), open, close);
    const frame = el('iframe', 'tile-ad-frame');
    frame.title = 'Web durante la pausa de anuncios';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    frame.referrerPolicy = 'no-referrer';
    frame.src = url;
    box.append(bar, frame);
    this.root.append(box);
    this.adBox = box;
  }

  hideAdFrame() {
    if (this.adBox) this.adBox.remove();
    this.adBox = null;
  }

  // ---- subtitles
  sttSet(want) {
    if (this.stt === want) return;
    this.stt = want;
    if (want) {
      this.sttMsg = 'iniciando…';
      if (this.tag) this.sttRegister();
      return;
    }
    if (this.tag) postStt(this.tag, false);
    this.sttMsg = '';
    this.clearSub();
  }

  sttRegister() {
    this.sttSeq = 0;
    postStt(this.tag, true).then((ok) => { if (!ok) this.sttMsg = 'no disponible'; });
  }

  // hls.js reports every segment it requests: its start on the video timeline anchors the subtitles
  noteFrag(frag) {
    try {
      const u = new URL(frag.url, location.href).searchParams.get('u');
      if (!u) return;
      this.fragStart.set(u, frag.start);
      if (this.fragStart.size > 60) this.fragStart.delete(this.fragStart.keys().next().value);
      this.host.fragSeen(this);
    } catch { /* odd URL */ }
  }

  sttItem(item) {
    const segs = item.segs || [];
    if (!segs.length) return;
    const start = item.u ? this.fragStart.get(item.u) : undefined;
    if (start === undefined) { // continuous stream: show it when it arrives
      this.live(segs.map((x) => x[2]).join(' '), item.dur);
      return;
    }
    if (!this.track) {
      this.track = this.video.addTextTrack('subtitles', 'Whisper', 'es');
      this.track.mode = 'hidden';
      this.track.addEventListener('cuechange', () => this.drawSub());
    }
    for (const [a, b, text] of segs) {
      const cue = new VTTCue(start + a, start + Math.max(b, a + 1), text);
      cue.onenter = () => this.host.spoke(this, text);
      this.track.addCue(cue);
    }
    for (const old of Array.from(this.track.cues || [])) { // do not accumulate hours of cues
      if (old.endTime < this.video.currentTime - 120) this.track.removeCue(old);
    }
  }

  live(text, dur) {
    this.liveText = text;
    this.drawSub();
    this.host.spoke(this, text);
    clearTimeout(this.subTimer);
    this.subTimer = setTimeout(() => { this.liveText = ''; this.drawSub(); }, Math.max(4000, dur * 1000 + 1500));
  }

  drawSub() {
    const cues = this.track && this.track.activeCues ? Array.from(this.track.activeCues).map((c) => c.text).join(' ') : '';
    const text = this.liveText || cues;
    this.subEl.textContent = text;
    this.subEl.hidden = !text;
  }

  clearSub() {
    clearTimeout(this.subTimer);
    this.liveText = '';
    if (this.track) for (const c of Array.from(this.track.cues || [])) this.track.removeCue(c);
    this.subEl.textContent = '';
    this.subEl.hidden = true;
  }

  // YouTube's API without loading its script: commands over postMessage (the iframe has enablejsapi=1)
  ytCmd(func) {
    try {
      this.frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: '' }), 'https://www.youtube-nocookie.com');
    } catch { /* the player has not loaded yet */ }
  }

  // ---- state shown to the user
  setInfo(text) {
    this.info = text;
    if (this.i === this.host.focus()) this.host.deckChanged();
  }

  showNotice(text, actions) {
    this.noticeText.textContent = text;
    this.noticeActions.replaceChildren(...(actions || []).map((a) => {
      const n = a.href ? el('a', 'btn', a.label) : el('button', 'btn' + (a.primary ? ' primary' : ''), a.label);
      if (a.href) {
        n.href = a.href;
        n.target = '_blank';
        n.rel = 'noopener noreferrer';
      } else {
        n.type = 'button';
        n.addEventListener('click', a.fn);
      }
      return n;
    }));
    this.noticeEl.hidden = false;
  }

  hideNotice() { this.noticeEl.hidden = true; }

  showEmpty() {
    this.info = '';
    this.draw();
    this.showNotice('Casilla vacía. Elige un canal de la lista para verlo aquí.');
  }

  draw() {
    const c = this.c;
    this.numEl.textContent = c ? String(this.host.numOf(c) || '') : '';
    this.nameEl.textContent = c ? c.name : 'Casilla vacía';
    this.epgEl.textContent = c ? this.host.epgLine(c) : '';
    const radio = !!c && c.kind === 'radio';
    this.root.classList.toggle('audio', radio);
    if (radio && this.coverFor !== c.id) {
      this.coverFor = c.id;
      fillLogo(this.coverLogo, c);
      this.coverName.textContent = c.name;
    }
  }

  // ---- lifecycle
  teardown() {
    clearTimeout(this.timer);
    if (this.session && this.session.cleanup) this.session.cleanup();
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (this.tag && this.stt) postStt(this.tag, false);
    this.tag = '';
    this.fragStart.clear();
    this.clearSub();
    this.hideAdFrame();
    this.setAdFlag(false);
    if (this.onBridge) { window.removeEventListener('message', this.onBridge); this.onBridge = null; }
    clearTimeout(this.bridgeTimer);
    this.bridged = false;
    this.atresMeter = null;
    this.contentClock = new ContentClock();
    if (this.frame) { this.frame.remove(); this.frame = null; this.frameKind = ''; }
    this.twitch = null;
    this.root.classList.remove('twitch');
    this.root.classList.remove('yt');
    this.video.removeAttribute('src');
    this.video.load();
  }

  stop() {
    this.token++;
    this.teardown();
    this.session = null;
    this.running = false;
    this.failed = false;
    this.info = '';
    this.hideNotice();
  }

  clear() {
    this.stop();
    this.c = null;
    this.showEmpty();
  }

  play(c, onlyUrl) {
    const token = ++this.token;
    this.teardown();
    this.hideNotice();
    this.c = c;
    this.session = null;
    this.running = true;
    this.failed = false;
    this.info = '';
    this.draw();
    if (this.chain) this.chain.reset(); // another channel: measure it afresh
    this.failCode = 0;
    this.reason = ''; // why the last attempt failed, when the server said so (U7D)
    this.syncAudio();
    if (!c.sources.length) {
      this.failed = true;
      this.setInfo(c.custom ? 'Solo en su web' : 'Sin directo abierto en la lista');
      const why = c.custom ? 'solo se puede ver en su web oficial: no deja incrustar su reproductor.'
        : 'no tiene un directo abierto en la lista de TDTChannels.';
      this.showNotice('«' + c.name + '» ' + why,
        c.web ? [{ label: 'Abrir la web de la cadena', href: c.web, primary: true }] : []);
      return;
    }
    if (c.recording) { // Atresplayer's embedded player cannot play its recordings: its own page can, in a window of the app
      this.failed = true;
      const desktop = window.tdtDesktop && window.tdtDesktop.atres && window.tdtDesktop.atres.watch;
      const open = () => window.tdtDesktop.atres.watch(c.web, c.name);
      const browser = { label: 'Abrir en tu navegador', href: c.web };
      if (desktop) {
        this.setInfo('Se ve en una ventana aparte de la aplicación');
        this.showNotice('«' + c.name + '» se ve en la página de Atresplayer, en una ventana de la aplicación (su reproductor '
          + 'incrustado no reproduce las grabaciones). Si sale su aviso de cookies, la respuesta es tuya y se recuerda.',
          [{ label: 'Abrir la ventana', primary: true, fn: open }, browser]);
        open();
      } else {
        this.setInfo('Se ve en la web de Atresplayer');
        this.showNotice('«' + c.name + '» es una grabación de Atresplayer y su reproductor incrustado no la reproduce desde aquí. '
          + 'Se ve en su página, en tu navegador.', [{ ...browser, label: 'Ver en Atresplayer', primary: true }]);
      }
      return;
    }
    if (c.kind !== 'radio' && typeof Hls === 'undefined' && !this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.failed = true;
      this.showNotice('Este navegador no puede reproducir HLS.');
      return;
    }
    const plan = buildPlan(c, { pref: this.host.preferred(c), onlyUrl, canPlayFmt: this.host.canPlayFmt });
    this.attempt(c, plan, 0, token);
  }

  retryAction(c) { return [{ label: 'Reintentar', primary: true, fn: () => this.play(c) }]; }

  attempt(c, plan, idx, token) {
    if (token !== this.token) return;
    this.teardown();
    if (idx >= plan.length) {
      this.session = null;
      this.failed = true;
      this.setInfo('Sin señal');
      const why = plan.length === 1 ? 'La única fuente no responde' : 'Ninguna de las ' + plan.length + ' fuentes responde';
      const text = this.reason ? this.reason + '.' : why + '.' + originNote(this.failCode) + ' Puede estar caído o limitado por zona.';
      this.showNotice('No se pudo reproducir «' + c.name + '». ' + text,
        this.retryAction(c).concat(c.web ? [{ label: 'Abrir la web de la cadena', href: c.web }] : []));
      return;
    }
    const step = plan[idx];
    const total = c.sources.length;
    const s = { u: step.u, ok: false, retries: 0, mediaRec: false, cleanup: null };
    this.session = s;
    this.setInfo('Conectando · fuente ' + step.n + ' de ' + total);
    // everything goes through the local proxy: streams almost never send CORS headers
    this.tag = 's' + Math.random().toString(36).slice(2, 10);
    if (this.stt) this.sttRegister();
    const url = '/proxy?u=' + encodeURIComponent(step.u) + (c.custom ? '&c=' + encodeURIComponent(c.id) : '') + '&s=' + this.tag;

    const fail = () => {
      if (s.ok || token !== this.token) return;
      this.attempt(c, plan, idx + 1, token);
    };
    const success = () => {
      if (s.ok || token !== this.token) return;
      s.ok = true;
      this.failed = false;
      clearTimeout(this.timer);
      this.hideNotice();
      this.setInfo(c.vod ? 'Grabación' : 'En directo · fuente ' + step.n + ' de ' + total);
      if (!c.vod && !atresEmbed(step.u)) this.host.remember(c, step.u); // an embedded player must not become the favourite
    };
    const lost = () => {
      this.failed = true;
      this.setInfo('Señal perdida');
      this.showNotice('Se perdió la señal de «' + c.name + '».', this.retryAction(c));
    };
    const startPlay = () => {
      const p = this.video.play();
      // a quick channel change aborts the previous play(): that is not a request for a click
      if (p && p.catch) {
        p.catch((err) => {
          if (token !== this.token || (err && err.name === 'AbortError')) return;
          this.showNotice('El navegador pide una pulsación para reproducir.',
            [{ label: 'Reproducir', primary: true, fn: () => { this.hideNotice(); this.video.play(); } }]);
        });
      }
    };
    this.timer = setTimeout(fail, ATTEMPT_TIMEOUT_MS);

    const embed = ytEmbed(step.u);
    const atres = atresEmbed(step.u);
    const twitch = twitchChannel(step.u);
    const u7d = parseU7d(step.u);
    if (u7d) {
      this.attachU7d(u7d, s, { fail, success, lost, startPlay });
    } else if (twitch) {
      this.attachTwitch(c, twitch, success, fail);
    } else if (embed) {
      this.attachYoutube(c, embed, success);
    } else if (atres) {
      this.attachAtres(c, atres, success);
    } else if (typeof Hls !== 'undefined' && Hls.isSupported() && usesHls(c, step)) {
      this.attachHls(url, s, { fail, success, lost, startPlay });
    } else {
      this.attachDirect(url, s, { fail, success, lost, startPlay });
    }
  }

  // U7D: the server resolves a recorded programme to an HLS list, which then plays like any channel
  attachU7d({ key, ref }, s, handlers) {
    fetch('/api/u7d/play?c=' + encodeURIComponent(key) + '&r=' + encodeURIComponent(ref))
      .then((r) => r.json())
      .then((d) => {
        if (this.session !== s) return; // another programme was chosen meanwhile
        if (!d.url) throw new Error(d.error || 'sin URL');
        const url = '/proxy?u=' + encodeURIComponent(d.url) + '&s=' + this.tag;
        if (typeof Hls !== 'undefined' && Hls.isSupported()) this.attachHls(url, s, handlers);
        else this.attachDirect(url, s, handlers);
      })
      .catch((err) => { this.reason = String((err && err.message) || err); handlers.fail(); });
  }

  attachTwitch(c, channel, success, fail) {
    // Twitch may need longer to initialise a logged-in live player than an HLS manifest.
    clearTimeout(this.timer);
    this.timer = setTimeout(fail, 45000);
    const box = el('div', 'tile-yt');
    box.id = 'twitch-' + this.i + '-' + this.token;
    this.frame = box;
    this.frameKind = 'twitch';
    this.root.classList.add('yt', 'twitch');
    this.twitchLink.href = twitchWeb('https://www.twitch.tv/' + channel);
    this.root.insertBefore(box, this.cover);
    const token = this.token;
    loadTwitchSdk().then((Twitch) => {
      if (token !== this.token || this.frame !== box) return;
      const player = new Twitch.Player(box.id, {
        channel, parent: [location.hostname], width: '100%', height: '100%', autoplay: true, muted: true,
      });
      player.addEventListener(Twitch.Player.READY, () => {
        if (token !== this.token || this.frame !== box) return;
        this.twitch = player;
        success();
        this.syncAudio();
        this.setInfo('Twitch · usa tu sesión del navegador; suscripciones según el canal');
      });
      player.addEventListener(Twitch.Player.OFFLINE, () => {
        if (this.frame === box) this.setInfo('Twitch · el canal está desconectado');
      });
      player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
        if (this.frame === box) this.setInfo('Twitch · pulsa reproducir dentro del reproductor');
      });
    }).catch(() => {
      if (this.frame !== box) return;
      fail();
    });
  }

  attachYoutube(c, embed, success) {
    const f = el('iframe', 'tile-yt');
    f.title = c.name;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.referrerPolicy = 'strict-origin-when-cross-origin'; // YouTube refuses the embed without a Referer
    f.setAttribute('allowfullscreen', '');
    f.addEventListener('load', () => {
      success();
      this.syncAudio();
      setTimeout(() => this.syncAudio(), 1500); // it takes a while to listen for commands
    });
    this.frame = f;
    this.frameKind = 'youtube';
    this.root.classList.add('yt');
    this.root.insertBefore(f, this.cover);
    f.src = embed + (embed.includes('?') ? '&' : '?') + 'autoplay=1&mute=1&playsinline=1&rel=0&enablejsapi=1&origin='
      + encodeURIComponent(location.origin);
  }

  // Atresplayer's embeddable player: it has its own controls, cookie notice and sound, which this page cannot change
  attachAtres(c, embed, success) {
    const f = el('iframe', 'tile-yt');
    f.title = c.name;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.setAttribute('allowfullscreen', '');
    f.addEventListener('load', () => {
      success();
      // without the bridge script its sound cannot be silenced from here: in multi-view they would play together
      this.setInfo('Reproductor de Atresplayer · pulsa «' + (c.vod ? 'Reproducir' : 'Directo') + '»'
        + (this.host.mode() === 'multi' && !this.bridged ? ' (sin el script del puente no se puede silenciar)' : ''));
      clearTimeout(this.bridgeTimer);
      this.bridgeTimer = setTimeout(() => {
        if (!this.bridged && this.frameKind === 'atres') {
          this.setInfo('Reproductor de Atresplayer · puente no detectado (¿instalada la extensión o el script del puente?)');
        }
      }, BRIDGE_WAIT_MS);
    });
    this.frame = f;
    this.frameKind = 'atres';
    this.root.classList.add('yt');
    this.root.insertBefore(f, this.cover);
    this.onBridge = (event) => {
      const message = parseBridge(event, f.contentWindow);
      if (message) this.fromBridge(message);
    };
    window.addEventListener('message', this.onBridge);
    f.src = embed;
  }

  attachHls(url, s, { fail, success, lost, startPlay }) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 30,
      maxBufferLength: this.host.mode() === 'multi' ? 12 : 30,
      manifestLoadingMaxRetry: 1,
      capLevelToPlayerSize: true, // small tiles -> low qualities
    });
    this.hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, startPlay);
    hls.on(Hls.Events.FRAG_LOADING, (_e, d) => this.noteFrag(d.frag));
    hls.on(Hls.Events.FRAG_BUFFERED, () => { s.retries = 0; success(); });
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (d.response && d.response.code) this.failCode = d.response.code;
      if (!d.fatal) return;
      if (!s.ok) { fail(); return; }
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR && s.retries < MAX_NETWORK_RETRIES) {
        s.retries++;
        this.setInfo('Señal interrumpida · reintento ' + s.retries + ' de ' + MAX_NETWORK_RETRIES);
        hls.startLoad();
      } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !s.mediaRec) {
        s.mediaRec = true;
        hls.recoverMediaError();
      } else {
        lost();
      }
    });
    hls.loadSource(url);
    hls.attachMedia(this.video);
  }

  // direct playback (mp3/aac radio, or native HLS in Safari)
  attachDirect(url, s, { fail, success, lost, startPlay }) {
    const video = this.video;
    const onOk = () => { success(); };
    const onErr = () => {
      if (!s.ok) { fail(); return; }
      lost();
    };
    video.addEventListener('loadeddata', onOk);
    video.addEventListener('error', onErr);
    video.addEventListener('ended', onErr);
    s.cleanup = () => {
      video.removeEventListener('loadeddata', onOk);
      video.removeEventListener('error', onErr);
      video.removeEventListener('ended', onErr);
    };
    video.src = url;
    startPlay();
  }
}
