// Which sources to try, and in which order, when a channel is played.
import { atresEmbed } from './embeds.js';
import { twitchChannel } from './twitch.js';

const rank = (s) => (s.ok === true ? 0 : s.ok === null ? 1 : 2);

/**
 * Ordered list of `{u, n, f}` to try: the last source that worked first, then the streams (healthy ones,
 * then unknown, then those that failed their last check), then the embedded players. Original order breaks ties.
 * @param {object} channel - channel with `sources: [{u, ok, f}]`
 * @param {{pref?: {u: string}, onlyUrl?: string, canPlayFmt?: (f: string) => boolean}} options
 */
export function buildPlan(channel, { pref, onlyUrl, canPlayFmt = () => true } = {}) {
  let order = channel.sources.map((s, i) => ({ ...s, n: i + 1 })).filter((s) => !onlyUrl || s.u === onlyUrl);
  // radio: drop formats this browser cannot play (if none is left, try anyway)
  const usable = order.filter((s) => canPlayFmt(s.f));
  if (usable.length) order = usable;
  const first = (s) => (pref && pref.u === s.u ? -1 : 0);
  // a player that is only embedded always "works" once loaded and offers less (no proxy: no subtitles, markers or
  // leveler), so it is the last resort after the streams
  const embedded = (s) => (atresEmbed(s.u) ? 1 : 0);
  const twitchFirst = (s) => twitchChannel(s.u) ? -1 : 0;
  order.sort((a, b) => twitchFirst(a) - twitchFirst(b) || first(a) - first(b) || embedded(a) - embedded(b) || rank(a) - rank(b) || a.n - b.n);
  return order.map((s) => ({ u: s.u, n: s.n, f: s.f || '' }));
}

/** hls.js for TV and for m3u8 radio; mp3/aac radio goes straight to the media element. */
export const usesHls = (channel, step) => channel.kind !== 'radio' || step.f === 'm3u8' || /\.m3u8?(\?|$)/i.test(step.u);

/** Whether this browser can play a radio format (`audio` is an HTMLMediaElement). */
export function canPlayFormat(audio, f) {
  if (f === 'mp3') return !!audio.canPlayType('audio/mpeg');
  if (f === 'aac') return !!(audio.canPlayType('audio/aac') || audio.canPlayType('audio/aacp'));
  return true;
}

/**
 * What to add to "no se pudo reproducir" when the origin answered with an error code (0: it did not answer).
 * @param {number} code - HTTP status of the request that failed
 */
export function originNote(code) {
  if (!code) return '';
  const why = code === 404 || code === 410 ? 'el enlace ya no existe o ha caducado'
    : code >= 500 ? 'fallo del servidor de origen'
      : code >= 400 ? 'el origen rechaza la petición (permiso, cabeceras, enlace caducado, o atado a la IP desde la que se sacó: p. ej. con una VPN)' : '';
  return ' El origen respondió HTTP ' + code + (why ? ': ' + why : '') + '.';
}
