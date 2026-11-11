// TDT local as a desktop app: its own window (Chromium) around the Python server, a tray icon and plugins.
// Development: `npm install` and `npm start` inside desktop/ (needs Python and the repository). See docs/DESKTOP.md.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import * as electronApi from 'electron';
import { BrowserWindow, Menu, Tray, app, dialog, ipcMain, nativeImage, protocol, session, shell } from 'electron';
import { CACHE_MS, PLUGIN_ID, Reading, SLUGS, allowedAddress, listUrl, watchAddress } from './lib/atres.js';
import { createDevAdmin } from './lib/dev-admin.js';
import { createDevRuntime, dataDirOf } from './lib/dev-runtime.js';
import { Logbook, levelOf } from './lib/logbook.js';
import {
  activationQuestion, codeOf, embedHosts, parsePermission, createPluginStorage, describePermission, effectivePermissions, isApproved, needsReapproval, pluginFetch, readApproved,
  readDenied, riskOf, signature, writeApproved,
} from './lib/plugin-api.js';
import { createPluginAdmin } from './lib/plugin-admin.js';
import {
  aboutPower, activationQuestion as fullQuestion, codePreview, handOver as fullHandOver, isApproved as fullApproved, isTheme, needsReapproval as fullNeeds,
  signature as fullSignature,
} from './lib/plugin-full.js';
import { createCrashGuard, decide, relaunchArgs } from './lib/safe-mode.js';
import { attribute, createWatch, limitsFrom } from './lib/plugin-limits.js';
import { createKeyStore, describeJudgement, isWarning, judge } from './lib/plugin-sign.js';
import { LIMITS, checkLink, cleanSha, download, readCatalog, sha256Of, withInstalled } from './lib/plugin-catalog.js';
import { applyChanges, createConfigStore, formOf, valuesOf } from './lib/plugin-config.js';
import { createPluginWriter } from './lib/plugin-writer.js';
import { discard, idFromName, inspectPackage, newPluginFiles, packFolder, place, sha256 } from './lib/plugin-pack.js';
import { SCHEME, parseAddress, servePlugin } from './lib/plugin-protocol.js';
import { discover, insideOf, readEnabled, readPlugin, scriptsFor, writeEnabled } from './lib/plugins.js';
import { copyIfMissing, dataDirFor, desktopDirFor, readPort, writePort } from './lib/paths.js';
import { PREFERRED_PORTS, REPO_ROOT, serverCommandFor, startServer, stopServer } from './lib/server.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const ICON = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(REPO_ROOT, 'packaging', 'icons', 'icon-256.png');

// What Chromium and the app keep lives inside the data folder of the server, and this must be set before anything reads
// it (the single-instance lock does). Before 1.3 it was %APPDATA%\tdt-local-desktop: the plugin choices come along.
const DATA_DIR = dataDirFor({ packaged: app.isPackaged, repoRoot: REPO_ROOT });
const previousUserData = app.getPath('userData');
app.setPath('userData', desktopDirFor(DATA_DIR));
copyIfMissing(join(previousUserData, 'plugins.json'), join(app.getPath('userData'), 'plugins.json'));

let server = null;
let logbook = new Logbook(); // in memory until the app is ready and knows where its folder is
const log = (source, level, text) => logbook.add(source, level, text);
const logsDir = () => join(app.getPath('userData'), 'logs');
let win = null;
let watching = null; // the window where a recording of Atresplayer is watched
let explorer = null; // the «Explorar Atresplayer» window and its reading: {win, reading}
const atresCache = new Map(); // channel -> {at, items}
let tray = null;
let quitting = false;
let plugins = [];
// Safe mode (lib/safe-mode.js): no plugin runs. Decided at the start; the choices of the user stay in their files and come back when it is left.
let safeMode = { safe: false, why: '', text: '' };
const crashGuard = createCrashGuard(join(app.getPath('userData'), 'run.json'));
const MUTATING_ADMIN = ['plugin_enable', 'plugin_disable', 'plugin_permission', 'plugin_write', 'plugin_config'];
let enabled = new Set();
let approved = {}; // plugins with permissions (api 1): id -> what the user approved (lib/plugin-api.js signature)
let denied = {}; // id -> the permissions it declares that the user turned off
const activity = new Map(); // id -> what the plugin did through the app: {fetches, bytesIn, hosts}

// Tests that drive the real window answer the native questions themselves. Never in an installed app.
const testAnswersYes = () => !app.isPackaged && process.env.TDT_DEV_CONFIRM === 'yes';

const stateFile = () => join(app.getPath('userData'), 'plugins.json');
const approvedFile = () => join(app.getPath('userData'), 'ui.json');
const storage = createPluginStorage(join(app.getPath('userData'), 'plugin-data'));
const pluginKeys = createKeyStore(join(app.getPath('userData'), 'plugin-keys.json')); // the key each plugin was installed with (author signatures)
const config = createConfigStore(join(app.getPath('userData'), 'plugin-config.json')); // what the user chose in the settings a plugin declares

// The pages of the plugins with permissions are served from tdt-plugin://<id>/ (lib/plugin-protocol.js). The scheme has to be
// declared before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

/** A plugin with permissions that is running: turned on, without problems, approved exactly as it is now. */
const isActive = (p) => p.kind === 'ui' && enabled.has(p.id) && isApproved(p, approved);
const activePlugin = (id) => plugins.find((p) => p.id === id && isActive(p)) || null;
/** A plugin with all the power that is running: turned on, without problems, approved with exactly the code it has now. */
const isFullOn = (p) => p.kind === 'full' && enabled.has(p.id) && fullApproved(p, approved);
/** Is it on? What each kind needs to be on is not the same. */
const isOn = (p) => (p.kind === 'ui' ? isActive(p) : p.kind === 'full' ? isFullOn(p) : enabled.has(p.id) && !p.problems.length);
const effective = (p) => effectivePermissions(p, denied);
const activityOf = (id) => {
  if (!activity.has(id)) activity.set(id, { fetches: 0, bytesIn: 0, hosts: [] });
  return activity.get(id);
};

