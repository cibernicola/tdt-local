// The settings dialog ("Ajustes"): assistant, live subtitles (Whisper, with model download) and lists/guide.
// What is shown is described in lib/settings-form.js; everything is validated and saved by the server.
import { requestJson } from './api.js';
import { $, el } from './dom.js';
import { CONTROL_INTRO, describeControl, describeUse } from './lib/control.js';
import { DEV_INTRO, describeDevPlugin, summarizeDev } from './lib/dev-panel.js';
import { LOGS_INTRO, MODES, filterLines, summarize as summarizeLogs } from './lib/logs-panel.js';
import {
  DEV_POINTER, ONLINE_INTRO, PLUGINS_INTRO, describeCatalogEntry, describePlugin, describeRuntime, permissionRows, settingHint, settingValue, summarize,
} from './lib/plugins-panel.js';
import { pluginHost } from './plugin-host.js';
import { inspectorButton } from './inspector.js';
import { themeControl } from './themes.js';
import {
  FIELDS, TABS, collectChanges, describeDiagnosis, describeDownload, fieldsOf, formatBytes, percent,
} from './lib/settings-form.js';

const POLL_MS = 700;
const inputs = new Map(); // setting name -> its input element
let snapshot = null; // last /api/settings answer
let hooks = null;
let pollTimer = null;
let removeKey = null; // the "remove saved key" checkbox

// only the desktop app has window.tdtDesktop; in a browser the settings have no «Plugins» tab
const desktop = () => (typeof window !== 'undefined' && window.tdtDesktop && window.tdtDesktop.plugins) || null;
const desktopLogs = () => (typeof window !== 'undefined' && window.tdtDesktop && window.tdtDesktop.logs) || null;
const desktopDev = () => (typeof window !== 'undefined' && window.tdtDesktop && window.tdtDesktop.dev) || null;
const tabsShown = () => (desktop()
  ? [...TABS, { id: 'plugins', label: 'Plugins' }, ...(desktopLogs() ? [{ id: 'logs', label: 'Registro' }] : []),
    ...(desktopDev() ? [{ id: 'dev', label: 'Desarrollo' }] : [])]
  : TABS);

const dlg = () => $('setDlg');
const say = (text, bad = false) => {
  const n = $('setMsg');
  n.textContent = text;
  n.classList.toggle('ok', !!text && !bad);
};

/* ------------------------------------------------------------ building the form */
function fieldNode(f) {
  const wrap = el('div', 'field');
  let input;
  if (f.type === 'bool') {
    input = el('input');
    input.type = 'checkbox';
    const label = el('label', 'chk');
    label.append(input, document.createTextNode(' ' + f.label));
    wrap.append(label);
  } else {
    const label = el('label');
    label.append(el('span', '', f.label));
    if (f.type === 'select') {
      input = el('select');
      for (const [value, text] of Object.entries(f.options)) input.append(new Option(text, value));
    } else if (f.type === 'json') {
      input = el('textarea');
      input.rows = 3;
      input.spellcheck = false;
    } else {
      input = el('input');
      input.type = f.type === 'number' ? 'number' : f.type === 'secret' ? 'password' : 'text';
      if (f.type === 'number') input.step = String(f.step || 1);
      if (f.type === 'secret') input.autocomplete = 'new-password';
      if (f.list) input.setAttribute('list', f.list);
      input.spellcheck = false;
    }
    label.append(input);
    wrap.append(label);
  }
  input.id = 'set_' + f.name;
  inputs.set(f.name, input);
  if (f.hint) wrap.append(el('p', 'dlg-hint', f.hint));
  if (f.type === 'secret') {
    const chk = el('label', 'chk');
    removeKey = el('input');
    removeKey.type = 'checkbox';
    chk.append(removeKey, document.createTextNode(' Quitar la clave guardada'));
    chk.hidden = true;
    wrap.append(chk);
    wrap.secretRow = chk;
  }
  wrap.append(el('p', 'field-error'));
  if (f.test) wrap.append(testBlock(f.test));
  return wrap;
}

function testBlock(kind) {
  const box = el('div', 'test');
  const button = el('button', 'btn', kind === 'ai' ? 'Probar conexión y listar modelos' : 'Comprobar');
  button.type = 'button';
  const result = el('div', 'test-result');
  result.setAttribute('role', 'status');
  const test = { ai: testAssistant, web: testWeb, stt: testWhisper }[kind];
  button.addEventListener('click', () => test(button, result));
  box.append(button, result);
  return box;
}

function modelsBlock() {
  const box = el('div', 'models');
  box.append(el('h4', '', 'Modelos de Whisper'));
  const installed = el('ul', 'models-installed');
  installed.id = 'modelsInstalled';
  const pick = el('label');
  pick.append(el('span', '', 'Descargar un modelo'));
  const select = el('select');
  select.id = 'modelCatalog';
  pick.append(select);
  const row = el('div', 'models-actions');
  const go = el('button', 'btn', 'Descargar');
  go.type = 'button';
  go.id = 'modelGo';
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.type = 'button';
  cancel.id = 'modelCancel';
  cancel.hidden = true;
  row.append(go, cancel);
  const progress = el('progress');
  progress.id = 'modelProgress';
  progress.max = 100;
  progress.hidden = true;
  const status = el('p', 'dlg-hint');
  status.id = 'modelStatus';
  status.setAttribute('role', 'status');
  const where = el('p', 'dlg-hint');
  where.id = 'modelsWhere';
  box.append(installed, pick, row, progress, status, where);
  go.addEventListener('click', startDownload);
  cancel.addEventListener('click', () => requestJson('/api/whisper/download/cancel', 'POST', {}));
  return box;
}

