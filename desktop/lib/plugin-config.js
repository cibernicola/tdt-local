// The settings of a plugin with permissions, generated from its manifest: the plugin declares what it lets the user choose
// (`tdt.settings`), the app draws the form in Ajustes ▸ Plugins, checks and keeps the values, and the plugin reads them with
// `tdt.config.get(name)`. The plugin draws nothing and can change nothing: the user does. Pure functions, plus a small store.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MAX_FIELDS = 20;
export const MAX_OPTIONS = 20;
export const MAX_TEXT = 500;
export const FIELD = /^[a-z][A-Za-z0-9_]{0,31}$/;
export const TYPES = ['string', 'number', 'boolean', 'choice'];

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** One value against its field: `{ok: true, value}` (cleaned) or `{ok: false, error}` in words. */
export function cleanValue(name, field, value) {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: `«${name}» tiene que ser true o false` };
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: `«${name}» tiene que ser un número` };
      if (value < field.min || value > field.max) return { ok: false, error: `«${name}» tiene que estar entre ${field.min} y ${field.max}` };
      return { ok: true, value };
    }
    case 'choice':
      return field.options.includes(value) ? { ok: true, value } : { ok: false, error: `«${name}» tiene que ser uno de: ${field.options.join(', ')}` };
    default: {
      if (typeof value !== 'string') return { ok: false, error: `«${name}» tiene que ser un texto` };
      if (value.length > field.maxLength) return { ok: false, error: `«${name}» pasa de ${field.maxLength} caracteres` };
      if (/[\u0000-\u001f]/.test(value)) return { ok: false, error: `«${name}» no puede llevar saltos de línea ni caracteres de control` };
      return { ok: true, value };
    }
  }
}

/**
 * The schema a manifest declares, checked: `{fields, problems}`. `fields` is `{name: {type, label, default, ...}}` with every limit filled in, so the form and the
 * check never have to guess; what is wrong goes to `problems`, in words, and the plugin is not usable until it is fixed.
 */
export function readSettings(raw) {
  const fields = {};
  const problems = [];
  if (raw === undefined) return { fields, problems };
  if (!plain(raw)) return { fields, problems: ['«tdt.settings» tiene que ser un objeto {nombre: campo}'] };
  const names = Object.keys(raw);
  if (names.length > MAX_FIELDS) problems.push(`«tdt.settings» tiene demasiados campos (hasta ${MAX_FIELDS})`);
  for (const name of names.slice(0, MAX_FIELDS)) {
    const f = raw[name];
    const at = `ajuste «${name.slice(0, 40)}»`;
    if (!FIELD.test(name)) { problems.push(`${at}: el nombre empieza por una letra minúscula y lleva letras, números o _ (hasta 32)`); continue; }
    if (!plain(f) || !TYPES.includes(f.type)) { problems.push(`${at}: «type» tiene que ser ${TYPES.join(', ')}`); continue; }
    const label = typeof f.label === 'string' && f.label.trim() ? f.label.trim().slice(0, 80) : name;
    const field = { type: f.type, label, help: typeof f.help === 'string' ? f.help.trim().slice(0, 200) : '' };
    if (f.type === 'number') {
      field.min = Number.isFinite(f.min) ? f.min : 0;
      field.max = Number.isFinite(f.max) ? f.max : 1_000_000;
      if (field.min > field.max) { problems.push(`${at}: «min» es mayor que «max»`); continue; }
    } else if (f.type === 'choice') {
      const options = f.options;
      if (!Array.isArray(options) || options.length < 2 || options.length > MAX_OPTIONS
        || options.some((o) => typeof o !== 'string' || !o || o.length > 60) || new Set(options).size !== options.length) {
        problems.push(`${at}: «options» son de 2 a ${MAX_OPTIONS} textos distintos de hasta 60 caracteres`);
        continue;
      }
      field.options = [...options];
    } else if (f.type === 'string') {
      field.maxLength = Number.isInteger(f.maxLength) && f.maxLength >= 1 && f.maxLength <= MAX_TEXT ? f.maxLength : 200;
    }
    const fallback = { boolean: false, number: field.min, choice: field.options && field.options[0], string: '' }[f.type];
    const given = f.default === undefined ? { ok: true, value: fallback } : cleanValue(name, field, f.default);
    if (!given.ok) { problems.push(`${at}: el valor por defecto no vale (${given.error})`); continue; }
    field.default = given.value;
    fields[name] = field;
  }
  return { fields, problems };
}

/** The values a plugin sees: what the user chose where it is still valid, the default everywhere else. */
export function valuesOf(fields, stored) {
  const out = {};
  for (const [name, field] of Object.entries(fields || {})) {
    const have = stored && Object.hasOwn(stored, name) ? cleanValue(name, field, stored[name]) : { ok: false };
    out[name] = have.ok ? have.value : field.default;
  }
  return out;
}

/** A change of some values, checked all or nothing: `{ok: true, values}` (the new full set) or `{ok: false, error}`. */
export function applyChanges(fields, stored, changes) {
  if (!plain(changes) || !Object.keys(changes).length) return { ok: false, error: 'no hay nada que cambiar: {ajuste: valor}' };
  const next = { ...valuesOf(fields, stored) };
  for (const [name, value] of Object.entries(changes)) {
    if (!Object.hasOwn(fields || {}, name)) return { ok: false, error: `el plugin no tiene ningún ajuste «${String(name).slice(0, 40)}»` };
    const checked = cleanValue(name, fields[name], value);
    if (!checked.ok) return checked;
    next[name] = checked.value;
  }
  return { ok: true, values: next };
}

/** The settings the form shows: each field with its current value. */
export function formOf(fields, stored) {
  const values = valuesOf(fields, stored);
  return Object.entries(fields || {}).map(([name, field]) => ({ name, ...field, value: values[name] }));
}

/** The values the user chose, in a file of the data folder (only what differs from the default is worth keeping, but keeping all is simpler and safe). */
export function createConfigStore(file) {
  let data = null;
  const load = () => {
    if (data) return data;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      data = plain(parsed) ? parsed : {};
    } catch {
      data = {};
    }
    return data;
  };
  return {
    get: (id) => (plain(load()[id]) ? load()[id] : {}),
    set(id, values) {
      load()[id] = values;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(data), 'utf8');
      renameSync(file + '.tmp', file);
    },
    remove(id) {
      if (load()[id] === undefined) return;
      delete data[id];
      writeFileSync(file, JSON.stringify(data), 'utf8');
    },
  };
}
