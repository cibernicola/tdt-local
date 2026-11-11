// TDT local: page controller (channel list, player deck, multi-view, subtitles and data loading).
import { adsEvents, adsExternal, adsTuned, adsUserVolume, fragSeen, initAds, setAds } from './adbreak.js';
import { api, postJson } from './api.js';
import { initAssistant, isAssistantOpen, toggleAssist } from './assistant.js';
import { initDialogs, removeOwn } from './dialogs.js';
import { initHeaders } from './headers.js';
import { loadIncluded, startPluginHost } from './core-plugins.js';
import { initEvents } from './events.js';
import { hooks } from './hooks.js';
import { initRules } from './rules.js';
import { initControl } from './control.js';
import { initDevBanner } from './dev-banner.js';
import { initSafeBanner } from './safe-banner.js';
import { initPluginHost } from './plugin-host.js';
import { initSettings } from './settings.js';
import { onWake } from './audio.js';
import { initScte, openScte, syncScte } from './scte.js';
import { audioFx, initSound } from './sound.js';
import { $, el, fillLogo } from './dom.js';
import { matchingWords, ALERT_COOLDOWN_MS } from './lib/alerts.js';
import { nearestSecs } from './lib/commands.js';
import { epgDetail, epgOf, progress } from './lib/epg.js';
import { categoriesOf, filterChannels, isListed } from './lib/filters.js';
import { ago } from './lib/format.js';
import { norm } from './lib/text.js';
import {
  ATRES_PLUGIN, atresChannels, atresItems, atresProgramme, newestFirst, programmeChannel, whenLabel,
} from './lib/u7d.js';
import { fillAssignments, nextRotation } from './lib/mosaic.js';
import { canPlayFormat } from './lib/plan.js';
import { atresEmbed } from './lib/embeds.js';
import { ytEmbed } from './lib/youtube.js';
import { pluginSourceName } from './sources.js';
import { isGuideOpen, syncGuide, toggleGuide } from './guide.js';
import { store } from './store.js';
import { TILES, channelEpgLine, cur, epgEntries, focusTile, nowTs, state } from './state.js';
import { Tile } from './tile.js';

const screenEl = $('screen');
const tilesEl = $('tiles');
const appEl = $('app');
const list = $('list');
const q = $('q');
const selCat = $('cat');
const selGrp = $('grp');
const onlyStream = $('onlyStream');
const onlyFav = $('onlyFav');
const hideDown = $('hideDown');

const audioProbe = document.createElement('audio'); // tells which radio formats this browser plays
const alertSeen = {};
let rotTimer = null;

const footMsg = (t) => { $('footMsg').textContent = t; };

/* ------------------------------------------------------------ on-screen display */
let osdTimer = null;
function osd(num, name) {
  $('osdNum').textContent = num;
  $('osdName').textContent = name || '';
  $('osd').classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => $('osd').classList.remove('show'), 2600);
}

/* ------------------------------------------------------------ filters and list */
const currentFilters = () => (state.kind === 'u7d'
  ? { kind: 'u7d', onlyStream: false, hideDown: false, cat: '', grp: '', onlyFav: false, favs: state.favs, query: q.value }
  : {
    kind: state.kind, onlyStream: onlyStream.checked, hideDown: hideDown.checked, cat: state.cat, grp: state.grp,
    onlyFav: onlyFav.checked, favs: state.favs, query: q.value,
  });

function renderFilters() {
  const f = currentFilters();
  const base = state.channels.filter((c) => isListed(c, f));
  const { cats } = categoriesOf(state.channels, state.kind, '');
  if (state.cat && !cats.includes(state.cat)) state.cat = '';
  const count = (cat) => base.filter((c) => c.category === cat).length;
  selCat.replaceChildren(new Option('Todas las categorías (' + base.length + ')', ''),
    ...cats.map((c) => new Option(c + ' (' + count(c) + ')', c)));
  selCat.value = state.cat;

  const { groups } = categoriesOf(state.channels, state.kind, state.cat);
  selGrp.hidden = groups.length === 0;
  if (state.grp && !groups.includes(state.grp)) state.grp = '';
  selGrp.replaceChildren(new Option('Todos los grupos', ''),
    ...groups.map((g) => new Option(g + ' (' + base.filter((c) => c.category === state.cat && c.group === g).length + ')', g)));
  selGrp.value = state.grp;
}

function favGlyph(btn, on, name) {
  btn.textContent = on ? '★' : '☆';
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.setAttribute('aria-label', (on ? 'Quitar de favoritos: ' : 'Añadir a favoritos: ') + name);
}

