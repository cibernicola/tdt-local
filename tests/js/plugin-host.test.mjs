// What the page answers to the plugins with permissions (tdtlocal/static/js/lib/plugin-host.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PluginError, SILENT_MS, START_MS, check, clampSize, createLimiter, dispatch, epgNow, healthOf, newStats, permissionFor, record, searchChannels,
  stateKey, validateArgs,
} from '../../tdtlocal/static/js/lib/plugin-host.js';

const spec = JSON.parse(readFileSync(new URL('../../tdtlocal/static/plugin-api.json', import.meta.url), 'utf8'));

const channels = [
  { id: 'la1', name: 'La 1', kind: 'tv', category: 'Generalistas', sources: [{}], epg: 'la1.es' },
  { id: 'la2', name: 'La 2', kind: 'tv', category: 'Generalistas', sources: [{}] },
  { id: 'caido', name: 'La Caída', kind: 'tv', category: 'Generalistas', sources: [{}], ok: false },
  { id: 'rne', name: 'Radio Nacional', kind: 'radio', category: 'Radio', sources: [{}] },
  { id: 'sinfuente', name: 'La Sin Fuente', kind: 'tv', sources: [] },
  { id: 'mx', name: 'Teléfono', kind: 'tv', category: 'Otros', sources: [{}] },
];

function world() {
  const calls = [];
  const state = {
    channels, byId: new Map(channels.map((c) => [c.id, c])), kind: 'tv', mode: 'single', layout: 'mosaic', focus: 0,
    vol: { v: 1, m: false }, rot: { on: false, secs: 20 }, tiles: [{ i: 0, c: channels[0] }], u7d: null,
    epg: { now: { 'la1.es': [[100, 200, 'Informativo'], [200, 300, 'Serie']] }, updated: 1 },
  };
  const actions = {
    setKind: (k) => calls.push(['kind', k]),
    play: (c) => calls.push(['play', c.id]),
    multiWith: (cs, r) => calls.push(['multi', cs.map((c) => c.id), r]),
    setVolume: (v, m) => calls.push(['volume', v, m]),
  };
  const env = {
    spec, state, actions, now: () => 150,
    toast: (id, text) => calls.push(['toast', id, text]),
    resize: (id, w, h) => { calls.push(['resize', id, w, h]); return { width: w, height: h }; },
    desktop: async (id, method, args) => { calls.push(['desktop', id, method, args]); return { ok: true, result: 'hecho' }; },
  };
  return { calls, env, state };
}

const plugin = (...permissions) => ({ id: 'p', permissions });

const why = (fn) => { try { fn(); } catch (e) { return e; } return null; };

test('every method needs a permission the manifest can declare, or none', () => {
  assert.equal(why(() => check(plugin(), 'ui.resize', spec)), null);
  const denied = why(() => check(plugin(), 'player.state', spec));
  assert.ok(denied instanceof PluginError);
  assert.equal(denied.code, 'E_PERMISSION');
  assert.match(denied.message, /permiso denegado: player\.read.*falta en tdt\.permissions/);
  assert.equal(why(() => check(plugin('player.read'), 'player.state', spec)), null);
  assert.match(why(() => check(plugin('player.read'), 'player.play', spec)).message, /player\.control/);
  assert.match(why(() => check(plugin('storage'), 'net.fetch', spec)).message, /network/);
  assert.equal(why(() => check(plugin('network:a.com'), 'net.fetch', spec)), null);
  assert.equal(why(() => check(plugin(), 'sistema.formatear', spec)).code, 'E_UNSUPPORTED');
  assert.equal(why(() => check(plugin(), '__proto__', spec)).code, 'E_UNSUPPORTED');
  // a permission the user turned off says so, and is not the author's mistake
  const off = why(() => check({ id: 'p', permissions: [], denied: ['player.read'] }, 'player.state', spec));
  assert.match(off.message, /el usuario lo ha desactivado/);
  const offNet = why(() => check({ id: 'p', permissions: [], denied: ['network:a.com'] }, 'net.fetch', spec));
  assert.match(offNet.message, /el usuario lo ha desactivado/);
});

