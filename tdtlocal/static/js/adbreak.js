// While an ad break is on (SCTE-35), react to it. This file is the engine: it finds out when a break starts and ends, keeps the one under way and its
// timers, and tells the hooks. WHAT is done during a break is not here: the filter «ad.reaction» says it (a list of steps, by default the user's choices
// in the settings) and each step is an action of the registry «ad.actions». Those, and the defaults, are in the included plugin «ads»
// (tdtlocal/static/plugins/ads/page.js), which any other plugin can add to, change or replace. What to do with each marker is in lib/adbreak.js.
import {
  END_MARGIN, PREROLL_CONTENT_SECONDS, STALE_SECONDS, reactionTo, remainingOf, segmentStart, untilMarker, waitFor,
} from './lib/adbreak.js';

const WAIT_FOR_SEGMENT_S = 20; // the most to wait for the player to ask for the segment a marker belongs to

/**
 * What the reaction needs from the page.
 * @typedef {object} AdsHost
 * @property {() => import('./tile.js').Tile} focusTile
 * @property {() => object[]} channels
 * @property {() => {v: number, m: boolean}} volume
 * @property {(v: {v: number, m: boolean}) => void} setVolume - set the user's volume (and apply it)
 * @property {(c: object) => void} tune - show a channel in the active tile without remembering it as "the last one"
 * @property {(original: import('./tile.js').Tile, c: object) => ({spare: object, was: object | null} | null)} park - single
 *   view only: show a channel in another tile and leave `original` playing in the background (`null` in multi-view)
 * @property {(parked: object, original: import('./tile.js').Tile, quiet: boolean) => void} unpark - undo `park`
 * @property {(text: string) => void} say - on-screen notice
 */

/** @type {AdsHost | null} */
let host = null;
/** @type {Pick<ReturnType<import('./lib/hooks.js').createHooks>, 'apply' | 'do' | 'get'> | null} */
let hooks = null;
let cfg = null; // the settings the server sent (`meta.ads`), or null when there is nothing to react with
let current = null; // the break under way
const waiting = new Set(); // markers whose segment the player has not asked for yet
const scheduled = new Set(); // markers with a timer set

/** @param {AdsHost} appHost @param {typeof hooks} hookApi */
export function initAds(appHost, hookApi) {
  host = appHost;
  hooks = hookApi;
}

/**
 * What a step of the reaction is given (`ctx`), and what it may leave there for the engine:
 * `tile`, `channel`, `ev`, `behind`, `external`, `soft`, `replay`, `cfg` (the settings when the break began), `settings()` (the settings now), `host`, `b` (the
 * break under way: `b.audioTouched` tells that the user changed the audio, `b.park` where the original went). A step may set `ctx.blind` (the original
 * can no longer be watched, so nothing will tell that the break is over) and `ctx.altName` (the other channel, for the notice).
 * A step returns nothing, or `{lift(quiet), settle()}`: `lift` undoes what it did (`quiet`: the user took over), `settle` is for what is put right
 * afterwards, only when the user did not take over.
 * @typedef {object} AdStep
 */

const warn = (what, error) => console.warn('[TDT] publicidad: ' + what + ':', error && error.message ? error.message : error);

/** Run the steps of the reaction in order; each one that works leaves its way back. A step that fails is skipped. */
function react(ctx) {
  const plan = hooks.apply('ad.reaction', [], ctx);
  const steps = [];
  for (const step of Array.isArray(plan) ? plan : []) {
    const action = step && hooks.get('ad.actions', step.do);
    if (!action || typeof action.run !== 'function') {
      warn('no hay una acción «' + (step && step.do) + '»', '');
      continue;
    }
    try {
      const done = action.run(ctx, step);
      if (done) steps.push(done);
    } catch (error) {
      warn('la acción «' + step.do + '» falló', error);
    }
  }
  return steps;
}

const call = (fn, what, ...args) => {
  try { if (typeof fn === 'function') fn(...args); } catch (error) { warn(what, error); }
};

