// Publishing a plugin with permissions: a `.tdtplugin` file is a zip with one folder inside, named like the plugin's id. This
// module writes that zip from a folder and reads it back with the checks a file from anywhere needs (no paths that leave the
// folder, no links, no huge files, no bombs). Packing is reproducible: the same folder gives the same bytes, so the SHA-256 that
// the author publishes is the one the user sees when installing. Nothing here needs Electron.
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { ID } from './plugin-api.js';
import { readPlugin } from './plugins.js';

export const EXTENSION = '.tdtplugin';
export const LIMITS = { files: 200, total: 8 * 1024 * 1024, file: 4 * 1024 * 1024, name: 200 };
const DOS_DATE = (44 << 9) | (1 << 5) | 1; // 2024-01-01, fixed on purpose
const DOS_TIME = 0;

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** The files of a folder as relative paths with `/`, in order. Hidden files and folders are left out; a link is an error. */
export function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.endsWith(EXTENSION)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = lstatSync(join(dir, rel));
    if (stat.isSymbolicLink()) throw new Error(`«${rel}» es un enlace: un plugin no puede llevar enlaces`);
    if (stat.isDirectory()) out.push(...listFiles(dir, rel));
    else if (stat.isFile()) out.push(rel);
  }
  return out;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** A zip of the folder, with `<id>/` as its only top folder. Throws an Error in plain words if the folder is not a valid plugin. */
export function packFolder(dir, id = dir.split(/[\\/]/).filter(Boolean).pop()) {
  if (!ID.test(id)) throw new Error('el nombre de la carpeta (el id) solo puede llevar minúsculas, números y guiones');
  const plugin = readPlugin(dir);
  if (plugin.kind !== 'ui' && plugin.kind !== 'full') throw new Error('solo se empaquetan plugins con permisos («tdt.api»: 1) o con todo el poder («tdt.full»)');
  if (plugin.problems.length) throw new Error('el plugin tiene problemas: ' + plugin.problems.join('; '));
  const names = listFiles(dir);
  if (names.length > LIMITS.files) throw new Error(`demasiados archivos (hasta ${LIMITS.files})`);
  const locals = [];
  const centrals = [];
  let offset = 0;
  let total = 0;
  for (const rel of names) {
    const raw = readFileSync(join(dir, rel));
    if (raw.length > LIMITS.file) throw new Error(`«${rel}» pesa más de ${LIMITS.file / 1048576} MB`);
    total += raw.length;
    if (total > LIMITS.total) throw new Error(`el plugin pesa más de ${LIMITS.total / 1048576} MB`);
    const name = Buffer.from(`${id}/${rel}`, 'utf8');
    if (name.length > LIMITS.name) throw new Error(`«${rel}»: el nombre es demasiado largo`);
    const deflated = deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const data = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);
    const common = [u16(20), u16(0x0800), u16(method), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(data.length), u32(raw.length), u16(name.length), u16(0)];
    locals.push(Buffer.concat([u32(0x04034b50), ...common, name, data]));
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(0x031e), ...common, u16(0), u16(0), u16(0), u32(0o100644 << 16), u32(offset), name,
    ]));
    offset += locals.at(-1).length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(names.length), u16(names.length), u32(central.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, central, end]);
}

/** A name inside a package, checked: no way out of the folder. */
function cleanName(raw) {
  if (!raw || raw.length > LIMITS.name || /[\0\\:]/.test(raw) || raw.startsWith('/') || /[\u0001-\u001f]/.test(raw)) throw new Error(`nombre no permitido en el paquete: «${raw.slice(0, 60)}»`);
  const parts = raw.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`nombre no permitido en el paquete: «${raw.slice(0, 60)}»`);
  return parts;
}

/**
 * The files of a package: `{id, files: Map(path -> Buffer)}`. It refuses encrypted or zip64 files, links, files with a size that
 * does not match what they say, more than the limits, and anything that is not inside one folder named like an id.
 */
