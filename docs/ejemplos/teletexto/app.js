// El teletexto como plugin que ocupa la pantalla del reproductor. Las páginas se construyen aquí (pages.js) con lo que baja tdt.net.fetch
// de los servidores que declara el manifest; el decodificador (decode.js) las pinta en un canvas con la fuente Bedstead.
// Se maneja con el ratón (botones y teclas de color en pantalla) y, además, con el teclado: 3 cifras, R V A Z, flechas, I.
import { COLS, PALETTE, ROWS, decodePage, headerRow, parseOutputLines, plainText } from './decode.js';
import { SOURCES, WEATHER_URL, buildPages, parseFeed } from './pages.js';

const $ = (id) => document.getElementById(id);
const HOME = '100';
const STALE_MS = 20 * 60 * 1000; // las páginas se vuelven a bajar si tienen más de esto al abrirlo
const CELL_W = 16;
const CELL_H = 20;
const COLORES = [['red', 'rojo'], ['green', 'verde'], ['yellow', 'amarillo'], ['blue', 'azul']];
const ETIQUETAS = { 101: 'Portada', 200: 'Deportes', 300: 'Economía', 400: 'El tiempo', 500: 'Televisión', 100: 'Índice' };

let datos = { updated: 0, errors: [], feeds: {}, weather: null }; // lo guardado: lo único que se baja de internet
let pages = {};
let page = null; // {number, subpages, sub}
let escrito = '';
let escritoTimer = null;
let refrescando = null;

const hace = (ms) => {
  const min = Math.round((Date.now() - ms) / 60000);
  return min < 1 ? 'hace un momento' : min < 60 ? `hace ${min} min` : `hace ${Math.round(min / 60)} h`;
};

// ---------------------------------------------------------------------------------------------------- datos
async function cargarGuardado() {
  const meta = await tdt.storage.get('meta');
  if (!meta) return;
  datos.updated = meta.updated || 0;
  datos.errors = meta.errors || [];
  for (const src of SOURCES) datos.feeds[src[0]] = (await tdt.storage.get('feed-' + src[0])) || null;
  datos.weather = await tdt.storage.get('weather');
}

/** La tele ahora: los canales nacionales con guía, con lo que dan y lo siguiente. Siempre al momento, no se guarda. */
async function filasTele() {
  const found = await tdt.channels.search('', { kind: 'tv', limit: 50 });
  const canales = found.channels.filter((c) => c.category === 'Nacionales' && c.hasGuide);
  return Promise.all(canales.map(async (c) => {
    try {
      const g = await tdt.epg.now(c.id);
      return { name: c.name, now: g.now && [g.now.start, g.now.end, g.now.title], next: g.next && [g.next.start, g.next.end, g.next.title] };
    } catch { return { name: c.name, now: null, next: null }; }
  }));
}

async function reconstruir() {
  let tv = null;
  try { tv = await filasTele(); } catch { /* sin lista de canales: sin esa página */ }
  const hora = new Date(datos.updated || Date.now());
  const stamp = `${String(hora.getDate()).padStart(2, '0')}/${String(hora.getMonth() + 1).padStart(2, '0')} ${String(hora.getHours()).padStart(2, '0')}:${String(hora.getMinutes()).padStart(2, '0')}`;
  pages = buildPages({ feeds: datos.feeds, weather: datos.weather, tv, stamp });
}