test('the specification is complete: every permission a method needs is described, and every method says what it is', () => {
  const described = new Set(Object.keys(spec.permissions).map((p) => (p.startsWith('network:') ? 'network' : p)));
  for (const [name, def] of Object.entries(spec.methods)) {
    const need = permissionFor(spec, name);
    assert.ok(need === null || described.has(need), `${name}: the permission ${need} is not in permissions`);
    assert.ok(def.since && def.doc && Array.isArray(def.args) && def.returns, `${name} lacks since, doc, args or returns`);
  }
  for (const [name, ev] of Object.entries(spec.events)) assert.ok(ev.permission === null || described.has(ev.permission), `event ${name}`);
  for (const risk of Object.values(spec.permissions).map((p) => p.risk)) assert.ok(['low', 'medium', 'high', 'critical'].includes(risk));
  for (const code of ['E_PERMISSION', 'E_INVALID', 'E_NOT_FOUND', 'E_UNSUPPORTED', 'E_UNAVAILABLE', 'E_RATE', 'E_QUOTA']) assert.ok(spec.errors[code], code);
});

test('the arguments are checked against the specification, with the message of each', () => {
  const args = (name) => spec.methods[name].args;
  const bad = (name, list) => why(() => validateArgs(args(name), list));
  assert.deepEqual(validateArgs(args('player.mute'), []), [true], 'a default');
  assert.deepEqual(validateArgs(args('player.mute'), [false]), [false]);
  assert.deepEqual(validateArgs(args('player.multi'), [['a'], null]), [['a'], null], 'a null where it is allowed');
  assert.deepEqual(validateArgs(args('channels.search'), []), ['', undefined]);
  assert.equal(bad('player.play', []).code, 'E_INVALID');
  assert.match(bad('player.play', ['   ']).message, /texto de hasta 200/);
  assert.match(bad('player.play', [42]).message, /texto/);
  assert.match(bad('player.play', ['x'.repeat(201)]).message, /texto/);
  assert.match(bad('player.play', [null]).message, /texto de hasta 200/, 'null is not a string');
  assert.match(bad('player.kind', ['u7d']).message, /"tv" o "radio"/);
  assert.match(bad('player.volume', [2]).message, /entre 0 y 1/);
  assert.match(bad('player.volume', [NaN]).message, /entre 0 y 1/);
  assert.match(bad('player.volume', ['alto']).message, /entre 0 y 1/);
  assert.match(bad('player.mute', ['si']).message, /true o false/);
  assert.match(bad('player.multi', [[], null]).message, /1 a 4/);
  assert.match(bad('player.multi', [['a', 2], null]).message, /1 a 4/, 'every item is checked');
  assert.match(bad('player.multi', [['a'], 7]).message, /10, 15, 20, 30, 45 o 60/);
  assert.match(bad('channels.search', [5]).message, /texto de hasta 200/);
  assert.match(bad('channels.search', ['x', [1]]).message, /objeto/);
  assert.match(bad('ui.toast', ['x'.repeat(161)]).message, /160/);
  assert.match(bad('ui.resize', [300]).message, /height/);
  assert.equal(bad('storage.get', []).code, 'E_INVALID');
});

test('a plugin that calls too fast is stopped, and the tokens come back with time', () => {
  let t = 0;
  const limiter = createLimiter({ capacity: 5, perSecond: 2 }, () => t);
  assert.deepEqual(Array.from({ length: 7 }, () => limiter.take()), [true, true, true, true, true, false, false]);
  t = 500; // half a second: one token
  assert.deepEqual([limiter.take(), limiter.take()], [true, false]);
  t = 60_000; // a long time: never more than the capacity
  assert.deepEqual(Array.from({ length: 7 }, () => limiter.take()), [true, true, true, true, true, false, false]);
  const real = createLimiter(spec.limits.rate);
  assert.equal(Array.from({ length: spec.limits.rate.capacity + 50 }, () => real.take()).filter(Boolean).length, spec.limits.rate.capacity);
});

