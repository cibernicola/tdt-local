// Themes that plugins bring (tdt.themes in a manifest): a name and some colours for the variables the page is painted with. No CSS and no code:
// only the variables listed here, and only values that are colours, so that a theme can change how the page looks and nothing else (it cannot
// hide a button, move anything or load anything). Pure functions; ../themes.js applies the chosen one.
export const VARS = ['--chassis', '--panel', '--ink', '--muted', '--line', '--screen', '--accent', '--accent-ink', '--row-hover', '--ok', '--bad', '--unk'];
export const MAX_THEMES = 5;
const ID = /^[a-z0-9][a-z0-9-]{0,29}$/;
const COLOR = /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|hsl)a?\(\s*[0-9.%\s,/-]{3,40}\))$/;

/** Is this a colour the page may be painted with? Hex, or a plain rgb()/hsl(): nothing that could carry a url() or a function. */
export const isColor = (value) => typeof value === 'string' && COLOR.test(value.trim());

/**
 * The themes a plugin brings, cleaned: ``[{key, label, scheme, vars}]``. A theme without a valid id or name is dropped; inside a theme, a variable
 * that is not one of ``VARS`` or whose value is not a colour is dropped (and counted in ``dropped``), the rest is kept. ``scheme`` is ``light``,
 * ``dark`` or ``''`` (it tells the browser which colours the native controls should have).
 */
export function cleanThemes(pluginId, raw) {
  const out = [];
  for (const t of (Array.isArray(raw) ? raw : []).slice(0, MAX_THEMES)) {
    if (!t || typeof t !== 'object' || !ID.test(String(t.id)) || typeof t.name !== 'string' || !t.name.trim()) continue;
    const vars = {};
    let dropped = 0;
    for (const [name, value] of Object.entries(t.vars && typeof t.vars === 'object' ? t.vars : {})) {
      if (VARS.includes(name) && isColor(value)) vars[name] = value.trim();
      else dropped += 1;
    }
    if (!Object.keys(vars).length) continue;
    out.push({ key: `${pluginId}/${t.id}`, label: `${t.name.trim().slice(0, 40)} (${pluginId})`, scheme: t.scheme === 'light' || t.scheme === 'dark' ? t.scheme : '', vars, dropped });
  }
  return out;
}

/** The theme chosen, if it is among those there are (a theme of a plugin that stopped is not): otherwise ``null``, the page's own. */
export const chosen = (themes, key) => themes.find((t) => t.key === key) || null;
