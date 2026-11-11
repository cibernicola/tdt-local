// What an AI may do about development plugins through the MCP (docs/PLUGINS.md): list them, read them, write them, read their
// log and ask for them to be activated. The server (tdtlocal/control.py) has checked each command; this checks it again,
// because the page that calls us is code too. The rules, in the order they matter:
//
//   1. Nothing at all while the developer mode is off, and no command can turn it on.
//   2. A write is checked FIRST (manifest, syntax) in a folder apart that nothing watches, so a mistake comes back to the AI
//      without bothering the user, and `dry_run` stops there.
//   3. Only a write that passes is shown to the user, with the code, and only if they accept does anything touch the plugin
//      folder. A plugin that is active reloads the moment it does, which is why the question is about the code.
//   4. Activating is a question of its own, and one question at a time: another one that arrives meanwhile is refused.
//
// This module knows nothing about Electron: the question to the user comes in as `confirmWrite`.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCOPE_TEXT, readDevPlugin } from './dev.js';

export const ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;
export const FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*){0,2}$/;
export const EXTENSIONS = ['.js', '.mjs', '.json', '.css', '.html', '.svg', '.txt', '.md'];
export const LIMITS = { files: 12, file: 65_536, total: 262_144, listed: 24, logs: 200 };
const MODE_OFF = 'el modo desarrollador está apagado: solo el usuario puede encenderlo (Ajustes ▸ Desarrollo)';

const fail = (detail, data) => ({ ok: false, detail, ...(data ? { data } : {}) });
const done = (data, detail = 'hecho') => ({ ok: true, detail, data: { ...data, message: detail } }); // the model gets only `data`
const bytes = (text) => Buffer.byteLength(text, 'utf8');

/** A sentence about what is wrong with these files, or null. The same rules as the server (`control.py`). */
export function checkFiles(files) {
  const names = Object.keys(files);
  if (!names.length || names.length > LIMITS.files) return `hacen falta de 1 a ${LIMITS.files} archivos`;
  let total = 0;
  for (const name of names) {
    if (!FILE.test(name) || name.length > 100) return `nombre de archivo no válido: «${name.slice(0, 60)}»`;
    if (!EXTENSIONS.some((e) => name.toLowerCase().endsWith(e))) return `«${name}»: solo se admiten archivos ${EXTENSIONS.join(' ')}`;
    const text = files[name];
    if (text !== null && typeof text !== 'string') return `«${name}» tiene que ser texto (o null para borrarlo)`;
    const size = text ? bytes(text) : 0;
    if (size > LIMITS.file) return `«${name}» pesa más de ${LIMITS.file / 1024} KB`;
    total += size;
  }
  return total > LIMITS.total ? `los archivos pesan más de ${LIMITS.total / 1024} KB en total` : null;
}

/** The text files of a plugin folder (not hidden, not links, not big, of the allowed kinds), by relative name. */
export function readFolder(root) {
  const out = {};
  const walk = (dir, prefix, depth) => {
    for (const entry of readdirSync(dir).sort()) {
      if (Object.keys(out).length >= LIMITS.listed) return;
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue; // a link could point anywhere
      const name = prefix + entry;
      if (stat.isDirectory()) {
        if (depth < 2) walk(full, name + '/', depth + 1);
      } else if (stat.isFile() && EXTENSIONS.some((e) => entry.toLowerCase().endsWith(e)) && stat.size <= LIMITS.file) {
        out[name] = readFileSync(full, 'utf8');
      }
    }
  };
  walk(root, '', 0);
  return out;
}

/** What changes: every file of the result and of the plugin as it is now, as `nuevo`, `cambiado`, `borrado` or `igual`. */
export function diffFiles(existing, finals) {
  const changes = [];
  for (const name of Object.keys({ ...existing, ...finals }).sort()) {
    const before = existing[name];
    const after = finals[name];
    let status = 'igual';
    if (before === undefined) status = 'nuevo';
    else if (after === undefined) status = 'borrado';
    else if (before !== after) status = 'cambiado';
    changes.push({ name, status, bytes: after === undefined ? 0 : bytes(after) });
  }
  return changes;
}

