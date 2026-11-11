// The permanent notice of the developer mode of the desktop app: nobody should forget that it is on (docs/PLUGINS.md).
// It reads the state from the app at the start and whenever the settings change it.
import { el } from './dom.js';
import { bannerText } from './lib/dev-panel.js';

export function initDevBanner() {
  const api = typeof window !== 'undefined' && window.tdtDesktop && window.tdtDesktop.dev;
  if (!api) return; // only the desktop app has it
  const bar = el('div', 'dev-banner');
  bar.hidden = true;
  bar.setAttribute('role', 'status');
  document.body.append(bar);
  const refresh = async () => {
    const text = bannerText(await api.state().catch(() => null));
    bar.textContent = text;
    bar.hidden = !text;
  };
  window.addEventListener('tdt-dev-changed', refresh);
  refresh();
}