export function readPackage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > LIMITS.total * 2) throw new Error('no es un paquete de plugin');
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('no es un archivo zip');
  const count = buffer.readUInt16LE(end + 10);
  if (count === 0 || count > LIMITS.files) throw new Error(`el paquete tiene ${count} archivos (hasta ${LIMITS.files})`);
  let at = buffer.readUInt32LE(end + 16);
  const files = new Map();
  let total = 0;
  let id = null;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('el paquete está dañado');
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const packed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const external = buffer.readUInt32LE(at + 38);
    const local = buffer.readUInt32LE(at + 42);
    const raw = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (raw.endsWith('/')) continue; // a folder
    if (flags & 1) throw new Error('el paquete está cifrado');
    if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error('paquete zip64: demasiado grande');
    if (((external >>> 16) & 0o170000) === 0o120000) throw new Error(`«${raw.slice(0, 60)}» es un enlace: no se permiten`);
    const parts = cleanName(raw);
    if (parts.length < 2) throw new Error('todo el plugin tiene que ir dentro de una carpeta con el nombre del plugin');
    if (id === null) id = parts[0];
    if (parts[0] !== id) throw new Error('el paquete tiene más de una carpeta en la raíz');
    if (parts.slice(1).some((p) => p.startsWith('.'))) throw new Error('no se admiten archivos ocultos');
    if (size > LIMITS.file) throw new Error(`«${raw.slice(0, 60)}» pesa más de ${LIMITS.file / 1048576} MB`);
    total += size;
    if (total > LIMITS.total) throw new Error(`el plugin pesa más de ${LIMITS.total / 1048576} MB`);
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('el paquete está dañado');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + packed > buffer.length) throw new Error('el paquete está dañado');
    const slice = buffer.subarray(start, start + packed);
    let data;
    if (method === 0) data = Buffer.from(slice);
    else if (method === 8) data = inflateRawSync(slice, { maxOutputLength: size + 1 });
    else throw new Error('el paquete usa una compresión que no se admite');
    if (data.length !== size || crc32(data) !== crc) throw new Error(`«${raw.slice(0, 60)}» no coincide con lo que dice el paquete`);
    files.set(parts.slice(1).join('/'), data);
  }
  if (!id || !ID.test(id)) throw new Error('la carpeta del paquete no tiene un nombre de plugin válido (minúsculas, números y guiones)');
  if (!files.has('manifest.json')) throw new Error('el paquete no lleva manifest.json');
  return { id, files };
}

/**
 * Check a package and say what it contains without installing anything: the plugin as readPlugin sees it, the hash of the file and
 * whether one with that id is already in `root`.
 * @returns {{id: string, plugin: object, sha256: string, files: Map<string, Buffer>}} (the plugin's `dir` is a temporary folder: use `place`)
 */
