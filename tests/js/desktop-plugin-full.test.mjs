// Plugins with all the power that anyone can install (desktop/lib/plugin-full.js): how one is read, how the approval is tied to its code, and what the page is handed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  POWER_TEXT, THEME_TEXT, activationQuestion, codePreview, counted, fingerprint, handOver, inlineAssets, isApproved, isTheme, needsReapproval, signature,
} from '../../desktop/lib/plugin-full.js';
import { discover, insideOf, readPlugin } from '../../desktop/lib/plugins.js';
import { inspectPackage, packFolder, discard } from '../../desktop/lib/plugin-pack.js';

/** What is handed to the page, with the tools main.js gives. */
const pageScripts = (list, on, ok, read, warn) => handOver(list, on, ok, { read, insideOf, warn });

function temp() {
  const root = mkdtempSync(join(tmpdir(), 'tdt-full-'));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}
const manifest = (extra = {}, tdt = {}) => JSON.stringify({ name: 'Cartel', version: '1.0.0', author: 'Ana', tdt: { api: 1, full: { page: 'page.js' }, ...tdt }, ...extra });
function plugin(root, id, files = {}, m = manifest()) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const all = { 'manifest.json': m, 'page.js': 'tdt.log(1);', ...files };
  for (const [name, text] of Object.entries(all)) {
    if (text === null) continue;
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test('a folder with «tdt.full» is read as a plugin with all the power: its page, no permissions, and a fingerprint of its code', () => {
  const { root, done } = temp();
  try {
    const p = readPlugin(plugin(root, 'cartel'));
    assert.deepEqual(p.problems, []);
    assert.equal(p.kind, 'full');
    assert.deepEqual([p.scopes, p.permissions, p.author, p.name, p.version], [['page'], [], 'Ana', 'Cartel', '1.0.0']);
    assert.match(p.hash, /^[0-9a-f]{64}$/);
    assert.equal(signature(p), `cartel|full|page|${p.hash}`);
    assert.equal(discover([root]).map((x) => [x.id, x.kind]).join(), 'cartel,full');
  } finally {
    done();
  }
});

test('what is wrong with one is said in words, and it never runs', () => {
  const { root, done } = temp();
  try {
    const problems = (id, files, m) => readPlugin(plugin(root, id, files, m)).problems.join(' | ');
    assert.match(problems('api', {}, manifest({}, { api: 2 })), /«tdt\.api» tiene que ser 1/);
    assert.match(problems('mixto', {}, manifest({}, { dev: { page: 'page.js' } })), /de desarrollo .* o con todo el poder/);
    assert.match(problems('permisos', {}, manifest({}, { permissions: ['player.read'] })), /«tdt\.permissions» no se usa/);
    assert.match(problems('main', {}, manifest({}, { full: { main: 'main.js' } })), /«main» todavía no está disponible/);
    assert.match(problems('server', {}, manifest({}, { full: { server: 'server.py' } })), /«server» todavía no está disponible/);
    assert.match(problems('raro', {}, manifest({}, { full: { page: 'page.js', otro: 'x.js' } })), /«otro» no existe/);
    assert.match(problems('vacio', {}, manifest({}, { full: {} })), /no declara ningún alcance/);
    assert.match(problems('objeto', {}, manifest({}, { full: 'page.js' })), /«tdt\.full» tiene que ser un objeto/);
    assert.match(problems('falta', { 'page.js': null }, manifest()), /no existe o está fuera/);
    assert.match(problems('fuera', {}, manifest({}, { full: { page: '../x.js' } })), /no existe o está fuera/);
    assert.match(problems('roto', { 'page.js': 'esto no es js (' }), /error de sintaxis \(línea 1\)/);
    assert.equal(problems('espera', { 'page.js': 'const x = await Promise.resolve(1); return () => x;' }), '', 'await at the top and a function returned are fine');
    assert.match(problems('Mayus', {}, manifest()), /minúsculas, números y guiones/, 'the id is the name of the folder');
  } finally {
    done();
  }
});

test('the fingerprint is of the code: any file, any letter, and the same folder gives the same one wherever it is', () => {
  const a = temp();
  const b = temp();
  try {
    const one = plugin(a.root, 'cartel', { 'extra/dato.txt': 'uno' });
    const two = plugin(b.root, 'otro-sitio', { 'extra/dato.txt': 'uno' });
    assert.equal(fingerprint(one), fingerprint(two));
    writeFileSync(join(one, 'extra', 'dato.txt'), 'dos');
    assert.notEqual(fingerprint(one), fingerprint(two), 'another file of the folder counts');
    writeFileSync(join(two, 'page.js'), 'tdt.log(2);');
    assert.notEqual(fingerprint(two), fingerprint(plugin(a.root, 'tercero')), 'one letter of the page counts');
    writeFileSync(join(one, '.oculto'), 'no cuenta');
    assert.equal(fingerprint(one), fingerprint(one));
  } finally {
    a.done();
    b.done();
  }
});

test('a link inside the folder is refused: a plugin cannot carry one', (t) => {
  const { root, done } = temp();
  try {
    const dir = plugin(root, 'enlace');
    try {
      symlinkSync(join(root, 'fuera.txt'), join(dir, 'atajo.txt'));
    } catch {
      t.skip('this system does not allow links here');
      return;
    }
    assert.match(readPlugin(dir).problems.join(' '), /es un enlace/);
  } finally {
    done();
  }
});

test('the approval is of the code: it holds while nothing changes, and one letter asks again', () => {
  const { root, done } = temp();
  try {
    const dir = plugin(root, 'cartel');
    let p = readPlugin(dir);
    const approved = {};
    assert.equal(isApproved(p, approved), false);
    assert.equal(needsReapproval(p, approved), false, 'never approved: nothing to renew');
    approved.cartel = signature(p);
    assert.equal(isApproved(p, approved), true);
    writeFileSync(join(dir, 'page.js'), 'tdt.log(1); // y un cambio');
    p = readPlugin(dir);
    assert.equal(isApproved(p, approved), false);
    assert.equal(needsReapproval(p, approved), true);
    assert.equal(isApproved({ ...p, kind: 'ui' }, { cartel: signature(p) }), false, 'only a plugin of this kind');
    writeFileSync(join(dir, 'page.js'), 'esto no es js (');
    assert.equal(isApproved(readPlugin(dir), { cartel: approved.cartel }), false, 'one with problems is never approved');
  } finally {
    done();
  }
});

test('the question says what it is, who made it, shows the code and the fingerprint, and says that a change asks again', () => {
  const { root, done } = temp();
  try {
    const p = readPlugin(plugin(root, 'cartel', { 'page.js': 'document.title = "hola";' }));
    const { message, detail } = activationQuestion(p);
    assert.match(message, /Cartel.*TODO el poder/);
    assert.ok(detail.includes(POWER_TEXT));
    assert.ok(detail.includes('De Ana. Versión 1.0.0.'));
    assert.ok(detail.includes('document.title = "hola";'), 'the code is in front of the user');
    assert.ok(detail.includes(p.hash.slice(0, 16)));
    assert.match(detail, /una sola letra .* se te vuelve a preguntar/);
    const long = readPlugin(plugin(root, 'largo', { 'page.js': '// ' + 'x'.repeat(3000) }));
    assert.match(codePreview(long, 100), /… \(\d+ caracteres más\)$/);
    assert.equal(codePreview({ files: { page: join(root, 'no-hay.js') } }), '');
  } finally {
    done();
  }
});

test('the page is handed only what is on and approved with the code it has now, read again at that moment', () => {
  const { root, done } = temp();
  try {
    const dirs = { uno: plugin(root, 'uno', { 'page.js': 'window.A = 1;' }), dos: plugin(root, 'dos', { 'page.js': 'window.B = 2;' }), tres: plugin(root, 'tres') };
    const listed = Object.values(dirs).map(readPlugin);
    const approved = Object.fromEntries(listed.map((p) => [p.id, signature(p)]));
    const warnings = [];
    const warn = (text, id) => warnings.push([id, text]);
    assert.deepEqual(pageScripts(listed, new Set(['uno', 'dos']), approved, readPlugin, warn).map((s) => [s.id, s.source, s.code]), [['uno', 'full', 'window.A = 1;'], ['dos', 'full', 'window.B = 2;']]);
    assert.deepEqual(pageScripts(listed, new Set(['uno']), approved, readPlugin, warn).map((s) => s.id), ['uno'], 'only what is on');
    assert.deepEqual(pageScripts(listed, new Set(['uno']), { ...approved, uno: 'otra' }, readPlugin, warn), [], 'not approved');
    // a file changed on disk after the approval: it does not run, and it is said
    writeFileSync(join(dirs.dos, 'page.js'), 'window.B = "cambiado";');
    assert.deepEqual(pageScripts(listed, new Set(['uno', 'dos']), approved, readPlugin, warn).map((s) => s.id), ['uno']);
    assert.match(warnings.at(-1)[1], /el código ha cambiado desde que lo aprobaste/);
    assert.equal(warnings.at(-1)[0], 'dos');
    assert.deepEqual(pageScripts([{ id: 'x', kind: 'ui', dir: root }], new Set(['x']), approved, readPlugin, warn), [], 'only plugins of this kind');
  } finally {
    done();
  }
});

test('it travels as a package like the others: packed, checked, and still the same plugin with the same fingerprint', () => {
  const { root, done } = temp();
  try {
    const dir = plugin(root, 'cartel', { 'extra/uno.txt': 'dato' });
    const buffer = packFolder(dir, 'cartel');
    const seen = inspectPackage(buffer);
    try {
      assert.equal(seen.plugin.kind, 'full');
      assert.deepEqual(seen.plugin.problems, []);
      assert.equal(seen.plugin.hash, readPlugin(dir).hash, 'the fingerprint survives the trip');
    } finally {
      discard(seen);
    }
    assert.throws(() => packFolder(plugin(root, 'roto', { 'page.js': 'esto no es js (' }), 'roto'), /tiene problemas/);
  } finally {
    done();
  }
});

// ---- themes: a style sheet and no code

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const themeManifest = (css = 'tema.css', extra = {}) => JSON.stringify({ name: 'Rojo', version: '1.0.0', author: 'Ana', tdt: { api: 1, full: { css }, ...extra } });
function theme(root, id, css, files = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), themeManifest());
  writeFileSync(join(dir, 'tema.css'), css);
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  return dir;
}

