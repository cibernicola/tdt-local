// The hooks of the page, and the plugins with all the power that use them (docs/HACKEABLE.md). One of each for the whole page.
// The application names its own hooks where it decides something (see docs/PUNTOS-DE-ENGANCHE.md); the plugins included with the application are loaded
// by the same loader as any other (core-plugins.js).
import { events } from './events.js';
import { createHooks } from './lib/hooks.js';
import { createLoader } from './lib/trusted.js';
import { setStyle } from './styles.js';

const where = (name, error) => console.warn('[TDT] un filtro de «' + name + '» falló:', error && error.message ? error.message : error);

export const hooks = createHooks({ hub: events, onError: where });
// What a plugin without isolation says goes to the log of the app, under its own name (the preload gives the page `window.tdtDev` only if there are any).
const say = (id, level, text) => {
  const from = /^(dev|full):(.+)$/.exec(id);
  if (window.tdtDev && from) window.tdtDev.log(from[2], level, text, from[1]);
  else console[level === 'ERROR' ? 'warn' : 'log']('[TDT] plugin «' + id + '»: ' + text);
};
export const trusted = createLoader(hooks, { log: say, css: setStyle }); // `tdt.css(text)` puts a style sheet in the page
