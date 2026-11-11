// How the ad-break tests get the engine and the included plugin that does the reaction. The hooks are the same ones the page uses (lib/hooks.js), on a
// hub of their own.
import { initAds as initEngine } from '../../../tdtlocal/static/js/adbreak.js';
import { createHub } from '../../../tdtlocal/static/js/lib/events.js';
import { createHooks } from '../../../tdtlocal/static/js/lib/hooks.js';
import { createLoader } from '../../../tdtlocal/static/js/lib/trusted.js';
import ads from '../../../tdtlocal/static/plugins/ads/page.js';

export { adsEvents, adsExternal, adsTuned, adsUserVolume, setAds } from '../../../tdtlocal/static/js/adbreak.js';

/** The hooks of the last scene: a test can add its own plugin to them. */
export let hooks;
export let trusted;
export let hub;

/** A new page: its hooks, the included plugin loaded, and the engine started on `host`. */
export async function initAds(host, { withIncluded = true } = {}) {
  hub = createHub();
  hooks = createHooks({ hub });
  trusted = createLoader(hooks, { log: () => {} });
  if (withIncluded) await trusted.load('ads', ads);
  initEngine(host, hooks);
}
