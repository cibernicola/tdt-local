// The running side of the development plugins (lib/dev.js says what they are; docs/PLUGINS.md why they are like this). It
// holds the mode, the plugins found, what was approved and the ones running in the main process, and it reloads them when
// their folder changes. What needs Electron comes in as arguments (`confirm`, `importPlugin`, `api`, `onChange`), so it is
// tested without it.
import { join } from 'node:path';
import {
  SCOPE_TEXT, codePreview, discoverDev, isApproved, needsReapproval, pageScripts, readDevPlugin, readDevState, signature, watchFolder,
  writeDevState,
} from './dev.js';

/** The words of the two native confirmations. They are deliberately plain and a little unfriendly. */
export const MODE_WARNING = {
  message: 'Activar el modo desarrollador',
  detail:
    'Los plugins de desarrollo se ejecutan SIN aislamiento ni permisos: pueden leer y cambiar cualquier cosa de TDT local y, '
    + 'los que usan el proceso principal, hacer lo mismo que puedes hacer tú en este equipo (archivos, procesos, red).\n\n'
    + 'Actívalo solo si vas a escribir o probar plugins tú, o con una IA de tu confianza. Si alguien te ha pedido que lo '
    + 'actives para «instalar» algo, no lo hagas.',
};

export function approvalWarning(plugin) {
  const code = codePreview(plugin);
  return {
    message: `Activar el plugin de desarrollo «${plugin.name}»`,
    detail:
      'Va a poder:\n' + plugin.scopes.map((s) => `  • ${SCOPE_TEXT[s]}`).join('\n')
      + '\n\nSu código puede cambiar mientras esté activo y se recarga solo. Si cambia lo que declara, se te vuelve a preguntar.'
      + (code ? `\n\nEl código:\n\n${code}` : ''),
  };
}

/**
 * @param {object} o
 * @param {string} o.dir          folder of the development plugins
 * @param {string} o.stateFile    where the mode and the approvals are kept
 * @param {object} o.env          process.env (TDT_DEV=1 turns the mode on; TDT_DEV_APPROVE=all approves everything, but not packaged)
 * @param {boolean} o.packaged
 * @param {(warning: {message: string, detail: string}) => Promise<boolean>} o.confirm  the native question; true = the user agreed
 * @param {(level: string, text: string, source?: string) => void} o.log
 * @param {(file: string) => Promise<object>} o.importPlugin   loads a main-process script (a new copy each time)
 * @param {(plugin: object) => object} o.api                   what `activate` receives
 * @param {(change: {reloadPage: boolean}) => void} o.onChange  something changed: refresh the tray and, if asked, reload the page
 */
