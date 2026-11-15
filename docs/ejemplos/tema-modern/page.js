// Modern: puts the logo of the channel that is playing next to its number, under the picture.
// Runs inside the page of TDT local (a plugin with all the power, docs/HACKEABLE.md). It reads the current channel from the
// application's own state, so the logo shows even when the list is hidden or a search leaves the channel out of it.
const { cur } = await import('/js/state.js');
const { fillLogo } = await import('/js/dom.js');

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
const watched = document.querySelector('.now') || document.body;
const observer = new MutationObserver(() => paint());
observer.observe(watched, { childList: true, subtree: true, characterData: true });
const off = tdt.on('channel.changed', () => paint());
paint();

return () => {
  observer.disconnect();
  if (typeof off === 'function') off();
  box.remove();
};
