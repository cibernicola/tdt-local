// The text of the «Desarrollo» tab and of the permanent notice (tdtlocal/static/js/lib/dev-panel.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEV_INTRO, SCOPE_LABEL, bannerText, describeDevPlugin, summarizeDev } from '../../tdtlocal/static/js/lib/dev-panel.js';

const plugin = (extra = {}) => ({
  name: 'Mi plugin', version: '0.1', description: 'Hace algo', scopes: ['page'], problems: [], approved: false,
  needsReapproval: false, running: false, error: '', ...extra,
});

test('the notice is empty while the mode is off and counts the plugins that run without isolation when it is on', () => {
  assert.equal(bannerText(null), '');
  assert.equal(bannerText({ mode: false, plugins: [plugin({ approved: true })] }), '');
  assert.equal(bannerText({ mode: true, plugins: [] }), 'Modo desarrollador: 0 plugins sin aislar');
  assert.equal(bannerText({ mode: true, plugins: [plugin({ approved: true }), plugin()] }), 'Modo desarrollador: 1 plugin sin aislar');
  assert.equal(bannerText({ mode: true, plugins: [plugin({ approved: true }), plugin({ approved: true })] }), 'Modo desarrollador: 2 plugins sin aislar');
});

test('the summary says how many there are and how many are on', () => {
  assert.equal(summarizeDev({ mode: false, plugins: [] }), 'El modo desarrollador está apagado.');
  assert.equal(summarizeDev({ mode: true, plugins: [] }), '0 plugins.');
  assert.equal(summarizeDev({ mode: true, plugins: [plugin()] }), '1 plugin, ninguno activado.');
  assert.equal(summarizeDev({ mode: true, plugins: [plugin({ approved: true }), plugin()] }), '2 plugins, 1 activado.');
});

test('each plugin shows what it can do and in what state it is', () => {
  const off = describeDevPlugin(plugin());
  assert.equal(off.status, 'apagado');
  assert.equal(off.on, false);
  assert.equal(off.usable, true);
  assert.equal(off.title, 'Mi plugin 0.1');
  assert.equal(off.acts, 'Corre en: la página de TDT local.');

  const both = describeDevPlugin(plugin({ scopes: ['page', 'main'], approved: true, running: true }));
  assert.equal(both.on, true);
  assert.equal(both.status, 'activado, corriendo');
  assert.equal(both.acts, 'Corre en: la página de TDT local y en el proceso principal de la aplicación.');
  assert.equal(describeDevPlugin(plugin({ scopes: ['main'], approved: true })).status, 'activado, sin arrancar');
  assert.equal(describeDevPlugin(plugin({ approved: true })).status, 'activado');

  assert.match(describeDevPlugin(plugin({ needsReapproval: true })).status, /volver a activarlo/);
  const failed = describeDevPlugin(plugin({ scopes: ['main'], approved: true, error: 'boom' }));
  assert.equal(failed.status, 'error al arrancar');
  assert.equal(failed.error, 'boom');
  const broken = describeDevPlugin(plugin({ scopes: [], problems: ['algo'], approved: true }));
  assert.equal(broken.usable, false);
  assert.equal(broken.on, false); // a plugin with problems is never shown as on
  assert.equal(broken.status, 'no se puede usar');
});

test('the warning says what it is without softening it', () => {
  assert.match(DEV_INTRO, /SIN aislamiento ni permisos/);
  assert.match(DEV_INTRO, /no lo hagas/);
  assert.ok(SCOPE_LABEL.page && SCOPE_LABEL.main);
});
