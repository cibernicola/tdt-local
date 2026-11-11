// The address and the policy of the plugins of api 1 (desktop/lib/plugin-protocol.js). It does not need Electron.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { POLICY, SDK_PATH, parseAddress, servePlugin } from '../../desktop/lib/plugin-protocol.js';
import { insideOf, readPlugin } from '../../desktop/lib/plugins.js';

const sdkFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'desktop', 'sdk', 'tdt-sdk.js');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tdt-proto-'));
  const dir = join(root, 'ejemplo');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'E', version: '1', tdt: { api: 1 } }));
  writeFileSync(join(dir, 'index.html'), '<p>hola</p>');
  writeFileSync(join(dir, 'app.js'), '1');
  writeFileSync(join(dir, '.secreto'), 'x');
  writeFileSync(join(dir, 'raro.exe'), 'x');
  writeFileSync(join(dir, 'sub', 'a.css'), 'p{}');
  writeFileSync(join(root, 'fuera.html'), 'no');
  const plugin = readPlugin(dir);
  const ctx = { lookup: (id) => (id === 'ejemplo' ? plugin : null), sdkFile, insideOf };
  return { root, ctx, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('an address is a plugin id and a path', () => {
  assert.deepEqual(parseAddress('tdt-plugin://ejemplo/sub/a.css'), { id: 'ejemplo', path: '/sub/a.css' });
  assert.deepEqual(parseAddress('tdt-plugin://ejemplo/'), { id: 'ejemplo', path: '/' });
  assert.equal(parseAddress('https://ejemplo/'), null);
  assert.equal(parseAddress('tdt-plugin://EJ_EMPLO/'), null);
  assert.equal(parseAddress('tdt-plugin://ejemplo/%zz'), null);
  assert.equal(parseAddress('nada'), null);
});

test('it serves the page, the files and the SDK of a running plugin with the policy', () => {
  const { ctx, done } = fixture();
  try {
    const home = servePlugin('tdt-plugin://ejemplo/', ctx);
    assert.equal(home.status, 200);
    assert.equal(home.body.toString(), '<p>hola</p>');
    assert.equal(home.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(home.headers['Content-Security-Policy'], POLICY);
    assert.equal(servePlugin('tdt-plugin://ejemplo/sub/a.css', ctx).headers['Content-Type'], 'text/css; charset=utf-8');
    const sdk = servePlugin(`tdt-plugin://ejemplo${SDK_PATH}`, ctx);
    assert.equal(sdk.status, 200);
    assert.equal(sdk.body.toString(), readFileSync(sdkFile, 'utf8'));
  } finally {
    done();
  }
});

test('it serves nothing else: not another plugin, not outside the folder, not hidden files, not odd types', () => {
  const { ctx, done } = fixture();
  try {
    const status = (url) => servePlugin(url, ctx).status;
    assert.equal(status('tdt-plugin://otro/'), 404);
    assert.equal(status('tdt-plugin://ejemplo/../fuera.html'), 404);
    assert.equal(status('tdt-plugin://ejemplo/%2e%2e/fuera.html'), 404);
    assert.equal(status('tdt-plugin://ejemplo/.secreto'), 404);
    assert.equal(status('tdt-plugin://ejemplo/sub/../.secreto'), 404);
    assert.equal(status('tdt-plugin://ejemplo/raro.exe'), 415);
    assert.equal(status('tdt-plugin://ejemplo/nada.js'), 404);
    assert.equal(status('tdt-plugin://ejemplo/sub'), 404); // a folder
    assert.equal(status('https://ejemplo/'), 400);
  } finally {
    done();
  }
});

test('the policy shuts the page in: no requests, no frames, no forms; scripts and styles only its own', () => {
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'"]) {
    assert.ok(POLICY.includes(directive), directive);
  }
  assert.ok(!/https?:/.test(POLICY), 'the policy names no remote host');
  assert.match(POLICY, /img-src 'self' data: blob:/);
});

test('the SDK is a script that creates window.tdt and nothing else global', async () => {
  const code = readFileSync(sdkFile, 'utf8');
  assert.doesNotThrow(() => new Function(code));
  const sent = [];
  const listeners = {};
  const fake = {
    parent: { postMessage: (m) => sent.push(m) },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  fake.window = fake;
  new Function('window', 'console', 'setTimeout', 'clearTimeout', code)(fake, console, setTimeout, clearTimeout);
  assert.ok(fake.tdt && fake.tdt.api === 1);
  assert.deepEqual(sent[0], { tdt: 1, hello: true });
  {
    {
      listeners.message({ source: fake.parent, data: { tdt: 1, ready: true, plugin: { id: 'ejemplo', permissions: [] } } });
      const me = await fake.tdt.ready;
      assert.equal(me.id, 'ejemplo');
      const asking = fake.tdt.storage.get('k');
      const request = sent.at(-1);
      assert.equal(request.method, 'storage.get');
      listeners.message({ source: { otra: true }, data: { tdt: 1, id: request.id, ok: true, result: 'falso' } }); // not from the host
      listeners.message({ source: fake.parent, data: { tdt: 1, id: request.id, ok: true, result: 7 } });
      assert.equal(await asking, 7);
      const failing = fake.tdt.net.fetch('https://a.com/');
      listeners.message({ source: fake.parent, data: { tdt: 1, id: sent.at(-1).id, ok: false, error: 'permiso denegado: network:a.com' } });
      await assert.rejects(failing, /permiso denegado/);
      const got = [];
      fake.tdt.on('player', (s) => got.push(s));
      listeners.message({ source: fake.parent, data: { tdt: 1, event: 'player', data: { kind: 'tv' } } });
      assert.deepEqual(got, [{ kind: 'tv' }]);
    }
  }
});

test('the SDK sends at most four requests to the network at once and queues the rest', async () => {
  const code = readFileSync(sdkFile, 'utf8');
  const sent = [];
  const listeners = {};
  const fake = { parent: { postMessage: (m) => sent.push(m) }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  fake.window = fake;
  new Function('window', 'console', 'setTimeout', 'clearTimeout', code)(fake, console, setTimeout, clearTimeout);
  const answer = (id, text) => listeners.message({ source: fake.parent, data: { tdt: 1, id, ok: true, result: { ok: true, status: 200, text } } });
  const asks = Array.from({ length: 6 }, (_, i) => fake.tdt.net.fetch('https://a.com/' + i));
  const fetches = () => sent.filter((m) => m.method === 'net.fetch');
  assert.equal(fetches().length, 4, 'only four go out');
  answer(fetches()[0].id, 'uno');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fetches().length, 5, 'one answered: the next one goes out');
  answer(fetches()[1].id, 'dos');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fetches().length, 6);
  assert.deepEqual(fetches().map((m) => m.args[0].slice(-1)), ['0', '1', '2', '3', '4', '5'], 'in order');
  for (const m of fetches().slice(2)) answer(m.id, 'x');
  assert.deepEqual((await Promise.all(asks)).map((r) => r.text).slice(0, 2), ['uno', 'dos']);
});