function makeRow(c, i) {
  const li = el('li');
  const b = el('button', 'row');
  b.type = 'button';
  b.dataset.id = c.id;
  b.append(el('span', 'num', String(i + 1)));
  const logo = el('span', 'logo');
  fillLogo(logo, c);
  b.append(logo);
  const txt = el('span', 'txt');
  txt.append(el('span', 'name', c.name));
  const embedName = (u) => (ytEmbed(u) ? 'YouTube' : atresEmbed(u) ? 'Atresplayer' : pluginSourceName(u));
  const embedOnly = c.sources.length && c.sources.every((s) => embedName(s.u)) ? embedName(c.sources[0].u) : '';
  const sub = [c.group || (state.cat ? '' : c.category), c.sources.length ? '' : 'solo web', embedOnly]
    .filter(Boolean).join(' · ');
  if (sub) txt.append(el('span', 'sub', sub));
  txt.append(el('span', 'epg', channelEpgLine(c)));
  b.append(txt);
  const dot = el('span', 'dot' + (c.ok === true ? ' ok' : c.ok === false ? ' bad' : ''));
  dot.title = c.ok === true ? 'Responde' : c.ok === false ? 'No responde' : 'Sin comprobar';
  b.append(dot);
  b.addEventListener('click', () => (c.kind === 'u7d' ? openU7d(c) : play(c)));
  const f = el('button', 'fav');
  f.type = 'button';
  f.dataset.fav = c.id;
  favGlyph(f, state.favs.has(c.id), c.name);
  f.addEventListener('click', () => toggleFav(c));
  li.append(b, f);
  if (c.custom) { // the ones the user added can be removed from here
    const d = el('button', 'del', '✕');
    d.type = 'button';
    d.title = 'Quitar este canal de tus canales propios';
    d.setAttribute('aria-label', 'Quitar canal propio: ' + c.name);
    d.addEventListener('click', () => removeOwn(c));
    li.classList.add('own');
    li.append(d);
  }
  return li;
}

/* ------------------------------------------------------------ U7D (last 7 days) */
// Inside a U7D channel the list shows its programmes, newest first; a programme is played like any channel.
function makeProgRow(p, i) {
  const li = el('li');
  const b = el('button', 'row prog');
  b.type = 'button';
  b.dataset.id = p.id;
  b.append(el('span', 'num', String(i + 1)));
  const logo = el('span', 'logo' + (p.thumb ? ' thumb' : ''));
  fillLogo(logo, p);
  b.append(logo);
  const txt = el('span', 'txt');
  txt.append(el('span', 'name', p.name));
  txt.append(el('span', 'sub', [p.when, p.subtitle].filter(Boolean).join(' · ')));
  b.append(txt);
  b.addEventListener('click', () => play(p));
  li.append(b);
  return li;
}

function renderProgrammes() {
  const { c, items, error } = state.u7d;
  const head = el('li', 'u7d-head');
  const back = el('button', 'btn', '← Canales');
  back.type = 'button';
  back.addEventListener('click', () => { state.u7d = null; q.value = ''; renderList(); }); // the search was for programmes
  head.append(back, el('strong', '', c.name + ' · últimos 7 días'));
  const note = (text) => { const li = el('li', 'empty'); li.textContent = text; return li; };
  state.view = [];
  if (error) {
    const retry = el('button', 'btn', 'Reintentar');
    retry.type = 'button';
    retry.addEventListener('click', () => openU7d(c));
    const li = note(error + ' ');
    li.append(retry);
    list.replaceChildren(head, li);
  } else if (!items) {
    list.replaceChildren(head, note(c.provider === 'atres'
      ? 'Leyendo la página de Atresplayer en una ventana aparte. Se cierra sola al terminar; si sale su aviso de cookies, es tuyo.'
      : 'Cargando…'));
  } else if (!items.length) {
    list.replaceChildren(head, note('Sin programas disponibles.'));
  } else {
    const query = norm(q.value);
    const shown = query ? items.filter((it) => norm(it.title + ' ' + it.subtitle).includes(query)) : items;
    const make = c.provider === 'atres' ? atresProgramme : programmeChannel;
    state.view = shown.map((it) => ({ ...make(c, it), subtitle: it.subtitle, when: whenLabel(it.ts) }));
    if (state.view.length) list.replaceChildren(head, ...state.view.map(makeProgRow));
    else list.replaceChildren(head, note('Ningún programa con esa búsqueda.'));
  }
  list.scrollTop = 0;
  markCurrent(false);
  updateDeck();
}

// What Atresplayer's own page «Emitido en TV (U7D)» of a channel shows, read by the plugin in the app's explorer window
async function readAtres(mine) {
  let res;
  try { res = await window.tdtDesktop.atres.list(mine.c.slug); } catch { res = { error: 'sin respuesta' }; }
  if (state.u7d !== mine) return; // the user went elsewhere meanwhile
  if (res && res.items) {
    mine.items = newestFirst(atresItems(res.items));
    // the logo proxy only serves covers the server has been told about
    try { await postJson('/api/u7d/covers', { urls: mine.items.map((i) => i.image).filter(Boolean) }); } catch { /* no covers */ }
  } else if (res && res.error === 'plugin-off') {
    mine.error = 'Para leer la lista de ' + mine.c.name + ' activa el plugin «Atresplayer U7D» en Ajustes ▸ Plugins y vuelve a entrar.';
  } else if (res && res.error === 'busy') {
    mine.error = 'Ya hay una ventana de exploración de Atresplayer abierta.';
  } else {
    mine.error = 'No se pudo leer la lista de ' + mine.c.name + ' (' + ((res && res.error) || 'sin datos') + ').';
  }
  renderList();
}

