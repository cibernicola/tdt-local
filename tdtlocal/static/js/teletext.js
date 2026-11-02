// The "Teletexto" dialog: news, sport, economy, weather and what is on TV, built by the local server (teletext.py).
// The page is decoded by lib/teletext.js and painted on a canvas with the Bedstead font; this module is the remote
// control: page numbers, subpages, the four colour keys and the sections.
import { api, postJson } from './api.js';
import { $ } from './dom.js';
import { ago } from './lib/format.js';
import { COLS, PALETTE, ROWS, decodePage, headerRow, parseOutputLines, plainText } from './lib/teletext.js';

const HOME = '100';
const CACHE_MS = 30000; // a magazine is fetched again after this long, so reopening the dialog shows new pages
const CELL_W = 16;
const CELL_H = 20;
const COLOURS = [['red', 'ttxRed'], ['green', 'ttxGreen'], ['yellow', 'ttxYellow'], ['blue', 'ttxBlue']];
const LABELS = { 101: 'Portada', 200: 'Deportes', 300: 'Economía', 400: 'El tiempo', 500: 'Televisión', 100: 'Índice' };
const magazines = new Map();
let page = null; // {number, subpages, sub}
let typed = '';
let typedTimer = null;
let clock = 0;

const dlg = () => $('ttxDlg');
const canvas = () => $('ttxScreen');

async function fetchPage(number) {
  const m = /^([1-8])[0-9]{2}$/.exec(number);
  if (!m) return null;
  const hit = magazines.get(m[1]);
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    try {
      const r = await fetch('/api/teletext/' + m[1] + '.json', { cache: 'no-store' });
      magazines.set(m[1], { at: Date.now(), pages: r.ok ? (await r.json()).pages : {} });
    } catch { magazines.set(m[1], { at: Date.now(), pages: {} }); }
  }
  return magazines.get(m[1]).pages[number] || null;
}

function paintCell(ctx, c, col, row, metrics) {
  const x = col * CELL_W;
  const y = row * CELL_H;
  const h = c.tall ? CELL_H * 2 : CELL_H;
  ctx.fillStyle = PALETTE[c.bg];
  ctx.fillRect(x, y, CELL_W, h);
  ctx.fillStyle = PALETTE[c.fg];
  if (c.bits) { // a 2x3 block of mosaic graphics; "separated" leaves a thin gap around each block
    const w = CELL_W / 2;
    const t = CELL_H / 3;
    const gap = c.separated ? 1.5 : 0;
    for (let i = 0; i < 6; i++) {
      if (!(c.bits & (1 << i))) continue;
      const bx = x + (i % 2) * w;
      const by = y + Math.floor(i / 2) * t * (c.tall ? 2 : 1);
      ctx.fillRect(bx + gap, by + gap, w - gap, t * (c.tall ? 2 : 1) - gap);
    }
  } else if (c.ch !== ' ') {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(CELL_W / metrics.advance, c.tall ? 2 : 1);
    ctx.fillText(c.ch, 0, CELL_H * 0.82);
    ctx.restore();
  }
}

function paint() {
  if (!page) return;
  const el = canvas();
  const ctx = el.getContext('2d');
  ctx.font = Math.round(CELL_H * 0.95) + 'px Bedstead, monospace';
  ctx.textBaseline = 'alphabetic';
  const advance = ctx.measureText('0').width || CELL_W;
  const sub = page.subpages[page.sub];
  const rows = parseOutputLines(sub.outputLines);
  rows[0] = headerRow(page.number);
  const decoded = decodePage(rows);
  ctx.fillStyle = PALETTE[0];
  ctx.fillRect(0, 0, el.width, el.height);
  for (let r = 0; r < ROWS; r++) {
    if (decoded[r].covered) continue;
    decoded[r].cells.forEach((c, col) => paintCell(ctx, c, col, r, { advance }));
  }
  el.setAttribute('aria-label', 'Teletexto, página ' + page.number + '. ' + plainText(rows).filter(Boolean).join('. '));
}

function controls() {
  if (!page) return;
  const sub = page.subpages[page.sub];
  $('ttxPage').value = page.number;
  $('ttxSub').textContent = page.subpages.length > 1 ? 'Subpágina ' + (page.sub + 1) + ' de ' + page.subpages.length : 'Una subpágina';
  $('ttxPrevSub').disabled = $('ttxNextSub').disabled = page.subpages.length < 2;
  for (const [colour, id] of COLOURS) {
    const target = sub.fastext && sub.fastext[colour];
    $(id).disabled = !target;
    $(id).querySelector('small').textContent = target ? LABELS[target] || target : '';
  }
}

async function go(number) {
  const found = await fetchPage(String(number));
  if (!found || !found.subpages || !found.subpages.length) {
    $('ttxMsg').textContent = 'La página ' + number + ' no existe o aún no está lista.';
    return;
  }
  $('ttxMsg').textContent = '';
  page = { number: String(number), subpages: found.subpages, sub: 0 };
  controls();
  paint();
}