/** The question to the user about a write: what changes, what the plugin can do, and the start of the new code. */
export function describeWrite({ name, scopes, changes, finals, active }, { perFile = 1000, total = 3200 } = {}) {
  const lines = changes.filter((c) => c.status !== 'igual').map((c) => `  • ${c.name}: ${c.status}${c.status === 'borrado' ? '' : ` (${c.bytes} bytes)`}`);
  let shown = 0;
  const code = [];
  for (const c of changes) {
    if (c.status === 'igual' || c.status === 'borrado' || shown >= total) continue;
    const text = finals[c.name];
    const room = Math.min(perFile, total - shown);
    code.push(`── ${c.name} ──\n${text.length > room ? `${text.slice(0, room)}\n… (${text.length - room} caracteres más: «Ver los archivos» los muestra enteros)` : text}`);
    shown += Math.min(text.length, room);
  }
  return {
    message: `Una IA quiere ${active ? 'cambiar el plugin de desarrollo' : 'escribir el plugin de desarrollo'} «${name}»`,
    detail:
      (active ? 'ESTÁ ACTIVADO: el código nuevo se ejecutará en cuanto aceptes.\n\n' : 'No correrá hasta que lo actives tú.\n\n')
      + `Cambios:\n${lines.join('\n')}\n\nCuando corra podrá:\n${scopes.map((s) => `  • ${SCOPE_TEXT[s]}`).join('\n')}`
      + (code.length ? `\n\nEl código nuevo:\n\n${code.join('\n\n')}` : ''),
  };
}

/**
 * @param {object} o
 * @param {string} o.dir  the folder of the development plugins
 * @param {ReturnType<import('./dev-runtime.js').createDevRuntime>} o.runtime
 * @param {() => string[]} o.logLines  the lines of the log
 * @param {(ask: object) => Promise<boolean>} o.confirmWrite  the question to the user (`describeWrite` + `stageDir` to look at)
 * @param {(level: string, text: string, source?: string) => void} o.log
 */
