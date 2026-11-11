// Services that sleep until their moment: what the manifest may ask for, who is woken by what, and when a service goes back to sleep.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ACTIVATION, readActivation, readUiPlugin } from '../../desktop/lib/plugin-api.js';
import { IDLE_MS, MAX_PENDING, isIdle, sleeps, wakingFor } from '../../tdtlocal/static/js/lib/plugin-host.js';

test('a manifest says when a plugin without a panel has to run, and a wrong entry is said in words', () => {
  assert.deepEqual(readActivation(undefined, false), { list: [], problems: [] });
  assert.deepEqual(readActivation(['onEvent:channel.changed', 'onTime:21:30', 'onEvent:channel.changed'], false).list, ['onEvent:channel.changed', 'onTime:21:30'], 'no repeats');
  assert.deepEqual(readActivation(['onStartup'], false).list, ['onStartup']);
  for (const wrong of ['onEvent:', 'onTime:25:00', 'onTime:9:00', 'onSchedule:*/5m', 'onEvent:Channel', 'siempre', 5, null]) {
    const r = readActivation([wrong], false);
    assert.equal(r.list.length, 0, String(wrong));
    assert.match(r.problems[0], /no vale|onStartup/, String(wrong));
  }
  assert.match(readActivation('onStartup', false).problems[0], /lista/);
  assert.match(readActivation(Array.from({ length: MAX_ACTIVATION + 1 }, () => 'onStartup'), false).problems[0], /lista/);
  assert.match(readActivation(['onStartup'], true).problems[0], /sin panel/, 'a panel is always seen');
  assert.deepEqual(readActivation([], true), { list: [], problems: [] });
});

test('the manifest of a plugin carries its activation', () => {
  const read = (tdt) => readUiPlugin({ name: 'S', tdt: { api: 1, ...tdt } }, '/x', { id: 's', name: 'S', problems: [] }, () => true);
  assert.deepEqual(read({ activation: ['onEvent:programme.started'], permissions: ['epg.read'] }).activation, ['onEvent:programme.started']);
  assert.deepEqual(read({}).activation, []);
  assert.ok(read({ activation: ['onEvent:x y'] }).problems.some((p) => /activation/.test(p)));
  assert.ok(read({ panel: true, activation: ['onStartup'] }).problems.some((p) => /sin panel/.test(p)));
});

test('only a service that asked to wait sleeps: with a panel, without a list, or with onStartup it runs from the start', () => {
  assert.equal(sleeps({ activation: ['onEvent:channel.changed'] }), true);
  assert.equal(sleeps({ activation: ['onTime:21:00'] }), true);
  assert.equal(sleeps({ activation: ['onStartup', 'onEvent:channel.changed'] }), false);
  assert.equal(sleeps({ activation: [] }), false);
  assert.equal(sleeps({}), false);
  assert.equal(sleeps({ panel: { width: 1 }, activation: ['onEvent:channel.changed'] }), false);
});

test('an event or a minute wakes up the services that asked for it, and only them', () => {
  const plugins = [
    { id: 'a', activation: ['onEvent:channel.changed'] },
    { id: 'b', activation: ['onTime:21:00'] },
    { id: 'c', activation: ['onEvent:programme.started', 'onTime:21:00'] },
    { id: 'd', activation: [] },
    { id: 'e', activation: ['onStartup'] },
  ];
  assert.deepEqual(wakingFor(plugins, { event: 'channel.changed' }).map((p) => p.id), ['a']);
  assert.deepEqual(wakingFor(plugins, { event: 'programme.started' }).map((p) => p.id), ['c']);
  assert.deepEqual(wakingFor(plugins, { minute: '21:00' }).map((p) => p.id), ['b', 'c']);
  assert.deepEqual(wakingFor(plugins, { minute: '21:01' }), []);
  assert.deepEqual(wakingFor(plugins, { event: 'volume.changed' }), []);
});

test('a service goes back to sleep after a minute without anything to do, and not before', () => {
  const t = 1_000_000;
  assert.equal(isIdle(t, t + IDLE_MS), false);
  assert.equal(isIdle(t, t + IDLE_MS + 1), true);
  assert.equal(IDLE_MS, 60000);
  assert.ok(MAX_PENDING >= 5 && MAX_PENDING <= 100, 'a frame that starts keeps a few events, not all of them');
});
