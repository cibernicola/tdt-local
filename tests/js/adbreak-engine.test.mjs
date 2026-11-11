// The reaction to an ad break, seen from the outside: what the engine (js/adbreak.js) does to the tile, the audio and the screen, and in which order.
// It is written with fakes for the tile and the page, so it needs no browser. It pins the behaviour: the same checks must pass whoever does the work
// (the engine itself, or the actions the included «ads» plugin registers).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adsEvents, adsExternal, adsTuned, adsUserVolume, hub, initAds, setAds, trusted } from './helpers/ads-setup.mjs';

const CFG = {
  flag: true, audio: 'mute', lower_percent: 30, screen: 'channel', channel: 'alt', web_url: 'https://example.test/ad', min_seconds: 5,
  unknown_seconds: 60, on_touch: 'restore',
};
const START = (channel) => ({ channel, kind: 'cue-out-cont', duration: 60, elapsed: 0 }); // «already in the middle of it»: it acts at once
const END = (channel) => ({ channel, kind: 'cue-in' });
const later = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tile, a page and the log of everything done to them. `parkable: false` is multi-view (the channel is switched in the tile itself). */
async function scene(id, { parkable = true, cfg = CFG, withIncluded = true } = {}) {
  const log = [];
  const alt = { id: 'alt', name: 'Alt', kind: 'tv', sources: ['x'], ok: true };
  const tile = {
    c: { id, name: 'Canal ' + id, kind: 'tv', sources: ['y'] }, fragStart: new Map(), hls: null, video: { currentTime: 0, playbackRate: 1 },
    setDuck: (d) => log.push('duck:' + JSON.stringify(d)),
    setAdFlag: (on) => log.push('flag:' + on),
    showAdFrame: (url) => log.push('web:' + url),
    hideAdFrame: () => log.push('web:off'),
  };
  const original = tile.c;
  let vol = { v: 0.8, m: false };
  const host = {
    focusTile: () => tile,
    channels: () => [alt, original],
    volume: () => vol,
    setVolume: (v) => { vol = v; log.push('volume:' + JSON.stringify(v)); },
    tune: (c) => { log.push('tune:' + c.id); tile.c = c; },
    park: (t, c) => { if (!parkable) return null; log.push('park:' + c.id); return { spare: {}, was: null }; },
    unpark: (p, t, quiet) => log.push('unpark:' + quiet),
    say: (text) => log.push('say:' + text),
  };
  await initAds(host, { withIncluded });
  setAds(cfg);
  return { log, tile, original };
}

test('a break starts: the flag, the sound and the other channel, in this order, and the user is told', async () => {
  const { log } = await scene('s1');
  adsEvents([START('s1')]);
  assert.deepEqual(log, ['flag:true', 'duck:{"muted":true}', 'park:alt', 'say:Pausa de anuncios · sonido silenciado · viendo Alt']);
  setAds(null);
});

test('the break is over: everything is put back and the user is told', async () => {
  const { log } = await scene('s2');
  adsEvents([START('s2')]);
  log.length = 0;
  adsEvents([END('s2')]);
  await later();
  // each step undoes what it did, in the order of the plan (the sound before the channel comes back); nothing is touched that was not
  assert.deepEqual(log, ['flag:false', 'duck:null', 'unpark:false', 'say:Fin de la pausa de anuncios']);
  setAds(null);
});

test('without a spare tile (multi-view) the channel is switched, and the original comes back when it is over', async () => {
  const { log, tile, original } = await scene('s3', { parkable: false });
  adsEvents([START('s3')]);
  assert.deepEqual(log, ['flag:true', 'duck:{"muted":true}', 'tune:alt', 'say:Pausa de anuncios · sonido silenciado · viendo Alt']);
  // the original cannot be watched any more: nothing tells that the break is over, so the assumed length rules (and a «cue-in» is not waited for)
  log.length = 0;
  setAds(null);
  assert.deepEqual(log, ['flag:false', 'duck:null', 'tune:' + original.id, 'say:Fin de la pausa de anuncios']);
  assert.equal(tile.c, original);
});

test('showing a web instead of another channel', async () => {
  const { log } = await scene('s4', { cfg: { ...CFG, screen: 'web', audio: 'lower', flag: false } });
  adsEvents([START('s4')]);
  assert.deepEqual(log, ['duck:{"gain":0.3}', 'web:https://example.test/ad', 'say:Pausa de anuncios · volumen al 30 % · mostrando una web']);
  setAds(null);
});

test('keeping the screen: only the sound and the notice', async () => {
  const { log } = await scene('s5', { cfg: { ...CFG, screen: 'keep', flag: false } });
  adsEvents([START('s5')]);
  assert.deepEqual(log, ['duck:{"muted":true}', 'say:Pausa de anuncios · sonido silenciado']);
  setAds(null);
});

test('a player that tells by itself, with little programme before: the sound and the notice, no channel switch', async () => {
  const { log, tile } = await scene('s6');
  adsExternal(tile, true, 5);
  assert.deepEqual(log, ['flag:true', 'duck:{"muted":true}', 'say:Pausa de anuncios · sonido silenciado (poco programa antes: no se cambia de canal)']);
  setAds(null);
});

test('the user changes the volume during the break: their value wins, and it is theirs again when it is over (restore)', async () => {
  const { log, tile } = await scene('s7');
  adsEvents([START('s7')]);
  log.length = 0;
  adsUserVolume(tile, { v: 0.2, m: false });
  assert.deepEqual(log, ['duck:null', 'volume:{"v":0.2,"m":false}']);
  log.length = 0;
  adsEvents([END('s7')]);
  await later();
  assert.deepEqual(log, ['flag:false', 'duck:null', 'unpark:false', 'volume:{"v":0.8,"m":false}', 'say:Fin de la pausa de anuncios']);
  setAds(null);
});