test('the health of a frame comes from how long it has been silent', () => {
  const base = { mountedAt: 1000, lastPong: 1000 };
  assert.equal(healthOf({ ...base, now: 1000 + START_MS - 1, ready: false }), 'starting');
  assert.equal(healthOf({ ...base, now: 1000 + START_MS + 1, ready: false }), 'unresponsive', 'it never said hello');
  assert.equal(healthOf({ ...base, now: 1000 + SILENT_MS - 1, ready: true }), 'running');
  assert.equal(healthOf({ ...base, now: 1000 + SILENT_MS + 1, ready: true }), 'unresponsive');
  assert.equal(healthOf({ mountedAt: 1000, lastPong: 1000 + SILENT_MS, now: 1000 + SILENT_MS + 5000, ready: true }), 'running', 'a pong resets it');
  // a page that loaded but never loads the SDK cannot answer: it is running, not watched
  assert.equal(healthOf({ ...base, now: 1000 + START_MS * 5, ready: false, loaded: true }), 'running');
  assert.equal(healthOf({ ...base, now: 1000 + START_MS * 5, ready: false, loaded: false }), 'unresponsive', 'it never even loaded');
});

test('what each plugin does is counted', () => {
  const stats = newStats();
  record(stats, 'player.state', null, 10);
  record(stats, 'player.state', null, 20);
  record(stats, 'player.play', 'E_PERMISSION', 30);
  record(stats, 'player.play', 'E_RATE', 40);
  record(stats, 'epg.now', 'E_NOT_FOUND', 50);
  assert.deepEqual(stats, { calls: 5, errors: 3, denied: 1, limited: 1, restarts: 0, wakes: 0, lastCallAt: 50, methods: { 'player.state': 2, 'player.play': 2, 'epg.now': 1 } });
});

test('a plugin that may read hears the state, and one that may not is refused', async () => {
  const { env } = world();
  const s = await dispatch(plugin('player.read'), 'player.state', [], env);
  assert.equal(s.kind, 'tv');
  assert.deepEqual(s.tiles.map((t) => t.name), ['La 1']);
  await assert.rejects(dispatch(plugin(), 'player.state', [], env), (e) => e.code === 'E_PERMISSION' && /permiso denegado/.test(e.message));
});

test('control methods validate what they are given and go through the same commands as the control bus', async () => {
  const { env, calls } = world();
  const p = plugin('player.control');
  assert.equal(await dispatch(p, 'player.play', ['La 2'], env), 'La 2');
  assert.deepEqual(calls.at(-1), ['play', 'la2']);
  await assert.rejects(dispatch(p, 'player.play', ['No existe'], env), (e) => e.code === 'E_NOT_FOUND' && /no hay ningún canal/.test(e.message));
  await assert.rejects(dispatch(p, 'player.play', [42], env), /texto/);
  await assert.rejects(dispatch(p, 'player.play', ['x'.repeat(300)], env), /texto/);
  await dispatch(p, 'player.kind', ['radio'], env);
  await assert.rejects(dispatch(p, 'player.kind', ['u7d'], env), /tv.*radio/);
  await dispatch(p, 'player.volume', [0.5], env);
  assert.deepEqual(calls.at(-1), ['volume', 0.5, false]);
  await assert.rejects(dispatch(p, 'player.volume', [2], env), /entre 0 y 1/);
  await assert.rejects(dispatch(p, 'player.volume', ['alto'], env), /entre 0 y 1/);
  await dispatch(p, 'player.mute', [], env);
  assert.deepEqual(calls.at(-1), ['volume', 1, true]);
  await dispatch(p, 'player.mute', [false], env);
  assert.deepEqual(calls.at(-1), ['volume', 1, false]);
  await dispatch(p, 'player.multi', [['La 1', 'La 2'], 30], env);
  assert.deepEqual(calls.at(-1), ['multi', ['la1', 'la2'], 30]);
  await assert.rejects(dispatch(p, 'player.multi', [[], 30], env), /1 a 4/);
  await assert.rejects(dispatch(p, 'player.multi', [['a', 'b', 'c', 'd', 'e']], env), /1 a 4/);
  await assert.rejects(dispatch(p, 'player.multi', [['La 1'], 7], env), /segundos/);
});

