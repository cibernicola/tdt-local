// What an AI may do to the files of a plugin with permissions (desktop/lib/plugin-writer.js). It does not need Electron.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describePermission, riskOf, signature } from '../../desktop/lib/plugin-api.js';
import { USES, createPluginWriter, lint, syntaxProblems } from '../../desktop/lib/plugin-writer.js';
import { readPlugin } from '../../desktop/lib/plugins.js';

const spec = JSON.parse(readFileSync(new URL('../../tdtlocal/static/plugin-api.json', import.meta.url), 'utf8'));
const example = (name) => readFileSync(new URL(`../../docs/ejemplos/saludo/${name}`, import.meta.url), 'utf8');
const GOOD = { 'manifest.json': example('manifest.json'), 'index.html': example('index.html'), 'app.js': example('app.js') };

function world(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tdt-writer-'));
  const dir = join(root, 'plugins');
  mkdirSync(dir, { recursive: true });
  const state = { approved: {}, active: new Set(), asked: [], reloads: 0, answer: true, logs: [] };
  const writer = createPluginWriter({
    dir, readPlugin, signature, describePermission, riskOf,
    approved: () => state.approved,
    isActive: (id) => state.active.has(id),
    confirmWrite: async (ask) => { state.asked.push(ask); return typeof state.answer === 'function' ? state.answer(ask) : state.answer; },
    reload: () => { state.reloads += 1; },
    log: (level, text) => state.logs.push([level, text]),
    ...over,
  });
  return { root, dir, writer, state, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the example of the guide is a valid plugin that raises no warnings, and writing it asks the user and activates nothing', async () => {
  const { dir, writer, state, done } = world();
  try {
    const dry = await writer.write({ id: 'saludo', files: GOOD, dry_run: true });
    assert.equal(dry.ok, true, dry.detail);
    assert.deepEqual(dry.data.warnings, []);
    assert.deepEqual(dry.data.permissions, ['player.read', 'ui.toast']);
    assert.equal(dry.data.placement, 'float');
    assert.equal(state.asked.length, 0, 'a dry run asks nothing');
    assert.ok(!existsSync(join(dir, 'saludo')), 'and writes nothing');

    const r = await writer.write({ id: 'saludo', files: GOOD });
    assert.equal(r.ok, true, r.detail);
    assert.equal(state.asked.length, 1);
    assert.match(state.asked[0].message, /escribir el plugin «Saludo» \(saludo\)/);
    assert.match(state.asked[0].detail, /No correrá hasta que lo actives tú/);
    assert.match(state.asked[0].detail, /ver qué estás viendo.*riesgo medio/);
    assert.match(state.asked[0].detail, /mostrar avisos breves.*riesgo bajo/);
    assert.match(state.asked[0].detail, /panel flotante/);
    assert.match(state.asked[0].detail, /El código nuevo/);
    assert.deepEqual(readdirSync(join(dir, 'saludo')).sort(), ['app.js', 'index.html', 'manifest.json']);
    assert.equal(state.reloads, 1);
    assert.equal(r.data.active, false);
    assert.match(r.data.next, /tdt_plugin_enable/);
    assert.ok(state.logs.some(([level, text]) => level === 'WARN' && /aceptados por el usuario/.test(text)));
    assert.ok(!existsSync(state.asked[0].stageDir), 'the folder apart is gone');
  } finally {
    done();
  }
});