async function status() {
  let res;
  try { res = await api('/api/teletext'); } catch { $('ttxStatus').textContent = 'El servidor local no responde.'; return; }
  const d = res.data || {};
  $('ttxStatus').textContent = d.updated
    ? 'Páginas actualizadas ' + ago(d.updated) + (d.errors && d.errors.length ? ' (alguna fuente falló: ' + d.errors.join('; ') + ')' : '')
    : 'Preparando las páginas… vuelve a probar en unos segundos.';
}

export function isTeletextOpen() { return dlg().open; }

export async function openTeletext(number = HOME) {
  if (!dlg().open) dlg().showModal();
  dlg().focus(); // like a remote control: the digits go to the teletext, not to the page field
  status();
  try { await document.fonts.load(Math.round(CELL_H * 0.95) + 'px Bedstead'); } catch { /* monospace fallback */ }
  clearInterval(clock);
  clock = setInterval(() => { if (dlg().open) paint(); else clearInterval(clock); }, 1000); // the header shows the seconds
  await go(number);
}

export function toggleTeletext() {
  if (dlg().open) dlg().close(); else openTeletext(page ? page.number : HOME);
}

/** Show or hide the button: the teletext is off until it is turned on in the settings. */
export function syncTeletext(enabled) {
  $('btnTtx').hidden = !enabled;
}

function sub(direction) {
  if (!page || page.subpages.length < 2) return;
  page.sub = (page.sub + direction + page.subpages.length) % page.subpages.length;
  controls();
  paint();
}

function fast(colour) {
  const target = page && page.subpages[page.sub].fastext && page.subpages[page.sub].fastext[colour];
  if (target) go(target);
}

function step(delta) {
  if (!page) return;
  go(Math.min(899, Math.max(100, parseInt(page.number, 10) + delta)));
}

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches && e.target.matches('input, select, textarea')) return;
  const k = e.key;
  const handled = () => { e.preventDefault(); e.stopPropagation(); }; // the page behind uses these keys for its own things
  if (/^[0-9]$/.test(k)) {
    handled();
    typed += k;
    clearTimeout(typedTimer);
    typedTimer = setTimeout(() => { typed = ''; }, 4000);
    $('ttxPage').value = typed.padEnd(3, '-');
    if (typed.length === 3) { const n = typed; typed = ''; go(n); }
    return;
  }
  const colour = { r: 'red', v: 'green', a: 'yellow', z: 'blue' }[k.toLowerCase()];
  if (colour) { handled(); fast(colour); return; }
  switch (k) {
    case 'ArrowLeft': handled(); sub(-1); break;
    case 'ArrowRight': handled(); sub(1); break;
    case 'ArrowUp': case 'PageUp': handled(); step(1); break;
    case 'ArrowDown': case 'PageDown': handled(); step(-1); break;
    case 'i': case 'I': handled(); go(HOME); break;
    case 'x': case 'X': handled(); dlg().close(); break;
    default:
  }
}

export function initTeletext() {
  const el = canvas();
  el.width = COLS * CELL_W;
  el.height = ROWS * CELL_H;
  $('btnTtx').addEventListener('click', () => openTeletext());
  $('ttxClose').addEventListener('click', () => dlg().close());
  $('ttxForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = $('ttxPage').value.trim();
    if (/^[1-8][0-9]{2}$/.test(n)) go(n); else $('ttxMsg').textContent = 'Escribe un número de tres cifras entre 100 y 899.';
  });
  $('ttxPrevSub').addEventListener('click', () => sub(-1));
  $('ttxNextSub').addEventListener('click', () => sub(1));
  $('ttxPrev').addEventListener('click', () => step(-1));
  $('ttxNext').addEventListener('click', () => step(1));
  $('ttxIndex').addEventListener('click', () => go(HOME));
  for (const [colour, id] of COLOURS) $(id).addEventListener('click', () => fast(colour));
  for (const b of document.querySelectorAll('[data-ttx]')) b.addEventListener('click', () => go(b.dataset.ttx));
  $('ttxRefresh').addEventListener('click', async () => {
    $('ttxMsg').textContent = 'Actualizando…';
    try { await postJson('/api/teletext/refresh', {}); } catch { $('ttxMsg').textContent = 'El servidor local no responde.'; return; }
    magazines.clear();
    setTimeout(() => { status(); go(page ? page.number : HOME); }, 6000);
  });
  dlg().addEventListener('keydown', onKey);
  dlg().addEventListener('close', () => clearInterval(clock));
  // direct link (`#ttx=101`, used by scripts): opens the teletext on that page and clears the address bar
  const link = /^#ttx=([1-8][0-9]{2})$/.exec(location.hash);
  if (link) { history.replaceState(null, '', location.pathname + location.search); openTeletext(link[1]); }
}