/** The settings changed (or arrived). `null` switches the reaction off, putting back what it had changed. */
export function setAds(config) {
  cfg = config || null;
  if (!cfg) {
    finish(false);
    for (const item of [...scheduled, ...waiting]) drop(item);
  }
}

export const adsOn = () => !!cfg;

const latencyOf = (tile) => (tile.hls && Number.isFinite(tile.hls.latency) ? Math.max(0, tile.hls.latency) : 0);

function drop(item) {
  clearTimeout(item.timer);
  clearTimeout(item.waitTimer);
  scheduled.delete(item);
  waiting.delete(item);
}

function arm(item, seconds) {
  waiting.delete(item);
  clearTimeout(item.waitTimer);
  item.timer = setTimeout(() => { scheduled.delete(item); item.run(0); }, seconds * 1000);
  scheduled.add(item);
}

/**
 * A marker the player will never reach because it is already behind it: the page was opened, or the channel
 * tuned, in the middle of a break. A break that is still going on is joined; one that is over is not.
 */
function late(item, behind) {
  if (item.kind === 'end') { item.run(0); return; }
  if (item.ev.duration && item.ev.duration - behind >= Math.max(cfg.min_seconds, 1)) item.run(behind);
}

/**
 * Run `item.run` when the player reaches the marker. A marker is seen in the playlist some seconds before it plays,
 * so it is not acted upon when it is found: it waits for the segment it belongs to (or, if the player does not
 * know that segment, for the time the server's measurements say).
 */
function schedule(tile, ev, kind, run) {
  const item = { tile, ev, kind, run, timer: 0, waitTimer: 0 };
  if (ev.kind === 'cue-out-cont') { run(0); return; } // already in the middle of it
  const start = segmentStart(tile.fragStart, ev.seg);
  if (start !== undefined) { arm(item, waitFor(start, tile.video.currentTime, tile.video.playbackRate)); return; }
  const ahead = untilMarker(ev, tile.hls ? tile.hls.latency : NaN, Date.now() / 1000);
  if (ahead !== undefined && ahead < -STALE_SECONDS) { late(item, -ahead); return; }
  if (!ev.seg) { arm(item, ahead === undefined ? latencyOf(tile) : Math.max(0, ahead)); return; }
  // by the time the marker is due the player has asked for its segment: until then, the exact position can arrive
  waiting.add(item);
  const patience = ahead === undefined ? WAIT_FOR_SEGMENT_S : Math.min(WAIT_FOR_SEGMENT_S, Math.max(0, ahead) + 2);
  item.waitTimer = setTimeout(() => arm(item, 0), patience * 1000);
}

/** The player asked for a new segment: a marker may have been waiting for exactly this one. */
export function fragSeen(tile) {
  for (const item of [...waiting]) {
    if (item.tile !== tile) continue;
    const start = segmentStart(tile.fragStart, item.ev.seg);
    if (start !== undefined) arm(item, waitFor(start, tile.video.currentTime, tile.video.playbackRate));
  }
}

/** New events from the log, oldest first. Only those of the channel being watched matter. */
export function adsEvents(events) {
  if (!cfg || !host) return;
  for (const ev of events) {
    const tile = host.focusTile();
    const watching = tile && tile.c ? tile.c.id : '';
    const what = reactionTo(ev, cfg, { channelId: current ? current.channelId : watching, inBreak: !!current });
    if (what === 'start' && watching) schedule(tile, ev, 'start', (behind) => begin(tile, ev, behind));
    else if (what === 'end') schedule(current.tile, ev, 'end', () => finish(false));
  }
}

const EXTERNAL_LIMIT_S = 900; // a break reported from inside a player ends when it says so; this is only a safety net
const REPLAY_GRACE_S = 90; // a player that is loaded again starts with an ad of its own: it is not a new break to leave for
let returned = null; // the channel we last went back to by loading it again, and when

