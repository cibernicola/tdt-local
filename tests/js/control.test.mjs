// What the page does for the control bus (tdtlocal/static/js/lib/control.js): the snapshot and the commands.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTROL_INTRO, badgeText, badgeTitle, describeControl, describeHeaderChanges, describeUse, isDevCommand, isHeadersCommand, isPluginCommand,
  mergeRuntime, resolveAnyChannel, resolveChannel, runCommand, runDevCommand, runHeadersCommand, runPluginCommand,
  snapshotOf,
} from '../../tdtlocal/static/js/lib/control.js';

const channel = (id, name, kind = 'tv', extra = {}) => ({ id, name, kind, sources: ['http://x/' + id], ...extra });

function world() {
  const channels = [channel('a', 'La 1'), channel('b', 'La 2'), channel('r', 'Radio Nacional', 'radio'), channel('d', 'Caído', 'tv', { ok: false }),
    channel('u', 'Programa', 'u7d'), channel('s', 'Sin fuentes', 'tv', { sources: [] })];
  const calls = [];
  const state = {
    channels, byId: new Map(channels.map((c) => [c.id, c])), kind: 'tv', mode: 'single', layout: 'mosaic', focus: 0,
    vol: { v: 0.8, m: false }, rot: { on: false, secs: 20 }, u7d: null,
    tiles: [{ i: 0, c: channels[0] }, { i: 1, c: null }, { i: 2, c: channels[2] }, { i: 3 }],
  };
  const actions = {
    setKind: (k) => calls.push(['kind', k]),
    play: (c) => calls.push(['play', c.id]),
    multiWith: (chs, rotate) => calls.push(['multi', chs.map((c) => c.id), rotate]),
    setVolume: (v, m) => calls.push(['volume', v, m]),
  };
  return { state, actions, calls };
}

test('the snapshot tells what is on and nothing else', () => {
  const { state } = world();
  const snap = snapshotOf(state);
  assert.deepEqual(snap.tiles, [
    { slot: 0, id: 'a', name: 'La 1', kind: 'tv' },
    { slot: 2, id: 'r', name: 'Radio Nacional', kind: 'radio' },
  ]);
  assert.deepEqual(snap.vol, { v: 0.8, m: false });
  assert.deepEqual([snap.kind, snap.mode, snap.layout, snap.focus], ['tv', 'single', 'mosaic', 0]);
  assert.equal(snap.u7d, null);
  assert.ok(!JSON.stringify(snap).includes('http://'), 'no stream addresses');
  assert.deepEqual(snapshotOf({ ...state, u7d: { c: { name: 'La 1' } } }).u7d, { channel: 'La 1' });
});

test('a channel is found by id or by name, and only if it can be played', () => {
  const { state } = world();
  assert.equal(resolveChannel(state, 'a').id, 'a');
  assert.equal(resolveChannel(state, 'La 2').id, 'b');
  assert.equal(resolveChannel(state, 'la 2').id, 'b');
  assert.equal(resolveChannel(state, 'Radio Nacional').id, 'r');
  for (const ref of ['d', 'Caído', 'u', 's', 'Inexistente', '']) assert.equal(resolveChannel(state, ref), null, ref);
});

test('play: switches the list if the channel is in the other one, then plays it', () => {
  const { state, actions, calls } = world();
  assert.deepEqual(runCommand({ do: 'play', channel: 'La 2' }, state, actions), { ok: true, detail: 'La 2' });
  assert.deepEqual(calls, [['play', 'b']]);
  calls.length = 0;
  assert.equal(runCommand({ do: 'play', channel: 'r' }, state, actions).ok, true);
  assert.deepEqual(calls, [['kind', 'radio'], ['play', 'r']]);
});

test('play of a channel that does not exist or cannot be played says so and does nothing', () => {
  const { state, actions, calls } = world();
  for (const channel of ['Nada', 'd', 'u']) {
    const r = runCommand({ do: 'play', channel }, state, actions);
    assert.equal(r.ok, false);
    assert.match(r.detail, /no hay ningún canal/);
  }
  assert.deepEqual(calls, []);
});

