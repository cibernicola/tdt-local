// The inspector: what is happening in the page, in one timeline: the events (what happens), the calls of the plugins (what they ask) and what the rules
// do. Pure functions; ../inspector.js draws it. The calls carry no arguments and no answers: only who, what and how it ended.
import { describeEvent } from './events.js';

export const KINDS = { all: 'Todo', event: 'Eventos', call: 'Llamadas de plugins', rule: 'Reglas' };

const clock = (t) => new Date(t).toLocaleTimeString('es-ES');

/** How a call of a plugin reads: ``plugin · method · ok / E_PERMISSION · 3 ms``. */
export function describeCall(c) {
  return `${clock(c.t)} · ${c.plugin} · ${c.method} · ${c.code || 'ok'}${c.ms ? ` · ${c.ms} ms` : ''}`;
}

/** How a firing of a rule reads. */
export function describeFiring(r) {
  return `${clock(r.t)} · regla «${r.name}»${r.channel ? ` (${r.channel})` : ''} · ${r.ok ? 'hecho' : 'falló: ' + r.detail}`;
}

/**
 * What the plugins with all the power are doing, in a line: each one with its state (and its mistakes, and the last one if it was switched off), and the filters
 * somebody is using. ``plugins`` is ``trusted.list()`` and ``chains`` is ``hooks.chains()`` (static/js/hooks.js).
 */
export function describeHooks({ plugins = [], chains = [] } = {}) {
  if (!plugins.length && !chains.length) return 'Ningún plugin con ganchos.';
  const state = (p) => {
    const base = p.state === 'on' ? 'activo' : p.state === 'failed' ? 'apagado por fallos' : 'apagado';
    const errors = p.errors ? `, ${p.errors} ${p.errors === 1 ? 'fallo' : 'fallos'}` : '';
    return `${p.id} (${base}${errors}${p.state === 'failed' && p.error ? ': ' + p.error : ''})`;
  };
  const filters = chains.map((c) => `${c.name} ×${c.links}`).join(' · ');
  return `Plugins con ganchos: ${plugins.map(state).join(' · ') || 'ninguno'}.` + (filters ? ` Filtros en uso: ${filters}.` : '');
}

/**
 * The three logs as one timeline, newest first: ``[{t, kind, bad, text}]``. ``kind`` is one of ``KINDS`` (``all`` shows everything), ``text`` filters by
 * what the line says (any case), and ``limit`` caps what is shown.
 * @param {{events?: object[], calls?: object[], rules?: object[]}} logs
 */
export function timeline({ events = [], calls = [], rules = [] }, { kind = 'all', text = '', limit = 200 } = {}) {
  const lines = [
    ...events.map((e) => ({ t: e.t, kind: 'event', bad: false, text: describeEvent(e) })),
    ...calls.map((c) => ({ t: c.t, kind: 'call', bad: !!c.code, text: describeCall(c) })),
    ...rules.map((r) => ({ t: r.t, kind: 'rule', bad: !r.ok, text: describeFiring(r) })),
  ];
  const want = String(text).trim().toLowerCase();
  return lines
    .filter((l) => (kind === 'all' || l.kind === kind) && (!want || l.text.toLowerCase().includes(want)))
    .sort((a, b) => b.t - a.t)
    .slice(0, Math.max(1, limit));
}
