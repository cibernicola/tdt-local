// The playback sources the plugins that run add, as the page knows them now. plugin-host.js fills it in; tile.js asks it.
import { matchSource } from './lib/sources.js';

let list = [];

export const setPluginSources = (sources) => { list = Array.isArray(sources) ? sources : []; };

/** ``{name, embed}`` if a plugin knows how to show this address, else ``null``. */
export const pluginEmbed = (url) => (list.length ? matchSource(list, url, location.hostname) : null);

/** The name of the plugin source that shows this address (for the lists), or ''. */
export const pluginSourceName = (url) => { const m = pluginEmbed(url); return m ? m.name : ''; };