test('kind, volume and mute', () => {
  const { state, actions, calls } = world();
  assert.equal(runCommand({ do: 'kind', kind: 'radio' }, state, actions).ok, true);
  assert.equal(runCommand({ do: 'volume', value: 0.25 }, state, actions).detail, '25 %');
  assert.equal(runCommand({ do: 'mute', on: true }, state, actions).detail, 'silenciado');
  assert.equal(runCommand({ do: 'mute', on: false }, state, actions).detail, 'con sonido');
  assert.deepEqual(calls, [['kind', 'radio'], ['volume', 0.25, false], ['volume', 0.8, true], ['volume', 0.8, false]]);
});

test('multi puts the channels in the tiles, with the rotation if asked, and refuses if one is missing', () => {
  const { state, actions, calls } = world();
  assert.equal(runCommand({ do: 'multi', channels: ['La 1', 'b'], rotate: 30 }, state, actions).detail, 'La 1, La 2');
  assert.deepEqual(calls, [['multi', ['a', 'b'], 30]]);
  calls.length = 0;
  assert.equal(runCommand({ do: 'multi', channels: ['La 1'], rotate: null }, state, actions).ok, true);
  assert.deepEqual(calls, [['multi', ['a'], null]]);
  calls.length = 0;
  const r = runCommand({ do: 'multi', channels: ['La 1', 'Nada'] }, state, actions);
  assert.equal(r.ok, false);
  assert.match(r.detail, /«Nada»/);
  assert.deepEqual(calls, []); // nothing was done with half of it
  assert.equal(runCommand({ do: 'multi', channels: [] }, state, actions).ok, false);
});

test('an unknown command, or an action that throws, is an answer and not an exception', () => {
  const { state, actions } = world();
  assert.deepEqual(runCommand({ do: 'format' }, state, actions), { ok: false, detail: 'orden desconocida' });
  assert.deepEqual(runCommand(null, state, actions), { ok: false, detail: 'orden desconocida' });
  const r = runCommand({ do: 'kind', kind: 'tv' }, state, { ...actions, setKind: () => { throw new Error('boom'); } });
  assert.deepEqual(r, { ok: false, detail: 'error: boom' });
});

test('the badge shows only while the access is on and a client asked recently', () => {
  assert.equal(badgeText(null), '');
  assert.equal(badgeText({ enabled: false, client_recent: true }), '');
  assert.equal(badgeText({ enabled: true, client_recent: false }), '');
  assert.equal(badgeText({ enabled: true, client_recent: true }), 'IA conectada');
  assert.equal(badgeTitle({ audit: [] }), 'Una IA tiene acceso a TDT local');
  assert.match(badgeTitle({ audit: [{ t: 1_700_000_000, text: 'play: hecho' }] }), /play: hecho/);
});

test('the settings tab says where it stands and how a client connects', () => {
  assert.match(describeControl(null), /Apagado/);
  assert.match(describeControl({ enabled: false }), /Apagado/);
  assert.equal(describeControl({ enabled: true, level: 'read', page_connected: false, client_recent: false }),
    'Encendido, nivel «solo leer». La ventana todavía no se ha conectado.');
  assert.match(describeControl({ enabled: true, level: 'control', page_connected: true, client_recent: true }),
    /leer y controlar.*La ventana está conectada.*Una IA ha pedido algo/);
  assert.match(describeUse('http://127.0.0.1:8790'), /127\.0\.0\.1:8790\/api\/control\/v1\/command/);
  assert.match(CONTROL_INTRO, /apagado por defecto/i);
  assert.match(CONTROL_INTRO, /instrucciones/);
});

test('the commands about development plugins are told apart from the ones of the page', () => {
  for (const cmd of ['dev_list', 'dev_read', 'dev_write', 'dev_logs', 'dev_activate']) assert.equal(isDevCommand({ do: cmd }), true, cmd);
  for (const cmd of [{ do: 'play' }, { do: 'device' }, { do: 5 }, {}, null, undefined, 'dev_list']) assert.equal(isDevCommand(cmd), false, String(cmd));
});

test('a development command goes to the desktop app and what it answers goes back, data included', async () => {
  const seen = [];
  const desktop = { dev: { admin: async (cmd) => { seen.push(cmd); return { ok: true, detail: 'hecho', data: { files: { 'a.js': '1' } } }; } } };
  const cmd = { do: 'dev_read', id: 'p' };
  assert.deepEqual(await runDevCommand(cmd, desktop), { ok: true, detail: 'hecho', data: { files: { 'a.js': '1' } } });
  assert.deepEqual(seen, [cmd]);
  const refused = await runDevCommand(cmd, { dev: { admin: async () => ({ ok: false, detail: 'x'.repeat(500) }) } });
  assert.equal(refused.ok, false);
  assert.equal(refused.detail.length, 300);
});

