// Plugins with all the power, the ones anyone can install: `{ "tdt": { "api": 1, "full": { "page": "page.js", "css": "theme.css" } } }` (docs/HACKEABLE.md). Their code runs INSIDE the page of
// TDT local, without isolation, with the hooks of the application (on, filter, register...) and no permission that limits it: that is the point, and it is what the user
// is told before turning one on, with the code in front of them. There is no sandbox to review, so what stands in for it is:
//   - the approval is of the CODE, not of what the manifest declares: a plugin is approved with a fingerprint of every file of its folder, and one letter changed asks again;
//   - the code that runs is read at the moment it is handed over and checked against that fingerprint (a file changed on disk after the approval does not run);
//   - it only gets to the page of TDT local, never to another site, and never in safe mode (main.js decides; this module only says what is true of a plugin).
// Two scopes: `page` (a script that runs in the page) and `css` (a style sheet: a THEME, which changes how the application looks and runs no code, docs/TEMAS.md). A plugin may have
// both. The pictures and fonts a style sheet names are put inside it (`data:` addresses) when it is handed over, from files of its own folder only: the page may not load anything else.
// `main` (Node, files and processes of the machine) and `server` come later, each with its own question; for now they stay for the development plugins (lib/dev.js).
// This module knows nothing about Electron.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Script } from 'node:vm';
import { ID } from './plugin-api.js';

export const SCOPES = ['page', 'css'];
export const MAX_FILES = 200;
export const MAX_CSS = 1024 * 1024;
export const MAX_ASSET = 1024 * 1024; // each picture or font a style sheet names
export const MAX_ASSETS = 4 * 1024 * 1024; // all of them together
const ASSET_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

const hex = (data) => createHash('sha256').update(data).digest('hex');

/** The files of a folder as relative paths with `/`, in order, as the packager counts them (hidden ones, node_modules and packages left out). A link is an error. */
function filesOf(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.endsWith('.tdtplugin')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = lstatSync(join(dir, rel));
    if (stat.isSymbolicLink()) throw new Error(`«${rel}» es un enlace: un plugin no puede llevar enlaces`);
    if (stat.isDirectory()) out.push(...filesOf(dir, rel));
    else if (stat.isFile()) out.push(rel);
    if (out.length > MAX_FILES) throw new Error(`demasiados archivos (hasta ${MAX_FILES})`);
  }
  return out;
}

/**
 * Does the fingerprint count this file (a path relative to the folder, as the manifest says it)? It does not count hidden files, `node_modules` or packages (they do not travel in a package either). A file that does
 * not count could change after the approval without anybody noticing, so none of them may be run or put into a style sheet.
 */
export function counted(path) {
  const parts = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').split('/');
  // `..` and `.` are ways of writing a path (and a way out of the folder is refused elsewhere, in words of its own): only a name that starts with a dot is hidden
  return !parts.some((p) => (p.startsWith('.') && p !== '..' && p !== '.') || p === 'node_modules') && !parts[parts.length - 1].endsWith('.tdtplugin');
}

/** A fingerprint of the code: the names and the contents of every file of the folder. The same folder gives the same one wherever it is. */
export function fingerprint(dir) {
  const lines = filesOf(dir).map((rel) => `${rel}\0${hex(readFileSync(join(dir, ...rel.split('/'))))}`);
  return hex(lines.join('\n'));
}

/** The page script is wrapped in an `async` function when it runs (preload.cjs), so it is compiled that way here, without running it, to say the real error and line. */
function syntaxProblem(file, name) {
  try {
    new Script(`(async function () {\n${readFileSync(file, 'utf8')}\n})`, { filename: name, lineOffset: -1 }); // eslint-disable-line no-new
    return '';
  } catch (error) {
    const line = /:(\d+)/.exec(String(error && error.stack ? error.stack.split('\n')[0] : ''));
    return `«${name}» tiene un error de sintaxis${line ? ' (línea ' + line[1] + ')' : ''}: ${error && error.message}`;
  }
}

