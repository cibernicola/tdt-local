// The plugins with all the power: code that runs inside the application and gets the hooks. This is the loader: it gives each plugin its own ``tdt``,
// remembers everything the plugin added so it can all be taken away, and keeps its mistakes from reaching the application: a plugin that throws is
// told off in the log, and one that keeps doing it is switched off (the rest go on).
import { DEFAULT_PRIORITY } from './hooks.js';

export const MAX_ERRORS = 5; // mistakes of a plugin before it is switched off

/**
 * @param {ReturnType<import('./hooks.js').createHooks>} hooks
 * @param {{maxErrors?: number, log?: (id: string, level: string, text: string) => void, css?: (key: string, text: string) => () => void}} [options]
 */
export function createLoader(hooks, { maxErrors = MAX_ERRORS, log = () => {}, css = null } = {}) {
  const plugins = new Map(); // id -> {state, errors, offs, cleanup, error}
  let sheets = 0;

  const text = (error) => (error && error.message ? error.message : String(error));
  const show = (x) => {
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch { return String(x); }
  };

  function fail(id, where, error) {
    const p = plugins.get(id);
    if (!p || p.state !== 'on') return;
    p.errors += 1;
    p.error = `${where}: ${text(error)}`;
    log(id, 'ERROR', p.error);
    if (p.errors >= maxErrors) {
      log(id, 'ERROR', `se apaga tras ${p.errors} fallos`);
      unload(id, 'failed');
    }
  }

  /** The same function, but a mistake of the plugin is counted (and swallowed) instead of reaching the application. */
  const guard = (id, where, fn) => function guarded(...args) {
    try {
      return fn.apply(this, args);
    } catch (error) {
      fail(id, where, error);
      return undefined;
    }
  };

  /** A thing for a registry: its methods are guarded too, one level deep. */
  function guardEntry(id, where, entry) {
    if (typeof entry === 'function') return guard(id, where, entry);
    if (!entry || typeof entry !== 'object') return entry;
    const out = Array.isArray(entry) ? [] : {};
    for (const [key, value] of Object.entries(entry)) out[key] = typeof value === 'function' ? guard(id, `${where}.${key}`, value) : value;
    return out;
  }

  function makeTdt(id, p) {
    const keep = (off) => { p.offs.push(off); return off; };
    return {
      id,
      on: (name, fn, priority = DEFAULT_PRIORITY) => keep(hooks.on(name, guard(id, `on(${name})`, fn), priority)),
      do: (name, data) => hooks.do(name, data),
      filter: (name, fn, priority = DEFAULT_PRIORITY) => keep(hooks.filter(name, guard(id, `filter(${name})`, fn), priority)),
      apply: (name, value, ctx) => hooks.apply(name, value, ctx),
      register: (registry, key, entry, priority = DEFAULT_PRIORITY) => keep(hooks.register(registry, key, guardEntry(id, `${registry}/${key}`, entry), priority)),
      get: (registry, key) => hooks.get(registry, key),
      list: (registry) => hooks.list(registry),
      log: (...parts) => log(id, 'INFO', parts.map(show).join(' ')),
      // a style sheet for the page, after its own; taken away with the plugin (or by calling what this returns). Only if the page can (`css` was given).
      css: (text) => (css ? keep(css(`${id}:${++sheets}`, String(text))) : () => {}),
    };
  }

  /**
   * Start a plugin: ``setup(tdt)`` adds what it brings; it may return a function that is called when the plugin is taken away.
   * @returns {Promise<boolean>} false if it failed to start (the plugin is left switched off and what it had added is gone)
   */
  async function load(id, setup) {
    if (plugins.has(id) && plugins.get(id).state === 'on') unload(id);
    const p = { state: 'on', errors: 0, offs: [], cleanup: null, error: '' };
    plugins.set(id, p);
    try {
      const cleanup = await setup(makeTdt(id, p));
      if (p.state !== 'on') return false; // it switched itself off while starting
      if (typeof cleanup === 'function') p.cleanup = cleanup;
      return true;
    } catch (error) {
      p.errors += 1;
      p.error = `al arrancar: ${text(error)}`;
      log(id, 'ERROR', p.error);
      unload(id, 'failed');
      return false;
    }
  }

  /** Take a plugin away: everything it added goes, and what was there before comes back. */
  function unload(id, state = 'off') {
    const p = plugins.get(id);
    if (!p || p.state !== 'on') return false;
    p.state = state;
    for (const off of p.offs.splice(0).reverse()) {
      try { off(); } catch { /* already gone */ }
    }
    if (p.cleanup) {
      try { p.cleanup(); } catch (error) { log(id, 'ERROR', `al apagar: ${text(error)}`); }
      p.cleanup = null;
    }
    return true;
  }

  return {
    load,
    unload,
    /** What there is: ``[{id, state: 'on'|'off'|'failed', errors, error}]``. */
    list: () => [...plugins].map(([id, p]) => ({ id, state: p.state, errors: p.errors, error: p.error })),
  };
}
