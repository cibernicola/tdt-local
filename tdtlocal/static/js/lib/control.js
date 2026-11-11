// What the page does for the control bus (tdtlocal/control.py): the snapshot of its state that clients can read, and the
// commands they can send. Pure functions: the module that talks to the server is ../control.js.
import { findChannel } from './commands.js';
import { slug } from './text.js';

/** A snapshot of the state worth telling: what is on, in which tiles, at what volume. No video, no URLs. */
export function snapshotOf(state) {
  const tiles = [];
  for (const t of state.tiles) {
    if (t && t.c) tiles.push({ slot: t.i, id: String(t.c.id), name: String(t.c.name || ''), kind: t.c.kind });
  }
  return {
    kind: state.kind,
    mode: state.mode,
    layout: state.layout,
    focus: state.focus,
    vol: { v: state.vol.v, m: state.vol.m },
    rot: { on: state.rot.on, secs: state.rot.secs },
    tiles,
    u7d: state.u7d && state.u7d.c ? { channel: String(state.u7d.c.name || '') } : null,
  };
}

const playable = (c) => !!c && Array.isArray(c.sources) && c.sources.length > 0 && c.ok !== false && c.kind !== 'u7d';

/** The channel a client means by its id or its name (the same way «pon La 2» understands names), or null. */
export function resolveChannel(state, ref) {
  const byId = state.byId.get(ref);
  if (playable(byId)) return byId;
  return findChannel(state.channels, state.kind, ref);
}

/**
 * Do what a client asked. Never throws: it answers `{ok, detail}`, which goes back to the client.
 * @param {object} cmd one of the commands control.py lets through (play, kind, volume, mute, multi)
 * @param {object} state the state of the page
 * @param {{setKind: Function, play: Function, multiWith: Function, setVolume: Function}} actions
 */
export function runCommand(cmd, state, actions) {
  try {
    switch (cmd && cmd.do) {
      case 'play': {
        const c = resolveChannel(state, cmd.channel);
        if (!c) return { ok: false, detail: `no hay ningún canal «${cmd.channel}» que se pueda reproducir` };
        if (c.kind !== state.kind) actions.setKind(c.kind);
        actions.play(c);
        return { ok: true, detail: c.name };
      }
      case 'kind':
        actions.setKind(cmd.kind);
        return { ok: true, detail: cmd.kind };
      case 'volume':
        actions.setVolume(cmd.value, false);
        return { ok: true, detail: String(Math.round(cmd.value * 100)) + ' %' };
      case 'mute':
        actions.setVolume(state.vol.v, cmd.on === true);
        return { ok: true, detail: cmd.on === true ? 'silenciado' : 'con sonido' };
      case 'multi': {
        const channels = [];
        for (const ref of cmd.channels || []) {
          const c = resolveChannel(state, ref);
          if (!c) return { ok: false, detail: `no hay ningún canal «${ref}» que se pueda reproducir` };
          channels.push(c);
        }
        if (!channels.length) return { ok: false, detail: 'no hay canales' };
        actions.multiWith(channels, cmd.rotate || null);
        return { ok: true, detail: channels.map((c) => c.name).join(', ') };
      }
      default:
        return { ok: false, detail: 'orden desconocida' };
    }
  } catch (error) {
    return { ok: false, detail: 'error: ' + ((error && error.message) || error) };
  }
}

/** Is this a command about development plugins? Those go to the desktop app, not to the page. */
export const isDevCommand = (cmd) => !!cmd && typeof cmd.do === 'string' && cmd.do.startsWith('dev_');

/**
 * Pass a command about development plugins to the desktop app, which checks it again and asks the user what it must ask.
 * Never throws: it answers `{ok, detail, data?}`.
 */
export async function runDevCommand(cmd, desktop) {
  const admin = desktop && desktop.dev && desktop.dev.admin;
  if (!admin) return { ok: false, detail: 'los plugins de desarrollo solo existen en la aplicación de escritorio' };
  try {
    const r = await admin(cmd);
    if (!r || typeof r !== 'object') return { ok: false, detail: 'la aplicación no ha respondido' };
    return { ok: r.ok === true, detail: String(r.detail || '').slice(0, 300), data: r.data };
  } catch (error) {
    return { ok: false, detail: 'error: ' + ((error && error.message) || error) };
  }
}

