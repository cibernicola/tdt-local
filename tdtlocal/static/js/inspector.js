// The inspector dialog: events, calls of the plugins and what the rules do, live, to see what a plugin does and why something does not work. It
// only looks (nothing here changes anything), it can be paused, and it refreshes while it is open.
import { $, el } from './dom.js';
import { events } from './events.js';
import { hooks, trusted } from './hooks.js';
import { KINDS, describeHooks, timeline } from './lib/inspector.js';
import { pluginHost } from './plugin-host.js';
import { rulesHistory } from './rules.js';

const REFRESH_MS = 1000;
let timer = null;

function draw() {
  if ($('insPause').checked) return;
  $('insHooks').textContent = describeHooks({ plugins: trusted.list(), chains: hooks.chains() });
  const host = pluginHost();
  const lines = timeline(
    { events: events.recent(100), calls: host ? host.calls(150) : [], rules: rulesHistory() },
    { kind: $('insKind').value, text: $('insText').value },
  );
  $('insLog').replaceChildren(...(lines.length
    ? lines.map((l) => el('li', `ins-${l.kind}` + (l.bad ? ' bad' : ''), l.text))
    : [el('li', 'empty', 'Todavía no ha pasado nada que mostrar.')]));
}

/** The button that opens the inspector (for the plugins tab of the settings). */
export function inspectorButton() {
  const dlg = $('inspectorDlg');
  const select = $('insKind');
  if (!select.options.length) for (const [key, label] of Object.entries(KINDS)) select.append(new Option(label, key));
  const button = el('button', 'btn', 'Inspector');
  button.type = 'button';
  button.title = 'Eventos, llamadas de los plugins y reglas en directo: para ver qué hace un plugin y por qué algo no funciona';
  button.addEventListener('click', () => {
    draw();
    clearInterval(timer);
    timer = setInterval(draw, REFRESH_MS);
    dlg.showModal();
  });
  if (!dlg.dataset.ready) {
    dlg.dataset.ready = '1';
    $('insClose').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => clearInterval(timer));
    $('insKind').addEventListener('change', draw);
    $('insText').addEventListener('input', draw);
  }
  return button;
}
