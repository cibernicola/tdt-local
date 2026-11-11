// The rules of the user («when this happens, do that»): this page is the one that carries them out, because it is the one that plays things.
// What a valid rule is, is decided by the server (tdtlocal/rules.py) when they are saved; the decisions of when one is due, what it does
// and how it reads are in lib/rules.js. A rule can only do what the control bus lets an AI do: nothing else runs.
import { api, postJson } from './api.js';
import { $, el } from './dom.js';
import { runCommand } from './lib/control.js';
import {
  RULES_EXAMPLE, RULES_INTRO, activeRules, createMemory, describeRule, dueByChannel, dueByKey, dueByProgramme, dueByTime, fire, isTyping, keyOf,
} from './lib/rules.js';
import { epgEntries, nowTs, state } from './state.js';
import { events, flushEvents } from './events.js';

const TICK_MS = 1000;
const PROGRAMME_EVERY = 10; // ticks between looks at the guide
const KEEP_LOG = 20;

/**
 * @param {{actions: object, footMsg: (t: string) => void}} app `actions` are the ones the control bus uses (setKind, play, multiWith, setVolume)
 */
let historyRef = [];

/** What the rules did (newest first), for the inspector. */
export const rulesHistory = () => historyRef.slice();

export function initRules(app) {
  const dlg = $('rulesDlg');
  const memory = createMemory();
  const history = []; // what the rules did, newest first
  historyRef = history;
  let rules = [];
  let brought = []; // [{plugin, enabled, rule, text}]: what plugins bring, off until the user turns it on
  const running = () => activeRules(rules, brought);
  let ticks = 0;
  let firing = false;

  const message = (t) => { $('rulesMsg').textContent = t; };

  async function load() {
    try {
      const r = await api('/api/rules');
      if (r.ok && r.data && Array.isArray(r.data.rules)) rules = r.data.rules;
      if (r.ok && r.data && Array.isArray(r.data.plugin_rules)) brought = r.data.plugin_rules;
    } catch { /* the server is not there: no rules, and nothing breaks */ }
  }

  function run(due) {
    for (const { rule, key, channel } of due) {
      if (!memory.allow(rule, key)) continue;
      firing = true;
      let result;
      try {
        result = fire(rule, (cmd) => runCommand(cmd, state, app.actions), app.footMsg);
      } finally {
        firing = false;
      }
      // what a rule did is told to everyone, marked as theirs (the rules by channel do not take it for the user's doing); after the event that
      // set it off has reached everybody, so that they hear things in the order they happened
      queueMicrotask(() => flushEvents('rule'));
      history.unshift({ t: Date.now(), name: rule.name || rule.id, ok: result.ok, detail: result.detail, channel: channel ? channel.name : '' });
      history.length = Math.min(history.length, KEEP_LOG);
    }
  }

  function tick() {
    if (firing) return;
    ticks += 1;
    const now = running();
    if (!now.length) return;
    run(dueByTime(now, new Date()));
    if (ticks % PROGRAMME_EVERY === 0) run(dueByProgramme(now, state.channels, epgEntries, nowTs()));
  }

  // ---- the dialog
  function showHistory() {
    $('rulesLog').textContent = history.length
      ? history.map((h) => `${new Date(h.t).toLocaleTimeString('es-ES')} · ${h.name}${h.channel ? ' (' + h.channel + ')' : ''} · ${h.ok ? 'hecho' : 'falló: ' + h.detail}`).join('\n')
      : 'Todavía no se ha cumplido ninguna.';
  }

  function showList() {
    const list = $('rulesList');
    list.replaceChildren(...(rules.length
      ? rules.map((r) => el('li', r.enabled === false ? 'off' : '', describeRule(r)))
      : [el('li', 'empty', 'No hay reglas. «Ejemplo» pone una para copiar.')]));
  }

  function showBrought() {
    const box = $('rulesBrought');
    box.hidden = !brought.length;
    $('rulesBroughtList').replaceChildren(...brought.map((b) => {
      const li = el('li');
      const label = el('label', 'chk');
      const check = el('input');
      check.type = 'checkbox';
      check.checked = b.enabled;
      check.addEventListener('change', async () => {
        try {
          await postJson('/api/rules/plugin/enable', { plugin: b.plugin, rule: b.rule.id, on: check.checked });
        } catch { check.checked = !check.checked; }
        await load();
      });
      label.append(check, ' ' + b.text, el('small', 'plugin-risk', ' · de «' + b.plugin + '»'));
      li.append(label);
      return li;
    }));
  }

  async function open() {
    await load();
    showBrought();
    message('');
    $('rulesText').value = JSON.stringify(rules, null, 2);
    showList();
    showHistory();
    dlg.showModal();
  }

  $('btnRules').addEventListener('click', open);
  $('rulesIntro').textContent = RULES_INTRO;
  $('rulesExample').addEventListener('click', () => {
    let current = [];
    try { current = JSON.parse($('rulesText').value || '[]'); } catch { /* the text is not valid: the example replaces it */ }
    $('rulesText').value = JSON.stringify([...(Array.isArray(current) ? current : []), ...RULES_EXAMPLE], null, 2);
  });
  $('rulesCancel').addEventListener('click', () => dlg.close());
  $('rulesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    let parsed;
    try {
      parsed = JSON.parse($('rulesText').value || '[]');
    } catch (error) {
      message('El texto no es JSON válido: ' + error.message);
      return;
    }
    let res;
    try {
      res = await (await postJson('/api/rules', { rules: parsed })).json();
    } catch { message('El servidor local no responde.'); return; }
    if (!res.ok) { message(res.error || 'No se pudieron guardar.'); return; }
    rules = res.rules;
    dlg.close();
    app.footMsg(rules.length === 1 ? 'Regla guardada.' : `${rules.length} reglas guardadas.`);
  });

  // a key a rule waits for (Ctrl or Alt + a letter, a number or F1-F12): never while the user types or a dialog is open
  document.addEventListener('keydown', (event) => {
    if (event.repeat || isTyping(event.target) || document.querySelector('dialog[open]')) return;
    const due = dueByKey(running(), keyOf(event));
    if (!due.length) return;
    event.preventDefault();
    run(due);
  });
  window.addEventListener('tdt-rules-changed', load); // an AI changed them through the control bus
  events.on('channel.changed', (_name, data) => { // the user (or an AI, or a plugin) put another channel: not a rule
    if (data.cause === 'rule' || firing) return;
    run(dueByChannel(running(), data));
  });
  setInterval(tick, TICK_MS);
  load();
}
