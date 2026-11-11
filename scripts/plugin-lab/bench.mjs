// The test bench of the plugins: the real desktop app, plugins that misbehave on purpose, and thresholds that fail.
//
//   node scripts/plugin-lab/bench.mjs            (from the root of the repository; needs `npm install` in desktop/)
//
// It starts the app with a temporary data folder and the plugins of ./plugins, and checks what docs/PLUGINS-ARQUITECTURA.md says a
// plugin cannot do to the app: freeze it, flood it, hide its own failure, keep what it should not, or outlive what the user turned off.
// It also asks, through the control bus and the MCP, what an AI would ask. It prints one line per check and exits with 1 if any fails.
// Nothing is changed outside the temporary folder. It does not run in the CI (it needs a screen and several minutes).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packFolder } from '../../desktop/lib/plugin-pack.js';
import { generateKeys, signPackage } from '../../desktop/lib/plugin-sign.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.BENCH_DEBUG_PORT || 9711);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = mkdtempSync(join(tmpdir(), 'tdt-bench-'));
const data = join(base, 'data');
const plugins = join(base, 'plugins');
cpSync(join(ROOT, 'scripts', 'plugin-lab', 'plugins'), plugins, { recursive: true });
// the «internet» of the install-from-link check: a folder with a packaged plugin and the catalog that lists it (the app reads it instead of the network
// only in a test run, and the checks of the link still apply)
const linkDir = join(base, 'internet');
mkdirSync(linkDir, { recursive: true });
const packed = packFolder(join(ROOT, 'scripts', 'plugin-lab', 'plugins', 'tema'), 'tema-catalogo');
const packedSha = createHash('sha256').update(packed).digest('hex');
writeFileSync(join(linkDir, 'tema-catalogo.tdtplugin'), packed);
// signed packages: the same plugin id in three versions (signed by A, signed by B, not signed) and one whose signature belongs to another file
const keysA = generateKeys();
const keysB = generateKeys();
const version = (n) => {
  const copy = join(base, `firmado-v${n}`);
  cpSync(join(ROOT, 'scripts', 'plugin-lab', 'plugins', 'tema'), copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8'));
  manifest.version = String(n);
  manifest.author = 'Autora de prueba';
  writeFileSync(join(copy, 'manifest.json'), JSON.stringify(manifest));
  return packFolder(copy, 'firmado-uno');
};
const [v1, v2, v3] = [version(1), version(2), version(3)];
writeFileSync(join(linkDir, 'firmado-uno-1.tdtplugin'), v1);
writeFileSync(join(linkDir, 'firmado-uno-1.tdtplugin.sig'), JSON.stringify(signPackage(v1, keysA)));
writeFileSync(join(linkDir, 'firmado-uno-2.tdtplugin'), v2);
writeFileSync(join(linkDir, 'firmado-uno-2.tdtplugin.sig'), JSON.stringify(signPackage(v2, keysB)));
writeFileSync(join(linkDir, 'firmado-uno-3.tdtplugin'), v3);
writeFileSync(join(linkDir, 'firmado-dos.tdtplugin'), packFolder(join(ROOT, 'scripts', 'plugin-lab', 'plugins', 'tema'), 'firmado-dos'));
writeFileSync(join(linkDir, 'firmado-dos.tdtplugin.sig'), JSON.stringify(signPackage(v1, keysA))); // the signature of another file
writeFileSync(join(linkDir, 'index.json'), JSON.stringify({ plugins: [
  { id: 'tema-catalogo', name: 'Tema de catálogo', author: 'Banco', version: '1', description: 'Un tema', url: 'https://plugins.example.org/tema-catalogo.tdtplugin', sha256: packedSha, permissions: [] },
  { id: 'sin-hash', name: 'Sin hash', url: 'https://plugins.example.org/sin-hash.tdtplugin' },
] }));

// what each check must reach: if the app gets worse than this, the bench fails
const LIMITS = {
  pageResponseMs: 250, // the page answers within this while a plugin hogs the CPU or floods it
  storageSetMs: 1.5, // one storage.set (it was 3.4 ms when each one rewrote the file)
  detectSeconds: 25, // a plugin that hangs is marked within this
  recoverSeconds: 12, // and is marked running again within this after it answers
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const app = spawn(join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), ['.'], {
  cwd: join(ROOT, 'desktop'),
  env: {
    ...process.env, TDT_DEBUG_PORT: String(PORT), TDT_DATA_DIR: data, TDT_PLUGINS_DIR: plugins, TDT_DEV_CONFIRM: 'yes', TDT_TEST_LINK_DIR: linkDir,
    TDT_LIMIT_MEMORY_MB: '350', TDT_LIMIT_CPU_SECONDS: '30', TDT_LIMIT_EVERY_MS: process.env.BENCH_LIMIT_EVERY || '2000', // lowered for the test: the hang check burns 26 s on purpose and must not trip it
    TDT_CONTROL_ENABLED: '1', TDT_CONTROL_LEVEL: 'dev',
  },
  stdio: 'ignore',
});

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
function connect(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let n = 0;
    const waiting = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
    const send = (method, params = {}, timeout = 30000) => new Promise((r) => {
      const id = ++n;
      const timer = setTimeout(() => { waiting.delete(id); r({ timeout: true }); }, timeout);
      waiting.set(id, (d) => { clearTimeout(timer); r(d); });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const ev = async (expression, timeout) => {
      const d = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
      if (d.timeout) return 'TIMEOUT';
      const r = d.result;
      return r.exceptionDetails ? 'EXC ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result.value;
    };
    ws.onopen = () => resolve({ ws, send, ev });
  });
}
const finish = async () => {
  try { // what the watch of memory and processor stopped, if anything: it explains checks that failed for no other reason
    const stopped = readFileSync(join(data, 'desktop', 'logs', 'tdt-local.log'), 'utf8').split('\n').filter((l) => /se para:|parado por pasarse/.test(l));
    if (stopped.length) console.log('\nParado por los límites:\n' + stopped.join('\n'));
  } catch { /* no log */ }
  app.kill();
  await sleep(1500);
  rmSync(base, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} de ${results.length} comprobaciones bien` + (failed.length ? `; FALLAN: ${failed.map((r) => r.name).join(' | ')}` : ''));
  process.exit(failed.length ? 1 : 0);
};

let page;
for (let i = 0; i < 120 && !page; i++) {
  await sleep(500);
  try { page = (await targets()).find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:')); } catch { /* not yet */ }
}
if (!page) { console.log('FAIL  la aplicación no arrancó'); await finish(); }
const ui = await connect(page.webSocketDebuggerUrl);
await sleep(4000);
const server = new URL(page.url).origin;
// The frame of a plugin may not be listed yet (the page is busy, or the frame was just made): it is looked for for a few seconds before giving up.
const plugin = async (id, seconds = 10) => {
  for (let t = 0; t <= seconds * 1000; t += 500) {
    const found = (await targets()).find((x) => x.url.startsWith(`tdt-plugin://${id}/`));
    if (found) return connect(found.webSocketDebuggerUrl);
    await sleep(500);
  }
  return null;
};
const status = async () => JSON.parse(await ui.ev("import('/js/plugin-host.js').then((m) => JSON.stringify(m.pluginHost().status()))"));
const stateOf = async (id) => (await status()).find((s) => s.id === id)?.state ?? 'absent';
const waitFor = async (fn, seconds) => {
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    if (await fn()) return (Date.now() - start) / 1000;
    await sleep(500);
  }
  return null;
};
const latency = async (n = 8) => {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const r = await ui.ev('1+1', 5000);
    times.push(r === 'TIMEOUT' ? 5000 : Date.now() - t0);
    await sleep(120);
  }
  return Math.max(...times);
};

// the public list is downloaded when the data folder is new: until it has arrived the page may still put a channel on by itself, which is an
// event that would wake a service or move a volume in the middle of a check. Wait for it, and for the page to settle.
await waitFor(async () => (await ui.ev("import('/js/state.js').then((m) => m.state.channels.length)")) > 100, 90);
await sleep(5000);
for (const id of ['ticker', 'ticker-screen', 'hostile', 'sinsdk']) await ui.ev(`window.tdtDesktop.plugins.setEnabled(${JSON.stringify(id)}, true)`);
await sleep(4000);
const hostile = await plugin('hostile');
const ticker = await plugin('ticker');

