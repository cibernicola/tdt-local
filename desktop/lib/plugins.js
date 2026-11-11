// Plugins of the desktop app. A plugin is a folder with a `manifest.json` in the format of the content scripts of a Chrome
// extension, so the same folder also loads as an extension in a normal browser (tools/puente-atresplayer does).
//
//   { "name": "...", "version": "1.0", "description": "...",
//     "content_scripts": [ { "matches": ["https://example.com/embed/*"], "js": ["a.js", "b.js"], "all_frames": true } ] }
//
// This module knows nothing about Electron: it finds the plugins, checks them and says which scripts go in which page.
// What a plugin may do is deliberately little: run its own scripts in pages whose address it declares. It asks for no
// permissions (a manifest that does is refused), and its scripts are read from its own folder, never from the network.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readUiPlugin } from './plugin-api.js';
import { readFullPlugin } from './plugin-full.js';

export const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
// An address that is TDT local itself or this machine: a plugin acts on other people's pages, not on the app's own.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

/**
 * A Chrome-style match pattern as a test on addresses: `scheme://host/path` where `*` is any text in the path, `*.`
 * opens the host to subdomains and `*` as scheme means http or https. A `problem` for the ones a plugin must not have
 * (any host, this machine).
 * @returns {{test: (url: string) => boolean} | {problem: string}}
 */
export function parsePattern(pattern) {
  const m = /^(https?|\*):\/\/([^/]+)(\/.*)$/.exec(String(pattern));
  if (!m) return { problem: `patrón no válido: «${pattern}» (usa https://sitio/ruta/*)` };
  const [, scheme, host, path] = m;
  if (host === '*' || LOCAL_HOST.test(host.replace(/:\d+$/, ''))) {
    return { problem: `patrón demasiado amplio o local: «${pattern}»` };
  }
  if (/[^\w.\-*:[\]]/.test(host) || (host.includes('*') && !/^\*\.[^*]+$/.test(host))) {
    return { problem: `patrón no válido: «${pattern}»` };
  }
  const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const hostRe = host.startsWith('*.') ? `([^/]+\\.)?${escape(host.slice(2))}` : escape(host);
  const pathRe = path.split('*').map(escape).join('.*');
  const re = new RegExp(`^${scheme === '*' ? 'https?' : scheme}://${hostRe}${pathRe}$`, 'i');
  return {
    test(url) {
      try {
        const u = new URL(url);
        return re.test(`${u.protocol}//${u.host}${u.pathname}${u.search}`);
      } catch {
        return false;
      }
    },
  };
}

/** Is this script path inside the plugin's folder (no `..`, no absolute path, no link that leaves it)? */
export function insideOf(dir, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  const full = resolve(dir, file);
  if (!existsSync(full)) return null;
  const real = realpathSync(full);
  const base = realpathSync(dir);
  const rel = relative(base, real);
  return rel && !rel.startsWith('..') && !rel.includes(`..${sep}`) && resolve(base, rel) === real ? real : null;
}

/**
 * Read one folder as a plugin. Always returns an object with `id`, `dir` and `problems`; a plugin with problems is listed
 * (so the user sees why) but never runs.
 */
export function readPlugin(dir) {
  const id = dir.split(/[\\/]/).filter(Boolean).pop();
  const plugin = { id, dir, kind: 'script', name: id, version: '', description: '', source: '', sites: [], rules: [], problems: [] };
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
  if (manifest.tdt && typeof manifest.tdt === 'object' && manifest.tdt.full !== undefined) {
    return readFullPlugin(manifest, dir, plugin, { insideOf, maxBytes: MAX_SCRIPT_BYTES }); // a plugin with all the power (lib/plugin-full.js)
  }
  if (manifest.tdt && typeof manifest.tdt === 'object' && manifest.tdt.api !== undefined && manifest.tdt.dev === undefined) {
    return readUiPlugin(manifest, dir, plugin, insideOf);
  }
  if (manifest.tdt && typeof manifest.tdt === 'object' && manifest.tdt.dev !== undefined) {
    plugin.problems.push('es un plugin de desarrollo: solo se carga desde la carpeta de desarrollo, con el modo desarrollador');
  }
  for (const key of ['permissions', 'host_permissions', 'optional_permissions', 'background', 'externally_connectable']) {
    const value = manifest[key];
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
      plugin.problems.push(`pide «${key}», que esta versión no ofrece a los plugins`);
    }
  }
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  if (!scripts.length) plugin.problems.push('no declara content_scripts');
  for (const entry of scripts) {
    const patterns = (Array.isArray(entry && entry.matches) ? entry.matches : []).map(parsePattern);
    patterns.filter((p) => p.problem).forEach((p) => plugin.problems.push(p.problem));
    if (!patterns.length) plugin.problems.push('un content_script no dice en qué páginas actúa (matches)');
    const files = [];
    for (const file of Array.isArray(entry && entry.js) ? entry.js : []) {
      const real = insideOf(dir, file);
      if (!real) plugin.problems.push(`el script «${file}» no existe o está fuera de la carpeta`);
      else if (statSync(real).size > MAX_SCRIPT_BYTES) plugin.problems.push(`el script «${file}» es demasiado grande`);
      else files.push({ file, real });
    }
    if (!files.length) plugin.problems.push('un content_script no tiene scripts (js)');
    plugin.rules.push({ patterns: patterns.filter((p) => p.test), allFrames: entry && entry.all_frames === true, files });
    for (const pattern of Array.isArray(entry && entry.matches) ? entry.matches : []) {
      if (!plugin.sites.includes(String(pattern))) plugin.sites.push(String(pattern));
    }
  }
  return plugin;
}

/**
 * Every plugin found in the given folders (each one a folder that has a `manifest.json`). The first folder wins on a
 * repeated id. A folder can be a path or `{dir, label}`; the label says where the plugin comes from.
 */
export function discover(roots) {
  const found = new Map();
  for (const entry of roots) {
    const root = typeof entry === 'string' ? entry : entry.dir;
    const label = typeof entry === 'string' ? '' : entry.label || '';
    let names = [];
    try {
      names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const dir = join(root, name);
      if (!existsSync(join(dir, 'manifest.json')) || found.has(name)) continue;
      found.set(name, { ...readPlugin(dir), source: label });
    }
  }
  return [...found.values()];
}

/**
 * The scripts that must run in a page: only from plugins without problems that the user turned on, only if the page
 * is one of the addresses they declare, and in a frame inside the page only if they ask for `all_frames`.
 * @returns {{id: string, scripts: {file: string, code: string}[]}[]}
 */
export function scriptsFor(plugins, enabled, url, isTop) {
  const out = [];
  for (const plugin of plugins) {
    if (plugin.problems.length || !enabled.has(plugin.id)) continue;
    const files = new Map();
    for (const rule of plugin.rules) {
      if ((!isTop && !rule.allFrames) || !rule.patterns.some((p) => p.test(url))) continue;
      for (const { file, real } of rule.files) files.set(file, real);
    }
    if (!files.size) continue;
    out.push({ id: plugin.id, scripts: [...files].map(([file, real]) => ({ file, code: readFileSync(real, 'utf8') })) });
  }
  return out;
}

/** The ids of the plugins the user turned on, from the saved state (`{enabled: [...]}`); nothing is on by default. */
export function readEnabled(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return new Set(Array.isArray(data.enabled) ? data.enabled.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeEnabled(file, enabled) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ enabled: [...enabled].sort() }, null, 2) + '\n', 'utf8');
}