// Development plugins (docs/PLUGINS.md): no isolation, no permissions, only from their own folder, only with the developer
// mode on, each approved by hand. The questions are native dialogs of this process, so no page can answer them.
const DEV_DIR = process.env.TDT_DEV_PLUGINS_DIR || join(DATA_DIR, 'dev-plugins');
let devImports = 0;
const dev = createDevRuntime({
  dir: DEV_DIR,
  stateFile: join(app.getPath('userData'), 'dev.json'),
  env: process.env,
  packaged: app.isPackaged,
  confirm: async ({ message, detail }) => {
    if (testAnswersYes()) return true;
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning', buttons: ['Cancelar', 'Activar'], defaultId: 0, cancelId: 0, noLink: true, title: 'TDT local · modo desarrollador', message, detail,
    });
    return response === 1;
  },
  log: (level, text, source) => log(source || 'dev', level, text),
  importPlugin: (file) => import(pathToFileURL(file).href + '?v=' + (++devImports)), // a new copy each time: hot reload
  api: (plugin) => {
    const source = 'dev:' + plugin.id;
    const say = (level) => (...parts) => log(source, level, parts.map((x) => (typeof x === 'string' ? x : inspect(x))).join(' '));
    return {
      id: plugin.id, log: say('INFO'), warn: say('WARN'), error: say('ERROR'),
      electron: electronApi, app, getWindow: () => win, serverUrl: server ? server.url : '', showWindow,
      reload: () => { if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache(); },
      dataDir: dataDirOf(DEV_DIR, plugin.id), // keep its own files here: the plugin folder is watched and a write would reload it
    };
  },
  onChange: ({ reloadPage }) => {
    buildTray();
    devTitle();
    if (reloadPage && win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
  },
});
// What an AI may do about development plugins through the MCP (lib/dev-admin.js). A write is checked first and only then
// shown to the user, here, in a native dialog that no page can click; «Ver los archivos» opens the whole result to read.
const devAdmin = createDevAdmin({
  dir: DEV_DIR,
  runtime: dev,
  logLines: () => logbook.lines(),
  log: (level, text, source) => log(source || 'dev', level, text),
  confirmWrite: ({ message, detail, stageDir }) => confirmWriteDialog('TDT local · plugin de desarrollo', message, detail, stageDir),
});
/** The question about the code an AI wants to write: reject, look at the files, or apply. A native window: no page can answer it. */
async function confirmWriteDialog(title, message, detail, stageDir) {
  if (testAnswersYes()) return true;
  showWindow();
  for (;;) {
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning', buttons: ['Rechazar', 'Ver los archivos', 'Aplicar los cambios'], defaultId: 0, cancelId: 0, noLink: true, title, message, detail,
    });
    if (response === 1) { await shell.openPath(stageDir); continue; }
    return response === 2;
  }
}
const devTitle = () => { if (win && !win.isDestroyed()) win.setTitle(safeMode.safe ? 'TDT local · MODO SEGURO' : dev.mode() ? 'TDT local · MODO DESARROLLADOR' : 'TDT local'); };

/** Where plugins are looked for: the ones the user adds, then the ones that come with the app (in development, tools/). */
function pluginFolders() {
  const extra = process.env.TDT_PLUGINS_DIR ? process.env.TDT_PLUGINS_DIR.split(process.platform === 'win32' ? ';' : ':') : [];
  const bundled = app.isPackaged ? join(process.resourcesPath, 'plugins') : join(REPO_ROOT, 'tools');
  return [
    ...extra.map((dir) => ({ dir, label: 'TDT_PLUGINS_DIR' })),
    { dir: userPluginsDir(), label: 'tu carpeta de plugins' },
    { dir: bundled, label: 'incluido con la aplicación' },
  ];
}

const userPluginsDir = () => join(app.getPath('userData'), 'plugins');

/** What the settings page is told about the plugins (never the scripts, nor paths of the user's machine). */
function pluginList() {
  return {
    safeMode: safeMode.safe ? safeMode.text : '', // not empty: no plugin runs, and why
    folder: userPluginsDir(),
    plugins: plugins.map((p) => ({
      id: p.id, name: p.name, version: p.version, description: p.description, source: p.source,
      sites: p.sites, problems: p.problems, enabled: isOn(p),
      kind: p.kind,
      ...(p.kind === 'full'
        ? { author: p.author, homepage: p.homepage, scopes: p.scopes, needsApproval: fullNeeds(p, approved), hash: p.hash.slice(0, 16) } // it runs without isolation: the panel says so
        : {}),
      ...(p.kind === 'ui'
        ? {
            author: p.author, homepage: p.homepage, panel: !!p.panel, screen: !!p.panel && p.panel.placement === 'screen',
            placement: !p.panel ? 'none' : p.panel.placement === 'screen' ? 'screen' : 'float',
            permissions: p.permissions.map((name) => ({ name, text: describePermission(name), risk: riskOf(name), granted: !(denied[p.id] || []).includes(name) })),
            activity: { ...activityOf(p.id), storage: storage.usage(p.id) },
            settings: formOf(p.settings, config.get(p.id)), // the form the settings page draws: each field with its value
            activation: p.activation,
            sources: p.sources,
            themes: (p.themes || []).map((t) => String(t.name).slice(0, 40)), // what it brings: the page chooses and checks the colours
            rulesBrought: (p.rules || []).length,
            needsApproval: needsReapproval(p, approved), // it was approved once and now asks for something else
          }
        : {}),
    })),
  };
}

/** The plugins with permissions the page has to show, with what the page needs to put them on screen. */
function uiPlugins() {
  return plugins.filter(isActive).map((p) => ({
    id: p.id, name: p.name, version: p.version, label: p.label, url: `${SCHEME}://${p.id}/`, panel: p.panel, permissions: effective(p), activation: p.activation,
    denied: denied[p.id] || [],
    // the players it may show in a tile: only the ones whose server the user has not taken the permission away from
    rules: p.rules || [],
    themes: p.themes || [],
    sources: (p.sources || []).filter((s) => effective(p).includes('embed:' + new URL(s.embed.replace(/\{[^}]*\}/g, 'x')).hostname)),
  }));
}
const uiChanged = (reload = false) => { if (win && !win.isDestroyed()) win.webContents.send('tdt:ui-changed', reload); };

function loadPlugins() {
  plugins = discover(pluginFolders());
  enabled = safeMode.safe ? new Set() : readEnabled(stateFile()); // safe mode: none is on (the file is not touched)
  approved = readApproved(approvedFile());
  denied = readDenied(approvedFile());
  log('plugins', 'INFO', plugins.length + ' encontrados; activados: ' + ([...enabled].join(', ') || 'ninguno'));
  for (const p of plugins.filter((x) => x.problems.length)) log('plugins', 'WARN', p.id + ' no se puede usar: ' + p.problems.join('; '));
}

/** Sends what a window's page writes to its console to the log: everything from TDT local, and warnings, errors and
 * the bridge's own lines from the players inside it (they are chatty). */
let reloads = 0;
let reloadTimer = null;
/** Our own server refused a connection: the page may have loaded without some of its scripts. Load it again, at most twice. */
function reloadOnce() {
  if (reloads >= 2 || reloadTimer || !win || win.isDestroyed()) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    reloads += 1;
    log('app', 'WARN', 'el servidor rechazó una conexión al cargar la página: se recarga (' + reloads + ' de 2)');
    if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
  }, 1000);
}

let exploring = false; // the explorer's own session is already being watched
const seenRequests = new Set();
/** Requests that fail or answer with an error, once per address (the players inside the page do not report them in the
 * console, and they are often the reason a video does not start): at most `MAX_REQUEST_LINES` for the whole run. */
const MAX_REQUEST_LINES = 150;
function watchRequests(ses, label) {
  const note = (text, address) => {
    const key = text + ' ' + address.split('?')[0];
    if (seenRequests.has(key) || seenRequests.size >= MAX_REQUEST_LINES) return;
    seenRequests.add(key);
    log(label, 'WARN', text + ' ' + key.slice(text.length + 1, text.length + 201)); // the address without its parameters: they carry ids
  };
  ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (d) => {
    if (d.statusCode >= 400) note('HTTP ' + d.statusCode + ' ' + d.method, d.url);
  });
  ses.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => {
    if (d.error !== 'net::ERR_ABORTED') note(d.error + ' ' + d.method, d.url);
    if (d.error === 'net::ERR_CONNECTION_REFUSED' && server && d.url.startsWith(server.url)) reloadOnce();
  });
}