test('the user chooses a channel during the break: what they chose stays, nothing is undone and nobody is taken back', async () => {
  const { log, tile } = await scene('s8', { cfg: { ...CFG, on_touch: 'respect' } });
  adsEvents([START('s8')]);
  log.length = 0;
  adsTuned();
  assert.deepEqual(log, ['duck:null', 'web:off', 'flag:false', 'duck:null', 'unpark:true']);
  log.length = 0;
  adsEvents([END('s8')]); // there is no break any more
  await later();
  assert.deepEqual(log, []);
  assert.equal(tile.c.id, 's8');
  setAds(null);
});

test('no settings, no reaction; the same break twice is one', async () => {
  const { log } = await scene('s9', { cfg: null });
  adsEvents([START('s9')]);
  assert.deepEqual(log, []);
  setAds(CFG);
  adsEvents([START('s9')]);
  const first = log.length;
  adsEvents([START('s9')]);
  assert.equal(log.length, first, 'a break under way is not started again');
  setAds(null);
});

// ---- what a plugin can do with the reaction (the hooks of docs/HACKEABLE.md)

test('the events: «ad.started» and «ad.ended» are told, with what is known about the break', async () => {
  const { hub: pageHub } = await scene('h1').then(() => ({ hub }));
  adsEvents([START('h1')]);
  const started = pageHub.recent(1, 'ad.started')[0].data;
  assert.deepEqual(started, { channel: 'h1', name: 'Canal h1', origin: 'scte', soft: false, seconds: 60, known: true });
  adsEvents([END('h1')]);
  await later();
  assert.deepEqual(pageHub.recent(1, 'ad.ended')[0].data, { channel: 'h1', name: 'Canal h1', quiet: false });
  setAds(null);
});

test('a plugin adds a step of its own: it runs with the others, and undoes itself when the break is over', async () => {
  const { log } = await scene('h2');
  await trusted.load('webhook', (tdt) => {
    tdt.register('ad.actions', 'ping', {
      run: (ctx, step) => { log.push('ping:' + step.to + ':' + ctx.channel.id); return { lift: () => log.push('ping:off'), settle: () => log.push('ping:settled') }; },
    });
    tdt.filter('ad.reaction', (steps) => [...steps, { do: 'ping', to: 'casa' }], 20);
  });
  adsEvents([START('h2')]);
  assert.deepEqual(log, ['flag:true', 'duck:{"muted":true}', 'park:alt', 'say:Pausa de anuncios · sonido silenciado · viendo Alt', 'ping:casa:h2']);
  log.length = 0;
  adsEvents([END('h2')]);
  await later();
  assert.deepEqual(log, ['flag:false', 'duck:null', 'unpark:false', 'ping:off', 'ping:settled', 'say:Fin de la pausa de anuncios']);
  setAds(null);
});

test('a plugin changes the reaction: it takes a step out, or adds one before the others', async () => {
  const { log } = await scene('h3');
  await trusted.load('quiet', (tdt) => {
    tdt.filter('ad.reaction', (steps) => steps.filter((s) => s.do !== 'channel' && s.do !== 'flag'), 20); // after the defaults: it works on what they made
    tdt.filter('ad.reaction', (steps) => [{ do: 'notice' }, ...steps], 1); // before them
  });
  adsEvents([START('h3')]);
  assert.deepEqual(log, ['say:Pausa de anuncios · sonido silenciado', 'duck:{"muted":true}', 'say:Pausa de anuncios · sonido silenciado']);
  setAds(null);
});

test('a plugin replaces a step of the core, and the core step comes back when the plugin goes', async () => {
  const { log } = await scene('h4');
  await trusted.load('other-sound', (tdt) => {
    tdt.register('ad.actions', 'audio', { run: (ctx) => { log.push('my-audio'); return { lift: () => log.push('my-audio:off') }; } });
  });
  adsEvents([START('h4')]);
  assert.ok(log.includes('my-audio') && !log.some((l) => l.startsWith('duck:')), log.join(' | '));
  setAds(null);
  assert.ok(log.includes('my-audio:off'));
  trusted.unload('other-sound');
  log.length = 0;
  setAds(CFG);
  adsEvents([START('h4')]);
  assert.equal(log[1], 'duck:{"muted":true}', 'the step of the core is back');
  setAds(null);
});

test('a step that fails, or that does not exist, does not stop the others', async () => {
  const { log } = await scene('h5');
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await trusted.load('clumsy', (tdt) => {
      tdt.register('ad.actions', 'boom', { run: () => { throw new Error('mal'); } });
      tdt.filter('ad.reaction', (steps) => [{ do: 'boom' }, { do: 'nope' }, ...steps], 1);
    });
    adsEvents([START('h5')]);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(log, ['flag:true', 'duck:{"muted":true}', 'park:alt', 'say:Pausa de anuncios · sonido silenciado · viendo Alt']);
  assert.equal(trusted.list().find((p) => p.id === 'clumsy').errors, 1, 'the mistake of the plugin is counted');
  assert.ok(warnings.some((w) => /nope/.test(w)), 'and the one that does not exist is told');
  setAds(null);
});

test('without the included plugin nothing is done during a break (it is the plugin that knows what to do)', async () => {
  const { log } = await scene('h6', { withIncluded: false });
  adsEvents([START('h6')]);
  assert.deepEqual(log, []);
  setAds(null);
});
