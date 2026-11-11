// The page's half of the control bus (see tdtlocal/control.py and docs/PLUGINS.md). While the user has the access of AIs
// turned on, the page publishes a snapshot of its state, listens for the commands clients send and answers each one. With
// it off, the page does nothing: it only asks, now and then, whether it was turned on.
import { api, postJson, requestJson } from './api.js';
import { el } from './dom.js';
import {
  badgeText, badgeTitle, isDevCommand, isHeadersCommand, isPluginCommand, runCommand, runDevCommand, runHeadersCommand, runPluginCommand, snapshotOf,
} from './lib/control.js';
import { events } from './events.js';
import { isRulesCommand, runRulesCommand } from './lib/rules.js';
import { state } from './state.js';

const SNAPSHOT_MS = 1500;
const HEARTBEAT_MS = 30000; // a snapshot that did not change is still sent now and then, so that its age stays small
const STATUS_MS = 5000;

/**
 * @param {{setKind: Function, play: Function, multiWith: Function, setVolume: Function}} actions
 * @param {{status: () => object[]} | null} plugins what the page knows about the frames of the plugins (plugin-host.js)
 */
export function initControl(actions, plugins = null) {
  const badge = el('div', 'ai-badge');
  badge.hidden = true;
  badge.setAttribute('role', 'status');
  document.body.append(badge);

  let source = null;
  let enabled = false;
  let last = '';
  let lastAt = 0;

  /** What the commands about the headers need: the server, and the question to the user (a window of the system: only the desktop has it). */
  const headersDeps = () => ({
    state,
    get: (id) => api('/api/headers?id=' + encodeURIComponent(id)),
    post: async (id, changes, replace) => {
      const r = await postJson('/api/headers', { id, headers: changes, replace });
      return { ok: r.ok, data: await r.json().catch(() => null) };
    },
    confirm: window.tdtDesktop && window.tdtDesktop.confirm ? (message, detail) => window.tdtDesktop.confirm(message, detail) : undefined,
  });

  /** What the commands about the rules need: the server, the question to the user, and telling the rest of the page that they changed. */
  const rulesDeps = () => ({
    get: () => api('/api/rules'),
    post: async (rules) => {
      const r = await postJson('/api/rules', { rules });
      return { ok: r.ok, data: await r.json().catch(() => null) };
    },
    confirm: window.tdtDesktop && window.tdtDesktop.confirm ? (message, detail) => window.tdtDesktop.confirm(message, detail) : undefined,
    changed: () => window.dispatchEvent(new Event('tdt-rules-changed')),
  });

  /** What just happened, newest first: the page is the one that sees it. */
  const recentEvents = (cmd) => {
    const list = events.recent(cmd.limit || 30, cmd.name || '');
    return { ok: true, detail: `${list.length} eventos`, data: { events: list.map((e) => ({ at: new Date(e.t).toISOString(), name: e.name, data: e.data })) } };
  };

  async function answer(message) {
    let data;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    // the ones about the plugins can wait for the user to answer a question: they are not the page's to do
    const result = isDevCommand(data.cmd)
      ? await runDevCommand(data.cmd, window.tdtDesktop)
      : isPluginCommand(data.cmd) ? await runPluginCommand(data.cmd, window.tdtDesktop, plugins)
        : isHeadersCommand(data.cmd) ? await runHeadersCommand(data.cmd, headersDeps())
          : isRulesCommand(data.cmd) ? await runRulesCommand(data.cmd, rulesDeps())
            : data.cmd && data.cmd.do === 'events_get' ? recentEvents(data.cmd)
              : runCommand(data.cmd, state, actions);
    const body = { id: data.id, ok: result.ok, detail: result.detail, data: result.data };
    await requestJson('/api/control/result', 'POST', body).catch(() => {});
    push(true); // what the command changed, now and not in a second
  }

  function connect() {
    source = new EventSource('/api/control/events');
    source.addEventListener('command', answer);
    source.onerror = () => {
      if (source && source.readyState === EventSource.CLOSED) disconnect();
    };
  }

  function disconnect() {
    if (source) source.close();
    source = null;
    last = '';
  }

  async function push(force = false) {
    if (!enabled) return;
    const text = JSON.stringify(snapshotOf(state));
    const now = Date.now();
    if (!force && text === last && now - lastAt < HEARTBEAT_MS) return;
    last = text;
    lastAt = now;
    await requestJson('/api/control/state', 'POST', JSON.parse(text)).catch(() => {});
  }

  async function refresh() {
    const res = await requestJson('/api/control/status').catch(() => null);
    const status = res && res.ok ? res.data : null;
    enabled = !!(status && status.enabled);
    if (enabled && !source) connect();
    if (!enabled && source) disconnect();
    const text = badgeText(status);
    badge.textContent = text;
    badge.title = text ? badgeTitle(status) : '';
    badge.hidden = !text;
  }

  window.addEventListener('tdt-control-changed', refresh); // the settings changed something
  setInterval(refresh, STATUS_MS);
  setInterval(() => push(false), SNAPSHOT_MS);
  refresh();
}
