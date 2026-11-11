// Plugins with permissions (desktop/lib/plugin-api.js). It does not need Electron.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  PERMISSIONS, activationQuestion, checkFetch, codeOf, createPluginStorage, describePermission, effectivePermissions, isApproved, isPrivateAddress, needsReapproval, readDenied,
  parsePermission, pluginFetch, readApproved, signature, writeApproved,
} from '../../desktop/lib/plugin-api.js';
import { readPlugin } from '../../desktop/lib/plugins.js';

function temp() {
  const root = mkdtempSync(join(tmpdir(), 'tdt-api-'));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function make(root, id, tdt, extra = {}, files = { 'index.html': '<p>hola</p>' }) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'Prueba', version: '1.0.0', ...extra, tdt }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

test('a plugin of api 1 is read with its page, panel and permissions', () => {
  const { root, done } = temp();
  try {
    const p = readPlugin(make(root, 'tiempo', {
      api: 1, panel: { width: 9999, height: 10 }, permissions: ['player.read', 'storage', 'network:api.open-meteo.com', 'storage'],
    }, { author: 'Ana', homepage: 'https://example.com/x' }));
    assert.deepEqual(p.problems, []);
    assert.equal(p.kind, 'ui');
    assert.equal(p.entry, 'index.html');
    assert.deepEqual(p.panel, { width: 800, height: 160, placement: 'float' });
    assert.deepEqual(p.permissions, ['player.read', 'storage', 'network:api.open-meteo.com']);
    assert.equal(p.author, 'Ana');
    assert.equal(p.homepage, 'https://example.com/x');
  } finally {
    done();
  }
});

test('a plugin without panel and without permissions is valid', () => {
  const { root, done } = temp();
  try {
    const p = readPlugin(make(root, 'silencioso', { api: 1 }));
    assert.deepEqual(p.problems, []);
    assert.equal(p.panel, null);
    assert.deepEqual(p.permissions, []);
  } finally {
    done();
  }
});

test('what a manifest must not have is listed as a problem', () => {
  const { root, done } = temp();
  try {
    const bad = (id, tdt, extra, files) => readPlugin(make(root, id, tdt, extra, files)).problems.join('\n');
    assert.match(bad('a', { api: 2 }), /tdt\.api/);
    assert.match(bad('b', { api: 1, entry: '../fuera.html' }), /tdt\.entry/);
    assert.match(bad('c', { api: 1, entry: 'nada.html' }), /tdt\.entry/);
    assert.match(bad('d', { api: 1, entry: 'script.js' }, {}, { 'script.js': '' }), /tdt\.entry/);
    assert.match(bad('e', { api: 1, permissions: ['disco.total'] }), /desconocido/);
    assert.match(bad('f', { api: 1, permissions: ['network:*.com'] }), /nombre público/);
    assert.match(bad('g', { api: 1, permissions: ['network:127.0.0.1'] }), /nombre público/);
    assert.match(bad('h', { api: 1, permissions: ['network:nas.local'] }), /nombre público/);
    assert.match(bad('i', { api: 1, permissions: 'storage' }), /lista/);
    assert.match(bad('j', { api: 1, permissions: Array(13).fill('storage') }), /demasiados/);
    assert.match(bad('k', { api: 1 }, { permissions: ['tabs'] }), /tdt\.permissions/);
    assert.match(bad('l', { api: 1 }, { content_scripts: [{ matches: ['https://a.com/*'], js: ['x.js'] }] }), /de un tipo o de otro/);
    assert.match(bad('M_Mayus', { api: 1 }), /minúsculas/);
    assert.match(bad('n', { api: 1, panel: 'grande' }), /tdt\.panel/);
  } finally {
    done();
  }
});

test('a development plugin is still refused by the normal loader and a script plugin is unchanged', () => {
  const { root, done } = temp();
  try {
    const dev = readPlugin(make(root, 'dev', { api: 0, dev: { page: 'page.js' } }));
    assert.equal(dev.kind, 'script');
    assert.match(dev.problems.join(), /desarrollo/);
    const dir = make(root, 'viejo', undefined, { content_scripts: [{ matches: ['https://a.com/*'], js: ['x.js'] }] }, { 'x.js': '1' });
    const old = readPlugin(dir);
    assert.equal(old.kind, 'script');
    assert.deepEqual(old.problems, []);
  } finally {
    done();
  }
});