test('without the desktop app, or if it fails, a development command is an answer and not an exception', async () => {
  const cmd = { do: 'dev_list' };
  for (const desktop of [undefined, {}, { dev: {} }]) {
    const r = await runDevCommand(cmd, desktop);
    assert.equal(r.ok, false);
    assert.match(r.detail, /solo existen en la aplicación de escritorio/);
  }
  assert.deepEqual(await runDevCommand(cmd, { dev: { admin: async () => { throw new Error('boom'); } } }), { ok: false, detail: 'error: boom' });
  assert.equal((await runDevCommand(cmd, { dev: { admin: async () => null } })).ok, false);
  assert.equal((await runDevCommand(cmd, { dev: { admin: async () => 'texto' } })).ok, false);
});

test('the three levels have words, and the last one says it writes plugins', () => {
  assert.match(describeControl({ enabled: true, level: 'dev', page_connected: true, client_recent: false }), /leer, controlar y escribir plugins/);
});

test('commands about the plugins are told apart and go to the desktop app', async () => {
  assert.equal(isPluginCommand({ do: 'plugin_list' }), true);
  assert.equal(isPluginCommand({ do: 'dev_list' }), false);
  assert.equal(isPluginCommand({ do: 'play' }), false);
  assert.equal(isPluginCommand(null), false);
  const calls = [];
  const desktop = { plugins: { admin: async (cmd) => { calls.push(cmd); return { ok: true, detail: 'hecho' }; } } };
  assert.deepEqual(await runPluginCommand({ do: 'plugin_enable', id: 'x' }, desktop, null), { ok: true, detail: 'hecho', data: undefined });
  assert.deepEqual(calls, [{ do: 'plugin_enable', id: 'x' }]);
  assert.match((await runPluginCommand({ do: 'plugin_list' }, {}, null)).detail, /solo existen en la aplicación de escritorio/);
  assert.equal((await runPluginCommand({ do: 'plugin_list' }, { plugins: { admin: async () => null } }, null)).ok, false);
  const broken = await runPluginCommand({ do: 'plugin_list' }, { plugins: { admin: async () => { throw new Error('se rompió'); } } }, null);
  assert.deepEqual([broken.ok, /se rompió/.test(broken.detail)], [false, true]);
});

test('the list of plugins is completed with how each frame is doing, and a plugin that is not on is stopped', async () => {
  const data = { folder: 'f', plugins: [{ id: 'a', kind: 'ui' }, { id: 'b', kind: 'ui' }, { id: 'c', kind: 'script' }] };
  const status = [{ id: 'a', state: 'unresponsive', calls: 5, errors: 1, denied: 0, limited: 0, restarts: 2, methods: { 'player.state': 5 } }];
  const merged = mergeRuntime(data, status);
  assert.equal(merged.folder, 'f');
  assert.equal(merged.plugins[0].runtime.state, 'unresponsive');
  assert.equal(merged.plugins[0].runtime.restarts, 2);
  assert.equal(merged.plugins[1].runtime.state, 'stopped');
  assert.equal(merged.plugins[2].runtime, undefined, 'a plugin of scripts has no frame');
  const desktop = { plugins: { admin: async () => ({ ok: true, detail: 'plugins', data }) } };
  const r = await runPluginCommand({ do: 'plugin_list' }, desktop, { status: () => status });
  assert.equal(r.data.plugins[0].runtime.state, 'unresponsive');
  const noHost = await runPluginCommand({ do: 'plugin_list' }, desktop, null);
  assert.equal(noHost.data.plugins[0].runtime.state, 'stopped');
});

test('commands about the headers are told apart, and a channel is found by id or name even if it does not play', () => {
  assert.equal(isHeadersCommand({ do: 'headers_set' }), true);
  assert.equal(isHeadersCommand({ do: 'plugin_list' }), false);
  assert.equal(isHeadersCommand(null), false);
  const { state } = world();
  state.channels.push(channel('sin', 'Solo web', 'tv', { sources: [] }));
  state.byId.set('sin', state.channels.at(-1));
  assert.equal(resolveAnyChannel(state, 'sin').name, 'Solo web');
  assert.equal(resolveAnyChannel(state, 'solo WEB').id, 'sin');
  assert.equal(resolveAnyChannel(state, 'La 1').id, 'a');
  assert.equal(resolveAnyChannel(state, 'no existe'), null);
  assert.equal(resolveAnyChannel(state, '   '), null);
});

