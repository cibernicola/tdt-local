// Rules («when this happens, do that»): which one is due, what it does, and how it reads. Pure functions: the module that
// listens to the player and runs the actions is ../rules.js. What a valid rule is, is decided by tdtlocal/rules.py (it checks every
// rule when it is saved); this file trusts the shape but never the contents, so a rule that is odd does nothing instead of breaking.
import { slug } from './text.js';

export const DAY_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
export const COOLDOWN_MS = 10_000; // a rule does not fire again within this (it could undo itself, or flood)
export const PROGRAMME_WINDOW = 90; // seconds: a programme «just started» if it began within this
export const MAX_SEEN = 500;

const isRule = (r) => !!r && typeof r === 'object' && r.when && typeof r.when === 'object' && Array.isArray(r.do) && r.enabled !== false;

const pad = (n) => String(n).padStart(2, '0');
export const hhmm = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** Does ``text`` (a name or id the rule gives) mean this channel? The same way a name is understood everywhere: ignoring case and accents. */
export function isChannel(ref, channel) {
  if (!channel || typeof ref !== 'string') return false;
  return ref === channel.id || slug(ref) === slug(String(channel.name || ''));
}

/** The rules that are due at this minute, each once per minute (the key says which minute: the caller remembers what it fired). */
export function dueByTime(rules, date) {
  const now = hhmm(date);
  const day = date.getDay();
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${now}`;
  const due = [];
  for (const rule of rules || []) {
    if (!isRule(rule) || rule.when.type !== 'time' || rule.when.at !== now) continue;
    if (Array.isArray(rule.when.days) && !rule.when.days.includes(day)) continue;
    due.push({ rule, key: `${rule.id}@${stamp}` });
  }
  return due;
}

let occurrence = 0;

/**
 * A key press as the text the rules use («Ctrl+Alt+Shift+K»), or ``''`` if it is not a key a rule can have: without Ctrl or Alt, or not a letter, a
 * digit or F1-F12. The physical key counts (``event.code``), so that Alt+1 is Alt+1 whatever the layout types.
 */
export function keyOf(event) {
  const code = String(event.code || '');
  const key = /^Key([A-Z])$/.exec(code)?.[1] || /^Digit([0-9])$/.exec(code)?.[1] || (/^F([1-9]|1[0-2])$/.test(code) ? code : '');
  if (!key || !(event.ctrlKey || event.altKey) || event.metaKey) return '';
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

/** The rules that wait for this key press. */
export function dueByKey(rules, combo) {
  const due = [];
  if (!combo) return due;
  for (const rule of rules || []) {
    if (isRule(rule) && rule.when.type === 'key' && rule.when.key === combo) {
      occurrence += 1;
      due.push({ rule, key: `${rule.id}@${combo}#${occurrence}` });
    }
  }
  return due;
}

/** Is the user typing? Then a key is theirs, not a rule's. */
export const isTyping = (target) => !!target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable === true);

/** The rules a plugin brings, as the engine runs them: only the ones the user turned on, with an id and a name that say whose they are. */
export function activeRules(own, brought) {
  const mine = (brought || []).filter((b) => b.enabled).map((b) => ({ ...b.rule, id: `${b.plugin}~${b.rule.id}`, name: `${b.rule.name || b.rule.id} (${b.plugin})`, enabled: true }));
  return [...(own || []), ...mine];
}

/** The rules that wait for this channel to become the active one. Each time it does is a new occurrence (a new key): only the cooldown limits them. */
export function dueByChannel(rules, channel) {
  const due = [];
  for (const rule of rules || []) {
    if (isRule(rule) && rule.when.type === 'channel' && isChannel(rule.when.channel, channel)) {
      occurrence += 1;
      due.push({ rule, key: `${rule.id}@${channel.id}#${occurrence}` });
    }
  }
  return due;
}

/**
 * The rules whose programme has just started, on the channel they name or on any channel of the list.
 * @param {object[]} rules
 * @param {object[]} channels the channels to look at
 * @param {(channel: object) => Array|undefined} entriesOf the programmes of a channel: [[start, end, title], ...]
 * @param {number} nowSec
 */