function helpBlock() {
  const p = el('p', 'dlg-hint');
  p.append('Whisper necesita ', link('https://ffmpeg.org', 'ffmpeg'), ' en el PATH y el programa ',
    link('https://github.com/ggml-org/whisper.cpp', 'whisper.cpp'),
    ' (whisper-server). El audio se transcribe en tu equipo y no sale de él.');
  return p;
}

function scteHelp() {
  const box = el('div', 'scte-help');
  box.append(el('p', 'dlg-hint', 'SCTE-35 es la señal con la que una cadena marca dónde empieza y acaba la publicidad. '
    + 'TDT local la busca en las listas de reproducción (y, si lo activas, dentro del vídeo) y guarda cada hallazgo en un '
    + 'registro local, scte.jsonl, en la carpeta de datos. No salta ni bloquea nada: solo avisa y guarda.'));
  const open = el('button', 'btn', 'Ver el registro de marcas…');
  open.type = 'button';
  open.addEventListener('click', () => { dlg().close(); hooks.openScte(); });
  box.append(open);
  return box;
}

function adsHelp() {
  return el('p', 'dlg-hint', 'Lo que hace la página mientras el canal que ves está en una pausa de anuncios. Para canales con '
    + 'stream necesita la vigilancia de marcas (pestaña anterior) y que el canal envíe la marca (muchos no lo hacen). Para los '
    + 'de Atresmedia con su reproductor incrustado necesita el puente de tools/puente-atresplayer (una extensión que se carga '
    + 'en tu navegador, sin gestor de scripts): lee el aviso «Publicidad» del propio reproductor y se lo cuenta a TDT local. '
    + 'Nada se bloquea ni se salta: el vídeo sigue su curso.');
}

