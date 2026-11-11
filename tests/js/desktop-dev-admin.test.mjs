// What an AI may do about development plugins (desktop/lib/dev-admin.js), with the questions to the user replaced by fakes.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDevRuntime } from '../../desktop/lib/dev-runtime.js';
import { EXTENSIONS, LIMITS, checkFiles, createDevAdmin, describeWrite, diffFiles, readFolder } from '../../desktop/lib/dev-admin.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MANIFEST = (dev = { page: 'page.js' }, extra = {}) => JSON.stringify({ name: 'Mi plugin', version: '0.1', tdt: { api: 0, dev }, ...extra });

function world({ mode = true, writeAnswer = true, approveAnswer = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tdt-admin-'));
  const dir = join(root, 'dev-plugins');
  mkdirSync(dir);
  const calls = { asks: [], approvals: [], activated: [], logs: [], changes: [] };
  const answers = { write: writeAnswer, approve: approveAnswer };
  const runtime = createDevRuntime({
    dir, stateFile: join(root, 'dev.json'), env: mode ? { TDT_DEV: '1' } : {}, packaged: false, delay: 60,
    confirm: async (warning) => { calls.approvals.push(warning); return answers.approve; },
    log: (level, text, source) => calls.logs.push([source, level, text]),
    importPlugin: async () => ({ default: (api) => { calls.activated.push(api.id); } }),
    api: (plugin) => ({ id: plugin.id }),
    onChange: (change) => calls.changes.push(change),
  });
  runtime.init();
  const lines = [];
  let busy = null;
  const admin = createDevAdmin({
    dir, runtime, logLines: () => lines,
    confirmWrite: async (ask) => { calls.asks.push(ask); if (busy) await busy; return answers.write; },
    log: (level, text, source) => calls.logs.push([source, level, text]),
  });
  const plugin = (id, files) => {
    mkdirSync(join(dir, id), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, id, name, '..'), { recursive: true });
      writeFileSync(join(dir, id, name), text);
    }
  };
  return {
    root, dir, calls, runtime, admin, lines, plugin, answers,
    holdQuestion: () => { let release; busy = new Promise((r) => { release = r; }); return () => { busy = null; release(); }; },
    leftovers: () => readdirSync(root).filter((n) => n.startsWith('dev-staging')),
    done: async () => { await runtime.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('with the developer mode off nothing works and nothing says how to turn it on from here', async () => {
  const w = world({ mode: false });
  try {
    for (const cmd of [{ do: 'dev_list' }, { do: 'dev_read', id: 'a' }, { do: 'dev_write', id: 'a', files: { 'manifest.json': MANIFEST() } },
      { do: 'dev_logs', id: 'a' }, { do: 'dev_activate', id: 'a' }]) {
      const r = await w.admin.run(cmd);
      assert.equal(r.ok, false, cmd.do);
      assert.match(r.detail, /solo el usuario puede encenderlo/);
    }
    assert.equal(w.calls.asks.length + w.calls.approvals.length, 0);
    assert.deepEqual(readdirSync(w.dir), []);
  } finally {
    await w.done();
  }
});

test('anything that is not a command, or has a bad id, is refused', async () => {
  const w = world();
  try {
    for (const cmd of [null, 5, 'x', {}, { do: 'format' }, { do: 'dev_read' }, { do: 'dev_read', id: '..' }, { do: 'dev_read', id: 'a/b' },
      { do: 'dev_read', id: '.x' }, { do: 'dev_logs', id: 5 }, { do: 'dev_write', id: 'a', files: [] }, { do: 'dev_write', id: 'a' }]) {
      assert.equal((await w.admin.run(cmd)).ok, false, JSON.stringify(cmd));
    }
  } finally {
    await w.done();
  }
});

test('checkFiles has the same rules as the server', () => {
  assert.equal(checkFiles({ 'a.js': 'x', 'sub/b.json': '{}', 'c.md': null }), null);
  const bad = [{}, Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}.js`, 'x'])), { '../a.js': 'x' }, { '/a.js': 'x' },
    { 'a\\b.js': 'x' }, { '.a.js': 'x' }, { 'a/../b.js': 'x' }, { 'a/b/c/d.js': 'x' }, { 'a.exe': 'x' }, { a: 'x' }, { 'a.js': 5 },
    { 'a.js': 'x'.repeat(LIMITS.file + 1) }, { 'a.js': 'x'.repeat(60_000), 'b.js': 'x'.repeat(60_000), 'c.js': 'x'.repeat(60_000), 'd.js': 'x'.repeat(60_000), 'e.js': 'x'.repeat(60_000) }];
  for (const files of bad) assert.notEqual(checkFiles(files), null, JSON.stringify(files).slice(0, 80));
  assert.ok(EXTENSIONS.includes('.mjs'));
});

test('list shows the plugins with their state, and finds a folder that was just created', async () => {
  const w = world();
  try {
    w.plugin('uno', { 'manifest.json': MANIFEST(), 'page.js': 'tdt.log(1)' });
    let r = await w.admin.run({ do: 'dev_list' });
    assert.deepEqual(r.data.plugins.map((p) => [p.id, p.active, p.running, p.scopes]), [['uno', false, false, ['page']]]);
    w.plugin('dos', { 'manifest.json': MANIFEST({ main: 'main.js' }), 'main.js': 'export default () => {}' });
    r = await w.admin.run({ do: 'dev_list' });
    assert.deepEqual(r.data.plugins.map((p) => p.id), ['dos', 'uno']);
    assert.ok(!JSON.stringify(r).includes(w.root), 'no path of the machine in what goes out');
  } finally {
    await w.done();
  }
});

test('read gives the text files of a plugin and leaves out what is hidden, linked, big or of another kind', async () => {
  const w = world();
  try {
    w.plugin('uno', { 'manifest.json': MANIFEST(), 'page.js': 'a', 'sub/ayuda.md': 'b', '.oculto.js': 'c', 'binario.exe': 'd', 'grande.js': 'x'.repeat(LIMITS.file + 1) });
    let linked = true;
    try {
      writeFileSync(join(w.root, 'secreto.js'), 'SECRETO');
      symlinkSync(join(w.root, 'secreto.js'), join(w.dir, 'uno', 'enlace.js'));
    } catch {
      linked = false;
    }
    const r = await w.admin.run({ do: 'dev_read', id: 'uno' });
    assert.deepEqual(Object.keys(r.data.files).sort(), ['manifest.json', 'page.js', 'sub/ayuda.md']);
    if (linked) assert.ok(!JSON.stringify(r).includes('SECRETO'));
    assert.equal((await w.admin.run({ do: 'dev_read', id: 'nada' })).ok, false);
    assert.deepEqual(readFolder(join(w.dir, 'uno')), r.data.files);
  } finally {
    await w.done();
  }
});

test('dry_run checks without writing and without asking the user', async () => {
  const w = world();
  try {
    const r = await w.admin.run({ do: 'dev_write', id: 'nuevo', dry_run: true, files: { 'manifest.json': MANIFEST(), 'page.js': 'tdt.log(1);' } });
    assert.deepEqual([r.ok, r.data.valid, r.data.scopes], [true, true, ['page']]);
    assert.match(r.detail, /no se ha escrito nada/);
    assert.equal(existsSync(join(w.dir, 'nuevo')), false);
    assert.equal(w.calls.asks.length, 0);
    assert.deepEqual(w.leftovers(), []);
  } finally {
    await w.done();
  }
});

test('what is wrong comes back to the AI, with the line, and the user is never bothered', async () => {
  const w = world();
  try {
    const cases = [
      [{ 'manifest.json': MANIFEST(), 'page.js': 'const a = 1;\nesto no es js (' }, /error de sintaxis \(línea 2\)/],
      [{ 'manifest.json': MANIFEST(), 'page.js': 'const x = ;' }, /error de sintaxis \(línea 1\)/],
      [{ 'manifest.json': '{ roto' }, /manifest\.json no se puede leer/],
      [{ 'manifest.json': MANIFEST({ page: 'no-esta.js' }) }, /no existe o está fuera/],
      [{ 'manifest.json': JSON.stringify({ name: 'x', tdt: { api: 1, dev: { page: 'page.js' } } }), 'page.js': '1' }, /tdt\.api/],
      [{ 'page.js': '1' }, /manifest/],
    ];
    for (const [files, pattern] of cases) {
      const r = await w.admin.run({ do: 'dev_write', id: 'malo', files });
      assert.equal(r.ok, false);
      assert.match(r.detail, pattern);
      assert.ok(Array.isArray(r.data.problems) && r.data.problems.length);
    }
    assert.equal(w.calls.asks.length, 0);
    assert.equal(existsSync(join(w.dir, 'malo')), false);
    assert.deepEqual(w.leftovers(), []);
  } finally {
    await w.done();
  }
});

test('a write that passes is shown to the user with the code, and only their yes puts it in the folder', async () => {
  const w = world();
  try {
    const files = { 'manifest.json': MANIFEST({ page: 'page.js', main: 'main.js' }), 'page.js': 'tdt.log("hola");', 'main.js': 'export default () => {};' };
    w.answers.write = false;
    let r = await w.admin.run({ do: 'dev_write', id: 'nuevo', files });
    assert.deepEqual([r.ok, r.detail], [false, 'el usuario rechazó los cambios']);
    assert.equal(existsSync(join(w.dir, 'nuevo')), false);
    const ask = w.calls.asks[0];
    assert.match(ask.message, /escribir el plugin de desarrollo «Mi plugin»/);
    assert.match(ask.detail, /No correrá hasta que lo actives tú/);
    assert.match(ask.detail, /página de TDT local/);
    assert.match(ask.detail, /proceso principal/);
    assert.match(ask.detail, /tdt\.log\("hola"\)/, 'the code is in the question');
    assert.ok(existsSync(ask.stageDir) === false, 'the folder to look at is gone once it is answered');

    w.answers.write = true;
    r = await w.admin.run({ do: 'dev_write', id: 'nuevo', files });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.written.sort(), ['main.js', 'manifest.json', 'page.js']);
    assert.equal(r.data.active, false);
    assert.match(r.data.next, /tdt_dev_activate/);
    assert.equal(readFileSync(join(w.dir, 'nuevo', 'page.js'), 'utf8'), 'tdt.log("hola");');
    assert.deepEqual(w.leftovers(), []);
    assert.ok(w.calls.logs.some(([source, level, text]) => source === 'dev' && level === 'WARN' && /aceptados por el usuario/.test(text)));
    assert.deepEqual((await w.admin.run({ do: 'dev_list' })).data.plugins.map((p) => p.id), ['nuevo']);
  } finally {
    await w.done();
  }
});

test('the user can look at the whole result first: the question carries the folder where it is', async () => {
  const w = world();
  try {
    let seen = null;
    const admin = createDevAdmin({
      dir: w.dir, runtime: w.runtime, logLines: () => [], log: () => {},
      confirmWrite: async (ask) => { seen = { dir: ask.stageDir, files: readdirSync(ask.stageDir).sort(), page: readFileSync(join(ask.stageDir, 'page.js'), 'utf8') }; return false; },
    });
    await admin.run({ do: 'dev_write', id: 'p', files: { 'manifest.json': MANIFEST(), 'page.js': 'tdt.log("entero");' } });
    assert.deepEqual(seen.files, ['manifest.json', 'page.js']);
    assert.equal(seen.page, 'tdt.log("entero");');
    assert.equal(existsSync(seen.dir), false);
  } finally {
    await w.done();
  }
});

test('changing a plugin keeps what is not mentioned, deletes with null, and says nothing changed if nothing did', async () => {
  const w = world();
  try {
    w.plugin('p', { 'manifest.json': MANIFEST(), 'page.js': 'viejo', 'extra.js': 'queda' });
    let r = await w.admin.run({ do: 'dev_write', id: 'p', files: { 'page.js': 'viejo' } });
    assert.deepEqual([r.ok, r.detail, w.calls.asks.length], [true, 'sin cambios', 0]);
    r = await w.admin.run({ do: 'dev_write', id: 'p', files: { 'page.js': 'nuevo', 'extra.js': null } });
    assert.equal(r.ok, true);
    assert.deepEqual([r.data.written, r.data.removed], [['page.js'], ['extra.js']]);
    assert.equal(readFileSync(join(w.dir, 'p', 'page.js'), 'utf8'), 'nuevo');
    assert.equal(existsSync(join(w.dir, 'p', 'extra.js')), false);
    assert.equal(existsSync(join(w.dir, 'p', 'manifest.json')), true);
    const asked = w.calls.asks[0];
    assert.match(asked.detail, /page\.js: cambiado/);
    assert.match(asked.detail, /extra\.js: borrado/);
    r = await w.admin.run({ do: 'dev_write', id: 'p', files: { 'manifest.json': null } });
    assert.equal(r.ok, false, 'deleting the manifest leaves something that is not a plugin');
    assert.equal(existsSync(join(w.dir, 'p', 'manifest.json')), true);
    r = await w.admin.run({ do: 'dev_write', id: 'p', files: { 'page.js': null, 'manifest.json': null, 'extra.js': null } });
    assert.equal(r.ok, false);
  } finally {
    await w.done();
  }
});

test('one question at a time: a second write while the user is deciding is refused', async () => {
  const w = world();
  try {
    const release = w.holdQuestion();
    const files = { 'manifest.json': MANIFEST(), 'page.js': 'tdt.log(1);' };
    const first = w.admin.run({ do: 'dev_write', id: 'a', files });
    await sleep(50);
    const second = await w.admin.run({ do: 'dev_write', id: 'b', files });
    assert.equal(second.ok, false);
    assert.match(second.detail, /ya hay una pregunta/);
    const activation = await w.admin.run({ do: 'dev_activate', id: 'a' });
    assert.equal(activation.ok, false);
    release();
    assert.equal((await first).ok, true);
    assert.equal((await w.admin.run({ do: 'dev_write', id: 'b', files })).ok, true);
  } finally {
    await w.done();
  }
});

test('a write to an active plugin reloads it, and says so', async () => {
  const w = world();
  try {
    w.plugin('p', { 'manifest.json': MANIFEST({ main: 'main.js' }), 'main.js': 'export default () => {};' });
    await w.runtime.refresh();
    await w.runtime.approve('p', true);
    await sleep(100);
    assert.deepEqual(w.calls.activated, ['p']);
    const r = await w.admin.run({ do: 'dev_write', id: 'p', files: { 'main.js': 'export default () => { /* v2 */ };' } });
    assert.equal(r.data.active, true);
    assert.match(w.calls.asks[0].detail, /ESTÁ ACTIVADO/);
    await sleep(500);
    assert.deepEqual(w.calls.activated, ['p', 'p'], 'the new code runs as soon as it is accepted');
  } finally {
    await w.done();
  }
});

test('logs: only the lines of that plugin, the last ones, bounded', async () => {
  const w = world();
  try {
    for (let i = 0; i < 300; i++) w.lines.push(`2026-11-01 10:00:00 INFO  [dev:a] línea ${i}`);
    w.lines.push('2026-11-01 10:00:01 ERROR [dev:b] de otro', '2026-11-01 10:00:02 INFO  [servidor] ajeno', '2026-11-01 10:00:03 INFO  [dev:ab] casi');
    let r = await w.admin.run({ do: 'dev_logs', id: 'a', limit: 3 });
    assert.deepEqual(r.data.lines.map((l) => l.split('] ')[1]), ['línea 297', 'línea 298', 'línea 299']);
    r = await w.admin.run({ do: 'dev_logs', id: 'a' });
    assert.equal(r.data.lines.length, 50);
    r = await w.admin.run({ do: 'dev_logs', id: 'a', limit: 99999 });
    assert.equal(r.data.lines.length, LIMITS.logs);
    r = await w.admin.run({ do: 'dev_logs', id: 'b' });
    assert.deepEqual(r.data.lines, ['2026-11-01 10:00:01 ERROR [dev:b] de otro']);
    assert.deepEqual((await w.admin.run({ do: 'dev_logs', id: 'nada' })).data.lines, []);
  } finally {
    await w.done();
  }
});

test('activate asks the user with the code, and only their yes makes it run', async () => {
  const w = world();
  try {
    w.plugin('p', { 'manifest.json': MANIFEST({ main: 'main.js' }), 'main.js': 'export default () => { /* mi código */ };' });
    w.answers.approve = false;
    let r = await w.admin.run({ do: 'dev_activate', id: 'p' });
    assert.deepEqual([r.ok, r.detail], [false, 'el usuario no lo ha activado']);
    assert.match(w.calls.approvals[0].detail, /mi código/, 'the question shows the code');
    assert.deepEqual(w.calls.activated, []);
    w.answers.approve = true;
    r = await w.admin.run({ do: 'dev_activate', id: 'p' });
    assert.deepEqual([r.ok, r.data.active, r.data.running], [true, true, true]);
    r = await w.admin.run({ do: 'dev_activate', id: 'p' });
    assert.match(r.detail, /ya estaba activado/);
    assert.equal(w.calls.approvals.length, 2, 'an active one is not asked about again');
  } finally {
    await w.done();
  }
});

test('activate refuses what does not exist or has problems, without asking', async () => {
  const w = world();
  try {
    assert.equal((await w.admin.run({ do: 'dev_activate', id: 'nada' })).ok, false);
    w.plugin('roto', { 'manifest.json': MANIFEST(), 'page.js': 'esto no es js (' });
    const r = await w.admin.run({ do: 'dev_activate', id: 'roto' });
    assert.equal(r.ok, false);
    assert.match(r.detail, /sintaxis/);
    assert.equal(w.calls.approvals.length, 0);
  } finally {
    await w.done();
  }
});

test('the question about a write lists the changes and cuts long code with a way to see it all', () => {
  const finals = { 'manifest.json': '{}', 'page.js': 'x'.repeat(5000), 'viejo.js': undefined };
  const changes = diffFiles({ 'manifest.json': '{ }', 'viejo.js': 'a', 'igual.js': 'z' }, { ...finals, 'igual.js': 'z' });
  assert.deepEqual(changes.map((c) => [c.name, c.status]), [['igual.js', 'igual'], ['manifest.json', 'cambiado'], ['page.js', 'nuevo'], ['viejo.js', 'borrado']]);
  const ask = describeWrite({ name: 'N', scopes: ['main'], changes, finals: { ...finals, 'igual.js': 'z' }, active: false });
  assert.match(ask.detail, /manifest\.json: cambiado/);
  assert.match(ask.detail, /viejo\.js: borrado/);
  assert.ok(!/igual\.js:/.test(ask.detail.split('El código nuevo')[0].replace('Cambios:', '')), 'what did not change is not listed');
  assert.match(ask.detail, /… \(\d+ caracteres más: «Ver los archivos»/);
  assert.match(ask.detail, /proceso principal/);
  assert.ok(ask.detail.length < 6000, 'the question stays readable');
});
