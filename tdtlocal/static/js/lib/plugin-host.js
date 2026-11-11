// What the page does for the plugins with permissions of the desktop app (docs/PLUGINS.md): who may ask what, and the answer.
// Pure functions; ../plugin-host.js puts the frames on screen and carries the messages. The same rules are checked again by the
// desktop app for the two things that are not the page's (files and network): this is the first lock, not the only one.
import { epgOf } from './epg.js';
import { runCommand, snapshotOf } from './control.js';
import { norm } from './text.js';

// The API itself (methods, permissions, arguments, errors, limits) is in tdtlocal/static/plugin-api.json, the one specification that
// the page, the MCP server, the documentation and the tests all read: nothing here repeats a method name.

export const MAX_TEXT = 200;
export const MAX_RESULTS = 50;
export const TOAST_MS = 4000;

/** An error a plugin can tell apart: `code` is one of the keys of `errors` in the specification, `message` is for the author. */
export class PluginError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The permission a method needs (`null`: none; `network` stands for any «network:host»), or `undefined` if there is no such method. */
export function permissionFor(spec, method) {
  if (!Object.hasOwn(spec.methods, method)) return undefined;
  const need = spec.methods[method].permission;
  return need === null ? null : need.startsWith('network:') ? 'network' : need;
}

/**
 * Does the plugin hold what the method needs? Throws a PluginError saying why not, in the words the author reads. A method that
 * does not exist is E_UNSUPPORTED; a permission the manifest does not declare, or the user turned off, is E_PERMISSION.
 */
export function check(plugin, method, spec) {
  const need = permissionFor(spec, method);
  if (need === undefined) throw new PluginError('E_UNSUPPORTED', `método desconocido: ${String(method).slice(0, 40)}`);
  if (need === null) return;
  const has = need === 'network' ? plugin.permissions.some((p) => p.startsWith('network:')) : plugin.permissions.includes(need);
  if (has) return;
  const shown = need === 'network' ? 'network:<servidor>' : need;
  const off = (plugin.denied || []).some((p) => (need === 'network' ? p.startsWith('network:') : p === need));
  throw new PluginError('E_PERMISSION', `permiso denegado: ${shown} (${off ? 'el usuario lo ha desactivado' : 'falta en tdt.permissions de manifest.json'})`);
}

const bad = (def, why) => new PluginError('E_INVALID', def.hint || `«${def.name}» ${why}`);

function validateOne(def, value) {
  switch (def.type) {
    case 'any':
      return value;
    case 'string':
      if (typeof value !== 'string' || (def.min >= 1 && !value.trim()) || value.length > (def.max ?? 1e9)) throw bad(def, `tiene que ser un texto${def.max ? ` de hasta ${def.max} caracteres` : ''}`);
      if (def.enum && !def.enum.includes(value)) throw bad(def, `tiene que ser uno de ${def.enum.join(', ')}`);
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < (def.min ?? -Infinity) || value > (def.max ?? Infinity)) throw bad(def, 'tiene que ser un número' + (def.min !== undefined ? ` entre ${def.min} y ${def.max}` : ''));
      if (def.enum && !def.enum.includes(value)) throw bad(def, `tiene que ser uno de ${def.enum.join(', ')}`);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw bad(def, 'tiene que ser true o false');
      return value;
    case 'array':
      if (!Array.isArray(value) || value.length < (def.min ?? 0) || value.length > (def.max ?? 1e9)) throw bad(def, 'tiene que ser una lista');
      return value.map((item) => validateOne({ ...def.items, name: def.name, hint: def.hint }, item));
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(def, 'tiene que ser un objeto');
      return value;
    default:
      throw new Error(`tipo de argumento desconocido en la especificación: ${def.type}`);
  }
}

/** The arguments of a call checked against the specification (`args` of the method): the normalised list, or a PluginError E_INVALID. */
export function validateArgs(defs, args) {
  const list = Array.isArray(args) ? args : [];
  return defs.map((def, i) => {
    const value = list[i];
    if (value === undefined) {
      if (!def.optional) throw bad(def, 'falta');
      return Object.hasOwn(def, 'default') ? def.default : undefined;
    }
    if (value === null) {
      if (def.nullable) return null;
      if (def.optional) return Object.hasOwn(def, 'default') ? def.default : undefined;
      throw bad(def, 'no puede ser null');
    }
    return validateOne(def, value);
  });
}