/**
 * Put the pictures and fonts of a style sheet inside it. Only files of the plugin's own folder, of the types in `ASSET_TYPES` and not too big: the page cannot load anything from
 * anywhere else, so an address with a scheme (`https:`, `file:`...) is a problem, and so is `@import`. `data:` addresses and `#fragments` stay as they are.
 * @param {string} css
 * @param {string} dir the folder of the plugin
 * @param {(dir: string, file: string) => string | null} insideOf
 * @returns {{css: string, problems: string[]}}
 */
export function inlineAssets(css, dir, insideOf) {
  const problems = [];
  if (/@import/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) problems.push('la hoja de estilo usa «@import»: junta las reglas en un solo archivo'); // a comment may say it
  let total = 0;
  const cache = new Map();
  // a comment is left as it is: what it says about a file is no request for it
  const out = css.replace(/(\/\*[\s\S]*?\*\/)|url\(\s*(['"]?)([^'")]*)\2\s*\)/gi, (whole, comment, quote, address) => {
    if (comment) return whole;
    const target = address.trim();
    if (!target || target.startsWith('#') || /^data:/i.test(target)) return whole;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
      problems.push(`«${target.slice(0, 60)}»: los recursos tienen que estar en la carpeta del plugin, no en otra dirección`);
      return whole;
    }
    const clean = target.split(/[?#]/)[0];
    if (cache.has(clean)) return `url("${cache.get(clean)}")`;
    if (!counted(clean)) {
      problems.push(`«${clean.slice(0, 60)}» no cuenta en la huella del código (es un archivo oculto o está en node_modules): ponlo en otra ruta`);
      return whole;
    }
    const type = ASSET_TYPES[extname(clean).toLowerCase()];
    const real = type ? insideOf(dir, clean.replace(/^\.?\//, '')) : null;
    if (!type) problems.push(`«${clean.slice(0, 60)}»: tipo de archivo no permitido (hay imágenes y fuentes)`);
    else if (!real) problems.push(`«${clean.slice(0, 60)}» no existe o está fuera de la carpeta`);
    else {
      const bytes = readFileSync(real);
      total += bytes.length;
      if (bytes.length > MAX_ASSET) problems.push(`«${clean.slice(0, 60)}» pesa más de ${MAX_ASSET / 1048576} MB`);
      else if (total > MAX_ASSETS) problems.push(`los recursos pesan más de ${MAX_ASSETS / 1048576} MB`);
      else {
        const uri = `data:${type};base64,${bytes.toString('base64')}`;
        cache.set(clean, uri);
        return `url("${uri}")`;
      }
    }
    return whole;
  });
  return { css: out, problems };
}

/**
 * Read a folder whose manifest declares `tdt.full` (called by readPlugin). Fills in `kind: 'full'`, `scopes`, `files`, `hash` and `problems`; one with problems is listed and never runs.
 * @param {{insideOf: (dir: string, file: string) => string | null, maxBytes: number}} tools
 */
export function readFullPlugin(manifest, dir, plugin, { insideOf, maxBytes }) {
  const tdt = manifest.tdt;
  plugin.kind = 'full';
  plugin.api = tdt.api;
  plugin.author = String(manifest.author || '').slice(0, 120);
  plugin.homepage = /^https:\/\//.test(String(manifest.homepage || '')) ? String(manifest.homepage).slice(0, 200) : '';
  plugin.scopes = [];
  plugin.files = {};
  plugin.permissions = []; // none: it can do everything
  plugin.hash = '';
  if (tdt.api !== 1) plugin.problems.push('«tdt.api» tiene que ser 1');
  if (!ID.test(plugin.id)) plugin.problems.push('el nombre de la carpeta (el id) solo puede llevar minúsculas, números y guiones, y empezar por una letra o un número');
  if (tdt.dev !== undefined) plugin.problems.push('un plugin es de desarrollo («tdt.dev») o con todo el poder («tdt.full»), no las dos cosas');
  if (Array.isArray(manifest.content_scripts) && manifest.content_scripts.length) plugin.problems.push('un plugin es de un tipo o de otro: no puede llevar «tdt.full» y «content_scripts»');
  for (const key of ['permissions', 'entry', 'panel', 'settings', 'sources', 'themes', 'rules', 'activation']) {
    if (tdt[key] !== undefined) plugin.problems.push(`«tdt.${key}» no se usa en un plugin con todo el poder: no pide permisos y se ocupa él mismo de lo que muestra`);
  }
  const full = tdt.full;
  if (!full || typeof full !== 'object' || Array.isArray(full)) {
    plugin.problems.push('«tdt.full» tiene que ser un objeto, por ejemplo {"page": "page.js"} o {"css": "tema.css"}');
    return plugin;
  }
  for (const key of Object.keys(full)) {
    if (!SCOPES.includes(key)) {
      plugin.problems.push(
        key === 'main' || key === 'server'
          ? `el alcance «${key}» todavía no está disponible en plugins que se instalan (solo en los de desarrollo)`
          : `el alcance «${key}» no existe (hay: ${SCOPES.join(', ')})`,
      );
    }
  }
  if (full.page === undefined && full.css === undefined) {
    if (!plugin.problems.length) plugin.problems.push('«tdt.full» no declara ningún alcance (por ejemplo «page» o «css»)');
    return plugin;
  }
  if (full.page !== undefined) {
    const real = typeof full.page === 'string' && counted(full.page) ? insideOf(dir, full.page) : null;
    if (typeof full.page === 'string' && !counted(full.page)) plugin.problems.push(`el archivo «${full.page.slice(0, 60)}» no cuenta en la huella del código (es un archivo oculto o está en node_modules): ponlo en otra ruta`);
    else if (!real) plugin.problems.push(`el archivo «${String(full.page).slice(0, 60)}» del alcance «page» no existe o está fuera de la carpeta`);
    else if (lstatSync(real).size > maxBytes) plugin.problems.push(`el archivo «${full.page}» es demasiado grande`);
    else {
      const syntax = syntaxProblem(real, full.page);
      if (syntax) plugin.problems.push(syntax);
      else {
        plugin.scopes.push('page');
        plugin.files.page = real;
      }
    }
  }
  if (full.css !== undefined) {
    const real = typeof full.css === 'string' && /\.css$/i.test(full.css) && counted(full.css) ? insideOf(dir, full.css) : null;
    if (typeof full.css === 'string' && /\.css$/i.test(full.css) && !counted(full.css)) plugin.problems.push(`el archivo «${full.css.slice(0, 60)}» no cuenta en la huella del código (es un archivo oculto o está en node_modules): ponlo en otra ruta`);
    else if (!real) plugin.problems.push(`el archivo «${String(full.css).slice(0, 60)}» del alcance «css» no existe, está fuera de la carpeta o no es .css`);
    else if (lstatSync(real).size > MAX_CSS) plugin.problems.push(`el archivo «${full.css}» pesa más de ${MAX_CSS / 1048576} MB`);
    else {
      const checked = inlineAssets(readFileSync(real, 'utf8'), dir, insideOf);
      if (checked.problems.length) plugin.problems.push(...checked.problems.map((p) => `«${full.css}»: ${p}`));
      else {
        plugin.scopes.push('css');
        plugin.files.css = real;
      }
    }
  }
  if (!plugin.problems.length) {
    try {
      plugin.hash = fingerprint(dir);
    } catch (error) {
      plugin.problems.push(String((error && error.message) || error));
    }
  }
  return plugin;
}

/** Is it a theme only: a style sheet and no code? That is a much smaller thing to allow, and the words say so. */
export const isTheme = (plugin) => plugin.kind === 'full' && plugin.scopes.includes('css') && !plugin.scopes.includes('page');

/** What the user approves: this plugin, with these scopes, and exactly this code. */
export const signature = (plugin) => `${plugin.id}|full|${[...plugin.scopes].sort().join(',')}|${plugin.hash}`;

/** Does this plugin run? Without problems, and approved with exactly the code it has now. */
export const isApproved = (plugin, approved) => plugin.kind === 'full' && !plugin.problems.length && approved[plugin.id] === signature(plugin);

/** True if it was approved once with other code: it needs the user to look at it again. */
export const needsReapproval = (plugin, approved) => plugin.kind === 'full' && !plugin.problems.length && plugin.id in approved && approved[plugin.id] !== signature(plugin);

/** The start of the code (or of the style sheet, for a theme), for the question the user answers: the point is that they see what they allow. */
export function codePreview(plugin, limit = 1500) {
  try {
    const text = readFileSync(plugin.files.page || plugin.files.css, 'utf8');
    return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} caracteres más)` : text;
  } catch {
    return '';
  }
}

/** The words that say what a plugin with all the power is. The same in the question to turn it on and in the one to install it. */
export const POWER_TEXT = 'Corre DENTRO de la página de TDT local, sin aislar y sin permisos que lo limiten: puede ver y cambiar todo lo que la aplicación ve y hace '
  + '(los canales, lo que reproduces, tus ajustes y lo que guardas en ella), cambiar lo que hace la aplicación (la publicidad, las teclas, el aspecto), poner lo que quiera '
  + 'sobre la pantalla y pedir lo que quiera a internet con el acceso de la propia página.';

/** What a theme is: much less than the above, and it says so. */
export const THEME_TEXT = 'Es un tema: una hoja de estilo que cambia el aspecto de TDT local (colores, tamaños, tipografías, qué se ve y dónde). No ejecuta código ni pide nada a internet. '
  + 'Con una hoja de estilo se puede esconder un botón o poner algo encima de otra cosa, así que solo es tan fiable como quien lo hizo.';

/** The words about what a plugin is, for the installation and the activation questions. */
export const aboutPower = (plugin) => (isTheme(plugin) ? THEME_TEXT : POWER_TEXT);

/** The question the user answers to turn one on. */
export function activationQuestion(plugin) {
  const code = codePreview(plugin);
  const theme = isTheme(plugin);
  return {
    message: theme ? `Activar el tema «${plugin.name}»` : `Activar «${plugin.name}», un plugin con TODO el poder`,
    detail:
      `${plugin.author ? `De ${plugin.author}. ` : ''}Versión ${plugin.version || '?'}.\n\n${aboutPower(plugin)}\n\n`
      + `Solo actívalo si confías en quien lo hizo. Si cambia una sola letra de su ${theme ? 'hoja de estilo' : 'código'}, se te vuelve a preguntar.\n\nHuella: ${plugin.hash.slice(0, 16)}…`
      + (code ? `\n\n${theme ? 'Su hoja de estilo' : 'Su código (page.js)'}:\n\n${code}` : ''),
  };
}

/**
 * What to hand to the page of TDT local: from the plugins that are on and approved. Each folder is read AGAIN now and has to give the fingerprint that was approved, so a file changed
 * on disk after the approval does not run (it is told in the log, and the next scan shows that it needs a new approval). A style sheet goes out with its pictures and fonts inside.
 * @param {object[]} plugins
 * @param {Set<string>} enabled
 * @param {Record<string, string>} approved
 * @param {{read: (dir: string) => object, insideOf: (dir: string, file: string) => string | null, warn?: (text: string, id: string) => void}} tools
 * @returns {{id: string, name: string, code?: string, css?: string, source: 'full'}[]}
 */
export function handOver(plugins, enabled, approved, { read, insideOf, warn = () => {} }) {
  const out = [];
  for (const listed of plugins) {
    if (listed.kind !== 'full' || !enabled.has(listed.id)) continue;
    const fresh = read(listed.dir);
    if (!isApproved(fresh, approved)) {
      warn('el código ha cambiado desde que lo aprobaste: no se carga hasta que lo vuelvas a activar', listed.id);
      continue;
    }
    try {
      const item = { id: fresh.id, name: fresh.name, source: 'full' };
      if (fresh.files.page) item.code = readFileSync(fresh.files.page, 'utf8');
      if (fresh.files.css) {
        const done = inlineAssets(readFileSync(fresh.files.css, 'utf8'), fresh.dir, insideOf);
        if (done.problems.length) throw new Error(done.problems[0]);
        item.css = done.css;
      }
      if (fingerprint(fresh.dir) !== fresh.hash) throw new Error('changed while it was being read'); // what runs is what was approved, not what the folder turned into meanwhile
      out.push(item);
    } catch {
      warn('no se pudo leer tal como se aprobó: no se carga', listed.id);
    }
  }
  return out;
}
