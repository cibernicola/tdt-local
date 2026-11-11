// Author signatures for plugins (ed25519). The author signs the SHA-256 of the `.tdtplugin` file with a private key only they have; whoever installs it can tell
// that the file is the author's and has not been changed, and, from the second plugin or update on, that it comes from the **same** key as before.
//
// There is no authority that vouches for a key: the first time a key is seen it is shown by its fingerprint and the user decides (trust on first use). What the app
// remembers is, for each plugin, the key it was installed with; an update signed with another key, or not signed at all, is shown as a warning.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SIGNATURE_VERSION = 1;
const CONTEXT = 'tdtplugin-v1\n'; // what is signed is this and the SHA-256, so a signature made for something else cannot be reused here
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** The fingerprint of a public key (the base64 of its SPKI DER): 32 hex digits in groups of four, which is what a person compares. */
export function fingerprintOf(publicKeyB64) {
  const hex = createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 32);
  return hex.match(/.{4}/g).join(' ');
}

/** A new pair of keys for an author: ``{publicKey (base64 SPKI DER), privateKey (PKCS8 PEM), fingerprint}``. The private one never leaves the author. */
export function generateKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { publicKey: spki, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fingerprint: fingerprintOf(spki) };
}

/** Sign a package: the object that goes in a `.sig` file (or in a catalog entry). */
export function signPackage(buffer, { publicKey, privateKey }) {
  const hash = sha256Hex(buffer);
  const signature = sign(null, Buffer.from(CONTEXT + hash), createPrivateKey(privateKey)).toString('base64');
  return { v: SIGNATURE_VERSION, alg: 'ed25519', key: publicKey, sig: signature, sha256: hash };
}

/** A signature as a `.sig` file or a catalog gives it (text or object), cleaned, or ``null`` if it is not one. */
export function parseSignature(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || value.v !== SIGNATURE_VERSION || value.alg !== 'ed25519') return null;
  if (typeof value.key !== 'string' || typeof value.sig !== 'string' || !B64.test(value.key) || !B64.test(value.sig) || value.key.length > 100 || value.sig.length > 100) return null;
  return { v: SIGNATURE_VERSION, alg: 'ed25519', key: value.key, sig: value.sig };
}

/**
 * Does this signature belong to this file? ``{ok: true, fingerprint}`` or ``{ok: false, reason}``. A signature made with another file, or changed by a single
 * bit, or with a key that is not a key, does not verify.
 */
export function verifyPackage(buffer, rawSignature) {
  const parsed = parseSignature(rawSignature);
  if (!parsed) return { ok: false, reason: 'la firma no tiene el formato esperado' };
  try {
    const key = createPublicKey({ key: Buffer.from(parsed.key, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'la clave no es ed25519' };
    const good = verify(null, Buffer.from(CONTEXT + sha256Hex(buffer)), key, Buffer.from(parsed.sig, 'base64'));
    return good ? { ok: true, fingerprint: fingerprintOf(parsed.key) } : { ok: false, reason: 'la firma no corresponde a este archivo: lo han cambiado o no es de esa clave' };
  } catch {
    return { ok: false, reason: 'la firma o la clave no son válidas' };
  }
}

/**
 * What to tell the user about the signature of a package that is about to be installed, given the key each plugin was installed with.
 * ``state``: ``signed-known`` (same key as the installed one), ``signed-new`` (a key seen for the first time for this plugin), ``signed-changed`` (another key than the
 * one this plugin had), ``unsigned`` (no signature, and the plugin was not signed before), ``unsigned-was-signed`` (no signature, and it used to have one) and
 * ``invalid`` (a signature that does not verify: the install is refused).
 * @param {string} id the plugin
 * @param {Buffer} buffer the file
 * @param {unknown} rawSignature what came with it, or nothing
 * @param {Record<string, {fingerprint: string, author: string}>} keys what is remembered
 */
export function judge(id, buffer, rawSignature, keys) {
  const had = keys && Object.hasOwn(keys, id) ? keys[id] : null;
  if (rawSignature === undefined || rawSignature === null || rawSignature === '') {
    return had ? { state: 'unsigned-was-signed', fingerprint: '', previous: had.fingerprint } : { state: 'unsigned', fingerprint: '' };
  }
  const checked = verifyPackage(buffer, rawSignature);
  if (!checked.ok) return { state: 'invalid', fingerprint: '', reason: checked.reason };
  if (!had) return { state: 'signed-new', fingerprint: checked.fingerprint };
  return had.fingerprint === checked.fingerprint
    ? { state: 'signed-known', fingerprint: checked.fingerprint }
    : { state: 'signed-changed', fingerprint: checked.fingerprint, previous: had.fingerprint };
}

/** The sentence about the signature for the question to the user. */
export function describeJudgement(j) {
  switch (j.state) {
    case 'signed-known': return `Firmado con la clave ${j.fingerprint}: la misma de la versión que ya tienes.`;
    case 'signed-new': return `Firmado con la clave ${j.fingerprint}. Es la primera vez que ves esta clave para este plugin: si conoces a su autor, compara esta huella con la que publica.`;
    case 'signed-changed': return `⚠ LA CLAVE HA CAMBIADO. Este archivo está firmado con ${j.fingerprint} y la versión que tienes se instaló con ${j.previous}. Puede ser el mismo autor con una clave nueva, o alguien distinto: no lo instales si no esperabas el cambio.`;
    case 'unsigned-was-signed': return `⚠ SIN FIRMA. La versión que tienes venía firmada con ${j.previous} y este archivo no lleva firma. No lo instales si no esperabas el cambio.`;
    case 'invalid': return `⚠ La firma NO es válida (${j.reason}).`;
    default: return 'Sin firma de autor: lo único que lo respalda es quién te lo pasa y el SHA-256.';
  }
}

/** Is this a verdict that deserves a warning dialog rather than a plain question? */
export const isWarning = (j) => ['signed-changed', 'unsigned-was-signed', 'invalid'].includes(j.state);

/** The keys the plugins were installed with, in a file of the data folder: ``{plugin id: {fingerprint, author, since}}``. */
export function createKeyStore(file) {
  let data = null;
  const load = () => {
    if (data) return data;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      data = {};
    }
    return data;
  };
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(data), 'utf8');
    renameSync(file + '.tmp', file);
  };
  return {
    all: () => ({ ...load() }),
    /** Remember (or replace) the key this plugin was installed with. */
    remember(id, fingerprint, author = '') {
      load()[id] = { fingerprint, author: String(author).slice(0, 60), since: new Date().toISOString().slice(0, 10) };
      save();
    },
    /** The plugin was installed without a signature: whatever key it had is not its key any more (the warning was shown and the user accepted). */
    forget(id) {
      if (load()[id] === undefined) return;
      delete data[id];
      save();
    },
  };
}
