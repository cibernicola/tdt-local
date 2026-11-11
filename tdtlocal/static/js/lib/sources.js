// Playback sources that plugins add (tdt.sources in a manifest): an address of a page, with holes, and the address of the embeddable player to
// show instead. No plugin code runs: this only fills in an address. Pure functions; ../sources.js keeps the list the page has now.
// What is a valid source (https, a fixed server, holes only in the path or the query, a permission for the server) is decided when the manifest
// is read (desktop/lib/plugin-api.js); this file checks the server again, so a wrong one shows nothing instead of showing the wrong place.
// the control adapters the core knows and the only servers each fits (the same table as desktop/lib/plugin-api.js, checked again here)
export const CONTROLS = { youtube: ['www.youtube-nocookie.com', 'www.youtube.com'], atres: ['www.atresplayer.com'] };
const HOLE = /\{([1-3])\}/g;
const WORD = '([A-Za-z0-9_.~-]{1,100})';
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern of a «match» address: everything literal except the holes, which take letters, numbers and _ . ~ - . No backtracking tricks. */
export function patternOf(match) {
  const parts = String(match).split(HOLE); // text, hole number, text, ...
  let source = '';
  parts.forEach((part, i) => { source += i % 2 ? WORD : escape(part); });
  return new RegExp('^' + source.replace(/\/$/, '') + '/?(?:[?#].*)?$', 'i');
}

/**
 * The embeddable player for ``url`` if one of the ``sources`` is for it, or ``null``: ``{name, embed}``. ``parent`` is the host that shows the player
 * (the player services ask for it). The player's server must be the one the source declared, in https.
 */
export function matchSource(sources, url, parent) {
  const text = String(url || '');
  if (text.length > 400) return null;
  for (const source of sources || []) {
    let found;
    try { found = patternOf(source.match).exec(text); } catch { continue; }
    if (!found) continue;
    const address = source.embed.replace(HOLE, (_all, n) => encodeURIComponent(found[Number(n)] || '')).replace('{parent}', encodeURIComponent(parent || ''));
    try {
      const wanted = new URL(source.embed.replace(HOLE, 'x').replace('{parent}', 'x')).hostname;
      const got = new URL(address);
      const control = Object.hasOwn(CONTROLS, source.control) && CONTROLS[source.control].includes(got.hostname) ? source.control : '';
      if (got.protocol === 'https:' && got.hostname === wanted) return { name: source.name, embed: got.href, control };
    } catch { /* an address that does not parse shows nothing */ }
  }
  return null;
}