/** Baja los titulares y el tiempo (cada servidor por su cuenta: uno que falla no frena a los demás) y los guarda. */
function actualizar() {
  if (refrescando) return refrescando;
  refrescando = (async () => {
    $('estado').textContent = 'Actualizando…';
    const errors = [];
    const trabajos = SOURCES.map(async (src) => {
      try {
        const r = await tdt.net.fetch(src[2], { headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        datos.feeds[src[0]] = parseFeed(r.text, src[4]);
        await tdt.storage.set('feed-' + src[0], datos.feeds[src[0]]);
      } catch (error) { errors.push(`${src[1]}: ${error.message}`); }
    });
    trabajos.push((async () => {
      try {
        const r = await tdt.net.fetch(WEATHER_URL, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        datos.weather = r.json();
        await tdt.storage.set('weather', datos.weather);
      } catch (error) { errors.push(`tiempo: ${error.message}`); }
    })());
    await Promise.all(trabajos);
    datos.errors = errors;
    if (errors.length < SOURCES.length + 1) datos.updated = Date.now();
    await tdt.storage.set('meta', { updated: datos.updated, errors });
    await reconstruir();
    refrescando = null;
    estado();
  })().catch((error) => { refrescando = null; $('estado').textContent = error.message; });
  return refrescando;
}

function estado() {
  $('estado').textContent = datos.updated
    ? `Páginas actualizadas ${hace(datos.updated)}${datos.errors.length ? ` (falló: ${datos.errors.join('; ')})` : ''}`
    : datos.errors.length ? `No se pudo bajar nada: ${datos.errors.join('; ')}` : 'Preparando las páginas…';
}

// ---------------------------------------------------------------------------------------------------- pintar
function pintarCelda(ctx, c, col, row, advance) {
  const x = col * CELL_W;
  const y = row * CELL_H;
  const h = c.tall ? CELL_H * 2 : CELL_H;
  ctx.fillStyle = PALETTE[c.bg];
  ctx.fillRect(x, y, CELL_W, h);
  ctx.fillStyle = PALETTE[c.fg];
  if (c.bits) { // un bloque de mosaico de 2x3; «separated» deja un hueco fino alrededor
    const w = CELL_W / 2;
    const t = CELL_H / 3;
    const gap = c.separated ? 1.5 : 0;
    for (let i = 0; i < 6; i++) {
      if (!(c.bits & (1 << i))) continue;
      ctx.fillRect(x + (i % 2) * w + gap, y + Math.floor(i / 2) * t * (c.tall ? 2 : 1) + gap, w - gap, t * (c.tall ? 2 : 1) - gap);
    }
  } else if (c.ch !== ' ') {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(CELL_W / advance, c.tall ? 2 : 1);
    ctx.fillText(c.ch, 0, CELL_H * 0.82);
    ctx.restore();
  }
}

function pintar() {
  if (!page) return;
  const canvas = $('pantalla');
  const ctx = canvas.getContext('2d');
  ctx.font = Math.round(CELL_H * 0.95) + 'px Bedstead, monospace';
  ctx.textBaseline = 'alphabetic';
  const advance = ctx.measureText('0').width || CELL_W;
  const rows = parseOutputLines(page.subpages[page.sub].outputLines);
  rows[0] = headerRow(page.number);
  const decoded = decodePage(rows);
  ctx.fillStyle = PALETTE[0];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < ROWS; r++) {
    if (decoded[r].covered) continue;
    decoded[r].cells.forEach((c, col) => pintarCelda(ctx, c, col, r, advance));
  }
  canvas.setAttribute('aria-label', `Teletexto, página ${page.number}. ${plainText(rows).filter(Boolean).join('. ')}`);
}

function mando() {
  if (!page) return;
  const sub = page.subpages[page.sub];
  $('pagina').value = page.number;
  $('sub').textContent = page.subpages.length > 1 ? `Subpágina ${page.sub + 1} de ${page.subpages.length}` : 'Una subpágina';
  $('subAnterior').disabled = $('subSiguiente').disabled = page.subpages.length < 2;
  for (const [color, id] of COLORES) {
    const destino = sub.fastext && sub.fastext[color];
    $(id).disabled = !destino || !pages[destino];
    $(id).querySelector('small').textContent = destino && pages[destino] ? ETIQUETAS[destino] || destino : '';
  }
}

// ---------------------------------------------------------------------------------------------------- manejo
async function ir(numero) {
  if (String(numero) === '500') await reconstruir(); // la tele ahora cambia cada minuto: se lee en el momento
  const found = pages[String(numero)];
  if (!found || !found.subpages.length) {
    $('mensaje').textContent = `La página ${numero} no existe o aún no está lista.`;
    return;
  }
  $('mensaje').textContent = '';
  page = { number: String(numero), subpages: found.subpages, sub: 0 };
  mando();
  pintar();
}

function subpagina(dir) {
  if (!page || page.subpages.length < 2) return;
  page.sub = (page.sub + dir + page.subpages.length) % page.subpages.length;
  mando();
  pintar();
}

function color(nombre) {
  const destino = page && page.subpages[page.sub].fastext && page.subpages[page.sub].fastext[nombre];
  if (destino) ir(destino);
}

function paso(delta) {
  if (!page) return;
  let n = parseInt(page.number, 10);
  for (let i = 0; i < 800; i++) { // hasta la siguiente página que exista en esa dirección
    n += delta;
    if (n < 100 || n > 899) return;
    if (pages[String(n)]) return ir(n);
  }
}

function tecla(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches && e.target.matches('input, select, textarea')) return;
  const k = e.key;
  if (/^[0-9]$/.test(k)) {
    e.preventDefault();
    escrito += k;
    clearTimeout(escritoTimer);
    escritoTimer = setTimeout(() => { escrito = ''; }, 4000);
    $('pagina').value = escrito.padEnd(3, '-');
    if (escrito.length === 3) { const n = escrito; escrito = ''; ir(n); }
    return;
  }
  const nombre = { r: 'red', v: 'green', a: 'yellow', z: 'blue' }[k.toLowerCase()];
  if (nombre) { e.preventDefault(); color(nombre); return; }
  if (k === 'ArrowLeft') { e.preventDefault(); subpagina(-1); }
  else if (k === 'ArrowRight') { e.preventDefault(); subpagina(1); }
  else if (k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); paso(1); }
  else if (k === 'ArrowDown' || k === 'PageDown') { e.preventDefault(); paso(-1); }
  else if (k === 'i' || k === 'I') { e.preventDefault(); ir(HOME); }
}

