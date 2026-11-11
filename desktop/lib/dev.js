// Development plugins (see docs/PLUGINS.md). Unlike the plugins of plugins.js they run WITHOUT isolation or permissions, with
// the same powers as the app: whatever they are asked to do, they can. That is what they are for (trying things, or letting
// an AI that edits your files try things), so what is built here is not a sandbox but the guard rails that keep them from
// running by accident or by trick:
//   - only from one folder of their own, and only while the developer mode is on (which nothing but the user can turn on);
//   - each one approved by hand, and approved again if what it declares changes (its code may change freely: hot reload);
//   - never read from the normal plugin folders, nor accepted by the normal plugin loader (which refuses their manifest).
// This module knows nothing about Electron: it finds them, checks them, remembers what was approved and watches the folder.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { MAX_SCRIPT_BYTES, insideOf } from './plugins.js';

/** Where a development plugin can run. `server` (the Python server) comes later. */
export const SCOPES = ['page', 'main'];

/** What each scope means, in the words the user reads before approving. */
export const SCOPE_TEXT = {
  page: 'correr dentro de la página de TDT local, con acceso a todo lo que ve y hace',
  main: 'correr en el proceso principal de la aplicación, con acceso al sistema: archivos, procesos, red y ventanas',
};

const ID = /^[\w.-]{1,64}$/;

/**
 * A page script is wrapped in a function when it runs, so it is compiled that way here (compiled, not run) to tell the
 * developer the real error and line: what the page's own `executeJavaScript` answers is only «Script failed to execute».
 * The wrapper is an `async` function, so `await` can be used at the top of the file.
 */
function syntaxProblem(file, name) {
  try {
    const code = readFileSync(file, 'utf8');
    new Script(`(async function () {\n${code}\n})`, { filename: name, lineOffset: -1 }); // eslint-disable-line no-new
    return '';
  } catch (error) {
    const line = /:(\d+)/.exec(String(error && error.stack ? error.stack.split('\n')[0] : ''));
    return `«${name}» tiene un error de sintaxis${line ? ' (línea ' + line[1] + ')' : ''}: ${error && error.message}`;
  }
}

/**
 * Read one folder as a development plugin: `{ "tdt": { "api": 0, "dev": { "page": "page.js", "main": "main.js" } } }`.
 * Always returns an object with `id`, `dir`, `scopes`, `files` and `problems`; one with problems is listed but never runs.
 */
export function readDevPlugin(dir) {
  const id = dir.split(/[\\/]/).filter(Boolean).pop();
  const plugin = { id, dir, name: id, version: '', description: '', scopes: [], files: {}, problems: [] };
  if (!ID.test(id)) plugin.problems.push('el nombre de la carpeta solo puede llevar letras, números, punto, guion y guion bajo');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch (error) {
    plugin.problems.push('manifest.json no se puede leer: ' + error.message);
    return plugin;
  }
  if (!manifest || typeof manifest !== 'object') {
    plugin.problems.push('manifest.json no es un objeto');
    return plugin;
  }
  plugin.name = String(manifest.name || id).slice(0, 120);
  plugin.version = String(manifest.version || '');
  plugin.description = String(manifest.description || '').slice(0, 400);
  const tdt = manifest.tdt;
  const dev = tdt && typeof tdt === 'object' ? tdt.dev : undefined;
  if (!dev || typeof dev !== 'object' || Array.isArray(dev)) {
    plugin.problems.push('no es un plugin de desarrollo: le falta «tdt.dev» en el manifest');
    return plugin;
  }
  if (tdt.api !== 0) plugin.problems.push('«tdt.api» tiene que ser 0 (la API de desarrollo no tiene garantías)');
  for (const key of Object.keys(dev)) {
    if (!SCOPES.includes(key)) plugin.problems.push(`el alcance «${key}» no existe todavía (hay: ${SCOPES.join(', ')})`);
  }
  for (const scope of SCOPES) {
    if (dev[scope] === undefined) continue;
    const real = insideOf(dir, dev[scope]);
    if (!real) plugin.problems.push(`el archivo «${dev[scope]}» del alcance «${scope}» no existe o está fuera de la carpeta`);
    else if (statSync(real).size > MAX_SCRIPT_BYTES) plugin.problems.push(`el archivo «${dev[scope]}» es demasiado grande`);
    else {
      const syntax = scope === 'page' ? syntaxProblem(real, dev[scope]) : '';
      if (syntax) plugin.problems.push(syntax);
      else {
        plugin.scopes.push(scope);
        plugin.files[scope] = real;
      }
    }
  }
  if (!plugin.scopes.length && !plugin.problems.length) plugin.problems.push('no declara ningún alcance en «tdt.dev»');
  return plugin;
}