export function dueByProgramme(rules, channels, entriesOf, nowSec) {
  const due = [];
  for (const rule of rules || []) {
    if (!isRule(rule) || rule.when.type !== 'programme' || typeof rule.when.title !== 'string') continue;
    const wanted = slug(rule.when.title);
    if (!wanted) continue;
    const where = rule.when.channel ? (channels || []).filter((c) => isChannel(rule.when.channel, c)) : channels || [];
    for (const channel of where) {
      for (const entry of entriesOf(channel) || []) {
        if (entry[0] <= nowSec && nowSec - entry[0] < PROGRAMME_WINDOW && slug(String(entry[2] || '')).includes(wanted)) {
          due.push({ rule, channel, entry, key: `${rule.id}@${channel.id}@${entry[0]}` });
        }
      }
    }
  }
  return due;
}

/** One action as the control bus understands it (``tdtlocal/control.py``), or ``null`` for the ones the page does by itself (a notice). */
export function commandOf(action) {
  switch (action && action.action) {
    case 'play': return { do: 'play', channel: action.channel };
    case 'kind': return { do: 'kind', kind: action.kind };
    case 'volume': return { do: 'volume', value: action.value };
    case 'mute': return { do: 'mute', on: action.on === true };
    case 'multi': return { do: 'multi', channels: action.channels, rotate: action.rotate };
    default: return null;
  }
}

/**
 * Do what a rule says, in order. A notice (``toast``) goes to ``notify``; the rest are commands, run by ``run`` (``{ok, detail}``).
 * An action that fails does not stop the following ones. Never throws. Returns what happened, for the list of what the rules did.
 */
export function fire(rule, run, notify) {
  const steps = [];
  for (const action of Array.isArray(rule.do) ? rule.do : []) {
    try {
      const command = commandOf(action);
      if (command) steps.push(run(command));
      else if (action && action.action === 'toast' && typeof action.text === 'string') {
        notify(action.text);
        steps.push({ ok: true, detail: 'aviso' });
      } else steps.push({ ok: false, detail: 'acción desconocida' });
    } catch (error) {
      steps.push({ ok: false, detail: String((error && error.message) || error) });
    }
  }
  const failed = steps.filter((s) => !s.ok);
  return { ok: !failed.length, detail: failed.length ? failed.map((s) => s.detail).join('; ') : steps.map((s) => s.detail).join(', ') };
}

/** What the rules remember so that one does not fire twice for the same thing, nor too often. */
export function createMemory(now = () => Date.now()) {
  const seen = new Set();
  const last = new Map();
  return {
    /** ``true`` if this firing may go ahead (and it is remembered); ``false`` if the same one was done already or the rule fired a moment ago. */
    allow(rule, key) {
      if (seen.has(key)) return false;
      if (now() - (last.get(rule.id) || 0) < COOLDOWN_MS) return false;
      seen.add(key);
      if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
      last.set(rule.id, now());
      return true;
    },
  };
}

const actionText = (a) => {
  switch (a && a.action) {
    case 'play': return `poner «${a.channel}»`;
    case 'kind': return { tv: 'cambiar a televisión', radio: 'cambiar a radio', u7d: 'cambiar a los últimos 7 días' }[a.kind] || 'cambiar de lista';
    case 'volume': return `volumen al ${Math.round(Number(a.value) * 100)} %`;
    case 'mute': return a.on ? 'silenciar' : 'quitar el silencio';
    case 'multi': return 'multivisión con ' + (a.channels || []).map((c) => `«${c}»`).join(', ');
    case 'toast': return `avisar «${a.text}»`;
    default: return 'algo que no entiendo';
  }
};

/** A rule in one sentence, for the list. */
export function describeRule(rule) {
  const w = rule.when || {};
  let when;
  if (w.type === 'key') when = `al pulsar ${w.key}`;
  else if (w.type === 'time') when = `a las ${w.at}` + (Array.isArray(w.days) ? ` (${w.days.map((d) => DAY_NAMES[d]).join(', ')})` : '');
  else if (w.type === 'channel') when = `cuando se ponga «${w.channel}»`;
  else if (w.type === 'programme') when = `cuando empiece un programa con «${w.title}»` + (w.channel ? ` en «${w.channel}»` : '');
  else when = 'en un momento que no entiendo';
  return `${rule.name || rule.id}: ${when} → ${(rule.do || []).map(actionText).join('; ')}` + (rule.enabled === false ? ' (apagada)' : '');
}

