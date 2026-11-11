// The page's half of the plugins with permissions of the desktop app (docs/PLUGINS.md, docs/PLUGINS-ARQUITECTURA.md). Each running
// plugin lives in a frame with `sandbox="allow-scripts"` and no origin of its own, served by the app from tdt-plugin://<id>/ under a
// policy that forbids it any request. The only way out of the frame is postMessage to this page, which answers with the methods its
// permissions allow (lib/plugin-host.js, from the specification plugin-api.json). The frame is told apart by the window the message
// comes from, never by what the message says.
//
// What this module also does, because a frame is a process of its own that can hang, fall or flood: it limits how fast a plugin may
// call, asks every frame «are you there?» every few seconds and says when one is not, counts what each plugin does, and does not keep
// a screen that is closed: its frame is destroyed (they cost about 100 MB each) and made again when it is opened.
import { api as getJson, postJson } from './api.js';
import { $, el } from './dom.js';
import {
  BEAT_MS, HEALTH_TEXT, MAX_PENDING, createCallLog, START_MS, PluginError, clampSize, createLimiter, dispatch, healthOf, isIdle, newStats, record, sleeps, stateKey,
  wakingFor,
} from './lib/plugin-host.js';
import { snapshotOf } from './lib/control.js';
import { events } from './events.js';
import { setPluginSources } from './sources.js';
import { cleanThemes } from './lib/themes.js';
import { setThemes } from './themes.js';
import { state } from './state.js';
import { store } from './store.js';

const EVENT_MS = 1000;
let current = null;

/** The host of the plugins of this page, for the settings (how the frames are doing), or null if this is not the desktop app. */
export const pluginHost = () => current;

/**
 * @param {{actions: {setKind: Function, play: Function, multiWith: Function, setVolume: Function}}} options
 * @returns {{status: () => object[], reload: (id: string) => boolean} | null} what the settings and the MCP ask about the plugins
 */
