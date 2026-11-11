// The test of the hooks in the real desktop app: a development plugin (without isolation) gets the same `tdt` the included plugins get, and uses it to add a step to the
// reaction to an ad break, with a plugin that fails beside it.
//
//   node scripts/plugin-lab/hooks.mjs        (from the root of the repository; needs `npm install` in desktop/)
//
// It starts the app with a temporary data folder and a folder of development plugins: `anuncio` (adds a step, listens, uses `await` at the top, returns a function to run when it goes)
// and `roto` (a filter and a listener that throw). Then it makes an ad break happen in the page and looks at what was done.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.BENCH_DEBUG_PORT || 9734);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = mkdtempSync(join(tmpdir(), 'tdt-hooks-'));
const data = join(base, 'data');
const devDir = join(base, 'dev-plugins');

const plugin = (id, page) => {
  mkdirSync(join(devDir, id), { recursive: true });
  writeFileSync(join(devDir, id, 'manifest.json'), JSON.stringify({ name: id, version: '1.0.0', tdt: { api: 0, dev: { page: 'page.js' } } }));
  writeFileSync(join(devDir, id, 'page.js'), page);
};
plugin('anuncio', `
const v = await Promise.resolve(42);
tdt.register('ad.actions', 'banner', { run(ctx, step) {
  const d = document.createElement('div'); d.id = 'lab-banner'; d.textContent = step.text + ' · ' + ctx.channel.name; document.body.append(d);
  return { lift: () => d.remove() };
} });
tdt.filter('ad.reaction', (steps) => [...steps, { do: 'banner', text: 'ANUNCIO' }], 20);
tdt.on('ad.started', (a) => tdt.log('empieza', a.name, 'await=' + v));
return () => { window.__cleaned = true; };
`);
plugin('capa', `
tdt.register('tile.overlay', 'etiqueta', { mount(ctx) {
  const el = document.createElement('div'); el.className = 'lab-capa';
  el.style.cssText = 'position:absolute;right:8px;bottom:8px;background:#c0392b;color:#fff;padding:4px 10px;border-radius:6px;font:600 13px system-ui';
  const paint = (c) => { el.textContent = 'Casilla ' + (c.tile.index + 1) + (c.tile.focus ? ' ★' : '') + ' · ' + c.mode; };
  paint(ctx);
  return { el, update: paint, destroy: () => { window.__capaDestruida = (window.__capaDestruida || 0) + 1; } };
} });
`);
plugin('roto', `
tdt.on('ad.started', () => { throw new Error('roto a propósito'); });
tdt.filter('ad.reaction', () => { throw new Error('filtro roto'); }, 5);
`);

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

const app = spawn(join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), ['.'], {
  cwd: join(ROOT, 'desktop'),
  env: {
    ...process.env, TDT_DEBUG_PORT: String(PORT), TDT_DATA_DIR: data, TDT_DEV_PLUGINS_DIR: devDir, TDT_DEV: '1', TDT_DEV_APPROVE: 'all', TDT_DEV_CONFIRM: 'yes',
    TDT_TEST_NO_RELAUNCH: '1',
  },
  stdio: 'ignore',
});

