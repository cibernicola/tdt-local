// A real MCP client against the real app: Claude Code (the `claude` command) is started with TDT local's MCP server and asked to do a tour of its tools. What it did is read from
// its own transcript (every tool call and its answer), and what changed in the app is looked at in the page, so nothing depends on what the model says it did.
//
//   node scripts/plugin-lab/mcp-claude.mjs        (from the root of the repository; needs `npm install` in desktop/ and `claude` installed and signed in)
//   MCP_CLAUDE_TRANSPORT=http node scripts/plugin-lab/mcp-claude.mjs        (the same tour, connecting by HTTP to `POST /mcp` with the token instead of by stdio)
//
// It uses your Claude Code (a few turns each run), so it is not part of the CI or of the other banks. It starts the desktop app with a temporary data folder, the access of AIs on at the
// development level and the native questions answered by the test (never in an installed app), writes a config for Claude Code that starts `python -m tdtlocal mcp` against that folder,
// and runs `claude -p` with only that server allowed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.BENCH_DEBUG_PORT || 9741);
const MODEL = process.env.MCP_CLAUDE_MODEL || ''; // empty: the one Claude Code uses
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = mkdtempSync(join(tmpdir(), 'tdt-mcp-claude-'));
const data = join(base, 'data');
mkdirSync(data, { recursive: true });

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

const THEME_MANIFEST = JSON.stringify({ name: 'Violeta', version: '0.1.0', author: 'Claude Code', tdt: { api: 1, full: { css: 'tema.css' } } });
const THEME_CSS = ':root { --accent: #8e44ad; --accent-ink: #ffffff; }\n';
const PROMPT = `Estás conectado al servidor MCP «tdt» (TDT local). Haz esto en este orden, llamando a las herramientas de verdad (no inventes resultados), y no hagas nada más:
1. tdt_state: dime si hay canal y cuál es el volumen.
2. tdt_search_channels con la búsqueda «La 2».
3. tdt_set_volume con el volumen 0.3.
4. tdt_events: dime cuántos eventos devuelve.
5. tdt_plugin_api con el método player.state.
6. tdt_plugin_write con dry_run true para el plugin con id «violeta-ia» y estos dos archivos exactos: manifest.json = ${JSON.stringify(THEME_MANIFEST)} y tema.css = ${JSON.stringify(THEME_CSS)}. Dime si dice que es un tema.
7. Si el paso 6 fue bien, repite tdt_plugin_write igual pero SIN dry_run (el usuario contestará la pregunta), y después tdt_plugin_enable para «violeta-ia».
8. tdt_plugins: dime si «violeta-ia» sale activado.
9. tdt_rules_get.
Termina con una sola línea de texto que empiece por RESULTADO: y diga en pocas palabras qué funcionó y qué no.`;

const electron = join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = spawn(electron, ['.'], {
  cwd: join(ROOT, 'desktop'),
  env: {
    ...process.env, TDT_DEBUG_PORT: String(PORT), TDT_DATA_DIR: data, TDT_DEV_CONFIRM: 'yes', TDT_TEST_NO_OPEN: '1', TDT_TEST_NO_RELAUNCH: '1', TDT_CONTROL_ENABLED: '1', TDT_CONTROL_LEVEL: 'dev',
  },
  stdio: 'ignore',
});