export const RULES_INTRO = 'Una regla dice «cuando pase esto, haz aquello», sin código. Cuando: a una hora (con días), al pulsar una tecla (Ctrl o Alt más una letra, un número o F1 a F12), al poner un canal o al empezar un programa '
  + 'cuyo título contenga un texto. Hacer: poner un canal, cambiar entre televisión y radio, el volumen, el silencio, una multivisión o un aviso. '
  + 'Se editan como texto (JSON): «Ejemplo» pone uno para copiar. Una IA puede escribirlas por MCP, y siempre te las enseña antes de guardarlas.';

export const RULES_EXAMPLE = [
  {
    id: 'noticias-de-las-21', name: 'Noticias a las 21', enabled: true,
    when: { type: 'time', at: '21:00', days: [1, 2, 3, 4, 5] },
    do: [{ action: 'play', channel: 'La 1' }, { action: 'volume', value: 0.4 }, { action: 'toast', text: 'Empieza el Telediario' }],
  },
];

/** The question to the user about the rules an AI wants to set: all of them, each in a sentence, marking what changes. */
export function describeRuleChange(before, after) {
  const was = new Map((before || []).map((r) => [r.id, JSON.stringify(r)]));
  const now = new Set((after || []).map((r) => r.id));
  const lines = (after || []).map((r) => `  • ${!was.has(r.id) ? '[nueva] ' : was.get(r.id) !== JSON.stringify(r) ? '[cambia] ' : ''}${describeRule(r)}`);
  for (const r of before || []) if (!now.has(r.id)) lines.push(`  • [se quita] ${r.name || r.id}`);
  return {
    message: 'Una IA quiere cambiar tus reglas de automatización',
    detail: `Quedarían estas reglas:\n${lines.join('\n') || '  (ninguna)'}\n\nTDT local las cumplirá solas mientras esté abierto: cambiar de canal, `
      + 'el volumen y avisos, nada más. Puedes apagarlas o quitarlas cuando quieras en el botón «Reglas».',
  };
}

/**
 * Do a command about the rules (the ones of the control bus). Reading goes to the server; replacing ends in a question to the user in a window
 * of the system, which only the desktop app has. Never throws: it answers ``{ok, detail, data?}``.
 * @param {{get: () => Promise<{ok: boolean, data: any}>, post: (rules: object[]) => Promise<{ok: boolean, data: any}>,
 *          confirm?: (message: string, detail: string) => Promise<boolean>, changed?: (rules: object[]) => void}} deps
 */
export async function runRulesCommand(cmd, { get, post, confirm, changed }) {
  try {
    const found = await get();
    if (!found.ok) return { ok: false, detail: 'no se pudieron leer las reglas' };
    const current = found.data.rules || [];
    if (cmd.do === 'rules_get') {
      return { ok: true, detail: `${current.length} reglas`, data: { rules: current.map((r) => ({ ...r, text: describeRule(r) })), plugin_rules: found.data.plugin_rules || [] } };
    }
    if (cmd.do !== 'rules_set') return { ok: false, detail: 'orden desconocida' };
    if (!confirm) return { ok: false, detail: 'cambiar las reglas por MCP necesita la aplicación de escritorio: el usuario lo confirma en una ventana del sistema' };
    const ask = describeRuleChange(current, cmd.rules);
    if (!(await confirm(ask.message, ask.detail))) return { ok: false, detail: 'el usuario no ha aceptado las reglas' };
    const done = await post(cmd.rules);
    if (!done.ok) return { ok: false, detail: String((done.data && done.data.error) || 'no se pudieron guardar').slice(0, 300) };
    if (changed) changed(done.data.rules);
    return { ok: true, detail: `${done.data.rules.length} reglas guardadas`, data: { rules: done.data.rules } };
  } catch (error) {
    return { ok: false, detail: 'error: ' + ((error && error.message) || error) };
  }
}

/** Is this a command about the rules? */
export const isRulesCommand = (cmd) => !!cmd && typeof cmd.do === 'string' && cmd.do.startsWith('rules_');