// 1. a plugin that hogs the CPU does not freeze the interface
hostile.send('Runtime.evaluate', { expression: 'setTimeout(() => window.busy(6000), 0); 1' });
await sleep(400);
const hog = await latency(10);
check('un plugin que gasta CPU no congela la interfaz', hog < LIMITS.pageResponseMs, `respuesta máxima ${hog} ms (tope ${LIMITS.pageResponseMs})`);
await sleep(6500);

// 2. a plugin that calls too fast is stopped, and the interface keeps up
const flood = hostile.ev('callMany(3000)', 60000);
const underFlood = await latency(8);
const codes = JSON.parse(await flood);
check('una ráfaga de 3000 llamadas se frena con E_RATE', (codes.E_RATE || 0) > 0 && (codes.OK || 0) > 0, JSON.stringify(codes));
check('la interfaz aguanta la ráfaga', underFlood < LIMITS.pageResponseMs, `respuesta máxima ${underFlood} ms`);
await sleep(2500);
check('pasado un momento, las llamadas vuelven a valer', (await hostile.ev('code(() => tdt.player.state())')) === 'OK');

// 3. errors can be told apart
check('E_INVALID: un argumento que no vale', (await hostile.ev('code(() => tdt.storage.get(5))')) === 'E_INVALID');
check('E_UNSUPPORTED: un método que no existe', (await hostile.ev('code(() => new Promise((ok, no) => { const id = 77; addEventListener("message", function f(e) { if (e.data && e.data.id === id) { removeEventListener("message", f); e.data.ok ? ok() : no({ code: e.data.code }); } }); parent.postMessage({ tdt: 1, id, method: "sistema.formatear", args: [] }, "*"); }))')) === 'E_UNSUPPORTED');
check('E_PERMISSION: sin el permiso', (await hostile.ev('code(() => tdt.player.play("La 2"))')) === 'E_PERMISSION');
check('E_PERMISSION: una red que no declaró', (await hostile.ev('code(() => tdt.net.fetch("https://example.com/"))')) === 'E_PERMISSION');
check('E_INVALID: una clave de almacenamiento fuera de las reglas', (await hostile.ev('code(() => tdt.storage.set("../x", 1))')) === 'E_INVALID');
check('E_QUOTA: un valor demasiado grande', (await hostile.ev('code(() => tdt.storage.set("grande", "x".repeat(70000)))')) === 'E_QUOTA');

// 4. the storage is fast and what it keeps is counted
const per = parseFloat(await hostile.ev("bench('storage.set', 200, 'k{i}', 1)", 60000));
check('el almacenamiento no reescribe el disco en cada llamada', per < LIMITS.storageSetMs, `${per} ms por storage.set (tope ${LIMITS.storageSetMs})`);

// 5. a plugin that hangs is seen, and is seen again when it answers
// the heartbeat does not ask a window that is hidden (a slow answer from it is not a hang): the checks below need the window to be seen
await ui.send('Page.bringToFront');
await ui.send('Emulation.setFocusEmulationEnabled', { enabled: true }); // the page counts as focused even if another window has the focus of the system
await sleep(1000);
check('la ventana de la aplicación está visible (si no, el latido no pregunta y estas pruebas no valen)', (await ui.ev('document.hidden')) === false, 'document.hidden = ' + (await ui.ev('document.hidden')));
await sleep(1000);
check('un plugin sano figura en marcha', (await stateOf('hostile')) === 'running');
hostile.send('Runtime.evaluate', { expression: 'setTimeout(() => window.busy(26000), 0); 1' });
const seen = await waitFor(async () => (await stateOf('hostile')) === 'unresponsive', LIMITS.detectSeconds);
check('un plugin colgado se marca «no responde»', seen !== null, seen === null ? 'no se marcó' : `a los ${seen.toFixed(1)} s (tope ${LIMITS.detectSeconds})`);
check('y los demás plugins no se ven afectados', (await stateOf('ticker')) === 'running');
const back = await waitFor(async () => (await stateOf('hostile')) === 'running', 26 + LIMITS.recoverSeconds);
check('cuando vuelve a contestar, vuelve a figurar en marcha', back !== null, back === null ? 'no volvió' : `${back.toFixed(1)} s después`);
const log1 = readFileSync(join(data, 'desktop', 'logs', 'tdt-local.log'), 'utf8');
check('el Registro lo cuenta', /\[plugin:hostile\] no responde/.test(log1) && /\[plugin:hostile\] vuelve a responder/.test(log1));

// 6. a plugin that falls is seen too, and reloading brings it back
const frame = (await targets()).find((x) => x.url.startsWith('tdt-plugin://ticker/'));
const victim = await connect(frame.webSocketDebuggerUrl);
victim.send('Page.crash').catch(() => {});
const noticed = await waitFor(async () => (await stateOf('ticker')) === 'unresponsive', LIMITS.detectSeconds);
check('un plugin cuyo proceso cae se marca «no responde»', noticed !== null, noticed === null ? 'no se marcó' : `a los ${noticed.toFixed(1)} s`);
await ui.ev("import('/js/plugin-host.js').then((m) => m.pluginHost().reload('ticker'))");
check('recargarlo lo trae de vuelta', (await waitFor(async () => (await stateOf('ticker')) === 'running', 15)) !== null);

// a page that never loads the SDK cannot answer «are you there?»: it is not flagged
await sleep(1000);
check('una página que no carga el SDK no se marca como colgada, y se dice que no se vigila', (await stateOf('sinsdk')) === 'running' && (await status()).find((s) => s.id === 'sinsdk').monitored === false);

// 7. a screen that is closed has no frame at all
const hasFrame = async (id) => (await targets()).some((x) => x.url.startsWith(`tdt-plugin://${id}/`));
check('una pantalla cerrada no tiene marco (no gasta un proceso)', !(await hasFrame('ticker-screen')));
await ui.ev("document.querySelector('.controls button[data-plugin=\"ticker-screen\"]').click()");
await sleep(2000);
check('al abrirla se crea', await hasFrame('ticker-screen'));
await ui.ev("document.querySelector('.plugin-screen-head button:last-child').click()");
await sleep(1500);
check('al cerrarla se destruye', !(await hasFrame('ticker-screen')));

// 8. the user can turn one permission off without turning the plugin off
await ui.ev("window.tdtDesktop.plugins.setPermission('hostile', 'storage', false)");
await sleep(3500);
const hostile2 = await plugin('hostile');
const off = await hostile2.ev('code(() => tdt.storage.set("k1", 1))');
check('un permiso quitado hace fallar esa llamada con E_PERMISSION', off === 'E_PERMISSION', off);
const why = await hostile2.ev('tdt.storage.set("k1", 1).catch((e) => e.message)');
check('y el mensaje dice que lo quitó el usuario', /el usuario lo ha desactivado/.test(why), why);
check('sin quitar el plugin: sigue en marcha', (await stateOf('hostile')) === 'running');

// 9. an AI asks through the control bus and the MCP
const token = readFileSync(join(data, 'control-token'), 'utf8').trim();
const bus = async (cmd) => (await fetch(`${server}/api/control/v1/command`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) })).json();
const list = await bus({ do: 'plugin_list' });
const mine = list.data && list.data.plugins.find((p) => p.id === 'hostile');
check('plugin_list (nivel read): cada plugin con estado, permisos y actividad', !!mine && mine.runtime.state === 'running' && mine.permissions.some((p) => p.name === 'storage' && p.granted === false) && mine.activity !== undefined,
  mine ? `${mine.runtime.state}, ${mine.runtime.calls} llamadas, ${mine.runtime.restarts} reinicios` : JSON.stringify(list).slice(0, 120));
