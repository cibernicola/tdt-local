// Plugins with permissions (api 1; docs/PLUGINS.md): the part that needs no Electron. A plugin is a folder with a `manifest.json`
// and an HTML page that runs in an isolated frame and talks to the app only through a small API; what it may ask of that API is
// what its manifest declares and the user granted. This module knows the manifest, the permissions, what the user is asked, the
// rules that decide whether a network request or a stored value is allowed, and nothing else.
//
//   { "name": "Mi plugin", "version": "1.0.0", "description": "...", "author": "...",
//     "tdt": { "api": 1, "entry": "index.html", "panel": { "width": 420, "height": 320 },  // or { "placement": "screen" }
//              "permissions": ["player.read", "storage", "network:api.open-meteo.com"] } }
import dns from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readSettings } from './plugin-config.js';
import { dirname, join } from 'node:path';

export const API_VERSION = 1;
/** The folder name is the id and is part of an address (host names are lowercase): lowercase, numbers and hyphens. */
export const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_PERMISSIONS = 12;
export const PANEL = { minWidth: 240, maxWidth: 800, minHeight: 160, maxHeight: 800, width: 420, height: 320 };

/** What each permission is, in the words the user reads when they are asked. */
export const PERMISSIONS = {
  'player.read': 'ver qué estás viendo: la lista, el canal de cada casilla, el volumen y el modo',
  'player.control': 'cambiar lo que ves: poner canales, cambiar de lista, el volumen, el silencio y la multivisión',
  'channels.read': 'buscar en la lista de canales y emisoras',
  'epg.read': 'leer la guía de programación',
  'ui.toast': 'mostrar avisos breves sobre la imagen',
  storage: 'guardar sus propios datos en tu equipo (hasta 256 KB)',
  'provide:epg': 'poner programas en la guía de los canales que ella misma aporta (títulos y horas que luego ves en la lista)',
  'provide:channels': 'añadir canales a tu lista (hasta 500): los enlaces que traiga se podrán abrir desde tu equipo, como los que añades tú',
};

/** How much a permission can do, for the question and the settings: low, medium or high (the same table as plugin-api.json). */
export const RISK = { 'player.read': 'medium', 'player.control': 'high', 'channels.read': 'medium', 'epg.read': 'medium', 'ui.toast': 'low', storage: 'low', 'provide:channels': 'high', 'provide:epg': 'medium' };
export const riskOf = (permission) => {
  const name = String(permission);
  if (name.startsWith('embed:')) return 'critical'; // a page of that server is shown inside TDT local, with its own scripts
  return name.startsWith('network:') ? 'high' : RISK[permission] || 'high';
};

const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const NOT_PUBLIC_NAME = /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/;

/**
 * One permission as the manifest writes it. `{name}` for the plain ones, `{network, host, wildcard}` for «network:host» and
 * `{problem}` for what cannot be. A host needs a dot and a letters-only ending, so IP addresses and `*.com` do not pass.
 */
export function parsePermission(raw) {
  if (typeof raw !== 'string') return { problem: 'un permiso tiene que ser texto' };
  if (Object.hasOwn(PERMISSIONS, raw)) return { name: raw };
  if (raw.startsWith('network:')) {
    const host = raw.slice(8);
    if (!HOST.test(host) || host.length > 120 || NOT_PUBLIC_NAME.test(host)) {
      return { problem: `«${raw.slice(0, 80)}»: el servidor tiene que ser un nombre público como api.ejemplo.com o *.ejemplo.com` };
    }
    return { network: true, host: host.replace(/^\*\./, ''), wildcard: host.startsWith('*.'), name: raw };
  }
  if (raw.startsWith('embed:')) {
    const host = raw.slice(6);
    if (!HOST.test(host) || host.startsWith('*.') || host.length > 120 || NOT_PUBLIC_NAME.test(host)) {
      return { problem: `«${raw.slice(0, 80)}»: el servidor tiene que ser un nombre público como player.ejemplo.tv (sin comodines)` };
    }
    return { embed: true, host, name: raw };
  }
  return { problem: `permiso desconocido: «${raw.slice(0, 60)}»` };
}