export function createDevRuntime({ dir, stateFile, env, packaged, confirm, log, importPlugin, api, onChange, delay = 400 }) {
  let state = readDevState(stateFile);
  const forced = env.TDT_DEV === '1';
  const autoApprove = env.TDT_DEV_APPROVE === 'all' && !packaged; // for the tests that drive the window: never in an installed app
  let plugins = [];
  const loose = {}; // approvals that are only in memory (autoApprove)
  const running = new Map(); // id -> {deactivate}
  const errors = new Map(); // id -> text
  const watchers = new Map();

  const mode = () => forced || state.mode;
  const approvals = () => ({ ...state, approved: { ...state.approved, ...loose } });
  const active = (plugin) => isApproved(plugin, approvals());

  async function startMain(plugin) {
    if (!plugin.scopes.includes('main') || !active(plugin) || running.has(plugin.id)) return;
    try {
      const mod = await importPlugin(plugin.files.main);
      const activate = mod.activate || mod.default;
      if (typeof activate !== 'function') throw new Error('main.js tiene que exportar una función (export default, o export function activate)');
      await activate(api(plugin));
      running.set(plugin.id, { deactivate: typeof mod.deactivate === 'function' ? mod.deactivate : null });
      errors.delete(plugin.id);
      log('INFO', 'arrancado en el proceso principal', 'dev:' + plugin.id);
    } catch (error) {
      errors.set(plugin.id, String((error && error.message) || error).slice(0, 300));
      log('ERROR', 'no arrancó: ' + ((error && error.stack) || error), 'dev:' + plugin.id);
    }
  }

  async function stopMain(id) {
    const entry = running.get(id);
    running.delete(id);
    if (!entry || !entry.deactivate) return;
    try {
      await entry.deactivate();
    } catch (error) {
      log('WARN', 'deactivate falló: ' + ((error && error.message) || error), 'dev:' + id);
    }
  }

  function watch(plugin) {
    if (watchers.has(plugin.id)) return;
    watchers.set(plugin.id, watchFolder(plugin.dir, () => reloaded(plugin.id), { delay }));
  }

  /** A file of the plugin changed: read it again and, if it is still the same approval, run it again. */
  async function reloaded(id) {
    const old = plugins.find((p) => p.id === id);
    if (!old) return;
    const fresh = readDevPlugin(old.dir);
    plugins = plugins.map((p) => (p.id === id ? fresh : p));
    await stopMain(id);
    log('INFO', 'recargado por un cambio en su carpeta' + (fresh.problems.length ? ' (con problemas: ' + fresh.problems.join('; ') + ')' : ''), 'dev:' + id);
    if (needsReapproval(fresh, approvals())) log('WARN', 'ahora declara otros alcances: hay que volver a activarlo', 'dev:' + id);
    errors.delete(id);
    await startMain(fresh);
    onChange({ reloadPage: fresh.scopes.includes('page') || old.scopes.includes('page') });
  }

  async function startAll() {
    for (const plugin of plugins) {
      if (!active(plugin)) continue;
      watch(plugin);
      await startMain(plugin);
    }
  }

  async function stopAll() {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    for (const id of [...running.keys()]) await stopMain(id);
  }

  function load() {
    plugins = mode() ? discoverDev(dir) : [];
    if (autoApprove) for (const p of plugins) if (!p.problems.length) loose[p.id] = signature(p);
  }

  const view = () => ({
    mode: mode(),
    forced,
    folder: dir,
    plugins: plugins.map((p) => ({
      id: p.id, name: p.name, version: p.version, description: p.description, scopes: p.scopes, problems: p.problems,
      approved: active(p), needsReapproval: needsReapproval(p, approvals()), running: running.has(p.id), error: errors.get(p.id) || '',
    })),
  });

  return {
    /** At start-up: read the plugins (the page asks for its scripts right after) and start the ones for the main process. */
    init() {
      load();
      if (mode()) log('WARN', `MODO DESARROLLADOR${forced ? ' (por TDT_DEV)' : ''}: ${plugins.filter(active).length} plugins sin aislar`, 'dev');
    },
    start: startAll,
    stop: stopAll,
    view,
    mode,
    /** How many plugins run without isolation now: what the permanent notice says. */
    count: () => (mode() ? plugins.filter(active).length : 0),
    pageScripts: () => (mode() ? pageScripts(plugins, approvals()) : []),
    has: (id) => plugins.some((p) => p.id === id && active(p)),

    async setMode(on) {
      if (on === mode()) return view();
      if (on) {
        if (!(await confirm(MODE_WARNING))) return view();
        state = { ...state, mode: true };
        writeDevState(stateFile, state);
        log('WARN', 'modo desarrollador activado por el usuario', 'dev');
        load();
        await startAll();
      } else {
        if (forced) return view(); // TDT_DEV decides; the page cannot undo what the environment asked for
        await stopAll();
        state = { ...state, mode: false };
        writeDevState(stateFile, state);
        plugins = [];
        log('INFO', 'modo desarrollador desactivado', 'dev');
      }
      onChange({ reloadPage: true });
      return view();
    },

    async approve(id, on) {
      const plugin = plugins.find((p) => p.id === id);
      if (!mode() || !plugin) return view();
      if (on) {
        if (plugin.problems.length) return view();
        if (!(await confirm(approvalWarning(plugin)))) return view();
        state = { ...state, approved: { ...state.approved, [id]: signature(plugin) } };
        writeDevState(stateFile, state);
        log('WARN', 'activado por el usuario con los alcances: ' + plugin.scopes.join(', '), 'dev:' + id);
        watch(plugin);
        await startMain(plugin);
      } else {
        const { [id]: _gone, ...rest } = state.approved;
        state = { ...state, approved: rest };
        delete loose[id];
        writeDevState(stateFile, state);
        watchers.get(id)?.close();
        watchers.delete(id);
        await stopMain(id);
        log('INFO', 'desactivado por el usuario', 'dev:' + id);
      }
      onChange({ reloadPage: plugin.scopes.includes('page') });
      return view();
    },

    /** Find new folders (and re-read the ones there are) without stopping what is running; start what is approved. */
    async refresh() {
      load();
      await startAll(); // idempotent: what already runs is left alone
      return view();
    },

    async rescan() {
      await stopAll();
      load();
      await startAll();
      onChange({ reloadPage: false });
      return view();
    },
  };
}

/** Where a development plugin of the main process can keep its own files, apart from its folder (which is watched). */
export const dataDirOf = (dir, id) => join(dir, '..', 'dev-data', id);
