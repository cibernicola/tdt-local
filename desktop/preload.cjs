// Runs in every frame of the window (also the ones of other sites inside it). It asks the main process which plugin
// scripts belong to this frame and runs them in an isolated world of their own, which is where the scripts of an
// extension run too (they see the page's DOM, the page does not see their variables). Only the page of TDT local gets
// something in return: `window.tdtDesktop`, at the end of this file.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const FIRST_WORLD = 1001; // 0 is the page's and 999 is Electron's

// Development plugins that run IN the page of TDT local (docs/PLUGINS.md). Only our own page is given any, and only when
// the developer mode is on and the user approved them: the main process decides, this only runs what it hands over. They
// run in the page's own world, without isolation, and can reach everything the page can (also its modules, with import()).
let devScripts = [];
if (window.top === window && location.hostname === '127.0.0.1') {
  try {
    devScripts = ipcRenderer.sendSync('tdt:dev-page-scripts') || [];
  } catch {
    devScripts = [];
  }
  if (devScripts.length) {
    contextBridge.exposeInMainWorld('tdtDev', {
      log: (id, level, text, source) => ipcRenderer.send('tdt:dev-log', String(id), String(level), String(text), source === 'full' ? 'full' : 'dev'),
    });
  }
}

function runDev() {
  for (const { id, code, css, source = 'dev' } of devScripts) {
    const name = JSON.stringify(id);
    if (css) { // a theme: a style sheet the page puts in after its own (js/styles.js); its pictures and fonts are already inside it
      const apply = `(function () {
  const id = ${name};
  const source = ${JSON.stringify(source)};
  const css = ${JSON.stringify(css)};
  if (window.tdtPluginHost && window.tdtPluginHost.css) window.tdtPluginHost.css(id, css, source);
  else (window.__tdtThemes = window.__tdtThemes || []).push([id, css, source]);
})();
//# sourceURL=tdt-theme://${id}/theme.css`;
      webFrame.executeJavaScript(apply).catch((error) => {
        ipcRenderer.send('tdt:dev-log', id, 'ERROR', String((error && error.stack) || error), source === 'full' ? 'full' : 'dev');
      });
    }
    if (!code) continue;
    // The code runs inside an async function that is given `tdt`: the hooks of the page (on, filter, register, ... docs/HACKEABLE.md), plus `log` and
    // `error`. The page (js/core-plugins.js) starts it with its loader, so a mistake is counted and the plugin is taken away cleanly; if the page has not
    // got that far yet, it waits in a queue the page empties. `await` can be used at the top, and a function can be returned to run when it goes.
    const wrapped = `(function () {
  const id = ${name};
  const source = ${JSON.stringify(source)};
  const run = async (tdt) => {
    tdt.error = (e) => window.tdtDev.log(id, 'ERROR', String((e && e.stack) || e), source);
    try {
${code}
    } catch (e) { tdt.error(e); }
  };
  if (window.tdtPluginHost) window.tdtPluginHost.load(id, run, source);
  else (window.__tdtQueue = window.__tdtQueue || []).push([id, run, source]);
})();
//# sourceURL=tdt-dev://${id}/page.js`;
    webFrame.executeJavaScript(wrapped).catch((error) => {
      ipcRenderer.send('tdt:dev-log', id, 'ERROR', String((error && error.stack) || error));
    });
  }
}

function run() {
  if (!/^https?:$/.test(location.protocol)) return;
  let plugins;
  try {
    plugins = ipcRenderer.sendSync('tdt:plugin-scripts');
  } catch {
    return;
  }
  (plugins || []).forEach((plugin, index) => {
    webFrame.executeJavaScriptInIsolatedWorld(
      FIRST_WORLD + index,
      plugin.scripts.map((s) => ({ code: s.code, url: `tdt-plugin://${plugin.id}/${s.file}` })),
    ).catch((error) => console.warn('[TDT plugins]', plugin.id, error && error.message));
  });
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', run, { once: true });
  window.addEventListener('DOMContentLoaded', runDev, { once: true });
} else {
  run();
  runDev();
}

// The plugin that reads Atresplayer's list tells what it read with postMessage in its own page. The page cannot be
// trusted (it can send the same message), so this only passes it on: the main process checks who it comes from and
// cleans every field.
if (window.top === window) {
  window.addEventListener('message', (event) => {
    const d = event.data;
    if (event.source !== window || !d || typeof d !== 'object' || d.source !== 'tdt-u7d') return;
    if (d.type === 'items' || d.type === 'done') {
      ipcRenderer.send('tdt:u7d-read', { type: d.type, slug: String(d.slug || ''), items: d.type === 'items' ? d.items : undefined });
    }
  });
}

