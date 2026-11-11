// The events of the page (see lib/events.js and tdtlocal/static/commands.json). One hub for the whole page: the rules, the plugins and the
// control bus listen to it. A watcher looks at the player once a second and tells what changed, and what a programme guide says has started
// on the channels being watched. Nothing here changes anything: it only tells.
import { PROGRAMME_WINDOW, createHub, createWatcher, lookAt, programmesStarted } from './lib/events.js';
import { cur, epgEntries, nowTs, state } from './state.js';

const LOOK_MS = 1000;
const GUIDE_EVERY = 5; // looks between reads of the guide

export const events = createHub({ onError: (name, error) => console.warn('[TDT] un oyente de «' + name + '» falló:', error && error.message ? error.message : error) });

let looks = 0;
const seen = new Set();
const watcher = createWatcher(() => lookAt(state, cur()), (name, data) => events.emit(name, data));

/** Look now, and say that what changed was done by ``why`` (a rule, say), so that whoever did it can tell it apart from the user's own doing. */
export const flushEvents = (why = '') => watcher.look(why);

export function initEvents() {
  setInterval(() => {
    watcher.look();
    looks += 1;
    if (looks % GUIDE_EVERY) return;
    const watched = state.tiles.map((t) => t.c).filter(Boolean);
    for (const e of programmesStarted(watched, epgEntries, nowTs(), seen)) events.emit(e.name, e.data);
  }, LOOK_MS);
  watcher.look();
}

export { PROGRAMME_WINDOW };
