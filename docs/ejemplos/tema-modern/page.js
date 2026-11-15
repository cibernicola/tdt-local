// Modern: what a style sheet cannot do on its own.
// Runs inside the page of TDT local (a plugin with all the power, docs/HACKEABLE.md). Two things, both undone when the plugin is switched off:
//  1. the logo of the channel that is playing, next to its number under the picture;
//  2. the buttons in the order the theme shows them, moved in the page itself so the Tab key goes through them in that same order.
const { cur } = await import('/js/state.js');
const { fillLogo } = await import('/js/dom.js');

// ---------- 1. the logo of the channel ----------
// It reads the current channel from the application's own state, so the logo shows even when the list is hidden or a search leaves the
// channel out of it.
const box = document.createElement('span');
box.className = 'n-now-logo';
box.setAttribute('aria-hidden', 'true'); // the name is already there as text
let shown = null;

function paint() {
  const num = document.getElementById('nowNum');
  if (!num) return;
  const c = cur();
  const id = c && c.logo ? `${c.id}|${c.logo}` : null;
  if (id === shown && box.isConnected) return;
  shown = id;
  if (!id) { box.remove(); return; }
  fillLogo(box, c); // the same box the list uses: initials first, the picture over them once it loads
  if (box.previousElementSibling !== num) num.after(box);
}

// the line under the picture is rewritten every time the channel changes: watching it covers every way of changing it
const now = document.querySelector('.now') || document.body;
const nowWatch = new MutationObserver(() => paint());
nowWatch.observe(now, { childList: true, subtree: true, characterData: true });
const off = tdt.on('channel.changed', () => paint());
paint();

// ---------- 2. the order of the buttons ----------
// Under the picture: this channel | tools | sound | view | the buttons plugins add | Ocultar canales, last, next to the list it hides.
// The source picker and the multi-view controls are not moved: they stay first. tema.css draws the same order with `order`.
const BAR = ['btnFav', 'btnGuide', 'btnHdr', 'btnDel', 'btnAsk', 'btnRules', 'btnAlert', 'btnScte', 'btnSound', 'btnSub', 'btnMulti', 'btnPip', 'btnFull'];
const FOOT = ['btnRefresh', 'btnCheck', 'btnAdd'];
const controls = document.querySelector('.controls');
const footActions = document.querySelector('.foot-actions');
const keys = document.querySelector('.keys'); // the shortcuts: moved in front of Ajustes, which is the last one at the right
const before = [controls, footActions].filter(Boolean).map((parent) => [parent, [...parent.children]]);
const keysHome = keys ? [keys.parentNode, keys.nextSibling] : null;

function arrange() {
  if (controls) {
    for (const id of BAR) {
      const b = document.getElementById(id);
      if (b && b.parentNode === controls) controls.append(b);
    }
    for (const b of controls.querySelectorAll(':scope > [data-plugin]')) controls.append(b);
    const panel = document.getElementById('btnPanel');
    if (panel && panel.parentNode === controls) controls.append(panel);
  }
  if (footActions) { // Actualizar, Comprobar, Añadir | the shortcuts, Ajustes
    for (const id of FOOT) {
      const b = document.getElementById(id);
      if (b && b.parentNode === footActions) footActions.append(b);
    }
    if (keys) footActions.append(keys);
    const settings = document.getElementById('btnSettings');
    if (settings && settings.parentNode === footActions) footActions.append(settings);
  }
}

// a plugin that opens over the picture adds its button at the end of the bar: put Ocultar canales back after it
const barWatch = new MutationObserver(() => {
  barWatch.disconnect(); // moving the buttons is a change too: not watched, or it would never stop
  arrange();
  if (controls) barWatch.observe(controls, { childList: true });
});
arrange();
if (controls) barWatch.observe(controls, { childList: true });

return () => {
  nowWatch.disconnect();
  barWatch.disconnect();
  if (typeof off === 'function') off();
  box.remove();
  if (keysHome) keysHome[0].insertBefore(keys, keysHome[1] && keysHome[1].parentNode === keysHome[0] ? keysHome[1] : null);
  for (const [parent, children] of before) {
    for (const child of children) if (child.isConnected) parent.append(child);
  }
  if (controls) for (const b of controls.querySelectorAll(':scope > [data-plugin]')) controls.append(b); // the app's place for them: the end
};