async function openU7d(c) {
  const mine = { c, items: null, error: '' };
  state.u7d = mine;
  q.value = ''; // what was typed searched channels, not programmes
  renderList();
  if (c.provider === 'atres') { readAtres(mine); return; }
  let r;
  try { r = await api('/api/u7d?c=' + encodeURIComponent(c.id.replace(/^u7d-/, ''))); } catch { r = { ok: false, data: null }; }
  if (state.u7d !== mine) return; // the user went elsewhere meanwhile
  if (r.ok && r.data && r.data.items) mine.items = newestFirst(r.data.items);
  else mine.error = (r.data && r.data.error) || 'No se pudo cargar la lista de ' + c.name + '.';
  renderList();
}

// U7D has no categories, favourites or "only with live": hide what does not apply, and search programmes inside a channel
function syncFilterBar() {
  const u7d = state.kind === 'u7d';
  selCat.hidden = u7d;
  document.querySelector('.toggles').hidden = u7d;
  if (u7d) selGrp.hidden = true;
  q.placeholder = u7d ? (state.u7d ? 'Buscar programa' : 'Buscar canal') : state.kind === 'radio' ? 'Buscar emisora' : 'Buscar canal';
  q.setAttribute('aria-label', q.placeholder);
}

function renderList() {
  syncFilterBar();
  if (state.kind === 'u7d' && state.u7d) { renderProgrammes(); return; }
  state.view = filterChannels(state.channels, currentFilters());
  const top = list.scrollTop;
  if (!state.view.length) {
    const li = el('li', 'empty');
    if (!state.channels.length) li.textContent = 'Todavía no hay lista. Pulsa «Actualizar lista» (hace falta conexión la primera vez).';
    else if (!state.channels.some((c) => c.kind === state.kind)) li.textContent = 'Todavía no hay emisoras. Pulsa «Actualizar lista» (hace falta conexión).';
    else li.textContent = 'Ningún canal con estos filtros.';
    list.replaceChildren(li);
  } else {
    list.replaceChildren(...state.view.map(makeRow));
    list.scrollTop = top;
  }
  markCurrent(false);
  updateDeck();
}

function rerender() { renderFilters(); renderList(); }

// marks the active channel in the list and, in multi-view, the ones in the other tiles
function markCurrent(scroll) {
  list.querySelectorAll('.row[aria-current], .row[data-shown]').forEach((n) => {
    n.removeAttribute('aria-current');
    n.removeAttribute('data-shown');
  });
  const f = focusTile();
  for (const t of (state.mode === 'multi' ? state.tiles : [f])) {
    if (!t.c) continue;
    const n = list.querySelector('.row[data-id="' + CSS.escape(t.c.id) + '"]');
    if (!n) continue;
    if (t === f) {
      n.setAttribute('aria-current', 'true');
      if (scroll) n.scrollIntoView({ block: 'nearest' });
    } else n.setAttribute('data-shown', 'true');
  }
}

const numOf = (c) => { const i = state.view.findIndex((x) => x.id === c.id); return i < 0 ? 0 : i + 1; };
// what the screen shows as the "number" of a channel; a recorded programme is not a channel
const numLabel = (c) => (c.vod ? 'U7D' : numOf(c) || '');

/* ------------------------------------------------------------ player deck (below the picture) */
function updateDeck() {
  const t = focusTile();
  const c = t.c;
  state.tiles.forEach((x) => x.draw());
  $('nowNum').textContent = c && numLabel(c) ? String(numLabel(c)) : '--';
  $('nowName').textContent = c ? c.name : (state.mode === 'multi' ? 'Casilla vacía' : 'Sin canal');
  drawInfo();
  document.title = c ? c.name + ' · TDT local' : 'TDT local';
  const entries = epgEntries(c);
  const e = epgOf(entries, nowTs());
  $('nowEpg').textContent = epgDetail(entries, nowTs()).join('\n');
  $('epgBar').hidden = !(e && e.cur);
  if (e && e.cur) $('epgBar').firstElementChild.style.width = progress(e.cur, nowTs()) + '%';
  syncGuide();
  syncStt();
  $('btnPip').disabled = !!t.frame; // YouTube lives in an iframe: no picture-in-picture of our own
  $('btnDel').hidden = !(c && c.custom);
  $('btnHdr').hidden = !(c && c.kind !== 'u7d');
  const fav = $('btnFav');
  fav.disabled = !c;
  fav.setAttribute('aria-pressed', c && state.favs.has(c.id) ? 'true' : 'false');
  const seg = $('sources');
  seg.replaceChildren();
  if (c && c.sources.length > 1) {
    c.sources.forEach((s, i) => {
      const b = el('button', '', String(i + 1));
      b.type = 'button';
      b.title = 'Fuente ' + (i + 1) + (s.ok === true ? ' (responde)' : s.ok === false ? ' (no responde)' : '');
      b.setAttribute('aria-label', 'Fuente ' + (i + 1));
      b.setAttribute('aria-pressed', t.session && t.session.u === s.u ? 'true' : 'false');
      b.addEventListener('click', () => play(c, s.u));
      seg.append(b);
    });
  }
}

function toggleFav(c) {
  if (!c) return;
  if (state.favs.has(c.id)) state.favs.delete(c.id); else state.favs.add(c.id);
  store.set('favs', [...state.favs]);
  if (onlyFav.checked) { renderList(); return; }
  const f = list.querySelector('.fav[data-fav="' + CSS.escape(c.id) + '"]');
  if (f) favGlyph(f, state.favs.has(c.id), c.name);
  updateDeck();
}

