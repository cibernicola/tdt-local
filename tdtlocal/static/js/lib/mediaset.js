// Mediaset live (DASH + Widevine) with Shaka Player. The browser's CDM decrypts; our server only relays
// manifest, segments and license requests (Mediaset's CDN only answers to its own web's Origin).

let loading = null;

/** Where Shaka must ask for `uri` instead: our relay. Idempotent (a retry runs the request filter again). */
export function proxyUri(uri, license) {
  if (!uri.startsWith('https://')) return uri; // already ours
  return (license ? '/api/mediaset/license?u=' : '/api/mediaset/p?u=') + encodeURIComponent(uri);
}

function loadShaka() {
  if (window.shaka) return Promise.resolve();
  loading = loading || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/shaka-player.compiled.js';
    s.onload = resolve;
    s.onerror = () => { loading = null; reject(new Error('no se pudo cargar Shaka')); };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Starts channel `key` (e.g. "telecinco") on `video`. Resolves with the Shaka player (call `.destroy()`
 * to stop); `onError` is called on playback errors after that.
 */
export async function startMediaset(video, key, onError) {
  await loadShaka();
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) throw new Error('este navegador no soporta MSE/EME');
  const res = await fetch('/api/mediaset?c=' + encodeURIComponent(key));
  const info = await res.json();
  if (!res.ok || info.error) throw new Error(info.error || 'HTTP ' + res.status);
  const player = new shaka.Player();
  try {
    await player.attach(video);
    const net = player.getNetworkingEngine();
    net.registerRequestFilter((type, request) => {
      const license = type === shaka.net.NetworkingEngine.RequestType.LICENSE;
      request.uris = request.uris.map((u) => proxyUri(u, license));
    });
    player.configure({ drm: { servers: { 'com.widevine.alpha': info.license } } });
    player.addEventListener('error', (e) => onError(e.detail));
    await player.load(info.mpd);
  } catch (err) {
    await player.destroy();
    throw err;
  }
  return player;
}