test('a plugin that does not pass is sent back to the AI with what is wrong, and the user is not bothered', async () => {
  const { writer, state, done } = world();
  try {
    const bad = async (files, pattern, id = 'malo') => {
      const r = await writer.write({ id, files });
      assert.equal(r.ok, false, JSON.stringify(files).slice(0, 80));
      assert.match(r.detail, pattern);
      return r;
    };
    const manifest = (tdt, extra = {}) => JSON.stringify({ name: 'M', version: '1', ...extra, tdt });
    await bad({ 'manifest.json': manifest({ api: 1, permissions: ['disco'] }), 'index.html': '<p>x</p>' }, /permiso desconocido/);
    await bad({ 'manifest.json': manifest({ api: 1, entry: 'no.html' }), 'index.html': '<p>x</p>' }, /tdt\.entry/);
    await bad({ 'manifest.json': manifest({ api: 1 }) }, /tdt\.entry/); // no page
    await bad({ 'manifest.json': manifest({ api: 0, dev: { page: 'p.js' } }), 'p.js': '1' }, /no es un plugin con permisos/);
    await bad({ 'manifest.json': '{ no es json', 'index.html': '' }, /manifest|JSON/i);
    await bad({ ...GOOD, 'app.js': 'const x = ;' }, /errores de sintaxis.*app\.js:1/);
    await bad({ ...GOOD, 'datos.json': '{ roto' }, /datos\.json: JSON no válido/);
    await bad({ ...GOOD, '../fuera.js': '1' }, /nombre de archivo no válido/);
    await bad({ ...GOOD, 'raro.exe': '1' }, /solo se admiten archivos/);
    await bad({ ...GOOD, 'grande.js': 'x'.repeat(70_000) }, /pesa más de 64 KB/);
    await bad({ 'manifest.json': null }, /sin archivos|manifest/);
    assert.equal((await writer.write({ id: 'Mayus', files: GOOD })).ok, false);
    assert.equal((await writer.write({ id: 'a', files: [] })).ok, false);
    assert.equal(state.asked.length, 0);
    assert.equal(state.reloads, 0);
  } finally {
    done();
  }
});

test('warnings say what usually goes wrong, and they do not stop the write', async () => {
  const { writer, state, done } = world();
  try {
    const files = {
      'manifest.json': JSON.stringify({ name: 'Avisos', version: '1', tdt: { api: 1, permissions: ['player.control', 'storage', 'network:a.com'] } }),
      'index.html': '<!doctype html><p>sin sdk ni esquema de color</p><script src="app.js"></script>',
      'app.js': "fetch('datos.json'); localStorage.setItem('a', 1); tdt.player.state(); tdt.epg.now('x');",
    };
    const dry = await writer.write({ id: 'avisos', files, dry_run: true });
    assert.equal(dry.ok, true, dry.detail);
    const text = dry.data.warnings.join('\n');
    assert.match(text, /ninguna página carga \/@tdt\/sdk\.js/);
    assert.match(text, /no declara color-scheme/);
    assert.match(text, /app\.js usa fetch\(\).*tdt\.net\.fetch/);
    assert.match(text, /usa localStorage.*tdt\.storage/);
    assert.match(text, /declara «player\.control» pero el código no lo usa/);
    assert.match(text, /declara «storage» pero el código no lo usa/);
    assert.match(text, /declara un «network:servidor» pero el código no lo usa/);
    assert.match(text, /usa una llamada que necesita «player\.read».*no declara «player\.read»/);
    assert.match(text, /usa una llamada que necesita «epg\.read»/);
    const r = await writer.write({ id: 'avisos', files });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.warnings, dry.data.warnings);
    assert.equal(state.asked.length, 1);
  } finally {
    done();
  }
});

test('the user can say no, and then nothing is written', async () => {
  const { dir, writer, state, done } = world();
  try {
    state.answer = false;
    const r = await writer.write({ id: 'saludo', files: GOOD });
    assert.deepEqual([r.ok, r.detail], [false, 'el usuario rechazó los cambios']);
    assert.ok(!existsSync(join(dir, 'saludo')));
    assert.equal(state.reloads, 0);
    assert.ok(state.logs.some(([, text]) => /rechazó/.test(text)));
  } finally {
    done();
  }
});

test('one question at a time: a second write while the user is deciding is refused', async () => {
  const { writer, state, done } = world();
  try {
    let answer;
    state.answer = () => new Promise((resolve) => { answer = resolve; });
    const first = writer.write({ id: 'saludo', files: GOOD });
    await new Promise((r) => setTimeout(r, 20));
    const second = await writer.write({ id: 'otro', files: GOOD });
    assert.equal(second.ok, false);
    assert.match(second.detail, /ya hay una pregunta esperando/);
    answer(true);
    assert.equal((await first).ok, true);
    assert.equal(state.asked.length, 1);
    const after = await writer.write({ id: 'otro', files: GOOD, dry_run: true });
    assert.equal(after.ok, true, 'a dry run is never refused for that');
  } finally {
    done();
  }
});