/* ------------------------------------------------------------ playback */
function play(c, onlyUrl) {
  adsTuned(); // a channel chosen during an ad break is the user's doing
  focusTile().play(c, onlyUrl);
  if (state.mode === 'single') osd(numLabel(c), c.name);
  if (!c.vod) store.set('last', c.id); // a programme of the last 7 days is not a channel to come back to
  saveMulti();
  markCurrent(true);
  updateDeck();
}

// the channel an ad-break reaction switches to (and back from): shown, but not remembered as the last one watched
function tune(c) {
  focusTile().play(c);
  if (state.mode === 'single') osd(numLabel(c), c.name);
  markCurrent(true);
  updateDeck();
}

// Ad-break reaction that switches channel, single view: the channel goes to another tile and the original keeps playing,
// out of sight and silent, so that its "break is over" is still seen and it need not be loaded again (it would start with
// another ad). The channel shown is not remembered as the last one watched.
function park(original, c) {
  if (state.mode !== 'single') return null;
  const spare = state.tiles.find((t) => t !== original);
  if (!spare) return null;
  const was = spare.c;
  parkedTile = original;
  spare.play(c);
  state.focus = spare.i;
  applyLayout();
  applyAudio();
  osd(numOf(c) || '', c.name);
  markCurrent(true);
  updateDeck();
  return { spare, was };
}

// `quiet`: the user chose another channel meanwhile, so it stays on screen and only the original is let go
function unpark(parked, original, quiet) {
  parkedTile = null;
  if (quiet || state.mode !== 'single') {
    if (quiet) original.stop();
    applyLayout();
    return;
  }
  parked.spare.stop();
  parked.spare.c = parked.was;
  state.focus = original.i;
  applyLayout();
  applyAudio();
  if (original.c) osd(numOf(original.c) || '', original.c.name);
  markCurrent(true);
  updateDeck();
}

function step(delta) {
  if (!state.view.length) return;
  const c = cur();
  const i = state.view.findIndex((x) => c && x.id === c.id);
  const n = i < 0 ? (delta > 0 ? 0 : state.view.length - 1) : (i + delta + state.view.length) % state.view.length;
  play(state.view[n]);
}

/* ------------------------------------------------------------ multi-view */
const saveMulti = () => store.set('multi', { ids: state.tiles.map((t) => (t.c ? t.c.id : null)) });

let parkedTile = null; // the tile an ad-break reaction left playing in the background, out of sight

function applyLayout() {
  tilesEl.className = 'tiles ' + (state.mode === 'multi' ? 'multi ' + state.layout : 'single');
  state.tiles.forEach((t) => {
    t.root.classList.toggle('main', t.i === state.focus);
    t.root.classList.toggle('parked', t === parkedTile);
  });
  state.tiles.forEach((t) => t.refreshOverlays()); // which tile has the sound, single or multi view
}

function applyAudio() { state.tiles.forEach((t) => t.syncAudio()); }

// what an AI or a plugin asks through the control bus: the same as the keyboard does
function controlVolume(v, m) {
  state.vol = { v, m };
  store.set('vol', state.vol);
  applyAudio();
}

function syncMultiUi() {
  const on = (b, v) => $(b).setAttribute('aria-pressed', v ? 'true' : 'false');
  on('btnMulti', state.mode === 'multi');
  on('lyMosaic', state.layout === 'mosaic');
  on('lyFocus', state.layout === 'focus');
  on('btnRot', state.rot.on);
  $('multiCtl').hidden = state.mode !== 'multi';
  $('rotSecs').value = String(state.rot.secs);
}

// the progress bar of the active tile shows how long is left before the audio moves to the next one
function scheduleRotation() {
  clearTimeout(rotTimer);
  state.tiles.forEach((t) => t.root.classList.remove('rotating'));
  if (state.mode !== 'multi' || !state.rot.on || state.rot.hold || document.hidden) return;
  const root = focusTile().root;
  root.style.setProperty('--rot', state.rot.secs + 's');
  void root.offsetWidth; // restart the animation
  root.classList.add('rotating');
  rotTimer = setTimeout(rotate, state.rot.secs * 1000);
}

function rotate() {
  const next = nextRotation(state.tiles, state.focus);
  if (next >= 0) setFocus(next);
  else scheduleRotation(); // no other tile has a signal
}

function setFocus(i) {
  if (i !== state.focus && state.tiles[i]) {
    state.focus = i;
    applyLayout();
    applyAudio();
    if (cur() && !cur().vod) store.set('last', cur().id);
    updateDeck();
    markCurrent(true);
  }
  scheduleRotation();
}

const moveFocus = (d) => setFocus((state.focus + d + state.tiles.length) % state.tiles.length);

function fillTiles() {
  const saved = store.get('multi', null);
  const filled = fillAssignments(state.tiles.map((t) => t.c), {
    savedIds: saved && Array.isArray(saved.ids) ? saved.ids : [],
    view: state.view, channels: state.channels, focusId: cur() ? cur().id : null,
  });
  state.tiles.forEach((t, i) => { if (!t.c && filled[i]) t.c = filled[i]; });
}

