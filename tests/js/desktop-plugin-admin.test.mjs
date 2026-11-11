// What an AI may ask about the plugins (desktop/lib/plugin-admin.js). It does not need Electron.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPluginAdmin } from '../../desktop/lib/plugin-admin.js';
import { PERMISSIONS, RISK, riskOf } from '../../desktop/lib/plugin-api.js';

function world() {
  const calls = [];
  const plugins = [
    { id: 'tiempo', kind: 'ui', name: 'El tiempo', enabled: false, problems: [], permissions: [{ name: 'storage', granted: true }, { name: 'network:a.com', granted: true }] },
    { id: 'activo', kind: 'ui', name: 'Activo', enabled: true, problems: [], permissions: [{ name: 'player.read', granted: false }] },
    { id: 'roto', kind: 'ui', name: 'Roto', enabled: false, problems: ['la página no existe'], permissions: [] },
    { id: 'viejo', kind: 'script', name: 'Viejo', enabled: true, problems: [], permissions: [] },
  ];
  const admin = createPluginAdmin({
    snapshot: () => ({ folder: 'x', plugins }),
    setEnabled: async (id, on) => { calls.push(['enabled', id, on]); return id !== 'rechazado'; },
    setPermission: async (id, name, on, ask) => { calls.push(['permission', id, name, on, ask]); return true; },
    logLines: () => [
      '2026-11-05 10:00:00 INFO  [plugins] tiempo activado',
      '2026-11-05 10:00:01 INFO  [plugin:tiempo] net.fetch api.a.com/x → 200',
      '2026-11-05 10:00:02 INFO  [plugin:otro] no es de este plugin',
      '2026-11-05 10:00:03 WARN  [plugin:tiempo] storage.set: demasiadas claves',
      '2026-11-05 10:00:04 INFO  [plugins] tiempoxx activado',
    ],
  });
  return { admin, calls };
}