export function inspectPackage(buffer) {
  const { id, files } = readPackage(buffer);
  const stage = mkdtempSync(join(tmpdir(), 'tdt-plugin-'));
  const dir = join(stage, id);
  for (const [name, data] of files) {
    const target = join(dir, ...name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  const plugin = readPlugin(dir);
  return { id, plugin, sha256: sha256(buffer), files, stage, dir };
}

/** Put an inspected package in `root/<id>` (replacing the folder of that id) and clean up. */
export function place(inspected, root) {
  const target = join(root, inspected.id);
  mkdirSync(root, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(inspected.dir, target, { recursive: true });
  rmSync(inspected.stage, { recursive: true, force: true });
  return target;
}

export const discard = (inspected) => rmSync(inspected.stage, { recursive: true, force: true });

/**
 * The folder of a new plugin: what «Crear un plugin nuevo» writes. It works as it is and shows the three things to know. `kind` is `ui` (with permissions, in a frame of its own),
 * `full` (all the power: code in the page with the hooks) or `theme` (only a style sheet).
 */
export function newPluginFiles(id, name, kind = 'ui') {
  const title = String(name || id).replace(/[<>&"]/g, '').slice(0, 60);
  if (kind === 'full') return fullTemplate(title);
  if (kind === 'theme') return themeTemplate(title);
  return {
    'manifest.json': JSON.stringify({
      name: title, version: '0.1.0', description: 'Dime en una frase qué hace.', author: 'Tu nombre',
      tdt: { api: 1, entry: 'index.html', label: title.slice(0, 24), panel: { width: 320, height: 180 }, permissions: ['player.read', 'ui.toast'] },
    }, null, 2) + '\n',
    'index.html': `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light dark">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 12px; font: 14px/1.4 system-ui, sans-serif; color: CanvasText; background: transparent; }
    button { font: inherit; }
  </style>
</head>
<body>
  <h1 style="font-size: 18px; margin: 0 0 6px">${title}</h1>
  <p id="texto">Conectando con TDT local…</p>
  <button id="aviso" type="button">Decir hola</button>
  <script src="/@tdt/sdk.js"></script>
  <script src="app.js"></script>
</body>
</html>
`,
    'app.js': `// 1. \`tdt\` lo crea /@tdt/sdk.js. Todo lo que pides pasa por la aplicación, que solo contesta a lo que declaraste en
//    "permissions" del manifest.json y aprobó quien te activó.
// 2. Cambia el manifest (permisos, tamaño del panel) y pulsa «Buscar de nuevo» en Ajustes ▸ Plugins: se recarga solo.
// 3. Lo que escribas con console.log sale en Ajustes ▸ Registro, con el nombre de tu plugin.
const $ = (id) => document.getElementById(id);

function pintar(estado) {
  const activa = estado.tiles.find((t) => t.slot === estado.focus) || estado.tiles[0];
  $('texto').textContent = activa ? 'Estás viendo ' + activa.name : 'No hay nada en pantalla';
}

(async () => {
  const yo = await tdt.ready; // { id, name, version, permissions }
  console.log('listo:', yo.id, yo.permissions.join(', '));
  pintar(await tdt.player.state()); // permiso player.read
  tdt.on('player', pintar); // la aplicación avisa cuando cambia algo
  $('aviso').addEventListener('click', () => tdt.ui.toast('Hola desde ' + yo.name).catch(console.error)); // permiso ui.toast
})().catch((error) => {
  $('texto').textContent = error.message; // por ejemplo: permiso denegado: player.read
});
`,
  };
}

const manifestOf = (title, description, full) => `${JSON.stringify({ name: title, version: '0.1.0', description, author: 'Tu nombre', tdt: { api: 1, full } }, null, 2)}\n`;

/** A plugin with all the power that works as it is: it says when an ad break starts and puts the name of the channel over every tile. */
function fullTemplate(title) {
  return {
    'manifest.json': manifestOf(title, 'Dime en una frase qué hace.', { page: 'page.js' }),
    'page.js': `// Un plugin con TODO el poder: corre dentro de la página de TDT local, sin aislar, con los ganchos de la aplicación (docs/HACKEABLE.md).
// 1. \`tdt\` lo pone la aplicación: tdt.on (algo ha pasado), tdt.filter (cambiar un valor), tdt.register (añadir o reemplazar cosas) y tdt.log (sale en Ajustes ▸ Registro con tu nombre).
// 2. Este ejemplo escribe en el Registro cuando empieza una pausa de anuncios y pone el nombre del canal sobre cada casilla.
// 3. Se ejecuta dentro de una función async: puedes usar await al principio y terminar con return () => { ... } para limpiar al apagarlo.
// 4. Al activarlo se te enseña este código y su huella; si cambias una sola letra, se te vuelve a preguntar.
tdt.on('ad.started', (anuncio) => tdt.log('pausa de anuncios en', anuncio.name));

tdt.register('tile.overlay', 'etiqueta', {
  mount(ctx) {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:8px;bottom:8px;padding:2px 8px;border-radius:4px;background:rgba(0,0,0,.6);color:#fff;font:12px system-ui';
    const pintar = (c) => { el.textContent = c.tile.channel ? c.tile.channel.name : ''; el.hidden = !c.tile.channel; };
    pintar(ctx);
    return { el, update: pintar };
  },
});
`,
  };
}

/** A theme that works as it is: another accent colour, in light and dark. */
function themeTemplate(title) {
  return {
    'manifest.json': manifestOf(title, 'Dime en una frase cómo lo deja.', { css: 'tema.css' }),
    'tema.css': `/* Un tema: una hoja de estilo que cambia el aspecto de TDT local (docs/TEMAS.md). Se aplica después de la de la aplicación y no ejecuta código. */
:root { --accent: #c0392b; --accent-ink: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --accent: #e0705e; --accent-ink: #1a0f0d; } }

/* Más colores: --chassis --panel --ink --muted --line --screen --row-hover --ok --bad --unk, y --font para la tipografía.
   Y cualquier clase estable (.tile-bar, .btn, .list, .notice...): mira la lista en docs/TEMAS.md. Una imagen de tu carpeta: background-image: url(fondo.png). */
`,
  };
}

/** An id (folder name) from a name people write: «Mi plugin de fútbol» -> mi-plugin-de-futbol; `taken` are ids already in use. */
export function idFromName(name, taken = []) {
  const base = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'mi-plugin';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base.slice(0, 36)}-${n}`;
  return id;
}