test('permissions are described for the user', () => {
  assert.deepEqual(parsePermission('storage'), { name: 'storage' });
  assert.equal(parsePermission('network:*.ejemplo.com').wildcard, true);
  assert.match(describePermission('network:api.ejemplo.com'), /hablar con api\.ejemplo\.com \(solo por https\)/);
  assert.match(describePermission('network:*.ejemplo.com'), /cualquier subdominio de ejemplo\.com/);
  for (const name of Object.keys(PERMISSIONS)) assert.ok(describePermission(name).length > 10);
  assert.match(describePermission('nope'), /desconocido/);
});

test('the user approves a signature: other permissions mean another question', () => {
  const base = { kind: 'ui', id: 'x', api: 1, permissions: ['player.read'], panel: null, problems: [] };
  const approved = { x: signature(base) };
  assert.equal(isApproved(base, approved), true);
  assert.equal(isApproved({ ...base, permissions: ['player.read', 'player.control'] }, approved), false);
  assert.equal(needsReapproval({ ...base, permissions: ['player.read', 'player.control'] }, approved), true);
  assert.equal(isApproved({ ...base, permissions: ['player.read'].reverse() }, approved), true);
  assert.equal(isApproved({ ...base, panel: { width: 1, height: 1 } }, approved), false);
  assert.equal(isApproved({ ...base, problems: ['x'] }, approved), false);
  assert.equal(needsReapproval(base, {}), false);
  const q = activationQuestion({ ...base, name: 'Mi plugin', author: 'Ana', version: '1.0', permissions: ['player.read', 'network:a.com'] });
  assert.match(q.message, /Mi plugin/);
  assert.match(q.detail, /De Ana/);
  assert.match(q.detail, /ver qué estás viendo/);
  assert.match(q.detail, /hablar con a\.com/);
  assert.match(activationQuestion({ ...base, name: 'N', permissions: [] }).detail, /no pide ningún permiso/);
});

test('the approved plugins are saved and read back', () => {
  const { root, done } = temp();
  try {
    const file = join(root, 'sub', 'ui.json');
    assert.deepEqual(readApproved(file), {});
    writeApproved(file, { x: 'sig', y: 'sig2' });
    assert.deepEqual(readApproved(file), { x: 'sig', y: 'sig2' });
    writeFileSync(file, '{"approved": {"x": 3, "y": "ok"}}');
    assert.deepEqual(readApproved(file), { y: 'ok' });
  } finally {
    done();
  }
});

test('private addresses are recognised', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.16.0.1', '172.31.9.9', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd00::5', '::ffff:10.0.0.1', 'no-es-ip']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700::1111']) assert.equal(isPrivateAddress(a), false, a);
});

const publicDns = async () => ['93.184.216.34'];

test('the network only reaches the hosts a permission names, by https, on public addresses', async () => {
  const perms = ['network:api.ejemplo.com', 'network:*.cdn.org'];
  assert.equal((await checkFetch(perms, 'https://api.ejemplo.com/x?y=1', publicDns)).ok, true);
  assert.equal((await checkFetch(perms, 'https://a.b.cdn.org/x', publicDns)).ok, true);
  const no = async (url, resolve = publicDns) => (await checkFetch(perms, url, resolve)).reason;
  assert.match(await no('http://api.ejemplo.com/'), /https/);
  assert.match(await no('https://api.ejemplo.com:8443/'), /443/);
  assert.match(await no('https://u:p@api.ejemplo.com/'), /usuario/);
  assert.match(await no('https://otro.com/'), /permiso denegado/);
  assert.match(await no('https://cdn.org/'), /permiso denegado/);
  assert.match(await no('https://api.ejemplo.com.malo.com/'), /permiso denegado/);
  assert.match(await no('https://x.api.ejemplo.com/'), /permiso denegado/);
  assert.match(await no('nada'), /no válida/);
  assert.match(await no('https://api.ejemplo.com/', async () => ['127.0.0.1']), /no es una dirección pública/);
  assert.match(await no('https://api.ejemplo.com/', async () => ['93.184.216.34', '10.0.0.2']), /no es una dirección pública/);
  assert.match(await no('https://api.ejemplo.com/', async () => { throw new Error('x'); }), /no se encuentra/);
});

function response(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: new Map(Object.entries(headers)), body: [Buffer.from(body)] };
}

