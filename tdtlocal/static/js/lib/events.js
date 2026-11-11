// The events of the page: what happens (another channel, another volume, a programme that starts) told to whoever listens (the rules, the
// plugins, and the MCP that asks for the latest). Pure functions: ../events.js watches the player and feeds them.
// What exists and who may hear it is in tdtlocal/static/commands.json; the tests check that this file agrees with it.
export const EVENTS = ['channel.changed', 'kind.changed', 'volume.changed', 'programme.started', 'ad.started', 'ad.ended'];
export const KEEP = 100; // events remembered, for whoever asks what just happened
export const PROGRAMME_WINDOW = 90; // seconds: a programme «has just started» if it began within this
export const MAX_SEEN = 300;

/**
 * A hub: ``on(name, fn, priority)`` (``'*'`` for all) returns the way to stop listening; ``emit`` tells them and remembers it; ``recent`` says what
 * happened. Listeners hear in order of priority (the lowest number first; the same priority, the order they came in). A listener that throws does
 * not stop the others, and what it threw is not lost: it goes to ``onError``.
 */
export function createHub({ now = () => Date.now(), keep = KEEP, onError = () => {} } = {}) {
  const listeners = new Map(); // name -> [{fn, priority}], in the order they are told
  const log = [];
  return {
    on(name, fn, priority = 10) {
      if (typeof fn !== 'function') throw new TypeError('on(evento, función)');
      if (!listeners.has(name)) listeners.set(name, []);
      const list = listeners.get(name);
      let item = list.find((other) => other.fn === fn);
      if (!item) {
        item = { fn, priority: Number(priority) || 0 };
        const after = list.findIndex((other) => other.priority > item.priority);
        list.splice(after < 0 ? list.length : after, 0, item);
      }
      return () => {
        const at = list.indexOf(item);
        if (at >= 0) list.splice(at, 1);
      };
    },
    emit(name, data = {}) {
      log.push({ t: now(), name, data });
      if (log.length > keep) log.shift();
      for (const key of [name, '*']) {
        for (const { fn } of [...(listeners.get(key) || [])]) {
          try {
            fn(name, data);
          } catch (error) {
            onError(name, error);
          }
        }
      }
    },
    /** The latest events, newest first: all, or only those called ``name``. */
    recent(limit = 50, name = '') {
      return log.filter((e) => !name || e.name === name).slice(-Math.max(1, Math.min(KEEP, limit))).reverse();
    },
  };
}

/** What the watcher compares from one look to the next. */
export function lookAt(state, current) {
  return {
    channel: current ? { id: String(current.id), name: String(current.name || ''), kind: current.kind } : null,
    kind: state.kind,
    vol: { v: state.vol.v, m: !!state.vol.m },
  };
}

/**
 * The events between two looks. The first look (``before`` null) says nothing: it is where things start, not a change.
 * @returns {{name: string, data: object}[]}
 */
export function changesBetween(before, after) {
  if (!before) return [];
  const out = [];
  if ((before.channel && before.channel.id) !== (after.channel && after.channel.id) && after.channel) out.push({ name: 'channel.changed', data: { ...after.channel } });
  if (before.kind !== after.kind) out.push({ name: 'kind.changed', data: { kind: after.kind } });
  if (Math.abs(before.vol.v - after.vol.v) >= 0.005 || before.vol.m !== after.vol.m) out.push({ name: 'volume.changed', data: { v: after.vol.v, m: after.vol.m } });
  return out;
}

/**
 * A watcher: each ``look(cause)`` reads the player and tells what changed since the last one (the first look says nothing).
 * What was seen is remembered BEFORE anyone is told, so a listener that changes something and looks again gets only its own change,
 * and the one it was told about is not told twice.
 * @param {() => object} read what the player is like now (``lookAt``)
 * @param {(name: string, data: object) => void} emit
 */
export function createWatcher(read, emit) {
  let before = null;
  return {
    look(cause = '') {
      const now = read();
      const changes = changesBetween(before, now);
      before = now;
      for (const change of changes) emit(change.name, cause ? { ...change.data, cause } : change.data);
    },
  };
}

/**
 * The programmes that have just started on the channels being watched, each once.
 * @param {object[]} channels the channels in the tiles
 * @param {(channel: object) => Array|undefined} entriesOf [[start, end, title], ...]
 * @param {Set<string>} seen what was told already (it is added to)
 */
export function programmesStarted(channels, entriesOf, nowSec, seen) {
  const out = [];
  for (const channel of channels) {
    for (const entry of entriesOf(channel) || []) {
      const key = `${channel.id}@${entry[0]}`;
      if (entry[0] > nowSec || nowSec - entry[0] >= PROGRAMME_WINDOW || seen.has(key)) continue;
      seen.add(key);
      if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
      out.push({ name: 'programme.started', data: { channel: String(channel.name || ''), id: String(channel.id), title: String(entry[2] || ''), start: entry[0] } });
    }
  }
  return out;
}

/** How an event is read in the list of what happened. */
export function describeEvent(e) {
  const d = e.data || {};
  const text = {
    'channel.changed': `otro canal: ${d.name || d.id}`,
    'kind.changed': `lista: ${d.kind}`,
    'volume.changed': d.m ? 'silenciado' : `volumen al ${Math.round(Number(d.v) * 100)} %`,
    'programme.started': `empieza «${d.title}» en ${d.channel}`,
    'ad.started': `pausa de anuncios en ${d.name || d.channel}${d.soft ? ' (solo sonido)' : ''}`,
    'ad.ended': `fin de la pausa de anuncios en ${d.name || d.channel}${d.quiet ? ' (el usuario tomó el mando)' : ''}`,
  }[e.name] || JSON.stringify(d).slice(0, 80);
  return `${new Date(e.t).toLocaleTimeString('es-ES')} · ${e.name} · ${text}` + (d.cause ? ` (${d.cause})` : '');
}
