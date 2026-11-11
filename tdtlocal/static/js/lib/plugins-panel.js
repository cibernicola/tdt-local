// The "Plugins" tab of the settings, which only exists in the desktop app. What the app says about each plugin
// (desktop/main.js: pluginList) becomes the text the panel shows.

/** The sites a plugin acts on, as people say them: `www.atresplayer.com`, not `https://www.atresplayer.com/embed/live/*`. */
export function hostsOf(patterns) {
  const hosts = [];
  for (const pattern of patterns || []) {
    const m = /^(?:https?|\*):\/\/([^/]+)\//.exec(String(pattern));
    if (m && !hosts.includes(m[1])) hosts.push(m[1]);
  }
  return hosts;
}

/**
 * @param {{name: string, version: string, description: string, source: string, sites: string[], problems: string[], enabled: boolean}} plugin
 */
export function describePlugin(plugin) {
  const usable = !plugin.problems.length;
  const hosts = hostsOf(plugin.sites);
  const ui = plugin.kind === 'ui';
  const full = plugin.kind === 'full'; // all the power: it runs inside the page, without isolation (docs/HACKEABLE.md)
  const theme = full && Array.isArray(plugin.scopes) && plugin.scopes.includes('css') && !plugin.scopes.includes('page'); // only a style sheet: docs/TEMAS.md
  const asks = ui ? plugin.permissions || [] : [];
  return {
    title: plugin.name + (plugin.version ? ' ' + plugin.version : ''),
    description: plugin.description,
    usable,
    on: usable && plugin.enabled,
    acts: hosts.length ? 'Actúa solo en: ' + hosts.join(', ') + '.' : '',
    source: plugin.source ? 'Viene de: ' + plugin.source + '.' : '',
    author: (ui || full) && plugin.author ? 'De ' + plugin.author + '.' : '',
    power: !full
      ? ''
      : theme
        ? 'Tema: cambia el aspecto con una hoja de estilo; no ejecuta código.' + (plugin.hash ? ' Aprobado: huella ' + plugin.hash + '.' : '')
        : 'Sin aislar: corre dentro de la página y puede hacer todo lo que hace la aplicación, sin permisos que lo limiten.' + (plugin.hash ? ' Código aprobado: huella ' + plugin.hash + '.' : ''),
    permissions: ui
      ? asks.length ? ['Pide permiso para:', ...asks.map((p) => '· ' + p.text)] : ['No pide ningún permiso.']
      : [],
    screen: ui && plugin.screen ? 'Se abre sobre la pantalla del reproductor.' : '',
    renewal: ui && plugin.needsApproval
      ? 'Ha cambiado lo que pide desde que lo activaste: al activarlo se te volverá a preguntar.'
      : full && plugin.needsApproval
        ? (theme ? 'Su hoja de estilo ha cambiado desde que lo activaste: no se aplica hasta que lo actives otra vez y la veas.' : 'Su código ha cambiado desde que lo activaste: no corre hasta que lo actives otra vez y veas el código nuevo.')
        : '',
    needsReload: !ui && !full, // a script is injected when the page loads; a plugin with permissions appears or goes away at once, and one with all the power reloads the page itself
    problems: plugin.problems,
  };
}

export const RISK_TEXT = { low: 'riesgo bajo', medium: 'riesgo medio', high: 'riesgo alto', critical: 'riesgo crítico' };
const STATE_TEXT = {
  running: 'en marcha',
  starting: 'arrancando',
  unresponsive: '⚠ no responde (se ha colgado, ha caído o no arrancó)',
  stopped: 'parado',
  waiting: 'dormido, a la espera de su momento',
  'over-limit': '⚠ parado por pasarse de memoria o procesador (pulsa Recargar para arrancarlo)',
};

/** The permissions of a plugin with permissions as rows the user can turn on and off: what it does, how risky, and whether it may. */
export function permissionRows(plugin) {
  return (plugin.permissions || []).map((p) => ({
    name: p.name, text: p.text, granted: p.granted !== false, risk: p.risk || 'high', riskText: RISK_TEXT[p.risk] || RISK_TEXT.high,
  }));
}

/**
 * What the user typed in the field of a setting a plugin declares, as the value the app expects: a number for a number, true or false for a
 * box. ``{ok: true, value}``, or ``{ok: false, error}`` in words when it cannot be (an empty or odd number). The app checks the limits
 * again; this only turns what a form gives into the right type.
 */
export function settingValue(field, raw) {
  if (field.type === 'boolean') return { ok: true, value: raw === true };
  if (field.type === 'number') {
    const text = String(raw).trim().replace(',', '.');
    const value = Number(text);
    if (!text || !Number.isFinite(value)) return { ok: false, error: `«${field.label}» necesita un número` };
    return { ok: true, value };
  }
  return { ok: true, value: String(raw) };
}

/** The line under a setting that says what it accepts. */
export function settingHint(field) {
  const parts = [];
  if (field.help) parts.push(field.help);
  if (field.type === 'number') parts.push(`de ${field.min} a ${field.max}`);
  if (field.type === 'string') parts.push(`hasta ${field.maxLength} caracteres`);
  return parts.join(' · ');
}