/** Is this a command about the plugins with permissions? Those go to the desktop app (and the page adds how the frames are doing). */
export const isPluginCommand = (cmd) => !!cmd && typeof cmd.do === 'string' && cmd.do.startsWith('plugin_');

/**
 * To the list the desktop app gives of the plugins, add what only the page knows: the state of each frame (running, starting, does not
 * respond, stopped), where it shows, and what it has done. A plugin that is not on has no frame: it is `stopped`.
 */
export function mergeRuntime(data, status) {
  const byId = new Map((status || []).map((s) => [s.id, s]));
  return {
    ...data,
    plugins: (data.plugins || []).map((p) => (p.kind === 'ui'
      ? { ...p, runtime: byId.get(p.id) || { id: p.id, state: 'stopped', open: false, calls: 0, errors: 0, denied: 0, limited: 0, restarts: 0, methods: {} } }
      : p)),
  };
}

/**
 * Pass a command about the plugins to the desktop app, which checks it again and asks the user what it must ask. Never throws:
 * it answers `{ok, detail, data?}`.
 */
export async function runPluginCommand(cmd, desktop, host) {
  if (cmd.do === 'plugin_calls') { // the page keeps this log: nothing to ask the app
    if (!host || !host.calls) return { ok: false, detail: 'los plugins solo existen en la aplicación de escritorio' };
    const list = host.calls(cmd.limit || 50, cmd.id || '');
    return { ok: true, detail: `${list.length} llamadas`, data: { calls: list.map((c) => ({ at: new Date(c.t).toISOString(), plugin: c.plugin, method: c.method, result: c.code || 'ok', ms: c.ms })) } };
  }
  const admin = desktop && desktop.plugins && desktop.plugins.admin;
  if (!admin) return { ok: false, detail: 'los plugins solo existen en la aplicación de escritorio' };
  try {
    const r = await admin(cmd);
    if (!r || typeof r !== 'object') return { ok: false, detail: 'la aplicación no ha respondido' };
    const data = cmd.do === 'plugin_list' && r.ok && r.data ? mergeRuntime(r.data, host && host.status ? host.status() : []) : r.data;
    return { ok: r.ok === true, detail: String(r.detail || '').slice(0, 300), data };
  } catch (error) {
    return { ok: false, detail: 'error: ' + ((error && error.message) || error) };
  }
}

/** Is this a command about the headers of a channel? */
export const isHeadersCommand = (cmd) => !!cmd && typeof cmd.do === 'string' && cmd.do.startsWith('headers_');

/** The channel a client means by its id or its name, playable or not (a channel of the list can have headers even if it does not play). */
export function resolveAnyChannel(state, ref) {
  const byId = state.byId.get(ref);
  if (byId) return byId;
  const want = slug(String(ref));
  return want ? state.channels.find((c) => slug(c.name) === want) || null : null;
}

/** The question to the user about the headers an AI wants to set: what changes, header by header, with the value in full. */
export function describeHeaderChanges(name, before, changes, replace) {
  const now = new Map((before || []).map((h) => [h.name.toLowerCase(), h]));
  const lines = [];
  const kept = new Set(Object.keys(changes).map((k) => k.toLowerCase()));
  for (const [header, value] of Object.entries(changes)) {
    const old = now.get(header.toLowerCase());
    if (value === null) lines.push(`  • ${header}: se quita`);
    else if (!old) lines.push(`  • ${header}: «${value}» (nueva)`);
    else if (old.secret) lines.push(`  • ${header}: «${value}» (sustituye a la guardada)`);
    else lines.push(`  • ${header}: «${value}» (antes «${old.value}»)`);
  }
  if (replace) for (const [key, old] of now) if (!kept.has(key)) lines.push(`  • ${old.name}: se quita (se dejan solo las que se piden)`);
  const credential = Object.entries(changes).some(([h, v]) => v !== null && !['origin', 'referer', 'user-agent'].includes(h.toLowerCase()));
  return {
    message: `Una IA quiere cambiar las cabeceras de «${name}»`,
    detail: `Cambios:\n${lines.join('\n')}\n\nTDT local las manda al servidor del canal con cada petición (la lista y sus segmentos). `
      + 'No se salta DRM ni geobloqueos: solo manda lo que se ponga aquí. '
      + (credential ? 'Las que no son Origin, Referer ni User-Agent (una cookie, un token) van solo a los servidores de los enlaces del canal y no siguen una redirección a otro. ' : '')
      + 'Fíate solo de lo que entiendas: una cabecera puede identificarte ante ese servidor.',
  };
}

