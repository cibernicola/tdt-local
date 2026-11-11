// Installing a plugin from the internet: a link to a `.tdtplugin`, or a catalog (a small `index.json` somebody publishes) that lists them.
// What comes in is treated like a file the user picked: it is downloaded, inspected and shown with its permissions and its SHA-256, and only
// installed (never activated) if the user says yes. Pure functions plus a download that only talks to public servers over https.
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { ID, isPrivateAddress, safeRequest } from './plugin-api.js';
import { fingerprintOf, parseSignature } from './plugin-sign.js';

export const LIMITS = { redirects: 3, packageBytes: 16 * 1024 * 1024, catalogBytes: 1_000_000, timeoutMs: 30_000, entries: 200 };
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const NOT_PUBLIC_NAME = /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/;
const SHA = /^[0-9a-f]{64}$/;

/** May this link be fetched? Only https, port 443, no credentials, a public-looking name (no IP addresses). ``{ok, url}`` or ``{ok: false, reason}``. */
export function checkLink(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return { ok: false, reason: 'no es una dirección' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'solo se descarga por https' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'solo el puerto 443' };
  if (url.username || url.password) return { ok: false, reason: 'sin usuario ni clave en la dirección' };
  const host = url.hostname.toLowerCase();
  if (!HOST.test(host) || NOT_PUBLIC_NAME.test(host)) return { ok: false, reason: 'el servidor tiene que ser un nombre público (no una dirección IP ni de tu red)' };
  if (url.href.length > 600) return { ok: false, reason: 'la dirección es demasiado larga' };
  return { ok: true, url };
}

/** The SHA-256 a person typed or a catalog gave, in lowercase, or ``null`` if it is not 64 hex digits (spaces and colons are ignored). */
export function cleanSha(raw) {
  const text = String(raw || '').replace(/[\s:]/g, '').toLowerCase();
  return SHA.test(text) ? text : null;
}

export const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Download ``rawUrl`` (at most ``maxBytes``), following up to 3 redirects and checking each one with ``checkLink``; the connection itself is only made to
 * public addresses (``safeRequest``). Throws ``Error`` with a reason in words. ``fetchImpl`` and ``resolve`` are for tests.
 * @returns {Promise<{url: string, buffer: Buffer}>}
 */
export async function download(rawUrl, { maxBytes = LIMITS.packageBytes, fetchImpl = safeRequest, resolve = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address) } = {}) {
  let target = rawUrl;
  for (let hop = 0; hop <= LIMITS.redirects; hop += 1) {
    const check = checkLink(target);
    if (!check.ok) throw new Error(check.reason);
    let addresses;
    try {
      addresses = await resolve(check.url.hostname);
    } catch {
      throw new Error(`no se encuentra ${check.url.hostname}`);
    }
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error(`${check.url.hostname} no es una dirección pública`);
    let response;
    try {
      response = await fetchImpl(check.url, { method: 'GET', headers: { Accept: '*/*' }, signal: AbortSignal.timeout(LIMITS.timeoutMs) });
    } catch (error) {
      // a network error often has no message of its own (an AggregateError, a reset): say where and why, in words
      const why = (error && (error.code || (error.errors && error.errors[0] && error.errors[0].code))) || (error && error.name) || '';
      throw new Error(`no se pudo conectar con ${check.url.hostname}${why ? ` (${why})` : ''}${error && error.message ? ': ' + error.message : ''}`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      target = new URL(response.headers.get('location'), check.url).href;
      continue;
    }
    if (!response.ok) throw new Error(`el servidor contestó ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > maxBytes) {
        if (response.body && response.body.destroy) response.body.destroy();
        throw new Error(`el archivo pesa más de ${maxBytes >= 1024 * 1024 ? `${Math.round((maxBytes / 1024 / 1024) * 10) / 10} MB` : `${Math.round(maxBytes / 102.4) / 10} KB`}`);
      }
      chunks.push(chunk);
    }
    return { url: check.url.href, buffer: Buffer.concat(chunks) };
  }
  throw new Error('demasiadas redirecciones');
}

const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

/**
 * A catalog as published (``{"plugins": [{id, name, author, version, description, url, sha256, permissions}]}``), cleaned: ``{entries, problems}``.
 * Every entry needs an id, a name, an https link and a **SHA-256**: the catalog pins the file, and a download that does not match is refused. What the
 * entry says about its permissions is only a hint: the ones that count are read from the package, and shown, before anything is installed.
 */
export function readCatalog(json) {
  const entries = [];
  const problems = [];
  const list = json && typeof json === 'object' && Array.isArray(json.plugins) ? json.plugins : null;
  if (!list) return { entries, problems: ['el catálogo tiene que ser {"plugins": [...]}'] };
  if (list.length > LIMITS.entries) problems.push(`el catálogo pasa de ${LIMITS.entries} plugins: solo se leen los primeros`);
  const seen = new Set();
  list.slice(0, LIMITS.entries).forEach((item, i) => {
    const at = `plugin ${i + 1}`;
    if (!item || typeof item !== 'object') { problems.push(`${at}: no es un objeto`); return; }
    const sha = cleanSha(item.sha256);
    const link = checkLink(item.url);
    if (!ID.test(String(item.id))) problems.push(`${at}: «id» no vale (minúsculas, números y guiones)`);
    else if (seen.has(item.id)) problems.push(`${at}: «${item.id}» está repetido`);
    else if (!text(item.name, 60)) problems.push(`${at} («${item.id}»): falta «name»`);
    else if (!link.ok) problems.push(`${at} («${item.id}»): enlace no válido (${link.reason})`);
    else if (!sha) problems.push(`${at} («${item.id}»): falta «sha256» (64 cifras hexadecimales)`);
    else {
      seen.add(item.id);
      const signature = item.signature === undefined ? null : parseSignature(item.signature); // the author's signature of the file, if the catalog carries it
      if (item.signature !== undefined && !signature) problems.push(`${at} («${item.id}»): la firma no tiene el formato esperado y se ignora`);
      entries.push({
        signature, fingerprint: signature ? fingerprintOf(signature.key) : '',
        id: item.id, name: text(item.name, 60), author: text(item.author, 60), version: text(item.version, 20), description: text(item.description, 200),
        url: link.url.href, sha256: sha, permissions: (Array.isArray(item.permissions) ? item.permissions : []).filter((p) => typeof p === 'string').map((p) => text(p, 80)).slice(0, 12),
      });
    }
  });
  return { entries, problems };
}

/** What the catalog says about each entry against what is installed: «new», «installed» or «update» (another version). */
export function withInstalled(entries, plugins) {
  return entries.map((e) => {
    const have = plugins.find((p) => p.id === e.id);
    return { ...e, state: !have ? 'new' : String(have.version || '') === e.version ? 'installed' : 'update', installedVersion: have ? String(have.version || '') : '' };
  });
}
