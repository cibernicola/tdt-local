// What an AI may write through the MCP besides plugins with permissions: plugins with all the power and themes (desktop/lib/plugin-writer.js), and the templates of the buttons «Crear un tema» and
// «Crear un plugin con todo el poder» (desktop/lib/plugin-pack.js). It does not need Electron.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describePermission, riskOf, signature } from '../../desktop/lib/plugin-api.js';
import { POWER_TEXT, THEME_TEXT, isTheme, signature as fullSignature } from '../../desktop/lib/plugin-full.js';
import { newPluginFiles } from '../../desktop/lib/plugin-pack.js';
import { createPluginWriter, lintFull } from '../../desktop/lib/plugin-writer.js';
import { readPlugin } from '../../desktop/lib/plugins.js';

function world() {
  const root = mkdtempSync(join(tmpdir(), 'tdt-writer-full-'));
  const dir = join(root, 'plugins');
  mkdirSync(dir, { recursive: true });
  const state = { approved: {}, active: new Set(), asked: [], reloads: 0, answer: true, logs: [] };
  const writer = createPluginWriter({
    dir, readPlugin, signature, describePermission, riskOf,
    approved: () => state.approved,
    isActive: (id) => state.active.has(id),
    confirmWrite: async (ask) => { state.asked.push(ask); return state.answer; },
    reload: () => { state.reloads += 1; if (state.onReload) state.onReload(); }, // the app reads the folder again: a plugin whose code changed is no longer approved
    log: (level, text) => state.logs.push([level, text]),
  });
  return { root, dir, writer, state, done: () => rmSync(root, { recursive: true, force: true }) };
}

const manifest = (full, extra = {}) => JSON.stringify({ name: 'Cartel', version: '0.1.0', author: 'Ana', tdt: { api: 1, full, ...extra } });
const CODE = { 'manifest.json': manifest({ page: 'page.js' }), 'page.js': "tdt.on('ad.started', (a) => tdt.log(a.name));\nreturn () => tdt.log('adiós');\n" };
const THEME = { 'manifest.json': manifest({ css: 'tema.css' }), 'tema.css': ':root { --accent: #c0392b; }\n' };

test('a plugin with all the power is checked, shown to the user with the words of «todo el poder» and the code, and written without activating anything', async () => {
  const { dir, writer, state, done } = world();
  try {
    const dry = await writer.write({ id: 'cartel', files: CODE, dry_run: true });
    assert.equal(dry.ok, true, dry.detail);
    assert.equal(dry.data.kind, 'full');
    assert.deepEqual(dry.data.scopes, ['page']);
    assert.equal(dry.data.theme, false);
    assert.deepEqual(dry.data.warnings, []);
    assert.equal(state.asked.length, 0, 'a dry run asks nothing');
    assert.ok(!existsSync(join(dir, 'cartel')), 'and writes nothing');

    const r = await writer.write({ id: 'cartel', files: CODE });
    assert.equal(r.ok, true, r.detail);
    assert.equal(state.asked.length, 1);
    assert.match(state.asked[0].message, /Una IA quiere escribir el plugin con TODO el poder «Cartel» \(cartel\)/);
    assert.ok(state.asked[0].detail.includes(POWER_TEXT));
    assert.match(state.asked[0].detail, /No correrá hasta que lo actives tú \(se te enseñará su código otra vez\)/);
    assert.match(state.asked[0].detail, /El código nuevo/);
    assert.ok(state.asked[0].detail.includes("tdt.on('ad.started'"), 'the code is in front of the user');
    assert.deepEqual(readdirSync(join(dir, 'cartel')).sort(), ['manifest.json', 'page.js']);
    assert.equal(r.data.active, false);
    assert.match(r.data.next, /tdt_plugin_enable.*su código/);
    assert.equal(state.reloads, 1);
    assert.ok(!existsSync(state.asked[0].stageDir), 'the folder apart is gone');
  } finally {
    done();
  }
});

test('top-level await and return in page.js are fine (it runs inside an async function), and a real syntax error comes back with its line', async () => {
  const { writer, done } = world();
  try {
    const fine = await writer.write({ id: 'espera', files: { ...CODE, 'page.js': 'const x = await Promise.resolve(1);\ntdt.log(x);\nreturn () => {};\n' }, dry_run: true });
    assert.equal(fine.ok, true, fine.detail);
    const broken = await writer.write({ id: 'roto', files: { ...CODE, 'page.js': 'tdt.log(1);\nesto no es js (' }, dry_run: true });
    assert.equal(broken.ok, false);
    assert.match(broken.detail, /error de sintaxis \(línea 2\)/);
  } finally {
    done();
  }
});