/** A permission in words. */
export function describePermission(permission) {
  const p = typeof permission === 'string' ? parsePermission(permission) : permission;
  if (p.problem) return p.problem;
  if (p.embed) return `mostrar dentro de una casilla el reproductor de ${p.host}: una página suya, con sus propios scripts, corre en tu ventana`;
  if (p.network) {
    return p.wildcard ? `hablar con cualquier subdominio de ${p.host} (solo por https)` : `hablar con ${p.host} (solo por https)`;
  }
  return PERMISSIONS[p.name];
}

/**
 * Add what an api-1 manifest says to `plugin` (an object made by readPlugin in plugins.js): kind, entry, panel, permissions and
 * the problems. A plugin with problems is listed so that the user sees why, and never runs. `insideOf(dir, file)` is the check
 * of plugins.js that a file exists and stays inside the folder.
 */
export const MAX_THEMES = 5;

/** The themes a manifest brings (`tdt.themes`): only the shape here; the page keeps just the variables it knows with values that are colours. */
export function readThemes(raw) {
  if (raw === undefined) return { list: [], problems: [] };
  if (!Array.isArray(raw) || raw.length > MAX_THEMES || raw.some((t) => !t || typeof t !== 'object' || Array.isArray(t) || typeof t.id !== 'string' || typeof t.name !== 'string' || !t.vars || typeof t.vars !== 'object')) {
    return { list: [], problems: [`«tdt.themes» es una lista de hasta ${MAX_THEMES} temas {id, name, vars: {"--accent": "#0d5662", …}}`] };
  }
  return { list: raw, problems: [] };
}

export const MAX_BROUGHT_RULES = 10;

/** The rules a manifest brings (`tdt.rules`): only the shape here (a list of objects); tdtlocal/rules.py checks every field and says what is wrong. */
export function readBroughtRules(raw) {
  if (raw === undefined) return { list: [], problems: [] };
  if (!Array.isArray(raw) || raw.length > MAX_BROUGHT_RULES || raw.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
    return { list: [], problems: [`«tdt.rules» es una lista de hasta ${MAX_BROUGHT_RULES} reglas (objetos {id, name, when, do})`] };
  }
  return { list: raw, problems: [] };
}

export const MAX_SOURCES = 5;
/** The control adapters a source may ask for (the core knows how to silence these players) and the only servers each one fits. */
export const CONTROLS = { youtube: ['www.youtube-nocookie.com', 'www.youtube.com'], atres: ['www.atresplayer.com'] };
const PLACE = /\{([1-3])\}/g;

/**
 * The playback sources a manifest declares (`tdt.sources`): a page address with up to three `{1}`..`{3}` holes, and the address of the embeddable
 * player to show for it, which can use the holes and `{parent}` (the host that shows it). No code: the page only fills in an address. The player's
 * server has to be one the plugin asked for with `embed:server`. ``{list, problems}``.
 */
