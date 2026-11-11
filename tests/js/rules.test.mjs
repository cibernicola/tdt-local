// Rules (tdtlocal/static/js/lib/rules.js): which one is due, what it does and how it is explained.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COOLDOWN_MS, PROGRAMME_WINDOW, RULES_EXAMPLE, commandOf, createMemory, describeRule, describeRuleChange, dueByChannel, dueByProgramme,
  dueByTime, fire, isChannel, isRulesCommand, runRulesCommand,
} from '../../tdtlocal/static/js/lib/rules.js';

const rule = (extra = {}) => ({
  id: 'r1', name: 'Regla', enabled: true, when: { type: 'time', at: '21:00' }, do: [{ action: 'play', channel: 'La 1' }], ...extra,
});
const at = (h, m, day = 3) => { // 2026-11-04 is a Wednesday (3)
  const d = new Date(2026, 10, 4 + (day - 3), h, m, 5);
  return d;
};

test('a channel is meant by its id or its name, whatever the case and the accents', () => {
  const la1 = { id: 'la-1', name: 'La 1' };
  assert.equal(isChannel('la-1', la1), true);
  assert.equal(isChannel('LA 1', la1), true);
  assert.equal(isChannel('Teledeporte', la1), false);
  assert.equal(isChannel('La 1', null), false);
  assert.equal(isChannel(5, la1), false);
  assert.equal(isChannel('Cuatro', { id: 'c', name: 'Cuátro' }), true);
});

test('a rule by time is due at that minute, on its days, and once for that minute', () => {
  const rules = [rule(), rule({ id: 'r2', when: { type: 'time', at: '21:00', days: [1, 2] } }), rule({ id: 'r3', enabled: false })];
  const due = dueByTime(rules, at(21, 0));
  assert.deepEqual(due.map((d) => d.rule.id), ['r1'], 'r2 is only on Monday and Tuesday, r3 is off');
  assert.deepEqual(dueByTime(rules, at(21, 0, 1)).map((d) => d.rule.id), ['r1', 'r2']);
  assert.deepEqual(dueByTime(rules, at(21, 1)), []);
  assert.equal(dueByTime(rules, at(21, 0))[0].key, dueByTime(rules, at(21, 0))[0].key, 'the same minute has the same key');
  assert.notEqual(dueByTime(rules, at(21, 0))[0].key, dueByTime(rules, at(21, 0, 4))[0].key, 'another day, another key');
});

test('a rule by channel waits for that channel', () => {
  const rules = [rule({ when: { type: 'channel', channel: 'La 2' } })];
  assert.equal(dueByChannel(rules, { id: 'la-2', name: 'La 2' }).length, 1);
  assert.equal(dueByChannel(rules, { id: 'la-1', name: 'La 1' }).length, 0);
});

test('a rule by programme fires when it has just started, on the channel it names or on any', () => {
  const now = 10_000;
  const channels = [{ id: 'la-1', name: 'La 1', epg: 'a' }, { id: 'la-2', name: 'La 2', epg: 'b' }];
  const guide = { 'la-1': [[now - 20, now + 3000, 'Telediario 2']], 'la-2': [[now - 20, now + 3000, 'Cine']] };
  const entriesOf = (c) => guide[c.id];
  const any = [rule({ when: { type: 'programme', title: 'telediario' } })];
  assert.deepEqual(dueByProgramme(any, channels, entriesOf, now).map((d) => d.channel.id), ['la-1']);
  const named = [rule({ when: { type: 'programme', title: 'cine', channel: 'La 2' } })];
  assert.equal(dueByProgramme(named, channels, entriesOf, now).length, 1);
  const wrong = [rule({ when: { type: 'programme', title: 'cine', channel: 'La 1' } })];
  assert.equal(dueByProgramme(wrong, channels, entriesOf, now).length, 0);
  assert.equal(dueByProgramme(any, channels, entriesOf, now + PROGRAMME_WINDOW + 1).length, 0, 'it started a while ago');
  assert.equal(dueByProgramme(any, channels, () => undefined, now).length, 0, 'a channel without guide');
  const key = dueByProgramme(any, channels, entriesOf, now)[0].key;
  assert.equal(key, dueByProgramme(any, channels, entriesOf, now + 5)[0].key, 'the same programme has the same key');
});

test('a rule that is odd does nothing instead of breaking', () => {
  const odd = [null, 5, {}, { id: 'x' }, { id: 'x', when: 5, do: [] }, rule({ when: { type: 'programme' } }), rule({ when: { type: 'programme', title: 7 } }), rule({ do: 'no' }), rule()];
  assert.deepEqual(dueByTime(odd, at(21, 0)).map((d) => d.rule.id), ['r1'], 'only the one that is fine');
  assert.deepEqual(dueByChannel(odd, { id: 'a', name: 'b' }), []);
  assert.deepEqual(dueByProgramme(odd, [{ id: 'a', name: 'b' }], () => [[0, 99, 'x']], 5), []);
  assert.deepEqual(dueByTime(undefined, at(21, 0)), []);
});

