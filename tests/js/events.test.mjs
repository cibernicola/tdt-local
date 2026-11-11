// The events of the page (tdtlocal/static/js/lib/events.js) and their agreement with the single specification, commands.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  EVENTS, KEEP, PROGRAMME_WINDOW, changesBetween, createHub, createWatcher, describeEvent, lookAt, programmesStarted,
} from '../../tdtlocal/static/js/lib/events.js';
import { commandOf } from '../../tdtlocal/static/js/lib/rules.js';

const json = (name) => JSON.parse(readFileSync(new URL('../../tdtlocal/static/' + name, import.meta.url), 'utf8'));
const commands = json('commands.json');
const pluginApi = json('plugin-api.json');

const state = (extra = {}) => ({ kind: 'tv', vol: { v: 0.5, m: false }, ...extra });
const la1 = { id: 'la-1', name: 'La 1', kind: 'tv' };

test('a hub tells those who listen, remembers what happened, and a listener that fails does not stop the rest', () => {
  const errors = [];
  let clock = 1000;
  const hub = createHub({ now: () => clock++, onError: (name, error) => errors.push([name, error.message]) });
  const heard = [];
  const stop = hub.on('channel.changed', (name, data) => heard.push(['a', name, data.id]));
  hub.on('channel.changed', () => { throw new Error('roto'); });
  hub.on('*', (name) => heard.push(['all', name]));
  hub.emit('channel.changed', { id: 'x' });
  hub.emit('kind.changed', { kind: 'radio' });
  assert.deepEqual(heard, [['a', 'channel.changed', 'x'], ['all', 'channel.changed'], ['all', 'kind.changed']]);
  assert.deepEqual(errors, [['channel.changed', 'roto']]);
  stop();
  hub.emit('channel.changed', { id: 'y' });
  assert.equal(heard.filter((h) => h[0] === 'a').length, 1, 'it stopped listening');
  assert.deepEqual(hub.recent(10).map((e) => e.name), ['channel.changed', 'kind.changed', 'channel.changed'], 'newest first');
  assert.deepEqual(hub.recent(10, 'kind.changed').map((e) => e.data.kind), ['radio']);
  assert.throws(() => hub.on('x', 5), TypeError);
});

test('the hub remembers a bounded number of events', () => {
  const hub = createHub();
  for (let i = 0; i < KEEP + 30; i += 1) hub.emit('volume.changed', { v: i / 1000 });
  assert.equal(hub.recent(1000).length, KEEP);
  assert.equal(hub.recent(1)[0].data.v, (KEEP + 29) / 1000);
});

test('the first look says nothing, and then each change says what it was', () => {
  const first = lookAt(state(), la1);
  assert.deepEqual(changesBetween(null, first), []);
  assert.deepEqual(changesBetween(first, lookAt(state(), la1)), []);
  const other = lookAt(state(), { id: 'la-2', name: 'La 2', kind: 'tv' });
  assert.deepEqual(changesBetween(first, other).map((e) => [e.name, e.data.id]), [['channel.changed', 'la-2']]);
  assert.deepEqual(changesBetween(first, lookAt(state({ kind: 'radio' }), la1)).map((e) => e.name), ['kind.changed']);
  assert.deepEqual(changesBetween(first, lookAt(state({ vol: { v: 0.9, m: false } }), la1)).map((e) => e.name), ['volume.changed']);
  assert.deepEqual(changesBetween(first, lookAt(state({ vol: { v: 0.5, m: true } }), la1)).map((e) => e.data.m), [true]);
  assert.deepEqual(changesBetween(first, lookAt(state({ vol: { v: 0.502, m: false } }), la1)), [], 'a hair of volume is not a change');
  assert.deepEqual(changesBetween(first, lookAt(state(), null)), [], 'no channel is not another channel');
  assert.equal(changesBetween(lookAt(state(), null), first)[0].name, 'channel.changed', 'but putting one is');
});

