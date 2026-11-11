// The «Desarrollo» tab of the settings and the permanent notice of the developer mode, which exist only in the desktop app.
// What the app says (desktop/main.js: dev.view) becomes the text shown. Docs: docs/PLUGINS.md.

export const SCOPE_LABEL = { page: 'la página de TDT local', main: 'el proceso principal de la aplicación' };

export const DEV_INTRO = 'Los plugins de desarrollo corren SIN aislamiento ni permisos, con los mismos poderes que la '
  + 'aplicación: pueden leer y cambiar cualquier cosa de la página y, los del proceso principal, hacer lo mismo que tú en '
  + 'este equipo. Sirven para probar cosas tú, o con una IA que edite sus archivos, no para repartir. Nunca se cargan de '
  + 'otro sitio que su carpeta, y cada uno se activa a mano. Actívalo solo si sabes lo que haces: si alguien te pide que '
  + 'lo hagas para «instalar» algo, no lo hagas.';

/** The line the permanent notice shows, or '' while the mode is off. */
export function bannerText(view) {
  if (!view || !view.mode) return '';
  const n = view.plugins.filter((p) => p.approved).length;
  return 'Modo desarrollador: ' + (n === 1 ? '1 plugin sin aislar' : n + ' plugins sin aislar');
}

export function summarizeDev(view) {
  if (!view.mode) return 'El modo desarrollador está apagado.';
  const word = view.plugins.length === 1 ? '1 plugin' : view.plugins.length + ' plugins';
  const on = view.plugins.filter((p) => p.approved).length;
  return word + (view.plugins.length ? (on ? ', ' + (on === 1 ? '1 activado' : on + ' activados') : ', ninguno activado') : '') + '.';
}

/**
 * @param {{name: string, version: string, description: string, scopes: string[], problems: string[], approved: boolean,
 *          needsReapproval: boolean, running: boolean, error: string}} plugin
 */
export function describeDevPlugin(plugin) {
  const usable = !plugin.problems.length;
  let status = 'apagado';
  if (!usable) status = 'no se puede usar';
  else if (plugin.needsReapproval) status = 'declara otros alcances: hay que volver a activarlo';
  else if (plugin.error) status = 'error al arrancar';
  else if (plugin.approved) status = 'activado' + (plugin.scopes.includes('main') ? (plugin.running ? ', corriendo' : ', sin arrancar') : '');
  return {
    title: plugin.name + (plugin.version ? ' ' + plugin.version : ''),
    description: plugin.description,
    usable,
    on: usable && plugin.approved,
    acts: plugin.scopes.length ? 'Corre en: ' + plugin.scopes.map((s) => SCOPE_LABEL[s] || s).join(' y en ') + '.' : '',
    status,
    problems: plugin.problems,
    error: plugin.error || '',
  };
}
