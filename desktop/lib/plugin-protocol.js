// The address a plugin of api 1 is served from: tdt-plugin://<id>/<file>. Each plugin has its own host name, so to the browser
// each one is a different place; and each answer carries a policy that keeps the page from reaching anything else. This module
// decides what an address gives and nothing else; main.js hands the answer to Electron.
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { ID } from './plugin-api.js';

export const SCHEME = 'tdt-plugin';
export const SDK_PATH = '/@tdt/sdk.js';
export const MAX_FILE = 8 * 1024 * 1024;

/**
 * What the page of a plugin may do. It can run its own scripts and styles and show its own images, fonts and sound, and nothing
 * else: no requests (the app makes them for it, with permission), no frames, no forms, no <base>, no plugins.
 */
export const POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const headers = (type) => ({
  'Content-Type': type,
  'Content-Security-Policy': POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  // the frame has no origin of its own (it is sandboxed), so its modules and fonts are cross-origin to it
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
});

const answer = (status, text) => ({ status, headers: headers('text/plain; charset=utf-8'), body: Buffer.from(text) });

/** The id and the path of a plugin address, or null if it is not one. */
export function parseAddress(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${SCHEME}:` || !ID.test(url.hostname)) return null;
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  return { id: url.hostname, path };
}

/**
 * The answer to one request. `lookup(id)` gives the plugin if it is running (approved, no problems) or null; `sdkFile` is the
 * path of the SDK. Only the files of a running plugin are served, from inside its folder, never the hidden ones.
 * @returns {{status: number, headers: object, body: Buffer}}
 */
export function servePlugin(rawUrl, { lookup, sdkFile, insideOf }) {
  const address = parseAddress(rawUrl);
  if (!address) return answer(400, 'dirección no válida');
  const plugin = lookup(address.id);
  if (!plugin) return answer(404, 'este plugin no está activado');
  if (address.path === SDK_PATH) return { status: 200, headers: headers(TYPES['.js']), body: readFileSync(sdkFile) };
  const wanted = address.path.replace(/^\/+/, '') || plugin.entry;
  if (wanted.split('/').some((part) => part.startsWith('.'))) return answer(404, 'no existe');
  const real = insideOf(plugin.dir, wanted);
  if (!real) return answer(404, 'no existe');
  const info = statSync(real);
  if (!info.isFile()) return answer(404, 'no existe');
  if (info.size > MAX_FILE) return answer(413, 'el archivo pesa demasiado');
  const type = TYPES[extname(real).toLowerCase()];
  if (!type) return answer(415, 'tipo de archivo no permitido');
  return { status: 200, headers: headers(type), body: readFileSync(real) };
}
