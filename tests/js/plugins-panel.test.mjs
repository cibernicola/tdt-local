// What the "Plugins" tab of the settings says about each plugin (the tab only exists in the desktop app).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEV_POINTER, describePlugin, describeRuntime, hostsOf, permissionRows, summarize } from '../../tdtlocal/static/js/lib/plugins-panel.js';

const bridge = {
  name: 'TDT local · puente con Atresplayer',
  version: '1.1.0',
  description: 'Cuenta a TDT local cuándo hay publicidad.',
  source: 'incluido con la aplicación',
  sites: ['https://www.atresplayer.com/embed/live/*', 'https://atresplayer.com/embed/live/*'],
  problems: [],
  enabled: false,
};

test('the sites of a plugin are shown as hosts, once each', () => {
  assert.deepEqual(hostsOf(bridge.sites), ['www.atresplayer.com', 'atresplayer.com']);
  assert.deepEqual(hostsOf(['https://a.com/x/*', 'http://a.com/y', '*://b.com:8080/*']), ['a.com', 'b.com:8080']);
  assert.deepEqual(hostsOf(['rubbish', undefined]), []);
  assert.deepEqual(hostsOf(), []);
});

test('a plugin is described with where it acts and where it comes from', () => {
  const d = describePlugin(bridge);
  assert.equal(d.title, 'TDT local · puente con Atresplayer 1.1.0');
  assert.equal(d.acts, 'Actúa solo en: www.atresplayer.com, atresplayer.com.');
  assert.equal(d.source, 'Viene de: incluido con la aplicación.');
  assert.deepEqual([d.usable, d.on], [true, false]);
  assert.equal(describePlugin({ ...bridge, enabled: true }).on, true);
});

test('a plugin with problems cannot be on, whatever the saved state says', () => {
  const d = describePlugin({ ...bridge, enabled: true, problems: ['pide «permissions»'] });
  assert.deepEqual([d.usable, d.on], [false, false]);
  assert.deepEqual(d.problems, ['pide «permissions»']);
});

test('a plugin with no version or source does not show empty words', () => {
  const d = describePlugin({ ...bridge, version: '', source: '', sites: [] });
  assert.equal(d.title, bridge.name);
  assert.equal(d.source, '');
  assert.equal(d.acts, '');
});

test('the summary counts plugins and how many are on', () => {
  assert.equal(summarize([]), 'No hay ningún plugin.');
  assert.equal(summarize([bridge]), '1 plugin, ninguno activado.');
  assert.equal(summarize([{ ...bridge, enabled: true }]), '1 plugin, 1 activado.');
  assert.equal(summarize([{ ...bridge, enabled: true }, { ...bridge, enabled: true }, bridge]), '3 plugins, 2 activados.');
  assert.equal(summarize([{ ...bridge, enabled: true, problems: ['x'] }]), '1 plugin, ninguno activado.');
});

test('the Plugins tab says where the development plugins are, since they are not in its list', () => {
  assert.match(DEV_POINTER, /pestaña «Desarrollo»/);
  assert.match(DEV_POINTER, /no salen en esta lista/);
});

test('a plugin with permissions says what it asks for, and needs no reload', () => {
  const ui = {
    id: 'tiempo', kind: 'ui', name: 'El tiempo', version: '1.0.0', description: 'x', source: '', sites: [], problems: [], enabled: true,
    author: 'Ana', permissions: [{ name: 'storage', text: 'guardar datos' }, { name: 'network:a.com', text: 'hablar con a.com' }], needsApproval: false,
  };
  const d = describePlugin(ui);
  assert.equal(d.author, 'De Ana.');
  assert.deepEqual(d.permissions, ['Pide permiso para:', '· guardar datos', '· hablar con a.com']);
  assert.equal(d.needsReload, false);
  assert.equal(d.renewal, '');
  assert.match(describePlugin({ ...ui, needsApproval: true, enabled: false }).renewal, /se te volverá a preguntar/);
  assert.deepEqual(describePlugin({ ...ui, permissions: [] }).permissions, ['No pide ningún permiso.']);
  assert.equal(describePlugin(bridge).needsReload, true);
  assert.deepEqual(describePlugin(bridge).permissions, []);
});

test('a plugin that takes the screen of the player says so', () => {
  const ui = { id: 't', kind: 'ui', name: 'T', version: '1', description: '', source: '', sites: [], problems: [], enabled: true, permissions: [], screen: true };
  assert.equal(describePlugin(ui).screen, 'Se abre sobre la pantalla del reproductor.');
  assert.equal(describePlugin({ ...ui, screen: false }).screen, '');
});

test('the permissions of a plugin are rows the user can turn on and off, with their risk', () => {
  const rows = permissionRows({ permissions: [{ name: 'storage', text: 'guardar', risk: 'low', granted: true }, { name: 'network:a.com', text: 'hablar con a.com', risk: 'high', granted: false }, { name: 'x', text: 'y' }] });
  assert.deepEqual(rows.map((r) => [r.name, r.granted, r.risk, r.riskText]), [
    ['storage', true, 'low', 'riesgo bajo'], ['network:a.com', false, 'high', 'riesgo alto'], ['x', true, 'high', 'riesgo alto'],
  ]);
  assert.deepEqual(permissionRows({}), []);
});

test('how a running plugin is doing is said in words: its state and what it has done', () => {
  assert.deepEqual(describeRuntime(null, null), { state: 'parado', health: 'stopped', activity: '' });
  const quiet = describeRuntime({ state: 'running', calls: 0, errors: 0, denied: 0, limited: 0, restarts: 0 }, { fetches: 0, bytesIn: 0, hosts: [], storage: { bytes: 0, keys: 0 } });
  assert.deepEqual(quiet, { state: 'en marcha', health: 'running', activity: '' });
  const busy = describeRuntime(
    { state: 'running', calls: 1200, errors: 3, denied: 2, limited: 1, restarts: 1 },
    { fetches: 6, bytesIn: 2048, hosts: ['api.a.com', 'b.org'], storage: { bytes: 300, keys: 1 } },
  );
  assert.equal(busy.activity, '1200 llamadas · 3 errores · 2 sin permiso · 1 frenadas por ritmo · 1 reinicio · red: 6 peticiones (2 KB) a api.a.com, b.org · guarda 300 B en 1 clave');
  assert.match(describeRuntime({ state: 'unresponsive' }, null).state, /no responde/);
  assert.equal(describeRuntime({ state: 'unresponsive' }, null).health, 'unresponsive');
  assert.equal(describeRuntime({ state: 'starting' }, null).state, 'arrancando');
});