test('a plugin with only a style sheet is a theme: it has no code, and the words say it is a lot less', () => {
  const { root, done } = temp();
  try {
    const p = readPlugin(theme(root, 'rojo', ':root { --accent: #c0392b; }'));
    assert.deepEqual(p.problems, []);
    assert.deepEqual(p.scopes, ['css']);
    assert.equal(isTheme(p), true);
    assert.equal(signature(p), `rojo|full|css|${p.hash}`);
    const { message, detail } = activationQuestion(p);
    assert.match(message, /Activar el tema «Rojo»/);
    assert.ok(detail.includes(THEME_TEXT) && !detail.includes(POWER_TEXT));
    assert.ok(detail.includes('--accent: #c0392b'), 'the style sheet is in front of the user');
    assert.match(detail, /una sola letra de su hoja de estilo/);
    assert.equal(isTheme(readPlugin(plugin(root, 'con-codigo'))), false);
    const both = readPlugin(plugin(root, 'los-dos', { 'tema.css': 'body{}' }, manifest({}, { full: { page: 'page.js', css: 'tema.css' } })));
    assert.deepEqual(both.scopes, ['page', 'css']);
    assert.equal(isTheme(both), false, 'one with code is not just a theme');
  } finally {
    done();
  }
});

test('the pictures and fonts of a style sheet are put inside it, only from the folder of the plugin', () => {
  const { root, done } = temp();
  try {
    const dir = theme(root, 'fondo', "body { background: url('img/fondo.png') } @font-face { font-family: X; src: url(./f.woff2) } i { fill: url(#clip); background: url(data:image/png;base64,AA==) }", { 'img/fondo.png': PNG, 'f.woff2': Buffer.from('fuente') });
    const p = readPlugin(dir);
    assert.deepEqual(p.problems, []);
    const out = inlineAssets("body { background: url('img/fondo.png'); x: url(img/fondo.png?v=2) }", dir, insideOf);
    assert.deepEqual(out.problems, []);
    assert.equal((out.css.match(/url\("data:image\/png;base64,/g) || []).length, 2);
    assert.ok(out.css.includes(PNG.toString('base64')));
    const keep = inlineAssets('i { fill: url(#clip); b: url(data:image/png;base64,AA==) }', dir, insideOf);
    assert.equal(keep.css, 'i { fill: url(#clip); b: url(data:image/png;base64,AA==) }');
    assert.deepEqual(keep.problems, []);
  } finally {
    done();
  }
});

test('what a style sheet may not do is said in words: an address, @import, a file that is not there, one that is not a picture or a font, or too big', () => {
  const { root, done } = temp();
  try {
    const problems = (id, css, files) => readPlugin(theme(root, id, css, files)).problems.join(' | ');
    assert.match(problems('remoto', 'a { background: url(https://example.com/a.png) }'), /los recursos tienen que estar en la carpeta del plugin/);
    assert.match(problems('fichero', 'a { background: url(file:///c:/x.png) }'), /los recursos tienen que estar en la carpeta/);
    assert.match(problems('doble', 'a { background: url(//example.com/a.png) }'), /los recursos tienen que estar en la carpeta/);
    assert.match(problems('importa', '@import url("otro.css"); a { }'), /«@import»/);
    assert.match(problems('falta', 'a { background: url(no-esta.png) }'), /no existe o está fuera/);
    assert.match(problems('fuera', 'a { background: url(../fuera.png) }'), /no existe o está fuera/);
    assert.match(problems('script', 'a { background: url(x.js) }', { 'x.js': 'alert(1)' }), /tipo de archivo no permitido/);
    assert.match(problems('grande', 'a { background: url(g.png) }', { 'g.png': Buffer.alloc(1024 * 1024 + 1) }), /pesa más de 1 MB/);
    const dir = join(root, 'muchos');
    mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.json'), themeManifest());
    writeFileSync(join(dir, 'tema.css'), [1, 2, 3, 4, 5].map((n) => `a${n} { background: url(i${n}.png) }`).join('\n'));
    for (const n of [1, 2, 3, 4, 5]) writeFileSync(join(dir, `i${n}.png`), Buffer.alloc(900 * 1024, n));
    assert.match(readPlugin(dir).problems.join(' | '), /los recursos pesan más de 4 MB/);
    theme(root, 'ext', 'a{}');
    writeFileSync(join(root, 'ext', 'manifest.json'), themeManifest('tema.txt'));
    assert.match(readPlugin(join(root, 'ext')).problems.join(' | '), /no existe, está fuera de la carpeta o no es \.css/);
  } finally {
    done();
  }
});

test('a theme is handed over with its pictures inside, and only if the style sheet and its files are what was approved', () => {
  const { root, done } = temp();
  try {
    const dir = theme(root, 'rojo', 'a { background: url(i.png) }', { 'i.png': PNG });
    const listed = [readPlugin(dir)];
    const approved = { rojo: signature(listed[0]) };
    const warnings = [];
    const [item] = pageScripts(listed, new Set(['rojo']), approved, readPlugin, (t, id) => warnings.push([id, t]));
    assert.equal(item.source, 'full');
    assert.equal(item.code, undefined, 'no code to run');
    assert.ok(item.css.startsWith('a { background: url("data:image/png;base64,'));
    writeFileSync(join(dir, 'i.png'), Buffer.concat([PNG, Buffer.from('x')]));
    assert.deepEqual(pageScripts(listed, new Set(['rojo']), approved, readPlugin, (t, id) => warnings.push([id, t])), [], 'a picture changed after the approval');
    assert.equal(warnings.at(-1)[0], 'rojo');
  } finally {
    done();
  }
});

test('a file the fingerprint does not count (hidden, in node_modules) cannot be the code or the style sheet or a picture: it could change after the approval and nobody would see it', () => {
  const { root, done } = temp();
  try {
    const problems = (id, m, files) => readPlugin(plugin(root, id, files, m)).problems.join(' | ');
    assert.match(problems('oculto', manifest({}, { full: { page: '.codigo.js' } }), { '.codigo.js': 'tdt.log(1)' }), /no cuenta en la huella del código/);
    assert.match(problems('modulos', manifest({}, { full: { page: 'node_modules/x.js' } }), { 'node_modules/x.js': 'tdt.log(1)' }), /no cuenta en la huella/);
    assert.match(problems('subcarpeta', manifest({}, { full: { page: 'src/.privado/x.js' } }), { 'src/.privado/x.js': 'tdt.log(1)' }), /no cuenta en la huella/);
    assert.match(problems('css-oculto', JSON.stringify({ name: 'x', tdt: { api: 1, full: { css: '.tema.css' } } }), { '.tema.css': 'a{}' }), /no cuenta en la huella/);
    assert.equal(problems('con-punto', manifest({}, { full: { page: './page.js' } }), {}), '', 'a leading ./ is only a way of writing the path');
    const dir = join(root, 'imagen-oculta');
    mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'x', tdt: { api: 1, full: { css: 'tema.css' } } }));
    writeFileSync(join(dir, 'tema.css'), 'a { background: url(.fondo.png) }');
    writeFileSync(join(dir, '.fondo.png'), PNG);
    assert.match(readPlugin(dir).problems.join(' | '), /no cuenta en la huella del código/);
    assert.equal(counted('img/a.png') && counted('./img/a.png') && counted('page.js'), true);
    assert.equal(counted('.a.js') || counted('x/.b/c.js') || counted('node_modules/y.js') || counted('p.tdtplugin'), false);
  } finally {
    done();
  }
});

test('a comment of the style sheet may talk about files, @import or addresses: it asks for nothing', () => {
  const { root, done } = temp();
  try {
    const dir = theme(root, 'comentado', "/* pon url(fondo.png) o url(https://example.com/a.png) y @import 'otro.css' si quieres */\na { color: red }\n/* y otro: url(../fuera.png) */");
    const p = readPlugin(dir);
    assert.deepEqual(p.problems, []);
    const out = inlineAssets("/* url(a.png) */ a { background: url(b.png) } /* url(c.png) */", dir, insideOf);
    assert.match(out.problems.join(' | '), /«b\.png» no existe/, 'what is outside a comment is still checked');
    assert.equal(out.problems.length, 1, 'and only that');
    assert.ok(out.css.startsWith('/* url(a.png) */') && out.css.endsWith('/* url(c.png) */'), 'comments stay as they were');
  } finally {
    done();
  }
});
