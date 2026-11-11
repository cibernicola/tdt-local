// Themes that plugins bring (tdt.themes): only known variables with values that are colours, and only the choice of the user applies.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_THEMES as DESKTOP_MAX, readThemes } from '../../desktop/lib/plugin-api.js';
import { MAX_THEMES, VARS, chosen, cleanThemes, isColor } from '../../tdtlocal/static/js/lib/themes.js';

const theme = (extra = {}) => ({ id: 'oscuro', name: 'Oscuro', scheme: 'dark', vars: { '--accent': '#62c4d3', '--chassis': 'rgb(10, 12, 11)', '--ink': 'hsl(90 10% 90%)' }, ...extra });

test('the variables a theme may repaint are the colours of the page, and every one of them exists in its stylesheet', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../tdtlocal/static/style.css', import.meta.url), 'utf8');
  for (const name of VARS) assert.match(css, new RegExp(`${name}:`), `${name} is a variable of style.css`);
  assert.ok(!VARS.includes('--font'), 'a theme changes colours, not the type');
  assert.equal(MAX_THEMES, DESKTOP_MAX);
});

test('only plain colours are colours: hex, rgb() and hsl(), nothing that could carry an address or a function', () => {
  for (const ok of ['#fff', '#ffff', '#0d5662', '#0d5662cc', 'rgb(1, 2, 3)', 'rgba(1,2,3,.5)', 'hsl(90 10% 90%)', 'hsla(90, 10%, 90%, 0.4)', ' #fff ']) assert.equal(isColor(ok), true, ok);
  for (const bad of ['red', 'url(https://x.example/a.png)', 'rgb(url(x))', 'var(--ink)', 'calc(1px)', '#ggg', '#12345', 'expression(1)', 'rgb(1,2,3);color:red', '', 5, null, undefined, '#fff; --x: y']) assert.equal(isColor(bad), false, String(bad));
});

test('the themes of a plugin are cleaned: known variables with colours stay, the rest is dropped and counted', () => {
  const [one] = cleanThemes('mi-plugin', [theme({ vars: { '--accent': '#62c4d3', '--font': 'Comic Sans', '--ink': 'url(x)', '--inventada': '#fff' } })]);
  assert.deepEqual(one.vars, { '--accent': '#62c4d3' });
  assert.equal(one.dropped, 3);
  assert.equal(one.key, 'mi-plugin/oscuro');
  assert.equal(one.label, 'Oscuro (mi-plugin)', 'the list says whose it is');
  assert.equal(one.scheme, 'dark');
  assert.equal(cleanThemes('p', [theme({ scheme: 'sepia' })])[0].scheme, '', 'a scheme that is not light or dark is ignored');
});

test('a theme that is not a theme is dropped, and there are few of them', () => {
  const bad = [null, 5, 'x', [], {}, { id: 'A', name: 'Mayúscula', vars: { '--accent': '#fff' } }, { id: 'x y', name: 'n', vars: { '--accent': '#fff' } }, { id: 'ok', name: '', vars: { '--accent': '#fff' } }, { id: 'ok', name: 'n', vars: {} }, { id: 'ok', name: 'n', vars: { '--font': 'x' } }, { id: 'ok', name: 'n', vars: 'x' }];
  assert.deepEqual(cleanThemes('p', bad), []);
  assert.deepEqual(cleanThemes('p', undefined), []);
  assert.equal(cleanThemes('p', Array.from({ length: MAX_THEMES + 3 }, (_, i) => theme({ id: 't' + i }))).length, MAX_THEMES);
});

test('the theme chosen is applied only if a plugin that runs still brings it', () => {
  const list = cleanThemes('p', [theme()]);
  assert.equal(chosen(list, 'p/oscuro').key, 'p/oscuro');
  assert.equal(chosen(list, 'otro/oscuro'), null);
  assert.equal(chosen(list, ''), null);
  assert.equal(chosen([], 'p/oscuro'), null, 'the plugin stopped: the page goes back to its own colours');
});

test('a manifest brings themes with the right shape, and a wrong one is said in words', () => {
  assert.deepEqual(readThemes(undefined), { list: [], problems: [] });
  assert.equal(readThemes([theme()]).list.length, 1);
  for (const wrong of ['x', {}, [5], [null], [{ id: 'a' }], [{ id: 'a', name: 'n' }], [{ id: 1, name: 'n', vars: {} }], Array.from({ length: DESKTOP_MAX + 1 }, () => theme())]) {
    const r = readThemes(wrong);
    assert.equal(r.list.length, 0, JSON.stringify(wrong).slice(0, 40));
    assert.match(r.problems[0], /tdt\.themes/);
  }
});