export function readSources(raw, permissions) {
  if (raw === undefined) return { list: [], problems: [] };
  if (!Array.isArray(raw) || raw.length > MAX_SOURCES) return { list: [], problems: [`«tdt.sources» es una lista de hasta ${MAX_SOURCES} fuentes`] };
  const list = [];
  const problems = [];
  const allowed = new Set((permissions || []).map(parsePermission).filter((p) => p.embed).map((p) => p.host));
  raw.forEach((s, i) => {
    const at = `fuente ${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) { problems.push(`${at}: tiene que ser {name, match, embed}`); return; }
    const name = typeof s.name === 'string' ? s.name.trim().slice(0, 40) : '';
    let match;
    let embed;
    try {
      match = new URL(String(s.match).replace(PLACE, 'x'));
      embed = new URL(String(s.embed).replace(PLACE, 'x').replace('{parent}', 'x'));
    } catch {
      problems.push(`${at}: «match» y «embed» tienen que ser direcciones https`);
      return;
    }
    if (!name) problems.push(`${at}: falta «name»`);
    else if (match.protocol !== 'https:' || embed.protocol !== 'https:') problems.push(`${at}: solo https`);
    else if (String(s.match).length > 200 || String(s.embed).length > 400) problems.push(`${at}: direcciones demasiado largas`);
    else if (/^https:\/\/[^/?#]*[{}]/.test(String(s.match)) || /^https:\/\/[^/?#]*[{}]/.test(String(s.embed)) || /[{}]/.test(String(s.match).replace(PLACE, '')) || /[{}]/.test(String(s.embed).replace(PLACE, '').replace('{parent}', ''))) {
      problems.push(`${at}: los huecos son {1}, {2}, {3} (y {parent} en «embed»), y nunca en el servidor`);
    } else if (/\{parent\}/.test(String(s.embed).split('?')[0])) problems.push(`${at}: {parent} solo va después de «?»`);
    else if (!allowed.has(embed.hostname)) problems.push(`${at}: pide «embed:${embed.hostname}» en tdt.permissions para poder mostrar su reproductor`);
    else if (s.control !== undefined && !Object.hasOwn(CONTROLS, s.control)) problems.push(`${at}: «control» es ${Object.keys(CONTROLS).join(' o ')}`);
    else if (s.control !== undefined && !CONTROLS[s.control].includes(embed.hostname)) problems.push(`${at}: el control «${s.control}» solo vale con ${CONTROLS[s.control].join(' o ')}`);
    else list.push({ name, match: String(s.match), embed: String(s.embed), ...(s.control !== undefined ? { control: s.control } : {}) });
  });
  return { list, problems };
}

/** The servers whose players the plugins that run may show: the page adds them to the places it lets frame. */
export const embedHosts = (plugins, permissionsOf) => [...new Set(plugins.flatMap((p) => permissionsOf(p).map(parsePermission).filter((x) => x.embed).map((x) => x.host)))];

export const MAX_ACTIVATION = 8;
export const ACTIVATION = /^(onStartup|onEvent:[a-z]+(\.[a-z]+)?|onTime:([01]\d|2[0-3]):[0-5]\d)$/;

/** The «activation» a manifest declares: when a plugin without a panel has to run. ``{list, problems}``; an empty list means «always». */
export function readActivation(raw, hasPanel) {
  if (raw === undefined) return { list: [], problems: [] };
  if (!Array.isArray(raw) || raw.length > MAX_ACTIVATION) return { list: [], problems: [`«tdt.activation» es una lista de hasta ${MAX_ACTIVATION} entradas`] };
  const bad = raw.find((a) => typeof a !== 'string' || !ACTIVATION.test(a));
  if (bad !== undefined) return { list: [], problems: [`«tdt.activation»: «${String(bad).slice(0, 40)}» no vale; hay onStartup, onEvent:evento (channel.changed…) y onTime:HH:MM`] };
  if (raw.length && hasPanel) return { list: [], problems: ['«tdt.activation» solo vale para plugins sin panel: un panel se ve siempre'] };
  return { list: [...new Set(raw)], problems: [] };
}

export function readUiPlugin(manifest, dir, plugin, insideOf) {
  const tdt = manifest.tdt;
  plugin.kind = 'ui';
  plugin.api = tdt.api;
  plugin.author = String(manifest.author || '').slice(0, 120);
  plugin.homepage = /^https:\/\//.test(String(manifest.homepage || '')) ? String(manifest.homepage).slice(0, 200) : '';
  plugin.label = String(tdt.label || plugin.name).slice(0, 24);
  plugin.entry = '';
  plugin.panel = null;
  plugin.permissions = [];
  plugin.activation = [];
  plugin.sources = []; // players it can show in a tile (tdt.sources)
  plugin.themes = []; // colours it brings (tdt.themes)
  plugin.rules = []; // rules it brings, off until the user turns them on (tdt.rules)
  plugin.settings = {}; // what the user may choose (lib/plugin-config.js): a form generated from this
  if (tdt.api !== API_VERSION) plugin.problems.push(`«tdt.api» tiene que ser ${API_VERSION}`);
  if (!ID.test(plugin.id)) {
    plugin.problems.push('el nombre de la carpeta (el id) solo puede llevar minúsculas, números y guiones, y empezar por una letra o un número');
  }
  if (Array.isArray(manifest.content_scripts) && manifest.content_scripts.length) {
    plugin.problems.push('un plugin es de un tipo o de otro: no puede llevar «tdt.api» y «content_scripts»');
  }
  for (const key of ['permissions', 'host_permissions', 'optional_permissions', 'background', 'externally_connectable']) {
    if (manifest[key] !== undefined && !(Array.isArray(manifest[key]) && manifest[key].length === 0)) {
      plugin.problems.push(`«${key}» no se usa: los permisos van en «tdt.permissions»`);
    }
  }
  const entry = tdt.entry === undefined ? 'index.html' : tdt.entry;
  if (typeof entry !== 'string' || !/\.html?$/i.test(entry) || !insideOf(dir, entry)) {
    plugin.problems.push(`la página «${String(entry).slice(0, 60)}» (tdt.entry) no existe, está fuera de la carpeta o no es .html`);
  } else {
    plugin.entry = entry;
  }
  if (tdt.panel !== undefined && tdt.panel !== false) {
    const size = tdt.panel === true ? {} : tdt.panel;
    const placement = size && size.placement === undefined ? 'float' : size && size.placement;
    if (!size || typeof size !== 'object' || Array.isArray(size)) plugin.problems.push('«tdt.panel» tiene que ser true o {width, height, placement}');
    else if (placement !== 'float' && placement !== 'screen') plugin.problems.push('«tdt.panel.placement» tiene que ser "float" o "screen"');
    else {
      const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
      plugin.panel = {
        width: clamp(size.width, PANEL.minWidth, PANEL.maxWidth, PANEL.width),
        height: clamp(size.height, PANEL.minHeight, PANEL.maxHeight, PANEL.height),
        placement, // «screen»: over the picture of the player (the size is then the whole screen)
      };
    }
  }
  const activation = readActivation(tdt.activation, !!plugin.panel);
  plugin.activation = activation.list; // [] = it runs all the time; otherwise it sleeps until one of these happens
  plugin.problems.push(...activation.problems);
  const declared = readSettings(tdt.settings);
  plugin.settings = declared.fields;
  plugin.problems.push(...declared.problems);
  plugin.sourcesRaw = tdt.sources; // read below, once the permissions are known
  const asked = tdt.permissions === undefined ? [] : tdt.permissions;
  if (!Array.isArray(asked)) plugin.problems.push('«tdt.permissions» tiene que ser una lista');
  else if (asked.length > MAX_PERMISSIONS) plugin.problems.push(`demasiados permisos (hasta ${MAX_PERMISSIONS})`);
  else {
    for (const raw of asked) {
      const p = parsePermission(raw);
      if (p.problem) plugin.problems.push(p.problem);
      else if (!plugin.permissions.includes(p.name)) plugin.permissions.push(p.name);
    }
  }
  const sources = readSources(plugin.sourcesRaw, plugin.permissions);
  delete plugin.sourcesRaw;
  plugin.sources = sources.list;
  plugin.problems.push(...sources.problems);
  const themes = readThemes(tdt.themes);
  plugin.themes = themes.list;
  plugin.problems.push(...themes.problems);
  const brought = readBroughtRules(tdt.rules);
  plugin.rules = brought.list;
  plugin.problems.push(...brought.problems);
  return plugin;
}

/** What the user approves. A change in the permissions or in the panel changes it, so they are asked again; the code can change. */
export const signature = (plugin) => `${plugin.id}|${plugin.api}|${[...plugin.permissions].sort().join(',')}|${plugin.panel ? (plugin.panel.placement === 'screen' ? 'pantalla' : 'panel') : 'sin-panel'}`;

/** Is this plugin approved exactly as it is now, and without problems? */
export const isApproved = (plugin, approved) => plugin.kind === 'ui' && !plugin.problems.length && approved[plugin.id] === signature(plugin);

/** True if it was approved once with other permissions: it needs the user to look at it again. */
export const needsReapproval = (plugin, approved) => plugin.kind === 'ui' && !plugin.problems.length && plugin.id in approved && approved[plugin.id] !== signature(plugin);

/** The question the user answers to activate a plugin. */
export function activationQuestion(plugin) {
  const wants = plugin.permissions.length ? plugin.permissions.map((p) => `  • ${describePermission(p)}`).join('\n') : '  • nada más que mostrarse (no pide ningún permiso)';
  return {
    message: `Activar el plugin «${plugin.name}»`,
    detail:
      `${plugin.author ? `De ${plugin.author}. ` : ''}Versión ${plugin.version || '?'}.\n\n`
      + `Va a poder:\n${wants}\n\n`
      + (plugin.panel
        ? plugin.panel.placement === 'screen'
          ? 'Se abrirá sobre la pantalla del reproductor, con un botón propio de la aplicación para cerrarlo: puede tapar la imagen.\n\n'
          : 'Tendrá un panel propio en la ventana.\n\n'
        : 'No tiene panel: corre en segundo plano.\n\n')
      + 'Corre aislado: no ve el resto de la aplicación, ni tus archivos, ni internet salvo lo que figura arriba. '
      + 'Si una versión nueva pide más permisos, se te vuelve a preguntar.',
  };
}

function readState(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function readApproved(file) {
  const out = {};
  const approved = readState(file).approved;
  for (const [id, sig] of Object.entries(approved && typeof approved === 'object' ? approved : {})) {
    if (typeof sig === 'string') out[id] = sig;
  }
  return out;
}

/** The permissions the user turned off for each plugin, even though it declares them: `{id: ['network:a.com', ...]}`. */
export function readDenied(file) {
  const out = {};
  const denied = readState(file).denied;
  for (const [id, list] of Object.entries(denied && typeof denied === 'object' ? denied : {})) {
    if (Array.isArray(list)) out[id] = list.filter((x) => typeof x === 'string');
  }
  return out;
}

export function writeApproved(file, approved, denied = readDenied(file)) {
  mkdirSync(dirname(file), { recursive: true });
  const kept = Object.fromEntries(Object.entries(denied).filter(([, list]) => list.length));
  writeFileSync(file, JSON.stringify({ approved, denied: kept }, null, 2) + '\n', 'utf8');
}

/** What a plugin may do now: what it declares minus what the user turned off. */
export const effectivePermissions = (plugin, denied) => plugin.permissions.filter((p) => !((denied && denied[plugin.id]) || []).includes(p));

/** An error with a code a plugin can tell apart (the keys of `errors` in tdtlocal/static/plugin-api.json). */
export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The code that fits a message of the network layer, which speaks in sentences. */
export function codeOf(message) {
  const m = String(message);
  if (/^permiso denegado/.test(m)) return 'E_PERMISSION';
  if (/demasiadas peticiones/.test(m)) return 'E_RATE';
  if (/pesa más|pasaría de|demasiadas claves/.test(m)) return 'E_QUOTA';
  if (/solo se puede pedir por https|solo el puerto|sin usuario|dirección no válida|solo GET|cuerpo no permitido|la clave puede|no se puede guardar/.test(m)) return 'E_INVALID';
  return 'E_UNAVAILABLE';
}

// ----------------------------------------------------------------------------------------------------------- the network
/** Is this address one that is not the public internet (this machine, the local network, link-local, metadata)? */
export function isPrivateAddress(address) {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || a >= 224;
  }
  if (kind === 6) {
    const text = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (mapped) return isPrivateAddress(mapped[1]);
    return text === '::' || text === '::1' || /^f[cd]/.test(text) || /^fe[89ab]/.test(text) || text.startsWith('ff');
  }
  return true; // not an address at all: do not trust it
}

/** Does one of the `network:` permissions cover this host? */
export function networkAllows(permissions, host) {
  for (const raw of permissions) {
    const p = parsePermission(raw);
    if (!p.network) continue;
    // «*.x.com» are the subdomains only; the domain itself needs its own «network:x.com»
    if (p.wildcard ? host.endsWith(`.${p.host}`) : host === p.host) return true;
  }
  return false;
}

/**
 * May the plugin ask this address? Only https, port 443, no credentials, a host a permission covers, and only if every address it
 * resolves to is public. `resolve` is `async (host) => string[]`.
 * @returns {Promise<{ok: true, url: URL} | {ok: false, reason: string}>}
 */
export async function checkFetch(permissions, rawUrl, resolve) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'dirección no válida' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'solo se puede pedir por https' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'solo el puerto 443' };
  if (url.username || url.password) return { ok: false, reason: 'sin usuario ni clave en la dirección' };
  const host = url.hostname.toLowerCase();
  if (!networkAllows(permissions, host)) return { ok: false, reason: `permiso denegado: network:${host}` };
  let addresses;
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: false, reason: `no se encuentra ${host}` };
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) return { ok: false, reason: `${host} no es una dirección pública` };
  return { ok: true, url };
}

const FETCH = { redirects: 3, bodyIn: 100_000, bodyOut: 1_000_000, timeoutMs: 15_000, headers: ['accept', 'accept-language', 'content-type'] };

/**
 * One https request whose connection is made only to public addresses: the name is resolved again here and every address is
 * checked at the moment of connecting, so a name that answers something else a second time (DNS rebinding) leads nowhere.
 * It does not follow redirects; the caller does, checking each one.
 */
export function safeRequest(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const lookup = (host, options, done) => {
      dns.lookup(host, { all: true }, (error, addresses) => {
        if (error) return done(error);
        if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) return done(new Error(`${host} no es una dirección pública`));
        return options && options.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family);
      });
    };
    const request = https.request(url, { method, signal, lookup, headers: { 'User-Agent': 'TDT-local-plugin/1', ...headers } }, (res) => {
      const header = (name) => {
        const value = res.headers[String(name).toLowerCase()];
        return (Array.isArray(value) ? value[0] : value) ?? null;
      };
      resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: { get: header }, body: res });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/**
 * A request for a plugin: the ones its permissions allow, following up to 3 redirects only to hosts they also allow, with a
 * short list of headers, a body of 100 KB at most and an answer of 1 MB at most.
 * @returns {Promise<{status: number, ok: boolean, url: string, contentType: string, text: string}>} (throws Error with a reason)
 */
export async function pluginFetch(permissions, rawUrl, init, { resolve = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address), fetchImpl = safeRequest } = {}) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw new ApiError('E_INVALID', 'solo GET y POST');
  const headers = {};
  for (const [key, value] of Object.entries((init && init.headers) || {})) {
    if (FETCH.headers.includes(key.toLowerCase()) && typeof value === 'string' && value.length < 300) headers[key] = value;
  }
  const body = init && init.body !== undefined ? String(init.body) : undefined;
  if (body !== undefined && (method !== 'POST' || Buffer.byteLength(body) > FETCH.bodyIn)) throw new ApiError('E_INVALID', 'cuerpo no permitido (solo POST, hasta 100 KB)');
  let target = rawUrl;
  for (let hop = 0; hop <= FETCH.redirects; hop++) {
    const check = await checkFetch(permissions, target, resolve);
    if (!check.ok) throw new ApiError(codeOf(check.reason), check.reason);
    const response = await fetchImpl(check.url, { method: hop ? 'GET' : method, headers, body: hop ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(FETCH.timeoutMs) });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      target = new URL(response.headers.get('location'), check.url).href;
      continue;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > FETCH.bodyOut) {
        if (response.body && response.body.destroy) response.body.destroy();
        throw new ApiError('E_QUOTA', 'la respuesta pesa más de 1 MB');
      }
      chunks.push(chunk);
    }
    return {
      status: response.status, ok: response.ok, url: check.url.href, contentType: String(response.headers.get('content-type') || '').slice(0, 120),
      text: Buffer.concat(chunks).toString('utf8'),
    };
  }
  throw new ApiError('E_UNAVAILABLE', 'demasiadas redirecciones');
}

// ---------------------------------------------------------------------------------------------------------- the storage
export const STORAGE = { key: /^[\w.-]{1,64}$/, value: 65_536, total: 262_144, keys: 200 };

/**
 * A file of JSON per plugin in `dir`, with limits so that one plugin cannot fill the disk. What is read stays in memory and what is
 * written goes to the disk a moment later (`delayMs`, 0 to write at once), so a plugin that saves often does not hammer it: measured,
 * a write that rewrote the whole file each time cost 3.4 ms. `flush()` writes what is pending (the app calls it when it quits).
 */
export function createPluginStorage(dir, { delayMs = 500 } = {}) {
  const fileOf = (id) => join(dir, `${id}.json`);
  const cache = new Map(); // id -> data
  const dirty = new Set();
  let timer = null;
  const load = (id) => {
    if (cache.has(id)) return cache.get(id);
    let data = {};
    try {
      const parsed = JSON.parse(readFileSync(fileOf(id), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch { /* nothing saved yet, or damaged: start empty */ }
    cache.set(id, data);
    return data;
  };
  const write = (id) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(fileOf(id), JSON.stringify(cache.get(id)), 'utf8');
  };
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    for (const id of dirty) {
      try { write(id); } catch { /* the disk is full or gone: the data stays in memory until the next try */ continue; }
      dirty.delete(id);
    }
  };
  const changed = (id) => {
    dirty.add(id);
    if (delayMs <= 0) flush();
    else if (!timer) {
      timer = setTimeout(flush, delayMs);
      if (timer.unref) timer.unref();
    }
  };
  return {
    get: (id, key) => (STORAGE.key.test(String(key)) ? (load(id)[key] ?? null) : null),
    keys: (id) => Object.keys(load(id)).sort(),
    set(id, key, value) {
      if (!STORAGE.key.test(String(key))) throw new ApiError('E_INVALID', 'la clave puede llevar letras, números, punto, guion y guion bajo (hasta 64)');
      const text = JSON.stringify(value);
      if (text === undefined) throw new ApiError('E_INVALID', 'el valor no se puede guardar (¿undefined o una función?)');
      if (Buffer.byteLength(text) > STORAGE.value) throw new ApiError('E_QUOTA', `el valor pesa más de ${STORAGE.value / 1024} KB`);
      const data = load(id);
      const next = { ...data, [key]: JSON.parse(text) }; // what is kept is a copy: the caller cannot change it afterwards
      if (Object.keys(next).length > STORAGE.keys) throw new ApiError('E_QUOTA', `demasiadas claves (hasta ${STORAGE.keys})`);
      if (Buffer.byteLength(JSON.stringify(next)) > STORAGE.total) throw new ApiError('E_QUOTA', `el almacenamiento pasaría de ${STORAGE.total / 1024} KB`);
      cache.set(id, next);
      changed(id);
      return true;
    },
    remove(id, key) {
      const data = load(id);
      const had = Object.hasOwn(data, key);
      if (had) {
        const { [key]: _gone, ...rest } = data;
        cache.set(id, rest);
        changed(id);
      }
      return had;
    },
    exists: (id) => cache.has(id) || existsSync(fileOf(id)),
    /** How much a plugin keeps: bytes of JSON and number of keys (for the settings and the MCP). */
    usage: (id) => ({ bytes: Buffer.byteLength(JSON.stringify(load(id))), keys: Object.keys(load(id)).length }),
    flush,
  };
}
