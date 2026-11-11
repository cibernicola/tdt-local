// The development plugins of the desktop app (desktop/lib/dev.js). It does not need Electron.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  discoverDev, isApproved, needsReapproval, pageScripts, readDevPlugin, readDevState, signature, watchFolder, writeDevState,
} from '../../desktop/lib/dev.js';
import { readPlugin } from '../../desktop/lib/plugins.js';

function temp() {
  const root = mkdtempSync(join(tmpdir(), 'tdt-dev-'));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function plugin(root, name, tdt, files = { 'page.js': 'window.A = 1;', 'main.js': 'export default () => {};' }, extra = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'Prueba ' + name, version: '0.1', ...extra, tdt }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

test('a development plugin declares its scopes and the files that run there', () => {
  const { root, done } = temp();
  try {
    const dir = plugin(root, 'uno', { api: 0, dev: { page: 'page.js', main: 'main.js' } });
    const p = readDevPlugin(dir);
    assert.deepEqual(p.problems, []);
    assert.deepEqual(p.scopes, ['page', 'main']);
    assert.ok(p.files.page.endsWith('page.js') && p.files.main.endsWith('main.js'));
    assert.equal(p.name, 'Prueba uno');
  } finally {
    done();
  }
});

test('what is wrong with one is said, and it never runs', () => {
  const { root, done } = temp();
  try {
    const cases = [
      [{ api: 0 }, /tdt\.dev/],
      [{ api: 1, dev: { page: 'page.js' } }, /tdt\.api.*0/],
      [{ api: 0, dev: {} }, /ningún alcance/],
      [{ api: 0, dev: { server: 'page.js' } }, /«server» no existe/],
      [{ api: 0, dev: { page: 'missing.js' } }, /no existe o está fuera/],
      [{ api: 0, dev: { page: '../x.js' } }, /no existe o está fuera/],
    ];
    cases.forEach(([tdt, pattern], index) => {
      const p = readDevPlugin(plugin(root, 'caso' + index, tdt));
      assert.ok(p.problems.some((m) => pattern.test(m)), `${index}: ${p.problems}`);
      assert.equal(isApproved(p, { approved: { [p.id]: signature(p) } }), false, 'with problems it does not run even if approved');
    });
    assert.ok(readDevPlugin(plugin(root, 'sin manifest', null)).problems.length);
    assert.ok(readDevPlugin(join(root, 'no-existe')).problems.length);
    assert.ok(readDevPlugin(plugin(root, 'con espacios y ñ', { api: 0, dev: { page: 'page.js' } })).problems.some((m) => /carpeta/.test(m)));
  } finally {
    done();
  }
});

test('a script cannot point outside its folder, not even through a link', () => {
  const { root, done } = temp();
  try {
    writeFileSync(join(root, 'secret.js'), 'steal()');
    const dir = plugin(root, 'link', { api: 0, dev: { page: 'page.js' } }, {});
    try {
      symlinkSync(join(root, 'secret.js'), join(dir, 'page.js'));
    } catch {
      return; // a system that does not let this user make links: nothing to check
    }
    assert.ok(readDevPlugin(dir).problems.some((m) => /fuera de la carpeta/.test(m)));
  } finally {
    done();
  }
});

test('discoverDev lists the folders with a manifest and a missing folder is no plugins', () => {
  const { root, done } = temp();
  try {
    assert.deepEqual(discoverDev(join(root, 'nope')), []);
    plugin(root, 'b', { api: 0, dev: { page: 'page.js' } });
    plugin(root, 'a', { api: 0, dev: { main: 'main.js' } });
    mkdirSync(join(root, 'vacia'));
    assert.deepEqual(discoverDev(root).map((p) => p.id), ['a', 'b']);
  } finally {
    done();
  }
});

test('the normal plugin loader refuses a development manifest', () => {
  const { root, done } = temp();
  try {
    const dir = plugin(root, 'dev', { api: 0, dev: { page: 'page.js' } }, { 'page.js': '1' }, {
      content_scripts: [{ matches: ['https://example.com/*'], js: ['page.js'] }],
    });
    const p = readPlugin(dir);
    assert.ok(p.problems.some((m) => /plugin de desarrollo/.test(m)), p.problems.join('; '));
  } finally {
    done();
  }
});

test('approval is for these scopes: changing them asks again, and a plugin with problems is never approved', () => {
  const { root, done } = temp();
  try {
    const dir = plugin(root, 'x', { api: 0, dev: { page: 'page.js' } });
    const first = readDevPlugin(dir);
    const state = { mode: true, approved: { x: signature(first) } };
    assert.equal(isApproved(first, state), true);
    assert.equal(needsReapproval(first, state), false);
    plugin(root, 'x', { api: 0, dev: { page: 'page.js', main: 'main.js' } }); // now it also asks for the main process
    const second = readDevPlugin(dir);
    assert.equal(isApproved(second, state), false);
    assert.equal(needsReapproval(second, state), true);
    assert.equal(isApproved(second, { mode: true, approved: {} }), false);
    assert.equal(needsReapproval(second, { mode: true, approved: {} }), false); // never approved: it is just off
  } finally {
    done();
  }
});

test('the state is saved, read back, and anything odd reads as off with nothing approved', () => {
  const { root, done } = temp();
  try {
    const file = join(root, 'sub', 'dev.json');
    assert.deepEqual(readDevState(file), { mode: false, approved: {} });
    writeDevState(file, { mode: true, approved: { a: 'a|page' } });
    assert.deepEqual(readDevState(file), { mode: true, approved: { a: 'a|page' } });
    for (const bad of ['no json', '[]', '{"mode":"yes","approved":{"a":5}}', 'null']) {
      writeFileSync(file, bad);
      const state = readDevState(file);
      assert.equal(state.mode, false, bad);
      assert.deepEqual(state.approved, {}, bad);
    }
  } finally {
    done();
  }
});

test('pageScripts gives the code of approved plugins that declare page, read at the moment of asking', () => {
  const { root, done } = temp();
  try {
    plugin(root, 'con-pagina', { api: 0, dev: { page: 'page.js' } });
    plugin(root, 'solo-main', { api: 0, dev: { main: 'main.js' } });
    plugin(root, 'sin-aprobar', { api: 0, dev: { page: 'page.js' } });
    const plugins = discoverDev(root);
    const state = { mode: true, approved: Object.fromEntries(plugins.filter((p) => p.id !== 'sin-aprobar').map((p) => [p.id, signature(p)])) };
    let scripts = pageScripts(plugins, state);
    assert.deepEqual(scripts.map((s) => s.id), ['con-pagina']);
    assert.equal(scripts[0].code, 'window.A = 1;');
    writeFileSync(join(root, 'con-pagina', 'page.js'), 'window.A = 2;'); // hot reload: the next load runs the new code
    scripts = pageScripts(plugins, state);
    assert.equal(scripts[0].code, 'window.A = 2;');
  } finally {
    done();
  }
});

test('watchFolder calls back once after a burst of changes inside the folder, and stops when closed', async () => {
  const { root, done } = temp();
  try {
    const dir = plugin(root, 'w', { api: 0, dev: { page: 'page.js' } });
    let calls = 0;
    const watcher = watchFolder(dir, () => { calls += 1; }, { delay: 80 });
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 4; i++) writeFileSync(join(dir, 'page.js'), 'window.A = ' + i + ';');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(calls, 1);
    watcher.close();
    writeFileSync(join(dir, 'page.js'), 'window.A = 99;');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls, 1);
  } finally {
    done();
  }
});

test('a page script with a syntax error says which line, and one with await at the top is fine (it runs inside an async function)', () => {
  const { root, done } = temp();
  try {
    const tdt = { api: 0, dev: { page: 'page.js' } };
    let p = readDevPlugin(plugin(root, 'roto', tdt, { 'page.js': 'const a = 1;\nesto no es javascript (' }));
    assert.match(p.problems.join(' '), /error de sintaxis \(línea 2\)/);
    assert.deepEqual(p.scopes, []); // it does not run
    p = readDevPlugin(plugin(root, 'espera', tdt, { 'page.js': 'const x = await Promise.resolve(1);' }));
    assert.deepEqual(p.problems, []);
    assert.deepEqual(p.scopes, ['page']);
    p = readDevPlugin(plugin(root, 'bien', tdt, { 'page.js': 'tdt.log(1); (async () => { await 1; })();' }));
    assert.deepEqual(p.problems, []);
  } finally {
    done();
  }
});

test('the example plugin of the documentation is a valid development plugin', () => {
  const dir = new URL('../../docs/ejemplos/plugin-desarrollo-hola', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const p = readDevPlugin(dir);
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.scopes, ['page', 'main']);
});
