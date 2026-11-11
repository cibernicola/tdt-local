// Packing and installing plugins with permissions (desktop/lib/plugin-pack.js). It does not need Electron.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { discard, idFromName, inspectPackage, newPluginFiles, packFolder, place, readPackage } from '../../desktop/lib/plugin-pack.js';
import { readPlugin } from '../../desktop/lib/plugins.js';

function temp() {
  const root = mkdtempSync(join(tmpdir(), 'tdt-pack-'));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

const good = () => newPluginFiles('hola', 'Hola');

/** A zip written by hand, to test what packFolder would never write. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  for (const e of entries) {
    const data = e.data ?? Buffer.from('x');
    const size = e.size ?? data.length;
    const crc = e.crc ?? crc32(data);
    const method = e.method ?? 0;
    const n = Buffer.from(e.name);
    const common = [u16(20), u16(e.flags ?? 0), u16(method), u16(0), u16(0x21), u32(crc), u32(data.length), u32(size), u16(n.length), u16(0)];
    locals.push(Buffer.concat([u32(0x04034b50), ...common, n, data]));
    centrals.push(Buffer.concat([u32(0x02014b50), u16(0x031e), ...common, u16(0), u16(0), u16(0), u32(e.external ?? 0), u32(offset), n]));
    offset += locals.at(-1).length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
}

test('the template of a new plugin is a valid plugin that can be packed', () => {
  const { root, done } = temp();
  try {
    const dir = join(root, 'hola');
    write(dir, good());
    const p = readPlugin(dir);
    assert.deepEqual(p.problems, []);
    assert.deepEqual(p.permissions, ['player.read', 'ui.toast']);
    assert.equal(p.name, 'Hola');
    assert.doesNotThrow(() => packFolder(dir));
  } finally {
    done();
  }
});

test('a package keeps the files, installs in a folder named like the id, and is the same bytes every time', () => {
  const { root, done } = temp();
  try {
    const dir = join(root, 'hola');
    write(dir, { ...good(), 'img/logo.png': 'no-es-png', '.git/config': 'secreto', '.oculto': 'x', 'notas.tdtplugin': 'viejo' });
    const a = packFolder(dir);
    const b = packFolder(dir);
    assert.ok(a.equals(b), 'reproducible');
    const { id, files } = readPackage(a);
    assert.equal(id, 'hola');
    assert.deepEqual([...files.keys()].sort(), ['app.js', 'img/logo.png', 'index.html', 'manifest.json']);
    assert.equal(files.get('img/logo.png').toString(), 'no-es-png');
    const seen = inspectPackage(a);
    assert.deepEqual(seen.plugin.problems, []);
    assert.match(seen.sha256, /^[0-9a-f]{64}$/);
    const dest = join(root, 'instalados');
    mkdirSync(join(dest, 'hola'), { recursive: true });
    writeFileSync(join(dest, 'hola', 'viejo.txt'), 'de la versión anterior');
    place(seen, dest);
    assert.ok(existsSync(join(dest, 'hola', 'manifest.json')));
    assert.ok(!existsSync(join(dest, 'hola', 'viejo.txt')), 'replaces the old folder');
    assert.equal(readFileSync(join(dest, 'hola', 'img', 'logo.png'), 'utf8'), 'no-es-png');
    assert.ok(!existsSync(seen.stage), 'the temporary folder is gone');
  } finally {
    done();
  }
});

test('a folder that is not a valid plugin is not packed', () => {
  const { root, done } = temp();
  try {
    const bad = join(root, 'malo');
    write(bad, { 'manifest.json': JSON.stringify({ name: 'M', tdt: { api: 1, permissions: ['disco'] } }), 'index.html': '' });
    assert.throws(() => packFolder(bad), /problemas.*desconocido/);
    const script = join(root, 'viejo');
    write(script, { 'manifest.json': JSON.stringify({ name: 'V', content_scripts: [{ matches: ['https://a.com/*'], js: ['x.js'] }] }), 'x.js': '1' });
    assert.throws(() => packFolder(script), /solo se empaquetan/);
    const linked = join(root, 'enlazado');
    write(linked, good());
    let linkable = true;
    try {
      symlinkSync(join(root, 'malo'), join(linked, 'enlace'));
    } catch {
      linkable = false; // this system does not allow links
    }
    if (linkable) assert.throws(() => packFolder(linked), /enlace/);
  } finally {
    done();
  }
});

test('a package that tries to leave its folder, or is not what it says, is refused', () => {
  const manifest = Buffer.from('{}');
  const refused = (entries, pattern) => assert.throws(() => readPackage(zip(entries)), pattern);
  refused([{ name: '../fuera/manifest.json' }], /nombre no permitido/);
  refused([{ name: 'hola/../../x' }], /nombre no permitido/);
  refused([{ name: '/abs/manifest.json' }], /nombre no permitido/);
  refused([{ name: 'hola\\manifest.json' }], /nombre no permitido/);
  refused([{ name: 'C:/x/manifest.json' }], /nombre no permitido/);
  refused([{ name: 'manifest.json' }], /dentro de una carpeta/);
  refused([{ name: 'uno/manifest.json' }, { name: 'dos/manifest.json' }], /más de una carpeta/);
  refused([{ name: 'Hola_Mayus/manifest.json', data: manifest }], /nombre de plugin válido/);
  refused([{ name: 'hola/index.html' }], /no lleva manifest/);
  refused([{ name: 'hola/.oculto', data: manifest }, { name: 'hola/manifest.json', data: manifest }], /ocultos/);
  refused([{ name: 'hola/manifest.json', data: manifest, flags: 1 }], /cifrado/);
  refused([{ name: 'hola/manifest.json', data: manifest, external: (0o120777 << 16) >>> 0 }], /enlace/);
  refused([{ name: 'hola/manifest.json', data: manifest, size: 5 }], /no coincide/);
  refused([{ name: 'hola/manifest.json', data: manifest, crc: 1 }], /no coincide/);
  refused([{ name: 'hola/manifest.json', data: manifest, size: 5_000_000 }], /pesa más/);
  assert.throws(() => readPackage(Buffer.from('esto no es un zip, ni de lejos, de verdad que no')), /no es un archivo zip/);
  assert.throws(() => readPackage(Buffer.alloc(3)), /no es un paquete/);
  const many = Array.from({ length: 201 }, (_, i) => ({ name: `hola/f${i}.txt` }));
  refused(many, /201 archivos/);
});

test('a zip bomb is stopped by the declared size', () => {
  const small = deflateRawSync(Buffer.alloc(3_000_000, 0));
  const lie = zip([{ name: 'hola/manifest.json', data: small, size: 10, crc: 0, method: 8 }]); // says 10 bytes, inflates to 3 MB
  assert.throws(() => readPackage(lie));
});

test('inspecting says what a package would install and discard leaves nothing behind', () => {
  const { root, done } = temp();
  try {
    const dir = join(root, 'hola');
    write(dir, good());
    const seen = inspectPackage(packFolder(dir));
    assert.equal(seen.plugin.id, 'hola');
    assert.equal(seen.plugin.author, 'Tu nombre');
    assert.ok(existsSync(seen.stage));
    discard(seen);
    assert.ok(!existsSync(seen.stage));
  } finally {
    done();
  }
});

test('an id is made from a name and never repeats one in use', () => {
  assert.equal(idFromName('Mi plugin de fútbol'), 'mi-plugin-de-futbol');
  assert.equal(idFromName('  ¡¡Hola!!  '), 'hola');
  assert.equal(idFromName('???'), 'mi-plugin');
  assert.equal(idFromName('hola', ['hola', 'hola-2']), 'hola-3');
  assert.match(idFromName('x'.repeat(100)), /^x{30}$/);
});
