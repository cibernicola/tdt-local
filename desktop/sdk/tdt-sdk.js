/* SDK de los plugins de TDT local (api 1). Se carga con <script src="/@tdt/sdk.js"></script> y crea `window.tdt`.
 *
 *   const yo = await tdt.ready;                      // { id, name, version, permissions: [...] }
 *   const estado = await tdt.player.state();         // player.read
 *   tdt.on('player', (estado) => { ... });           // player.read: cada vez que cambia algo
 *   await tdt.player.play('La 2');                   // player.control
 *   const r = await tdt.channels.search('canal sur', { kind: 'tv', limit: 5 });   // channels.read
 *   const ahora = await tdt.epg.now('La 2');         // epg.read
 *   await tdt.ui.toast('Hola');                      // ui.toast
 *   await tdt.storage.set('clave', { cualquier: 'cosa' }); // storage
 *   const resp = await tdt.net.fetch('https://api.ejemplo.com/x'); // network:api.ejemplo.com
 *
 * Todo devuelve una promesa; si falla, es un Error con `message` (para ti) y `code` (para tu código): E_PERMISSION, E_INVALID, E_NOT_FOUND,
 * E_UNSUPPORTED, E_UNAVAILABLE, E_RATE o E_QUOTA. Las de permiso empiezan por «permiso denegado».
 * Referencia completa: docs/PLUGINS.md */
(() => {
  'use strict';
  if (window.tdt) return;
  const TIMEOUT = 60_000;
  const pending = new Map();
  const listeners = new Map();
  let next = 1;
  let hello;
  const ready = new Promise((resolve, reject) => {
    hello = { resolve, reject };
  });

  function send(message) {
    if (window.parent === window) throw new Error('este plugin tiene que correr dentro de TDT local');
    window.parent.postMessage({ tdt: 1, ...message }, '*');
  }

  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: la aplicación no ha respondido`));
      }, TIMEOUT);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        send({ id, method, args });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.tdt !== 1) return;
    if (m.ping !== undefined) send({ pong: m.ping }); // the app asks «are you there?»: answered here, without the plugin's code
    else if (m.ready) hello.resolve(Object.freeze(m.plugin));
    else if (m.event) {
      for (const fn of [...(listeners.get(m.event) || [])]) {
        try { fn(m.data); } catch (error) { console.error(error); }
      }
    } else if (m.id && pending.has(m.id)) {
      const entry = pending.get(m.id);
      pending.delete(m.id);
      if (m.ok) entry.resolve(m.result);
      else {
        const error = new Error(String(m.error || 'error'));
        error.code = m.code || 'E_UNAVAILABLE'; // E_PERMISSION, E_INVALID, E_NOT_FOUND, E_UNSUPPORTED, E_UNAVAILABLE, E_RATE, E_QUOTA
        entry.reject(error);
      }
    }
  });

  const response = (r) => ({ ...r, json: () => JSON.parse(r.text) });

  // the app answers at most 4 requests of a plugin at a time: the others wait here their turn, so that a plugin can ask for six things at once
  const MAX_FETCHES = 4;
  const waiting = [];
  let fetching = 0;
  function fetchTurn(url, init) {
    return new Promise((resolve, reject) => {
      const run = () => {
        fetching += 1;
        call('net.fetch', String(url), init || {}).then(resolve, reject).finally(() => {
          fetching -= 1;
          if (waiting.length) waiting.shift()();
        });
      };
      if (fetching < MAX_FETCHES) run();
      else waiting.push(run);
    });
  }

  window.tdt = Object.freeze({
    api: 1,
    ready,
    on(event, fn) {
      if (typeof fn !== 'function') throw new TypeError('on(evento, función)');
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      if (listeners.has(event)) listeners.get(event).delete(fn);
    },
    player: Object.freeze({
      state: () => call('player.state'),
      play: (channel) => call('player.play', channel),
      kind: (kind) => call('player.kind', kind),
      volume: (value) => call('player.volume', value),
      mute: (on = true) => call('player.mute', on),
      multi: (channels, rotateSecs) => call('player.multi', channels, rotateSecs),
    }),
    channels: Object.freeze({
      search: (query = '', options = {}) => call('channels.search', query, options),
      provide: (channels) => call('channels.provide', channels), // provide:channels — all the channels this plugin adds (an empty list removes them)
    }),
    epg: Object.freeze({
      now: (channel) => call('epg.now', channel),
      provide: (guide) => call('epg.provide', guide), // provide:epg — the whole guide this plugin adds ({channel: [[start, end, title], ...]})
    }),
    config: Object.freeze({
      get: (name) => call('config.get', name), // a setting the user chooses in Ajustes ▸ Plugins (declared in tdt.settings)
      all: () => call('config.all'),
    }),
    ui: Object.freeze({
      toast: (text) => call('ui.toast', text),
      resize: (width, height) => call('ui.resize', width, height),
    }),
    storage: Object.freeze({
      get: (key) => call('storage.get', key),
      set: (key, value) => call('storage.set', key, value),
      remove: (key) => call('storage.remove', key),
      keys: () => call('storage.keys'),
    }),
    net: Object.freeze({
      fetch: (url, init) => fetchTurn(url, init).then(response),
    }),
  });

  try { send({ hello: true }); } catch (error) { hello.reject(error); }
})();
