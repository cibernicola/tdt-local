// The test of safe mode in the real desktop app: it needs the app to be killed and started again, so it is not part of bench.mjs.
//
//   node scripts/plugin-lab/safe-mode.mjs        (from the root of the repository; needs `npm install` in desktop/)
//
// It starts the app several times with the same temporary data folder: one plugin turned on; two kills in a row (bad exits) → the third start is in safe mode (no plugin
// runs, the title and the notice say so, nothing can be turned on or off, what was chosen is kept); a clean exit does not count; leaving safe mode brings the plugin back.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.BENCH_DEBUG_PORT || 9733);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = mkdtempSync(join(tmpdir(), 'tdt-safe-'));
const data = join(base, 'data');
const plugins = join(base, 'plugins');
mkdirSync(plugins, { recursive: true });
cpSync(join(ROOT, 'scripts', 'plugin-lab', 'plugins', 'tema'), join(plugins, 'tema'), { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

let app = null;
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

/** Start the app (with these extra arguments); resolves with the connection to its page. */
async function launch(extra = [], env = {}) {
  app = spawn(join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), ['.', ...extra], {
    cwd: join(ROOT, 'desktop'),
    env: { ...process.env, TDT_DEBUG_PORT: String(PORT), TDT_DATA_DIR: data, TDT_PLUGINS_DIR: plugins, TDT_DEV_CONFIRM: 'yes', TDT_TEST_NO_RELAUNCH: '1', ...env },
    stdio: 'ignore',
  });
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(500);
    try { page = (await targets()).find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:')); } catch { /* not yet */ }
  }
  if (!page) throw new Error('la aplicación no arrancó');
  const ui = await connect(page.webSocketDebuggerUrl);
  await sleep(4000);
  return { ui, title: page.title };
}
const kill = async () => { app.kill(); await sleep(2500); }; // a bad exit: nobody closed it properly
const closeClean = async (ui) => { await ui.send('Browser.close').catch(() => {}); for (let i = 0; i < 40 && app.exitCode === null; i++) await sleep(500); await sleep(500); };
const state = async (ui) => JSON.parse(await ui.ev("Promise.all([window.tdtDesktop.plugins.list(), window.tdtDesktop.ui.list()]).then(([l, u]) => JSON.stringify({ safe: l.safeMode, enabled: l.plugins.filter((p) => p.enabled).map((p) => p.id), running: u.map((p) => p.id), title: document.title }))"));
// the title of the native window (what the user sees): the page cannot read it, so it is asked of the system (Windows only; elsewhere the check is skipped)
const windowTitle = () => {
  if (process.platform !== 'win32') return null;
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }) -join '|'"], { encoding: 'utf8' }).trim();
  } catch { return ''; }
};

try {
  // 1. a normal start, with one plugin turned on (the app answers the question: it is a test run)
  let { ui } = await launch();
  await ui.ev("window.tdtDesktop.plugins.setEnabled('tema', true)");
  await sleep(2500);
  let st = await state(ui);
  check('un arranque normal: el plugin está activado y corre', !st.safe && st.enabled.includes('tema') && st.running.join() === 'tema', JSON.stringify(st));
  await kill();

  // 2. first bad exit: still a normal start (one is bad luck)
  ({ ui } = await launch());
  st = await state(ui);
  check('tras un cierre malo, sigue siendo un arranque normal', !st.safe && st.running.join() === 'tema', JSON.stringify(st));
  await kill();

  // 3. second bad exit in a row: safe mode
  ({ ui } = await launch());
  st = await state(ui);
  check('tras dos cierres malos seguidos entra en modo seguro, y lo dice', /dos últimas veces/.test(st.safe || ''), st.safe);
  check('en modo seguro no corre ningún plugin, y los activados no se pierden de vista pero no están activados', st.running.length === 0 && st.enabled.length === 0, JSON.stringify(st));
  const nativeTitle = windowTitle();
if (nativeTitle !== null) check('el título de la ventana dice «MODO SEGURO»', /MODO SEGURO/.test(nativeTitle), nativeTitle);
  check('un aviso permanente con un botón para salir', (await ui.ev("document.querySelector('.safe-banner') ? document.querySelector('.safe-banner').textContent : ''")).includes('Salir del modo seguro'));
  const tryOn = await ui.ev("window.tdtDesktop.plugins.setEnabled('tema', false)");
  check('en modo seguro no se puede activar ni apagar nada (no se pisa lo guardado)', tryOn.plugins.every((p) => p.enabled === false) && tryOn.safeMode.length > 0);
  const refused = await ui.ev("window.tdtDesktop.plugins.admin({ do: 'plugin_enable', id: 'tema' })");
  check('ni siquiera por MCP: se rechaza diciendo por qué', refused.ok === false && /modo seguro/.test(refused.detail), refused.detail);
  check('las lecturas siguen funcionando (plugin_list)', (await ui.ev("window.tdtDesktop.plugins.admin({ do: 'plugin_list' })")).ok === true);
  check('el archivo de lo activado sigue intacto', JSON.parse(readFileSync(join(data, 'desktop', 'plugins.json'), 'utf8')).enabled?.includes('tema') || readFileSync(join(data, 'desktop', 'plugins.json'), 'utf8').includes('tema'));
  await closeClean(ui);

  // 4. a clean exit starts the count again
  ({ ui } = await launch());
  st = await state(ui);
  check('tras salir bien, el siguiente arranque es normal y el plugin vuelve (lo que activaste se conservó)', !st.safe && st.running.join() === 'tema', JSON.stringify(st));
  await kill();
  ({ ui } = await launch());
  await closeClean(ui);
  ({ ui } = await launch());
  st = await state(ui);
  check('un cierre limpio entre dos cierres malos no suma: un cierre malo, uno limpio, y sigue normal', !st.safe, JSON.stringify(st));
  await closeClean(ui);

  // 5. by hand: the flag and leaving it
  ({ ui } = await launch(['--safe']));
  st = await state(ui);
  check('con --safe entra en modo seguro sin haber fallado nada', /--safe/.test(st.safe || '') && st.running.length === 0, JSON.stringify(st));
  await ui.ev("window.tdtDesktop.safe.restart(false)");
  for (let i = 0; i < 40 && app.exitCode === null; i++) await sleep(500);
  ({ ui } = await launch());
  st = await state(ui);
  check('«Salir del modo seguro» deja un arranque normal, con el plugin otra vez', !st.safe && st.running.join() === 'tema', JSON.stringify(st));
  await closeClean(ui);
  ({ ui } = await launch([], { TDT_SAFE_MODE: '1' }));
  st = await state(ui);
  check('con TDT_SAFE_MODE=1 también', /TDT_SAFE_MODE/.test(st.safe || '') && st.running.length === 0, JSON.stringify(st));
  await closeClean(ui);
} catch (error) {
  check('la prueba termina sin error', false, String((error && error.message) || error));
}
try { app.kill(); } catch { /* already gone */ }
await sleep(1500);
rmSync(base, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} comprobaciones bien` + (failed.length ? `; FALLAN: ${failed.map((r) => r.name).join(' | ')}` : ''));
process.exit(failed.length ? 1 : 0);