function watch(contents, label) {
  contents.on('console-message', (...args) => {
    const d = args.length === 1 ? args[0] : { level: args[1], message: args[2], sourceId: args[4] }; // Electron changed this signature
    const name = typeof d.level === 'string' ? d.level : ['debug', 'info', 'warning', 'error'][d.level] || 'info';
    const message = String(d.message || '');
    const own = label === 'pagina' && d.frame && d.frame.parent === null;
    // what a plugin with permissions writes to its console is its own line in the log, at any level: it is what its author reads
    const mine = parseAddress(String(d.sourceId || '')) || (d.frame ? parseAddress(d.frame.url || '') : null);
    if (mine) {
      log('plugin:' + mine.id, name === 'error' ? 'ERROR' : name === 'warning' ? 'WARN' : 'INFO', message.slice(0, 2000));
      return;
    }
    if (!own && name !== 'warning' && name !== 'error' && !message.startsWith('[TDT')) return;
    log(label, name === 'error' ? 'ERROR' : name === 'warning' ? 'WARN' : 'INFO', message);
  });
  contents.on('did-fail-load', (_e, code, text, url, isMainFrame) => {
    if (code !== -3) log(label, 'ERROR', (isMainFrame ? 'no se pudo cargar ' : 'no se pudo cargar un marco: ') + url + ' (' + text + ')');
  });
  contents.on('render-process-gone', (_e, details) => log(label, 'ERROR', 'el proceso de la página se cerró: ' + details.reason));
  contents.on('unresponsive', () => log(label, 'WARN', 'la página no responde'));
}

function serverCommand() {
  return serverCommandFor({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: REPO_ROOT, dataDir: DATA_DIR });
}

/** The question that decides whether a plugin with permissions may run. A native dialog: no page can answer it. */
async function askActivation(plugin) {
  if (testAnswersYes()) return true;
  const { message, detail } = activationQuestion(plugin);
  showWindow();
  const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'question', buttons: ['Cancelar', 'Activar'], defaultId: 0, cancelId: 0, noLink: true, title: 'TDT local · plugins', message, detail,
  });
  return response === 1;
}

/** The question that decides whether a plugin with all the power may run: it shows the code. A native dialog: no page can answer it. */
async function askFull(plugin) {
  if (testAnswersYes()) return true;
  const { message, detail } = fullQuestion(plugin);
  showWindow();
  const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning', buttons: ['Cancelar', 'Activar con todo el poder'], defaultId: 0, cancelId: 0, noLink: true, title: 'TDT local · plugins', message, detail,
  });
  return response === 1;
}

async function setPlugin(id, on) {
  if (safeMode.safe) { // turning one on or off would write the file of choices with what safe mode shows (nothing): it is not allowed
    log('plugins', 'WARN', id + ': en modo seguro no se activa ni se apaga nada');
    return false;
  }
  const plugin = plugins.find((p) => p.id === id);
  if (!plugin || (on && plugin.problems.length)) return false;
  if (on && plugin.kind === 'ui' && !isApproved(plugin, approved)) {
    if (!(await askActivation(plugin))) {
      log('plugins', 'INFO', id + ': el usuario no lo activó');
      return false;
    }
    approved[id] = signature(plugin);
    writeApproved(approvedFile(), approved, denied);
  }
  if (on && plugin.kind === 'full' && !fullApproved(plugin, approved)) {
    if (!(await askFull(plugin))) {
      log('plugins', 'INFO', id + ': el usuario no lo activó');
      return false;
    }
    approved[id] = fullSignature(plugin);
    writeApproved(approvedFile(), approved, denied);
    log('plugins', 'WARN', `${id}: aprobado por el usuario con todo el poder (huella ${plugin.hash.slice(0, 16)})`);
  }
  if (on && plugin.kind === 'full' && plugin.scopes.includes('css')) { // there is one theme at a time: turning one on turns the other off
    for (const other of plugins) {
      if (other.id !== id && other.kind === 'full' && other.scopes.includes('css') && enabled.delete(other.id)) log('plugins', 'INFO', `${other.id}: se apaga porque ${id} es ahora el tema (solo hay uno)`);
    }
  }
  if (on) enabled.add(id);
  else enabled.delete(id);
  writeEnabled(stateFile(), enabled);
  log('plugins', 'INFO', id + (on ? ' activado' : ' desactivado'));
  buildTray();
  uiChanged();
  if (plugin.kind === 'full' && win && !win.isDestroyed()) win.webContents.reloadIgnoringCache(); // its code is handed to the page when it loads
  return true;
}

/** Take a permission away from a plugin or give it back. Giving it back asks the user when someone else than the user asked for it. */
async function setPermission(id, name, on, ask = false) {
  if (safeMode.safe) return false;
  const plugin = plugins.find((p) => p.id === id && p.kind === 'ui');
  if (!plugin || !plugin.permissions.includes(name)) return false;
  if (on && ask && !testAnswersYes()) {
    showWindow();
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'question', buttons: ['Cancelar', 'Permitir'], defaultId: 0, cancelId: 0, noLink: true, title: 'TDT local · plugins',
      message: `Volver a dar un permiso a «${plugin.name}»`, detail: `Podrá otra vez: ${describePermission(name)}.`,
    });
    if (response !== 1) return false;
  }
  const list = new Set(denied[id] || []);
  if (on) list.delete(name);
  else list.add(name);
  denied = { ...denied, [id]: [...list] };
  writeApproved(approvedFile(), approved, denied);
  log('plugins', 'INFO', `${id}: permiso ${name} ${on ? 'permitido' : 'quitado'}`);
  uiChanged(); // the plugin starts again with what it may do now
  return true;
}

async function togglePlugin(id, on) {
  const kind = (plugins.find((p) => p.id === id) || {}).kind;
  await setPlugin(id, on);
  if (win && kind !== 'ui') win.webContents.reloadIgnoringCache(); // a content script is injected when the page loads
}