test('each action is the command the control bus knows', () => {
  assert.deepEqual(commandOf({ action: 'play', channel: 'La 1' }), { do: 'play', channel: 'La 1' });
  assert.deepEqual(commandOf({ action: 'kind', kind: 'radio' }), { do: 'kind', kind: 'radio' });
  assert.deepEqual(commandOf({ action: 'volume', value: 0.3 }), { do: 'volume', value: 0.3 });
  assert.deepEqual(commandOf({ action: 'mute', on: true }), { do: 'mute', on: true });
  assert.deepEqual(commandOf({ action: 'multi', channels: ['a', 'b'] }), { do: 'multi', channels: ['a', 'b'], rotate: undefined });
  assert.equal(commandOf({ action: 'toast', text: 'x' }), null, 'a notice is the page\'s own');
  assert.equal(commandOf({ action: 'eval', code: '1' }), null);
  assert.equal(commandOf(null), null);
});

test('firing a rule does its actions in order, notices go to the screen, and a failure does not stop the rest', () => {
  const ran = [];
  const said = [];
  const run = (c) => { ran.push(c.do); return c.do === 'volume' ? { ok: false, detail: 'sin canal' } : { ok: true, detail: c.do }; };
  const done = fire(rule({ do: [{ action: 'play', channel: 'La 1' }, { action: 'volume', value: 0.2 }, { action: 'toast', text: 'hola' }] }), run, (t) => said.push(t));
  assert.deepEqual(ran, ['play', 'volume']);
  assert.deepEqual(said, ['hola'], 'the notice still came after the failure');
  assert.deepEqual(done, { ok: false, detail: 'sin canal' });
  assert.equal(fire(rule({ do: [{ action: 'toast', text: 'a' }] }), run, () => {}).ok, true);
  assert.equal(fire(rule({ do: [{ action: 'eval' }] }), run, () => {}).ok, false, 'an unknown action is a failure, not a crash');
  assert.equal(fire(rule(), () => { throw new Error('roto'); }, () => {}).detail, 'roto');
});

test('a rule does not fire twice for the same thing, nor again within a few seconds', () => {
  let clock = 1_000_000;
  const memory = createMemory(() => clock);
  const r = rule();
  assert.equal(memory.allow(r, 'a'), true);
  assert.equal(memory.allow(r, 'a'), false, 'the same key');
  assert.equal(memory.allow(r, 'b'), false, 'too soon');
  clock += COOLDOWN_MS;
  assert.equal(memory.allow(r, 'b'), true);
  assert.equal(memory.allow(rule({ id: 'otra' }), 'c'), true, 'another rule has its own clock');
});

test('a rule is read as a sentence', () => {
  assert.equal(
    describeRule(rule({ name: 'Noticias', when: { type: 'time', at: '21:00', days: [1, 3] }, do: [{ action: 'play', channel: 'La 1' }, { action: 'volume', value: 0.4 }] })),
    'Noticias: a las 21:00 (lun, mié) → poner «La 1»; volumen al 40 %',
  );
  assert.match(describeRule(rule({ when: { type: 'channel', channel: 'La 2' }, do: [{ action: 'mute', on: true }] })), /cuando se ponga «La 2» → silenciar/);
  assert.match(describeRule(rule({ when: { type: 'programme', title: 'Cine', channel: 'La 2' }, do: [{ action: 'toast', text: 'hay cine' }] })), /programa con «Cine» en «La 2» → avisar «hay cine»/);
  assert.match(describeRule(rule({ enabled: false })), /\(apagada\)$/);
  assert.match(describeRule({ id: 'x', when: {}, do: [{ action: 'raro' }] }), /no entiendo/);
  assert.equal(describeRule(RULES_EXAMPLE[0]).startsWith('Noticias a las 21'), true);
});

test('the question about a change lists every rule and says what changes', () => {
  const before = [rule({ id: 'a' }), rule({ id: 'b' }), rule({ id: 'c' })];
  const after = [rule({ id: 'a' }), rule({ id: 'b', name: 'Otra' }), rule({ id: 'd' })];
  const ask = describeRuleChange(before, after);
  assert.match(ask.message, /cambiar tus reglas/);
  assert.match(ask.detail, /\[cambia\] Otra/);
  assert.match(ask.detail, /\[nueva\] Regla/);
  assert.match(ask.detail, /\[se quita\] Regla/);
  assert.doesNotMatch(ask.detail, /\[nueva\] .*\n.*\[nueva\]/);
  assert.match(describeRuleChange([], []).detail, /\(ninguna\)/);
});

