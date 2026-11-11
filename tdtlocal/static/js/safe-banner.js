// The permanent notice of safe mode (docs/HACER-PLUGINS.md): no plugin runs, and a button to start again with them. Only the desktop app has it.
import { el } from './dom.js';

export async function initSafeBanner() {
  const desktop = typeof window !== 'undefined' && window.tdtDesktop;
  if (!desktop || !desktop.plugins || !desktop.safe) return;
  const data = await desktop.plugins.list().catch(() => null);
  if (!data || !data.safeMode) return;
  const bar = el('div', 'safe-banner');
  bar.setAttribute('role', 'status');
  const leave = el('button', 'btn', 'Salir del modo seguro');
  leave.type = 'button';
  leave.title = 'Reinicia la aplicación con tus plugins, tal y como los dejaste';
  leave.addEventListener('click', () => desktop.safe.restart(false));
  bar.append(`Modo seguro: ningún plugin corre (${data.safeMode}). Lo que tenías activado sigue guardado. `, leave);
  document.body.append(bar);
}
