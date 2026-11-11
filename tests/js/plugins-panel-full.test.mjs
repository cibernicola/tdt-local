// How the «Plugins» tab says that a plugin has all the power (static/js/lib/plugins-panel.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLUGINS_INTRO, describePlugin, summarize } from '../../tdtlocal/static/js/lib/plugins-panel.js';

const full = (extra = {}) => ({
  id: 'cartel', name: 'Cartel', version: '1.0.0', description: 'Pone un cartel', source: 'tu carpeta de plugins', sites: [], problems: [], enabled: true, kind: 'full',
  author: 'Ana', scopes: ['page'], needsApproval: false, hash: '0123456789abcdef', ...extra,
});

test('a plugin with all the power says that it runs without isolation, who made it and which code was approved', () => {
  const d = describePlugin(full());
  assert.equal(d.title, 'Cartel 1.0.0');
  assert.equal(d.on, true);
  assert.match(d.power, /Sin aislar: corre dentro de la página y puede hacer todo/);
  assert.match(d.power, /huella 0123456789abcdef/);
  assert.equal(d.author, 'De Ana.');
  assert.equal(d.needsReload, false, 'the app reloads the page itself');
  assert.equal(d.renewal, '');
});

test('one whose code changed says that it does not run until the user turns it on again and sees the new code', () => {
  const d = describePlugin(full({ needsApproval: true, enabled: false }));
  assert.match(d.renewal, /Su código ha cambiado desde que lo activaste/);
  assert.equal(d.on, false);
});

test('the other kinds say nothing about power, and the intro names the three kinds', () => {
  assert.equal(describePlugin({ ...full(), kind: 'ui', permissions: [] }).power, '');
  assert.equal(describePlugin({ ...full(), kind: 'script' }).power, '');
  assert.match(PLUGINS_INTRO, /tres clases/);
  assert.match(PLUGINS_INTRO, /con todo el poder/);
  assert.equal(summarize([full(), full({ id: 'otro', enabled: false })]), '2 plugins, 1 activado.');
});