test('the plugins are listed with what the app knows of them', async () => {
  const { admin } = world();
  const r = await admin.run({ do: 'plugin_list' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.plugins.map((p) => p.id), ['tiempo', 'activo', 'roto', 'viejo']);
});

test('the log of a plugin has its lines and the ones of the app about it, and nobody else\'s', async () => {
  const { admin } = world();
  const r = await admin.run({ do: 'plugin_logs', id: 'tiempo', limit: 10 });
  assert.equal(r.data.lines.length, 3);
  assert.ok(r.data.lines.every((l) => /tiempo/.test(l) && !/otro|tiempoxx/.test(l)));
  assert.equal((await admin.run({ do: 'plugin_logs', id: 'tiempo', limit: 1 })).data.lines.length, 1);
  assert.equal((await admin.run({ do: 'plugin_logs', id: 'nadie' })).ok, false);
  assert.equal((await admin.run({ do: 'plugin_logs', id: '../x' })).ok, false, 'an id that is not an id is refused');
  assert.equal((await admin.run({ do: 'plugin_logs', id: 123 })).ok, false);
});

test('turning a plugin on or off goes through the app, and what cannot be done is said', async () => {
  const { admin, calls } = world();
  assert.deepEqual(await admin.run({ do: 'plugin_enable', id: 'tiempo' }), { ok: true, detail: 'activado' });
  assert.deepEqual(calls.at(-1), ['enabled', 'tiempo', true]);
  assert.deepEqual(await admin.run({ do: 'plugin_enable', id: 'activo' }), { ok: true, detail: 'ya estaba activado' });
  assert.deepEqual(await admin.run({ do: 'plugin_disable', id: 'tiempo' }), { ok: true, detail: 'ya estaba desactivado' });
  assert.deepEqual(await admin.run({ do: 'plugin_disable', id: 'activo' }), { ok: true, detail: 'desactivado' });
  const roto = await admin.run({ do: 'plugin_enable', id: 'roto' });
  assert.equal(roto.ok, false);
  assert.match(roto.detail, /la página no existe/);
  assert.equal((await admin.run({ do: 'plugin_enable', id: 'nadie' })).ok, false);
  assert.equal(calls.filter((c) => c[0] === 'enabled').length, 2, 'only the two real changes reached the app');
  assert.deepEqual((await admin.run({ do: 'plugin_enable', id: 'rechazado' })).ok, false);
});

test('giving a permission back asks the user, and taking it away does not', async () => {
  const { admin, calls } = world();
  assert.deepEqual(await admin.run({ do: 'plugin_permission', id: 'tiempo', permission: 'network:a.com', on: false }), { ok: true, detail: 'quitado' });
  assert.deepEqual(calls.at(-1), ['permission', 'tiempo', 'network:a.com', false, false]);
  assert.deepEqual(await admin.run({ do: 'plugin_permission', id: 'activo', permission: 'player.read', on: true }), { ok: true, detail: 'permitido' });
  assert.deepEqual(calls.at(-1), ['permission', 'activo', 'player.read', true, true], 'asked');
  assert.deepEqual(await admin.run({ do: 'plugin_permission', id: 'tiempo', permission: 'storage', on: true }), { ok: true, detail: 'ya estaba permitido' });
  assert.match((await admin.run({ do: 'plugin_permission', id: 'tiempo', permission: 'epg.read', on: true })).detail, /no declara/);
  assert.equal((await admin.run({ do: 'plugin_permission', id: 'tiempo', permission: 'storage', on: 'no' })).ok, false);
  assert.equal((await admin.run({ do: 'plugin_permission', id: 'viejo', permission: 'storage', on: true })).ok, false, 'a script plugin has no permissions');
});

test('whatever is asked, it answers and never throws', async () => {
  const admin = createPluginAdmin({ snapshot: () => { throw new Error('se rompió'); }, setEnabled: async () => true, setPermission: async () => true, logLines: () => [] });
  assert.match((await admin.run({ do: 'plugin_list' })).detail, /se rompió/);
  assert.equal((await admin.run({ do: 'nada' })).ok, false);
  assert.equal((await admin.run(null)).ok, false);
  assert.equal((await admin.run('plugin_list')).ok, false);
});

test('the permission texts and risks of the desktop app are the ones of the specification', () => {
  const spec = JSON.parse(readFileSync(new URL('../../tdtlocal/static/plugin-api.json', import.meta.url), 'utf8'));
  for (const name of Object.keys(PERMISSIONS)) {
    assert.equal(PERMISSIONS[name], spec.permissions[name].text, name);
    assert.equal(riskOf(name), spec.permissions[name].risk, name);
  }
  assert.deepEqual(Object.keys(RISK).sort(), Object.keys(spec.permissions).filter((p) => !p.startsWith('network:') && !p.startsWith('embed:')).sort());
  assert.equal(riskOf('embed:player.a.tv'), spec.permissions['embed:<servidor>'].risk);
  assert.equal(riskOf('network:a.com'), spec.permissions['network:<servidor>'].risk);
});

test('plugin_config: a plugin that does not exist or an admin without the settings is refused; the rest goes to the settings with the plugin', async () => {
  const calls = [];
  const admin = createPluginAdmin({
    snapshot: () => ({ plugins: [{ id: 'mio', kind: 'ui', problems: [] }, { id: 'viejo', kind: 'script', problems: [] }] }),
    setEnabled: async () => true, setPermission: async () => true, logLines: () => [],
    config: { change: async (plugin, values) => { calls.push([plugin.id, values]); return { ok: true, detail: 'guardados' }; } },
  });
  assert.deepEqual(await admin.run({ do: 'plugin_config', id: 'mio', values: { a: 1 } }), { ok: true, detail: 'guardados' });
  assert.deepEqual(calls, [['mio', { a: 1 }]]);
  assert.equal((await admin.run({ do: 'plugin_config', id: 'nadie', values: { a: 1 } })).ok, false);
  assert.equal((await admin.run({ do: 'plugin_config', id: 'viejo', values: { a: 1 } })).ok, false, 'a plugin of scripts has no settings');
  const without = createPluginAdmin({ snapshot: () => ({ plugins: [{ id: 'mio', kind: 'ui', problems: [] }] }), setEnabled: async () => true, setPermission: async () => true, logLines: () => [] });
  assert.match((await without.run({ do: 'plugin_config', id: 'mio', values: { a: 1 } })).detail, /no está disponible/);
});