let claude = null;
try {
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(500);
    try { page = (await targets()).find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:')); } catch { /* not yet */ }
  }
  if (!page) throw new Error('la aplicación no arrancó');
  const ui = await connect(page.webSocketDebuggerUrl);
  for (let i = 0; i < 40 && !(existsSync(join(data, 'control-token')) && existsSync(join(data, 'desktop', 'port.json'))); i++) await sleep(500);
  await sleep(4000); // the page publishes its state to the bus a few times a second: let it start
  check('la aplicación está en marcha con el acceso de IAs encendido', existsSync(join(data, 'control-token')));

  // two ways to connect, the two the app offers: by standard input and output (Claude Code starts `python -m tdtlocal mcp`), or by HTTP (`POST /mcp` of the app, with the token)
  const http = process.env.MCP_CLAUDE_TRANSPORT === 'http';
  const config = join(base, 'mcp.json');
  if (http) {
    const port = JSON.parse(readFileSync(join(data, 'desktop', 'port.json'), 'utf8')).port;
    const token = readFileSync(join(data, 'control-token'), 'utf8').trim();
    writeFileSync(config, JSON.stringify({ mcpServers: { tdt: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }));
  } else {
    writeFileSync(config, JSON.stringify({ mcpServers: { tdt: { command: 'python', args: ['-m', 'tdtlocal', 'mcp'], env: { TDT_DATA_DIR: data, PYTHONIOENCODING: 'utf-8' } } } }));
  }
  console.log(`Conexión: ${http ? 'HTTP (POST /mcp)' : 'entrada y salida estándar (stdio)'}`);
  // the prompt goes in by standard input: as an argument its quotes and lines do not survive a command line on Windows
  const args = ['-p', '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__tdt', '--output-format', 'stream-json', '--verbose', '--max-turns', '40'];
  if (MODEL) args.push('--model', MODEL);
  const lines = [];
  let chunk = '';
  await new Promise((resolve) => {
    claude = spawn(process.platform === 'win32' ? 'claude.exe' : 'claude', args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    claude.on('error', (error) => { console.log('no se pudo arrancar «claude»: ' + error.message); resolve(); });
    claude.stdin.end(PROMPT);
    const timer = setTimeout(() => { try { claude.kill(); } catch { /* gone */ } resolve(); }, 8 * 60 * 1000);
    claude.stdout.on('data', (d) => {
      chunk += d.toString('utf8');
      const parts = chunk.split('\n');
      chunk = parts.pop();
      for (const line of parts) if (line.trim()) lines.push(line);
    });
    claude.stderr.on('data', (d) => process.stderr.write(d));
    claude.on('close', () => { clearTimeout(timer); resolve(); });
  });
  if (chunk.trim()) lines.push(chunk);

  // what Claude Code did, from its own transcript
  const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const server = init && (init.mcp_servers || []).find((s) => s.name === 'tdt');
  check('Claude Code conecta con el servidor MCP «tdt»', !!server && server.status === 'connected', JSON.stringify(server || init && init.mcp_servers));
  const tools = (init && init.tools || []).filter((t) => t.startsWith('mcp__tdt__'));
  check('y ve sus herramientas', tools.length >= 25 && tools.includes('mcp__tdt__tdt_state') && tools.includes('mcp__tdt__tdt_plugin_write'), `${tools.length} herramientas`);

  const calls = [];
  const answers = new Map();
  for (const e of events) {
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const part of content) {
      if (e.type === 'assistant' && part.type === 'tool_use') calls.push({ id: part.id, name: part.name.replace('mcp__tdt__', ''), input: part.input });
      if (e.type === 'user' && part.type === 'tool_result') {
        const text = Array.isArray(part.content) ? part.content.map((c) => c.text || '').join('') : String(part.content || '');
        answers.set(part.tool_use_id, { error: !!part.is_error, text });
      }
    }
  }
  const called = (name) => calls.filter((c) => c.name === name).map((c) => ({ ...c, ...(answers.get(c.id) || { error: true, text: 'sin respuesta' }) }));
  const first = (name) => called(name)[0];
  const ok = (name) => { const c = first(name); return !!c && !c.error; };

  check('llamó a tdt_state y le contestó', ok('tdt_state'), first('tdt_state') && first('tdt_state').text.slice(0, 80));
  check('buscó «La 2» y salió el canal', ok('tdt_search_channels') && /La 2/.test(first('tdt_search_channels').text));
  check('cambió el volumen con tdt_set_volume', ok('tdt_set_volume'), first('tdt_set_volume') && first('tdt_set_volume').text.slice(0, 80));
  check('en la página el volumen es el que pidió (0,3)', Math.abs(Number(await ui.ev("import('/js/state.js').then((m) => m.state.vol.v)")) - 0.3) < 0.011);
  check('leyó los eventos y la especificación de la API', ok('tdt_events') && ok('tdt_plugin_api'));
  const writes = called('tdt_plugin_write');
  const dry = writes.find((c) => c.input && c.input.dry_run === true);
  const real = writes.find((c) => c.input && !c.input.dry_run);
  check('comprobó el tema con dry_run y la aplicación dijo que es un tema', !!dry && !dry.error && /"theme":\s*true/.test(dry.text) && /"kind":\s*"full"/.test(dry.text), dry && dry.text.slice(0, 100));
  check('lo escribió de verdad (el usuario contestó la pregunta) y lo activó', !!real && !real.error && ok('tdt_plugin_enable'), real && real.text.slice(0, 100));
  let accent = '';
  for (let i = 0; i < 30 && accent !== '#8e44ad'; i++) {
    try { accent = await ui.ev("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()"); } catch { /* reloading */ }
    if (accent !== '#8e44ad') await sleep(500);
  }
  check('y en la página el tema que escribió la IA está aplicado', accent === '#8e44ad', 'acento ' + accent);
  check('listó los plugins y las reglas', ok('tdt_plugins') && /violeta-ia/.test((first('tdt_plugins') || { text: '' }).text) && ok('tdt_rules_get'));
  const bad = calls.map((c) => ({ ...c, ...(answers.get(c.id) || { error: true, text: 'sin respuesta' }) })).filter((c) => c.error);
  check('ninguna llamada dio error', bad.length === 0, bad.map((c) => `${c.name}: ${c.text.slice(0, 100)}`).join(' | '));
  const finalText = (events.find((e) => e.type === 'result') || {}).result || '';
  console.log('\nLo que dice Claude Code: ' + String(finalText).replace(/\s+/g, ' ').slice(0, 400));
  console.log(`Herramientas llamadas (${calls.length}): ` + calls.map((c) => c.name).join(', '));
} catch (error) {
  check('la prueba termina sin error', false, String((error && error.message) || error));
}
try { app.kill(); } catch { /* gone */ }
try { if (claude) claude.kill(); } catch { /* gone */ }
await sleep(1500);
rmSync(base, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} comprobaciones bien` + (failed.length ? `; FALLAN: ${failed.map((r) => r.name).join(' | ')}` : ''));
process.exit(failed.length ? 1 : 0);