check('plugin_list dice cuántas llamadas se frenaron', mine && mine.runtime.limited >= 0 && mine.runtime.calls > 100);
const logs = await bus({ do: 'plugin_logs', id: 'hostile', limit: 20 });
check('plugin_logs: el Registro del plugin', logs.ok && logs.data.lines.length > 0 && logs.data.lines.every((l) => /hostile/.test(l)), `${logs.data?.lines.length} líneas`);
const mcp = async (name, args = {}) => (await (await fetch(`${server}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
const viaMcp = await mcp('tdt_plugins');
check('MCP tdt_plugins devuelve lo mismo', viaMcp && !viaMcp.isError && viaMcp.structuredContent.plugins.some((p) => p.id === 'hostile' && p.runtime), '');
const apiSpec = await mcp('tdt_plugin_api', { method: 'storage.set' });
check('MCP tdt_plugin_api devuelve la especificación', apiSpec && apiSpec.structuredContent.permission === 'storage');
check('MCP: dar un permiso de vuelta (pide al usuario; aquí se acepta)', (await mcp('tdt_plugin_permission', { id: 'hostile', permission: 'storage', on: true })).isError === false);
await sleep(3500);
const saved = await (await plugin('hostile')).ev('code(() => tdt.storage.set("k1", 1))');
check('el plugin vuelve a poder guardar', saved === 'OK', saved);
check('MCP: desactivar un plugin', (await mcp('tdt_plugin_disable', { id: 'hostile' })).isError === false);
await sleep(1500);
check('el plugin desactivado ya no tiene marco', !(await hasFrame('hostile')));
check('MCP: activarlo otra vez (pregunta al usuario; aquí se acepta)', (await mcp('tdt_plugin_enable', { id: 'hostile' })).isError === false);
await sleep(3000);
check('y vuelve a correr', (await stateOf('hostile')) === 'running');

// 10. an AI writes a plugin through the MCP: checks first, the user decides, nothing is activated by writing, and it can be edited live
const sample = (name) => readFileSync(join(ROOT, 'docs', 'ejemplos', 'saludo', name), 'utf8');
const files = { 'manifest.json': sample('manifest.json'), 'index.html': sample('index.html'), 'app.js': sample('app.js') };
const wrong = await mcp('tdt_plugin_write', { id: 'saludo', files: { ...files, 'app.js': 'const x = ;' }, dry_run: true });
check('escribir: un error de sintaxis vuelve a la IA con su línea, sin molestar al usuario', wrong.isError === true && /app\.js:1/.test(wrong.content[0].text), wrong.content[0].text.slice(0, 90));
const badManifest = await mcp('tdt_plugin_write', { id: 'saludo', files: { ...files, 'manifest.json': JSON.stringify({ name: 'X', tdt: { api: 1, permissions: ['disco'] } }) }, dry_run: true });
check('escribir: un permiso que no existe se rechaza al comprobar', badManifest.isError === true && /permiso desconocido/.test(badManifest.content[0].text));
const dry = await mcp('tdt_plugin_write', { id: 'saludo', files, dry_run: true });
check('escribir: un plugin bueno pasa la comprobación sin avisos y sin escribir nada', dry.isError === false && dry.structuredContent.valid === true && dry.structuredContent.warnings.length === 0);
const userPlugins = join(data, 'desktop', 'plugins');
check('...y no ha creado la carpeta', !(await import('node:fs')).existsSync(join(userPlugins, 'saludo')));
const wrote = await mcp('tdt_plugin_write', { id: 'saludo', files });
check('escribir: se escribe tras la confirmación (aquí se acepta)', wrote.isError === false && wrote.structuredContent.written.length === 3, wrote.isError ? wrote.content[0].text : '');
check('escribir NO activa el plugin', wrote.structuredContent.active === false && !(await hasFrame('saludo')));
const read = await mcp('tdt_plugin_read', { id: 'saludo' });
check('leer: devuelve los archivos para poder cambiarlos', read.isError === false && read.structuredContent.files['app.js'] === files['app.js']);
check('el plugin nuevo aparece en tdt_plugins, sin activar', (await mcp('tdt_plugins')).structuredContent.plugins.some((p) => p.id === 'saludo' && p.enabled === false));
check('activarlo (pregunta al usuario; aquí se acepta)', (await mcp('tdt_plugin_enable', { id: 'saludo' })).isError === false);
await sleep(3500);
check('y corre', (await stateOf('saludo')) === 'running' && (await hasFrame('saludo')));
const live = await plugin('saludo');
check('el plugin hace lo que dice el código', typeof (await live.ev("document.getElementById('canal').textContent")) === 'string' && (await live.ev("document.getElementById('saludar').textContent")) === 'Saludar');
const edited = await mcp('tdt_plugin_write', { id: 'saludo', files: { 'index.html': files['index.html'].replace('>Saludar<', '>Di hola<') } });
check('cambiar el código con los mismos permisos lo recarga solo', edited.isError === false && edited.structuredContent.active === true && /recargado/.test(edited.structuredContent.next));
await sleep(3500);
check('...y corre el código nuevo', (await (await plugin('saludo')).ev("document.getElementById('saludar').textContent")) === 'Di hola');
const withWarning = await mcp('tdt_plugin_write', { id: 'saludo', files: { 'app.js': files['app.js'] + "\nfetch('x.json');\n" } });
check('un aviso no impide escribir, pero se le dice a la IA', withWarning.isError === false && withWarning.structuredContent.warnings.some((w) => /fetch\(\)/.test(w)));
const manifest = JSON.parse(files['manifest.json']);
manifest.tdt.permissions.push('storage');
const more = await mcp('tdt_plugin_write', { id: 'saludo', files: { 'manifest.json': JSON.stringify(manifest) } });
check('pedir un permiso nuevo deja el plugin sin activar hasta que el usuario lo apruebe', more.isError === false && more.structuredContent.active === false && /tdt_plugin_enable/.test(more.structuredContent.next));
await sleep(2500);
check('...y deja de correr', !(await hasFrame('saludo')));
check('volver a activarlo con el permiso nuevo', (await mcp('tdt_plugin_enable', { id: 'saludo' })).isError === false);
await sleep(3000);
check('...y vuelve a correr', (await stateOf('saludo')) === 'running');
check('no queda ninguna carpeta temporal', !(await import('node:fs')).readdirSync(join(data, 'desktop')).some((n) => n.startsWith('plugin-staging-')));

// 11. the headers of a channel: the user edits them in the dialog and an AI through the MCP (what an origin receives is checked by the Python tests:
// the proxy of the real app does not reach a server on this machine)
const added = await (await fetch(`${server}/api/custom`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Canal de prueba', sources: ['https://directo.ejemplo.invalid/live.m3u8'], merge: true }) })).json();
check('un canal propio nuevo no lleva cabeceras', added.ok === true && (await (await fetch(`${server}/api/headers?id=${added.id}`)).json()).headers.length === 0);
await ui.send('Page.reload'); // the page learns of a channel added behind its back when it loads the list
await sleep(8000);
const played = await bus({ do: 'play', channel: 'Canal de prueba' });
await sleep(3500);
check('la página conoce el canal y lo pone', played.ok === true, played.detail);
const btnVisible = await ui.ev("(() => { const b = document.getElementById('btnHdr'); return !!b && !b.hidden; })()");
check('el botón «Cabeceras» sale con un canal en pantalla', btnVisible === true);
await ui.ev("document.getElementById('btnHdr').click()");
await sleep(1500);
check('el diálogo se abre con las cabeceras del canal', (await ui.ev("document.getElementById('hdrDlg').open")) === true);
await ui.ev(`(() => {
  const set = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const [n, v] = document.querySelector('#hdrRows .hdr-row').querySelectorAll('input');
  set(n, 'Referer'); set(v, 'https://web.ejemplo.es/directo/');
  document.getElementById('hdrAdd').click();
  const [n2, v2] = [...document.querySelectorAll('#hdrRows .hdr-row')][1].querySelectorAll('input');
  set(n2, 'Cookie'); set(v2, 'sesion=secreta123');
  document.getElementById('hdrForm').requestSubmit();
})()`);
await sleep(3000);
const stored = await (await fetch(`${server}/api/headers?id=${added.id}`)).json();
const dialogMsg = await ui.ev("document.getElementById('hdrMsg').textContent");
check('guardar el diálogo cambia las cabeceras del canal', stored.headers.map((h) => h.name).sort().join() === 'Cookie,Referer', `${JSON.stringify(stored.headers.map((h) => h.name))} ${dialogMsg}`);
const cookie = stored.headers.find((h) => h.name === 'Cookie');
check('la página no recibe el valor de la cookie', JSON.stringify(stored).indexOf('secreta123') === -1 && !!cookie && cookie.secret === true);
check('el diálogo se cerró', (await ui.ev("document.getElementById('hdrDlg').open")) === false);

// reopening: the credential is not shown, only that it is set
await ui.ev("document.getElementById('btnHdr').click()");
await sleep(1200);
const reopened = JSON.parse(await ui.ev("JSON.stringify([...document.querySelectorAll('#hdrRows .hdr-row')].map((r) => { const [n, v] = r.querySelectorAll('input'); return { name: n.value, value: v.value, type: v.type, placeholder: v.placeholder }; }))"));
check('al volver a abrirlo, la cookie sale sin valor y con «guardado»', reopened.some((r) => r.name === 'Cookie' && r.value === '' && r.type === 'password' && /guardado/.test(r.placeholder)) && reopened.some((r) => r.name === 'Referer' && r.value === 'https://web.ejemplo.es/directo/'));
await ui.ev("document.getElementById('hdrCancel').click()");

// an AI, through the MCP
const viaMcpGet = await mcp('tdt_headers_get', { channel: 'Canal de prueba' });
check('MCP tdt_headers_get: ve los nombres y el Referer, no la cookie', viaMcpGet.isError === false && viaMcpGet.structuredContent.headers.length === 2 && JSON.stringify(viaMcpGet).indexOf('secreta123') === -1);
const set = await mcp('tdt_headers_set', { channel: 'Canal de prueba', headers: { 'User-Agent': 'VLC/3.0', Cookie: null } });
check('MCP tdt_headers_set: cambia (el usuario acepta en la ventana; aquí se acepta)', set.isError === false, set.isError ? set.content[0].text : '');
const after = (await (await fetch(`${server}/api/headers?id=${added.id}`)).json()).headers.map((h) => `${h.name}=${h.value}`).sort().join('|');
check('...y quedan el Referer y el User-Agent, sin la cookie', after === 'Referer=https://web.ejemplo.es/directo/|User-Agent=VLC/3.0', after);
const bad = await mcp('tdt_headers_set', { channel: 'Canal de prueba', headers: { Host: 'otro.example' } });
check('MCP: una cabecera del transporte (Host) se rechaza antes de molestar al usuario', bad.isError === true && /propio programa/.test(bad.content[0].text));
check('MCP: un canal que no existe se dice', (await mcp('tdt_headers_get', { channel: 'No Existe Nada' })).isError === true);
const first2 = await ui.ev("import('/js/state.js').then((m) => JSON.stringify(m.state.channels.filter((c) => c.kind === 'tv' && !c.custom && c.sources.length).slice(0, 1).map((c) => ({ id: c.id, name: c.name }))))");
const pub = JSON.parse(first2)[0];
if (pub) {
  const setPublic = await mcp('tdt_headers_set', { channel: pub.id, headers: { Referer: 'https://www.rtve.es/' } });
  check('un canal de las listas públicas también admite cabeceras (se guardan aparte)', setPublic.isError === false && setPublic.structuredContent.own === false, pub.name);
  const flagged = JSON.parse(await ui.ev(`fetch('/api/channels').then((r) => r.json()).then((d) => JSON.stringify(d.channels.find((c) => c.id === ${JSON.stringify(pub.id)}).hdr))`));
  check('y la lista de canales avisa a la página de que lleva cabeceras', flagged === true);
  await mcp('tdt_headers_set', { channel: pub.id, headers: { Referer: null } });
  check('quitarlas las deja como estaban', (await (await fetch(`${server}/api/headers?id=${pub.id}`)).json()).headers.length === 0);
} else check('hay un canal de las listas públicas con el que probar', false);

// 12. the rules («when this happens, do that»): the dialog, the MCP, and a rule that really fires in the page
const rulesNow = async () => (await (await fetch(`${server}/api/rules`)).json()).rules;
check('no hay reglas de entrada', (await rulesNow()).length === 0);
check('el botón «Reglas» está siempre', (await ui.ev("(() => { const b = document.getElementById('btnRules'); return !!b && !b.hidden; })()")) === true);
await ui.ev("document.getElementById('btnRules').click()");
await sleep(1200);
check('el diálogo de reglas se abre', (await ui.ev("document.getElementById('rulesDlg').open")) === true);
await ui.ev("document.getElementById('rulesExample').click()");
check('«Ejemplo» pone una regla para copiar', JSON.parse(await ui.ev("document.getElementById('rulesText').value")).length === 1);
await ui.ev("(() => { document.getElementById('rulesText').value = '[{\"id\": \"MAL\", \"when\": {}, \"do\": []}]'; document.getElementById('rulesForm').requestSubmit(); })()");
await sleep(1000);
check('una regla mala se explica y no se guarda', (await rulesNow()).length === 0 && /id|regla/i.test(await ui.ev("document.getElementById('rulesMsg').textContent")), await ui.ev("document.getElementById('rulesMsg').textContent"));
await ui.ev("(() => { document.getElementById('rulesText').value = '[]'; document.getElementById('rulesExample').click(); document.getElementById('rulesForm').requestSubmit(); })()");
await sleep(1200);
const savedRules = await rulesNow();
check('guardar el diálogo guarda la regla', savedRules.length === 1 && savedRules[0].id === 'noticias-de-las-21', JSON.stringify(savedRules.map((r) => r.id)));
check('el diálogo se cerró', (await ui.ev("document.getElementById('rulesDlg').open")) === false);
await ui.ev("document.getElementById('btnRules').click()");
await sleep(800);
check('al abrirlo otra vez la lista la cuenta en una frase', /Noticias a las 21: a las 21:00 \(lun, mar, mié, jue, vie\)/.test(await ui.ev("document.getElementById('rulesList').textContent")));
await ui.ev("document.getElementById('rulesCancel').click()");
const viaGet = await mcp('tdt_rules_get');
check('MCP tdt_rules_get: ve las reglas con su frase', viaGet.isError === false && viaGet.structuredContent.rules.length === 1 && /poner «La 1»/.test(viaGet.structuredContent.rules[0].text), viaGet.isError ? viaGet.content[0].text : '');
const badRule = await mcp('tdt_rules_set', { rules: [{ id: 'x', when: { type: 'time', at: '25:99' }, do: [{ action: 'toast', text: 'x' }] }] });
check('MCP: una regla mala se rechaza antes de molestar al usuario', badRule.isError === true && /hora/.test(badRule.content[0].text));
const evil = await mcp('tdt_rules_set', { rules: [{ id: 'x', when: { type: 'time', at: '21:00' }, do: [{ action: 'eval', code: 'alert(1)' }] }] });
check('MCP: una acción que no existe (código) se rechaza', evil.isError === true);
const probe = { id: 'prueba', name: 'Prueba', when: { type: 'channel', channel: 'Canal de prueba' }, do: [{ action: 'volume', value: 0.33 }] };
const setRules = await mcp('tdt_rules_set', { rules: [probe] });
check('MCP tdt_rules_set: cambia las reglas (el usuario acepta; aquí se acepta)', setRules.isError === false && (await rulesNow()).map((r) => r.id).join() === 'prueba', setRules.isError ? setRules.content[0].text : '');
await sleep(800); // the page hears that they changed
const other = (await ui.ev("import('/js/state.js').then((m) => JSON.stringify(m.state.channels.filter((c) => c.kind === 'tv' && !c.custom && c.sources.length).slice(0, 1).map((c) => c.name)))"));
await bus({ do: 'play', channel: JSON.parse(other)[0] });
await sleep(2500);
await bus({ do: 'volume', value: 0.8 });
await sleep(1500);
await bus({ do: 'play', channel: 'Canal de prueba' });
await sleep(4000);
const volume = (await (await fetch(`${server}/api/control/v1/state`, { headers: { Authorization: 'Bearer ' + token } })).json()).vol.v;
check('una regla por canal se cumple sola: al poner el canal, el volumen pasa a 0,33', Math.abs(volume - 0.33) < 0.01, `volumen ${volume}`);
const did = await ui.ev("(() => { document.getElementById('btnRules').click(); return new Promise((ok) => setTimeout(() => ok(document.getElementById('rulesLog').textContent), 800)); })()");
check('y «Lo que han hecho» lo cuenta', /Prueba/.test(did) && /hecho/.test(did), did);
await ui.ev("document.getElementById('rulesCancel').click()");
await mcp('tdt_rules_set', { rules: [] });
check('quitarlas las deja como estaban', (await rulesNow()).length === 0);

// 13. the events of the page: one list of orders and events for everyone, a plugin that hears them, and the MCP that asks what just happened
const spec = (await mcp('tdt_commands')).structuredContent;
check('MCP tdt_commands: la lista única de órdenes y eventos', Object.keys(spec.commands).length === 6 && Object.keys(spec.events).length === 6, Object.keys(spec.events).join());
const listener = await plugin('hostile'); // the frame was reloaded by the earlier checks: connect again
await listener.ev("(window.__heard = [], tdt.on('channel.changed', (d) => window.__heard.push(['canal', d.name])), tdt.on('volume.changed', (d) => window.__heard.push(['volumen', d.v, d.cause || ''])), 1)");
await bus({ do: 'play', channel: JSON.parse(other)[0] });
await sleep(3000);
const heardChannel = JSON.parse(await listener.ev('JSON.stringify(window.__heard)'));
check('un plugin con player.read oye el cambio de canal', heardChannel.some((h) => h[0] === 'canal' && h[1] === JSON.parse(other)[0]), JSON.stringify(heardChannel));
const latest = await mcp('tdt_events', { name: 'channel.changed', limit: 3 });
check('MCP tdt_events: lo último que pasó, con el canal', latest.isError === false && latest.structuredContent.events[0].name === 'channel.changed' && latest.structuredContent.events[0].data.name === JSON.parse(other)[0], latest.isError ? latest.content[0].text : JSON.stringify(latest.structuredContent.events[0]));
await bus({ do: 'volume', value: 0.21 });
await sleep(2500);
const vol = (await mcp('tdt_events', { name: 'volume.changed' })).structuredContent.events[0];
check('el cambio de volumen del usuario no lleva «cause»', vol && Math.abs(vol.data.v - 0.21) < 0.01 && !vol.data.cause, JSON.stringify(vol));
const evRule = { id: 'evento', name: 'Evento', when: { type: 'channel', channel: 'Canal de prueba' }, do: [{ action: 'volume', value: 0.55 }] };
await mcp('tdt_rules_set', { rules: [evRule] });
await sleep(800);
await bus({ do: 'play', channel: 'Canal de prueba' });
await sleep(4000);
const byRule = (await mcp('tdt_events', { name: 'volume.changed' })).structuredContent.events[0];
check('lo que hace una regla se cuenta como suyo (cause: rule)', byRule && Math.abs(byRule.data.v - 0.55) < 0.01 && byRule.data.cause === 'rule', JSON.stringify(byRule));
const heardAll = JSON.parse(await listener.ev('JSON.stringify(window.__heard)'));
check('y el plugin también lo oye, marcado', heardAll.some((h) => h[0] === 'volumen' && h[2] === 'rule'), JSON.stringify(heardAll.slice(-3)));
const firedTwice = (await mcp('tdt_events', { name: 'channel.changed', limit: 10 })).structuredContent.events.filter((e) => e.data.cause === 'rule').length;
check('una regla no se dispara a sí misma (el canal no cambió por la regla)', firedTwice === 0);
await mcp('tdt_rules_set', { rules: [] });

// 14. the settings a plugin declares: the form is generated, the plugin reads what is chosen, nobody else changes it, and an AI asks first
const cfg = await plugin('hostile');
const listed = await mcp('tdt_plugins');
const hostileInfo = listed.structuredContent.plugins.find((p) => p.id === 'hostile');
check('tdt_plugins cuenta los ajustes del plugin con su valor actual', hostileInfo.settings.length === 2 && hostileInfo.settings.find((f) => f.name === 'ciudad').value === 'Madrid', JSON.stringify(hostileInfo.settings.map((f) => f.name + '=' + f.value)));
check('el plugin lee su valor por defecto, sin permisos', (await cfg.ev('code(() => tdt.config.get("ciudad"))')) !== undefined && (await cfg.ev('JSON.stringify(window.__last)')) !== 'x');
const readConfig = async () => JSON.parse(await cfg.ev('(async () => JSON.stringify(await tdt.config.all()))()', 8000));
check('tdt.config.all() devuelve los valores por defecto', JSON.stringify(await readConfig()) === JSON.stringify({ ciudad: 'Madrid', segundos: 20 }));
await cfg.ev("(window.__cfg = [], tdt.on('config.changed', (v) => window.__cfg.push(v)), 1)");
await ui.ev("document.querySelector('[data-tab=\"plugins\"]') && document.querySelector('[data-tab=\"plugins\"]').click()");
const changed = await ui.ev("window.tdtDesktop.plugins.setConfig('hostile', { ciudad: 'Sevilla', segundos: 45 })");
check('el usuario cambia los ajustes y se guardan', changed.ok === true && changed.values.ciudad === 'Sevilla' && changed.values.segundos === 45, JSON.stringify(changed));
await sleep(800);
check('el plugin lee lo que eligió el usuario', JSON.stringify(await readConfig()) === JSON.stringify({ ciudad: 'Sevilla', segundos: 45 }));
check('y se entera: config.changed', JSON.parse(await cfg.ev('JSON.stringify(window.__cfg)')).some((v) => v.ciudad === 'Sevilla'));
const wrongValue = await ui.ev("window.tdtDesktop.plugins.setConfig('hostile', { ciudad: 'Bilbao' })");
check('un valor que no vale se rechaza y no cambia nada', wrongValue.ok === false && /uno de/.test(wrongValue.error) && (await readConfig()).ciudad === 'Sevilla', wrongValue.error);
check('un ajuste que no existe se rechaza', (await ui.ev("window.tdtDesktop.plugins.setConfig('hostile', { inventado: 1 })")).ok === false);
const viaMcpCfg = await mcp('tdt_plugin_config', { id: 'hostile', values: { segundos: 90 } });
check('MCP tdt_plugin_config: cambia un ajuste (el usuario acepta; aquí se acepta)', viaMcpCfg.isError === false && (await readConfig()).segundos === 90, viaMcpCfg.isError ? viaMcpCfg.content[0].text : '');
const badMcpCfg = await mcp('tdt_plugin_config', { id: 'hostile', values: { segundos: 1 } });
check('MCP: un valor fuera de límites se rechaza antes de molestar al usuario', badMcpCfg.isError === true && /entre 5 y 600/.test(badMcpCfg.content[0].text), badMcpCfg.isError ? badMcpCfg.content[0].text : '');
check('MCP: un plugin que no existe se dice', (await mcp('tdt_plugin_config', { id: 'nadie', values: { a: 1 } })).isError === true);
await ui.ev("window.tdtDesktop.plugins.setConfig('hostile', { ciudad: 'Madrid', segundos: 20 })");

// 15. a service sleeps until its moment: no frame (no process) while it waits, woken by the event it asked for, back to sleep when idle
await ui.ev("window.tdtDesktop.plugins.setEnabled('servicio', true)");
await sleep(3000);
const asleep = (await status()).find((x) => x.id === 'servicio');
check('un servicio con activation está dormido: sin marco', asleep && asleep.state === 'waiting' && (await plugin('servicio')) === null, asleep ? asleep.state : 'ausente');
check('y cuenta de qué se despierta', asleep && asleep.activation.join() === 'onEvent:channel.changed' && asleep.wakes === 0);
const sleeping = (await mcp('tdt_plugins')).structuredContent.plugins.find((x) => x.id === 'servicio');
check('el MCP lo ve dormido', sleeping && sleeping.runtime.state === 'waiting' && sleeping.activation.length === 1, sleeping ? sleeping.runtime.state : '');
await bus({ do: 'play', channel: JSON.parse(other)[0] });
const woke = await waitFor(async () => (await stateOf('servicio')) === 'running', 12);
check('el evento que pidió lo despierta', woke !== null, woke === null ? 'no despertó' : `a los ${woke.toFixed(1)} s`);
const service = await plugin('servicio');
await sleep(1500);
check('y le llega el evento que lo despertó', service !== null && JSON.parse(await service.ev('JSON.stringify(window.__woke)')).includes(JSON.parse(other)[0]));
check('despertarlo se cuenta', (await status()).find((x) => x.id === 'servicio').wakes === 1);
const slept = await waitFor(async () => (await stateOf('servicio')) === 'waiting', 100);
check('sin nada que hacer, vuelve a dormir (se libera el proceso)', slept !== null && (await plugin('servicio')) === null, slept === null ? 'no se durmió' : `a los ${slept.toFixed(0)} s`);
await bus({ do: 'play', channel: 'Canal de prueba' });
check('y se despierta otra vez', (await waitFor(async () => (await stateOf('servicio')) === 'running', 12)) !== null && (await status()).find((x) => x.id === 'servicio').wakes === 2);
await ui.ev("window.tdtDesktop.plugins.setEnabled('servicio', false)");

// 16. a playback source added by a plugin: the player of another server in a tile, only while the plugin runs and the user allows its server
const csp = () => ui.ev("fetch('/api/version').then((r) => r.headers.get('content-security-policy'))");
check('sin el plugin, la política no deja enmarcar player.twitch.tv', !/player\.twitch\.tv/.test(await csp()));
await ui.ev("window.tdtDesktop.plugins.setEnabled('fuente', true)");
await sleep(2500);
check('con el plugin activo, la política deja enmarcar solo ese servidor', /frame-src [^;]*https:\/\/player\.twitch\.tv/.test(await csp()) && !/frame-src [^;]*https:\/\/\*/.test(await csp()));
const tw = await (await fetch(`${server}/api/custom`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Twitch de prueba', sources: ['https://www.twitch.tv/twitch'], merge: true }) })).json();
await ui.send('Page.reload');
await sleep(8000);
const twPlay = await bus({ do: 'play', channel: 'Twitch de prueba' });
await sleep(7000);
const frameSrc = await ui.ev("(document.querySelector('iframe.tile-yt') || {}).src || ''");
check('un enlace de Twitch se reproduce con el reproductor del plugin', twPlay.ok === true && frameSrc === 'https://player.twitch.tv/?channel=twitch&parent=127.0.0.1', `${twPlay.detail} ${frameSrc}`);
const info = await ui.ev("[...document.querySelectorAll('.tile .info, .tile-info, .tinfo')].map((n) => n.textContent).join(' | ')");
check('y la casilla dice que es un reproductor de un plugin', /Reproductor de Twitch \(plugin\)/.test(info) || /Twitch/.test(await ui.ev('document.body.innerText')), info.slice(0, 120));
await ui.ev("window.tdtDesktop.plugins.setPermission('fuente', 'embed:player.twitch.tv', false)");
await sleep(2500);
check('si el usuario quita el permiso, la fuente y la política se van', !/player\.twitch\.tv/.test(await csp()));
await ui.ev("window.tdtDesktop.plugins.setPermission('fuente', 'embed:player.twitch.tv', true)");
await ui.ev("window.tdtDesktop.plugins.setEnabled('fuente', false)");
await fetch(`${server}/api/custom/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: tw.id }) });