function setMode(m) {
  if (state.mode === m) return;
  state.mode = m;
  applyLayout();
  if (m === 'multi') {
    fillTiles();
    for (const t of state.tiles) {
      t.video.controls = false;
      if (!t.c) t.showEmpty();
      else if (!t.running) t.play(t.c);
    }
    saveMulti();
  } else {
    for (const t of state.tiles) {
      t.video.controls = true;
      if (t.i !== state.focus) t.stop();
    }
  }
  applyAudio();
  syncMultiUi();
  updateDeck();
  markCurrent(true);
  scheduleRotation();
}

function setLayout(l) {
  state.layout = l;
  store.set('layout', l);
  applyLayout();
  syncMultiUi();
}

function toggleRot() {
  state.rot.on = !state.rot.on;
  store.set('rotOn', state.rot.on);
  syncMultiUi();
  scheduleRotation();
}

function setPanel(open) {
  appEl.classList.toggle('collapsed', !open);
  const b = $('btnPanel');
  b.setAttribute('aria-expanded', open ? 'true' : 'false');
  b.textContent = open ? 'Ocultar canales' : 'Mostrar canales';
  store.set('panel', open);
  state.rot.hold = false;
  scheduleRotation();
}

// the desktop app has no console to close: this button stops the server
async function quitServer() {
  if (!window.confirm('¿Cerrar TDT local? Se pararán la reproducción y las tareas en segundo plano.')) return;
  try { await postJson('/api/quit', {}); } catch { /* it may close before answering */ }
  state.tiles.forEach((t) => t.stop());
  document.body.replaceChildren(el('p', 'closed', 'TDT local se ha cerrado. Ya puedes cerrar esta pestaña.'));
}

// put channels into the tiles (from the assistant)
function multiWith(chs, rotate) {
  if (!chs.length) return;
  if (chs[0].kind !== state.kind) setKind(chs[0].kind);
  chs.slice(0, TILES).forEach((c, i) => {
    const t = state.tiles[i];
    if (state.mode === 'multi') t.play(c); else { t.stop(); t.c = c; }
  });
  // tiles the request does not cover must not repeat a channel that is now shown elsewhere
  state.tiles.slice(chs.length).forEach((t) => { if (t.c && chs.some((c) => c.id === t.c.id)) t.clear(); });
  if (state.mode !== 'multi') setMode('multi');
  if (rotate) {
    state.rot.secs = nearestSecs(rotate);
    state.rot.on = true;
    store.set('rotSecs', state.rot.secs);
    store.set('rotOn', true);
  }
  setFocus(0);
  saveMulti(); syncMultiUi(); applyAudio(); updateDeck(); markCurrent(false); scheduleRotation();
}

function toMosaic(c) {
  if (state.mode !== 'multi') { multiWith([cur(), c].filter(Boolean)); return; }
  const t = state.tiles.find((x) => !x.c) || state.tiles[(state.focus + 1) % TILES];
  t.play(c);
  saveMulti(); updateDeck(); markCurrent(false);
}

/* ------------------------------------------------------------ subtitles and voice alerts (Whisper) */
// subtitles: only the tile with the audio. Alerts: every tile of the mosaic (what each one says must be heard)
const wantsStt = (t) => !!t.c && t.running && !t.frame && (
  (state.stt.on && t.i === state.focus)
  || (state.alerts.on && state.alerts.words.length > 0 && (state.mode === 'multi' || t.i === state.focus)));

function syncStt() { for (const t of state.tiles) t.sttSet(wantsStt(t)); }

function drawInfo() {
  const t = focusTile();
  $('nowInfo').textContent = (t.info || (t.c ? '' : 'Elige un canal de la lista.'))
    + (t.stt ? ' · subtítulos: ' + (t.sttMsg || 'activos') : '');
}

async function pollStt() {
  for (const t of state.tiles) {
    if (!t.stt || !t.tag || t.polling) continue;
    const tag = t.tag;
    t.polling = true;
    try {
      const d = await (await fetch('/api/stt?s=' + encodeURIComponent(tag) + '&after=' + t.sttSeq, { cache: 'no-store' })).json();
      if (tag !== t.tag) continue; // the tile changed session meanwhile
      if (!d.active) { t.sttRegister(); continue; } // the server restarted or dropped it
      for (const it of d.items) { t.sttSeq = it.seq; t.sttItem(it); }
      t.sttMsg = d.err ? 'error (' + d.err.slice(0, 70) + ')'
        : d.whisper === 'starting' ? 'iniciando Whisper…' : t.sttSeq ? 'activos' : 'escuchando…';
    } catch { t.sttMsg = 'sin respuesta'; } finally { t.polling = false; }
  }
  if (focusTile().stt) drawInfo();
}

function checkAlerts(tile, text) {
  if (!state.alerts.on || !state.alerts.words.length) return;
  for (const w of matchingWords(text, state.alerts.words)) {
    const key = tile.i + '|' + w;
    if (Date.now() - (alertSeen[key] || 0) < ALERT_COOLDOWN_MS) continue;
    alertSeen[key] = Date.now();
    tile.root.classList.add('alert');
    setTimeout(() => tile.root.classList.remove('alert'), 6000);
    const who = tile.c ? tile.c.name : 'casilla ' + (tile.i + 1);
    osd('🔔', who + ' · «' + w + '»');
    footMsg('Alerta: «' + w + '» en ' + who + '.');
    if (state.alerts.jump && state.mode === 'multi' && tile.i !== state.focus) setFocus(tile.i);
  }
}

