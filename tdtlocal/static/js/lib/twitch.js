// Official Twitch player only: no extracted streams, credentials or subscription tokens.
const RESERVED = new Set(['directory', 'downloads', 'settings', 'subscriptions', 'videos', 'login', 'signup', 'search']);

export function twitchChannel(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    let channel;
    if (url.hostname === 'player.twitch.tv' && url.pathname === '/') channel = url.searchParams.get('channel');
    else if (['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(url.hostname)) {
      const match = /^\/([a-z0-9_]{1,25})\/?$/i.exec(url.pathname);
      channel = match && match[1];
    }
    return channel && /^[a-z0-9_]{1,25}$/i.test(channel) && !RESERVED.has(channel.toLowerCase())
      ? channel.toLowerCase() : null;
  } catch { return null; }
}

export const twitchWeb = (value) => {
  const channel = twitchChannel(value);
  return channel ? 'https://www.twitch.tv/' + channel : '';
};

// Saved failed probes must not hide embeds. Keep other sources available for manual selection.
export function withTwitchSources(channel) {
  const twitch = channel.sources.filter((s) => twitchChannel(s.u));
  return twitch.length ? { ...channel, ok: null, sources: channel.sources.map((s) => twitchChannel(s.u) ? { ...s, ok: null } : s) } : channel;
}

export function syncTwitchAudio(player, want) {
  player.setVolume(Math.max(0, Math.min(1, want.v)));
  player.setMuted(!!want.m);
}

let sdkPromise;
export function loadTwitchSdk() {
  if (window.Twitch && window.Twitch.Player) return Promise.resolve(window.Twitch);
  if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://player.twitch.tv/js/embed/v1.js';
    script.addEventListener('load', () => {
      if (window.Twitch && window.Twitch.Player) resolve(window.Twitch);
      else { script.remove(); sdkPromise = null; reject(new Error('Twitch no ha cargado su reproductor.')); }
    });
    script.addEventListener('error', () => {
      script.remove(); sdkPromise = null; reject(new Error('No se pudo cargar Twitch.'));
    });
    document.head.append(script);
  });
  return sdkPromise;
}
