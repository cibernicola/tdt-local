// The inspector: one timeline of events, calls of the plugins and firings of rules; and the log of calls that feeds it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCallLog, CALL_KEEP } from '../../tdtlocal/static/js/lib/plugin-host.js';
import { KINDS, describeCall, describeFiring, describeHooks, timeline } from '../../tdtlocal/static/js/lib/inspector.js';
import { runPluginCommand } from '../../tdtlocal/static/js/lib/control.js';

const call = (t, plugin, method, code = null, ms = 2) => ({ t, plugin, method, code, ms });

test('the log of calls keeps who called what and how it ended, newest first, a limited number, and never arguments or answers', () => {
  const log = createCallLog(5);
  for (let i = 1; i <= 8; i += 1) log.add(call(i, i % 2 ? 'a' : 'b', 'player.state', i === 8 ? 'E_PERMISSION' : null));
  assert.deepEqual(log.recent(10).map((c) => c.t), [8, 7, 6, 5, 4], 'only the latest five were kept, newest first');
  assert.deepEqual(log.recent(2).map((c) => c.t), [8, 7]);
  assert.deepEqual(log.recent(10, 'a').map((c) => c.t), [7, 5], 'one plugin');
  assert.deepEqual(Object.keys(log.recent(1)[0]).sort(), ['code', 'method', 'ms', 'plugin', 't'], 'nothing else is kept');
  assert.equal(CALL_KEEP, 300);
  assert.deepEqual(createCallLog().recent(), []);
});

test('a call and a firing read as one line each', () => {
  assert.match(describeCall(call(1_800_000_000_000, 'tiempo', 'net.fetch', null, 120)), /tiempo · net\.fetch · ok · 120 ms/);
  assert.match(describeCall(call(1_800_000_000_000, 'tiempo', 'storage.set', 'E_QUOTA', 0)), /tiempo · storage\.set · E_QUOTA$/);
  assert.match(describeFiring({ t: 1_800_000_000_000, name: 'Noticias', ok: true, detail: '', channel: 'La 1' }), /regla «Noticias» \(La 1\) · hecho/);
  assert.match(describeFiring({ t: 1_800_000_000_000, name: 'X', ok: false, detail: 'sin canal', channel: '' }), /regla «X» · falló: sin canal/);
});

test('the three logs become one timeline, newest first, with the failures marked', () => {
  const logs = {
    events: [{ t: 3000, name: 'channel.changed', data: { id: 'la-1', name: 'La 1' } }],
    calls: [call(4000, 'tiempo', 'net.fetch'), call(2000, 'tiempo', 'storage.set', 'E_QUOTA')],
    rules: [{ t: 1000, name: 'Noticias', ok: false, detail: 'sin canal', channel: '' }],
  };
  const all = timeline(logs);
  assert.deepEqual(all.map((l) => [l.t, l.kind, l.bad]), [[4000, 'call', false], [3000, 'event', false], [2000, 'call', true], [1000, 'rule', true]]);
  assert.deepEqual(timeline(logs, { kind: 'call' }).map((l) => l.t), [4000, 2000]);
  assert.deepEqual(timeline(logs, { kind: 'event' }).map((l) => l.t), [3000]);
  assert.deepEqual(timeline(logs, { kind: 'rule' }).map((l) => l.t), [1000]);
  assert.deepEqual(timeline(logs, { text: 'e_quota' }).map((l) => l.t), [2000], 'a text filters, whatever the case');
  assert.deepEqual(timeline(logs, { text: 'la 1' }).map((l) => l.kind), ['event']);
  assert.deepEqual(timeline(logs, { limit: 2 }).map((l) => l.t), [4000, 3000]);
  assert.deepEqual(timeline({}), []);
  assert.deepEqual(Object.keys(KINDS), ['all', 'event', 'call', 'rule']);
});

test('what the MCP asks of the calls is answered by the page, with the plugin and the result in words, and needs no app', async () => {
  const log = createCallLog();
  log.add(call(1_800_000_000_000, 'a', 'player.state'));
  log.add(call(1_800_000_001_000, 'b', 'storage.set', 'E_QUOTA', 5));
  const host = { calls: (limit, plugin) => log.recent(limit, plugin) };
  const all = await runPluginCommand({ do: 'plugin_calls', limit: 10 }, undefined, host);
  assert.equal(all.ok, true);
  assert.deepEqual(all.data.calls.map((c) => [c.plugin, c.method, c.result]), [['b', 'storage.set', 'E_QUOTA'], ['a', 'player.state', 'ok']]);
  assert.deepEqual(Object.keys(all.data.calls[0]).sort(), ['at', 'method', 'ms', 'plugin', 'result']);
  assert.deepEqual((await runPluginCommand({ do: 'plugin_calls', limit: 10, id: 'a' }, undefined, host)).data.calls.length, 1);
  assert.match((await runPluginCommand({ do: 'plugin_calls' }, undefined, undefined)).detail, /aplicación de escritorio/);
});

test('the plugins with ganchos are described in one line: state, mistakes, why one was switched off, and the filters in use', () => {
  assert.equal(describeHooks(), 'Ningún plugin con ganchos.');
  assert.equal(
    describeHooks({
      plugins: [{ id: 'ads', state: 'on', errors: 0, error: '' }, { id: 'dev:uno', state: 'on', errors: 1, error: 'x' }, { id: 'dev:roto', state: 'failed', errors: 5, error: 'filter(ad.reaction): mal' }, { id: 'dev:fuera', state: 'off', errors: 0, error: '' }],
      chains: [{ name: 'ad.reaction', links: 3 }],
    }),
    'Plugins con ganchos: ads (activo) · dev:uno (activo, 1 fallo) · dev:roto (apagado por fallos, 5 fallos: filter(ad.reaction): mal) · dev:fuera (apagado). Filtros en uso: ad.reaction ×3.',
  );
  assert.equal(describeHooks({ chains: [{ name: 'f', links: 1 }] }), 'Plugins con ganchos: ninguno. Filtros en uso: f ×1.');
});
