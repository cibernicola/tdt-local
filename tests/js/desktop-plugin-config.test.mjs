// The settings a plugin declares (desktop/lib/plugin-config.js): the schema is checked, the values are checked, and nothing but the user changes them.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MAX_FIELDS, applyChanges, cleanValue, createConfigStore, formOf, readSettings, valuesOf,
} from '../../desktop/lib/plugin-config.js';
import { readUiPlugin } from '../../desktop/lib/plugin-api.js';
import { settingHint, settingValue } from '../../tdtlocal/static/js/lib/plugins-panel.js';

const declared = {
  ciudad: { type: 'choice', label: 'Ciudad', options: ['Madrid', 'Sevilla'], default: 'Sevilla' },
  grande: { type: 'boolean', label: 'Letra grande' },
  segundos: { type: 'number', label: 'Segundos', min: 5, max: 600, default: 20 },
  saludo: { type: 'string', maxLength: 10, default: 'Hola', help: 'Lo que dice' },
};

test('a schema is read with every limit filled in, so nobody has to guess', () => {
  const { fields, problems } = readSettings(declared);
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(fields), ['ciudad', 'grande', 'segundos', 'saludo']);
  assert.equal(fields.grande.default, false, 'a boolean without default is off');
  assert.equal(fields.saludo.label, 'saludo', 'no label: the name');
  assert.equal(fields.saludo.help, 'Lo que dice');
  assert.deepEqual(readSettings(undefined), { fields: {}, problems: [] });
  assert.equal(readSettings({ a: { type: 'number' } }).fields.a.default, 0, 'a number without default is its minimum');
  assert.equal(readSettings({ a: { type: 'choice', options: ['x', 'y'] } }).fields.a.default, 'x');
  assert.equal(readSettings({ a: { type: 'string', maxLength: 99999 } }).fields.a.maxLength, 200, 'a limit that is too big falls to the usual');
});

test('what is wrong in a schema is said, field by field', () => {
  const wrong = [
    [5, /objeto/],
    [[], /objeto/],
    [{ Mayuscula: { type: 'string' } }, /nombre empieza por una letra minúscula/],
    [{ a: { type: 'color' } }, /type/],
    [{ a: 'texto' }, /type/],
    [{ a: { type: 'choice', options: ['solo uno'] } }, /options/],
    [{ a: { type: 'choice', options: ['a', 'a'] } }, /options/],
    [{ a: { type: 'choice', options: ['a', 5] } }, /options/],
    [{ a: { type: 'number', min: 10, max: 1 } }, /«min» es mayor/],
    [{ a: { type: 'number', min: 0, max: 5, default: 9 } }, /valor por defecto/],
    [{ a: { type: 'boolean', default: 'si' } }, /valor por defecto/],
    [{ a: { type: 'choice', options: ['a', 'b'], default: 'c' } }, /valor por defecto/],
    [{ a: { type: 'string', maxLength: 3, default: 'largo' } }, /valor por defecto/],
    [Object.fromEntries(Array.from({ length: MAX_FIELDS + 1 }, (_, i) => ['f' + i, { type: 'boolean' }])), /demasiados/],
  ];
  for (const [raw, pattern] of wrong) {
    const { problems } = readSettings(raw);
    assert.ok(problems.some((p) => pattern.test(p)), `${JSON.stringify(raw).slice(0, 60)} → ${problems.join(' / ')}`);
  }
});

test('a value is checked against its field', () => {
  const { fields } = readSettings(declared);
  assert.deepEqual(cleanValue('segundos', fields.segundos, 30), { ok: true, value: 30 });
  for (const [name, value, pattern] of [
    ['segundos', 4, /entre 5 y 600/], ['segundos', '30', /número/], ['segundos', Infinity, /número/], ['segundos', NaN, /número/],
    ['ciudad', 'Bilbao', /uno de: Madrid, Sevilla/], ['grande', 'si', /true o false/],
    ['saludo', 'demasiado largo', /pasa de 10/], ['saludo', 'a\nb', /saltos de línea/], ['saludo', 5, /texto/],
  ]) {
    const r = cleanValue(name, fields[name], value);
    assert.equal(r.ok, false, `${name}=${value}`);
    assert.match(r.error, pattern);
  }
});