/**
 * A bucket of tokens: each call takes one, and they come back at `perSecond` up to `capacity`. A plugin that asks for more gets E_RATE
 * and the call costs almost nothing.
 */
export function createLimiter({ capacity, perSecond }, now = () => Date.now()) {
  let tokens = capacity;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - last) / 1000) * perSecond);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/** The channels that can be played whose name or category has every word of the query. */
export function searchChannels(state, query, options) {
  const q = String(query || '');
  const kind = options && ['tv', 'radio'].includes(options.kind) ? options.kind : '';
  const limit = Math.max(1, Math.min(MAX_RESULTS, Number.isInteger(options && options.limit) ? options.limit : 25));
  const words = norm(q).split(/\s+/).filter(Boolean);
  const found = state.channels.filter((c) => {
    if (!Array.isArray(c.sources) || !c.sources.length || c.ok === false || (c.kind !== 'tv' && c.kind !== 'radio')) return false;
    if (kind && c.kind !== kind) return false;
    const hay = norm(`${c.name || ''} ${c.category || ''}`);
    return words.every((w) => hay.includes(w));
  });
  return {
    total: found.length,
    channels: found.slice(0, limit).map((c) => ({
      id: String(c.id).slice(0, MAX_TEXT), name: String(c.name || '').slice(0, MAX_TEXT), kind: c.kind,
      category: String(c.category || '').slice(0, MAX_TEXT), hasGuide: !!c.epg,
    })),
  };
}

/** What is on and what comes next in a channel, from the guide the page already has. */
export function epgNow(state, ref, nowSec) {
  const key = String(ref);
  const c = state.byId.get(key) || state.channels.find((x) => norm(x.name || '') === norm(key));
  if (!c) throw new PluginError('E_NOT_FOUND', `no hay ningún canal «${key.slice(0, 60)}»`);
  const entries = c.epg ? state.epg.now[c.epg] : undefined;
  const e = epgOf(entries, nowSec);
  const item = (p) => (p ? { start: p[0], end: p[1], title: String(p[2]).slice(0, MAX_TEXT) } : null);
  return { channel: String(c.name || '').slice(0, MAX_TEXT), now: e ? item(e.cur) : null, next: e ? item(e.next) : null };
}

/**
 * Do what a plugin asked. Throws a PluginError (code and a reason in plain words); the caller turns it into the answer to the plugin.
 * @param {{id: string, permissions: string[], denied?: string[]}} plugin
 * @param {{spec: object, state: object, actions: object, toast: Function, resize: Function, desktop: Function, now?: () => number}} env
 *   `spec` is plugin-api.json; `desktop(id, method, args)` asks the app for what is not the page's (files and network); it answers
 *   `{ok, result, error, code}`.
 */
export async function dispatch(plugin, method, args, env) {
  check(plugin, method, env.spec);
  const a = validateArgs(env.spec.methods[method].args, args);
  const { state, actions } = env;
  const asCommand = (cmd) => {
    const r = runCommand(cmd, state, actions);
    if (!r.ok) throw new PluginError(/no hay ningún canal/.test(r.detail) ? 'E_NOT_FOUND' : 'E_UNAVAILABLE', r.detail);
    return r.detail;
  };
  switch (method) {
    case 'player.state':
      return snapshotOf(state);
    case 'player.play':
      return asCommand({ do: 'play', channel: a[0] });
    case 'player.kind':
      return asCommand({ do: 'kind', kind: a[0] });
    case 'player.volume':
      return asCommand({ do: 'volume', value: Math.round(a[0] * 1000) / 1000 });
    case 'player.mute':
      return asCommand({ do: 'mute', on: a[0] !== false });
    case 'player.multi':
      return asCommand({ do: 'multi', channels: a[0], rotate: a[1] ?? null });
    case 'channels.search':
      return searchChannels(state, a[0] || '', a[1] || {});
    case 'channels.provide':
      return env.provide(plugin.id, a[0]);
    case 'epg.provide':
      return env.provideEpg(plugin.id, a[0]);
    case 'epg.now':
      return epgNow(state, a[0], env.now ? env.now() : Date.now() / 1000);
    case 'ui.toast':
      env.toast(plugin.id, a[0]);
      return true;
    case 'ui.resize':
      return env.resize(plugin.id, a[0], a[1]);
    default: {
      // storage.* and net.fetch are the app's: it checks the permission again against what the user approved
      const r = await env.desktop(plugin.id, method, a);
      if (!r || r.ok !== true) throw new PluginError((r && r.code) || 'E_UNAVAILABLE', (r && r.error) || 'la aplicación no ha respondido');
      return r.result;
    }
  }
}

