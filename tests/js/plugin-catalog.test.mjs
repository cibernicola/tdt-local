// Installing from a link or a catalog (desktop/lib/plugin-catalog.js): which links are fetched, how a download is limited, and what a catalog may say.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, checkLink, cleanSha, download, readCatalog, sha256Of, withInstalled } from '../../desktop/lib/plugin-catalog.js';
import { describeCatalogEntry } from '../../tdtlocal/static/js/lib/plugins-panel.js';

const SHA = 'a'.repeat(64);
const entry = (extra = {}) => ({ id: 'tiempo', name: 'El tiempo', author: 'Ana', version: '1.2.0', description: 'Cuenta el tiempo', url: 'https://plugins.example.org/tiempo.tdtplugin', sha256: SHA, permissions: ['network:api.example.org'], ...extra });
const body = (...chunks) => ({ async *[Symbol.asyncIterator]() { for (const c of chunks) yield Buffer.from(c); }, destroy() { this.destroyed = true; } });
const response = (status, chunks = [], headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (n) => headers[String(n).toLowerCase()] ?? null }, body: body(...chunks) });

test('only an https link to a public name is fetched', () => {
  assert.equal(checkLink('https://plugins.example.org/a.tdtplugin').ok, true);
  assert.equal(checkLink('  https://plugins.example.org/a.tdtplugin ').ok, true, 'spaces around are ignored');
  for (const bad of ['http://plugins.example.org/a', 'ftp://x.example.org/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://10.0.0.5/a', 'https://localhost/a', 'https://nas.local/a', 'https://printer.lan/a', 'https://plugins.example.org:8443/a', 'https://user:pass@plugins.example.org/a', 'https://a.example.org/' + 'x'.repeat(700), 'no es una dirección', '', null, 5, 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.equal(checkLink(bad).ok, false, String(bad).slice(0, 50));
  }
  assert.match(checkLink('http://x.example.org/a').reason, /https/);
});

test('a SHA-256 is 64 hex digits, whatever the case, spaces and colons', () => {
  assert.equal(cleanSha('AA'.repeat(32)), 'a'.repeat(64));
  assert.equal(cleanSha('aa:'.repeat(31) + 'aa'), 'a'.repeat(64));
  assert.equal(cleanSha('aa aa '.repeat(8) + 'aa'.repeat(16)), 'a'.repeat(64));
  for (const bad of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), null, undefined]) assert.equal(cleanSha(bad), null, String(bad).slice(0, 20));
  assert.equal(sha256Of(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('a download follows a few redirects, checks each one and is limited in size', async () => {
  const publicHost = async () => ['93.184.216.34'];
  const ok = await download('https://a.example.org/x', { resolve: publicHost, fetchImpl: async () => response(200, ['ho', 'la']) });
  assert.equal(ok.buffer.toString(), 'hola');
  assert.equal(ok.url, 'https://a.example.org/x');
  const hops = [];
  const moved = await download('https://a.example.org/x', { resolve: publicHost, fetchImpl: async (u) => { hops.push(u.href); return hops.length < 3 ? response(302, [], { location: '/y' + hops.length }) : response(200, ['fin']); } });
  assert.equal(moved.buffer.toString(), 'fin');
  assert.deepEqual(hops, ['https://a.example.org/x', 'https://a.example.org/y1', 'https://a.example.org/y2']);
  await assert.rejects(() => download('https://a.example.org/x', { resolve: publicHost, fetchImpl: async () => response(302, [], { location: '/otra' }) }), /demasiadas redirecciones/);
  await assert.rejects(() => download('https://a.example.org/x', { resolve: publicHost, fetchImpl: async () => response(302, [], { location: 'http://a.example.org/x' }) }), /https/);
  await assert.rejects(() => download('https://a.example.org/x', { resolve: publicHost, fetchImpl: async () => response(302, [], { location: 'https://127.0.0.1/x' }) }), /nombre público/);
  await assert.rejects(() => download('https://a.example.org/x', { resolve: async () => ['10.0.0.9'], fetchImpl: async () => response(200, ['x']) }), /no es una dirección pública/);
  await assert.rejects(() => download('https://a.example.org/x', { resolve: async () => { throw new Error('nx'); }, fetchImpl: async () => response(200) }), /no se encuentra/);
  await assert.rejects(() => download('https://a.example.org/x', { resolve: publicHost, fetchImpl: async () => response(404) }), /contestó 404/);
  const big = response(200, ['x'.repeat(600), 'y'.repeat(600)]);
  await assert.rejects(() => download('https://a.example.org/x', { maxBytes: 1000, resolve: publicHost, fetchImpl: async () => big }), /pesa más de/);
  assert.equal(big.body.destroyed, true, 'the connection is dropped when it is too big');
  await assert.rejects(() => download('https://a.example.org/x', { maxBytes: 500, resolve: publicHost, fetchImpl: async () => response(200, ['x'.repeat(600)]) }), /pesa más de 0,5 KB|pesa más de 0\.5 KB/);
  await assert.rejects(() => download('https://a.example.org/x', { maxBytes: 3 * 1024 * 1024, resolve: publicHost, fetchImpl: async () => response(200, ['x'.repeat(3 * 1024 * 1024 + 1)]) }), /pesa más de 3 MB/);
  const reset = Object.assign(new Error(''), { code: 'ECONNRESET' });
  await assert.rejects(() => download('https://a.example.org/x', { resolve: publicHost, fetchImpl: async () => { throw reset; } }), /no se pudo conectar con a\.example\.org \(ECONNRESET\)/);
  await assert.rejects(() => download('https://a.example.org/x', { resolve: publicHost, fetchImpl: async () => { throw Object.assign(new Error(''), { name: 'AggregateError', errors: [{ code: 'ETIMEDOUT' }] }); } }), /\(ETIMEDOUT\)/);
  assert.ok(LIMITS.packageBytes >= 1024 * 1024 && LIMITS.catalogBytes <= LIMITS.packageBytes);
});

test('a catalog is cleaned, every file is pinned with its SHA-256, and what is wrong is said', () => {
  const { entries, problems } = readCatalog({ plugins: [entry(), entry({ id: 'otro', name: 'Otro' })] });
  assert.deepEqual(entries.map((e) => e.id), ['tiempo', 'otro']);
  assert.deepEqual(problems, []);
  assert.equal(entries[0].sha256, SHA);
  const bad = readCatalog({ plugins: [
    entry({ id: 'MAL' }), entry({ id: 'a', name: '' }), entry({ id: 'b', url: 'http://x.example.org/a' }), entry({ id: 'c', url: 'https://127.0.0.1/a' }),
    entry({ id: 'd', sha256: undefined }), entry({ id: 'e', sha256: 'abc' }), 'texto', null, entry({ id: 'ok' }), entry({ id: 'ok' }),
  ] });
  assert.deepEqual(bad.entries.map((e) => e.id), ['ok'], 'only the good one, once');
  assert.equal(bad.problems.length, 9);
  assert.match(bad.problems.join(' | '), /falta «sha256»/);
  assert.match(bad.problems.join(' | '), /«ok» está repetido/);
  for (const wrong of [null, 5, 'x', {}, { plugins: 'x' }]) assert.match(readCatalog(wrong).problems[0], /\{"plugins"/);
  assert.deepEqual(readCatalog({ plugins: [] }), { entries: [], problems: [] }, 'an empty catalog is a catalog');
  const long = readCatalog({ plugins: Array.from({ length: LIMITS.entries + 5 }, (_, i) => entry({ id: 'p' + i })) });
  assert.equal(long.entries.length, LIMITS.entries);
  assert.match(long.problems[0], /solo se leen los primeros/);
  const odd = readCatalog({ plugins: [entry({ name: 'N\u0000ame', description: 'x'.repeat(500), permissions: ['network:a.com', 5, 'x'.repeat(200)] })] }).entries[0];
  assert.equal(odd.name, 'N ame', 'control characters are not kept');
  assert.equal(odd.description.length, 200);
  assert.deepEqual(odd.permissions.map((p) => p.length), [13, 80], 'what is not text is dropped and the rest is cut');
});

test('the catalog says what is new, what is installed and what has another version', () => {
  const states = withInstalled([entry({ id: 'a' }), entry({ id: 'b', version: '2.0.0' }), entry({ id: 'c' })], [{ id: 'a', version: '1.2.0' }, { id: 'b', version: '1.0.0' }]);
  assert.deepEqual(states.map((s) => [s.id, s.state, s.installedVersion]), [['a', 'installed', '1.2.0'], ['b', 'update', '1.0.0'], ['c', 'new', '']]);
});

test('an entry of the catalog reads as a sentence and its button says what it does', () => {
  const fresh = describeCatalogEntry({ ...entry(), state: 'new' });
  assert.equal(fresh.button, 'Instalar');
  assert.equal(fresh.enabled, true);
  assert.match(fresh.line, /de Ana · versión 1\.2\.0 — Cuenta el tiempo — Dice que pedirá: network:api\.example\.org \(se comprueba al descargarlo\)/);
  assert.equal(describeCatalogEntry({ ...entry(), state: 'installed' }).enabled, false);
  assert.match(describeCatalogEntry({ ...entry(), state: 'update', installedVersion: '1.0.0' }).button, /Actualizar \(tienes la 1\.0\.0\)/);
  assert.match(describeCatalogEntry({ ...entry({ permissions: [] }), state: 'new' }).line, /no pide permisos/);
});
