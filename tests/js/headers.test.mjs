// The dialog of the headers of a channel (tdtlocal/static/js/lib/headers.js): the rows, what is wrong and what changed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATRES_HEADERS, MAX_HEADERS, changesFrom, isPlain, problemIn, rowsFrom, withKeep } from '../../tdtlocal/static/js/lib/headers.js';

const row = (name, value = '', secret = false, keep = false) => ({ name, value, secret, keep });

test('the rows come from what the server says, and a credential has no value to show', () => {
  const rows = rowsFrom([{ name: 'Referer', value: 'https://r/', secret: false }, { name: 'Cookie', value: null, secret: true }]);
  assert.deepEqual(rows, [{ name: 'Referer', value: 'https://r/', secret: false }, { name: 'Cookie', value: '', secret: true }]);
  assert.deepEqual(withKeep(rows).map((r) => r.keep), [false, true]);
  assert.deepEqual(rowsFrom(undefined), []);
  assert.equal(isPlain('REFERER'), true);
  assert.equal(isPlain('Cookie'), false);
});

test('what is wrong with the rows is said in words, and an empty form is fine', () => {
  assert.equal(problemIn([row('', '')]), '');
  assert.equal(problemIn([row('Referer', 'https://r/'), row('X-Token', 'abc')]), '');
  assert.match(problemIn([row('con espacio', 'x')]), /no es un nombre de cabecera válido/);
  assert.match(problemIn([row('Host', 'x')]), /la pone el propio programa/);
  assert.match(problemIn([row('Sec-Fetch-Mode', 'x')]), /la pone el propio programa/);
  assert.match(problemIn([row('Origin', 'a'), row('origin', 'b')]), /repetida/);
  assert.match(problemIn([row('Origin', '')]), /necesita un valor/);
  assert.match(problemIn([row('Origin', 'a\nb')]), /saltos de línea/);
  assert.match(problemIn([row('Origin', 'x'.repeat(601))]), /pasa de 600/);
  assert.match(problemIn(Array.from({ length: MAX_HEADERS + 1 }, (_, i) => row('X-' + i, 'v'))), /hasta 8/);
  assert.equal(problemIn([row('Cookie', '', true, true)]), '', 'a credential kept as it is needs no value');
  assert.match(problemIn([row('Cookie', '', true, false)]), /necesita un valor/, 'but one that is not kept does');
});

test('only what changed is sent: new, changed and removed headers', () => {
  const original = [row('Referer', 'https://r/'), row('Origin', 'https://o/'), row('Cookie', '', true)];
  assert.deepEqual(changesFrom(original, original.map((r) => ({ ...r }))), {}, 'nothing changed');
  const now = [row('Referer', 'https://nuevo/'), row('Cookie', '', true), row('X-Token', ' abc '), row('', '')];
  assert.deepEqual(changesFrom(original, now), { Referer: 'https://nuevo/', Origin: null, 'X-Token': 'abc' });
  assert.deepEqual(changesFrom(original, []), { Referer: null, Origin: null, Cookie: null }, 'every row removed');
  assert.deepEqual(changesFrom([], [row('Origin', 'https://o/')]), { Origin: 'https://o/' });
});

test('a credential is replaced when a value is typed, and a renamed header takes the new name', () => {
  const original = [row('Cookie', '', true), row('Referer', 'https://r/')];
  assert.deepEqual(changesFrom(original, [row('Cookie', 'a=nueva', true), row('Referer', 'https://r/')]), { Cookie: 'a=nueva' });
  assert.deepEqual(changesFrom(original, [row('Cookie', '', true), row('referer', 'https://r/')]), { Referer: null, referer: 'https://r/' });
  assert.deepEqual(changesFrom(original, [row('X-Cookie', 'a=b', true), row('Referer', 'https://r/')]), { Cookie: null, 'X-Cookie': 'a=b' });
});

test('the Atresplayer preset is Origin and Referer of Atresplayer and nothing else', () => {
  assert.deepEqual(Object.keys(ATRES_HEADERS).sort(), ['Origin', 'Referer']);
  assert.ok(Object.values(ATRES_HEADERS).every((v) => v.startsWith('https://www.atresplayer.com')));
});