// 17. a plugin that provides channels: they join the list while it runs and have the permission, and leave when it stops or loses it
const providedNow = async () => (await (await fetch(`${server}/api/channels`)).json()).channels.filter((c) => c.provider === 'proveedor');
check('sin el plugin no hay canales suyos', (await providedNow()).length === 0);
await ui.ev("window.tdtDesktop.plugins.setEnabled('proveedor', true)");
const gotThem = await waitFor(async () => (await providedNow()).length === 2, 15);
check('un plugin con provide:channels añade sus canales a la lista', gotThem !== null, gotThem === null ? 'no llegaron' : `a los ${gotThem.toFixed(1)} s`);
const mineProvided = await providedNow();
check('con su categoría y sin poder elegir el id ni las cabeceras', mineProvided.every((c) => c.category === 'Plugin · proveedor' && c.id.startsWith('prov-proveedor-') && c.custom === false) && mineProvided.some((c) => c.kind === 'radio'), JSON.stringify(mineProvided.map((c) => c.id)));
const proveedor = await plugin('proveedor');
check('un canal con cabeceras se rechaza con E_INVALID y no entra', proveedor && (await proveedor.ev('window.__bad')) === 'E_INVALID' && !mineProvided.some((c) => /cabeceras/i.test(c.name)));
check('el MCP/servidor cuenta quién aporta cuántos', JSON.stringify((await (await fetch(`${server}/api/providers`)).json()).providers) === '{"proveedor":2}');
const epgLine = () => ui.ev("import('/js/state.js').then((m) => { const c = m.state.channels.find((x) => x.id === 'prov-proveedor-proveedor-uno'); return c ? m.channelEpgLine(c) : 'sin canal'; })");
const gotGuide = await waitFor(async () => (await epgLine()) === 'Programa de prueba', 20);
check('y su guía: el canal enseña el programa que da el plugin', gotGuide !== null, await epgLine());
check('la guía queda bajo «plugin:canal» y el servidor la cuenta', JSON.stringify((await (await fetch(`${server}/api/providers`)).json()).epg) === '{"proveedor":1}' && (await (await fetch(`${server}/api/epg?id=proveedor:uno`)).json()).programmes[0][2] === 'Programa de prueba');
await ui.ev("window.tdtDesktop.plugins.setPermission('proveedor', 'provide:epg', false)");
check('si el usuario quita provide:epg, la guía se va y los canales se quedan', (await waitFor(async () => (await (await fetch(`${server}/api/providers`)).json()).epg.proveedor === undefined, 15)) !== null && (await providedNow()).length === 2);
await ui.ev("window.tdtDesktop.plugins.setPermission('proveedor', 'provide:epg', true)");
await sleep(2500);
await ui.ev("window.tdtDesktop.plugins.setPermission('proveedor', 'provide:channels', false)");
const lost = await waitFor(async () => (await providedNow()).length === 0, 15);
check('si el usuario quita el permiso, sus canales se van de la lista', lost !== null);
await ui.ev("window.tdtDesktop.plugins.setPermission('proveedor', 'provide:channels', true)");
check('y vuelven cuando se le da otra vez', (await waitFor(async () => (await providedNow()).length === 2, 20)) !== null);
await ui.ev("window.tdtDesktop.plugins.setEnabled('proveedor', false)");
check('al apagar el plugin, se van', (await waitFor(async () => (await providedNow()).length === 0, 15)) !== null);