function toggleSubs() {
  state.stt.on = !state.stt.on;
  store.set('sttOn', state.stt.on);
  $('btnSub').setAttribute('aria-pressed', state.stt.on ? 'true' : 'false');
  syncStt();
  updateDeck();
}

const syncAlertUi = () => {
  $('btnAlert').setAttribute('aria-pressed', state.alerts.on && state.alerts.words.length ? 'true' : 'false');
};

/* ------------------------------------------------------------ programme guide data */
function paintEpg() {
  for (const n of list.querySelectorAll('.row')) {
    const e = n.querySelector('.epg');
    if (e) e.textContent = channelEpgLine(state.byId.get(n.dataset.id));
  }
  updateDeck();
}

async function loadEpg() {
  let r = null;
  try { r = await api('/api/epg'); } catch { return; }
  if (!r.ok || !r.data || !r.data.now) return; // server without a guide
  state.epg = { now: r.data.now, updated: r.data.updated };
  paintEpg();
}

/* ------------------------------------------------------------ channel data */
function drawMeta(chs) {
  if (!state.meta) return;
  const radios = chs.filter((c) => c.kind === 'radio').length;
  $('meta').textContent = (chs.length - radios) + ' canales' + (radios ? ' · ' + radios + ' emisoras' : '')
    + ' · lista ' + (state.meta.checked ? ago(state.meta.checked) : 'sin descargar');
  $('meta').title = state.meta.updated ? 'Última modificación de la lista: ' + new Date(state.meta.updated * 1000).toLocaleString('es-ES') : '';
  if (state.meta.error) footMsg('Última actualización fallida: ' + state.meta.error);
}

async function load(force) {
  let res;
  try { res = await api('/api/channels'); } catch { footMsg('El servidor local no responde.'); return; }
  if (!res.ok || !res.data) { footMsg('El servidor local devolvió un error.'); return; }
  const d = res.data;
  state.meta = d.meta;
  state.health = d.health;
  const sig = [d.meta.checked, d.meta.updated, d.health.finished, d.channels.length].join('|');
  drawMeta(d.channels);
  $('btnAsk').hidden = !(d.meta && d.meta.ai);
  $('btnSub').hidden = $('btnAlert').hidden = !(d.meta && d.meta.stt);
  setAds(d.meta && d.meta.ads);
  syncScte(!!(d.meta && d.meta.scte), !!(d.meta && d.meta.ads));
  $('hideDownWrap').hidden = !d.channels.some((c) => c.kind === state.kind && c.ok !== null);
  $('btnQuit').hidden = !(d.meta && d.meta.quit);
  if (d.meta && d.meta.version) $('aboutVersion').textContent = 'TDT local v' + d.meta.version;
  if (d.health.running) pollCheck();
  if (sig === state.signature && !force) return;
  state.signature = sig;
  // Atresmedia's catch-up can only be read by the desktop app (see readAtres): its channels join the U7D list there
  const atres = window.tdtDesktop && window.tdtDesktop.atres ? atresChannels(d.channels) : [];
  state.channels = d.channels.concat(atres);
  state.byId = new Map(state.channels.map((c) => [c.id, c]));
  for (const t of state.tiles) if (t.c) t.c = state.byId.get(t.c.id) || t.c;
  rerender();
}

function pollCheck() {
  if (state.checkTimer) return;
  $('btnCheck').disabled = true;
  state.checkTimer = setInterval(async () => {
    let h;
    try { h = (await api('/api/check')).data; } catch { return; }
    if (!h) return;
    if (h.running) { footMsg('Comprobando streams: ' + h.done + ' de ' + h.total); return; }
    clearInterval(state.checkTimer);
    state.checkTimer = null;
    $('btnCheck').disabled = false;
    await load(true);
    const withSrc = state.channels.filter((c) => c.kind === state.kind && c.sources.length);
    footMsg('Comprobación terminada: responden ' + withSrc.filter((c) => c.ok === true).length + ' de ' + withSrc.length
      + (state.kind === 'radio' ? ' emisoras.' : ' canales con directo.'));
  }, 1000);
}

// television / radio: each kind has its own list, categories and numbering
function syncKind() {
  document.querySelectorAll('#kinds button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.kind === state.kind ? 'true' : 'false'));
  const radio = state.kind === 'radio';
  $('btnCheck').textContent = radio ? 'Comprobar emisoras' : 'Comprobar canales';
  $('btnCheck').hidden = state.kind === 'u7d'; // nothing to check: the programmes are resolved when played
  q.placeholder = radio ? 'Buscar emisora' : 'Buscar canal';
  q.setAttribute('aria-label', q.placeholder);
  $('hideDownWrap').hidden = !state.channels.some((c) => c.kind === state.kind && c.ok !== null);
}

function setKind(k) {
  if (state.kind === k) {
    if (k === 'u7d' && state.u7d) { state.u7d = null; q.value = ''; renderList(); } // the U7D button again: back to the channels
    return;
  }
  state.u7d = null;
  state.cats[state.kind] = state.cat;
  store.set('cats', state.cats);
  state.kind = k;
  store.set('kind', k);
  state.cat = state.cats[k] || '';
  state.grp = '';
  syncKind();
  rerender();
}

/* ------------------------------------------------------------ browser features */
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (screenEl.requestFullscreen) screenEl.requestFullscreen();
}