test('the commands of the bus: reading goes to the server, replacing asks the user first', async () => {
  const stored = [rule({ id: 'a' })];
  const calls = [];
  const deps = {
    get: async () => ({ ok: true, data: { rules: stored } }),
    post: async (rules) => { calls.push(['post', rules.length]); return { ok: true, data: { rules } }; },
    confirm: async () => true,
    changed: (rules) => calls.push(['changed', rules.length]),
  };
  assert.equal(isRulesCommand({ do: 'rules_get' }), true);
  assert.equal(isRulesCommand({ do: 'play' }), false);
  const read = await runRulesCommand({ do: 'rules_get' }, deps);
  assert.equal(read.ok, true);
  assert.match(read.data.rules[0].text, /Regla: a las 21:00/);
  const set = await runRulesCommand({ do: 'rules_set', rules: [rule({ id: 'a' }), rule({ id: 'b' })] }, deps);
  assert.deepEqual([set.ok, set.detail], [true, '2 reglas guardadas']);
  assert.deepEqual(calls, [['post', 2], ['changed', 2]]);

  calls.length = 0;
  const refused = await runRulesCommand({ do: 'rules_set', rules: [] }, { ...deps, confirm: async () => false });
  assert.deepEqual([refused.ok, refused.detail], [false, 'el usuario no ha aceptado las reglas']);
  assert.deepEqual(calls, [], 'nothing was saved');
  const noWindow = await runRulesCommand({ do: 'rules_set', rules: [] }, { ...deps, confirm: undefined });
  assert.match(noWindow.detail, /aplicación de escritorio/);
  const broken = await runRulesCommand({ do: 'rules_set', rules: [] }, { ...deps, post: async () => ({ ok: false, data: { error: 'regla «x»: mal' } }) });
  assert.match(broken.detail, /regla «x»/);
  assert.equal((await runRulesCommand({ do: 'rules_get' }, { ...deps, get: async () => ({ ok: false }) })).ok, false);
  assert.equal((await runRulesCommand({ do: 'rules_get' }, { ...deps, get: async () => { throw new Error('caído'); } })).detail, 'error: caído');
  assert.equal((await runRulesCommand({ do: 'rules_nope' }, deps)).detail, 'orden desconocida');
});

test('a key press becomes the text the rules use, and only a key with Ctrl or Alt counts', async () => {
  const { keyOf, dueByKey, isTyping, activeRules } = await import('../../tdtlocal/static/js/lib/rules.js');
  const press = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  assert.equal(keyOf(press('Digit1', { altKey: true })), 'Alt+1');
  assert.equal(keyOf(press('KeyK', { ctrlKey: true, altKey: true, shiftKey: true })), 'Ctrl+Alt+Shift+K');
  assert.equal(keyOf(press('F5', { ctrlKey: true })), 'Ctrl+F5');
  assert.equal(keyOf(press('F12', { altKey: true })), 'Alt+F12');
  for (const nope of [press('Digit1'), press('KeyA', { shiftKey: true }), press('F13', { altKey: true }), press('Space', { altKey: true }), press('Digit1', { altKey: true, metaKey: true }), press('')]) {
    assert.equal(keyOf(nope), '', JSON.stringify(nope));
  }
  const rules = [rule({ id: 'k1', when: { type: 'key', key: 'Alt+1' } }), rule({ id: 'k2', when: { type: 'key', key: 'Alt+2' } }), rule({ id: 'off', enabled: false, when: { type: 'key', key: 'Alt+1' } })];
  assert.deepEqual(dueByKey(rules, 'Alt+1').map((d) => d.rule.id), ['k1']);
  assert.notEqual(dueByKey(rules, 'Alt+1')[0].key, dueByKey(rules, 'Alt+1')[0].key, 'each press is its own occasion');
  assert.deepEqual(dueByKey(rules, ''), []);
  assert.equal(isTyping({ tagName: 'INPUT' }), true);
  assert.equal(isTyping({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTyping({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTyping({ tagName: 'BUTTON' }), false);
  assert.equal(isTyping(null), false);
  assert.match(describeRule(rule({ when: { type: 'key', key: 'Alt+1' } })), /al pulsar Alt\+1/);
  const brought = [{ plugin: 'mi-plugin', enabled: true, rule: rule({ id: 'a', name: 'Una', enabled: false }) }, { plugin: 'mi-plugin', enabled: false, rule: rule({ id: 'b' }) }];
  const active = activeRules([rule({ id: 'mia' })], brought);
  assert.deepEqual(active.map((r) => r.id), ['mia', 'mi-plugin~a'], 'only the ones the user turned on, with ids that say whose they are');
  assert.equal(active[1].name, 'Una (mi-plugin)');
  assert.equal(active[1].enabled, true, 'what the plugin wrote as «enabled» does not matter: the user chose');
  assert.deepEqual(activeRules(undefined, undefined), []);
});

test('the rules a manifest brings are checked for their shape here and for their contents by the server', async () => {
  const { readBroughtRules, MAX_BROUGHT_RULES } = await import('../../desktop/lib/plugin-api.js');
  assert.deepEqual(readBroughtRules(undefined), { list: [], problems: [] });
  assert.equal(readBroughtRules([{ id: 'a' }]).list.length, 1);
  for (const wrong of ['x', {}, [5], [null], [[]], Array.from({ length: MAX_BROUGHT_RULES + 1 }, () => ({}))]) {
    const r = readBroughtRules(wrong);
    assert.equal(r.list.length, 0);
    assert.match(r.problems[0], /tdt\.rules/);
  }
});