/**
 * The player inside a tile (Atresplayer's, through the bridge script) says an ad break starts or ends. It does not
 * say how long it lasts, so it ends when the player says so.
 */
export function adsExternal(tile, on, contentSeconds = Infinity) {
  if (!cfg || !host || !tile.c) return;
  if (current && current.tile === tile) { // the break we are in: it may be parked in the background, still telling us
    if (!on && current.external) finish(false);
    return;
  }
  if (tile !== host.focusTile()) { // in multi-view another tile has the sound: its break only gets the notice
    tile.setAdFlag(on && cfg.flag);
    return;
  }
  // the ad that comes right after pressing «Directo» (or after the player starts over) has no programme before it: a
  // channel switch would be useless (it lasts a few seconds) and, when the player starts over after a break, it would
  // make it a loop. It only gets the sound and the notice.
  if (on && !current) begin(tile, { channel: tile.c.id, kind: 'cue-out' }, 0, true, contentSeconds < PREROLL_CONTENT_SECONDS);
}

function begin(tile, ev, behind, external = false, soft = false) {
  if (!cfg || current || tile !== host.focusTile() || !tile.c || tile.c.id !== ev.channel) return;
  const channel = tile.c;
  const b = {
    tile, channel, channelId: channel.id, before: { ...host.volume() }, audioTouched: false, tuned: false, timer: 0, external,
    park: null, steps: [],
  };
  current = b;
  // right after going back to a channel by loading it again, its player starts with an ad of its own: not a new break
  const replay = !!(external && returned && returned.channelId === channel.id && Date.now() - returned.at < REPLAY_GRACE_S * 1000);
  const ctx = { tile, channel, ev, behind, external, soft, replay, cfg, settings: () => cfg, host, b, blind: false, altName: '' };
  b.steps = react(ctx);
  // when the original cannot be watched any more, nothing tells that the break is over: the assumed length rules
  const left = external && !ctx.blind ? EXTERNAL_LIMIT_S : Math.max(0, remainingOf(ev, cfg).seconds - behind);
  b.timer = setTimeout(() => finish(false), (left + (external ? 0 : END_MARGIN)) * 1000);
  hooks.do('ad.started', {
    channel: String(channel.id), name: String(channel.name || ''), origin: external ? 'player' : 'scte', soft, seconds: Math.round(left),
    known: external ? false : remainingOf(ev, cfg).known,
  });
}

/**
 * Put things back. `quiet`: the user took over (a channel change they made), so only what the reaction itself set is
 * lifted and nobody is taken back to the original channel.
 */
function finish(quiet) {
  const b = current;
  if (!b) return;
  current = null;
  clearTimeout(b.timer);
  for (const item of [...scheduled]) if (item.kind === 'end') drop(item);
  for (const step of b.steps) call(step.lift, 'deshacer un paso falló', quiet);
  const ended = () => hooks.do('ad.ended', { channel: String(b.channelId), name: String(b.channel.name || ''), quiet });
  if (quiet) { ended(); return; }
  for (const step of b.steps) call(step.settle, 'rematar un paso falló');
  const tile = b.tile;
  if (!b.park && tile === host.focusTile() && tile.c && tile.c.id !== b.channelId) {
    returned = { channelId: b.channelId, at: Date.now() };
    host.tune(b.channel);
  }
  host.say('Fin de la pausa de anuncios');
  ended();
}

/** The user changed the volume of the active tile while the reaction held its own: their value wins, now. */
export function adsUserVolume(tile, value) {
  tile.setDuck(null);
  host.setVolume(value);
  if (current && current.tile === tile) current.audioTouched = true;
}

/** The user chose a channel (a change the reaction did not make). */
export function adsTuned() {
  if (!current) return;
  current.tuned = true;
  current.tile.setDuck(null);
  current.tile.hideAdFrame();
  if (!cfg || cfg.on_touch === 'respect') finish(true); // what they chose stays: nothing is undone
}
