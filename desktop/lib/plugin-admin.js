// What an AI (through the MCP) or the settings may ask about the plugins with permissions: list them with their state, read what they wrote
// in the Registro, turn one on or off, and take a permission away or give it back. Nothing here needs Electron: main.js passes in what it
// does (`setEnabled` and `setPermission` end in a native question when they give more power; taking power away asks nothing).
import { ID } from './plugin-api.js';

export const MAX_LOG_LINES = 200;

const refuse = (detail) => ({ ok: false, detail });

/**
 * @param {{snapshot: () => {plugins: object[]}, setEnabled: (id: string, on: boolean) => Promise<boolean>,
 *          setPermission: (id: string, name: string, on: boolean, ask: boolean) => Promise<boolean>, logLines: () => string[],
 *          writer?: {read: (id: string) => Promise<object>, write: (cmd: object) => Promise<object>}}} deps
 *   `writer` (lib/plugin-writer.js) reads and writes the files of a plugin; the write ends in a native question with the code.
 */
export function createPluginAdmin({ snapshot, setEnabled, setPermission, logLines, writer, config }) {
  const find = (id) => (typeof id === 'string' && ID.test(id) ? snapshot().plugins.find((p) => p.id === id) : undefined);
  return {
    /** @returns {Promise<{ok: boolean, detail: string, data?: object}>} (never throws) */
    async run(cmd) {
      try {
        switch (cmd && cmd.do) {
          case 'plugin_list':
            return { ok: true, detail: 'plugins', data: snapshot() };
          case 'plugin_logs': {
            const plugin = find(cmd.id);
            if (!plugin) return refuse('no hay ningún plugin con ese id');
            const limit = Number.isInteger(cmd.limit) ? Math.max(1, Math.min(MAX_LOG_LINES, cmd.limit)) : 50;
            const mine = new RegExp(`\\[plugin:${plugin.id}\\]|\\[plugins\\] ${plugin.id}[ :]`);
            return { ok: true, detail: 'registro', data: { id: plugin.id, lines: logLines().filter((l) => mine.test(l)).slice(-limit) } };
          }
          case 'plugin_read':
            return writer ? await writer.read(cmd.id) : refuse('escribir plugins no está disponible');
          case 'plugin_write':
            return writer ? await writer.write(cmd) : refuse('escribir plugins no está disponible');
          case 'plugin_enable':
          case 'plugin_disable': {
            const plugin = find(cmd.id);
            if (!plugin) return refuse('no hay ningún plugin con ese id');
            const on = cmd.do === 'plugin_enable';
            if (on && plugin.problems.length) return refuse('el plugin tiene problemas y no se puede activar: ' + plugin.problems.join('; '));
            if (on && plugin.enabled) return { ok: true, detail: 'ya estaba activado' };
            if (!on && !plugin.enabled) return { ok: true, detail: 'ya estaba desactivado' };
            const done = await setEnabled(plugin.id, on); // turning on ends in the question of the app to the user
            return done ? { ok: true, detail: on ? 'activado' : 'desactivado' } : refuse(on ? 'el usuario no lo ha activado' : 'no se pudo desactivar');
          }
          case 'plugin_permission': {
            const plugin = find(cmd.id);
            if (!plugin || plugin.kind !== 'ui') return refuse('no hay ningún plugin con permisos con ese id');
            const known = plugin.permissions.find((p) => p.name === cmd.permission);
            if (!known) return refuse('el plugin no declara ese permiso');
            if (typeof cmd.on !== 'boolean') return refuse('«on» tiene que ser true o false');
            if (known.granted === cmd.on) return { ok: true, detail: cmd.on ? 'ya estaba permitido' : 'ya estaba quitado' };
            const done = await setPermission(plugin.id, known.name, cmd.on, cmd.on); // giving it back asks the user; taking it away does not
            return done ? { ok: true, detail: cmd.on ? 'permitido' : 'quitado' } : refuse('el usuario no lo ha permitido');
          }
          case 'plugin_config': {
            const plugin = find(cmd.id);
            if (!plugin || plugin.kind !== 'ui') return refuse('no hay ningún plugin con permisos con ese id');
            if (!config) return refuse('cambiar ajustes no está disponible');
            return await config.change(plugin, cmd.values); // checked first, then the question to the user, then saved
          }
          default:
            return refuse('orden desconocida');
        }
      } catch (error) {
        return refuse('error: ' + ((error && error.message) || error));
      }
    },
  };
}