// The page of TDT local itself (never a frame inside it) can manage the plugins from its settings. The main process
// checks again who asks on every call, so this being here gives nothing to any other page.
if (window.top === window && location.hostname === '127.0.0.1') {
  contextBridge.exposeInMainWorld('tdtDesktop', {
    plugins: {
      list: () => ipcRenderer.invoke('tdt:plugins-list'),
      setEnabled: (id, on) => ipcRenderer.invoke('tdt:plugins-set', String(id), !!on),
      rescan: () => ipcRenderer.invoke('tdt:plugins-rescan'),
      openFolder: () => ipcRenderer.invoke('tdt:plugins-folder'),
      create: (name, kind) => ipcRenderer.invoke('tdt:plugins-new', String(name), kind === 'full' || kind === 'theme' ? kind : 'ui'), // a plugin with permissions (default), with all the power, or a theme
      install: () => ipcRenderer.invoke('tdt:plugins-install'),
      pack: (id) => ipcRenderer.invoke('tdt:plugins-pack', String(id)),
      installLink: (url, sha, signature) => ipcRenderer.invoke('tdt:plugins-install-link', String(url), sha ? String(sha) : '', signature && typeof signature === 'object' ? signature : undefined), // from a link: the app downloads, checks and asks
      catalog: (url) => ipcRenderer.invoke('tdt:catalog-load', String(url)), // reads a catalog the user pointed at
      setPermission: (id, name, on) => ipcRenderer.invoke('tdt:plugins-permission', String(id), String(name), !!on),
      setConfig: (id, changes) => ipcRenderer.invoke('tdt:plugins-config', String(id), changes), // the settings a plugin declares
      admin: (cmd) => ipcRenderer.invoke('tdt:plugins-admin', cmd), // what an AI asks about the plugins, through the MCP
    },
    atres: {
      list: (slug) => ipcRenderer.invoke('tdt:atres-list', String(slug)),
      watch: (address, title) => ipcRenderer.invoke('tdt:atres-watch', String(address), String(title || '')),
    },
    logs: {
      get: () => ipcRenderer.invoke('tdt:logs-get'),
      save: () => ipcRenderer.invoke('tdt:logs-save'),
      openFolder: () => ipcRenderer.invoke('tdt:logs-folder'),
    },
    // development plugins: the state, and the two things that end in a native question the page cannot answer
    dev: {
      state: () => ipcRenderer.invoke('tdt:dev-state'),
      setMode: (on) => ipcRenderer.invoke('tdt:dev-mode', !!on),
      approve: (id, on) => ipcRenderer.invoke('tdt:dev-approve', String(id), !!on),
      rescan: () => ipcRenderer.invoke('tdt:dev-rescan'),
      openFolder: () => ipcRenderer.invoke('tdt:dev-folder'),
      admin: (cmd) => ipcRenderer.invoke('tdt:dev-admin', cmd), // what an AI asks about development plugins, through the MCP
    },
    // plugins with permissions: the ones to show, what they ask of the app that the page cannot do (files, network), and a
    // notice when the list changes. The main process checks every call against what the user approved.
    ui: {
      list: () => ipcRenderer.invoke('tdt:ui-list'),
      call: (id, method, args) => ipcRenderer.invoke('tdt:ui-call', String(id), String(method), Array.isArray(args) ? args : []),
      log: (id, level, text) => ipcRenderer.send('tdt:ui-log', String(id), String(level), String(text)),
      onChange: (callback) => {
        ipcRenderer.on('tdt:ui-changed', (_event, reload) => callback(reload === true));
      },
      onMetrics: (callback) => {
        ipcRenderer.on('tdt:ui-metrics', (_event, list) => callback(Array.isArray(list) ? list : []));
      },
      onLimit: (callback) => {
        ipcRenderer.on('tdt:ui-limit', (_event, id, reason, detail) => callback(String(id), String(reason), String(detail)));
      },
      onConfig: (callback) => {
        ipcRenderer.on('tdt:ui-config', (_event, id, values) => callback(String(id), values));
      },
    },
    // safe mode: start again without any plugin, or leave it
    safe: { restart: (safe) => ipcRenderer.invoke('tdt:safe-restart', !!safe) },
    // a question to the user in a window of the system, for what an AI asks that changes how the app talks to the outside (the headers of a
    // channel): true if they accept. The answer is theirs, whoever asks.
    confirm: (message, detail) => ipcRenderer.invoke('tdt:confirm', String(message), String(detail)),
    reload: () => ipcRenderer.invoke('tdt:reload'),
  });
}