test('channel search finds playable channels, ignores accents and caps the answer', () => {
  const { state } = world();
  assert.deepEqual(searchChannels(state, 'la', {}).channels.map((c) => c.id), ['la1', 'la2']);
  assert.deepEqual(searchChannels(state, 'telefono', {}).channels.map((c) => c.id), ['mx']);
  assert.deepEqual(searchChannels(state, '', { kind: 'radio' }).channels.map((c) => c.id), ['rne']);
  assert.deepEqual(searchChannels(state, 'generalistas', { limit: 1 }).channels.map((c) => c.id), ['la1']);
  assert.equal(searchChannels(state, 'generalistas', { limit: 1 }).total, 2);
  assert.equal(searchChannels(state, '', { limit: 9999 }).channels.length, 4);
  assert.equal(searchChannels(state, 'La 1', {}).channels[0].hasGuide, true);
  assert.ok(!JSON.stringify(searchChannels(state, '', {})).includes('sources'));
});

test('the guide says what is on and what comes next', async () => {
  const { state, env } = world();
  assert.deepEqual(epgNow(state, 'La 1', 150), { channel: 'La 1', now: { start: 100, end: 200, title: 'Informativo' }, next: { start: 200, end: 300, title: 'Serie' } });
  assert.deepEqual(epgNow(state, 'la1', 50), { channel: 'La 1', now: null, next: { start: 100, end: 200, title: 'Informativo' } });
  assert.deepEqual(epgNow(state, 'La 2', 150), { channel: 'La 2', now: null, next: null });
  assert.throws(() => epgNow(state, 'nada', 150), (e) => e.code === 'E_NOT_FOUND');
  assert.equal((await dispatch(plugin('epg.read'), 'epg.now', ['La 1'], env)).now.title, 'Informativo');
});

test('toasts, resizing and the things that belong to the app', async () => {
  const { env, calls } = world();
  await dispatch(plugin('ui.toast'), 'ui.toast', ['Hola'], env);
  assert.deepEqual(calls.at(-1), ['toast', 'p', 'Hola']);
  await assert.rejects(dispatch(plugin('ui.toast'), 'ui.toast', ['x'.repeat(200)], env), /texto/);
  await assert.rejects(dispatch(plugin(), 'ui.toast', ['Hola'], env), /permiso denegado: ui\.toast/);
  await dispatch(plugin(), 'ui.resize', [300, 200], env);
  assert.deepEqual(calls.at(-1), ['resize', 'p', 300, 200]);
  assert.equal(await dispatch(plugin('storage'), 'storage.set', ['k', 1], env), 'hecho');
  assert.deepEqual(calls.at(-1), ['desktop', 'p', 'storage.set', ['k', 1]]);
  await assert.rejects(dispatch(plugin(), 'storage.get', ['k'], env), /permiso denegado: storage/);
  env.desktop = async () => ({ ok: false, error: 'permiso denegado: network:b.com', code: 'E_PERMISSION' });
  await assert.rejects(dispatch(plugin('network:a.com'), 'net.fetch', ['https://b.com/'], env), (e) => e.code === 'E_PERMISSION' && /network:b\.com/.test(e.message));
  env.desktop = async () => null;
  await assert.rejects(dispatch(plugin('storage'), 'storage.get', ['k'], env), (e) => e.code === 'E_UNAVAILABLE' && /no ha respondido/.test(e.message));
});

test('the state key changes when something the plugins can read changes', () => {
  const { state } = world();
  const before = stateKey(state);
  assert.equal(stateKey(state), before);
  state.vol = { v: 0.4, m: false };
  assert.notEqual(stateKey(state), before);
});

test('a panel asks for a size and keeps inside the limits', () => {
  assert.deepEqual(clampSize(10, 5000), { width: 240, height: 800 });
  assert.deepEqual(clampSize(300.4, 200), { width: 300, height: 200 });
  assert.deepEqual(clampSize('x', 200), { width: null, height: 200 });
});
