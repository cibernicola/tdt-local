// The hooks of the page (lib/hooks.js) and the loader of the plugins with all the power (lib/trusted.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHub } from '../../tdtlocal/static/js/lib/events.js';
import { createHooks } from '../../tdtlocal/static/js/lib/hooks.js';
import { createLoader } from '../../tdtlocal/static/js/lib/trusted.js';

function make() {
  const errors = [];
  const hub = createHub({ onError: (name, error) => errors.push(['hub', name, error.message]) });
  const hooks = createHooks({ hub, onError: (name, error) => errors.push(['filter', name, error.message]) });
  return { hub, hooks, errors };
}

test('actions: heard in order of priority, then of arrival; the hub remembers them too', () => {
  const { hooks, hub } = make();
  const heard = [];
  hooks.on('ad.started', () => heard.push('b'), 20);
  hooks.on('ad.started', () => heard.push('a1'), 5);
  hooks.on('ad.started', () => heard.push('a2'), 5);
  hooks.on('ad.started', () => heard.push('default'));
  hooks.do('ad.started', { channel: 'la-1' });
  assert.deepEqual(heard, ['a1', 'a2', 'default', 'b']);
  assert.equal(hub.recent(1)[0].name, 'ad.started');
});

test('actions: a listener is given the data first, and the name of the event after it (also for a «*» listener)', () => {
  const { hooks } = make();
  const got = [];
  hooks.on('ad.started', (data, name) => got.push(['named', name, data.channel]));
  hooks.on('*', (data, name) => got.push(['all', name, data.channel]));
  hooks.do('ad.started', { channel: 'la-1' });
  assert.deepEqual(got, [['named', 'ad.started', 'la-1'], ['all', 'ad.started', 'la-1']]);
  assert.throws(() => hooks.on('x', 'no es una función'), TypeError);
});

test('actions: stopping puts it back as it was, and a listener that throws does not stop the others', () => {
  const { hooks, errors } = make();
  const heard = [];
  const off = hooks.on('x', () => heard.push(1));
  hooks.on('x', () => { throw new Error('malo'); });
  hooks.on('x', () => heard.push(3), 50);
  hooks.do('x');
  off();
  hooks.do('x');
  assert.deepEqual(heard, [1, 3, 3]);
  assert.deepEqual(errors.map((e) => e[2]), ['malo', 'malo']);
});

test('filters: the value goes through the chain in order; a link that returns nothing leaves it alone; one that throws is skipped', () => {
  const { hooks, errors } = make();
  hooks.filter('ad.reaction', (plan) => [...plan, 'late'], 30);
  hooks.filter('ad.reaction', (plan) => [...plan, 'first'], 1);
  hooks.filter('ad.reaction', () => undefined);
  hooks.filter('ad.reaction', () => { throw new Error('roto'); });
  hooks.filter('ad.reaction', (plan, ctx) => [...plan, ctx.channel]);
  assert.deepEqual(hooks.apply('ad.reaction', [], { channel: 'la-1' }), ['first', 'la-1', 'late']);
  assert.deepEqual(errors, [['filter', 'ad.reaction', 'roto']]);
  assert.equal(hooks.apply('nobody', 7), 7, 'a name nobody uses leaves the value as it is');
  assert.deepEqual(hooks.chains(), [{ name: 'ad.reaction', links: 5 }]);
});

test('registries: the lowest priority number wins, the last one on a tie, and taking it away brings back the one before', () => {
  const { hooks } = make();
  const offCore = hooks.register('players', 'hls', { who: 'core' });
  const offMine = hooks.register('players', 'hls', { who: 'mine' }); // same priority: the last one
  hooks.register('players', 'hls', { who: 'late' }, 99);
  assert.equal(hooks.get('players', 'hls').who, 'mine');
  const offFirst = hooks.register('players', 'hls', { who: 'first' }, 1);
  assert.equal(hooks.get('players', 'hls').who, 'first');
  offFirst();
  offMine();
  assert.equal(hooks.get('players', 'hls').who, 'core');
  offCore();
  assert.equal(hooks.get('players', 'hls').who, 'late');
  assert.equal(hooks.get('players', 'no'), undefined);
  assert.deepEqual(hooks.list('players').map((e) => [e.id, e.entry.who]), [['hls', 'late']]);
  assert.deepEqual(hooks.list('nothing'), []);
});