export function createDevAdmin({ dir, runtime, logLines, confirmWrite, log }) {
  let asking = false; // one question at a time: a client cannot pile dialogs on the user

  const find = (id) => runtime.view().plugins.find((p) => p.id === id);
  const brief = (p) => ({
    id: p.id, name: p.name, version: p.version, description: p.description, scopes: p.scopes, problems: p.problems,
    active: p.approved, needs_new_approval: p.needsReapproval, running: p.running, error: p.error,
  });

  async function write(cmd) {
    const { id } = cmd;
    const proposed = cmd.files;
    const wrong = checkFiles(proposed);
    if (wrong) return fail(wrong);
    const folder = join(dir, id);
    const existing = existsSync(folder) ? readFolder(folder) : {};
    const finals = { ...existing };
    for (const [name, text] of Object.entries(proposed)) {
      if (text === null) delete finals[name];
      else finals[name] = text;
    }
    if (!Object.keys(finals).length) return fail('el plugin se quedaría sin archivos');
    const tooBig = checkFiles(finals);
    if (tooBig) return fail(tooBig);

    // 2. check the result in a folder apart, which nothing watches and nothing runs from
    const stageRoot = mkdtempSync(join(dirname(dir), 'dev-staging-'));
    try {
      const stageDir = join(stageRoot, id);
      for (const [name, text] of Object.entries(finals)) {
        mkdirSync(dirname(join(stageDir, name)), { recursive: true });
        writeFileSync(join(stageDir, name), text, 'utf8');
      }
      const probe = readDevPlugin(stageDir);
      if (probe.problems.length) return fail(`el plugin no es válido: ${probe.problems.join('; ')}`, { problems: probe.problems });
      const changes = diffFiles(existing, finals);
      const changed = changes.filter((c) => c.status !== 'igual');
      if (!changed.length) return done({ changed: [], valid: true }, 'sin cambios');
      if (cmd.dry_run) return done({ valid: true, scopes: probe.scopes, changes: changed }, 'válido: no se ha escrito nada');

      // 3. the user sees the code and decides
      if (asking) return fail('ya hay una pregunta esperando al usuario: espera a que la responda');
      asking = true;
      let accepted = false;
      try {
        const active = runtime.has(id);
        accepted = await confirmWrite({ ...describeWrite({ name: probe.name, scopes: probe.scopes, changes, finals, active }), stageDir, id });
      } finally {
        asking = false;
      }
      if (!accepted) {
        log('INFO', `el usuario rechazó los cambios de una IA en «${id}»`, 'dev');
        return fail('el usuario rechazó los cambios');
      }
      for (const c of changed) {
        const target = join(folder, c.name);
        if (c.status === 'borrado') rmSync(target, { force: true });
        else {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, finals[c.name], 'utf8');
        }
      }
      await runtime.refresh();
      log('WARN', `cambios de una IA aceptados por el usuario en «${id}»: ${changed.map((c) => `${c.name} (${c.status})`).join(', ')}`, 'dev');
      const active = runtime.has(id);
      return done({
        written: changed.filter((c) => c.status !== 'borrado').map((c) => c.name),
        removed: changed.filter((c) => c.status === 'borrado').map((c) => c.name),
        active,
        next: active ? 'está activado: se recarga solo; mira tdt_dev_logs' : 'para que corra, pide la activación con tdt_dev_activate',
      });
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  }

  async function activate(id) {
    await runtime.refresh();
    const plugin = find(id);
    if (!plugin) return fail(`no hay ningún plugin de desarrollo «${id}»: escríbelo antes con tdt_dev_write`);
    if (plugin.problems.length) return fail(`no se puede activar: ${plugin.problems.join('; ')}`, { problems: plugin.problems });
    if (plugin.approved) return done(brief(plugin), 'ya estaba activado');
    if (asking) return fail('ya hay una pregunta esperando al usuario: espera a que la responda');
    asking = true;
    try {
      await runtime.approve(id, true); // the native question, with the code
    } finally {
      asking = false;
    }
    const after = find(id);
    return after && after.approved ? done(brief(after), 'activado por el usuario') : fail('el usuario no lo ha activado');
  }

  return {
    /** Do one command (already checked by the server). Always answers `{ok, detail, data?}`; never throws. */
    async run(cmd) {
      try {
        if (!cmd || typeof cmd !== 'object') return fail('orden no válida');
        if (!runtime.mode()) return fail(MODE_OFF);
        const needsId = cmd.do !== 'dev_list';
        if (needsId && !(typeof cmd.id === 'string' && ID.test(cmd.id))) return fail('«id» no es un nombre de carpeta válido');
        switch (cmd.do) {
          case 'dev_list':
            return done({ plugins: (await runtime.refresh()).plugins.map(brief) });
          case 'dev_read': {
            const folder = join(dir, cmd.id);
            if (!existsSync(folder)) return fail(`no hay ningún plugin de desarrollo «${cmd.id}»`);
            return done({ id: cmd.id, files: readFolder(folder) });
          }
          case 'dev_write':
            if (!cmd.files || typeof cmd.files !== 'object' || Array.isArray(cmd.files)) return fail('«files» tiene que ser un objeto');
            return await write(cmd);
          case 'dev_logs': {
            const limit = Number.isInteger(cmd.limit) ? Math.max(1, Math.min(LIMITS.logs, cmd.limit)) : 50;
            return done({ id: cmd.id, lines: logLines().filter((l) => l.includes(`[dev:${cmd.id}]`)).slice(-limit) });
          }
          case 'dev_activate':
            return await activate(cmd.id);
          default:
            return fail('orden desconocida');
        }
      } catch (error) {
        log('ERROR', `fallo al atender una orden de una IA: ${(error && error.stack) || error}`, 'dev');
        return fail(`error: ${(error && error.message) || error}`);
      }
    },
  };
}