function buildTray() {
  if (!tray) return;
  const items = plugins.length
    ? plugins.map((p) => ({
        label: p.problems.length ? `${p.name} (no se puede usar)` : p.name,
        type: 'checkbox',
        checked: isOn(p),
        enabled: !p.problems.length,
        toolTip: p.problems.length ? p.problems.join('\n') : p.description,
        click: (item) => togglePlugin(p.id, item.checked),
      }))
    : [{ label: 'No hay plugins', enabled: false }];
  tray.setToolTip(safeMode.safe ? 'TDT local · modo seguro' : dev.mode() ? 'TDT local · modo desarrollador' : 'TDT local');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar TDT local', click: showWindow },
    ...(dev.mode() ? [{ label: `Modo desarrollador: ${dev.count()} plugins sin aislar`, enabled: false }] : []),
    { label: 'Plugins', submenu: items },
    { label: safeMode.safe ? 'Salir del modo seguro (reinicia)' : 'Reiniciar en modo seguro (sin plugins)', click: () => restartSafe(!safeMode.safe) },
    { type: 'separator' },
    { label: 'Salir', click: () => app.quit() },
  ]));
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** A window shows only its own site: what is not allowed opens in the system browser, and no window of its own is made. */
function keepInside(contents, isOurs) {
  const outside = (address) => { if (/^https?:/.test(address)) shell.openExternal(address); };
  contents.setWindowOpenHandler(({ url }) => {
    outside(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, target) => {
    if (!isOurs(target)) {
      event.preventDefault();
      outside(target);
    }
  });
}

// How much memory and processor each plugin with a page uses: the app looks at the processes every few seconds, tells the page (for the settings and the MCP) and,
// when one goes over what is allowed, tells the page to stop its frame. In a test run the limits can be lowered with TDT_LIMIT_* (never in an installed app).
const watchLimits = limitsFrom(process.env, app.isPackaged);
const pluginWatch = createWatch(watchLimits);
function lookAtPlugins() {
  if (!win || win.isDestroyed()) return;
  let frames;
  try {
    frames = win.webContents.mainFrame.framesInSubtree.map((f) => ({ pid: f.osProcessId, url: f.url }));
  } catch {
    return; // a frame that went away while it was being read
  }
  const perPlugin = attribute(frames, app.getAppMetrics(), cpus().length); // the processor is read as a share of all the cores
  win.webContents.send('tdt:ui-metrics', perPlugin.map(({ id, memoryMB, cpuPercent, shared }) => ({ id, memoryMB, cpuPercent, shared })));
  for (const v of pluginWatch.look(perPlugin)) {
    log('plugin:' + v.id, 'WARN', `se para: ${v.reason === 'memory' ? 'memoria' : 'procesador'}: ${v.detail}`);
    win.webContents.send('tdt:ui-limit', v.id, v.reason, v.detail);
  }
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0b0d10',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // so the preload also runs in the players inside the page
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setMenu(null);
  win.on('page-title-updated', (event) => { if (dev.mode() || safeMode.safe) event.preventDefault(); }); // the title says the mode is on
  devTitle();
  watch(win.webContents, 'pagina');
  const origin = new URL(url).origin;
  // the window shows TDT local; everything else opens in the system browser
  keepInside(win.webContents, (target) => sameOrigin(target, origin));
  // a plugin with permissions stays where it is: its frame cannot go to another address (it would leave the policy of its page
  // and the permissions would no longer limit what it reaches)
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || !event.frame) return;
    const now = parseAddress(event.frame.url || '');
    if (!now) return;
    const next = parseAddress(event.url);
    if (!next || next.id !== now.id) {
      event.preventDefault();
      log('plugin:' + now.id, 'WARN', 'intentó irse a otra dirección y no se le dejó: ' + String(event.url).slice(0, 120));
    }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(url);
}

