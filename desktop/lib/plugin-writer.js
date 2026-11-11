// What an AI (through the MCP) may do to the files of a plugin with permissions, or with all the power (and the themes, which are one of those): read them and write them. It is
// the same idea as the development plugins (lib/dev-admin.js), for the kinds of plugin that are made to be shared. The rules, in the order they matter:
//
//   1. A write is checked FIRST in a folder apart that nothing watches and nothing runs from: the manifest as the app reads it, the
//      syntax of every script, and a few warnings about what usually goes wrong (the page is blocked from the network, a permission that
//      is not used, an SDK that is not loaded). A mistake comes back to the AI without bothering the user, and `dry_run` stops there.
//   2. Only a write that passes is shown to the user, in a native window, with what the plugin will be able to do (permissions with their
//      risk) and the code. Only if they accept does anything touch the plugin folder.
//   3. A write never activates anything. If a plugin with permissions is on and its permissions do not change, the new code runs as soon as it is
//      accepted (that is why the question is about the code); if they change, the user has to approve it again, as always. A plugin with all the power
//      is approved by its CODE: whatever is written changes it, so it stops until the user turns it on again and sees the new code.
//   4. One question at a time: another one that arrives meanwhile is refused.
//
// It knows nothing about Electron: the question comes in as `confirmWrite`.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import vm from 'node:vm';
import { ID } from './plugin-api.js';
import { checkFiles, diffFiles, readFolder } from './dev-admin.js';
import { aboutPower, isTheme, signature as fullSignature } from './plugin-full.js';

const fail = (detail, data) => ({ ok: false, detail, ...(data ? { data } : {}) });
const done = (data, detail = 'hecho') => ({ ok: true, detail, data: { ...data, message: detail } });

