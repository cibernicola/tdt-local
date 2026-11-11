// The theme of the page: the page's own, or one that a plugin brings (tdt.themes). The choice is the user's (it is kept in this browser); a
// theme only repaints the variables of lib/themes.js. plugin-host.js tells which themes there are now.
import { el } from './dom.js';
import { VARS, chosen } from './lib/themes.js';
import { store } from './store.js';

let themes = [];
let applied = [];
const controls = new Set();

function paint() {
  const root = document.documentElement;
  for (const name of applied) root.style.removeProperty(name);
  root.style.removeProperty('color-scheme');
  applied = [];
  const theme = chosen(themes, store.get('theme', ''));
  if (!theme) return;
  for (const name of VARS) {
    if (theme.vars[name]) { root.style.setProperty(name, theme.vars[name]); applied.push(name); }
  }
  if (theme.scheme) root.style.setProperty('color-scheme', theme.scheme);
}

function refresh() {
  for (const select of controls) {
    const keep = store.get('theme', '');
    select.replaceChildren(new Option('El de la aplicación', ''), ...themes.map((t) => new Option(t.label, t.key)));
    select.value = themes.some((t) => t.key === keep) ? keep : '';
  }
}

/** The themes the plugins that run bring, as plugin-host.js knows them now. */
export function setThemes(list) {
  themes = Array.isArray(list) ? list : [];
  paint();
  refresh();
}

/** Choose a theme by its key (``''``: the page's own). */
export function chooseTheme(key) {
  store.set('theme', themes.some((t) => t.key === key) ? key : '');
  paint();
  refresh();
}

/** The control for the settings: a label and a list with the themes there are. */
export function themeControl() {
  const select = el('select');
  select.id = 'themeSelect';
  select.addEventListener('change', () => chooseTheme(select.value));
  controls.add(select);
  refresh();
  const label = el('label', '', 'Tema de la aplicación ');
  label.htmlFor = select.id;
  const box = el('p', 'dlg-hint theme-pick');
  box.append(label, select);
  return box;
}