function togglePip() {
  if (!document.pictureInPictureEnabled) return;
  if (document.pictureInPictureElement) document.exitPictureInPicture();
  else focusTile().video.requestPictureInPicture().catch(() => {});
}

/* ------------------------------------------------------------ events */
function bindEvents() {
  q.addEventListener('input', renderList);
  selCat.addEventListener('change', () => {
    state.cat = selCat.value;
    state.grp = '';
    state.cats[state.kind] = state.cat;
    store.set('cats', state.cats);
    rerender();
  });
  selGrp.addEventListener('change', () => { state.grp = selGrp.value; renderList(); });
  for (const [box, key] of [[onlyStream, 'onlyStream'], [onlyFav, 'onlyFav'], [hideDown, 'hideDown']]) {
    box.checked = store.get(key, box.checked);
    box.addEventListener('change', () => { store.set(key, box.checked); rerender(); });
  }
  document.querySelectorAll('#kinds button').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));

  $('btnFav').addEventListener('click', () => toggleFav(cur()));
  $('btnFull').addEventListener('click', toggleFull);
  if (!document.pictureInPictureEnabled) $('btnPip').hidden = true;
  $('btnPip').addEventListener('click', togglePip);

  $('btnMulti').addEventListener('click', () => setMode(state.mode === 'multi' ? 'single' : 'multi'));
  $('lyMosaic').addEventListener('click', () => setLayout('mosaic'));
  $('lyFocus').addEventListener('click', () => setLayout('focus'));
  $('btnRot').addEventListener('click', toggleRot);
  $('rotSecs').addEventListener('change', () => {
    state.rot.secs = Number($('rotSecs').value) || 20;
    store.set('rotSecs', state.rot.secs);
    scheduleRotation();
  });
  $('btnPanel').addEventListener('click', () => setPanel(appEl.classList.contains('collapsed')));
  $('btnSub').addEventListener('click', toggleSubs);
  $('btnQuit').addEventListener('click', quitServer);
  $('btnGuide').addEventListener('click', toggleGuide);
  $('guideClose').addEventListener('click', toggleGuide);

  $('btnRefresh').addEventListener('click', async () => {
    const b = $('btnRefresh');
    b.disabled = true;
    footMsg('Descargando la lista…');
    try {
      const r = await api('/api/refresh', 'POST');
      if (r.ok && r.data.ok) {
        const rad = r.data.radio ? ' y ' + r.data.radio + ' emisoras' : '';
        footMsg(r.data.changed
          ? 'Lista actualizada: ' + r.data.count + ' canales' + rad + ', con cambios.'
          : 'Sin cambios: la lista ya estaba al día (' + r.data.count + ' canales' + rad + ').');
      } else {
        footMsg('No se pudo actualizar: ' + ((r.data && r.data.error) || 'error desconocido'));
      }
    } catch { footMsg('El servidor local no responde.'); }
    b.disabled = false;
    await load(true);
    loadEpg();
  });
  $('btnCheck').addEventListener('click', async () => {
    footMsg('Iniciando comprobación…');
    try { await api('/api/check?kind=' + state.kind, 'POST'); } catch { footMsg('El servidor local no responde.'); return; }
    pollCheck();
  });

  // while a channel is being chosen the rotation waits, so the tile does not change under the mouse
  $('panel').addEventListener('pointerenter', () => { state.rot.hold = true; scheduleRotation(); });
  $('panel').addEventListener('pointerleave', () => { state.rot.hold = false; scheduleRotation(); });
  document.addEventListener('visibilitychange', scheduleRotation);
  document.addEventListener('keydown', onKey);
}

let digits = '';
let digitTimer = null;
function jump() {
  clearTimeout(digitTimer);
  const n = parseInt(digits, 10);
  digits = '';
  const c = state.view[n - 1];
  if (c) play(c); else osd('--', 'No existe ese canal');
}

