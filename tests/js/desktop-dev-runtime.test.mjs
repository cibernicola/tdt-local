// The running side of the development plugins (desktop/lib/dev-runtime.js), with the parts that need Electron replaced.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDevState } from '../../desktop/lib/dev.js';
import { MODE_WARNING, approvalWarning, createDevRuntime, dataDirOf } from '../../desktop/lib/dev-runtime.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup({ answer = true, env = {}, packaged = false, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tdt-devrt-'));
  const dir = join(root, 'dev-plugins');
  const make = (name, tdt, extra = {}) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'manifest.json'), JSON.stringify({ name: 'P ' + name, version: '1', tdt }));
    writeFileSync(join(dir, name, 'page.js'), 'window.X = 1;');
    writeFileSync(join(dir, name, 'main.js'), 'export default () => {};');
    for (const [file, text] of Object.entries({ ...files, ...extra })) writeFileSync(join(dir, name, file), text);
  };
  const calls = { confirm: [], logs: [], changes: [], activated: [], deactivated: [], imported: [] };
  let nextAnswer = answer;
  const modules = new Map(); // folder name of the plugin -> the module (or the error) the fake import gives
  const runtime = createDevRuntime({
    dir,
    stateFile: join(root, 'dev.json'),
    env,
    packaged,
    delay: 60,
    confirm: async (warning) => { calls.confirm.push(warning); return nextAnswer; },
    log: (level, text, source) => calls.logs.push([source, level, text]),
    importPlugin: async (file) => {
      calls.imported.push(file);
      const id = file.split(/[\\/]/).slice(-2)[0]; // the folder of the plugin: paths differ between systems
      const mod = modules.get(id);
      if (mod instanceof Error) throw mod;
      return mod || { default: (api) => { calls.activated.push(api.id); }, deactivate: () => { calls.deactivated.push('x'); } };
    },
    api: (plugin) => ({ id: plugin.id, dataDir: dataDirOf(dir, plugin.id) }),
    onChange: (change) => calls.changes.push(change),
  });
  return { root, dir, make, calls, runtime, modules, answer: (v) => { nextAnswer = v; }, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('nothing is loaded, shown or asked while the mode is off', () => {
  const t = setup();
  try {
    t.make('a', { api: 0, dev: { page: 'page.js' } });
    t.runtime.init();
    assert.equal(t.runtime.mode(), false);
    assert.deepEqual(t.runtime.view().plugins, []);
    assert.deepEqual(t.runtime.pageScripts(), []);
    assert.equal(t.runtime.count(), 0);
    assert.equal(t.calls.confirm.length, 0);
  } finally {
    t.done();
  }
});

test('turning the mode on asks first, with the plain warning; a no leaves it off and writes nothing', async () => {
  const t = setup({ answer: false });
  try {
    t.make('a', { api: 0, dev: { page: 'page.js' } });
    t.runtime.init();
    const view = await t.runtime.setMode(true);
    assert.equal(view.mode, false);
    assert.equal(t.calls.confirm.length, 1);
    assert.equal(t.calls.confirm[0], MODE_WARNING);
    assert.match(MODE_WARNING.detail, /SIN aislamiento/);
    assert.equal(existsSync(join(t.root, 'dev.json')), false);
    assert.equal(t.calls.changes.length, 0);
  } finally {
    t.done();
  }
});

test('a yes turns it on, saves it, lists the plugins (all still off) and tells the app to reload the page', async () => {
  const t = setup();
  try {
    t.make('a', { api: 0, dev: { page: 'page.js' } });
    t.runtime.init();
    const view = await t.runtime.setMode(true);
    assert.equal(view.mode, true);
    assert.deepEqual(view.plugins.map((p) => [p.id, p.approved, p.running]), [['a', false, false]]);
    assert.equal(readDevState(join(t.root, 'dev.json')).mode, true);
    assert.deepEqual(t.calls.changes, [{ reloadPage: true }]);
    assert.equal(t.runtime.count(), 0);
    assert.deepEqual(t.runtime.pageScripts(), []); // listed is not approved
  } finally {
    t.done();
  }
});

test('approving asks with what the plugin may do; only then does its page code go out and its main code run', async () => {
  const t = setup();
  try {
    t.make('a', { api: 0, dev: { page: 'page.js', main: 'main.js' } });
    t.runtime.init();
    await t.runtime.setMode(true);
    t.answer(false);
    await t.runtime.approve('a', true);
    assert.equal(t.runtime.count(), 0);
    assert.deepEqual(t.calls.activated, []);
    t.answer(true);
    const view = await t.runtime.approve('a', true);
    const ask = t.calls.confirm.at(-1);
    assert.match(ask.message, /«P a»/);
    assert.match(ask.detail, /página de TDT local/);
    assert.match(ask.detail, /proceso principal/);
    assert.deepEqual(approvalWarning({ name: 'N', scopes: ['page'] }).detail.includes('proceso principal'), false);
    assert.equal(view.plugins[0].approved, true);
    assert.equal(view.plugins[0].running, true);
    assert.deepEqual(t.calls.activated, ['a']);
    assert.equal(t.runtime.count(), 1);
    assert.deepEqual(t.runtime.pageScripts().map((s) => s.id), ['a']);
    assert.equal(readDevState(join(t.root, 'dev.json')).approved.a, 'a|main,page');
    await t.runtime.stop();
  } finally {
    t.done();
  }
});

test('a plugin of the main process that fails is reported and does not stop the others', async () => {
  const t = setup();
  try {
    t.make('bad', { api: 0, dev: { main: 'main.js' } });
    t.make('good', { api: 0, dev: { main: 'main.js' } });
    t.modules.set('bad', new Error('boom'));
    t.runtime.init();
    await t.runtime.setMode(true);
    await t.runtime.approve('bad', true);
    await t.runtime.approve('good', true);
    const plugins = Object.fromEntries(t.runtime.view().plugins.map((p) => [p.id, p]));
    assert.equal(plugins.bad.running, false);
    assert.equal(plugins.bad.error, 'boom');
    assert.equal(plugins.good.running, true);
    assert.deepEqual(t.calls.activated, ['good']);
    assert.ok(t.calls.logs.some(([source, level]) => source === 'dev:bad' && level === 'ERROR'));
    await t.runtime.stop();
  } finally {
    t.done();
  }
});

test('a main script that exports no function is an error the user can read', async () => {
  const t = setup();
  try {
    t.make('x', { api: 0, dev: { main: 'main.js' } });
    t.modules.set('x', { default: 5 });
    t.runtime.init();
    await t.runtime.setMode(true);
    const plugin = (await t.runtime.approve('x', true)).plugins[0];
    assert.equal(plugin.running, false);
    assert.match(plugin.error, /exportar una función/);
    await t.runtime.stop(); // closes the folder watcher: an open one keeps the test process alive
  } finally {
    t.done();
  }
});

test('hot reload: a change in the folder restarts the main script and asks to reload the page', async () => {
  const t = setup();
  try {
    t.make('h', { api: 0, dev: { page: 'page.js', main: 'main.js' } });
    t.runtime.init();
    await t.runtime.setMode(true);
    await t.runtime.approve('h', true);
    await sleep(120);
    t.calls.changes.length = 0;
    writeFileSync(join(t.dir, 'h', 'page.js'), 'window.X = 2;');
    await sleep(500);
    assert.deepEqual(t.calls.deactivated, ['x']);
    assert.deepEqual(t.calls.activated, ['h', 'h']);
    assert.deepEqual(t.calls.changes, [{ reloadPage: true }]);
    assert.equal(t.runtime.pageScripts()[0].code, 'window.X = 2;');
    await t.runtime.stop();
  } finally {
    t.done();
  }
});

test('if a change makes the plugin declare more, it stops until the user approves it again', async () => {
  const t = setup();
  try {
    t.make('g', { api: 0, dev: { page: 'page.js' } });
    t.runtime.init();
    await t.runtime.setMode(true);
    await t.runtime.approve('g', true);
    await sleep(120);
    writeFileSync(join(t.dir, 'g', 'manifest.json'), JSON.stringify({ name: 'P g', version: '2', tdt: { api: 0, dev: { page: 'page.js', main: 'main.js' } } }));
    await sleep(500);
    const plugin = t.runtime.view().plugins[0];
    assert.equal(plugin.approved, false);
    assert.equal(plugin.needsReapproval, true);
    assert.equal(plugin.running, false);
    assert.deepEqual(t.runtime.pageScripts(), []);
    assert.ok(t.calls.logs.some(([, level, text]) => level === 'WARN' && /otros alcances/.test(text)));
    await t.runtime.stop();
  } finally {
    t.done();
  }
});

test('deactivating stops it, forgets the approval and stops watching', async () => {
  const t = setup();
  try {
    t.make('d', { api: 0, dev: { main: 'main.js' } });
    t.runtime.init();
    await t.runtime.setMode(true);
    await t.runtime.approve('d', true);
    await t.runtime.approve('d', false);
    assert.deepEqual(t.calls.deactivated, ['x']);
    assert.deepEqual(readDevState(join(t.root, 'dev.json')).approved, {});
    t.calls.activated.length = 0;
    writeFileSync(join(t.dir, 'd', 'main.js'), 'export default () => {}; // changed');
    await sleep(300);
    assert.deepEqual(t.calls.activated, []);
  } finally {
    t.done();
  }
});

test('turning the mode off stops everything and a restart finds it off', async () => {
  const t = setup();
  try {
    t.make('o', { api: 0, dev: { main: 'main.js' } });
    t.runtime.init();
    await t.runtime.setMode(true);
    await t.runtime.approve('o', true);
    const view = await t.runtime.setMode(false);
    assert.equal(view.mode, false);
    assert.deepEqual(view.plugins, []);
    assert.deepEqual(t.calls.deactivated, ['x']);
    assert.equal(readDevState(join(t.root, 'dev.json')).mode, false);
  } finally {
    t.done();
  }
});

test('TDT_DEV=1 turns the mode on without asking and the page cannot turn it off; plugins still need approval', async () => {
  const t = setup({ env: { TDT_DEV: '1' } });
  try {
    t.make('f', { api: 0, dev: { page: 'page.js' } });
    t.runtime.init();
    assert.equal(t.runtime.mode(), true);
    assert.equal(t.runtime.view().forced, true);
    assert.equal(t.calls.confirm.length, 0);
    assert.equal(t.runtime.count(), 0);
    assert.equal((await t.runtime.setMode(false)).mode, true);
  } finally {
    t.done();
  }
});

test('TDT_DEV_APPROVE=all approves without asking in development, and is ignored in an installed app', () => {
  const dev = setup({ env: { TDT_DEV: '1', TDT_DEV_APPROVE: 'all' } });
  const installed = setup({ env: { TDT_DEV: '1', TDT_DEV_APPROVE: 'all' }, packaged: true });
  try {
    for (const t of [dev, installed]) {
      t.make('z', { api: 0, dev: { page: 'page.js' } });
      t.runtime.init();
    }
    assert.equal(dev.runtime.count(), 1);
    assert.equal(installed.runtime.count(), 0);
    assert.deepEqual(installed.runtime.pageScripts(), []);
  } finally {
    dev.done();
    installed.done();
  }
});

test('a plugin with problems cannot be approved, and approving something unknown does nothing', async () => {
  const t = setup();
  try {
    t.make('p', { api: 1, dev: { page: 'page.js' } });
    t.runtime.init();
    await t.runtime.setMode(true);
    const before = t.calls.confirm.length;
    await t.runtime.approve('p', true);
    await t.runtime.approve('nope', true);
    assert.equal(t.calls.confirm.length, before); // it did not even ask
    assert.equal(t.runtime.count(), 0);
  } finally {
    t.done();
  }
});

test('approving does nothing while the mode is off', async () => {
  const t = setup();
  try {
    t.make('q', { api: 0, dev: { page: 'page.js' } });
    t.runtime.init();
    await t.runtime.approve('q', true);
    assert.equal(t.calls.confirm.length, 0);
    assert.equal(existsSync(join(t.root, 'dev.json')), false);
  } finally {
    t.done();
  }
});

test('refresh finds new folders and starts what is approved, without restarting what already runs', async () => {
  const t = setup({ env: { TDT_DEV: '1', TDT_DEV_APPROVE: 'all' } });
  try {
    t.make('a', { api: 0, dev: { main: 'main.js' } });
    t.runtime.init();
    await t.runtime.start();
    assert.deepEqual(t.calls.activated, ['a']);
    t.make('b', { api: 0, dev: { main: 'main.js' } });
    assert.deepEqual(t.runtime.view().plugins.map((p) => p.id), ['a']); // not seen until it looks again
    const view = await t.runtime.refresh();
    assert.deepEqual(view.plugins.map((p) => [p.id, p.running]), [['a', true], ['b', true]]);
    assert.deepEqual(t.calls.activated, ['a', 'b'], 'a was left alone and b was started');
    await t.runtime.refresh();
    assert.deepEqual(t.calls.activated, ['a', 'b'], 'asking again starts nothing twice');
    await t.runtime.stop();
  } finally {
    t.done();
  }
});
