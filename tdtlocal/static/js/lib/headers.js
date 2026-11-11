// The dialog of the request headers of a channel (docs/HACER-PLUGINS.md does not need it: this is the user's own, in the settings of a
// channel). Pure functions: the rows of the form, what changed, and what is wrong. The module that talks to the server is ../headers.js.

/** Headers some providers check before serving a stream. They are sent by the proxy, nothing more. */
export const ATRES_HEADERS = { Origin: 'https://www.atresplayer.com', Referer: 'https://www.atresplayer.com/directos/lasexta/' };

export const MAX_HEADERS = 8;
export const MAX_VALUE = 600;
const NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,40}$/;
const PLAIN = ['origin', 'referer', 'user-agent'];
const FORBIDDEN = new Set(['host', 'connection', 'keep-alive', 'content-length', 'content-type', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'expect', 'range', 'if-range', 'accept-encoding', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection']);

export const HEADERS_INTRO = 'Cabeceras que el proxy de TDT local manda al servidor del canal con cada petición (la lista y sus segmentos). '
  + 'No cambian nada por defecto: un canal no lleva ninguna hasta que las pones tú. Origin, Referer y User-Agent van a todos los servidores del '
  + 'canal; cualquier otra (una cookie, un token) va solo a los servidores de sus enlaces y no sigue una redirección a otro. Su valor se guarda '
  + 'en tu equipo y no vuelve a esta pantalla: puedes sustituirlo o quitarlo. No se salta DRM ni geobloqueos: solo manda lo que escribas aquí.';

export const isPlain = (name) => PLAIN.includes(String(name).toLowerCase());

/** The rows of the form from what the server says (`GET /api/headers`): a credential has no value to show. */
export function rowsFrom(described) {
  return (described || []).map((h) => ({ name: h.name, value: h.secret ? '' : String(h.value ?? ''), secret: !!h.secret }));
}

/** A problem with the rows of the form, in words, or `''`. */
export function problemIn(rows) {
  const seen = new Set();
  const filled = rows.filter((r) => r.name.trim() || r.value.trim());
  if (filled.length > MAX_HEADERS) return `hasta ${MAX_HEADERS} cabeceras por canal`;
  for (const r of filled) {
    const name = r.name.trim();
    if (!NAME.test(name)) return `«${name.slice(0, 40)}» no es un nombre de cabecera válido (letras, números y -_.; hasta 40 caracteres)`;
    if (FORBIDDEN.has(name.toLowerCase()) || /^(sec|proxy)-/i.test(name)) return `la cabecera «${name}» la pone el propio programa y no se puede cambiar`;
    if (seen.has(name.toLowerCase())) return `«${name}» está repetida`;
    seen.add(name.toLowerCase());
    if (r.value.length > MAX_VALUE) return `el valor de «${name}» pasa de ${MAX_VALUE} caracteres`;
    if (/[\u0000-\u001f\u007f]/.test(r.value)) return `el valor de «${name}» no puede llevar saltos de línea`;
    if (!r.value.trim() && !(r.secret && r.keep)) return `«${name}» necesita un valor (para quitarla, quita la fila)`;
  }
  return '';
}

/**
 * What to send to change `original` (the rows the form opened with) into `rows` (what it has now): `{name: value}` sets one and `{name: null}`
 * removes one. A credential row left empty is not touched (its value never came to the page), and a renamed one needs its value again.
 */
export function changesFrom(original, rows) {
  const before = new Map((original || []).map((r) => [r.name.toLowerCase(), r]));
  const now = new Map();
  for (const r of rows) {
    const name = r.name.trim();
    if (name) now.set(name.toLowerCase(), { ...r, name, value: r.value.trim() });
  }
  const changes = {};
  for (const [key, old] of before) if (!now.has(key)) changes[old.name] = null;
  for (const [key, row] of now) {
    const old = before.get(key);
    if (old && old.secret && !row.value) continue; // kept as it is
    if (old && !old.secret && old.value === row.value && old.name === row.name) continue;
    if (old && old.name !== row.name) changes[old.name] = null; // a change of case: the old name goes, the new one comes
    changes[row.name] = row.value;
  }
  return changes;
}

/** Rows marked as the credentials they hold, so the form can say «guardado» instead of showing nothing. */
export const withKeep = (rows) => rows.map((r) => ({ ...r, keep: r.secret }));
