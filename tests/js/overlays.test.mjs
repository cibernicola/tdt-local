// The slot «tile.overlay» (static/js/lib/overlays.js): what a plugin puts over a tile, when it is asked, updated and taken away. No browser: the element and the container are fakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHooks } from '../../tdtlocal/static/js/lib/hooks.js';
import { createHub } from '../../tdtlocal/static/js/lib/events.js';
import { createLoader } from '../../tdtlocal/static/js/lib/trusted.js';
import { createOverlays } from '../../tdtlocal/static/js/lib/overlays.js';

const fakeElement = (name) => ({ nodeType: 1, name, removed: false, remove() { this.removed = true; container.items = container.items.filter((x) => x !== this); } });
const container = { items: [], append(el) { this.items.push(el); } };
const names = () => container.items.map((e) => e.name);

function world({ onError } = {}) {
  container.items = [];
  const hub = createHub();
  const hooks = createHooks({ hub });
  const state = { index: 2, focus: true, channel: { id: 'la-1', name: 'La 1', kind: 'tv' }, mode: 'multi' };
  const context = () => ({ tile: { index: state.index, focus: state.focus, channel: state.channel }, mode: state.mode });
  const errors = [];
  const overlays = createOverlays({ list: () => hooks.list('tile.overlay'), container, context, onError: onError || ((id, e) => errors.push([id, e.message])) });
  hooks.watch('tile.overlay', () => overlays.refresh());
  return { hooks, overlays, state, errors, loader: createLoader(hooks, { log: () => {} }) };
}

test('the registry tells who listens when something is added or taken away, and a listener that throws does not stop the others', () => {
  const hub = createHub();
  const hooks = createHooks({ hub });
  const seen = [];
  const off = hooks.watch('tile.overlay', () => seen.push('a'));
  hooks.watch('tile.overlay', () => { throw new Error('malo'); });
  hooks.watch('tile.overlay', () => seen.push('c'));
  const undo = hooks.register('tile.overlay', 'x', { mount() {} });
  undo();
  assert.deepEqual(seen, ['a', 'c', 'a', 'c']);
  off();
  hooks.register('tile.overlay', 'y', { mount() {} });
  assert.deepEqual(seen, ['a', 'c', 'a', 'c', 'c']);
  hooks.register('otra', 'z', {});
  assert.equal(seen.length, 5, 'only the registry it watches');
});

test('an overlay is mounted on the tile with what is known about it, and goes away when its registration does', () => {
  const w = world();
  let got = null;
  const off = w.hooks.register('tile.overlay', 'reloj', { mount: (ctx) => { got = ctx; return fakeElement('reloj'); } });
  assert.deepEqual(names(), ['reloj']);
  assert.deepEqual(got, { tile: { index: 2, focus: true, channel: { id: 'la-1', name: 'La 1', kind: 'tv' } }, mode: 'multi' });
  off();
  assert.deepEqual(names(), []);
  assert.deepEqual(w.overlays.ids(), []);
});

test('a handle {el, update, destroy}: it is updated when the tile changes and destroyed when it goes', () => {
  const w = world();
  const calls = [];
  w.hooks.register('tile.overlay', 'cartel', { mount: () => ({ el: fakeElement('cartel'), update: (ctx) => calls.push(['update', ctx.tile.channel && ctx.tile.channel.name]), destroy: () => calls.push(['destroy']) }) });
  w.state.channel = { id: 'la-2', name: 'La 2', kind: 'tv' };
  w.overlays.refresh();
  w.state.channel = null;
  w.overlays.refresh();
  assert.deepEqual(calls.filter((c) => c[0] === 'update').map((c) => c[1]), ['La 1', 'La 2', null], 'told when it is mounted and at each change');
  w.overlays.clear();
  assert.deepEqual(calls.at(-1), ['destroy']);
  assert.deepEqual(names(), []);
});

test('an overlay that does not want this tile is asked again when something changes', () => {
  const w = world();
  w.state.focus = false;
  w.hooks.register('tile.overlay', 'solo-activa', { mount: (ctx) => (ctx.tile.focus ? fakeElement('solo-activa') : undefined) });
  assert.deepEqual(names(), []);
  w.state.focus = true;
  w.overlays.refresh();
  assert.deepEqual(names(), ['solo-activa']);
  w.overlays.refresh();
  assert.deepEqual(names(), ['solo-activa'], 'it is not mounted twice');
});

test('one registered with the same id replaces the other, and the first comes back when it goes', () => {
  const w = world();
  w.hooks.register('tile.overlay', 'marco', { mount: () => fakeElement('de-la-aplicacion') });
  const off = w.hooks.register('tile.overlay', 'marco', { mount: () => fakeElement('del-plugin') });
  assert.deepEqual(names(), ['del-plugin']);
  off();
  assert.deepEqual(names(), ['de-la-aplicacion']);
});

test('a plugin that is switched off takes its overlays with it, and one that throws in mount is skipped and counted', () => {
  const w = world();
  return (async () => {
    await w.loader.load('capa', (tdt) => {
      tdt.register('tile.overlay', 'uno', { mount: () => fakeElement('uno') });
      tdt.register('tile.overlay', 'roto', { mount: () => { throw new Error('fallo al montar'); } });
    });
    assert.deepEqual(names(), ['uno'], 'the broken one is skipped and the other stays (the loader swallowed the mistake and counted it)');
    assert.equal(w.loader.list()[0].errors >= 1, true);
    w.loader.unload('capa');
    assert.deepEqual(names(), []);
  })();
});

test('a handle that throws in update or destroy does not break the others, and is told', () => {
  const w = world();
  w.hooks.register('tile.overlay', 'malo', { mount: () => ({ el: fakeElement('malo'), update: () => { throw new Error('u'); }, destroy: () => { throw new Error('d'); } }) });
  w.hooks.register('tile.overlay', 'bueno', { mount: () => fakeElement('bueno') });
  w.overlays.refresh();
  w.overlays.clear();
  const told = w.errors.map((e) => e[0] + ':' + e[1]);
  assert.ok(told.length >= 2 && told.slice(0, -1).every((t) => t === 'malo:update: u') && told.at(-1) === 'malo:destroy: d', told.join(' | ')); // every refresh tells it again
  assert.deepEqual(names(), [], 'both were taken away anyway');
});

test('what mount returns that is not an element is ignored, and an entry without mount is too', () => {
  const w = world();
  w.hooks.register('tile.overlay', 'numero', { mount: () => 5 });
  w.hooks.register('tile.overlay', 'cadena', { mount: () => 'hola' });
  w.hooks.register('tile.overlay', 'sin-mount', {});
  w.hooks.register('tile.overlay', 'nulo', null);
  w.overlays.refresh();
  assert.deepEqual(names(), []);
  assert.deepEqual(w.errors, []);
});