/**
 * Do a command about the headers of a channel. Reading goes straight to the server (which hides the value of a credential); changing ends in
 * a question to the user in a window of the system, which only the desktop app has. Never throws: it answers `{ok, detail, data?}`.
 * @param {{state: object, get: (id: string) => Promise<{ok: boolean, data: any}>, post: (id: string, changes: object, replace: boolean) => Promise<{ok: boolean, data: any}>,
 *          confirm?: (message: string, detail: string) => Promise<boolean>}} deps
 */
export async function runHeadersCommand(cmd, { state, get, post, confirm }) {
  try {
    const channel = resolveAnyChannel(state, cmd.channel);
    if (!channel) return { ok: false, detail: `no hay ningún canal «${String(cmd.channel).slice(0, 60)}»` };
    const found = await get(channel.id);
    if (!found.ok) return { ok: false, detail: 'no se pudieron leer las cabeceras del canal' };
    if (cmd.do === 'headers_get') return { ok: true, detail: channel.name, data: found.data };
    if (cmd.do !== 'headers_set') return { ok: false, detail: 'orden desconocida' };
    if (!confirm) return { ok: false, detail: 'cambiar cabeceras por MCP necesita la aplicación de escritorio: el usuario lo confirma en una ventana del sistema' };
    const ask = describeHeaderChanges(channel.name, found.data.headers, cmd.headers, cmd.replace === true);
    if (!(await confirm(ask.message, ask.detail))) return { ok: false, detail: 'el usuario no ha aceptado el cambio' };
    const done = await post(channel.id, cmd.headers, cmd.replace === true);
    if (!done.ok) return { ok: false, detail: String((done.data && done.data.error) || 'no se pudieron guardar').slice(0, 300) };
    return { ok: true, detail: 'guardadas', data: { id: done.data.id, name: done.data.name, own: done.data.own, headers: done.data.headers } };
  } catch (error) {
    return { ok: false, detail: 'error: ' + ((error && error.message) || error) };
  }
}

/** The words of the badge that says an AI is connected, and of the tooltip that tells what it did. */
export function badgeText(status) {
  if (!status || !status.enabled) return '';
  return status.client_recent ? 'IA conectada' : '';
}

export function badgeTitle(status) {
  const lines = (status && status.audit ? status.audit : []).slice(-5).map((a) => new Date(a.t * 1000).toLocaleTimeString('es-ES') + ' ' + a.text);
  return lines.length ? lines.join('\n') : 'Una IA tiene acceso a TDT local';
}

export const CONTROL_INTRO = 'Deja que una IA (o un plugin) vea qué estás viendo y, si lo eliges, ponga canales o cambie el volumen. '
  + 'Está apagado por defecto. Solo funciona desde este equipo y con un token que se guarda en la carpeta de datos: '
  + 'quien lo tenga puede hacer lo que permita el nivel que elijas, así que no lo compartas. Lo que lea la IA (nombres de '
  + 'canal, títulos de programas) viene de internet y puede intentar darle instrucciones: por eso el nivel «solo leer» es el '
  + 'de partida.';

export const CONTROL_LEVEL_TEXT = { read: 'solo leer', control: 'leer y controlar', dev: 'leer, controlar y escribir plugins' };

/** One line about where the bus stands, from what /api/control/status says. */
export function describeControl(status) {
  if (!status || !status.enabled) return 'Apagado: nada de esto funciona hasta que lo actives y guardes los cambios.';
  const level = CONTROL_LEVEL_TEXT[status.level] || status.level;
  return 'Encendido, nivel «' + level + '». '
    + (status.page_connected ? 'La ventana está conectada.' : 'La ventana todavía no se ha conectado.')
    + (status.client_recent ? ' Una IA ha pedido algo hace menos de un minuto.' : '');
}

/** How a client talks to it, for the settings tab. */
export function describeUse(origin) {
  return 'Un cliente lee ' + origin + '/api/control/v1/state y manda órdenes a ' + origin + '/api/control/v1/command con la '
    + 'cabecera «Authorization: Bearer <token>». Las órdenes son play, kind, volume, mute y multi. Para una IA que hable '
    + 'MCP no hace falta nada de esto: el programa «tdt-local mcp» (o POST /mcp) ya lo envuelve. Detalle en docs/PLUGINS.md.';
}
