// The test, in the real desktop app, of a plugin with all the power that a user installs and turns on WITHOUT the developer mode:
//
//   node scripts/plugin-lab/full.mjs        (from the root of the repository; needs `npm install` in desktop/)
//
// A folder `cartel` (in the plugins folder) and a package `instalado.tdtplugin` (a folder stands for the internet, as in bench.mjs). It checks: it is listed and off; turning it on
// (the app answers its own question: it is a test run) hands its code to the page, where it uses the hooks; what it says reaches the log under its name; a change in its code
// stops it until the user approves again; it installs from a link like any other; and in safe mode none of them runs.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { packFolder } = await import(pathToFileURL(join(ROOT, 'desktop', 'lib', 'plugin-pack.js')).href);
const PORT = Number(process.env.BENCH_DEBUG_PORT || 9735);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = mkdtempSync(join(tmpdir(), 'tdt-full-'));
const data = join(base, 'data');
const plugins = join(base, 'plugins');
const internet = join(base, 'internet');
mkdirSync(plugins, { recursive: true });
mkdirSync(internet, { recursive: true });

const PAGE = (word) => `
tdt.register('ad.actions', 'banner', { run(ctx) {
  const d = document.createElement('div'); d.id = 'lab-banner'; d.textContent = '${word} · ' + ctx.channel.name; document.body.append(d);
  return { lift: () => d.remove() };
} });
tdt.filter('ad.reaction', (steps) => [...steps, { do: 'banner' }], 20);
tdt.log('arrancado: ${word}');
`;
const make = (root, id, word) => {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: id, version: '1.0.0', author: 'Ana', tdt: { api: 1, full: { page: 'page.js' } } }));
  writeFileSync(join(dir, 'page.js'), PAGE(word));
  return dir;
};
make(plugins, 'cartel', 'PRIMERA');
// two themes: a style sheet and no code (one with a picture of its own, that has to arrive inside the sheet)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const makeTheme = (id, accent) => {
  const dir = join(plugins, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: id, version: '1.0.0', author: 'Ana', tdt: { api: 1, full: { css: 'tema.css' } } }));
  writeFileSync(join(dir, 'tema.css'), `:root { --accent: ${accent}; } body { background-image: url(fondo.png); }`);
  writeFileSync(join(dir, 'fondo.png'), PNG);
};
makeTheme('tema-rojo', '#c0392b');
makeTheme('tema-verde', '#27ae60');
const staged = mkdtempSync(join(tmpdir(), 'tdt-full-stage-'));
writeFileSync(join(internet, 'instalado.tdtplugin'), packFolder(make(staged, 'instalado', 'INSTALADO'), 'instalado'));
rmSync(staged, { recursive: true, force: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

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

let app = null;
async function launch(extra = {}) {
  app = spawn(join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), ['.'], {
    cwd: join(ROOT, 'desktop'),
    env: {
      ...process.env, TDT_DEBUG_PORT: String(PORT), TDT_DATA_DIR: data, TDT_PLUGINS_DIR: plugins, TDT_DEV_CONFIRM: 'yes', TDT_TEST_NO_RELAUNCH: '1', TDT_TEST_NO_OPEN: '1', TDT_TEST_LINK_DIR: internet, ...extra,
    },
    stdio: 'ignore',
  });
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(500);
    try { page = (await targets()).find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:')); } catch { /* not yet */ }
  }
  if (!page) throw new Error('la aplicación no arrancó');
  const ui = await connect(page.webSocketDebuggerUrl);
  await sleep(5000);
  return ui;
}
const closeApp = async (ui) => { await ui.send('Browser.close').catch(() => {}); for (let i = 0; i < 40 && app.exitCode === null; i++) await sleep(500); await sleep(500); };

const running = (ui) => ui.ev("import('/js/hooks.js').then((m) => JSON.stringify(m.trusted.list().map((p) => [p.id, p.state])))").then(JSON.parse);
const has = (list, id) => list.some((p) => p[0] === id && p[1] === 'on');
const waitFor = async (ui, id, want, ms = 25000) => {
  for (let t = 0; t < ms; t += 500) {
    try { if (has(await running(ui), id) === want) return true; } catch { /* the page is reloading */ }
    await sleep(500);
  }
  return false;
};
const listed = (ui) => ui.ev('window.tdtDesktop.plugins.list()');
const breakOnce = (ui) => ui.ev(`(async () => {
  const { state } = await import('/js/state.js'); const ads = await import('/js/adbreak.js');
  const t = state.tiles[state.focus || 0]; const c = state.channels.find((x) => !x.kind || x.kind === 'tv') || state.channels[0]; t.c = c;
  ads.setAds({ flag: false, audio: 'mute', lower_percent: 30, screen: 'keep', channel: '', web_url: '', min_seconds: 5, unknown_seconds: 60, on_touch: 'respect' });
  ads.adsEvents([{ channel: c.id, kind: 'cue-out-cont', duration: 60, elapsed: 0 }]);
  await new Promise((r) => setTimeout(r, 250));
  const banner = document.getElementById('lab-banner') ? document.getElementById('lab-banner').textContent : '';
  ads.setAds(null);
  await new Promise((r) => setTimeout(r, 100));
  return banner;
})()`);

try {
  let ui = await launch(); // no TDT_DEV: the developer mode is off
  let l = await listed(ui);
  const cartel = () => l.plugins.find((p) => p.id === 'cartel');
  check('el plugin con todo el poder está en la lista, sin problemas y apagado', cartel() && cartel().kind === 'full' && !cartel().problems.length && cartel().enabled === false && /^[0-9a-f]{16}$/.test(cartel().hash), JSON.stringify(cartel()));
  check('sin el modo desarrollador', (await ui.ev('window.tdtDesktop.dev.state()')).mode === false);
  check('apagado, su código no llega a la página', !(await running(ui)).some((p) => p[0] === 'full:cartel'));

  const on = await ui.ev("window.tdtDesktop.plugins.setEnabled('cartel', true)");
  check('al activarlo (la aplicación contesta su pregunta) queda activado', on && on.plugins.find((p) => p.id === 'cartel').enabled === true);
  check('la página se recarga y recibe su código: corre con el mismo cargador', await waitFor(ui, 'full:cartel', true));
  check('usa los ganchos: su paso se hace en una pausa de anuncios', (await breakOnce(ui)) === 'PRIMERA · La 1');
  const logs = JSON.stringify(await ui.ev("window.tdtDesktop.plugins.admin({ do: 'plugin_logs', id: 'cartel' })"));
  check('lo que dice llega al registro con su nombre (también por MCP)', /arrancado: PRIMERA/.test(logs), logs.slice(0, 160));

  // the code changes on disk after the approval
  writeFileSync(join(plugins, 'cartel', 'page.js'), PAGE('SEGUNDA'));
  l = await ui.ev('window.tdtDesktop.plugins.rescan()');
  check('si cambia su código, ya no está aprobado: pide volver a activarlo y no corre', cartel().needsApproval === true && cartel().enabled === false, JSON.stringify({ needs: cartel().needsApproval, on: cartel().enabled }));
  await ui.ev('location.reload()');
  await sleep(6000);
  check('y su código nuevo no llega a la página', !has(await running(ui), 'full:cartel'));
  const again = await ui.ev("window.tdtDesktop.plugins.setEnabled('cartel', true)");
  // the plugin is listed as running a moment before the page of a reload has everything in place: the break is tried a few times
  let second = '';
  const running2 = again.plugins.find((p) => p.id === 'cartel').enabled === true && (await waitFor(ui, 'full:cartel', true));
  for (let i = 0; running2 && i < 4 && second !== 'SEGUNDA · La 1'; i++) { second = await breakOnce(ui); if (second !== 'SEGUNDA · La 1') await sleep(1000); }
  check('al activarlo otra vez (con el código nuevo delante) corre el nuevo', running2 && second === 'SEGUNDA · La 1', second);

  // install from a link, like any other package
  const done = await ui.ev("window.tdtDesktop.plugins.installLink('https://plugins.example.org/instalado.tdtplugin')");
  check('se instala desde un enlace como los demás, y no queda activado', done && done.id === 'instalado' && done.list.plugins.find((p) => p.id === 'instalado').kind === 'full' && done.list.plugins.find((p) => p.id === 'instalado').enabled === false, JSON.stringify(done && { id: done.id, error: done.error }));
  await ui.ev("window.tdtDesktop.plugins.setEnabled('instalado', true)");
  check('activado, el instalado corre también', await waitFor(ui, 'full:instalado', true));
  await ui.ev("window.tdtDesktop.plugins.setEnabled('instalado', false)");
  check('apagado, deja de correr', await waitFor(ui, 'full:instalado', false));

  // themes: a style sheet, with its picture inside, and one at a time
  const accent = () => ui.ev("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()");
  const background = () => ui.ev('getComputedStyle(document.body).backgroundImage');
  const waitAccent = async (want) => { for (let t = 0; t < 25000; t += 500) { try { if ((await accent()) === want) return true; } catch { /* reloading */ } await sleep(500); } return false; };
  const before = await accent();
  l = await listed(ui);
  check('un tema se lista como plugin con todo el poder pero solo con hoja de estilo', l.plugins.find((p) => p.id === 'tema-rojo').scopes.join() === 'css' && !l.plugins.find((p) => p.id === 'tema-rojo').problems.length);
  await ui.ev("window.tdtDesktop.plugins.setEnabled('tema-rojo', true)");
  check('al activar un tema, la hoja de estilo cambia la página', await waitAccent('#c0392b'), 'antes ' + before);
  check('su imagen llega dentro de la hoja (la página no carga nada de fuera)', String(await background()).startsWith('url("data:image/png;base64,'), String(await background()).slice(0, 40));
  await ui.ev("window.tdtDesktop.plugins.setEnabled('tema-verde', true)");
  l = await listed(ui);
  check('solo hay un tema a la vez: activar otro apaga el anterior', (await waitAccent('#27ae60')) && l.plugins.find((p) => p.id === 'tema-rojo').enabled === false && l.plugins.find((p) => p.id === 'tema-verde').enabled === true);
  await ui.ev("window.tdtDesktop.plugins.setEnabled('tema-verde', false)");
  check('apagado, el aspecto vuelve al de la aplicación', await waitAccent(before));

  // an AI writes a theme and a plugin with all the power (the path of the MCP: plugin_write; the app answers the question, it is a test run), and the buttons make working ones
  const write = (id, files, dry = false) => ui.ev(`window.tdtDesktop.plugins.admin(${JSON.stringify({ do: 'plugin_write', id, files, dry_run: dry })})`);
  const manifestOf = (full) => JSON.stringify({ name: 'De la IA', version: '0.1.0', author: 'Una IA', tdt: { api: 1, full } });
  const aiDry = await write('tema-ia', { 'manifest.json': manifestOf({ css: 'tema.css' }), 'tema.css': ':root { --accent: #8e44ad; }' }, true);
  check('una IA comprueba un tema antes de escribirlo: válido, es un tema, y no se escribe nada', aiDry.ok && aiDry.data.theme === true && aiDry.data.kind === 'full' && !(await listed(ui)).plugins.some((p) => p.id === 'tema-ia'), JSON.stringify(aiDry.data || aiDry.detail).slice(0, 120));
  const badAi = await write('codigo-ia', { 'manifest.json': manifestOf({ page: 'page.js' }), 'page.js': "fetch('https://example.com/x'); document.title = 1;" }, true);
  check('y le avisa de lo que suele salir mal en el código (internet bloqueado, no usa tdt)', badAi.ok && badAi.data.warnings.some((w) => /connect-src/.test(w)) && badAi.data.warnings.some((w) => /no usa «tdt»/.test(w)), JSON.stringify(badAi.data && badAi.data.warnings).slice(0, 160));
  const aiWrote = await write('tema-ia', { 'manifest.json': manifestOf({ css: 'tema.css' }), 'tema.css': ':root { --accent: #8e44ad; }' });
  l = await listed(ui);
  check('al escribirlo (con la pregunta contestada) queda escrito y apagado: escribir no activa', aiWrote.ok && l.plugins.find((p) => p.id === 'tema-ia') && l.plugins.find((p) => p.id === 'tema-ia').enabled === false, aiWrote.detail);
  await ui.ev("window.tdtDesktop.plugins.setEnabled('tema-ia', true)");
  check('activado, lo que escribió la IA cambia la página (y apaga el otro tema)', await waitAccent('#8e44ad'));
  const dev = await write('desarrollo-ia', { 'manifest.json': JSON.stringify({ name: 'x', tdt: { api: 0, dev: { page: 'page.js' } } }), 'page.js': 'tdt.log(1)' }, true);
  check('un manifest de otra clase se rechaza diciendo cuáles se admiten', dev.ok === false && /con todo el poder/.test(dev.detail), dev.detail);
  const madeTheme = await ui.ev("window.tdtDesktop.plugins.create('Mi tema', 'theme')");
  const madeFull = await ui.ev("window.tdtDesktop.plugins.create('Mi plugin con todo el poder', 'full')");
  const byId = (id) => (madeFull.list.plugins.find((p) => p.id === id));
  check('los botones de crear hacen un tema y un plugin con todo el poder que ya funcionan, sin problemas', madeTheme.id === 'mi-tema' && madeFull.id === 'mi-plugin-con-todo-el-poder' && byId('mi-tema').kind === 'full' && !byId('mi-tema').problems.length && !byId('mi-plugin-con-todo-el-poder').problems.length, JSON.stringify([madeTheme.id, madeFull.id]));
  await ui.ev("window.tdtDesktop.plugins.setEnabled('mi-tema', true)");
  // the template has a colour for the light scheme and another for the dark one: the one that applies depends on the system of whoever runs this
  check('la plantilla de tema, tal como se crea, se aplica', (await waitAccent('#c0392b')) || (await waitAccent('#e0705e')), 'acento ' + (await accent()));
  await ui.ev("window.tdtDesktop.plugins.setEnabled('mi-plugin-con-todo-el-poder', true)");
  check('y la de plugin con todo el poder corre y pone su capa sobre cada casilla', (await waitFor(ui, 'full:mi-plugin-con-todo-el-poder', true)) && (await ui.ev("import('/js/hooks.js').then((m) => m.hooks.list('tile.overlay').map((e) => e.id).join())")).includes('etiqueta'));
  await ui.ev("window.tdtDesktop.plugins.setEnabled('mi-plugin-con-todo-el-poder', false)");
  await ui.ev("window.tdtDesktop.plugins.setEnabled('tema-rojo', true)");
  await waitAccent('#c0392b');
  await closeApp(ui);

  // safe mode: nothing runs, whatever is turned on
  ui = await launch({ TDT_SAFE_MODE: '1' });
  l = await listed(ui);
  check('en modo seguro ninguno corre, aunque estén activados', !!l.safeMode && !(await running(ui)).some((p) => p[0].startsWith('full:')), JSON.stringify(await running(ui)));
  const refused = await ui.ev("window.tdtDesktop.plugins.admin({ do: 'plugin_enable', id: 'instalado' })");
  check('y no se puede activar ninguno', refused.ok === false);
  check('ni se aplica el tema que estaba activado', (await ui.ev("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")) !== '#c0392b');
  await closeApp(ui);
} catch (error) {
  check('la prueba termina sin error', false, String((error && error.message) || error));
}
try { app.kill(); } catch { /* already gone */ }
await sleep(1500);
rmSync(base, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} comprobaciones bien` + (failed.length ? `; FALLAN: ${failed.map((r) => r.name).join(' | ')}` : ''));
process.exit(failed.length ? 1 : 0);
