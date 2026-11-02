// Modal dialogs: own channels (pasted link + optional headers) and voice-alert words.
import { postJson } from './api.js';
import { $ } from './dom.js';
import { parseAddLink } from './lib/addlink.js';
import { twitchWeb } from './lib/twitch.js';
import { GROUPS, atresWeb, missingOf } from './lib/embeds.js';
import { parseAlertWords } from './lib/alerts.js';
import { cur, state } from './state.js';
import { store } from './store.js';

// Headers some providers check before serving a stream. They are sent by the proxy, nothing more.
const ATRES_HEADERS = { Origin: 'https://www.atresplayer.com', Referer: 'https://www.atresplayer.com/directos/lasexta/' };

let hooks = null;

/**
 * @param {{setKind: (k: string) => void, play: (c: object) => void, load: (force: boolean) => Promise<void>,
 *          footMsg: (t: string) => void, updateDeck: () => void, syncStt: () => void,
 *          syncAlertUi: () => void, saveMulti: () => void, clearChannel: (c: object) => void,
 *          loadEpg: () => Promise<void>}} app
 */
export function initDialogs(app) {
  hooks = app;
  initOwnChannels(app);
  initAlerts(app);
}

function initOwnChannels(app) {
  const dlg = $('addDlg');
  const message = (t) => { $('addMsg').textContent = t; };
  $('btnAdd').addEventListener('click', () => { message(''); dlg.showModal(); $('addName').focus(); });
  openFromLink(dlg, message);
  $('addCancel').addEventListener('click', () => dlg.close());
  $('addHdr').addEventListener('change', () => { $('addExtra').hidden = $('addHdr').value !== 'custom'; });
  $('addAtres').addEventListener('click', () => addGroup(app, 'atresmedia', message));

  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const choice = $('addHdr').value;
    const headers = choice === 'atres' ? ATRES_HEADERS
      : choice === 'custom' ? { Origin: $('addOrigin').value.trim(), Referer: $('addReferer').value.trim() } : {};
    const kind = $('addKind').value;
    let res;
    try {
      const url = $('addUrl').value.trim();
      const r = await postJson('/api/custom', { name: $('addName').value, kind, sources: [url], headers, web: atresWeb(url) || twitchWeb(url), merge: true });
      res = await r.json();
    } catch { message('El servidor local no responde.'); return; }
    if (!res.ok) { message(res.error || 'No se pudo añadir el canal.'); return; }
    dlg.close();
    $('addForm').reset();
    $('addExtra').hidden = true;
    if (res.merged) app.footMsg('Ya tenías un canal con ese nombre: el enlace se ha añadido como otra fuente suya.');
    if (state.kind !== kind) app.setKind(kind);
    state.cat = '';
    state.grp = '';
    await app.load(true);
    const c = state.byId.get(res.id);
    if (c) app.play(c);
  });

  $('btnDel').addEventListener('click', () => removeOwn(cur()));
}

/** Remove an own channel (after asking), from its row in the list or from the button under the picture. */
export async function removeOwn(c) {
  if (!c || !c.custom || !window.confirm('¿Quitar «' + c.name + '» de tus canales propios?')) return;
  try {
    await postJson('/api/custom/delete', { id: c.id });
  } catch { hooks.footMsg('El servidor local no responde.'); return; }
  hooks.clearChannel(c); // a tile that was showing it is emptied
  hooks.saveMulti();
  await hooks.load(true);
}

// Own channels for a whole group (Atresmedia: its embeddable player). No headers, no stream.
async function addGroup(app, groupId, message) {
  const group = GROUPS[groupId];
  const missing = missingOf(groupId, state.channels);
  if (!missing.length) { message('Ya tienes todos los canales de ' + group.name + '.'); return; }
  let added = 0;
  let merged = 0;
  for (const entry of missing) {
    try {
      const r = await postJson('/api/custom', { ...entry, kind: 'tv', headers: {}, merge: true });
      const res = await r.json();
      if (res.ok) added++;
      if (res.merged) merged++;
    } catch { message('El servidor local no responde.'); return; }
  }
  if (state.kind !== 'tv') app.setKind('tv');
  state.cat = '';
  state.grp = '';
  await app.load(true);
  // these channels have no guide in the lists: it comes from the community guide, which is turned on now
  const guide = await postJson('/api/settings', { epg_extra_enabled: true }).then((r) => r.ok).catch(() => false);
  if (guide) for (const wait of [15000, 40000, 90000]) setTimeout(() => app.loadEpg(), wait); // it takes a while to arrive
  message('Hecho: ' + added + ' canales de ' + group.name + (merged ? ' (' + merged + ' unidos a canales que ya tenías, como otra fuente)' : '')
    + (added < missing.length ? '; algunos no se pudieron añadir' : '') + '. Los verás en «Propios»'
    + (guide ? ', y en unos segundos tendrán su guía.' : '.'));
}

// tools/capturar-directo.js opens the page with #add=…: the dialog opens already filled in, nothing is added by itself
function openFromLink(dlg, message) {
  const link = parseAddLink(location.hash);
  if (!link) return;
  history.replaceState(null, '', location.pathname + location.search); // the link carries a token: do not keep it
  $('addKind').value = link.kind;
  $('addName').value = link.name;
  $('addUrl').value = link.url;
  $('addHdr').value = link.hdr;
  $('addExtra').hidden = true;
  message('Enlace recibido de tu navegador: revísalo y pulsa «Añadir».');
  dlg.showModal();
}

function initAlerts(app) {
  const dlg = $('alertDlg');
  $('btnAlert').addEventListener('click', () => {
    $('alertWords').value = state.alerts.words.join(', ');
    $('alertOn').checked = state.alerts.on;
    $('alertJump').checked = state.alerts.jump;
    dlg.showModal();
  });
  $('alertCancel').addEventListener('click', () => dlg.close());
  $('alertForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const words = parseAlertWords($('alertWords').value);
    state.alerts = { words, on: $('alertOn').checked && words.length > 0, jump: $('alertJump').checked };
    store.set('alerts', state.alerts);
    dlg.close();
    app.syncAlertUi();
    app.syncStt();
    app.updateDeck();
  });
}