test('a theme is written with the words of a theme, and says that it is only a style sheet', async () => {
  const { writer, state, done } = world();
  try {
    const dry = await writer.write({ id: 'rojo', files: THEME, dry_run: true });
    assert.equal(dry.ok, true, dry.detail);
    assert.equal(dry.data.theme, true);
    assert.deepEqual(dry.data.scopes, ['css']);
    const r = await writer.write({ id: 'rojo', files: THEME });
    assert.equal(r.ok, true, r.detail);
    assert.match(state.asked[0].message, /Una IA quiere escribir el tema «Cartel» \(rojo\)/);
    assert.ok(state.asked[0].detail.includes(THEME_TEXT) && !state.asked[0].detail.includes(POWER_TEXT));
    assert.match(state.asked[0].detail, /La hoja de estilo nueva/);
    assert.match(state.asked[0].detail, /--accent: #c0392b/);
  } finally {
    done();
  }
});

test('a theme may not name a picture that is not in its folder, and an AI cannot write hidden files (the fingerprint would not count them)', async () => {
  const { writer, done } = world();
  try {
    const remote = await writer.write({ id: 'remoto', files: { ...THEME, 'tema.css': 'a { background: url(https://example.com/x.png) }' }, dry_run: true });
    assert.equal(remote.ok, false);
    assert.match(remote.detail, /los recursos tienen que estar en la carpeta del plugin/);
    const hidden = await writer.write({ id: 'oculto', files: { 'manifest.json': manifest({ page: '.codigo.js' }), '.codigo.js': 'tdt.log(1)' }, dry_run: true });
    assert.equal(hidden.ok, false);
  } finally {
    done();
  }
});

test('rewriting one that is on: it stops until the user turns it on again and sees the new code, and the AI is told so', async () => {
  const { dir, writer, state, done } = world();
  try {
    await writer.write({ id: 'cartel', files: CODE });
    const old = readPlugin(join(dir, 'cartel'));
    state.approved.cartel = fullSignature(old);
    state.active.add('cartel');
    state.onReload = () => state.active.delete('cartel');
    state.asked.length = 0;
    const r = await writer.write({ id: 'cartel', files: { 'page.js': "tdt.log('otra cosa');\n" } });
    assert.equal(r.ok, true, r.detail);
    assert.match(state.asked[0].message, /cambiar el plugin con TODO el poder/);
    assert.match(state.asked[0].detail, /ESTÁ ACTIVADO: dejará de correr .* hasta que lo vuelvas a activar y veas lo nuevo/);
    assert.match(r.data.next, /la aprobación es de su código y ha cambiado.*tdt_plugin_enable/);
  } finally {
    done();
  }
});

test('the user can say no, and nothing is written', async () => {
  const { dir, writer, state, done } = world();
  try {
    state.answer = false;
    const r = await writer.write({ id: 'cartel', files: CODE });
    assert.equal(r.ok, false);
    assert.match(r.detail, /rechazó/);
    assert.ok(!existsSync(join(dir, 'cartel')));
  } finally {
    done();
  }
});

test('a development plugin or a manifest of another kind is refused, and the answer names the two kinds that are accepted', async () => {
  const { writer, done } = world();
  try {
    const dev = await writer.write({ id: 'desarrollo', files: { 'manifest.json': JSON.stringify({ name: 'x', tdt: { api: 0, dev: { page: 'page.js' } } }), 'page.js': 'tdt.log(1)' }, dry_run: true });
    assert.equal(dev.ok, false);
    assert.match(dev.detail, /con permisos ni con todo el poder/);
    assert.match(dev.detail, /«full»/);
  } finally {
    done();
  }
});

test('advice for the AI: no use of tdt, a request to the internet that the page blocks, and a static import', () => {
  const plugin = { files: { page: '/x/page.js' }, pageName: 'page.js' };
  assert.deepEqual(lintFull({ 'page.js': "tdt.log('hola');" }, plugin), []);
  assert.match(lintFull({ 'page.js': 'document.title = 1;' }, plugin).join(' | '), /no usa «tdt»/);
  assert.match(lintFull({ 'page.js': "tdt.log(1); fetch('https://example.com/x')" }, plugin).join(' | '), /connect-src/);
  assert.match(lintFull({ 'page.js': "import { x } from './x.js'; tdt.log(x)" }, plugin).join(' | '), /import. estático/);
  assert.deepEqual(lintFull({ 'page.js': "tdt.log(1); await import('/js/state.js')" }, plugin), [], 'a dynamic import is the way');
  assert.deepEqual(lintFull({ 'tema.css': 'a{}' }, { files: { css: '/x/tema.css' } }), [], 'a theme has no code to advise on');
});

test('the templates of the buttons work as they are: a theme and a plugin with all the power, with nothing to correct', async () => {
  const { root, writer, done } = world();
  try {
    for (const [kind, scope] of [['full', 'page'], ['theme', 'css']]) {
      const files = newPluginFiles(`prueba-${kind}`, 'Prueba', kind);
      const dir = join(root, `prueba-${kind}`);
      mkdirSync(dir);
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      const plugin = readPlugin(dir);
      assert.deepEqual(plugin.problems, [], kind);
      assert.equal(plugin.kind, 'full');
      assert.deepEqual(plugin.scopes, [scope]);
      assert.equal(isTheme(plugin), kind === 'theme');
      const dry = await writer.write({ id: `prueba-${kind}`, files: { ...files, 'manifest.json': files['manifest.json'] }, dry_run: true });
      assert.equal(dry.ok, true, dry.detail);
      assert.deepEqual(dry.data.warnings, [], `the template of ${kind} raises no warning`);
    }
    assert.equal(readPlugin(join(root, 'prueba-full')).hash.length, 64);
    assert.match(readFileSync(join(root, 'prueba-full', 'page.js'), 'utf8'), /tile\.overlay/);
    assert.match(readFileSync(join(root, 'prueba-theme', 'tema.css'), 'utf8'), /--accent/);
    assert.deepEqual(Object.keys(newPluginFiles('x', 'X')).sort(), ['app.js', 'index.html', 'manifest.json'], 'the default is still the plugin with permissions');
  } finally {
    done();
  }
});