/* ------------------------------------------------------------ plugins (desktop app only) */
function pluginsPanel() {
  const box = el('div', 'plugins');
  box.append(el('p', 'dlg-hint', PLUGINS_INTRO));
  if (desktopDev()) { // the development plugins live in their own tab and nothing here says so
    const pointer = el('p', 'dlg-hint', DEV_POINTER + ' ');
    const go = el('button', 'btn', 'Ir a Desarrollo');
    go.type = 'button';
    go.addEventListener('click', () => showTab('dev'));
    pointer.append(go);
    box.append(pointer);
  }
  box.append(themeControl());
  const insp = el('p', 'dlg-hint');
  insp.append(inspectorButton(), ' Eventos, llamadas de los plugins y reglas en directo.');
  box.append(insp);
  const safe = el('p', 'dlg-hint');
  const safeButton = el('button', 'btn', 'Reiniciar en modo seguro');
  safeButton.type = 'button';
  safeButton.id = 'pluginSafeButton';
  safeButton.title = 'Reinicia la aplicación sin que corra ningún plugin: para encontrar uno que la rompe. No pierdes lo que tenías activado.';
  safeButton.addEventListener('click', () => { if (window.tdtDesktop && window.tdtDesktop.safe) window.tdtDesktop.safe.restart(!safeButton.dataset.safe); });
  safe.id = 'pluginSafe';
  safe.append(safeButton, ' ', el('span', '', 'Arranca sin ningún plugin (lo que tienes activado se conserva).'));
  box.append(safe);
  const summary = el('p', 'dlg-hint');
  summary.id = 'pluginSummary';
  summary.setAttribute('role', 'status');
  const list = el('ul', 'plugin-list');
  list.id = 'pluginList';
  const apply = el('p', 'dlg-hint plugin-apply');
  apply.id = 'pluginApply';
  apply.hidden = true;
  const reload = el('button', 'btn', 'Recargar ahora');
  reload.type = 'button';
  reload.addEventListener('click', () => window.tdtDesktop.reload());
  apply.append('Los cambios se aplican al recargar la ventana. ', reload);
  const actions = el('div', 'plugin-actions');
  const open = el('button', 'btn', 'Abrir la carpeta de plugins');
  open.type = 'button';
  open.addEventListener('click', () => desktop().openFolder());
  const rescan = el('button', 'btn', 'Buscar de nuevo');
  rescan.type = 'button';
  rescan.addEventListener('click', async () => paintPlugins(await desktop().rescan()));
  const install = el('button', 'btn', 'Instalar desde un archivo…');
  install.type = 'button';
  install.title = 'Un archivo .tdtplugin que te han pasado: se te enseña qué pide antes de instalarlo';
  install.addEventListener('click', async () => {
    const r = await desktop().install();
    if (r && r.list) paintPlugins(r.list);
    pluginNote(r && r.error ? 'No se instaló: ' + r.error : r && r.id ? 'Instalado «' + r.id + '». Actívalo en la lista cuando quieras.' : '');
  });
  actions.append(open, rescan, install);
  const make = el('div', 'plugin-actions');
  const name = el('input');
  name.type = 'text';
  name.id = 'pluginNewName';
  name.maxLength = 60;
  name.placeholder = 'Nombre del plugin nuevo';
  name.setAttribute('aria-label', 'Nombre del plugin nuevo');
  // three starting points: each one writes a folder with something that already works, to change
  const maker = (label, title, kind, fallback, after) => {
    const button = el('button', 'btn', label);
    button.type = 'button';
    button.title = title;
    button.addEventListener('click', async () => {
      const r = await desktop().create(name.value.trim() || fallback, kind);
      if (r && r.list) paintPlugins(r.list);
      pluginNote(r && r.id ? 'Creado «' + r.id + '» en ' + r.folder + '. ' + after : 'No se pudo crear.');
      name.value = '';
    });
    return button;
  };
  make.append(
    name,
    maker('Crear un plugin nuevo', 'Un plugin aislado, con permisos: crea una carpeta con uno que ya funciona, para que lo cambies', 'ui', 'Mi plugin', 'Edítalo, pulsa «Buscar de nuevo» y actívalo en la lista.'),
    maker('Crear un tema', 'Una hoja de estilo que cambia el aspecto de TDT local (sin código)', 'theme', 'Mi tema', 'Edita tema.css, pulsa «Buscar de nuevo» y actívalo: se te enseñará la hoja de estilo.'),
    maker('Crear un plugin con todo el poder', 'Código dentro de la página, sin aislar, con los ganchos de la aplicación (puede cambiar lo que hace)', 'full', 'Mi plugin con todo el poder', 'Edita page.js, pulsa «Buscar de nuevo» y actívalo: se te enseñará su código.'),
  );
  const online = el('details', 'plugin-online');
  online.append(el('summary', '', 'Instalar desde internet'), el('p', 'dlg-hint', ONLINE_INTRO));
  const linkRow = el('div', 'plugin-actions');
  const link = el('input');
  link.type = 'url';
  link.placeholder = 'https://…/mi-plugin.tdtplugin';
  link.setAttribute('aria-label', 'Enlace del archivo .tdtplugin');
  const sha = el('input');
  sha.type = 'text';
  sha.placeholder = 'SHA-256 (opcional, el que publica su autor)';
  sha.setAttribute('aria-label', 'SHA-256 esperado');
  const get = el('button', 'btn', 'Instalar desde el enlace');
  get.type = 'button';
  const installFrom = async (url, expected, signature) => {
    pluginNote('Descargando…');
    const r = await desktop().installLink(url, expected, signature);
    if (r && r.list) paintPlugins(r.list);
    pluginNote(r && r.error ? 'No se instaló: ' + r.error : r && r.id ? 'Instalado «' + r.id + '». Actívalo en la lista cuando quieras.' : '');
  };
  get.addEventListener('click', () => installFrom(link.value.trim(), sha.value.trim()));
  linkRow.append(link, sha, get);
  const catalogRow = el('div', 'plugin-actions');
  const catalogUrl = el('input');
  catalogUrl.type = 'url';
  catalogUrl.placeholder = 'https://…/index.json (un catálogo)';
  catalogUrl.setAttribute('aria-label', 'Enlace de un catálogo');
  try { catalogUrl.value = localStorage.getItem('tdt:catalogUrl') || ''; } catch { /* no storage */ }
  const see = el('button', 'btn', 'Ver el catálogo');
  see.type = 'button';
  const entries = el('ul', 'catalog-list');
  see.addEventListener('click', async () => {
    try { localStorage.setItem('tdt:catalogUrl', catalogUrl.value.trim()); } catch { /* no storage */ }
    entries.replaceChildren();
    pluginNote('Leyendo el catálogo…');
    const r = await desktop().catalog(catalogUrl.value.trim());
    if (!r || r.error) { pluginNote(r && r.error ? r.error : 'No se pudo leer el catálogo.'); return; }
    pluginNote(`${r.entries.length} plugins en el catálogo de ${r.source}` + (r.problems.length ? ` (${r.problems.length} entradas con problemas: ${r.problems[0]})` : '') + '.');
    for (const entry of r.entries) {
      const d = describeCatalogEntry(entry);
      const item = el('li', 'catalog-item');
      const head = el('strong', '', entry.name);
      const button = el('button', 'btn', d.button);
      button.type = 'button';
      button.disabled = !d.enabled;
      button.addEventListener('click', () => installFrom(entry.url, entry.sha256, entry.signature)); // the catalog pins the file with its SHA-256 and carries the signature
      item.append(head, ' ', button, el('p', 'dlg-hint', d.line));
      entries.append(item);
    }
  });
  catalogRow.append(catalogUrl, see);
  online.append(linkRow, catalogRow, entries);
  const note = el('p', 'dlg-hint');
  note.id = 'pluginMsg';
  note.setAttribute('role', 'status');
  const where = el('p', 'dlg-hint');
  where.id = 'pluginFolder';
  box.append(summary, list, apply, actions, make, online, note, where);
  // the state of each running plugin changes by itself (a frame that stops answering): look again every few seconds, only at those lines
  const timer = setInterval(async () => {
    if (!box.isConnected) { clearInterval(timer); return; }
    const data = await desktop().list().catch(() => null);
    if (data) paintRuntime(data);
  }, 3000);
  return box;
}