/** Which uses of the SDK need which permission (the same names as plugin-api.json; a test keeps them equal). */
export const USES = {
  'player.read': /tdt\.player\.state|tdt\.on\(\s*['"]player['"]/,
  'player.control': /tdt\.player\.(?:play|kind|volume|mute|multi)\b/,
  'channels.read': /tdt\.channels\.search/,
  'provide:channels': /tdt\.channels\.provide/,
  'epg.read': /tdt\.epg\.now/,
  'provide:epg': /tdt\.epg\.provide/,
  'ui.toast': /tdt\.ui\.toast/,
  storage: /tdt\.storage\./,
  network: /tdt\.net\.fetch/,
  embed: /(?!)/, // never in the code: a player is shown by the manifest (tdt.sources), see lint()
};

const BLOCKED = [
  [/\bfetch\s*\(/, 'fetch()', 'la página no puede hacer peticiones (tampoco a sus propios archivos): para internet usa tdt.net.fetch, y los datos que lleve el plugin, dentro de un .js o un .json que cargues con <script>'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest', 'la página no puede hacer peticiones: usa tdt.net.fetch'],
  [/\bnew\s+WebSocket\b/, 'WebSocket', 'la página no puede abrir conexiones'],
  [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/, 'localStorage, cookies o indexedDB', 'la caja no tiene almacenamiento propio del navegador: usa tdt.storage'],
  [/\bwindow\.open\s*\(/, 'window.open', 'un plugin no puede abrir ventanas'],
];

/** Syntax problems of the scripts and the JSON of a set of files, with the line. A module (import/export) cannot be checked here. */
export function syntaxProblems(files) {
  const problems = [];
  for (const [name, text] of Object.entries(files)) {
    if (typeof text !== 'string') continue;
    if (name.endsWith('.json')) {
      try { JSON.parse(text); } catch (error) { problems.push(`${name}: JSON no válido (${error.message})`); }
    } else if (/\.m?js$/.test(name)) {
      if (name.endsWith('.mjs') || /^\s*(?:import|export)\b/m.test(text)) continue; // a module: it is checked when it runs
      try {
        new vm.Script(text, { filename: name }); // eslint-disable-line no-new
      } catch (error) {
        const line = /:(\d+)\n/.exec(String(error.stack).split('\n').slice(0, 2).join('\n'));
        problems.push(`${name}${line ? ':' + line[1] : ''}: ${error.message}`);
      }
    }
  }
  return problems;
}

/** What usually goes wrong with a plugin that passes the manifest: advice for the AI, not a reason to refuse. */
export function lint(files, plugin) {
  const warnings = [];
  const code = Object.entries(files).filter(([n]) => /\.(?:m?js|html?)$/.test(n)).map(([n, t]) => [n, t || '']);
  const all = code.map(([, t]) => t).join('\n');
  if (!all.includes('/@tdt/sdk.js')) warnings.push('ninguna página carga /@tdt/sdk.js: sin el SDK no hay `tdt`, y la aplicación no puede vigilar si el plugin se cuelga');
  const entry = files[plugin.entry] || '';
  if (entry && !/color-scheme/.test(entry + (files['style.css'] || ''))) warnings.push(`«${plugin.entry}» no declara color-scheme (<meta name="color-scheme" content="light dark">): el marco tendrá un fondo blanco opaco`);
  for (const [name, text] of code) {
    for (const [re, what, why] of BLOCKED) if (re.test(text)) warnings.push(`${name} usa ${what}: ${why}`);
  }
  const declared = new Set(plugin.permissions.map((p) => (p.startsWith('network:') ? 'network' : p.startsWith('embed:') ? 'embed' : p)));
  for (const [perm, re] of Object.entries(USES)) {
    const used = perm === 'embed' ? (plugin.sources || []).length > 0 : re.test(all);
    if (used && !declared.has(perm)) warnings.push(`usa ${perm === 'network' ? 'tdt.net.fetch' : 'una llamada que necesita «' + perm + '»'} pero no declara ${perm === 'network' ? 'ningún «network:servidor»' : '«' + perm + '»'} en tdt.permissions`);
    if (!used && declared.has(perm)) warnings.push(`declara ${perm === 'network' ? 'un «network:servidor»' : '«' + perm + '»'} pero el código no lo usa: quítalo (cada permiso de más es una razón para que no lo activen)`);
  }
  return warnings;
}

/** What usually goes wrong with a plugin with all the power (or a theme): advice for the AI, not a reason to refuse. */
export function lintFull(files, plugin) {
  const warnings = [];
  const page = plugin.files && plugin.files.page ? Object.entries(files).find(([name]) => name === plugin.pageName) : null;
  const code = page ? page[1] || '' : '';
  if (page && !/\btdt\./.test(code)) warnings.push(`«${plugin.pageName}» no usa «tdt» (los ganchos: tdt.on, tdt.filter, tdt.register, tdt.log): ¿hace falta código, o basta un tema?`);
  if (/\bfetch\s*\(\s*['"`]https?:/.test(code)) warnings.push('fetch() a una dirección de internet: la política de la página solo deja pedir a la propia aplicación (connect-src \'self\'), así que se bloquea');
  if (/\bimport\s*[\w{*]/.test(code.replace(/\bimport\s*\(/g, ''))) warnings.push('un «import» estático no vale en page.js (corre dentro de una función): usa `await import(\'/js/…\')` para los módulos de la interfaz');
  return warnings;
}

/** The question to the user: who is asking, what the plugin will be able to do (with the risk), what changes and the new code. */
export function describePluginWrite({ plugin, changes, finals, active, exists, permissionChange, describePermission, riskOf }, { perFile = 1000, total = 3200 } = {}) {
  const lines = changes.filter((c) => c.status !== 'igual').map((c) => `  • ${c.name}: ${c.status}${c.status === 'borrado' ? '' : ` (${c.bytes} bytes)`}`);
  const risk = { low: 'bajo', medium: 'medio', high: 'alto', critical: 'crítico' };
  const can = plugin.permissions.length
    ? plugin.permissions.map((p) => `  • ${describePermission(p)} (riesgo ${risk[riskOf(p)] || 'alto'})`).join('\n')
    : '  • nada más que mostrarse (no pide ningún permiso)';
  let shown = 0;
  const code = [];
  for (const c of changes) {
    if (c.status === 'igual' || c.status === 'borrado' || shown >= total) continue;
    const text = finals[c.name];
    const room = Math.min(perFile, total - shown);
    code.push(`── ${c.name} ──\n${text.length > room ? `${text.slice(0, room)}\n… (${text.length - room} caracteres más: «Ver los archivos» los muestra enteros)` : text}`);
    shown += Math.min(text.length, room);
  }
  if (plugin.kind === 'full') { // all the power, or a theme: the words are those of the question to turn it on, and what is written stops it
    const theme = isTheme(plugin);
    const now = active
      ? 'ESTÁ ACTIVADO: dejará de correr (o de aplicarse) hasta que lo vuelvas a activar y veas lo nuevo, porque la aprobación es de su código y cualquier cambio la anula.\n\n'
      : 'No correrá hasta que lo actives tú (se te enseñará su código otra vez).\n\n';
    return {
      message: `Una IA quiere ${exists ? 'cambiar' : 'escribir'} ${theme ? 'el tema' : 'el plugin con TODO el poder'} «${plugin.name}» (${plugin.id})`,
      detail: `${now}${aboutPower(plugin)}\n\nCambios:\n${lines.join('\n')}${code.length ? `\n\n${theme ? 'La hoja de estilo nueva' : 'El código nuevo'}:\n\n${code.join('\n\n')}` : ''}`,
    };
  }
  const state = active
    ? (permissionChange ? 'ESTÁ ACTIVADO, pero pide otros permisos: dejará de correr hasta que lo vuelvas a activar y apruebes lo nuevo.\n\n' : 'ESTÁ ACTIVADO con los mismos permisos: el código nuevo se ejecutará en cuanto aceptes.\n\n')
    : 'No correrá hasta que lo actives tú (con sus permisos a la vista).\n\n';
  return {
    message: `Una IA quiere ${exists ? 'cambiar' : 'escribir'} el plugin «${plugin.name}» (${plugin.id})`,
    detail: `${state}Cuando corra podrá:\n${can}\n${plugin.panel ? `\nSe verá como ${plugin.panel.placement === 'screen' ? 'una pantalla sobre el reproductor' : 'un panel flotante'}.\n` : '\nNo tiene panel: corre en segundo plano.\n'}`
      + `\nCambios:\n${lines.join('\n')}${code.length ? `\n\nEl código nuevo:\n\n${code.join('\n\n')}` : ''}`,
  };
}

/**
 * @param {object} o
 * @param {string} o.dir  the folder of the plugins of the user
 * @param {(dir: string) => object} o.readPlugin  plugins.js: how a folder reads as a plugin
 * @param {(plugin: object) => string} o.signature  what the user approves
 * @param {() => Record<string, string>} o.approved  id -> the signature approved
 * @param {(id: string) => boolean} o.isActive  is that plugin running?
 * @param {(ask: object) => Promise<boolean>} o.confirmWrite  the question to the user (`describePluginWrite` + `stageDir` to look at)
 * @param {() => void} o.reload  look at the folder again and restart what changed
 * @param {(permission: string) => string} o.describePermission
 * @param {(permission: string) => string} o.riskOf
 * @param {(level: string, text: string) => void} o.log
 */
export function createPluginWriter({ dir, readPlugin, signature, approved, isActive, confirmWrite, reload, describePermission, riskOf, log }) {
  let asking = false; // one question at a time: a client cannot pile dialogs on the user

  return {
    async read(id) {
      if (typeof id !== 'string' || !ID.test(id)) return fail('«id» no es un id de plugin válido (minúsculas, números y guiones)');
      const folder = join(dir, id);
      if (!existsSync(folder)) return fail(`no hay ningún plugin «${id}» en la carpeta del usuario: escríbelo con tdt_plugin_write`);
      return done({ id, files: readFolder(folder), plugin: { active: isActive(id) } });
    },

    async write(cmd) {
      const { id } = cmd;
      if (typeof id !== 'string' || !ID.test(id)) return fail('«id» no es un id de plugin válido (minúsculas, números y guiones)');
      if (!cmd.files || typeof cmd.files !== 'object' || Array.isArray(cmd.files)) return fail('«files» tiene que ser un objeto');
      const wrong = checkFiles(cmd.files);
      if (wrong) return fail(wrong);
      const folder = join(dir, id);
      const existing = existsSync(folder) ? readFolder(folder) : {};
      const finals = { ...existing };
      for (const [name, text] of Object.entries(cmd.files)) {
        if (text === null) delete finals[name];
        else finals[name] = text;
      }
      if (!Object.keys(finals).length) return fail('el plugin se quedaría sin archivos');
      const tooBig = checkFiles(finals);
      if (tooBig) return fail(tooBig);

      // 1. check the result in a folder apart, which nothing watches and nothing runs from
      const stageRoot = mkdtempSync(join(dirname(dir), 'plugin-staging-'));
      try {
        const stageDir = join(stageRoot, id);
        for (const [name, text] of Object.entries(finals)) {
          mkdirSync(dirname(join(stageDir, name)), { recursive: true });
          writeFileSync(join(stageDir, name), text, 'utf8');
        }
        const probe = readPlugin(stageDir);
        if (probe.kind !== 'ui' && probe.kind !== 'full') return fail('esto no es un plugin con permisos ni con todo el poder: el manifest necesita «tdt»: { «api»: 1, … } (con permisos) o «tdt»: { «api»: 1, «full»: { «page»: «page.js» o «css»: «tema.css» } } (con todo el poder, o un tema), y no «tdt.dev» ni «content_scripts»');
        if (probe.problems.length) return fail(`el plugin no es válido: ${probe.problems.join('; ')}`, { problems: probe.problems });
        const full = probe.kind === 'full';
        if (full && probe.files.page) probe.pageName = relative(stageDir, probe.files.page).replace(/\\/g, '/');
        // the page script of a plugin with all the power runs inside an async function (`await` and `return` at the top are fine), and readPlugin has already compiled it that way
        const broken = syntaxProblems(Object.fromEntries(Object.entries(finals).filter(([name]) => !(full && name === probe.pageName))));
        if (broken.length) return fail(`errores de sintaxis: ${broken.join('; ')}`, { problems: broken });
        const warnings = full ? lintFull(finals, probe) : lint(finals, probe);
        const changes = diffFiles(existing, finals);
        const changed = changes.filter((c) => c.status !== 'igual');
        const summary = { kind: probe.kind, permissions: probe.permissions, placement: probe.panel ? probe.panel.placement : 'none', warnings, ...(full ? { scopes: probe.scopes, theme: isTheme(probe) } : {}) };
        if (!changed.length) return done({ ...summary, changed: [], valid: true }, 'sin cambios');
        if (cmd.dry_run) return done({ ...summary, valid: true, changes: changed }, 'válido: no se ha escrito nada');

        // 2. the user sees the permissions and the code, and decides
        if (asking) return fail('ya hay una pregunta esperando al usuario: espera a que la responda');
        asking = true;
        const before = approved()[id];
        const active = isActive(id);
        const permissionChange = before === undefined ? 'nuevo' : before !== (full ? fullSignature(probe) : signature(probe));
        let accepted = false;
        try {
          accepted = await confirmWrite({ ...describePluginWrite({ plugin: probe, changes, finals, active, exists: Object.keys(existing).length > 0, permissionChange, describePermission, riskOf }), stageDir, id });
        } finally {
          asking = false;
        }
        if (!accepted) {
          log('INFO', `el usuario rechazó los cambios de una IA en el plugin «${id}»`);
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
        reload();
        log('WARN', `cambios de una IA aceptados por el usuario en el plugin «${id}»: ${changed.map((c) => `${c.name} (${c.status})`).join(', ')}`);
        const nowActive = isActive(id);
        return done({
          ...summary,
          written: changed.filter((c) => c.status !== 'borrado').map((c) => c.name),
          removed: changed.filter((c) => c.status === 'borrado').map((c) => c.name),
          active: nowActive,
          next: nowActive
            ? 'está activado y se ha recargado con el código nuevo: mira tdt_plugins (estado) y tdt_plugin_logs (errores)'
            : active ? (full ? 'la aprobación es de su código y ha cambiado: el usuario tiene que volver a activarlo con tdt_plugin_enable (verá el código nuevo)' : 'pide otros permisos: el usuario tiene que volver a activarlo con tdt_plugin_enable')
              : full ? 'para que corra, pide la activación con tdt_plugin_enable (el usuario verá su código)' : 'para que corra, pide la activación con tdt_plugin_enable (el usuario verá los permisos)',
        });
      } finally {
        rmSync(stageRoot, { recursive: true, force: true });
      }
    },
  };
}