// 18. the rules a plugin brings (a key shortcut): off until the user turns them on, run by the page, gone with the plugin
const broughtNow = async () => (await (await fetch(`${server}/api/rules`)).json()).plugin_rules;
const pressAlt9 = async () => { for (const type of ['rawKeyDown', 'keyUp']) await ui.send('Input.dispatchKeyEvent', { type, modifiers: 1, key: '9', code: 'Digit9', windowsVirtualKeyCode: 57 }); };
const volumeNow = async () => (await (await fetch(`${server}/api/control/v1/state`, { headers: { Authorization: 'Bearer ' + token } })).json()).vol.v;
check('sin el plugin no hay reglas suyas', (await broughtNow()).length === 0);
await ui.ev("window.tdtDesktop.plugins.setEnabled('atajos', true)");
check('un plugin trae su regla, apagada, y dice qué hace', (await waitFor(async () => (await broughtNow()).length === 1, 15)) !== null && (await broughtNow())[0].enabled === false && /al pulsar Ctrl\+Alt|al pulsar Alt\+9/.test((await broughtNow())[0].text), JSON.stringify((await broughtNow()).map((b) => b.text)));
await bus({ do: 'volume', value: 0.8 });
await sleep(2500);
await pressAlt9();
await sleep(1500);
check('apagada, la tecla no hace nada', Math.abs((await volumeNow()) - 0.8) < 0.01, `volumen ${await volumeNow()}`);
const viaMcpBrought = await mcp('tdt_rules_get');
check('el MCP ve las reglas de plugins con su estado', viaMcpBrought.isError === false && viaMcpBrought.structuredContent.plugin_rules.length === 1 && viaMcpBrought.structuredContent.plugin_rules[0].enabled === false);
const turnedOn = await ui.ev("fetch('/api/rules/plugin/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin: 'atajos', rule: 'volumen-bajo', on: true }) }).then((r) => r.json()).then((d) => { window.dispatchEvent(new Event('tdt-rules-changed')); return d.enabled; })");
await sleep(1500);
check('el usuario la enciende', turnedOn === true && (await broughtNow())[0].enabled === true);
await pressAlt9();
await sleep(2500);
check('encendida, Alt+9 baja el volumen (la regla del plugin se cumple)', Math.abs((await volumeNow()) - 0.27) < 0.01, `volumen ${await volumeNow()}`);
await ui.ev("window.tdtDesktop.plugins.setEnabled('atajos', false)");
check('al apagar el plugin, su regla se va', (await waitFor(async () => (await broughtNow()).length === 0, 15)) !== null);