function conectar() {
  const canvas = $('pantalla');
  canvas.width = COLS * CELL_W;
  canvas.height = ROWS * CELL_H;
  $('formPagina').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = $('pagina').value.trim();
    if (/^[1-8][0-9]{2}$/.test(n)) ir(n); else $('mensaje').textContent = 'Escribe un número de tres cifras entre 100 y 899.';
  });
  $('subAnterior').addEventListener('click', () => subpagina(-1));
  $('subSiguiente').addEventListener('click', () => subpagina(1));
  $('anterior').addEventListener('click', () => paso(-1));
  $('siguiente').addEventListener('click', () => paso(1));
  $('indice').addEventListener('click', () => ir(HOME));
  for (const [nombre, id] of COLORES) $(id).addEventListener('click', () => color(nombre));
  for (const b of document.querySelectorAll('[data-ttx]')) b.addEventListener('click', () => ir(b.dataset.ttx));
  $('actualizar').addEventListener('click', async () => { await actualizar(); ir(page ? page.number : HOME); });
  document.addEventListener('keydown', tecla);
  setInterval(pintar, 1000); // la cabecera enseña los segundos
}

// La aplicación crea este marco cuando el usuario abre el teletexto y lo destruye al cerrarlo (un marco cerrado costaría unos 100 MB), así
// que arrancar es abrir: se pinta enseguida lo guardado la última vez, y se vuelve a bajar solo si tiene más de 20 minutos. Antes de
// abrirlo no se baja nada.
(async () => {
  await tdt.ready;
  conectar();
  try { await document.fonts.load(Math.round(CELL_H * 0.95) + 'px Bedstead'); } catch { /* con monospace */ }
  await cargarGuardado();
  await reconstruir();
  estado();
  if (Object.keys(pages).length) ir(HOME);
  else $('mensaje').textContent = 'Bajando los titulares…';
  if (!datos.updated || Date.now() - datos.updated > STALE_MS) {
    await actualizar();
    ir(page ? page.number : HOME);
  }
  estado();
})().catch((error) => { $('mensaje').textContent = error.message; });