export const IDLE_MS = 60000; // a service that did nothing for this long goes back to sleep (it rebuilds itself from its storage)
export const MAX_PENDING = 20; // events kept for a frame that is still starting

/** Does this wake-up list make a plugin wait for its moment? «onStartup» means it runs from the start, like one without a list. */
export const sleeps = (plugin) => !plugin.panel && Array.isArray(plugin.activation) && plugin.activation.length > 0 && !plugin.activation.includes('onStartup');

/** Which of the plugins asleep wake up for this event or this minute? */
export function wakingFor(plugins, { event, minute }) {
  return plugins.filter((p) => sleeps(p) && p.activation.some((a) => (event ? a === `onEvent:${event}` : a === `onTime:${minute}`)));
}

/** Has a service been idle long enough to go back to sleep? */
export const isIdle = (lastActive, now) => now - lastActive > IDLE_MS;

export const CALL_KEEP = 300;

/** The latest calls of the plugins: ``{t, plugin, method, code, ms}`` (``code`` is the error code, ``null`` if it went well). No arguments, no answers. */
export function createCallLog(keep = CALL_KEEP) {
  const log = [];
  return {
    add(entry) {
      log.push(entry);
      if (log.length > keep) log.shift();
    },
    /** Newest first; all, or only those of one plugin. */
    recent(limit = 50, plugin = '') {
      return log.filter((c) => !plugin || c.plugin === plugin).slice(-Math.max(1, Math.min(keep, limit))).reverse();
    },
  };
}

export const BEAT_MS = 5000; // how often the page asks a frame «are you there?»
export const SILENT_MS = 15000; // three silences in a row: the frame hangs or fell
export const START_MS = 10000; // a frame that has not said hello after this long did not start

/**
 * How a mounted frame is doing, from what the page knows: `starting` (not loaded yet), `running`, `unresponsive` (it did not load in
 * time, or it has not answered a ping for a while). A frame that is not mounted is `stopped` (the caller says so). A page that loaded
 * but never loads the SDK (`loaded` and not `ready`) cannot answer a ping: it counts as running and is not watched.
 */
export function healthOf({ now, mountedAt, ready, lastPong, loaded = false }) {
  if (!ready) return loaded ? 'running' : now - mountedAt > START_MS ? 'unresponsive' : 'starting';
  return now - lastPong > SILENT_MS ? 'unresponsive' : 'running';
}

export const HEALTH_TEXT = {
  stopped: 'parado',
  waiting: 'dormido, a la espera de su momento',
  'over-limit': 'parado por pasarse de memoria o procesador (pulsa ⟳ para arrancarlo)',
  starting: 'arrancando',
  running: 'en marcha',
  unresponsive: 'no responde (se ha colgado, ha caído o no arrancó)',
};

/** What the page counts of each plugin, for the user and for whoever asks (the settings, the MCP). */
export function newStats() {
  return { calls: 0, errors: 0, denied: 0, limited: 0, restarts: 0, wakes: 0, lastCallAt: 0, methods: {} };
}

/** Count one call and how it ended (`code` is the PluginError code, or none if it went well). */
export function record(stats, method, code, now = Date.now()) {
  stats.calls += 1;
  stats.lastCallAt = now;
  stats.methods[method] = (stats.methods[method] || 0) + 1;
  if (code) stats.errors += 1;
  if (code === 'E_PERMISSION') stats.denied += 1;
  if (code === 'E_RATE') stats.limited += 1;
}

/** The part of the state a plugin that may read it is told about when it changes, as text to compare. */
export const stateKey = (state) => JSON.stringify(snapshotOf(state));

/** The size a panel asks for, kept inside what the manifest allows. */
export function clampSize(width, height, limits = { minWidth: 240, maxWidth: 800, minHeight: 160, maxHeight: 800 }) {
  const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null);
  return { width: clamp(width, limits.minWidth, limits.maxWidth), height: clamp(height, limits.minHeight, limits.maxHeight) };
}