// 19. a theme a plugin brings: it changes colours only, and only when the user chooses it
const cssVar = (name) => ui.ev(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
const normalAccent = await cssVar('--accent');
const normalFont = await cssVar('--font');
await ui.ev("window.tdtDesktop.plugins.setEnabled('tema', true)");
await sleep(3000);
const themeOptions = await ui.ev("(async () => { const m = await import('/js/themes.js'); const box = m.themeControl(); return JSON.stringify([...box.querySelector('select').options].map((o) => o.value)); })()");
check('el tema del plugin sale en la lista de temas', JSON.parse(themeOptions).includes('tema/rojo'), themeOptions);
check('con el plugin activo, nada cambia hasta que el usuario lo elige', (await cssVar('--accent')) === normalAccent);
await ui.ev("import('/js/themes.js').then((m) => m.chooseTheme('tema/rojo'))");
await sleep(500);
check('al elegirlo, el color de acento es el del tema', (await cssVar('--accent')) === '#ff0033', await cssVar('--accent'));
check('pero la tipografía no cambia (solo hay colores) ni se cuela una dirección', (await cssVar('--font')) === normalFont && !/evil\.example/.test(await ui.ev("document.documentElement.getAttribute('style') || ''")));
check('y el aviso de color es el del tema', (await ui.ev("document.documentElement.style.colorScheme")) === 'dark');
await ui.ev("window.tdtDesktop.plugins.setEnabled('tema', false)");
check('al apagar el plugin, la página vuelve a sus colores', (await waitFor(async () => (await cssVar('--accent')) === normalAccent, 15)) !== null, await cssVar('--accent'));
await ui.ev("import('/js/themes.js').then((m) => m.chooseTheme(''))");

// 20. a source of a plugin with a control adapter: its player is silenced and given back from TDT local like the built-in YouTube
await ui.ev("window.tdtDesktop.plugins.setEnabled('fuente-yt', true)");
await sleep(2500);
const yt = await (await fetch(`${server}/api/custom`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'YT de plugin', sources: ['https://yt.example/36YnV9STBqc'], merge: true }) })).json();
await ui.send('Page.reload');
await sleep(8000);
await bus({ do: 'play', channel: 'YT de plugin' });
await sleep(12000);
const ytSrc = await ui.ev("(document.querySelector('iframe.tile-yt') || {}).src || ''");
check('una fuente de plugin con control «youtube» usa el reproductor con la API de órdenes', /^https:\/\/www\.youtube-nocookie\.com\/embed\/36YnV9STBqc\?.*enablejsapi=1/.test(ytSrc), ytSrc);
const ytTarget = (await targets()).find((t) => t.url.includes('youtube-nocookie.com/embed'));
if (ytTarget) {
  const inside = await connect(ytTarget.webSocketDebuggerUrl);
  const mutedNow = async () => JSON.parse(await inside.ev("JSON.stringify({ muted: (document.querySelector('video') || {}).muted })", 8000)).muted;
  await bus({ do: 'mute', on: true });
  await sleep(3000);
  check('TDT local silencia ese reproductor', (await mutedNow()) === true);
  // YouTube sometimes ignores an «unMute» that arrives while its own start-up is not done: the sound has to come back within a few tries
  let unmutedAfter = 0;
  for (let attempt = 1; attempt <= 3 && !unmutedAfter; attempt += 1) {
    await bus({ do: 'mute', on: false });
    await sleep(3000);
    if ((await mutedNow()) === false) unmutedAfter = attempt;
    else { await bus({ do: 'mute', on: true }); await sleep(1500); }
  }
  check('y le devuelve el sonido', unmutedAfter > 0, unmutedAfter ? `a la ${unmutedAfter}ª orden` : 'sigue silenciado tras tres intentos');
} else check('hay un marco de YouTube con el que probar', false);
await ui.ev("window.tdtDesktop.plugins.setEnabled('fuente-yt', false)");
await fetch(`${server}/api/custom/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: yt.id }) });

// 21. the inspector and the calls of the plugins: who called what and how it ended (never the data), through the MCP and in the dialog
const caller = await plugin('hostile');
if (!caller) {
  check('el marco del plugin hostil está disponible para probar el inspector', false, 'no apareció en 10 s: se salta el resto de esta sección');
  console.log(`\n${results.filter((r) => r.ok).length} de ${results.length} comprobaciones bien; FALLAN: ${results.filter((r) => !r.ok).map((r) => r.name).join(' | ')}`);
  try { app.kill(); } catch { /* already gone */ }
  process.exit(1);
}
await caller.ev('code(() => tdt.player.state())');
const denied = await caller.ev('code(() => tdt.player.play("La 1"))');
const callsViaMcp = await mcp('tdt_plugin_calls', { id: 'hostile', limit: 30 });
const seenCalls = callsViaMcp.isError === false ? callsViaMcp.structuredContent.calls : [];
check('MCP tdt_plugin_calls: las llamadas de un plugin, con el método y cómo acabaron', seenCalls.some((c) => c.method === 'player.state' && c.result === 'ok') && seenCalls.some((c) => c.method === 'player.play' && c.result === 'E_PERMISSION') && denied === 'E_PERMISSION', JSON.stringify(seenCalls.slice(0, 3)));
check('y solo las de ese plugin, sin argumentos ni respuestas', seenCalls.every((c) => c.plugin === 'hostile') && seenCalls.every((c) => JSON.stringify(Object.keys(c).sort()) === '["at","method","ms","plugin","result"]') && !/La 1/.test(JSON.stringify(seenCalls)));
check('MCP: un id mal escrito se rechaza', (await mcp('tdt_plugin_calls', { id: 'Mal Id' })).isError === true);
const inspectorText = await ui.ev("(async () => { const m = await import('/js/inspector.js'); m.inspectorButton().click(); await new Promise((r) => setTimeout(r, 1500)); return document.getElementById('insLog').textContent + '|open=' + document.getElementById('inspectorDlg').open; })()");
check('el Inspector se abre y enseña las llamadas de los plugins y los eventos en una línea de tiempo', /open=true/.test(inspectorText) && /hostile · player\.play · E_PERMISSION/.test(inspectorText) && /channel\.changed|volume\.changed/.test(inspectorText), inspectorText.slice(0, 160));
await ui.ev("document.getElementById('insKind').value = 'call'; document.getElementById('insKind').dispatchEvent(new Event('change')); 1");
check('y se puede filtrar por tipo', !/channel\.changed/.test(await ui.ev("document.getElementById('insLog').textContent")));
await ui.ev("document.getElementById('insClose').click()");
check('al cerrarlo, deja de refrescar', (await ui.ev("document.getElementById('inspectorDlg').open")) === false);

// 22. installing from a link or a catalog: the catalog pins every file, a file that is not the expected one is refused, nothing is activated
const catalog = await ui.ev("window.tdtDesktop.plugins.catalog('https://plugins.example.org/index.json')");
check('el catálogo se lee: un plugin con su SHA-256 y otro sin él, que se descarta diciéndolo', catalog.entries && catalog.entries.length === 1 && catalog.entries[0].id === 'tema-catalogo' && catalog.entries[0].state === 'new' && catalog.problems.length === 1 && /falta «sha256»/.test(catalog.problems[0]), JSON.stringify(catalog).slice(0, 200));
check('un catálogo que no es https se rechaza', /https/.test((await ui.ev("window.tdtDesktop.plugins.catalog('http://plugins.example.org/index.json')")).error || ''));
const wrongHash = await ui.ev(`window.tdtDesktop.plugins.installLink('https://plugins.example.org/tema-catalogo.tdtplugin', ${JSON.stringify('0'.repeat(64))})`);
check('un archivo que no es el esperado (otro SHA-256) se rechaza y no se instala nada', /no es el que se esperaba/.test(wrongHash.error || '') && !(await (await fetch(`${server}/api/control/v1/command`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ do: 'plugin_list' }) })).json()).data.plugins.some((p) => p.id === 'tema-catalogo'), wrongHash.error);
check('un enlace sin https o a una dirección de tu red se rechaza', /https/.test((await ui.ev("window.tdtDesktop.plugins.installLink('http://plugins.example.org/a.tdtplugin', '')")).error || '') && /nombre público/.test((await ui.ev("window.tdtDesktop.plugins.installLink('https://127.0.0.1/a.tdtplugin', '')")).error || ''));
check('un SHA-256 mal escrito se dice', /64 cifras/.test((await ui.ev("window.tdtDesktop.plugins.installLink('https://plugins.example.org/tema-catalogo.tdtplugin', 'abc')")).error || ''));
const done = await ui.ev(`window.tdtDesktop.plugins.installLink(${JSON.stringify(catalog.entries[0].url)}, ${JSON.stringify(catalog.entries[0].sha256)})`);
check('con el SHA-256 del catálogo se instala (el usuario acepta; aquí se acepta)', done.id === 'tema-catalogo' && done.sha256 === packedSha, JSON.stringify(done).slice(0, 160));
const installedNow = (await (await fetch(`${server}/api/control/v1/command`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ do: 'plugin_list' }) })).json()).data.plugins.find((p) => p.id === 'tema-catalogo');
check('instalar no activa: sale en la lista, apagado', !!installedNow && installedNow.enabled === false);
check('y el catálogo ya lo marca como instalado', (await ui.ev("window.tdtDesktop.plugins.catalog('https://plugins.example.org/index.json')")).entries[0].state === 'installed');
const logText = readFileSync(join(data, 'desktop', 'logs', 'tdt-local.log'), 'utf8');
check('el Registro dice de dónde vino', /tema-catalogo.*instalado desde plugins\.example\.org/.test(logText));

// 23. author signatures: the key a plugin was installed with is remembered; the same key is recognised, another one or no signature is a warning, a signature of another file is refused
const link = (name) => `https://plugins.example.org/${name}.tdtplugin`;
const installSigned = (name) => ui.ev(`window.tdtDesktop.plugins.installLink(${JSON.stringify(link(name))}, '')`);
const sig_first = await installSigned('firmado-uno-1');
check('un plugin firmado por primera vez: «clave nueva» y se recuerda su huella', sig_first.id === 'firmado-uno' && sig_first.signature.state === 'signed-new' && /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/.test(sig_first.signature.fingerprint), JSON.stringify(sig_first.signature));
const sig_again = await installSigned('firmado-uno-1');
check('la misma clave otra vez: se reconoce («la misma de siempre»)', sig_again.signature.state === 'signed-known' && sig_again.signature.fingerprint === sig_first.signature.fingerprint, JSON.stringify(sig_again.signature));
const sig_changed = await installSigned('firmado-uno-2');
check('una versión firmada con OTRA clave: «la clave ha cambiado» (avisa; aquí el usuario acepta)', sig_changed.signature.state === 'signed-changed' && sig_changed.signature.fingerprint !== sig_first.signature.fingerprint, JSON.stringify(sig_changed.signature));
const sig_unsigned = await installSigned('firmado-uno-3');
check('una versión sin firma de un plugin que venía firmado: «sin firma» (avisa; aquí el usuario acepta)', sig_unsigned.signature.state === 'unsigned-was-signed', JSON.stringify(sig_unsigned.signature));
const sig_forgotten = await installSigned('firmado-uno-3');
check('y tras aceptarlo, ya no se le exige la firma de antes', sig_forgotten.signature.state === 'unsigned', JSON.stringify(sig_forgotten.signature));
const sig_tampered = await installSigned('firmado-dos');
check('una firma que es de otro archivo se rechaza y no se instala nada', /la firma no es válida/.test(sig_tampered.error || '') && sig_tampered.signature.state === 'invalid' && !(await (await fetch(`${server}/api/control/v1/command`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ do: 'plugin_list' }) })).json()).data.plugins.some((p) => p.id === 'firmado-dos'), sig_tampered.error);
const keysFile = JSON.parse(readFileSync(join(data, 'desktop', 'plugin-keys.json'), 'utf8'));
check('al aceptar una versión sin firma, el plugin deja de tener una clave recordada (y los sin firma nunca la tuvieron)', keysFile['firmado-uno'] === undefined && keysFile['tema-catalogo'] === undefined && keysFile['firmado-dos'] === undefined, JSON.stringify(keysFile));
const signedLogs = readFileSync(join(data, 'desktop', 'logs', 'tdt-local.log'), 'utf8');
check('el Registro dice con qué firma se instaló', /firmado-uno.*firma: signed-new/.test(signedLogs) && /firmado-uno.*firma: signed-changed/.test(signedLogs));

