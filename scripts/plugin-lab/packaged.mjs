// The PACKAGED app (what the installer puts on the machine), looked at from outside: it has no debug port and no test answers (those only exist when the app runs from the source), so
// the only way in is what a user or an AI client has: the page it serves and the MCP over HTTP with the token.
//
//   node scripts/plugin-lab/packaged.mjs ["dist/electron/TDT local-win32-x64/tdt-local.exe"]        (after `python packaging/build.py`)
//
// It starts the app with a temporary data folder and the access of AIs on (level «dev»), and a window opens, as for any user. It checks that the files of the interface and of the plugins that come
// with the app are in the package, that the page runs (it publishes its state to the bus: that only happens if app.js and the included plugins loaded), that the plugins and the hooks answer, and that the
// writer of plugins works through the preload of the packaged app (`dry_run` asks nothing: the native questions cannot be answered by a script, and that is by design).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = process.argv[2] || join(ROOT, 'dist', 'electron', 'TDT local-win32-x64', 'tdt-local.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = mkdtempSync(join(tmpdir(), 'tdt-packaged-'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

if (!existsSync(exe)) {
  console.log(`no existe ${exe}: construye antes con «python packaging/build.py»`);
  process.exit(2);
}
const app = spawn(exe, [], {
  env: { ...process.env, TDT_DATA_DIR: data, TDT_CONTROL_ENABLED: '1', TDT_CONTROL_LEVEL: 'dev' },
  stdio: 'ignore',
});

const stop = async () => {
  try { app.kill(); } catch { /* gone */ }
  if (process.platform === 'win32') { // the window and the frozen server are children of the app
    await new Promise((r) => spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }).on('close', r));
  }
  await sleep(1500);
  rmSync(data, { recursive: true, force: true });
};

try {
  const portFile = join(data, 'desktop', 'port.json');
  const tokenFile = join(data, 'control-token');
  for (let i = 0; i < 120 && !(existsSync(portFile) && existsSync(tokenFile)); i++) await sleep(500);
  if (!existsSync(portFile)) throw new Error('la aplicación empaquetada no arrancó (no hay port.json)');
  const base = `http://127.0.0.1:${JSON.parse(readFileSync(portFile, 'utf8')).port}`;
  const token = readFileSync(tokenFile, 'utf8').trim();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/')).ok) break; } catch { /* not yet */ } await sleep(500); }

  // 1. what is in the package
  const get = async (path) => { const r = await fetch(base + path); return { status: r.status, text: await r.text() }; };
  check('sirve la página', (await get('/')).status === 200);
  for (const path of ['/js/hooks.js', '/js/lib/hooks.js', '/js/lib/trusted.js', '/js/lib/overlays.js', '/js/styles.js', '/js/core-plugins.js', '/plugins/ads/page.js', '/plugins/ads/plugin.json', '/commands.json', '/plugin-api.json']) {
    const r = await get(path);
    check(`el paquete lleva ${path}`, r.status === 200 && r.text.length > 20, 'HTTP ' + r.status);
  }
  const csp = (await fetch(base + '/')).headers.get('content-security-policy') || '';
  check('la política de la página permite fuentes data: (para los temas)', /font-src 'self' data:/.test(csp));

  // 2. the MCP over HTTP, with the token
  let id = 0;
  const rpc = async (method, params = {}) => {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    return r.json();
  };
  const tool = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { error: !!(r.error || (r.result && r.result.isError)), data: r.result && r.result.structuredContent, text: r.result && r.result.content && r.result.content[0] && r.result.content[0].text, raw: r };
  };
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packaged.mjs', version: '1' } });
  check('el servidor MCP contesta y dice su versión', !!(init.result && init.result.serverInfo), init.result && JSON.stringify(init.result.serverInfo));
  const tools = await rpc('tools/list');
  check('ofrece las 30 herramientas', tools.result && tools.result.tools.length === 30, String(tools.result && tools.result.tools.length));

  // the page of the window publishes its state to the bus a few times a second: it only does if app.js and the plugins included with the app loaded
  let state = null;
  for (let i = 0; i < 40 && !(state && state.data && state.data.kind); i++) { state = await tool('tdt_state'); if (!(state.data && state.data.kind)) await sleep(1000); }
  check('la página de la ventana corre y publica su estado (app.js y los plugins incluidos cargaron)', !!(state && state.data && state.data.kind), JSON.stringify(state && state.data).slice(0, 100));
  const vol = await tool('tdt_set_volume', { value: 0.4 });
  await sleep(1500);
  const after = await tool('tdt_state');
  check('una orden llega a la página y la cambia', !vol.error && after.data && after.data.vol && Math.abs(after.data.vol.v - 0.4) < 0.011, JSON.stringify(after.data && after.data.vol));
  const events = await tool('tdt_events', { name: 'volume.changed' });
  check('el bus de eventos ve el cambio (con prioridad y ganchos en medio)', !events.error && JSON.stringify(events.data).includes('volume.changed'));
  const spec = await tool('tdt_commands');
  check('la lista única de órdenes y eventos trae los de publicidad', !spec.error && JSON.stringify(spec.data).includes('ad.started') && JSON.stringify(spec.data).includes('ad.ended'));

  // 3. the plugins, through the preload of the packaged app
  const plugins = await tool('tdt_plugins');
  const list = (plugins.data && (plugins.data.plugins || plugins.data)) || [];
  check('la lista de plugins sale y trae los que vienen incluidos', !plugins.error && JSON.stringify(plugins.data).includes('atresplayer-u7d'), JSON.stringify(plugins.data).slice(0, 120));
  const theme = { 'manifest.json': JSON.stringify({ name: 'Empaquetado', version: '0.1.0', tdt: { api: 1, full: { css: 'tema.css' } } }), 'tema.css': ':root { --accent: #c0392b; }\n' };
  const dry = await tool('tdt_plugin_write', { id: 'empaquetado', files: theme, dry_run: true });
  check('el escritor de plugins funciona en la aplicación empaquetada: un tema pasa dry_run y es un tema', !dry.error && JSON.stringify(dry.data).includes('"theme":true'), dry.text && dry.text.slice(0, 120));
  const bad = await tool('tdt_plugin_write', { id: 'roto', files: { 'manifest.json': JSON.stringify({ name: 'x', tdt: { api: 1, full: { page: 'page.js' } } }), 'page.js': 'esto no es js (' }, dry_run: true });
  check('y rechaza un código con un error de sintaxis, diciendo la línea', bad.error && /sintaxis/.test(JSON.stringify(bad.raw)), JSON.stringify(bad.raw).slice(0, 140));

  // 4. what the app wrote in its log
  const logsDir = join(data, 'desktop', 'logs');
  const lines = existsSync(logsDir) ? readdirSync(logsDir).filter((f) => f.endsWith('.log')).flatMap((f) => readFileSync(join(logsDir, f), 'utf8').split('\n')) : [];
  // the app logs as an error a command it refused: the one this test provoked on purpose («roto») is not a fault, and the requests of the players to the network are not the app's
  const errors = lines.filter((l) => /\bERROR\b/.test(l) && !/atresplayer|ERR_|net::/i.test(l) && !l.includes('plugin_write {"id": "roto"'));
  check('el registro de la aplicación no tiene errores propios', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300) || `${lines.length} líneas`);
} catch (error) {
  check('la prueba termina sin error', false, String((error && error.message) || error));
}
await stop();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} comprobaciones bien` + (failed.length ? `; FALLAN: ${failed.map((r) => r.name).join(' | ')}` : ''));
process.exit(failed.length ? 1 : 0);