test('a request goes through with a short list of headers and follows redirects only to allowed hosts', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).startsWith('https://api.ejemplo.com/viejo')) return response(302, '', { location: '/nuevo' });
    if (String(url).startsWith('https://api.ejemplo.com/fuga')) return response(302, '', { location: 'https://malo.com/' });
    return response(200, '{"ok":true}', { 'content-type': 'application/json' });
  };
  const perms = ['network:api.ejemplo.com'];
  const opts = { resolve: publicDns, fetchImpl };
  const ok = await pluginFetch(perms, 'https://api.ejemplo.com/viejo', { headers: { Accept: 'x', Cookie: 'no', Authorization: 'no' } }, opts);
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '{"ok":true}');
  assert.equal(ok.url, 'https://api.ejemplo.com/nuevo');
  assert.deepEqual(seen[0].init.headers, { Accept: 'x' });
  assert.equal(seen[0].init.redirect, 'manual');
  await assert.rejects(pluginFetch(perms, 'https://api.ejemplo.com/fuga', {}, opts), /permiso denegado: network:malo\.com/);
  await assert.rejects(pluginFetch(perms, 'https://api.ejemplo.com/', { method: 'DELETE' }, opts), /solo GET y POST/);
  await assert.rejects(pluginFetch(perms, 'https://api.ejemplo.com/', { method: 'GET', body: 'x' }, opts), /cuerpo no permitido/);
  const big = async () => response(200, 'x'.repeat(1_000_001));
  await assert.rejects(pluginFetch(perms, 'https://api.ejemplo.com/', {}, { resolve: publicDns, fetchImpl: big }), /1 MB/);
});

test('the storage of a plugin is its own and has limits', () => {
  const { root, done } = temp();
  try {
    const s = createPluginStorage(join(root, 'st'), { delayMs: 0 });
    assert.equal(s.get('a', 'k'), null);
    assert.equal(s.set('a', 'k', { n: 1 }), true);
    assert.deepEqual(s.get('a', 'k'), { n: 1 });
    assert.equal(s.get('b', 'k'), null);
    assert.deepEqual(s.keys('a'), ['k']);
    assert.throws(() => s.set('a', '../x', 1), /clave/);
    assert.throws(() => s.set('a', 'big', 'x'.repeat(70_000)), /pesa más/);
    assert.throws(() => s.set('a', 'u', undefined), /no se puede guardar/);
    for (let i = 0; i < 4; i++) s.set('a', 'k' + i, 'x'.repeat(60_000));
    assert.throws(() => s.set('a', 'k9', 'x'.repeat(60_000)), /256 KB/);
    assert.equal(s.remove('a', 'k0'), true);
    assert.equal(s.remove('a', 'k0'), false);
    assert.equal(s.exists('a'), true);
    assert.equal(s.exists('zzz'), false);
  } finally {
    done();
  }
});