// 24. limits of memory and processor: each plugin with a page is measured, one that eats memory or burns the processor is stopped and can be started again
const usageOf = async (id) => (await status()).find((x) => x.id === id);
const measured = await waitFor(async () => { const u = await usageOf('hostile'); return u && typeof u.memoryMB === 'number' && u.memoryMB > 10; }, 20);
const usageSample = await usageOf('hostile');
check('cada plugin con página se mide: memoria y procesador en el estado', measured !== null && typeof usageSample.cpuPercent === 'number', usageSample ? `${usageSample.memoryMB} MB, ${usageSample.cpuPercent} %` : 'sin medida');
// the installs just before reload every plugin: wait until the frame of the one used here is there again
await waitFor(async () => (await plugin('hostile')) !== null && (await stateOf('hostile')) === 'running', 30);
const eater = await plugin('hostile');
eater.send('Runtime.evaluate', { expression: 'setTimeout(() => window.mem(500), 0); 1' });
const stoppedForMemory = await waitFor(async () => (await usageOf('hostile')).state === 'over-limit', 30);
const memState = await usageOf('hostile');
check('un plugin que se come la memoria se para', stoppedForMemory !== null && memState.overLimit === 'memory', stoppedForMemory === null ? `sigue ${memState.state} con ${memState.memoryMB} MB` : `a los ${stoppedForMemory.toFixed(1)} s`);
check('sin marco: el proceso se libera', (await plugin('hostile')) === null);
check('y los demás plugins siguen como estaban', (await stateOf('ticker')) === 'running');
const memLogs = readFileSync(join(data, 'desktop', 'logs', 'tdt-local.log'), 'utf8');
check('el Registro dice por qué y cuánto usaba', /\[plugin:hostile\] se para: memoria: usa \d+ MB y el tope es 350 MB/.test(memLogs));
const viaMcpLimit = (await mcp('tdt_plugins')).structuredContent.plugins.find((p) => p.id === 'hostile');
check('el MCP lo ve parado por el límite', viaMcpLimit && viaMcpLimit.runtime.state === 'over-limit' && viaMcpLimit.runtime.overLimit === 'memory');
await ui.ev("import('/js/plugin-host.js').then((m) => m.pluginHost().reload('hostile'))");
// a restarted plugin often gets the same process, which keeps its memory for a while: it must not be stopped again for what was already there
const restarted = await waitFor(async () => { const u = await usageOf('hostile'); return u && u.state === 'running' && u.overLimit === null; }, 25);
await sleep(14000); // several looks of the watch
const afterRestart = await usageOf('hostile');
check('recargarlo lo arranca y no se vuelve a parar por la memoria que el proceso ya tenía', restarted !== null && afterRestart.state === 'running' && afterRestart.overLimit === null, JSON.stringify(afterRestart).slice(0, 200));
// (what a restarted plugin allocates in a process that still holds its old memory cannot be told apart by measuring the process: a limit of this app, written in the docs)
await waitFor(async () => (await plugin('ticker')) !== null && (await stateOf('ticker')) === 'running', 30);
const burner = await plugin('ticker');
burner.send('Runtime.evaluate', { expression: 'setTimeout(() => { const end = Date.now() + 70000; while (Date.now() < end) {} }, 0); 1' });
const stoppedForCpu = await waitFor(async () => (await usageOf('ticker')).state === 'over-limit', 55);
check('un plugin que quema el procesador sin parar se para', stoppedForCpu !== null && (await usageOf('ticker')).overLimit === 'cpu', stoppedForCpu === null ? 'sigue ' + (await usageOf('ticker')).state : `a los ${stoppedForCpu.toFixed(1)} s`);
await ui.ev("import('/js/plugin-host.js').then((m) => m.pluginHost().reload('ticker'))");
check('y también se puede volver a arrancar', (await waitFor(async () => (await usageOf('ticker')).state === 'running', 20)) !== null);
await fetch(`${server}/api/custom/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: added.id }) });

await finish();
