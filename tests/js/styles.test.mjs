// The style sheets plugins put in the page (static/js/styles.js, and `tdt.css` of the loader) and how the «Plugins» tab names a theme. The browser's `document` and `CSSStyleSheet` are fakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHub } from '../../tdtlocal/static/js/lib/events.js';
import { createHooks } from '../../tdtlocal/static/js/lib/hooks.js';
import { describePlugin } from '../../tdtlocal/static/js/lib/plugins-panel.js';
import { createLoader } from '../../tdtlocal/static/js/lib/trusted.js';

globalThis.document = { adoptedStyleSheets: [{ css: 'la de la página' }] };
globalThis.CSSStyleSheet = class { replaceSync(css) { this.css = css; } };
const { setStyle, styleKeys } = await import('../../tdtlocal/static/js/styles.js');
const sheets = () => document.adoptedStyleSheets.map((s) => s.css);

test('a style sheet goes in after the page\'s own, under a key, and a text left empty takes it away', () => {
  setStyle('tema', 'a { color: red }');
  assert.deepEqual(sheets(), ['la de la página', 'a { color: red }'], 'after the page\'s own, so it wins ties');
  assert.deepEqual(styleKeys(), ['tema']);
  setStyle('tema', 'a { color: blue }');
  assert.deepEqual(sheets(), ['la de la página', 'a { color: blue }'], 'the same key replaces it');
  setStyle('otro', 'b { margin: 0 }');
  setStyle('tema', '');
  assert.deepEqual(sheets(), ['la de la página', 'b { margin: 0 }']);
  setStyle('otro', '');
  assert.deepEqual(sheets(), ['la de la página']);
  assert.deepEqual(styleKeys(), []);
});

test('what setStyle returns takes away only the sheet that call put in', () => {
  const off = setStyle('k', 'uno');
  setStyle('k', 'dos'); // another one under the same key, later
  off();
  assert.deepEqual(sheets(), ['la de la página', 'dos'], 'the later one stays');
  setStyle('k', '');
  const again = setStyle('k', 'tres');
  again();
  again();
  assert.deepEqual(sheets(), ['la de la página']);
});

test('tdt.css of a plugin puts a sheet in and takes it away with the plugin; without the page being able to, it does nothing', async () => {
  const hooks = createHooks({ hub: createHub() });
  const loader = createLoader(hooks, { log: () => {}, css: setStyle });
  await loader.load('mio', (tdt) => { tdt.css('x { top: 1px }'); tdt.css('y { top: 2px }'); });
  assert.deepEqual(sheets(), ['la de la página', 'x { top: 1px }', 'y { top: 2px }']);
  loader.unload('mio');
  assert.deepEqual(sheets(), ['la de la página']);
  const without = createLoader(hooks, { log: () => {} });
  await without.load('otro', (tdt) => { assert.equal(typeof tdt.css('z { }'), 'function'); });
  assert.deepEqual(sheets(), ['la de la página']);
});

test('the «Plugins» tab says that a theme is only a style sheet and runs no code, and that a changed one is not applied until it is turned on again', () => {
  const base = { id: 'rojo', name: 'Rojo', version: '1.0.0', description: '', source: '', sites: [], problems: [], enabled: true, kind: 'full', author: 'Ana', hash: '0123456789abcdef', needsApproval: false };
  const theme = describePlugin({ ...base, scopes: ['css'] });
  assert.match(theme.power, /^Tema: cambia el aspecto con una hoja de estilo; no ejecuta código\./);
  assert.doesNotMatch(theme.power, /Sin aislar/);
  assert.match(describePlugin({ ...base, scopes: ['css'], needsApproval: true }).renewal, /Su hoja de estilo ha cambiado/);
  assert.match(describePlugin({ ...base, scopes: ['page', 'css'] }).power, /Sin aislar/, 'with code it is not just a theme');
  assert.match(describePlugin({ ...base, scopes: ['page'], needsApproval: true }).renewal, /Su código ha cambiado/);
});