test('the example plugins of the documentation are valid plugins with permissions', () => {
  for (const name of ['ahora', 'tiempo', 'pantalla']) {
    const dir = new URL(`../../docs/ejemplos/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const p = readPlugin(dir);
    assert.deepEqual(p.problems, [], name);
    assert.equal(p.kind, 'ui');
    assert.ok(p.panel, name);
    assert.ok(p.permissions.length > 0, name);
    assert.ok(p.author && p.description, name);
  }
});

test('a panel can take the screen of the player: it is part of what the user approves and of what they are told', () => {
  const { root, done } = temp();
  try {
    const screen = readPlugin(make(root, 'pantalla', { api: 1, panel: { placement: 'screen' }, permissions: ['player.read'] }));
    assert.deepEqual(screen.problems, []);
    assert.equal(screen.panel.placement, 'screen');
    const float = readPlugin(make(root, 'flota', { api: 1, panel: { placement: 'float' }, permissions: ['player.read'] }));
    assert.equal(float.panel.placement, 'float');
    assert.match(readPlugin(make(root, 'rara', { api: 1, panel: { placement: 'fondo' } })).problems.join(), /placement/);
    // the same plugin as a floating panel and as a screen is not the same thing to approve
    const as = (placement) => ({ ...screen, panel: { ...screen.panel, placement } });
    assert.notEqual(signature(as('screen')), signature(as('float')));
    assert.equal(isApproved(as('screen'), { pantalla: signature(as('float')) }), false);
    assert.equal(needsReapproval(as('screen'), { pantalla: signature(as('float')) }), true);
    assert.match(activationQuestion({ ...as('screen'), name: 'P', permissions: [] }).detail, /sobre la pantalla del reproductor.*tapar la imagen/);
    assert.match(activationQuestion({ ...as('float'), name: 'P', permissions: [] }).detail, /panel propio/);
  } finally {
    done();
  }
});

test('the storage keeps what it reads in memory and writes a moment later; flush writes at once', () => {
  const { root, done } = temp();
  try {
    const dir = join(root, 'st');
    const a = createPluginStorage(dir, { delayMs: 60_000 });
    a.set('x', 'k', { n: 1 });
    a.set('x', 'k2', [1, 2]);
    assert.deepEqual(a.get('x', 'k'), { n: 1 });
    assert.equal(createPluginStorage(dir).get('x', 'k'), null, 'nothing on the disk yet');
    assert.equal(a.exists('x'), true, 'but it exists for the one who wrote it');
    a.flush();
    const b = createPluginStorage(dir);
    assert.deepEqual(b.get('x', 'k'), { n: 1 });
    assert.deepEqual(b.keys('x'), ['k', 'k2']);
    assert.deepEqual(a.usage('x'), { bytes: JSON.stringify({ k: { n: 1 }, k2: [1, 2] }).length, keys: 2 });
    const value = { inner: 1 };
    a.set('x', 'copy', value);
    value.inner = 2;
    assert.deepEqual(a.get('x', 'copy'), { inner: 1 }, 'what is kept is a copy');
    assert.equal(a.remove('x', 'k'), true);
    a.flush();
    assert.deepEqual(createPluginStorage(dir).keys('x'), ['copy', 'k2']);
    assert.doesNotThrow(() => a.flush(), 'flushing with nothing pending is harmless');
  } finally {
    done();
  }
});

test('the errors of the storage and the network carry a code a plugin can tell apart', async () => {
  const { root, done } = temp();
  try {
    const s = createPluginStorage(join(root, 'st'), { delayMs: 0 });
    const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
    assert.equal(code(() => s.set('a', '../x', 1)), 'E_INVALID');
    assert.equal(code(() => s.set('a', 'k', undefined)), 'E_INVALID');
    assert.equal(code(() => s.set('a', 'k', 'x'.repeat(70_000))), 'E_QUOTA');
    const perms = ['network:api.ejemplo.com'];
    const opts = { resolve: async () => ['93.184.216.34'], fetchImpl: async () => ({ status: 200, ok: true, headers: new Map(), body: [Buffer.from('x')] }) };
    const why = async (url, init = {}) => { try { await pluginFetch(perms, url, init, opts); } catch (e) { return e.code; } return null; };
    assert.equal(await why('https://otro.com/'), 'E_PERMISSION');
    assert.equal(await why('http://api.ejemplo.com/'), 'E_INVALID');
    assert.equal(await why('https://api.ejemplo.com/', { method: 'DELETE' }), 'E_INVALID');
    assert.equal(await why('https://api.ejemplo.com/', { method: 'POST', body: 'x'.repeat(200_000) }), 'E_INVALID');
    const loop = { ...opts, resolve: async () => ['10.0.0.1'] };
    await assert.rejects(pluginFetch(perms, 'https://api.ejemplo.com/', {}, loop), (e) => e.code === 'E_UNAVAILABLE');
    assert.equal(codeOf('permiso denegado: x'), 'E_PERMISSION');
    assert.equal(codeOf('demasiadas peticiones a la vez'), 'E_RATE');
    assert.equal(codeOf('cualquier otra cosa'), 'E_UNAVAILABLE');
  } finally {
    done();
  }
});

test('the permissions a user turns off are remembered and taken away from what a plugin may do', () => {
  const { root, done } = temp();
  try {
    const file = join(root, 'ui.json');
    writeApproved(file, { x: 'sig' }, { x: ['network:a.com'], y: [] });
    assert.deepEqual(readApproved(file), { x: 'sig' });
    assert.deepEqual(readDenied(file), { x: ['network:a.com'] }, 'an empty list is not kept');
    writeApproved(file, { x: 'sig', y: 'sig2' }); // saving the approvals does not forget what was turned off
    assert.deepEqual(readDenied(file), { x: ['network:a.com'] });
    const plugin = { id: 'x', permissions: ['storage', 'network:a.com', 'network:b.com'] };
    assert.deepEqual(effectivePermissions(plugin, readDenied(file)), ['storage', 'network:b.com']);
    assert.deepEqual(effectivePermissions({ id: 'z', permissions: ['storage'] }, readDenied(file)), ['storage']);
    assert.deepEqual(readDenied(join(root, 'no-existe.json')), {});
  } finally {
    done();
  }
});