test('the question about the headers an AI wants to set shows every change in full', () => {
  const before = [{ name: 'Referer', value: 'https://viejo/', secret: false }, { name: 'Cookie', value: null, secret: true }, { name: 'Origin', value: 'https://o/', secret: false }];
  const ask = describeHeaderChanges('La 2', before, { Referer: 'https://nuevo/', Cookie: 'a=b', 'X-Token': 't', Origin: null }, false);
  assert.match(ask.message, /cambiar las cabeceras de «La 2»/);
  assert.match(ask.detail, /Referer: «https:\/\/nuevo\/» \(antes «https:\/\/viejo\/»\)/);
  assert.match(ask.detail, /Cookie: «a=b» \(sustituye a la guardada\)/);
  assert.match(ask.detail, /X-Token: «t» \(nueva\)/);
  assert.match(ask.detail, /Origin: se quita/);
  assert.match(ask.detail, /una cookie, un token\) van solo a los servidores/);
  assert.match(ask.detail, /No se salta DRM ni geobloqueos/);
  const plain = describeHeaderChanges('La 2', [], { Referer: 'https://r/' }, false);
  assert.doesNotMatch(plain.detail, /una cookie, un token/, 'the warning about credentials only when one is set');
  const replaced = describeHeaderChanges('La 2', before, { Referer: 'https://r/' }, true);
  assert.match(replaced.detail, /Cookie: se quita \(se dejan solo las que se piden\)/);
  assert.match(replaced.detail, /Origin: se quita \(se dejan solo/);
});

test('reading the headers goes to the server, and changing them asks the user first and only then saves', async () => {
  const { state } = world();
  const calls = [];
  const found = { ok: true, data: { id: 'a', name: 'La 1', own: false, headers: [{ name: 'Referer', value: 'https://r/', secret: false }] } };
  const deps = (confirm) => ({
    state, confirm,
    get: async (id) => { calls.push(['get', id]); return found; },
    post: async (id, changes, replace) => { calls.push(['post', id, changes, replace]); return { ok: true, data: { id, name: 'La 1', own: false, headers: [] } }; },
  });
  const read = await runHeadersCommand({ do: 'headers_get', channel: 'La 1' }, deps(undefined));
  assert.deepEqual([read.ok, read.data.headers[0].name], [true, 'Referer']);
  assert.deepEqual(calls, [['get', 'a']], 'reading asks nobody and saves nothing');

  const asked = [];
  const yes = await runHeadersCommand({ do: 'headers_set', channel: 'a', headers: { Origin: 'https://o/' }, replace: false }, deps(async (m, d) => { asked.push([m, d]); return true; }));
  assert.equal(yes.ok, true);
  assert.equal(asked.length, 1);
  assert.deepEqual(calls.at(-1), ['post', 'a', { Origin: 'https://o/' }, false]);

  calls.length = 0;
  const no = await runHeadersCommand({ do: 'headers_set', channel: 'a', headers: { Origin: 'https://o/' } }, deps(async () => false));
  assert.deepEqual([no.ok, no.detail], [false, 'el usuario no ha aceptado el cambio']);
  assert.ok(!calls.some((c) => c[0] === 'post'), 'nothing is saved if the user says no');

  const browser = await runHeadersCommand({ do: 'headers_set', channel: 'a', headers: { Origin: 'https://o/' } }, deps(undefined));
  assert.match(browser.detail, /aplicación de escritorio/);
  assert.ok(!calls.some((c) => c[0] === 'post'));

  assert.match((await runHeadersCommand({ do: 'headers_get', channel: 'nada' }, deps(undefined))).detail, /no hay ningún canal/);
  assert.equal((await runHeadersCommand({ do: 'headers_get', channel: 'a' }, { ...deps(undefined), get: async () => ({ ok: false, data: null }) })).ok, false);
  const failing = await runHeadersCommand({ do: 'headers_set', channel: 'a', headers: { Host: 'x' } }, { ...deps(async () => true), post: async () => ({ ok: false, data: { error: 'la cabecera «Host» la pone el propio programa' } }) });
  assert.match(failing.detail, /la pone el propio programa/);
  assert.equal((await runHeadersCommand({ do: 'headers_get', channel: 'a' }, { ...deps(undefined), get: async () => { throw new Error('se rompió'); } })).ok, false);
});