function pluginNote(text) {
  const note = $('pluginMsg');
  if (note) note.textContent = text;
}

/** The two lines of each running plugin: how its frame is doing and what it has done. Refreshed by a timer, without redoing the list. */
function paintRuntime(data) {
  const status = (pluginHost() && pluginHost().status()) || [];
  for (const live of document.querySelectorAll('.plugin-runtime')) {
    const plugin = data.plugins.find((p) => p.id === live.dataset.plugin);
    const r = describeRuntime(status.find((s) => s.id === live.dataset.plugin), plugin && plugin.activity);
    live.textContent = 'Estado: ' + r.state + (r.activity ? ' · ' + r.activity : '');
    live.classList.toggle('field-error', r.health === 'unresponsive');
  }
}

/** The form of the settings a plugin declares: the app draws it, checks it and keeps it; the plugin only reads what is chosen. */
function settingsForm(plugin) {
  const box = el('fieldset', 'plugin-settings');
  box.append(el('legend', '', 'Ajustes de este plugin'));
  const error = el('p', 'field-error');
  error.hidden = true;
  const save = async (field, input, raw) => {
    const typed = settingValue(field, raw);
    const res = typed.ok ? await desktop().setConfig(plugin.id, { [field.name]: typed.value }) : typed;
    error.hidden = !!res.ok;
    if (!res.ok) { error.textContent = res.error || 'No se pudo guardar.'; input.value = field.value; }
  };
  for (const field of plugin.settings) {
    const row = el('div', 'plugin-setting');
    const label = el('label', '', field.label);
    let input;
    if (field.type === 'boolean') {
      input = el('input');
      input.type = 'checkbox';
      input.checked = field.value === true;
      input.addEventListener('change', () => save(field, input, input.checked));
    } else if (field.type === 'choice') {
      input = el('select');
      for (const option of field.options) input.append(new Option(option, option));
      input.value = field.value;
      input.addEventListener('change', () => save(field, input, input.value));
    } else {
      input = el('input');
      input.type = field.type === 'number' ? 'number' : 'text';
      if (field.type === 'number') { input.min = field.min; input.max = field.max; input.step = 'any'; } else input.maxLength = field.maxLength;
      input.value = String(field.value);
      input.addEventListener('change', () => save(field, input, input.value));
    }
    input.id = `set-${plugin.id}-${field.name}`;
    label.htmlFor = input.id;
    row.append(label, input);
    const hint = settingHint(field);
    if (hint) row.append(el('small', 'dlg-hint', hint));
    box.append(row);
  }
  box.append(error);
  return box;
}

function paintPlugins(data) {
  if (!data) return;
  const list = $('pluginList');
  list.replaceChildren();
  for (const plugin of data.plugins) {
    const d = describePlugin(plugin);
    const item = el('li', 'plugin' + (d.usable ? '' : ' broken'));
    const label = el('label', 'chk');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = d.on;
    box.disabled = !d.usable;
    box.addEventListener('change', async () => {
      paintPlugins(await desktop().setEnabled(plugin.id, box.checked)); // a plugin with permissions asks first, in a native window
      $('pluginApply').hidden = !d.needsReload;
    });
    label.append(box, el('strong', '', ' ' + d.title));
    item.append(label);
    for (const line of [d.description, d.author, d.screen, d.acts, d.source]) if (line) item.append(el('p', 'dlg-hint', line));
    if (d.power) item.append(el('p', 'field-error', d.power));
    if (plugin.kind === 'ui') {
      const rows = permissionRows(plugin);
      if (!rows.length) item.append(el('p', 'dlg-hint', 'No pide ningún permiso.'));
      else {
        // each permission can be turned off on its own: the plugin starts again with what it may do now
        const asked = el('ul', 'plugin-perms');
        asked.append(el('li', 'plugin-perms-head', 'Pide permiso para:'));
        for (const row of rows) {
          const li = el('li', 'plugin-perm risk-' + row.risk);
          const chk = el('label', 'chk');
          const check = el('input');
          check.type = 'checkbox';
          check.checked = row.granted;
          check.setAttribute('aria-label', row.text);
          check.addEventListener('change', async () => paintPlugins(await desktop().setPermission(plugin.id, row.name, check.checked)));
          chk.append(check, ' ' + row.text + ' ', el('small', 'plugin-risk', '(' + row.riskText + ')'));
          li.append(chk);
          asked.append(li);
        }
        item.append(asked);
      }
      if (d.usable && Array.isArray(plugin.settings) && plugin.settings.length) item.append(settingsForm(plugin));
      if (d.on) {
        const live = el('p', 'dlg-hint plugin-runtime');
        live.dataset.plugin = plugin.id;
        item.append(live);
        const reload = el('button', 'btn', 'Recargar');
        reload.type = 'button';
        reload.title = 'Vuelve a cargar el plugin';
        reload.addEventListener('click', () => { const host = pluginHost(); if (host) host.reload(plugin.id); });
        item.append(reload);
      }
    }
    if (d.renewal) item.append(el('p', 'field-error', d.renewal));
    if ((plugin.kind === 'ui' || plugin.kind === 'full') && d.usable) {
      const pack = el('button', 'btn', 'Empaquetar para compartir…');
      pack.type = 'button';
      pack.title = 'Crea un archivo .tdtplugin con este plugin';
      pack.addEventListener('click', async () => {
        const r = await desktop().pack(plugin.id);
        if (r && r.saved) pluginNote('Guardado en ' + r.saved + '. SHA-256: ' + r.sha256 + ' (publícala junto al archivo para que quien lo instale pueda comprobarlo).');
        else if (r && r.error) pluginNote('No se pudo empaquetar: ' + r.error);
      });
      item.append(pack);
    }
    for (const problem of d.problems) item.append(el('p', 'field-error', 'No se puede usar: ' + problem));
    list.append(item);
  }
  paintRuntime(data);
  $('pluginSummary').textContent = summarize(data.plugins);
  const inSafe = !!data.safeMode; // the button leaves the safe mode when it is on
  $('pluginSafeButton').textContent = inSafe ? 'Salir del modo seguro' : 'Reiniciar en modo seguro';
  if (inSafe) $('pluginSafeButton').dataset.safe = '1'; else delete $('pluginSafeButton').dataset.safe;
  $('pluginSafe').lastChild.textContent = inSafe ? `Modo seguro: ningún plugin corre (${data.safeMode}).` : 'Arranca sin ningún plugin (lo que tienes activado se conserva).';
  $('pluginFolder').textContent = 'Los tuyos van en una carpeta por plugin dentro de: ' + data.folder;
}