test('the plugin sees what the user chose where it still holds, and the default everywhere else', () => {
  const { fields } = readSettings(declared);
  assert.deepEqual(valuesOf(fields, {}), { ciudad: 'Sevilla', grande: false, segundos: 20, saludo: 'Hola' });
  assert.deepEqual(valuesOf(fields, { ciudad: 'Madrid', segundos: 99999, extra: 1 }), { ciudad: 'Madrid', grande: false, segundos: 20, saludo: 'Hola' }, 'a stale value and a stranger are ignored');
  assert.deepEqual(valuesOf(undefined, { a: 1 }), {});
  const form = formOf(fields, { grande: true });
  assert.equal(form.find((f) => f.name === 'grande').value, true);
  assert.equal(form.find((f) => f.name === 'ciudad').options.length, 2);
});

test('a change is all or nothing', () => {
  const { fields } = readSettings(declared);
  const ok = applyChanges(fields, { ciudad: 'Madrid' }, { segundos: 45, grande: true });
  assert.deepEqual(ok, { ok: true, values: { ciudad: 'Madrid', grande: true, segundos: 45, saludo: 'Hola' } });
  assert.match(applyChanges(fields, {}, { segundos: 45, ciudad: 'Bilbao' }).error, /uno de/);
  assert.match(applyChanges(fields, {}, { inventado: 1 }).error, /ningún ajuste «inventado»/);
  assert.match(applyChanges(fields, {}, {}).error, /nada que cambiar/);
  assert.match(applyChanges(fields, {}, 'x').error, /nada que cambiar/);
  assert.equal(applyChanges(fields, {}, { __proto__: null, toString: 1 }).ok, false, 'not a name of the plugin');
});

test('the values are kept in a file and survive a restart, and a damaged file is not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tdt-config-'));
  try {
    const file = join(dir, 'sub', 'plugin-config.json');
    const store = createConfigStore(file);
    assert.deepEqual(store.get('uno'), {});
    store.set('uno', { ciudad: 'Madrid' });
    assert.deepEqual(createConfigStore(file).get('uno'), { ciudad: 'Madrid' });
    store.remove('uno');
    assert.deepEqual(createConfigStore(file).get('uno'), {});
    writeFileSync(file, '{', 'utf8');
    assert.deepEqual(createConfigStore(file).get('uno'), {});
    writeFileSync(file, '[1]', 'utf8');
    assert.deepEqual(createConfigStore(file).get('uno'), {});
    const again = createConfigStore(file);
    again.set('dos', { grande: true });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).dos.grande, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest with settings is read, and one with a wrong setting cannot be used', () => {
  const read = (settings) => readUiPlugin({ name: 'P', tdt: { api: 1, settings } }, '/x', { id: 'p', name: 'P', problems: [] }, () => true);
  const good = read(declared);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(Object.keys(good.settings), ['ciudad', 'grande', 'segundos', 'saludo']);
  assert.deepEqual(read(undefined).settings, {});
  assert.ok(read({ a: { type: 'color' } }).problems.some((p) => /type/.test(p)), 'it cannot be activated');
});

test('what a form gives becomes the type the app expects', () => {
  const number = { type: 'number', label: 'Segundos', min: 5, max: 600 };
  assert.deepEqual(settingValue(number, '30'), { ok: true, value: 30 });
  assert.deepEqual(settingValue(number, '2,5'), { ok: true, value: 2.5 }, 'a Spanish decimal comma');
  assert.match(settingValue(number, '').error, /necesita un número/);
  assert.match(settingValue(number, 'abc').error, /necesita un número/);
  assert.deepEqual(settingValue({ type: 'boolean' }, true), { ok: true, value: true });
  assert.deepEqual(settingValue({ type: 'boolean' }, 'on'), { ok: true, value: false }, 'only a ticked box is true');
  assert.deepEqual(settingValue({ type: 'string' }, 'hola'), { ok: true, value: 'hola' });
  assert.equal(settingHint(number), 'de 5 a 600');
  assert.equal(settingHint({ type: 'string', maxLength: 80, help: 'Algo' }), 'Algo · hasta 80 caracteres');
  assert.equal(settingHint({ type: 'boolean' }), '');
});