export function initPluginHost({ actions }) {
  const api = typeof window !== 'undefined' && window.tdtDesktop && window.tdtDesktop.ui;
  if (!api) return null; // only the desktop app has them

  const specReady = fetch('/plugin-api.json').then((r) => r.json());
  const dock = el('div', 'plugin-dock');
  const hidden = el('div', 'plugin-hidden');
  const toasts = el('div', 'plugin-toasts');
  toasts.setAttribute('role', 'status');
  dock.hidden = true;
  hidden.hidden = true;
  document.body.append(dock, hidden, toasts);

  /** id -> {plugin, key, box, frame, button, badge, state, ready, mountedAt, lastPong, stats, limiter} */
  const mounted = new Map();
  const callLog = createCallLog(); // what each plugin called and how it ended (the inspector and the MCP read it)
  const allStats = new Map(); // id -> counts: they survive the plugin starting again (a reload, a permission turned off)
  const statsOf = (id) => allStats.get(id) || allStats.set(id, newStats()).get(id);
  let minimized = store.get('pluginMin', {});
  let last = '';
  let beat = 0;

  const note = (id, level, text) => { try { api.log(id, level, text); } catch { /* the log is a courtesy */ } };

  const toast = (id, text) => {
    const m = mounted.get(id);
    const item = el('div', 'plugin-toast', `${m ? m.plugin.label : id}: ${text}`);
    toasts.append(item);
    setTimeout(() => item.remove(), 4000);
  };

  const resize = (id, width, height) => {
    const m = mounted.get(id);
    if (!m || !m.plugin.panel || !m.frame) throw new PluginError('E_UNAVAILABLE', 'este plugin no tiene panel');
    if (m.plugin.panel.placement === 'screen') throw new PluginError('E_UNAVAILABLE', 'un panel que ocupa la pantalla no cambia de tamaño');
    const size = clampSize(width, height);
    if (size.width === null || size.height === null) throw new PluginError('E_INVALID', 'ui.resize(ancho, alto): dos números');
    m.frame.style.width = `${size.width}px`;
    m.frame.style.height = `${size.height}px`;
    return size;
  };

  const send = (m, message) => {
    if (m.frame && m.frame.contentWindow) m.frame.contentWindow.postMessage({ tdt: 1, ...message }, '*');
  };

  // the channels a plugin provides go to the server, which checks them (tdtlocal/providers.py); the page then loads the list again
  const providing = new Set();
  async function provide(id, channels) {
    let res;
    try {
      res = await postJson('/api/providers', { id, channels });
    } catch {
      throw new PluginError('E_UNAVAILABLE', 'el servidor local no responde');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new PluginError('E_INVALID', String(body.error || 'los canales no valen').slice(0, 300));
    if (body.count) providing.add(id);
    else providing.delete(id);
    window.dispatchEvent(new Event('tdt-channels-changed'));
    return { count: body.count };
  }

  async function provideEpg(id, guide) {
    let res;
    try {
      res = await postJson('/api/providers/epg', { id, guide });
    } catch {
      throw new PluginError('E_UNAVAILABLE', 'el servidor local no responde');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new PluginError('E_INVALID', String(body.error || 'la guía no vale').slice(0, 300));
    window.dispatchEvent(new Event('tdt-guide-changed'));
    return { count: body.count };
  }

  // the rules a plugin brings (tdt.rules) go to the server, which checks them; they stay off until the user turns them on
  const rulesSent = new Map();
  async function publishRules(wanted) {
    let changed = false;
    for (const p of wanted.values()) {
      const text = JSON.stringify(p.rules || []);
      if ((rulesSent.get(p.id) || '[]') === text) continue;
      try { await postJson('/api/rules/plugin', { id: p.id, rules: p.rules || [] }); rulesSent.set(p.id, text); changed = true; } catch { /* next time */ }
    }
    try {
      const known = (await getJson('/api/rules')).data.plugin_rules || [];
      for (const id of new Set(known.map((k) => k.plugin))) {
        if (wanted.has(id)) continue;
        await postJson('/api/rules/plugin', { id, rules: [] });
        rulesSent.delete(id);
        changed = true;
      }
    } catch { /* next time */ }
    if (changed) window.dispatchEvent(new Event('tdt-rules-changed'));
  }

  /** The plugins that no longer run (or lost the permission) stop providing: their channels leave the list. */
  async function dropProviders(wanted) {
    let known = {};
    let guides = {};
    try {
      const data = (await getJson('/api/providers')).data;
      known = data.providers || {};
      guides = data.epg || {};
    } catch { return; }
    for (const id of Object.keys(guides)) {
      const p = wanted.get(id);
      if (p && p.permissions.includes('provide:epg')) continue;
      try { await postJson('/api/providers/epg', { id, guide: {} }); window.dispatchEvent(new Event('tdt-guide-changed')); } catch { /* next time */ }
    }
    let changed = false;
    for (const id of Object.keys(known)) {
      const p = wanted.get(id);
      if (p && p.permissions.includes('provide:channels')) continue;
      try { await postJson('/api/providers', { id, channels: [] }); providing.delete(id); changed = true; } catch { /* next time */ }
    }
    if (changed) window.dispatchEvent(new Event('tdt-channels-changed'));
  }

  const env = { state, actions, toast, resize, provide, provideEpg, desktop: (id, method, args) => api.call(id, method, args) };

  // ------------------------------------------------------------------------------------------------ the frames
  function setState(m, next) {
    if (m.state === next) return;
    const was = m.state;
    m.state = next;
    if (m.badge) {
      m.badge.hidden = next !== 'unresponsive' && next !== 'over-limit';
      m.badge.textContent = next === 'over-limit' ? '⚠ parado' : '⚠ no responde';
      m.badge.title = HEALTH_TEXT[next === 'over-limit' ? 'over-limit' : 'unresponsive'];
    }
    if (next === 'unresponsive') note(m.plugin.id, 'WARN', 'no responde: ' + (m.ready ? 'no contesta desde hace más de 15 s' : 'su página no ha cargado en 10 s'));
    else if (was === 'unresponsive' && next === 'running') note(m.plugin.id, 'INFO', 'vuelve a responder');
  }

  function startFrame(m) {
    const { plugin } = m;
    m.overLimit = null; // it starts clean
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms'); // no allow-same-origin: it has no origin and no access to ours
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', '');
    frame.title = plugin.name;
    frame.className = 'plugin-frame';
    if (plugin.panel && plugin.panel.placement === 'screen') frame.classList.add('plugin-screen-frame');
    else if (plugin.panel) {
      frame.style.width = `${plugin.panel.width}px`;
      frame.style.height = `${plugin.panel.height}px`;
    }
    m.frame = frame;
    m.ready = false;
    m.loaded = false;
    frame.addEventListener('load', () => { if (m.frame === frame) m.loaded = true; });
    m.mountedAt = Date.now();
    m.lastPong = m.mountedAt;
    m.box.append(frame);
    frame.src = plugin.url;
    setState(m, 'starting');
  }

  function stopFrame(m) {
    if (m.frame) m.frame.remove();
    m.frame = null;
    m.ready = false;
    setState(m, 'stopped');
  }

  function reloadFrame(m) {
    if (m.waiting) { wake(m); return; } // a sleeping service: reloading it is waking it
    if (m.overLimit && !m.button) { m.stats.restarts += 1; startFrame(m); note(m.plugin.id, 'INFO', 'se vuelve a arrancar tras pasarse de límites'); return; } // stopped for using too much
    if (m.state === 'stopped' && !m.open) return;
    m.stats.restarts += 1;
    stopFrame(m);
    startFrame(m);
    note(m.plugin.id, 'INFO', 'se vuelve a cargar');
  }

  const disable = (id) => window.tdtDesktop.plugins.setEnabled(id, false);

  /** Open the screen of a plugin (one at a time) or close it. A closed screen has no frame at all. */
  function toggleScreen(id, force) {
    const target = mounted.get(id);
    if (!target || !target.button) return;
    const open = force === undefined ? target.box.hidden : force;
    for (const m of mounted.values()) {
      if (!m.button) continue;
      const here = m === target && open;
      m.open = here;
      m.box.hidden = !here;
      m.button.setAttribute('aria-pressed', String(here));
      if (here && !m.frame) startFrame(m);
      else if (!here && m.frame) stopFrame(m); // frees the process: about 100 MB
    }
    if (open && target.frame) target.frame.focus(); // the keys go to the plugin from now on
  }

  function unmount(id) {
    const m = mounted.get(id);
    if (!m) return;
    if (m.frame) m.frame.remove();
    if (m.button) m.button.remove();
    m.box.remove();
    mounted.delete(id);
  }

  function button(label, title, onClick, cls = 'plugin-btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  /** A service wakes up: its frame is made, and what woke it is handed over once it says hello. */
  function wake(m, first) {
    m.waiting = false;
    m.lastActive = Date.now();
    m.stats.wakes += 1;
    if (first) queue(m, first.event, first.data);
    startFrame(m);
    note(m.plugin.id, 'INFO', 'se despierta' + (first ? ' (' + first.event + ')' : ''));
  }

  /** What happens while a frame starts is kept for it (a few), so that the event that woke a service reaches it. */
  function queue(m, event, data) {
    m.pending.push({ event, data });
    if (m.pending.length > MAX_PENDING) m.pending.shift();
  }

  function mount(plugin) {
    const m = { plugin, key: JSON.stringify(plugin), waiting: false, lastActive: Date.now(), pending: [], box: null, frame: null, button: null, badge: null, open: false, state: 'stopped', ready: false, loaded: false, mountedAt: 0, lastPong: 0, stats: statsOf(plugin.id), limiter: null };
    const badge = el('span', 'plugin-badge', '⚠ no responde');
    badge.hidden = true;
    m.badge = badge;
    if (plugin.panel && plugin.panel.placement === 'screen') {
      // over the picture of the player: the head is the app's (name and a close button the plugin cannot remove)
      m.box = el('section', 'plugin-screen');
      m.box.dataset.plugin = plugin.id;
      m.box.hidden = true;
      const head = el('header', 'plugin-screen-head');
      head.append(el('span', 'plugin-title', plugin.name), badge, el('span', 'plugin-note', 'plugin · ' + plugin.id));
      head.append(button('⟳', 'Volver a cargar el plugin', () => reloadFrame(m)), button('Cerrar', 'Cerrar', () => toggleScreen(plugin.id, false)));
      m.box.append(head);
      $('screen').append(m.box);
      m.button = button(plugin.label, plugin.name + ' (plugin): se abre sobre la pantalla del reproductor', () => toggleScreen(plugin.id), 'btn');
      m.button.dataset.plugin = plugin.id;
      m.button.setAttribute('aria-pressed', 'false');
      document.querySelector('.controls').append(m.button);
    } else if (plugin.panel) {
      m.box = el('section', 'plugin-panel');
      m.box.dataset.plugin = plugin.id;
      const head = el('header', 'plugin-head');
      const title = el('span', 'plugin-title', plugin.label);
      title.title = plugin.name;
      const fold = button(minimized[plugin.id] ? '▢' : '–', 'Plegar o desplegar', () => {
        minimized = { ...minimized, [plugin.id]: !minimized[plugin.id] };
        store.set('pluginMin', minimized);
        m.box.classList.toggle('folded', !!minimized[plugin.id]);
        fold.textContent = minimized[plugin.id] ? '▢' : '–';
      });
      head.append(title, badge, button('⟳', 'Volver a cargar el plugin', () => reloadFrame(m)), fold, button('✕', 'Desactivar este plugin', () => disable(plugin.id)));
      m.box.append(head);
      m.box.classList.toggle('folded', !!minimized[plugin.id]);
      dock.append(m.box);
      startFrame(m);
    } else {
      m.box = el('div', 'plugin-background');
      hidden.append(m.box);
      if (sleeps(plugin)) {
        m.waiting = true; // no frame, no process: it wakes up when its event happens or its time comes
        setState(m, 'waiting');
      } else startFrame(m);
    }
    mounted.set(plugin.id, m);
  }

  async function onMessage(event) {
    const m = [...mounted.values()].find((x) => x.frame && x.frame.contentWindow && x.frame.contentWindow === event.source);
    const data = event.data;
    if (!m || !data || typeof data !== 'object' || data.tdt !== 1) return;
    if (data.hello) {
      m.ready = true;
      m.lastPong = Date.now();
      setState(m, 'running');
      send(m, { ready: true, plugin: { id: m.plugin.id, name: m.plugin.name, version: m.plugin.version, permissions: m.plugin.permissions, denied: m.plugin.denied || [] } });
      for (const p of m.pending.splice(0)) send(m, { event: p.event, data: p.data }); // what woke it, and what happened while it started
      if (m.open && m.frame) m.frame.focus(); // the frame did not exist yet when the screen was opened
      return;
    }
    if (data.pong !== undefined) {
      m.lastPong = Date.now();
      if (m.state === 'unresponsive') setState(m, 'running');
      return;
    }
    if (!Number.isInteger(data.id) || typeof data.method !== 'string') return;
    const spec = await specReady;
    if (!m.limiter) m.limiter = createLimiter(spec.limits.rate);
    m.lastActive = Date.now();
    const reply = (message) => send(m, { id: data.id, ...message });
    if (!m.limiter.take()) {
      record(m.stats, data.method.slice(0, 40), 'E_RATE');
      callLog.add({ t: Date.now(), plugin: m.plugin.id, method: data.method.slice(0, 40), code: 'E_RATE', ms: 0 });
      reply({ ok: false, error: 'demasiadas llamadas seguidas: espera un poco', code: 'E_RATE' });
      return;
    }
    const started = Date.now();
    try {
      const result = await dispatch(m.plugin, data.method, data.args, { ...env, spec });
      record(m.stats, data.method, null);
      callLog.add({ t: Date.now(), plugin: m.plugin.id, method: data.method, code: null, ms: Date.now() - started });
      reply({ ok: true, result: result === undefined ? null : result });
    } catch (error) {
      const code = (error && error.code) || 'E_UNAVAILABLE';
      record(m.stats, Object.hasOwn(spec.methods, data.method) ? data.method : 'desconocido', code);
      callLog.add({ t: Date.now(), plugin: m.plugin.id, method: Object.hasOwn(spec.methods, data.method) ? data.method : 'desconocido', code, ms: Date.now() - started });
      reply({ ok: false, error: String((error && error.message) || error).slice(0, 300), code });
    }
  }
  window.addEventListener('message', onMessage);

  // ------------------------------------------------------------------------------------------------ the heartbeat
  // A frame that hangs or falls tells nobody: the only way to know is to ask. A page that is hidden or minimised is not asked (the
  // browser slows its frames down and a slow answer is not a hang) and starts again from a clean slate when it comes back.
  setInterval(() => {
    const now = Date.now();
    if (document.hidden) { beat = now; return; }
    if (beat && now - beat > BEAT_MS * 2) for (const m of mounted.values()) m.lastPong = now;
    beat = now;
    for (const m of mounted.values()) {
      if (!m.frame) continue;
      const health = healthOf({ now, mountedAt: m.mountedAt, ready: m.ready, lastPong: m.lastPong, loaded: m.loaded });
      setState(m, health);
      if (health === 'unresponsive' && !m.loaded && m.stats.restarts === 0 && now - m.mountedAt > START_MS) reloadFrame(m); // one more try
      else if (m.ready) send(m, { ping: now });
    }
  }, BEAT_MS);

  // the services that asked for a time of the day (onTime:HH:MM) wake up at that minute, once
  let minuteSeen = '';
  setInterval(() => {
    const at = new Date();
    const minute = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
    if (minute === minuteSeen) return;
    minuteSeen = minute;
    for (const plugin of wakingFor([...mounted.values()].filter((m) => m.waiting && !m.frame).map((m) => m.plugin), { minute })) {
      wake(mounted.get(plugin.id), { event: 'schedule', data: { at: minute } });
    }
    for (const m of mounted.values()) if (m.ready && m.plugin.activation && m.plugin.activation.includes(`onTime:${minute}`)) send(m, { event: 'schedule', data: { at: minute } });
  }, EVENT_MS);

  // a service that has nothing to do goes back to sleep: its frame is a process of about 100 MB
  setInterval(() => {
    const now = Date.now();
    for (const m of mounted.values()) {
      if (!m.frame || !sleeps(m.plugin) || !isIdle(m.lastActive, now)) continue;
      stopFrame(m);
      m.waiting = true;
      setState(m, 'waiting');
      note(m.plugin.id, 'INFO', 'se duerme: sin actividad desde hace más de un minuto');
    }
  }, BEAT_MS);

  // the plugins that may read it hear about the changes of what is on, about once a second and only if something changed
  setInterval(() => {
    const now = stateKey(state);
    if (now === last) return;
    last = now;
    const snapshot = snapshotOf(state);
    for (const m of mounted.values()) {
      if (m.ready && m.plugin.permissions.includes('player.read')) send(m, { event: 'player', data: snapshot });
    }
  }, EVENT_MS);

  // the events of the page (commands.json) reach the plugins that may hear them: the permission is the one the specification names
  events.on('*', async (name, data) => {
    const def = (await specReady).events[name];
    if (!def) return;
    const allowed = (m) => m.plugin.permissions.includes(def.permission);
    for (const m of mounted.values()) {
      if (m.waiting && !m.frame) continue; // asleep: below
      if (m.ready && allowed(m)) {
        // only what the service asked to be woken for keeps it awake (and its own calls): any event it merely hears would keep it up for ever
        if ((m.plugin.activation || []).includes(`onEvent:${name}`)) m.lastActive = Date.now();
        send(m, { event: name, data });
      }
      else if (m.frame && !m.ready && allowed(m)) queue(m, name, data);
    }
    for (const plugin of wakingFor([...mounted.values()].filter((m) => m.waiting && !m.frame).map((m) => m.plugin), { event: name })) {
      if (plugin.permissions.includes(def.permission)) wake(mounted.get(plugin.id), { event: name, data });
    }
  });

  async function sync(reloadAll = false) {
    const list = await api.list().catch(() => []);
    const wanted = new Map((Array.isArray(list) ? list : []).map((p) => [p.id, p]));
    for (const [id, m] of [...mounted]) {
      if (!wanted.has(id) || reloadAll || m.key !== JSON.stringify(wanted.get(id))) unmount(id);
    }
    for (const plugin of wanted.values()) if (!mounted.has(plugin.id)) mount(plugin);
    setThemes([...wanted.values()].flatMap((p) => cleanThemes(p.id, p.themes))); // the colours the plugins that run bring
    dropProviders(wanted);
    publishRules(wanted);
    setPluginSources([...wanted.values()].flatMap((p) => p.sources || [])); // the players the plugins that run know how to show
    dock.hidden = !dock.children.length;
  }

  api.onChange((reload) => sync(reload === true));
  // what each plugin uses (memory, processor), measured by the app, and the order to stop one that went over (see desktop/lib/plugin-limits.js)
  const usage = new Map();
  if (api.onMetrics) api.onMetrics((list) => { usage.clear(); for (const p of list) usage.set(p.id, p); });
  if (api.onLimit) {
    api.onLimit((id, reason, detail) => {
      const m = mounted.get(id);
      if (!m || !m.frame) return;
      if (m.button) toggleScreen(id, false); else stopFrame(m);
      m.overLimit = { reason, detail };
      setState(m, 'over-limit');
      note(id, 'WARN', `parado por pasarse de ${reason === 'memory' ? 'memoria' : 'procesador'}: ${detail}`);
    });
  }
  // the user changed a setting of a plugin in the settings: the plugin is told (it needs no permission to hear about its own settings)
  if (api.onConfig) api.onConfig((id, values) => { const m = mounted.get(id); if (m && m.ready) send(m, { event: 'config.changed', data: values }); });
  sync();

  current = {
    /** What is going on with each plugin that is on: for the settings and for whoever asks through the MCP. */
    status: () => [...mounted.values()].map((m) => ({
      id: m.plugin.id,
      placement: !m.plugin.panel ? 'none' : m.plugin.panel.placement === 'screen' ? 'screen' : 'float',
      state: m.state,
      monitored: m.ready, // false: its page never loaded the SDK, so it cannot answer «are you there?»
      open: m.open,
      uptimeSeconds: m.frame ? Math.round((Date.now() - m.mountedAt) / 1000) : 0,
      calls: m.stats.calls,
      errors: m.stats.errors,
      denied: m.stats.denied,
      limited: m.stats.limited,
      restarts: m.stats.restarts,
      wakes: m.stats.wakes, // how many times it was woken up (a service that sleeps until its moment)
      memoryMB: usage.has(m.plugin.id) ? usage.get(m.plugin.id).memoryMB : null,
      cpuPercent: usage.has(m.plugin.id) ? usage.get(m.plugin.id).cpuPercent : null,
      overLimit: m.overLimit ? m.overLimit.reason : null,
      activation: m.plugin.activation || [],
      lastCallSecondsAgo: m.stats.lastCallAt ? Math.round((Date.now() - m.stats.lastCallAt) / 1000) : null,
      methods: { ...m.stats.methods },
    })),
    /** The latest calls of the plugins, newest first. */
    calls: (limit, plugin) => callLog.recent(limit, plugin),
    reload: (id) => {
      const m = mounted.get(id);
      if (!m) return false;
      reloadFrame(m);
      return true;
    },
  };
  return current;
}