/* ------------------------------------------------------------ log (desktop app only) */
let logData = null; // what the app last said: {lines, folder}

function logsPanel() {
  const box = el('div', 'logs');
  box.append(el('p', 'dlg-hint', LOGS_INTRO));
  const bar = el('div', 'plugin-actions');
  const mode = el('select');
  mode.id = 'logMode';
  mode.setAttribute('aria-label', 'Qué líneas ver');
  for (const [value, text] of Object.entries(MODES)) mode.append(new Option(text, value));
  mode.addEventListener('change', paintLogs);
  const button = (text, fn) => {
    const b = el('button', 'btn', text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  bar.append(mode,
    button('Actualizar', loadLogs),
    button('Copiar', copyLogs),
    button('Guardar en un archivo…', saveLogs),
    button('Abrir la carpeta de registros', () => desktopLogs().openFolder()));
  const summary = el('p', 'dlg-hint');
  summary.id = 'logSummary';
  summary.setAttribute('role', 'status');
  const view = el('pre', 'log-view');
  view.id = 'logView';
  view.tabIndex = 0;
  view.setAttribute('aria-label', 'Registro de la aplicación');
  const msg = el('p', 'dlg-hint');
  msg.id = 'logMsg';
  msg.setAttribute('role', 'status');
  box.append(bar, summary, view, msg);
  return box;
}

function paintLogs() {
  if (!logData) return;
  const lines = filterLines(logData.lines, $('logMode').value);
  const view = $('logView');
  view.textContent = lines.length ? lines.join('\n') : 'No hay líneas con este filtro.';
  view.scrollTop = view.scrollHeight;
  $('logSummary').textContent = summarizeLogs(logData.lines) + (lines.length < logData.lines.length ? ' · se ven ' + lines.length : '')
    + '. Archivo: ' + logData.folder;
}

async function loadLogs() {
  if (!desktopLogs()) return;
  logData = await desktopLogs().get();
  paintLogs();
}

async function copyLogs() {
  if (!logData) await loadLogs();
  const text = filterLines(logData.lines, $('logMode').value, Infinity).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('logMsg').textContent = 'Copiado (' + text.split('\n').length + ' líneas).';
  } catch {
    $('logMsg').textContent = 'El navegador no deja copiar: usa «Guardar en un archivo…».';
  }
}

async function saveLogs() {
  const res = await desktopLogs().save();
  $('logMsg').textContent = res && res.saved ? 'Guardado en ' + res.saved : 'No se ha guardado nada.';
}

async function loadPlugins() {
  if (desktop()) paintPlugins(await desktop().list());
}

/* ------------------------------------------------------------ access of AIs (control bus) */
function controlHelp() {
  const box = el('div', 'control-help');
  box.append(el('p', 'dlg-hint dev-warn', CONTROL_INTRO));
  const status = el('p', 'dlg-hint');
  status.id = 'controlState';
  status.setAttribute('role', 'status');
  const tokenBox = el('div', 'token-box');
  tokenBox.id = 'controlToken';
  tokenBox.hidden = true;
  const input = el('input');
  input.id = 'controlTokenValue';
  input.type = 'password';
  input.readOnly = true;
  input.setAttribute('aria-label', 'Token de acceso');
  const button = (text, fn) => {
    const b = el('button', 'btn', text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  tokenBox.append(
    input,
    button('Mostrar', (e) => {
      input.type = input.type === 'password' ? 'text' : 'password';
      e.target.textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar';
    }),
    button('Copiar', () => navigator.clipboard.writeText(input.value)),
    button('Generar uno nuevo…', async () => {
      if (!window.confirm('El token actual dejará de valer: tendrás que poner el nuevo en cada cliente. ¿Seguir?')) return;
      const res = await requestJson('/api/control/token/regenerate', 'POST').catch(() => null);
      if (res && res.ok) input.value = res.data.token;
    }),
  );
  const how = el('p', 'dlg-hint', describeUse(location.origin));
  how.id = 'controlHow';
  box.append(status, tokenBox, how);
  return box;
}

async function loadControl() {
  const res = await requestJson('/api/control/status').catch(() => null);
  const status = res && res.ok ? res.data : null;
  $('controlState').textContent = describeControl(status);
  const tokenBox = $('controlToken');
  tokenBox.hidden = !(status && status.enabled);
  if (!tokenBox.hidden) {
    const t = await requestJson('/api/control/token').catch(() => null);
    $('controlTokenValue').value = t && t.ok ? t.data.token : '';
  }
}

/* ------------------------------------------------------------ development plugins (desktop app only) */
function devPanel() {
  const box = el('div', 'dev');
  const warn = el('p', 'dlg-hint dev-warn', DEV_INTRO);
  const mode = el('button', 'btn');
  mode.type = 'button';
  mode.id = 'devMode';
  mode.addEventListener('click', async () => {
    const view = await desktopDev().state();
    paintDev(await desktopDev().setMode(!view.mode)); // turning it on ends in a native question that this page cannot answer
  });
  const summary = el('p', 'dlg-hint');
  summary.id = 'devSummary';
  summary.setAttribute('role', 'status');
  const list = el('ul', 'plugin-list');
  list.id = 'devList';
  const actions = el('div', 'plugin-actions');
  actions.id = 'devActions';
  const open = el('button', 'btn', 'Abrir la carpeta de plugins de desarrollo');
  open.type = 'button';
  open.addEventListener('click', () => desktopDev().openFolder());
  const rescan = el('button', 'btn', 'Buscar de nuevo');
  rescan.type = 'button';
  rescan.addEventListener('click', async () => paintDev(await desktopDev().rescan()));
  actions.append(open, rescan);
  const where = el('p', 'dlg-hint');
  where.id = 'devFolder';
  box.append(warn, mode, summary, list, actions, where);
  return box;
}

function paintDev(view) {
  if (!view) return;
  window.dispatchEvent(new Event('tdt-dev-changed')); // the permanent notice reads the state again
  $('devMode').textContent = view.mode ? 'Apagar el modo desarrollador' : 'Activar el modo desarrollador…';
  $('devMode').disabled = view.mode && view.forced;
  $('devSummary').textContent = summarizeDev(view) + (view.forced ? ' (encendido por TDT_DEV: desde aquí no se apaga)' : '');
  $('devActions').hidden = !view.mode;
  $('devFolder').textContent = view.mode
    ? 'Cada plugin es una carpeta con un manifest.json («tdt.dev») y un page.js y/o un main.js, dentro de: ' + view.folder
      + '. Se recargan solos al cambiar un archivo. Detalle en docs/PLUGINS.md.'
    : '';
  const list = $('devList');
  list.replaceChildren();
  for (const plugin of view.plugins) {
    const d = describeDevPlugin(plugin);
    const item = el('li', 'plugin' + (d.usable ? '' : ' broken'));
    const label = el('label', 'chk');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = d.on;
    box.disabled = !d.usable;
    box.addEventListener('change', async () => {
      paintDev(await desktopDev().approve(plugin.id, box.checked)); // on: a native question first
    });
    label.append(box, el('strong', '', ' ' + d.title));
    item.append(label);
    for (const line of [d.description, d.acts, 'Estado: ' + d.status + '.']) if (line) item.append(el('p', 'dlg-hint', line));
    for (const problem of d.problems) item.append(el('p', 'field-error', 'No se puede usar: ' + problem));
    if (d.error) item.append(el('p', 'field-error', 'Error: ' + d.error));
    list.append(item);
  }
}

async function loadDev() {
  if (desktopDev()) paintDev(await desktopDev().state());
}

function link(href, text) {
  const a = el('a', '', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function build() {
  const nav = $('setTabs');
  const panels = $('setPanels');
  for (const tab of tabsShown()) {
    const button = el('button', '', tab.label);
    button.type = 'button';
    button.id = 'tab_' + tab.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'panel_' + tab.id);
    button.addEventListener('click', () => showTab(tab.id));
    nav.append(button);

    const panel = el('section');
    panel.id = 'panel_' + tab.id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    if (tab.id === 'plugins' || tab.id === 'logs' || tab.id === 'dev') { // not server settings: they talk to the app
      panel.append(tab.id === 'plugins' ? pluginsPanel() : tab.id === 'logs' ? logsPanel() : devPanel());
      panels.append(panel);
      continue;
    }
    const advanced = el('details', 'adv');
    advanced.append(el('summary', '', 'Fuentes de datos (avanzado)'));
    for (const f of fieldsOf(tab.id)) {
      (f.advanced ? advanced : panel).append(fieldNode(f));
      if (f.name === 'whisper_model') panel.append(modelsBlock());
    }
    if (tab.id === 'stt') panel.prepend(helpBlock());
    if (tab.id === 'scte') panel.prepend(scteHelp());
    if (tab.id === 'ads') panel.prepend(adsHelp());
    if (tab.id === 'control') panel.prepend(controlHelp());
    if (advanced.children.length > 1) panel.append(advanced);
    const reset = el('button', 'btn reset', 'Restaurar valores de esta pestaña');
    reset.type = 'button';
    reset.addEventListener('click', () => resetTab(tab.id));
    panel.append(reset);
    panels.append(panel);
  }
  nav.addEventListener('keydown', (e) => {
    const ids = tabsShown().map((t) => t.id);
    const i = ids.findIndex((id) => $('tab_' + id).getAttribute('aria-selected') === 'true');
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = ids[(i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
      showTab(next);
      $('tab_' + next).focus();
    }
  });
  for (const id of ['llmModels', 'whisperModels']) {
    const list = el('datalist');
    list.id = id;
    dlg().append(list);
  }
}

function showTab(id) {
  for (const tab of tabsShown()) {
    const on = tab.id === id;
    $('tab_' + tab.id).setAttribute('aria-selected', on ? 'true' : 'false');
    $('tab_' + tab.id).tabIndex = on ? 0 : -1;
    $('panel_' + tab.id).hidden = !on;
  }
}

/* ------------------------------------------------------------ values <-> form */
function fill(snap) {
  snapshot = snap;
  for (const f of FIELDS) {
    const input = inputs.get(f.name);
    const value = snap.values[f.name];
    if (f.type === 'bool') input.checked = !!value;
    else input.value = value === undefined || value === null ? '' : String(value);
    const locked = snap.locked.includes(f.name);
    input.disabled = locked;
    const wrap = input.closest('.field');
    wrap.classList.toggle('locked', locked);
    wrap.querySelector('.field-error').textContent = locked
      ? 'Fijado por la línea de comandos o la variable TDT_' + f.name.toUpperCase() + '; se ignora lo guardado.' : '';
    if (f.type === 'secret') {
      input.value = '';
      input.placeholder = snap.secrets_set[f.name] ? '•••••••• (guardada)' : '';
      wrap.secretRow.hidden = !snap.secrets_set[f.name] || locked;
      removeKey.checked = false;
    }
  }
  $('modelsWhere').textContent = '';
}

function readForm() {
  const out = {};
  for (const f of FIELDS) {
    const input = inputs.get(f.name);
    if (input.disabled) continue;
    if (f.type === 'bool') out[f.name] = input.checked;
    else if (f.type === 'number') out[f.name] = input.value.trim() === '' ? input.value : Number(input.value);
    else if (f.type !== 'secret') out[f.name] = input.value;
  }
  return out;
}

function showErrors(errors) {
  for (const f of FIELDS) {
    const note = inputs.get(f.name).closest('.field').querySelector('.field-error');
    if (errors[f.name]) note.textContent = errors[f.name];
    else if (!inputs.get(f.name).disabled) note.textContent = '';
  }
  const first = FIELDS.find((f) => errors[f.name]);
  if (first) {
    showTab(first.tab);
    inputs.get(first.name).focus();
  }
}

/* ------------------------------------------------------------ actions */
async function save(e) {
  e.preventDefault();
  const typed = inputs.get('llm_api_key');
  const changes = collectChanges(snapshot.values, readForm(), { secret: typed.value, removeSecret: removeKey.checked });
  if (!Object.keys(changes).length) { say('No hay cambios que guardar.'); return; }
  say('Guardando…');
  let res;
  try { res = await requestJson('/api/settings', 'POST', changes); } catch { say('El servidor local no responde.', true); return; }
  if (!res.ok) {
    showErrors((res.data && res.data.errors) || {});
    say('Revisa los campos marcados: no se ha guardado nada.', true);
    return;
  }
  fill(res.data.settings);
  say('Guardado. Los cambios ya están en uso.');
  window.dispatchEvent(new Event('tdt-control-changed'));
  loadControl();
  loadModels();
  await hooks.reload();
}

async function resetTab(tab) {
  if (!window.confirm('¿Restaurar los valores por defecto de esta pestaña?')) return;
  const res = await requestJson('/api/settings/reset', 'POST', { section: tab });
  if (res.ok) {
    fill(res.data.settings);
    say(res.data.changed.length ? 'Valores restaurados.' : 'Ya tenía los valores por defecto.');
    await hooks.reload();
  } else say('No se pudo restaurar.', true);
}

async function testAssistant(button, out) {
  button.disabled = true;
  out.textContent = 'Conectando…';
  out.className = 'test-result';
  const typed = inputs.get('llm_api_key').value;
  let res;
  try {
    res = await requestJson('/api/settings/test/ai', 'POST', { url: inputs.get('llm_url').value, api_key: typed || null });
  } catch { res = { data: { ok: false, error: 'El servidor local no responde.' } }; }
  button.disabled = false;
  const d = res.data || { ok: false, error: 'Respuesta no válida.' };
  out.classList.add(d.ok ? 'good' : 'bad');
  if (!d.ok) { out.textContent = '✖ ' + d.error; return; }
  out.textContent = d.models.length
    ? '✔ Conectado. Modelos disponibles: ' + d.models.join(', ')
    : '✔ Conectado, pero el servidor no lista modelos.';
  $('llmModels').replaceChildren(...d.models.map((m) => new Option(m, m)));
}

async function testWeb(button, out) {
  button.disabled = true;
  out.textContent = 'Comprobando…';
  out.className = 'test-result';
  let res;
  try {
    res = await requestJson('/api/settings/test/web', 'POST', { url: inputs.get('ad_web_url').value });
  } catch { res = { data: { ok: false, error: 'El servidor local no responde.' } }; }
  button.disabled = false;
  const d = res.data || { ok: false, error: 'Respuesta no válida.' };
  out.classList.add(d.ok ? 'good' : 'bad');
  out.textContent = d.ok ? '✔ La web responde y permite mostrarse dentro de la página.' : '✖ ' + d.error;
}

async function testWhisper(button, out) {
  button.disabled = true;
  out.textContent = 'Comprobando…';
  out.className = 'test-result';
  let res;
  try {
    res = await requestJson('/api/settings/test/stt', 'POST', {
      whisper_bin: inputs.get('whisper_bin').value, whisper_model: inputs.get('whisper_model').value,
      whisper_url: inputs.get('whisper_url').value,
    });
  } catch { res = { data: { ok: false, error: 'El servidor local no responde.' } }; }
  button.disabled = false;
  const d = res.data || { ok: false, error: 'Respuesta no válida.' };
  if (!d.ok) { out.classList.add('bad'); out.textContent = '✖ ' + d.error; return; }
  out.replaceChildren(...describeDiagnosis(d).map((r) => el('div', r.ok ? 'good' : 'bad', (r.ok ? '✔ ' : '✖ ') + r.text)));
}

/* ------------------------------------------------------------ Whisper models */
async function loadModels() {
  const res = await requestJson('/api/whisper/models');
  if (!res.ok) return;
  const { installed, catalog, models_dir: dir, download } = res.data;
  $('whisperModels').replaceChildren(...installed.map((m) => new Option(m.file, m.path)));
  const list = $('modelsInstalled');
  list.replaceChildren(...(installed.length ? installed.map((m) => {
    const li = el('li');
    const use = el('button', 'btn', 'Usar');
    use.type = 'button';
    use.addEventListener('click', () => { inputs.get('whisper_model').value = m.path; say('Modelo elegido: pulsa Guardar para usarlo.'); });
    li.append(el('span', '', m.file + ' · ' + formatBytes(m.bytes)), use);
    return li;
  }) : [el('li', 'dlg-hint', 'No hay modelos instalados todavía.')]));
  $('modelCatalog').replaceChildren(...catalog.map((m) => {
    const opt = new Option(`${m.name} · ${m.label} · ≈ ${m.mb >= 1000 ? (m.mb / 1000).toFixed(1).replace('.', ',') + ' GB' : m.mb + ' MB'}`
      + (m.installed ? ' · ya descargado' : '') + ' — ' + m.note, m.name);
    return opt;
  }));
  $('modelsWhere').textContent = 'Carpeta de modelos: ' + dir;
  paintDownload(download);
  if (download.state === 'running') pollDownload();
}

function paintDownload(s) {
  const running = s.state === 'running';
  $('modelGo').disabled = running;
  $('modelCancel').hidden = !running;
  $('modelProgress').hidden = !running;
  if (running) $('modelProgress').value = percent(s.done, s.total);
  $('modelStatus').textContent = describeDownload(s);
}

function pollDownload() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    const res = await requestJson('/api/whisper/download').catch(() => null);
    if (!res || !res.ok) return;
    paintDownload(res.data);
    if (res.data.state === 'running') { pollDownload(); return; }
    await loadModels();
    if (res.data.state === 'done') {
      inputs.get('whisper_model').value = res.data.path;
      say('Modelo descargado y elegido: pulsa Guardar para usarlo.');
    }
  }, POLL_MS);
}

async function startDownload() {
  const res = await requestJson('/api/whisper/download', 'POST', { name: $('modelCatalog').value });
  if (res.data && res.data.download) paintDownload(res.data.download);
  if (res.ok) pollDownload();
  else say((res.data && res.data.error) || 'Ya hay una descarga en curso.', true);
}

/* ------------------------------------------------------------ opening */
async function open() {
  say('');
  const res = await requestJson('/api/settings').catch(() => null);
  if (!res || !res.ok) { hooks.footMsg('No se pudieron leer los ajustes.'); return; }
  fill(res.data);
  showTab('ai');
  dlg().showModal();
  loadModels();
  loadPlugins();
  loadLogs();
  loadDev();
  loadControl();
}

/**
 * @param {{reload: () => Promise<void>, footMsg: (t: string) => void, openScte: () => void}} appHooks
 */
export function initSettings(appHooks) {
  hooks = appHooks;
  build();
  $('btnSettings').addEventListener('click', open);
  $('setForm').addEventListener('submit', save);
  $('setClose').addEventListener('click', () => dlg().close());
  dlg().addEventListener('close', () => clearTimeout(pollTimer));
}