/** Every folder of `root` with a manifest, read as a development plugin. A missing folder is no plugins. */
export function discoverDev(root) {
  let names = [];
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names.sort().filter((name) => existsSync(join(root, name, 'manifest.json'))).map((name) => readDevPlugin(join(root, name)));
}

/**
 * The start of the code that would run, for the question the user answers: the point is that they see what they allow.
 * A file longer than `limit` characters shows how much more there is.
 */
export function codePreview(plugin, limit = 1200) {
  const parts = [];
  try {
    for (const scope of plugin.scopes) {
      const text = readFileSync(plugin.files[scope], 'utf8');
      const head = text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} caracteres más)` : text;
      parts.push(`── ${basename(plugin.files[scope])} (${scope}) ──\n${head}`);
    }
  } catch {
    /* a file that cannot be read now is not shown: the question still says what the plugin will be able to do */
  }
  return parts.join('\n\n');
}

/** What the user approves: this plugin, with these scopes. Changing the scopes changes it, so it is asked again. */
export const signature = (plugin) => `${plugin.id}|${[...plugin.scopes].sort().join(',')}`;

/** The saved state: `{mode: boolean, approved: {id: signature}}`. Off and nothing approved if there is none or it is broken. */
export function readDevState(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const approved = {};
    for (const [id, sig] of Object.entries(data && data.approved && typeof data.approved === 'object' ? data.approved : {})) {
      if (typeof sig === 'string') approved[id] = sig;
    }
    return { mode: !!data && data.mode === true, approved };
  } catch {
    return { mode: false, approved: {} };
  }
}

export function writeDevState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ mode: !!state.mode, approved: state.approved }, null, 2) + '\n', 'utf8');
}

/** Does this plugin run? Without problems, and approved exactly as it is now. */
export const isApproved = (plugin, state) => !plugin.problems.length && state.approved[plugin.id] === signature(plugin);

/** True if it was approved once with other scopes: it needs the user to look at it again. */
export const needsReapproval = (plugin, state) => !plugin.problems.length && plugin.id in state.approved && !isApproved(plugin, state);

/**
 * The scripts for the page of TDT local: from the approved plugins that declare `page`. The file is read now, not when the
 * plugin was found, so that a change on disk is what the next load runs.
 * @returns {{id: string, name: string, code: string}[]}
 */
export function pageScripts(plugins, state) {
  const out = [];
  for (const plugin of plugins) {
    if (!plugin.scopes.includes('page') || !isApproved(plugin, state)) continue;
    try {
      out.push({ id: plugin.id, name: plugin.name, code: readFileSync(plugin.files.page, 'utf8') });
    } catch {
      /* it disappeared between the scan and now: the next scan says so */
    }
  }
  return out;
}

/**
 * Call `onChange` (once, after `delay` ms without more changes) when something inside `dir` changes. This is the hot reload.
 * @returns {{close: () => void}}
 */
export function watchFolder(dir, onChange, { delay = 400 } = {}) {
  let timer = null;
  let watcher = null;
  try {
    watcher = watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, delay);
    });
    watcher.on('error', () => {});
  } catch {
    /* a folder that cannot be watched is just not hot reloaded */
  }
  return {
    close() {
      clearTimeout(timer);
      if (watcher) watcher.close();
    },
  };
}