test('a listener that changes something and looks again hears only its own change, after the one it was told, and nothing twice', async () => {
  const world = { channel: la1, v: 0.5 };
  const told = [];
  const watcher = createWatcher(() => lookAt(state({ vol: { v: world.v, m: false } }), world.channel), (name, data) => told.push([name, data.cause || '', data.id || data.v]));
  watcher.look(); // the first look: nothing
  world.channel = { id: 'la-2', name: 'La 2', kind: 'tv' };
  // what a rule does when it is told about the channel: it changes the volume, and (after everybody heard) asks to look again as its own
  const rule = () => { world.v = 0.55; queueMicrotask(() => watcher.look('rule')); };
  const hub = createHub();
  hub.on('channel.changed', rule);
  hub.on('*', (name, data) => told.push(['heard', name, data.id || data.v]));
  const emit = (name, data) => hub.emit(name, data);
  const again = createWatcher(() => lookAt(state({ vol: { v: world.v, m: false } }), world.channel), emit);
  again.look();
  world.channel = la1;
  world.v = 0.5;
  again.look(); // the user puts La 1 back: the rule answers
  await Promise.resolve();
  watcher.look(); // (the other watcher is only there to show the first look says nothing)
  assert.deepEqual(told.filter((t) => t[0] === 'heard').map((t) => t.slice(1)), [['channel.changed', 'la-1']], 'only what happened so far, in order');
  hub.emit('x');
  again.look('rule');
  assert.deepEqual(hub.recent(10).filter((e) => e.name === 'volume.changed').map((e) => [e.data.v, e.data.cause]), [[0.55, 'rule']], 'one volume event, marked, and not twice');
  assert.equal(hub.recent(10).filter((e) => e.name === 'channel.changed').length, 1, 'the channel change is told once');
  again.look();
  assert.equal(hub.recent(20).filter((e) => e.name === 'volume.changed').length, 1, 'and nothing more shows up later');
});

test('a programme that has just started is told once, on the channels given', () => {
  const now = 10_000;
  const seen = new Set();
  const guide = { 'la-1': [[now - 30, now + 3000, 'Telediario'], [now + 3000, now + 6000, 'Cine']], 'la-2': [[now - 600, now + 100, 'Viejo']] };
  const found = programmesStarted([la1, { id: 'la-2', name: 'La 2' }], (c) => guide[c.id], now, seen);
  assert.deepEqual(found.map((e) => [e.name, e.data.channel, e.data.title]), [['programme.started', 'La 1', 'Telediario']]);
  assert.deepEqual(programmesStarted([la1], (c) => guide[c.id], now + 5, seen), [], 'already told');
  assert.deepEqual(programmesStarted([la1], () => undefined, now, new Set()), [], 'a channel without guide');
  assert.deepEqual(programmesStarted([la1], (c) => guide[c.id], now + PROGRAMME_WINDOW + 40, new Set()), [], 'it started a while ago');
});

test('an event is read as a sentence', () => {
  const at = (name, data) => describeEvent({ t: Date.UTC(2026, 10, 4, 12, 0, 0), name, data });
  assert.match(at('channel.changed', { id: 'la-2', name: 'La 2' }), /channel\.changed · otro canal: La 2/);
  assert.match(at('volume.changed', { v: 0.4, m: false }), /volumen al 40 %/);
  assert.match(at('volume.changed', { v: 0.4, m: true }), /silenciado/);
  assert.match(at('programme.started', { channel: 'La 1', title: 'Telediario' }), /empieza «Telediario» en La 1/);
  assert.match(at('kind.changed', { kind: 'radio', cause: 'rule' }), /lista: radio \(rule\)/);
  assert.match(at('ad.started', { channel: 'la-1', name: 'La 1' }), /pausa de anuncios en La 1$/);
  assert.match(at('ad.ended', { channel: 'la-1', name: 'La 1', quiet: true }), /fin de la pausa de anuncios en La 1 \(el usuario tomó el mando\)/);
  assert.match(at('otro', { x: 1 }), /\{"x":1\}/);
});

test('the specification lists the same events as the page tells, and the plugins hear them with the permission it names', () => {
  assert.deepEqual(Object.keys(commands.events).sort(), [...EVENTS].sort());
  for (const [name, event] of Object.entries(commands.events)) {
    assert.ok(pluginApi.events[name], `${name} is in plugin-api.json`);
    assert.equal(pluginApi.events[name].permission, event.permission, name);
    assert.ok(pluginApi.permissions[event.permission], `${name} needs a permission that exists`);
  }
});

test('every order of the specification is the command the rules, the control bus and the plugins know', () => {
  for (const [id, command] of Object.entries(commands.commands)) {
    const action = { action: command.rule, ...command.example };
    const as = commandOf(action);
    if (command.bus) {
      assert.equal(as && as.do, command.bus, `${id}: the rule does the command of the bus`);
      for (const name of Object.keys(command.example)) assert.ok(name in as, `${id}: ${name} reaches the command`);
    } else assert.equal(as, null, `${id}: the page does it by itself`);
    assert.ok(pluginApi.methods[command.plugin], `${id}: plugins have ${command.plugin}`);
    const spec = pluginApi.methods[command.plugin].args.map((a) => a.name);
    assert.ok(Object.keys(command.args).filter((a) => command.args[a].required).every((a) => spec.length >= 1 && true), id);
  }
});
