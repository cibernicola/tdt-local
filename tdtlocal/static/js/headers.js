// The dialog of the request headers of a channel: any channel, the ones the user added and the ones of the public lists. What it saves is
// kept by the server (tdtlocal/headers.py checks everything again); the page never gets the value of a credential back.
import { api, postJson } from './api.js';
import { $, el } from './dom.js';
import { ATRES_HEADERS, HEADERS_INTRO, changesFrom, problemIn, rowsFrom, withKeep } from './lib/headers.js';
import { cur, state } from './state.js';

/** @param {{load: (force: boolean) => Promise<void>, play: (c: object) => void, footMsg: (t: string) => void}} app */
export function initHeaders(app) {
  const dlg = $('hdrDlg');
  const rowsBox = $('hdrRows');
  const message = (t) => { $('hdrMsg').textContent = t; };
  let channel = null; // {id, name, own}
  let original = []; // the rows the form opened with

  function addRow(row = { name: '', value: '', secret: false, keep: false }) {
    const line = el('div', 'hdr-row');
    const name = el('input');
    name.type = 'text';
    name.value = row.name;
    name.placeholder = 'Nombre (Referer, Origin…)';
    name.setAttribute('aria-label', 'Nombre de la cabecera');
    name.maxLength = 40;
    const value = el('input');
    value.type = row.secret ? 'password' : 'text';
    value.value = row.value;
    value.placeholder = row.secret ? '(guardado: escribe para cambiarlo)' : 'Valor';
    value.setAttribute('aria-label', 'Valor de la cabecera');
    value.autocomplete = 'off';
    const remove = el('button', 'btn', 'Quitar');
    remove.type = 'button';
    remove.addEventListener('click', () => line.remove());
    line.append(name, value, remove);
    line._row = row;
    rowsBox.append(line);
    return line;
  }

  const readRows = () => [...rowsBox.children].map((line) => {
    const [name, value] = line.querySelectorAll('input');
    return { name: name.value, value: value.value, secret: line._row.secret, keep: line._row.keep };
  });

  async function open() {
    const c = cur();
    if (!c) return;
    message('');
    let found;
    try {
      const r = await api('/api/headers?id=' + encodeURIComponent(c.id));
      found = r.ok ? r.data : null;
    } catch { found = null; }
    if (!found) { app.footMsg('No se pudieron leer las cabeceras de este canal.'); return; }
    channel = { id: c.id, name: c.name, own: found.own };
    original = rowsFrom(found.headers);
    rowsBox.replaceChildren();
    for (const row of withKeep(original)) addRow(row);
    if (!original.length) addRow();
    $('hdrWho').textContent = found.own ? `«${c.name}» (un canal tuyo)` : `«${c.name}» (de las listas públicas: se guardan aparte y siguen al actualizar la lista)`;
    dlg.showModal();
  }

  $('btnHdr').addEventListener('click', open);
  $('hdrAdd').addEventListener('click', () => addRow().querySelector('input').focus());
  $('hdrAtres').addEventListener('click', () => {
    for (const [name, value] of Object.entries(ATRES_HEADERS)) {
      const have = [...rowsBox.children].find((l) => l.querySelector('input').value.trim().toLowerCase() === name.toLowerCase());
      const line = have || addRow();
      const [n, v] = line.querySelectorAll('input');
      n.value = name;
      v.value = value;
    }
  });
  $('hdrCancel').addEventListener('click', () => dlg.close());
  $('hdrIntro').textContent = HEADERS_INTRO;

  $('hdrForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const rows = readRows();
    const wrong = problemIn(rows);
    if (wrong) { message(wrong); return; }
    const changes = changesFrom(original, rows);
    if (!Object.keys(changes).length) { dlg.close(); return; }
    let res;
    try {
      res = await (await postJson('/api/headers', { id: channel.id, headers: changes })).json();
    } catch { message('El servidor local no responde.'); return; }
    if (!res.ok) { message(res.error || 'No se pudieron guardar.'); return; }
    dlg.close();
    app.footMsg('Cabeceras de «' + channel.name + '» guardadas.');
    await app.load(true); // the channel now says it has headers: the proxy is told whose to use
    const c = state.byId.get(channel.id);
    if (c && cur() && cur().id === c.id) app.play(c); // the stream is asked for again with them
  });
}