try {
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(500);
    try { page = (await targets()).find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:')); } catch { /* not yet */ }
  }
  if (!page) throw new Error('la aplicación no arrancó');
  const ui = await connect(page.webSocketDebuggerUrl);
  await sleep(5000);

  const list = () => ui.ev("import('/js/hooks.js').then((m) => JSON.stringify(m.trusted.list().map((p) => [p.id, p.state, p.errors])))").then(JSON.parse);
  let plugins = await list();
  const state = (id) => (plugins.find((p) => p[0] === id) || [])[1];
  check('el plugin incluido y los dos de desarrollo están cargados por el mismo cargador', state('ads') === 'on' && state('dev:anuncio') === 'on' && state('dev:roto') === 'on', JSON.stringify(plugins));
  check('el plugin de desarrollo registró su acción en el registro de la aplicación', (await ui.ev("import('/js/hooks.js').then((m) => m.hooks.list('ad.actions').map((e) => e.id).join())")).includes('banner'));

  // an ad break in the page: the same one the SCTE markers make
  const breakOnce = (seconds = 60) => ui.ev(`(async () => {
    const { state } = await import('/js/state.js'); const ads = await import('/js/adbreak.js');
    const t = state.tiles[state.focus || 0]; const c = state.channels.find((x) => !x.kind || x.kind === 'tv') || state.channels[0]; t.c = c;
    ads.setAds({ flag: true, audio: 'mute', lower_percent: 30, screen: 'keep', channel: '', web_url: '', min_seconds: 5, unknown_seconds: ${seconds}, on_touch: 'respect' });
    ads.adsEvents([{ channel: c.id, kind: 'cue-out-cont', duration: ${seconds}, elapsed: 0 }]);
    await new Promise((r) => setTimeout(r, 250));
    const during = { banner: document.getElementById('lab-banner') ? document.getElementById('lab-banner').textContent : '', duck: t.duck, flag: !!(t.flagEl && t.flagEl.isConnected && !t.flagEl.hidden) };
    ads.setAds(null);
    await new Promise((r) => setTimeout(r, 150));
    return JSON.stringify({ during, bannerAfter: !!document.getElementById('lab-banner'), duckAfter: t.duck });
  })()`).then(JSON.parse);

  const first = await breakOnce();
  check('en una pausa, el paso del plugin se hace junto a los de la aplicación', /^ANUNCIO · /.test(first.during.banner) && first.during.duck && first.during.duck.muted === true && first.during.flag, JSON.stringify(first.during));
  check('al acabar la pausa, el paso del plugin se deshace solo', first.bannerAfter === false && first.duckAfter === null, JSON.stringify({ banner: first.bannerAfter, duck: first.duckAfter }));
  plugins = await list();
  check('un plugin que falla cuenta sus fallos y el resto sigue', state('dev:roto') === 'on' && plugins.find((p) => p[0] === 'dev:roto')[2] >= 2 && state('dev:anuncio') === 'on', JSON.stringify(plugins));

  await breakOnce();
  await breakOnce();
  plugins = await list();
  check('con cinco fallos, solo ese plugin se apaga', state('dev:roto') === 'failed' && state('dev:anuncio') === 'on' && state('ads') === 'on', JSON.stringify(plugins));
  const later = await breakOnce();
  check('y la reacción a la publicidad sigue funcionando', /^ANUNCIO · /.test(later.during.banner) && later.during.duck && later.during.duck.muted === true, JSON.stringify(later.during));

  // a layer over the picture of every tile (slot «tile.overlay»)
  const layers = JSON.parse(await ui.ev(`(async () => {
    document.getElementById('btnMulti').click();
    await new Promise((r) => setTimeout(r, 800));
    const caps = [...document.querySelectorAll('.lab-capa')];
    const r = caps[0].getBoundingClientRect();
    const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    document.querySelectorAll('.tile')[1].click();
    await new Promise((r2) => setTimeout(r2, 300));
    return JSON.stringify({ n: caps.length, inBox: caps.every((c) => c.parentElement.classList.contains('tile-overlays')), through: !!under && under !== caps[0], after: [...document.querySelectorAll('.lab-capa')].map((c) => c.textContent) });
  })()`));
  check('un plugin pone una capa sobre la imagen de cada casilla', layers.n === 4 && layers.inBox, JSON.stringify(layers));
  check('la capa deja pasar el clic, y se entera de que el foco cambió', layers.through && /★/.test(layers.after[1]) && !/★/.test(layers.after[0]), JSON.stringify(layers.after));

  const logs = JSON.stringify(await ui.ev("window.tdtDesktop.dev.admin({ do: 'dev_logs', id: 'anuncio' })"));
  check('lo que dice un plugin con tdt.log llega al registro con su nombre, con los datos del evento (y el await del principio funcionó)', /empieza La 1 await=42/.test(logs), logs.slice(0, 200));
  const brokenLogs = JSON.stringify(await ui.ev("window.tdtDesktop.dev.admin({ do: 'dev_logs', id: 'roto' })"));
  check('los fallos del plugin roto llegan al registro, con qué fue', /roto a propósito|filtro roto/.test(brokenLogs), brokenLogs.slice(0, 200));
} catch (error) {
  check('la prueba termina sin error', false, String((error && error.message) || error));
}
try { app.kill(); } catch { /* already gone */ }
await sleep(1500);
rmSync(base, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} comprobaciones bien` + (failed.length ? `; FALLAN: ${failed.map((r) => r.name).join(' | ')}` : ''));
process.exit(failed.length ? 1 : 0);
