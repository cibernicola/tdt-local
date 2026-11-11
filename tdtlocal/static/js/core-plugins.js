// The plugins that come with the application. They are loaded by the same loader as any other plugin with all the power, and use the same hooks:
// the application does by default what they do, so a plugin that wants to do it differently can change or replace it. Each one is in
// tdtlocal/static/plugins/<id>/ with its plugin.json.
import { trusted } from './hooks.js';
import { setStyle } from './styles.js';
import ads from '../plugins/ads/page.js';

export const INCLUDED = [{ id: 'ads', setup: ads }];

/** Start them. They register what they bring at once (their setup is not asynchronous), so what needs them can be started right after. */
export function loadIncluded() {
  for (const { id, setup } of INCLUDED) trusted.load(id, setup);
}

/**
 * The plugins without isolation of the desktop app (development plugins, docs/PLUGINS.md) are run by the app's preload, which hands each one to the page:
 * `window.tdtPluginHost.load(id, run)`, or a queue (`window.__tdtQueue`) if it got there first. Here they are given to the same loader as the included
 * ones, with their id apart (`dev:<id>` or `full:<id>`, so one can never take the place of an included plugin by having its name), and so they get the same `tdt`.
 * Without the desktop app there is nothing to hand over, and this does nothing.
 */
export function startPluginHost() {
  if (!window.tdtDev) return;
  // `source` says where it comes from: «dev» (a development plugin) or «full» (an installed plugin with all the power)
  const load = (id, run, source = 'dev') => trusted.load((source === 'full' ? 'full:' : 'dev:') + id, run);
  // a theme: its style sheet goes in after the page's own (js/styles.js), under a key of its own so it can be taken away
  const css = (id, text, source = 'dev') => setStyle((source === 'full' ? 'full:' : 'dev:') + id + ':theme', text);
  window.tdtPluginHost = { load, css };
  const waiting = window.__tdtQueue || [];
  window.__tdtQueue = [];
  for (const [id, run, source] of waiting) load(id, run, source);
  const themes = window.__tdtThemes || [];
  window.__tdtThemes = [];
  for (const [id, text, source] of themes) css(id, text, source);
}