test('the loader: a plugin gets its own tdt, and taking it away removes everything it added, in reverse', async () => {
  const { hooks } = make();
  const loader = createLoader(hooks);
  const heard = [];
  assert.equal(await loader.load('mine', (tdt) => {
    assert.equal(tdt.id, 'mine');
    tdt.on('a', () => heard.push('a'));
    tdt.filter('f', (v) => v + 1);
    tdt.register('actions', 'beep', { run: () => 'beep' });
    return () => heard.push('cleanup');
  }), true);
  hooks.do('a');
  assert.equal(hooks.apply('f', 1), 2);
  assert.equal(hooks.get('actions', 'beep').run(), 'beep');
  assert.equal(loader.unload('mine'), true);
  hooks.do('a');
  assert.equal(hooks.apply('f', 1), 1);
  assert.equal(hooks.get('actions', 'beep'), undefined);
  assert.deepEqual(heard, ['a', 'cleanup']);
  assert.deepEqual(loader.list(), [{ id: 'mine', state: 'off', errors: 0, error: '' }]);
  assert.equal(loader.unload('mine'), false, 'already off');
});

test('the loader: a plugin that replaces a thing of the core, and gives it back when it goes', async () => {
  const { hooks } = make();
  const loader = createLoader(hooks);
  hooks.register('actions', 'beep', { run: () => 'core' });
  await loader.load('mine', (tdt) => { tdt.register('actions', 'beep', { run: () => 'mine' }); });
  assert.equal(hooks.get('actions', 'beep').run(), 'mine');
  loader.unload('mine');
  assert.equal(hooks.get('actions', 'beep').run(), 'core');
});

test('the loader: a mistake of a plugin does not reach the application; five and it is switched off, and the others go on', async () => {
  const { hooks } = make();
  const logged = [];
  const loader = createLoader(hooks, { log: (id, level, text) => logged.push(`${id}:${level}:${text}`) });
  await loader.load('bad', (tdt) => {
    tdt.filter('f', () => { throw new Error('mal'); });
    tdt.register('actions', 'boom', { run: () => { throw new Error('mal también'); } });
  });
  await loader.load('good', (tdt) => { tdt.filter('f', (v) => v * 2); });
  for (let i = 0; i < 3; i++) assert.equal(hooks.apply('f', 1), 2, 'the bad link is skipped and the good one works');
  assert.equal(hooks.get('actions', 'boom').run(), undefined, 'a guarded entry swallows the mistake');
  assert.equal(loader.list().find((p) => p.id === 'bad').state, 'on');
  hooks.get('actions', 'boom').run();
  assert.equal(loader.list().find((p) => p.id === 'bad').state, 'failed', 'the fifth mistake');
  assert.equal(hooks.get('actions', 'boom'), undefined, 'and what it added is gone');
  assert.equal(hooks.apply('f', 1), 2);
  assert.equal(loader.list().find((p) => p.id === 'good').state, 'on');
  assert.ok(logged.some((l) => /bad:ERROR:se apaga tras 5 fallos/.test(l)), logged.join('\n'));
});

test('the loader: a plugin that fails to start leaves nothing behind', async () => {
  const { hooks } = make();
  const loader = createLoader(hooks, { log: () => {} });
  const ok = await loader.load('broken', (tdt) => {
    tdt.filter('f', (v) => v + 100);
    throw new Error('no arranca');
  });
  assert.equal(ok, false);
  assert.equal(hooks.apply('f', 1), 1);
  assert.deepEqual(loader.list().map((p) => [p.id, p.state, p.error]), [['broken', 'failed', 'al arrancar: no arranca']]);
  assert.equal(await loader.load('broken', () => {}), true, 'it can be tried again');
});
