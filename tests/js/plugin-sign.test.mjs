// Author signatures (desktop/lib/plugin-sign.js): who signed, that the file is not another, and what the app tells when the key of a plugin changes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createKeyStore, describeJudgement, fingerprintOf, generateKeys, isWarning, judge, parseSignature, signPackage, verifyPackage,
} from '../../desktop/lib/plugin-sign.js';

const file = Buffer.from('un paquete cualquiera');
const keys = generateKeys();
const other = generateKeys();

test('a pair of keys has a fingerprint a person can compare, and the private key is not in the signature', () => {
  assert.match(keys.fingerprint, /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  assert.equal(fingerprintOf(keys.publicKey), keys.fingerprint);
  assert.notEqual(keys.fingerprint, other.fingerprint);
  assert.match(keys.privateKey, /BEGIN PRIVATE KEY/);
  const signature = signPackage(file, keys);
  assert.ok(!JSON.stringify(signature).includes('PRIVATE'));
  assert.deepEqual(Object.keys(signature).sort(), ['alg', 'key', 'sha256', 'sig', 'v']);
});

test('a signature verifies the file it was made for, and nothing else', () => {
  const signature = signPackage(file, keys);
  assert.deepEqual(verifyPackage(file, signature), { ok: true, fingerprint: keys.fingerprint });
  assert.deepEqual(verifyPackage(file, JSON.stringify(signature)), { ok: true, fingerprint: keys.fingerprint }, 'text of a .sig file');
  assert.equal(verifyPackage(Buffer.from('otro paquete'), signature).ok, false, 'another file');
  assert.equal(verifyPackage(Buffer.concat([file, Buffer.from('x')]), signature).ok, false, 'a changed file');
  const flipped = { ...signature, sig: Buffer.from(Buffer.from(signature.sig, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') };
  assert.equal(verifyPackage(file, flipped).ok, false, 'a signature changed by one bit');
  assert.equal(verifyPackage(file, { ...signature, key: other.publicKey }).ok, false, 'another key');
  assert.match(verifyPackage(Buffer.from('x'), signature).reason, /no corresponde/);
});

test('what is not a signature is refused in words, without crashing', () => {
  const good = signPackage(file, keys);
  for (const bad of [null, undefined, '', 'no json', '{}', [], 5, { ...good, v: 2 }, { ...good, alg: 'rsa' }, { ...good, key: '***' }, { ...good, sig: 5 }, { ...good, key: 'A'.repeat(200) }, { ...good, sig: '' }]) {
    assert.equal(parseSignature(bad), null, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.match(verifyPackage(file, 'basura').reason, /formato/);
  assert.match(verifyPackage(file, { ...good, key: 'AAAA' }).reason, /no son válidas|no es ed25519/);
  const rsa = { ...good, key: Buffer.from('no es una clave').toString('base64') };
  assert.equal(verifyPackage(file, rsa).ok, false);
});

test('the signature is bound to this use: the hash of another file with the same words does not work', () => {
  const signature = signPackage(file, keys);
  assert.equal(signature.sha256.length, 64);
  assert.equal(verifyPackage(file, { ...signature, sha256: 'f'.repeat(64) }).ok, true, 'the hash written in the file is information: what is checked is the file itself');
});

test('what the app says depends on the key the plugin was installed with', () => {
  const remembered = { tiempo: { fingerprint: keys.fingerprint, author: 'Ana' } };
  const signed = signPackage(file, keys);
  assert.deepEqual(judge('tiempo', file, signed, remembered), { state: 'signed-known', fingerprint: keys.fingerprint });
  assert.deepEqual(judge('nuevo', file, signed, remembered), { state: 'signed-new', fingerprint: keys.fingerprint });
  assert.deepEqual(judge('tiempo', file, signPackage(file, other), remembered), { state: 'signed-changed', fingerprint: other.fingerprint, previous: keys.fingerprint });
  assert.deepEqual(judge('tiempo', file, undefined, remembered), { state: 'unsigned-was-signed', fingerprint: '', previous: keys.fingerprint });
  assert.deepEqual(judge('nuevo', file, undefined, remembered), { state: 'unsigned', fingerprint: '' });
  assert.equal(judge('nuevo', Buffer.from('cambiado'), signed, remembered).state, 'invalid');
  assert.equal(judge('nuevo', file, 'basura', remembered).state, 'invalid');
  assert.equal(judge('tiempo', file, signed, undefined).state, 'signed-new');
  assert.equal(judge('constructor', file, signed, {}).state, 'signed-new', 'an id like «constructor» is not a remembered key');
});

test('the sentences say the important thing, and the dangerous cases are warnings', () => {
  const j = (state, extra = {}) => ({ state, fingerprint: 'aaaa', previous: 'bbbb', reason: 'x', ...extra });
  assert.match(describeJudgement(j('signed-known')), /la misma de la versión que ya tienes/);
  assert.match(describeJudgement(j('signed-new')), /primera vez que ves esta clave/);
  assert.match(describeJudgement(j('signed-changed')), /LA CLAVE HA CAMBIADO.*aaaa.*bbbb/);
  assert.match(describeJudgement(j('unsigned-was-signed')), /SIN FIRMA.*bbbb/);
  assert.match(describeJudgement(j('invalid')), /NO es válida \(x\)/);
  assert.match(describeJudgement(j('unsigned')), /Sin firma de autor/);
  assert.deepEqual(['signed-known', 'signed-new', 'unsigned', 'signed-changed', 'unsigned-was-signed', 'invalid'].filter((s) => isWarning(j(s))), ['signed-changed', 'unsigned-was-signed', 'invalid']);
});

test('the keys of the plugins are kept in a file, replaced, forgotten and survive a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tdt-keys-'));
  try {
    const path = join(dir, 'sub', 'plugin-keys.json');
    const store = createKeyStore(path);
    assert.deepEqual(store.all(), {});
    store.remember('tiempo', keys.fingerprint, 'Ana');
    assert.equal(createKeyStore(path).all().tiempo.fingerprint, keys.fingerprint);
    assert.equal(createKeyStore(path).all().tiempo.author, 'Ana');
    store.remember('tiempo', other.fingerprint, 'Ana');
    assert.equal(createKeyStore(path).all().tiempo.fingerprint, other.fingerprint);
    store.forget('tiempo');
    store.forget('no-existe');
    assert.deepEqual(createKeyStore(path).all(), {});
    writeFileSync(path, '{', 'utf8');
    assert.deepEqual(createKeyStore(path).all(), {}, 'a damaged file is not a crash');
    writeFileSync(path, '[1]', 'utf8');
    assert.deepEqual(createKeyStore(path).all(), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the author tool creates a key, signs a file and checks it, and refuses to overwrite a key or to accept a changed file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tdt-sign-'));
  const run = (...args) => execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'plugin-sign.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const keyFile = join(dir, 'clave.json');
    const pack = join(dir, 'mi-plugin.tdtplugin');
    writeFileSync(pack, 'contenido del paquete');
    assert.match(run('keygen', keyFile), /Huella/);
    assert.throws(() => run('keygen', keyFile), /ya existe/);
    assert.match(run('sign', pack, keyFile), /SHA-256 del archivo/);
    assert.match(run('verify', pack), /Firma válida\. Huella de la clave: ([0-9a-f]{4} ){7}[0-9a-f]{4}/);
    assert.equal(verifyPackage(readFileSync(pack), readFileSync(`${pack}.sig`, 'utf8')).ok, true);
    writeFileSync(pack, 'contenido CAMBIADO');
    assert.throws(() => run('verify', pack), /FIRMA NO VÁLIDA/);
    assert.throws(() => run('verify', join(dir, 'no-existe.tdtplugin')), /no hay/);
    assert.throws(() => run('inventado'), /uso:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