test('changing a plugin that is on: the same permissions reload it, other permissions make the user approve again', async () => {
  const { writer, state, done } = world();
  try {
    await writer.write({ id: 'saludo', files: GOOD });
    state.approved.saludo = signature(readPlugin(join(state.asked[0].stageDir, '..', '..', 'plugins', 'saludo')));
    state.active.add('saludo');
    // new code, same permissions
    const same = await writer.write({ id: 'saludo', files: { 'app.js': GOOD['app.js'] + '\n// cambio\n' } });
    assert.equal(same.ok, true, same.detail);
    assert.match(state.asked.at(-1).message, /cambiar el plugin/);
    assert.match(state.asked.at(-1).detail, /ESTÁ ACTIVADO con los mismos permisos/);
    assert.match(same.data.next, /se ha recargado/);
    assert.deepEqual(same.data.written, ['app.js']);
    // other permissions
    const manifest = JSON.parse(GOOD['manifest.json']);
    manifest.tdt.permissions.push('storage');
    const more = await writer.write({ id: 'saludo', files: { 'manifest.json': JSON.stringify(manifest), 'app.js': GOOD['app.js'] + "\ntdt.storage.get('k');\n" } });
    assert.equal(more.ok, true, more.detail);
    assert.match(state.asked.at(-1).detail, /pide otros permisos: dejará de correr hasta que lo vuelvas a activar/);
    assert.match(state.asked.at(-1).detail, /guardar sus propios datos/);
    // nothing changes: no question
    const before = state.asked.length;
    const none = await writer.write({ id: 'saludo', files: { 'app.js': readFileSync(join(state.asked[0].stageDir, '..', '..', 'plugins', 'saludo', 'app.js'), 'utf8') } });
    assert.deepEqual([none.ok, none.detail], [true, 'sin cambios']);
    assert.equal(state.asked.length, before);
  } finally {
    done();
  }
});

test('a file can be deleted, and the plugin can be read back to be edited', async () => {
  const { dir, writer, done } = world();
  try {
    await writer.write({ id: 'saludo', files: { ...GOOD, 'sobra.js': '// nada\n' } });
    assert.ok(existsSync(join(dir, 'saludo', 'sobra.js')));
    const read = await writer.read('saludo');
    assert.equal(read.ok, true);
    assert.deepEqual(Object.keys(read.data.files).sort(), ['app.js', 'index.html', 'manifest.json', 'sobra.js']);
    assert.equal(read.data.files['app.js'], GOOD['app.js']);
    const removed = await writer.write({ id: 'saludo', files: { 'sobra.js': null } });
    assert.deepEqual(removed.data.removed, ['sobra.js']);
    assert.ok(!existsSync(join(dir, 'saludo', 'sobra.js')));
    assert.equal((await writer.read('no-existe')).ok, false);
    assert.equal((await writer.read('../x')).ok, false);
    assert.equal((await writer.read(5)).ok, false);
  } finally {
    done();
  }
});

test('the checks of the scripts: syntax with its line, modules left alone', () => {
  assert.deepEqual(syntaxProblems({ 'a.js': 'const x = 1;', 'b.json': '{"a":1}', 'c.html': '<' }), []);
  assert.match(syntaxProblems({ 'a.js': 'let a = 1;\nlet = = 2;' })[0], /^a\.js:2: /);
  assert.deepEqual(syntaxProblems({ 'm.js': "import { x } from './y.js';\nexport const z = 1;" }), [], 'a module cannot be checked here');
  assert.deepEqual(syntaxProblems({ 'm.mjs': 'esto no es js (' }), []);
  assert.match(syntaxProblems({ 'd.json': '{' })[0], /JSON no válido/);
});

test('the uses of the SDK that need a permission are the permissions of the specification', () => {
  const permissions = Object.keys(spec.permissions).map((p) => (p.startsWith('network:') ? 'network' : p.startsWith('embed:') ? 'embed' : p)).sort();
  assert.deepEqual(Object.keys(USES).sort(), permissions);
  for (const [name, def] of Object.entries(spec.methods)) {
    const need = def.permission === null ? null : def.permission.startsWith('network:') ? 'network' : def.permission;
    if (need) assert.match(`tdt.${name}(`, USES[need], `${name} is not recognised as a use of ${need}`);
  }
  assert.deepEqual(lint(GOOD, readPlugin(new URL('../../docs/ejemplos/saludo', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), []);
});