/** What the list of a catalog says about an entry, and what its button does: ``{line, button, enabled}``. */
export function describeCatalogEntry(e) {
  const who = [e.author && 'de ' + e.author, e.version && 'versión ' + e.version].filter(Boolean).join(' · ');
  const asks = e.permissions && e.permissions.length ? 'Dice que pedirá: ' + e.permissions.join(', ') + ' (se comprueba al descargarlo).' : 'Dice que no pide permisos (se comprueba al descargarlo).';
  const state = {
    new: { button: 'Instalar', enabled: true },
    update: { button: `Actualizar (tienes la ${e.installedVersion || '?'})`, enabled: true },
    installed: { button: 'Instalado', enabled: false },
  }[e.state] || { button: 'Instalar', enabled: true };
  const signed = e.fingerprint ? `Firmado con la clave ${e.fingerprint}.` : 'Sin firma de autor.';
  return { line: [who, e.description, asks, signed].filter(Boolean).join(' — '), ...state };
}

export const ONLINE_INTRO = 'Un plugin puede instalarse desde un enlace https a su archivo .tdtplugin, o desde un catálogo: un índice (index.json) que alguien publica con '
  + 'sus plugins y el SHA-256 de cada archivo. Nada se descarga hasta que lo pides, el archivo se descarga solo de servidores públicos y se te enseña lo mismo que con un archivo '
  + '(permisos, SHA-256 y de dónde viene) antes de instalarlo. Instalar no activa. Si das el SHA-256 que publica su autor, un archivo distinto se rechaza.';

const kb = (bytes) => (bytes < 1024 ? bytes + ' B' : Math.round(bytes / 102.4) / 10 + ' KB');

/**
 * How a running plugin is doing, in two lines: the state of its frame and what it has done. `runtime` is what the page knows (state, calls,
 * errors, restarts) and `activity` what the app knows (network and saved data); either can be missing.
 */
export function describeRuntime(runtime, activity) {
  if (!runtime) return { state: 'parado', health: 'stopped', activity: '' };
  const parts = [];
  if (runtime.memoryMB !== null && runtime.memoryMB !== undefined) parts.push(`${runtime.memoryMB} MB` + (runtime.cpuPercent ? ` · ${runtime.cpuPercent} % de procesador` : ''));
  if (runtime.calls) parts.push(runtime.calls + (runtime.calls === 1 ? ' llamada' : ' llamadas'));
  if (runtime.errors) parts.push(runtime.errors + (runtime.errors === 1 ? ' error' : ' errores'));
  if (runtime.denied) parts.push(runtime.denied + ' sin permiso');
  if (runtime.limited) parts.push(runtime.limited + ' frenadas por ritmo');
  if (runtime.restarts) parts.push(runtime.restarts + (runtime.restarts === 1 ? ' reinicio' : ' reinicios'));
  if (activity && activity.fetches) parts.push('red: ' + activity.fetches + (activity.fetches === 1 ? ' petición' : ' peticiones') + ' (' + kb(activity.bytesIn) + ')' + (activity.hosts && activity.hosts.length ? ' a ' + activity.hosts.join(', ') : ''));
  if (activity && activity.storage && activity.storage.keys) parts.push('guarda ' + kb(activity.storage.bytes) + ' en ' + activity.storage.keys + (activity.storage.keys === 1 ? ' clave' : ' claves'));
  return { state: STATE_TEXT[runtime.state] || runtime.state, health: runtime.state, activity: parts.join(' · ') };
}

export function summarize(plugins) {
  if (!plugins.length) return 'No hay ningún plugin.';
  const on = plugins.filter((p) => p.enabled && !p.problems.length).length;
  const word = plugins.length === 1 ? '1 plugin' : plugins.length + ' plugins';
  return word + (on ? ', ' + (on === 1 ? '1 activado' : on + ' activados') : ', ninguno activado') + '.';
}

export const PLUGINS_INTRO = 'Un plugin es una carpeta con un manifest.json. Los hay de tres clases: los que traen un panel o '
  + 'un servicio propio (corren aislados y solo pueden lo que declaran en «permisos»: al activarlos se te enseña la lista y '
  + 'eliges tú) y los de scripts, que se ejecutan dentro de las páginas que declaran (por ejemplo el reproductor incrustado '
  + 'de un canal) y no piden permisos, y los «con todo el poder», que corren dentro de la propia página sin aislar y pueden cambiar lo que hace la aplicación (si solo traen una hoja de estilo son un tema, y no ejecutan código): '
  + 'al activarlos se te enseña su código, y si cambia una letra se te vuelve a preguntar. Todos empiezan desactivados. Cómo hacer uno: docs/PLUGINS.md y docs/HACKEABLE.md.';

/** Said in this tab when the app has development plugins: they are not in this list, and that is not obvious. */
export const DEV_POINTER = 'Los plugins de desarrollo (los que escribes tú, o una IA, y que corren sin aislamiento) no salen en '
  + 'esta lista: están en la pestaña «Desarrollo».';
