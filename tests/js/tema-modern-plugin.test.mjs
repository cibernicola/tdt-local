// The Modern theme of the examples (docs/ejemplos/tema-modern): a plugin with all the power that brings a style sheet and a little code.
// These tests catch the ways an application change can break it: the loader refusing it, its files growing past the limits, the page losing an
// id the style sheet places or a variable it reads, and the modules page.js imports no longer giving what it uses. No DOM, no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MAX_ASSET, MAX_ASSETS, MAX_CSS, inlineAssets, isTheme } from '../../desktop/lib/plugin-full.js';
import { insideOf, readPlugin } from '../../desktop/lib/plugins.js';

const path = (rel) => new URL(rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIR = path('../../docs/ejemplos/tema-modern');
const CSS = readFileSync(path('../../docs/ejemplos/tema-modern/tema.css'), 'utf8');
const PAGE = readFileSync(path('../../docs/ejemplos/tema-modern/page.js'), 'utf8');
const APP_CSS = readFileSync(path('../../tdtlocal/static/style.css'), 'utf8');
const INDEX = readFileSync(path('../../tdtlocal/static/index.html'), 'utf8');
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('the loader reads it as a plugin with all the power, with a style sheet and code, and no problems', () => {
  const p = readPlugin(DIR);
  assert.deepEqual(p.problems, []);
  assert.equal(p.kind, 'full');
  assert.deepEqual([...p.scopes].sort(), ['css', 'page']);
  assert.equal(isTheme(p), false, 'it has code, so it is approved as a plugin with all the power, not as a plain theme');
  assert.equal(p.name, 'Modern');
});

test('its font and the app icon are put inside the style sheet, within the limits', () => {
  const { css, problems } = inlineAssets(CSS, DIR, insideOf);
  assert.deepEqual(problems, []);
  assert.match(css, /url\("data:font\/woff2;base64,/);
  assert.match(css, /url\("data:image\/svg\+xml;base64,/);
  assert.ok(CSS.length < MAX_CSS, 'the style sheet itself');
  const assets = ['Geist-Variable.woff2', 'icono-app.svg'].map((f) => readFileSync(`${DIR}/${f}`).length);
  for (const size of assets) assert.ok(size <= MAX_ASSET, 'each file it names');
  assert.ok(assets.reduce((a, b) => a + b, 0) <= MAX_ASSETS, 'all of them together');
});

test('every id the style sheet places and page.js moves exists in the page', () => {
  const ids = new Set([...INDEX.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const inCss = [...withoutComments(CSS).matchAll(/#([A-Za-z][\w-]*)/g)].map((m) => m[1]).filter((id) => !/^[0-9a-f]{3,8}$/i.test(id));
  const inPage = [...PAGE.matchAll(/'((?:btn|now)[A-Z]\w*)'/g)].map((m) => m[1]);
  assert.ok(inPage.length >= 17, 'page.js names the buttons it moves');
  const missing = [...new Set([...inCss, ...inPage])].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], 'an id the app renamed or removed: its icon, tooltip or place in the order is lost');
});

test('every icon button has a tooltip, since its label is hidden', () => {
  const icons = new Set([...CSS.matchAll(/#(btn\w+)\s*\{\s*--n-icon:/g)].map((m) => m[1]));
  const tips = new Set([...CSS.matchAll(/#(btn\w+)\s*\{\s*--n-tip:/g)].map((m) => m[1]));
  assert.ok(icons.size >= 15);
  assert.deepEqual([...icons].filter((id) => !tips.has(id)), []);
});

test('every variable it reads is defined by the theme or by the app', () => {
  const defined = new Set([...`${CSS}\n${APP_CSS}`.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const read = new Set([...withoutComments(CSS).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...read].filter((name) => !defined.has(name)), []);
});

test('page.js is a valid plugin body and the modules it imports still give what it uses', () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction('tdt', PAGE));
  const imports = { '/js/state.js': 'cur', '/js/dom.js': 'fillLogo' };
  for (const [module, name] of Object.entries(imports)) {
    assert.match(PAGE, new RegExp(`\\{ ${name} \\} = await import\\('${module.replace(/[/.]/g, '\\$&')}'\\)`));
    const source = readFileSync(path(`../../tdtlocal/static${module}`), 'utf8');
    assert.match(source, new RegExp(`export (?:function|const) ${name}\\b`), `${module} no longer exports ${name}`);
  }
});