function onKey(e) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k' && !$('btnAsk').hidden) {
    e.preventDefault();
    toggleAssist(true);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  const typing = t.matches && t.matches('input[type="search"], input[type="text"], textarea, select');
  if (e.key === 'Escape') {
    if (isAssistantOpen()) toggleAssist(false);
    else if (typing) t.blur();
    else if (isGuideOpen()) toggleGuide();
    digits = '';
    return;
  }
  if (typing) return;
  if (e.key === '/') {
    e.preventDefault();
    if (appEl.classList.contains('collapsed')) setPanel(true);
    q.focus();
    q.select();
    return;
  }
  if (/^[0-9]$/.test(e.key)) {
    digits = (digits + e.key).slice(0, 4);
    osd(digits, '');
    clearTimeout(digitTimer);
    digitTimer = setTimeout(jump, 1300);
    return;
  }
  if (e.key === 'Enter' && digits) { e.preventDefault(); jump(); return; }
  const multi = state.mode === 'multi';
  switch (e.key) {
    case 'PageDown': e.preventDefault(); step(1); break;
    case 'PageUp': e.preventDefault(); step(-1); break;
    case 'ArrowDown': if (t.tagName !== 'VIDEO') { e.preventDefault(); step(1); } break;
    case 'ArrowUp': if (t.tagName !== 'VIDEO') { e.preventDefault(); step(-1); } break;
    case 'ArrowRight': if (multi) { e.preventDefault(); moveFocus(1); } break;
    case 'ArrowLeft': if (multi) { e.preventDefault(); moveFocus(-1); } break;
    case 'f': case 'F': toggleFull(); break;
    case 'm': case 'M':
      state.vol.m = !state.vol.m;
      store.set('vol', state.vol);
      applyAudio();
      break;
    case 'p': case 'P': togglePip(); break;
    case 's': case 'S': toggleFav(cur()); break;
    case 'v': case 'V': setMode(multi ? 'single' : 'multi'); break;
    case 't': case 'T': setKind(state.kind === 'tv' ? 'radio' : 'tv'); break;
    case 'g': case 'G': toggleGuide(); break;
    case 'u': case 'U': if (!$('btnSub').hidden) toggleSubs(); break;
    case 'c': case 'C': setPanel(appEl.classList.contains('collapsed')); break;
    case 'r': case 'R': if (multi) toggleRot(); break;
    default:
  }
}

/* ------------------------------------------------------------ start */
/** @type {import('./tile.js').TileHost} */
const host = {
  mode: () => state.mode,
  focus: () => state.focus,
  volume: () => state.vol,
  setVolume(v) { state.vol = v; store.set('vol', v); },
  requestFocus: setFocus,
  toggleFull,
  numOf,
  epgLine: channelEpgLine,
  deckChanged: updateDeck,
  cleared() { saveMulti(); markCurrent(false); updateDeck(); },
  preferred: (c) => state.prefs[c.id],
  remember(c, url) { state.prefs[c.id] = { u: url }; store.set('prefs', state.prefs); },
  canPlayFmt: (f) => canPlayFormat(audioProbe, f),
  spoke: checkAlerts,
  fragSeen,
  adVolume: adsUserVolume,
  adExternal: adsExternal,
  audioFx,
  overlays: { list: () => hooks.list('tile.overlay'), watch: (fn) => hooks.watch('tile.overlay', fn) }, // the layers plugins put over the picture
};

for (let i = 0; i < TILES; i++) state.tiles.push(new Tile(i, host));
tilesEl.replaceChildren(...state.tiles.map((t) => t.root));
bindEvents();
initAssistant({ setKind, play, multiWith, toMosaic });
initDialogs({
  setKind, play, load, footMsg, updateDeck, syncStt, syncAlertUi, saveMulti,
  clearChannel: (c) => state.tiles.forEach((t) => { if (t.c && t.c.id === c.id) t.clear(); }),
  loadEpg,
});
initHeaders({ load, play, footMsg });
loadIncluded(); // the plugins that come with the application (the reaction to an ad break among them), before anything uses their hooks
startPluginHost(); // and, in the desktop app, the plugins without isolation the preload has for this page (they get the same hooks)
initAds({
  focusTile,
  channels: () => state.channels,
  volume: () => state.vol,
  setVolume(v) { state.vol = v; store.set('vol', v); applyAudio(); },
  tune,
  park,
  unpark,
  say: (text) => osd('📢', text),
}, hooks);
initScte({
  react: adsEvents,
  notify(name, text, count) {
    osd('📢', name + ' · ' + text);
    footMsg('Marca de anuncios en ' + name + ': ' + text + (count > 1 ? ' (y ' + (count - 1) + ' más)' : '') + '.');
  },
});
initSound({ apply: applyAudio });
onWake(applyAudio); // the audio context starts with the first click or key: only then can a channel be routed through it
initSettings({ reload: () => load(true), footMsg, openScte });
initDevBanner();
initSafeBanner();
initEvents();
window.addEventListener('tdt-channels-changed', () => load(true)); // a plugin added or removed channels
window.addEventListener('tdt-guide-changed', () => loadEpg()); // a plugin gave a guide or took it away
const pluginHost = initPluginHost({ actions: { setKind, play, multiWith, setVolume: controlVolume } });
initControl({ setKind, play, multiWith, setVolume: controlVolume }, pluginHost);
initRules({ actions: { setKind, play, multiWith, setVolume: controlVolume }, footMsg });
applyLayout();
syncMultiUi();
syncKind();
syncAlertUi();
$('btnSub').setAttribute('aria-pressed', state.stt.on ? 'true' : 'false');
setInterval(pollStt, 1200);
setPanel(store.get('panel', true) !== false);

(async () => {
  await load(true);
  const last = store.get('last', null);
  const c = last && state.byId.get(last);
  const t = focusTile();
  if (c) {
    t.c = c;
    markCurrent(true);
    t.setInfo('Último canal visto');
    t.showNotice('Último canal visto: «' + c.name + '».', [{ label: 'Ver ahora', primary: true, fn: () => play(c) }]);
  } else {
    t.showNotice('Elige un canal de la lista o escribe su número.');
  }
  setInterval(() => load(false), 5 * 60 * 1000);
  loadEpg();
  setInterval(loadEpg, 5 * 60 * 1000);
  setInterval(paintEpg, 30 * 1000); // the programme changes on the hour and the bar advances
})();
