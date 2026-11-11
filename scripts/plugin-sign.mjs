#!/usr/bin/env node
// The author's tool for signing plugins (ed25519). Nothing here talks to the network.
//
//   node scripts/plugin-sign.mjs keygen mi-clave.json          creates a pair of keys (the private one stays in that file: keep it safe, never publish it)
//   node scripts/plugin-sign.mjs sign mi-plugin-1.0.0.tdtplugin mi-clave.json     writes mi-plugin-1.0.0.tdtplugin.sig next to the file
//   node scripts/plugin-sign.mjs verify mi-plugin-1.0.0.tdtplugin [archivo.sig]    checks a signature (by default the .sig next to it)
//
// Publish the `.sig` next to the `.tdtplugin` (same address plus «.sig»: TDT local looks for it by itself), or put its content in the `signature` of your entry of
// the catalog. Publish the fingerprint of your key somewhere people can compare it.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fingerprintOf, generateKeys, sha256Hex, signPackage, verifyPackage } from '../desktop/lib/plugin-sign.js';

const [command, first, second] = process.argv.slice(2);
const fail = (text) => { console.error(text); process.exit(1); };

if (command === 'keygen') {
  if (!first) fail('uso: keygen <archivo-de-clave.json>');
  if (existsSync(first)) fail(`${first} ya existe: no se sobrescribe una clave`);
  const keys = generateKeys();
  writeFileSync(first, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(first, 0o600); } catch { /* Windows: the folder of the user is private */ }
  console.log(`Clave creada en ${first}. GUÁRDALA y no la publiques: quien la tenga puede firmar como tú.`);
  console.log(`Huella (publícala para que se pueda comparar): ${keys.fingerprint}`);
} else if (command === 'sign') {
  if (!first || !second) fail('uso: sign <paquete.tdtplugin> <archivo-de-clave.json>');
  const keys = JSON.parse(readFileSync(second, 'utf8'));
  const buffer = readFileSync(first);
  const signature = signPackage(buffer, keys);
  writeFileSync(`${first}.sig`, JSON.stringify(signature) + '\n');
  console.log(`Firmado: ${first}.sig`);
  console.log(`SHA-256 del archivo: ${sha256Hex(buffer)}`);
  console.log(`Huella de la clave:  ${fingerprintOf(keys.publicKey)}`);
} else if (command === 'verify') {
  if (!first) fail('uso: verify <paquete.tdtplugin> [archivo.sig]');
  const signatureFile = second || `${first}.sig`;
  if (!existsSync(signatureFile)) fail(`no hay ${signatureFile}`);
  const checked = verifyPackage(readFileSync(first), readFileSync(signatureFile, 'utf8'));
  if (!checked.ok) fail(`FIRMA NO VÁLIDA: ${checked.reason}`);
  console.log(`Firma válida. Huella de la clave: ${checked.fingerprint}`);
} else {
  fail('uso: node scripts/plugin-sign.mjs keygen|sign|verify …  (mira la cabecera del archivo)');
}