// «Explorar Atresplayer»: a window of the app on the public page «Emitido en TV (U7D)» of a channel, so that the plugin
// «atresplayer-u7d» reads the recordings from it. It is shown while it works (the cookie notice and anything else on the
// page is the user's to answer), has its own browsing data, can only go to atresplayer.com, and closes when it has read.
function exploreAtres(slug) {
  const cached = atresCache.get(slug);
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve({ items: cached.items });
  if (!plugins.some((p) => p.id === PLUGIN_ID && !p.problems.length) || !enabled.has(PLUGIN_ID)) {
    return Promise.resolve({ error: 'plugin-off', plugin: PLUGIN_ID });
  }
  if (explorer) return Promise.resolve({ error: 'busy' });
  return new Promise((resolve) => {
    const window = new BrowserWindow({
      width: 1100, height: 800, parent: win || undefined, title: 'Explorar Atresplayer · ' + slug, icon: ICON, autoHideMenuBar: true,
      webPreferences: { partition: 'persist:atresplayer', preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    window.setMenu(null);
    watch(window.webContents, 'explorar');
    log('explorar', 'INFO', 'se abre ' + listUrl(slug));
    const timer = setTimeout(() => reading.end('tiempo agotado'), 120000);
    const reading = new Reading(slug, (result) => {
      clearTimeout(timer);
      log('explorar', result.items ? 'INFO' : 'WARN', result.items ? 'leídos ' + result.items.length + ' programas de ' + slug : 'sin datos de ' + slug + ': ' + result.error);
      if (result.items) atresCache.set(slug, { at: Date.now(), items: result.items });
      explorer = null;
      if (!window.isDestroyed()) window.destroy();
      showWindow(); // the page was behind the explorer: until it is shown again the browser does not load its pictures
      resolve(result);
    });
    explorer = { win: window, reading };
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    if (!exploring) { exploring = true; watchRequests(window.webContents.session, 'red-explorar'); } // the session outlives the window
    keepInside(window.webContents, allowedAddress);
    window.on('closed', () => reading.end('ventana cerrada'));
    window.loadURL(listUrl(slug)).catch(() => reading.end('no se pudo abrir la página'));
  });
}

// Watching a recording: Atresplayer's own page of it, in a window of the app. Its embedded player does not play recordings
// (it answers 404), but the page does. The window shares its data with the explorer, so the answer to the cookie notice
// (which is the user's) is remembered; it can only go to atresplayer.com; a new recording replaces the one being watched.
function watchAtres(address, title) {
  if (watching && !watching.isDestroyed()) {
    watching.setTitle(title);
    watching.loadURL(address).catch(() => {});
    watching.show();
    watching.focus();
    log('ver', 'INFO', 'se abre ' + address);
    return;
  }
  const window = new BrowserWindow({
    width: 1100, height: 720, parent: win || undefined, title, icon: ICON, autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:atresplayer', preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  watching = window;
  window.setMenu(null);
  watch(window.webContents, 'ver');
  window.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'fullscreen'));
  if (!exploring) { exploring = true; watchRequests(window.webContents.session, 'red-explorar'); }
  keepInside(window.webContents, allowedAddress);
  window.on('closed', () => { if (watching === window) watching = null; });
  log('ver', 'INFO', 'se abre ' + address);
  window.loadURL(address).catch((error) => log('ver', 'ERROR', 'no se pudo abrir la página: ' + (error.message || error)));
}

// The preload asks which scripts belong to the frame it runs in. The address comes from Electron (the frame that
// asks), never from what the page says, and only frames of our window are answered.
ipcMain.on('tdt:plugin-scripts', (event) => {
  const frame = event.senderFrame;
  const ours = (win && !win.isDestroyed() && event.sender === win.webContents)
    || (explorer && !explorer.win.isDestroyed() && event.sender === explorer.win.webContents);
  event.returnValue = ours && frame ? scriptsFor(plugins, enabled, frame.url, frame.parent === null) : [];
});

// For development only: lets a test script drive the window (Chrome DevTools protocol, this machine only).
if (!app.isPackaged && process.env.TDT_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.TDT_DEBUG_PORT);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  // a test window is often behind others: without these, Chromium slows its frames down and the timings of the bench mean nothing
  for (const flag of ['disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding', 'disable-background-timer-throttling']) app.commandLine.appendSwitch(flag);
}

// What the settings page may ask of the app. Only the top page of our window is answered: not a frame inside it, and not
// any other address.
/** Is ``address`` on ``origin``? An address that does not even parse is not. */
function sameOrigin(address, origin) {
  try {
    return new URL(address).origin === origin;
  } catch {
    return false;
  }
}

const fromOurPage = (event) => {
  const frame = event.senderFrame;
  return !!(win && !win.isDestroyed() && server && frame && event.sender === win.webContents && frame.parent === null
    && sameOrigin(frame.url, new URL(server.url).origin));
};
ipcMain.handle('tdt:plugins-list', (event) => (fromOurPage(event) ? pluginList() : null));
ipcMain.handle('tdt:plugins-set', async (event, id, on) => {
  if (!fromOurPage(event) || typeof id !== 'string' || typeof on !== 'boolean') return null;
  await setPlugin(id, on);
  return pluginList();
});
// Making and publishing plugins with permissions: a template to start from, a `.tdtplugin` file to share and to install. The
// install only copies the folder (checked first, and shown to the user with the hash of the file): activating it is another
// question, with the permissions.
const testPick = (name) => (!app.isPackaged && process.env[name]) || ''; // tests that drive the window: never in an installed app
ipcMain.handle('tdt:plugins-new', async (event, name, rawKind) => {
  if (!fromOurPage(event) || typeof name !== 'string') return null;
  const kind = rawKind === 'full' || rawKind === 'theme' ? rawKind : 'ui'; // with permissions, with all the power, or a theme
  const id = idFromName(name, plugins.map((p) => p.id));
  const dir = join(userPluginsDir(), id);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(newPluginFiles(id, name.trim().slice(0, 60) || id, kind))) writeFileSync(join(dir, file), text, 'utf8');
  log('plugins', 'INFO', `${kind === 'theme' ? 'tema' : kind === 'full' ? 'plugin con todo el poder' : 'plugin'} nuevo «${id}» creado en ${dir}`);
  loadPlugins();
  buildTray();
  if (!testPick('TDT_TEST_NO_OPEN')) shell.openPath(dir);
  return { id, folder: dir, list: pluginList() };
});
/**
 * The same question for a package that comes from a file and from a link: what it is, who made it, what it will ask for, where it came from and its SHA-256.
 * Yes installs it (it never activates it); no leaves nothing behind. ``origin`` is the server it was downloaded from; ``pinned`` says the SHA-256 matched
 * one that was expected (typed by the user, or in a catalog).
 */
async function reviewAndInstall(buffer, { origin = '', pinned = false, skip = false, signature } = {}) {
  let seen;
  try {
    seen = inspectPackage(buffer);
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
  if (seen.plugin.problems.length) {
    discard(seen);
    return { error: 'el plugin tiene problemas: ' + seen.plugin.problems.join('; ') };
  }
  const verdict = judge(seen.id, buffer, signature, pluginKeys.all()); // who signed it, and whether it is the key this plugin already had
  if (verdict.state === 'invalid') {
    discard(seen);
    return { error: 'la firma no es válida: ' + verdict.reason, signature: { state: verdict.state, fingerprint: '' } };
  }
  const old = plugins.find((p) => p.id === seen.id);
  const full = seen.plugin.kind === 'full';
  const asks = seen.plugin.permissions.length ? seen.plugin.permissions.map((p) => `  • ${describePermission(p)}`).join('\n') : '  • ninguno';
  const preview = full ? codePreview(seen.plugin, 1200) : '';
  const detail = `${seen.plugin.author ? `De ${seen.plugin.author}. ` : ''}Versión ${seen.plugin.version || '?'}.\n`
    + (origin ? `Descargado de ${origin}.\n` : '')
    + (full
      ? `\n${isTheme(seen.plugin) ? 'Es un tema.' : 'Es un plugin con TODO el poder.'}\n${aboutPower(seen.plugin)}\n\nSolo instálalo si confías en quien lo hizo.\n\n`
      : `\nPedirá permiso para:\n${asks}\n\n`)
    + `SHA-256 del archivo:\n${seen.sha256}\n`
    + (pinned ? '(coincide con el que se esperaba)' : '(nadie la ha comprobado: compárala con la que publica su autor)') + '\n\n'
    + describeJudgement(verdict) + '\n\n'
    + (old ? `Ya hay un plugin «${old.id}» (versión ${old.version || '?'}): se reemplaza. ` : '')
    + (full ? `Instalarlo no lo activa: al activarlo se te enseñará ${isTheme(seen.plugin) ? 'su hoja de estilo' : 'su código'} y decides.` : 'Instalarlo no lo activa: al activarlo se te enseñarán los permisos y decides.')
    + (preview ? `\n\n${isTheme(seen.plugin) ? 'Su hoja de estilo' : 'Su código (page.js)'}:\n\n${preview}` : '');
  const ok = skip || (await dialog.showMessageBox(win, {
    type: full || isWarning(verdict) ? 'warning' : 'question', buttons: ['Cancelar', 'Instalar'], defaultId: 0, cancelId: 0, noLink: true, title: 'TDT local · plugins',
    message: `Instalar «${seen.plugin.name}»`, detail,
  })).response === 1;
  if (!ok) {
    discard(seen);
    return { cancelled: true };
  }
  place(seen, userPluginsDir());
  if (verdict.fingerprint) pluginKeys.remember(seen.id, verdict.fingerprint, seen.plugin.author);
  else if (verdict.state === 'unsigned-was-signed') pluginKeys.forget(seen.id); // the user saw the warning and accepted it
  log('plugins', 'INFO', `plugin «${seen.id}» ${seen.plugin.version} instalado${origin ? ' desde ' + origin : ''} (sha256 ${seen.sha256}, firma: ${verdict.state}${verdict.fingerprint ? ' ' + verdict.fingerprint : ''})`);
  loadPlugins();
  buildTray();
  uiChanged(true);
  return { id: seen.id, sha256: seen.sha256, signature: { state: verdict.state, fingerprint: verdict.fingerprint }, list: pluginList() };
}
ipcMain.handle('tdt:plugins-install', async (event) => {
  if (!fromOurPage(event)) return null;
  let file = testPick('TDT_TEST_OPEN');
  if (!file) {
    const pick = await dialog.showOpenDialog(win, { title: 'Instalar un plugin', filters: [{ name: 'Plugin de TDT local', extensions: ['tdtplugin'] }], properties: ['openFile'] });
    if (pick.canceled || !pick.filePaths[0]) return { cancelled: true };
    file = pick.filePaths[0];
  }
  let buffer;
  try {
    if (statSync(file).size > 16 * 1024 * 1024) throw new Error('el archivo pesa demasiado');
    buffer = readFileSync(file);
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
  const sigFile = file + '.sig'; // the signature next to the file, if the author published one
  const signature = existsSync(sigFile) && statSync(sigFile).size < 4096 ? readFileSync(sigFile, 'utf8') : undefined;
  return reviewAndInstall(buffer, { skip: testPick('TDT_TEST_OPEN') && testAnswersYes(), signature });
});
// From a link, or from a catalog: the link has to be https and public, the download is limited, and the question is the one of a file (plus where it came from).
// A catalog pins every file with its SHA-256: a download that does not match is refused before anything is shown. An AI cannot install: it is the user's decision.
const fetchLinked = async (rawUrl, maxBytes) => {
  const test = testPick('TDT_TEST_LINK_DIR'); // tests: a folder stands for the internet (never in an installed app); the checks of the link still apply
  if (test) {
    const check = checkLink(rawUrl);
    if (!check.ok) throw new Error(check.reason);
    return { url: check.url.href, buffer: readFileSync(join(test, basename(check.url.pathname))) };
  }
  return download(rawUrl, { maxBytes });
};
ipcMain.handle('tdt:plugins-install-link', async (event, rawUrl, rawSha, rawSignature) => {
  if (!fromOurPage(event) || typeof rawUrl !== 'string') return null;
  const expected = rawSha ? cleanSha(rawSha) : null;
  if (rawSha && !expected) return { error: 'el SHA-256 tiene que ser de 64 cifras hexadecimales' };
  let got;
  try {
    got = await fetchLinked(rawUrl, LIMITS.packageBytes);
  } catch (error) {
    return { error: 'no se pudo descargar: ' + String((error && error.message) || error) };
  }
  const digest = sha256Of(got.buffer);
  if (expected && digest !== expected) return { error: `el archivo descargado no es el que se esperaba: su SHA-256 es ${digest}` };
  // the signature: the one a catalog gave, or the file next to the package («address.sig»), if there is one; no signature is a state, not an error
  let signature = rawSignature && typeof rawSignature === 'object' ? rawSignature : undefined;
  if (!signature) {
    try {
      signature = (await fetchLinked(got.url + '.sig', 4096)).buffer.toString('utf8');
    } catch { /* not published: unsigned */ }
  }
  return reviewAndInstall(got.buffer, { origin: new URL(got.url).host, pinned: !!expected, skip: !!testPick('TDT_TEST_LINK_DIR') && testAnswersYes(), signature });
});
ipcMain.handle('tdt:catalog-load', async (event, rawUrl) => {
  if (!fromOurPage(event) || typeof rawUrl !== 'string') return null;
  let got;
  let json;
  try {
    got = await fetchLinked(rawUrl, LIMITS.catalogBytes);
    json = JSON.parse(got.buffer.toString('utf8'));
  } catch (error) {
    return { error: 'no se pudo leer el catálogo: ' + String((error && error.message) || error) };
  }
  const { entries, problems } = readCatalog(json);
  return { source: new URL(got.url).host, entries: withInstalled(entries, plugins), problems };
});
ipcMain.handle('tdt:plugins-pack', async (event, id) => {
  const plugin = fromOurPage(event) && typeof id === 'string' ? plugins.find((p) => p.id === id && (p.kind === 'ui' || p.kind === 'full')) : null;
  if (!plugin) return { error: 'solo se empaquetan plugins con permisos o con todo el poder' };
  let buffer;
  try {
    buffer = packFolder(plugin.dir, plugin.id);
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
  let target = testPick('TDT_TEST_SAVE');
  if (!target) {
    const pick = await dialog.showSaveDialog(win, {
      title: 'Empaquetar el plugin', defaultPath: `${plugin.id}-${plugin.version || '0'}.tdtplugin`, filters: [{ name: 'Plugin de TDT local', extensions: ['tdtplugin'] }],
    });
    if (pick.canceled || !pick.filePath) return { cancelled: true };
    target = pick.filePath;
  }
  writeFileSync(target, buffer);
  log('plugins', 'INFO', `plugin «${id}» empaquetado en ${target} (sha256 ${sha256(buffer)})`);
  if (!testPick('TDT_TEST_SAVE')) shell.showItemInFolder(target);
  return { saved: target, sha256: sha256(buffer), bytes: buffer.length };
});
// Plugins with permissions (api 1). The page asks which ones to show, and passes on what a plugin asks of the app that the page
// cannot do itself (its own files and the network). The permission is checked here again, against what the user approved: what
// the page says it is the plugin's is not believed.
ipcMain.handle('tdt:ui-list', (event) => (fromOurPage(event) ? uiPlugins() : []));
const fetching = new Map(); // plugin id -> requests in flight
ipcMain.handle('tdt:ui-call', async (event, id, method, args) => {
  if (!fromOurPage(event) || typeof id !== 'string' || typeof method !== 'string' || !Array.isArray(args)) return { ok: false, error: 'no permitido', code: 'E_PERMISSION' };
  const plugin = activePlugin(id);
  if (!plugin) return { ok: false, error: 'el plugin no está activado', code: 'E_UNAVAILABLE' };
  const allowed = effective(plugin);
  try {
    if (method === 'config.get' || method === 'config.all') { // the settings the user chose for this plugin: it reads them, it cannot change them
      const values = valuesOf(plugin.settings, config.get(id));
      if (method === 'config.all') return { ok: true, result: values };
      if (typeof args[0] !== 'string' || !Object.hasOwn(values, args[0])) return { ok: false, error: `no hay ningún ajuste «${String(args[0]).slice(0, 40)}»`, code: 'E_NOT_FOUND' };
      return { ok: true, result: values[args[0]] };
    }
    if (method.startsWith('storage.')) {
      if (!allowed.includes('storage')) return { ok: false, error: 'permiso denegado: storage', code: 'E_PERMISSION' };
      if (method === 'storage.get') return { ok: true, result: storage.get(id, args[0]) };
      if (method === 'storage.set') return { ok: true, result: storage.set(id, args[0], args[1]) };
      if (method === 'storage.remove') return { ok: true, result: storage.remove(id, args[0]) };
      if (method === 'storage.keys') return { ok: true, result: storage.keys(id) };
    } else if (method === 'net.fetch') {
      if (!allowed.some((p) => p.startsWith('network:'))) return { ok: false, error: 'permiso denegado: network', code: 'E_PERMISSION' };
      if ((fetching.get(id) || 0) >= 4) return { ok: false, error: 'demasiadas peticiones a la vez', code: 'E_RATE' };
      fetching.set(id, (fetching.get(id) || 0) + 1);
      try {
        const result = await pluginFetch(allowed, String(args[0]), args[1] && typeof args[1] === 'object' ? args[1] : {});
        const seen = new URL(result.url);
        const mine = activityOf(id);
        mine.fetches += 1;
        mine.bytesIn += Buffer.byteLength(result.text);
        mine.hosts = [seen.host, ...mine.hosts.filter((h) => h !== seen.host)].slice(0, 5);
        log('plugin:' + id, 'INFO', `net.fetch ${seen.host}${seen.pathname} → ${result.status}`);
        return { ok: true, result };
      } finally {
        fetching.set(id, fetching.get(id) - 1);
      }
    }
    return { ok: false, error: 'método desconocido', code: 'E_UNSUPPORTED' };
  } catch (error) {
    const message = String((error && error.message) || error).slice(0, 300);
    log('plugin:' + id, 'WARN', `${method}: ${message}`);
    return { ok: false, error: message, code: (error && error.code) || codeOf(message) };
  }
});
ipcMain.on('tdt:ui-log', (event, id, level, text) => {
  if (!fromOurPage(event) || typeof id !== 'string' || !activePlugin(id)) return;
  log('plugin:' + id, ['INFO', 'WARN', 'ERROR'].includes(level) ? level : 'INFO', String(text).slice(0, 2000));
});
/** The user (or an AI, after the user said yes) changes the settings of a plugin: all or nothing, checked against what the manifest declares. */
function setConfig(id, changes) {
  const plugin = plugins.find((p) => p.id === id && p.kind === 'ui');
  if (!plugin) return { ok: false, error: 'no hay ningún plugin con permisos con ese id' };
  const done = applyChanges(plugin.settings, config.get(id), changes);
  if (!done.ok) return done;
  config.set(id, done.values);
  log('plugins', 'INFO', `${id}: ajustes cambiados (${Object.keys(changes).join(', ')})`);
  if (win && !win.isDestroyed()) win.webContents.send('tdt:ui-config', id, done.values); // the plugin hears it (`config.changed`)
  return { ok: true, values: done.values };
}
ipcMain.handle('tdt:plugins-config', (event, id, changes) => (fromOurPage(event) && typeof id === 'string' ? setConfig(id, changes) : { ok: false, error: 'no permitido' }));
ipcMain.handle('tdt:plugins-permission', async (event, id, name, on) => {
  if (!fromOurPage(event) || typeof id !== 'string' || typeof name !== 'string' || typeof on !== 'boolean') return null;
  await setPermission(id, name, on, false); // the user clicked it in their own settings: no question
  return pluginList();
});
// What an AI asks about the plugins through the MCP (lib/plugin-admin.js): the same rules, and the questions that give power end in a
// native dialog
const pluginWriter = createPluginWriter({
  dir: userPluginsDir(),
  readPlugin,
  signature,
  approved: () => approved,
  isActive: (id) => plugins.some((p) => p.id === id && isOn(p)),
  confirmWrite: ({ message, detail, stageDir }) => confirmWriteDialog('TDT local · plugins', message, detail, stageDir),
  reload: () => { loadPlugins(); buildTray(); uiChanged(true); },
  describePermission,
  riskOf,
  log: (level, text) => log('plugins', level, text),
});
/** An AI asks to change the settings of a plugin: the values are checked first (nothing is asked if they are wrong), then the user sees each change in a native window. */
async function changeConfig(listed, values) {
  const plugin = plugins.find((p) => p.id === listed.id);
  const checked = plugin ? applyChanges(plugin.settings, config.get(plugin.id), values) : { ok: false, error: 'no hay ningún plugin con permisos con ese id' };
  if (!checked.ok) return { ok: false, detail: checked.error };
  const now = valuesOf(plugin.settings, config.get(plugin.id));
  const lines = Object.keys(values).map((k) => `  • ${plugin.settings[k].label}: «${now[k]}» → «${checked.values[k]}»`);
  if (!lines.length) return { ok: false, detail: 'no hay nada que cambiar' };
  if (!testAnswersYes()) {
    showWindow();
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'question', buttons: ['Rechazar', 'Cambiar'], defaultId: 0, cancelId: 0, noLink: true, title: 'TDT local · plugins',
      message: `Una IA quiere cambiar los ajustes de «${plugin.name}»`,
      detail: `Cambios:\n${lines.join('\n')}\n\nEl plugin solo los lee; puedes volver a cambiarlos en Ajustes ▸ Plugins.`,
    });
    if (response !== 1) return { ok: false, detail: 'el usuario no ha aceptado el cambio' };
  }
  const done = setConfig(plugin.id, values);
  return done.ok ? { ok: true, detail: 'guardados', data: { id: plugin.id, values: done.values } } : { ok: false, detail: done.error };
}
const pluginAdmin = createPluginAdmin({
  config: { change: changeConfig },
  writer: pluginWriter,
  snapshot: pluginList,
  setEnabled: async (id, on) => { await setPlugin(id, on); return !!plugins.find((p) => p.id === id && isOn(p)) === on; },
  setPermission,
  logLines: () => logbook.lines(),
});
ipcMain.handle('tdt:plugins-admin', (event, cmd) => {
  if (!fromOurPage(event)) return null;
  if (safeMode.safe && cmd && MUTATING_ADMIN.includes(cmd.do)) return { ok: false, detail: 'modo seguro: no se cambia nada de los plugins hasta salir de él (' + safeMode.text + ')' };
  return pluginAdmin.run(cmd);
});
ipcMain.handle('tdt:plugins-folder', async (event) => {
  if (!fromOurPage(event)) return false;
  mkdirSync(userPluginsDir(), { recursive: true });
  return (await shell.openPath(userPluginsDir())) === '';
});
ipcMain.handle('tdt:plugins-rescan', (event) => {
  if (!fromOurPage(event)) return null;
  loadPlugins();
  buildTray();
  uiChanged(true);
  return pluginList();
});
// Development plugins. Only the top page of our window is answered; turning the mode on and approving a plugin end in a
// native dialog that the page cannot click.
// What the page of TDT local is handed to run without isolation: the development plugins (with the developer mode on) and the plugins with all the power that are on.
ipcMain.on('tdt:dev-page-scripts', (event) => {
  event.returnValue = fromOurPage(event) && !safeMode.safe
    ? [...dev.pageScripts().map((s) => ({ ...s, source: 'dev' })), ...fullHandOver(plugins, enabled, approved, { read: readPlugin, insideOf, warn: (text, id) => log('plugin:' + id, 'WARN', text) })]
    : [];
});
ipcMain.on('tdt:dev-log', (event, id, level, text, source) => {
  if (!fromOurPage(event) || typeof id !== 'string') return;
  const where = source === 'full' ? (plugins.some((p) => p.id === id && isFullOn(p)) ? 'plugin:' + id : '') : dev.has(id) ? 'dev:' + id : '';
  if (where) log(where, ['INFO', 'WARN', 'ERROR'].includes(level) ? level : 'INFO', String(text).slice(0, 2000));
});
ipcMain.handle('tdt:dev-state', (event) => (fromOurPage(event) ? dev.view() : null));
// the commands of an AI that reach the page through the control bus (only if the server let them through)
ipcMain.handle('tdt:dev-admin', (event, cmd) => (!fromOurPage(event) ? null : safeMode.safe ? { ok: false, detail: 'modo seguro: los plugins de desarrollo no corren (' + safeMode.text + ')' } : devAdmin.run(cmd)));
ipcMain.handle('tdt:dev-mode', (event, on) => (fromOurPage(event) && !safeMode.safe && typeof on === 'boolean' ? dev.setMode(on) : null));
ipcMain.handle('tdt:dev-approve', (event, id, on) => (fromOurPage(event) && !safeMode.safe && typeof id === 'string' && typeof on === 'boolean' ? dev.approve(id, on) : null));
ipcMain.handle('tdt:dev-rescan', (event) => (fromOurPage(event) && dev.mode() ? dev.rescan() : null));
ipcMain.handle('tdt:dev-folder', async (event) => {
  if (!fromOurPage(event) || !dev.mode()) return false;
  mkdirSync(DEV_DIR, { recursive: true });
  return (await shell.openPath(DEV_DIR)) === '';
});
ipcMain.handle('tdt:atres-list', (event, slug) => {
  if (!fromOurPage(event) || !SLUGS.includes(slug)) return { error: 'no permitido' };
  return exploreAtres(slug);
});
ipcMain.handle('tdt:atres-watch', (event, address, title) => {
  const page = watchAddress(address);
  if (!fromOurPage(event) || !page) return false;
  watchAtres(page, String(title || 'Atresplayer').slice(0, 120));
  return true;
});
// what the plugin read: only from the explorer window, its top page, atresplayer.com, and with the plugin on
ipcMain.on('tdt:u7d-read', (event, msg) => {
  const frame = event.senderFrame;
  if (!explorer || event.sender !== explorer.win.webContents || !frame || frame.parent !== null
    || !allowedAddress(frame.url) || !enabled.has(PLUGIN_ID)) return;
  explorer.reading.message(msg);
});
// the log, for the settings page: read it, save it to a file the user chooses, open its folder
ipcMain.handle('tdt:logs-get', (event) => (fromOurPage(event) ? { lines: logbook.lines(1500), folder: logsDir() } : null));
ipcMain.handle('tdt:logs-save', async (event) => {
  if (!fromOurPage(event)) return { saved: '' };
  const pick = await dialog.showSaveDialog(win, { defaultPath: 'tdt-local-registro.txt', filters: [{ name: 'Texto', extensions: ['txt', 'log'] }] });
  if (pick.canceled || !pick.filePath) return { saved: '' };
  const head = ['TDT local ' + app.getVersion() + ' · Electron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome + ' · ' + process.platform + ' ' + process.arch, ''];
  writeFileSync(pick.filePath, head.concat(logbook.lines()).join('\n') + '\n', 'utf8');
  return { saved: pick.filePath };
});
ipcMain.handle('tdt:logs-folder', async (event) => {
  if (!fromOurPage(event)) return false;
  mkdirSync(logsDir(), { recursive: true });
  return (await shell.openPath(logsDir())) === '';
});
let confirming = false; // one question at a time: an AI cannot pile windows on the user
ipcMain.handle('tdt:confirm', async (event, message, detail) => {
  if (!fromOurPage(event) || typeof message !== 'string' || typeof detail !== 'string' || confirming) return false;
  if (testAnswersYes()) return true;
  confirming = true;
  try {
    showWindow();
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning', buttons: ['Rechazar', 'Aceptar'], defaultId: 0, cancelId: 0, noLink: true, title: 'TDT local',
      message: message.slice(0, 200), detail: detail.slice(0, 3000),
    });
    return response === 1;
  } finally {
    confirming = false;
  }
});
ipcMain.handle('tdt:reload', (event) => {
  if (!fromOurPage(event)) return false;
  win.webContents.reloadIgnoringCache();
  return true;
});

/** Start again in safe mode, or out of it. A clean exit is marked first (leaving it must not count as a bad exit); a test run can skip the new start. */
function restartSafe(safe) {
  if (quitting) return;
  quitting = true;
  crashGuard.cleanExit();
  if (!(!app.isPackaged && process.env.TDT_TEST_NO_RELAUNCH)) app.relaunch({ args: relaunchArgs(process.argv.slice(1), safe) });
  storage.flush();
  Promise.resolve(dev.stop()).catch(() => {}).then(() => (server ? stopServer(server) : null)).finally(() => app.exit(0));
}
ipcMain.handle('tdt:safe-restart', (event, safe) => {
  if (!fromOurPage(event) || typeof safe !== 'boolean') return false;
  restartSafe(safe);
  return true;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    // Permissions a site could ask for (camera, location, notifications...) are all refused; the page needs none.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'fullscreen'));
    watchRequests(session.defaultSession, 'red');
    // The page of TDT local may frame the players of the plugins that run, and only those: the policy of the server (which does not know
    // the plugins) is widened here, for its own pages, with the servers the user approved with «embed:server».
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = details.responseHeaders || {};
      const hosts = server && details.url.startsWith(server.url) ? embedHosts(plugins.filter(isActive), effective) : [];
      if (hosts.length) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'content-security-policy') {
            headers[key] = headers[key].map((policy) => policy.replace(/frame-src /, 'frame-src ' + hosts.map((h) => 'https://' + h).join(' ') + ' '));
          }
        }
      }
      callback({ responseHeaders: headers });
    });
    session.defaultSession.protocol.handle(SCHEME, (request) => {
      try {
        const { status, headers, body } = servePlugin(request.url, { lookup: activePlugin, sdkFile: join(here, 'sdk', 'tdt-sdk.js'), insideOf });
        return new Response(body, { status, headers });
      } catch (error) {
        log('plugins', 'ERROR', 'no se pudo servir un plugin: ' + String((error && error.message) || error).slice(0, 200));
        return new Response('error', { status: 500 });
      }
    });
    logbook = new Logbook({ file: join(logsDir(), 'tdt-local.log') });
    log('app', 'INFO', 'TDT local ' + app.getVersion() + ' · Electron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome
      + ' · ' + process.platform + ' ' + process.arch + (app.isPackaged ? '' : ' · desarrollo'));
    // how did the last run end? Two bad exits in a row, a flag or a variable: safe mode (no plugin runs)
    safeMode = decide({ argv: process.argv.slice(1), env: process.env, unclean: crashGuard.start() });
    if (safeMode.safe) log('app', 'WARN', 'MODO SEGURO: ' + safeMode.text + '. Ningún plugin corre; lo que habías activado sigue guardado.');
    loadPlugins();
    if (!safeMode.safe) dev.init();
    try {
      const portFile = join(app.getPath('userData'), 'port.json');
      const remembered = readPort(portFile);
      server = await startServer(serverCommand(), {
        onLine: (line) => log('servidor', levelOf(line), line),
        ports: [remembered, ...PREFERRED_PORTS],
      });
      if (remembered && server.port !== remembered) {
        log('app', 'WARN', 'el puerto ' + remembered + ' estaba ocupado: se usa el ' + server.port + ' y la página empieza sin lo que guardó');
      }
      writePort(portFile, server.port);
      log('app', 'INFO', 'servidor listo en ' + server.url);
    } catch (error) {
      log('app', 'ERROR', 'el servidor no arrancó: ' + (error.message || error));
      console.error(error);
      const { dialog } = await import('electron');
      dialog.showErrorBox('TDT local no pudo arrancar', String(error.message || error));
      app.exit(1);
      return;
    }
    server.child.once('exit', (code) => {
      log('app', quitting ? 'INFO' : 'WARN', 'el servidor se cerró (código ' + code + ')');
      if (!quitting) app.quit();
    }); // the «Salir» button of the page stops the server
    createWindow(server.url);
    setInterval(lookAtPlugins, watchLimits.everyMs);
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 24, height: 24 }));
    tray.setToolTip('TDT local');
    tray.on('click', showWindow);
    buildTray();
    if (!safeMode.safe) dev.start().catch((error) => log('dev', 'ERROR', 'no se pudieron arrancar: ' + ((error && error.message) || error)));
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting || !server) return;
    quitting = true;
    event.preventDefault();
    storage.flush(); // what the plugins saved in the last half second
    dev.stop().catch(() => {}).then(() => stopServer(server)).finally(() => { crashGuard.cleanExit(); app.exit(0); });
  });
}
