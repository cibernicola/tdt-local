// The pages of the teletext: built from public news feeds, the weather and the programme guide. Pure functions, no DOM and no network.
// A port to JavaScript of tdtlocal/teletext.py of the pull request 3 of TDT local by Antonio Bueno Martín (antoniobuen0).
//
// A page is a list of subpages; each subpage is "output lines" (`OL,<row>,<text>`: 40 cells per row, a control code is written as
// ESC followed by `code | 0x40`, the format of the MRG `.tti` files). Text uses the Spanish/Portuguese national character set of the
// teletext standard, which decode.js turns back into letters.

export const ES_FEED = 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/';
/** [index page, name, feed address, number of its first article page, items]. The hosts are the `network:` permissions of the manifest. */
export const SOURCES = [
  ['101', 'EL PAIS', ES_FEED + 'portada', 111, 8],
  ['102', 'EL MUNDO', 'https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml', 121, 8],
  ['103', 'EUROPA PRESS', 'https://www.europapress.es/rss/rss.aspx', 131, 8],
  ['200', 'DEPORTES', ES_FEED + 'section/deportes/portada', 211, 8],
  ['300', 'ECONOMIA', ES_FEED + 'section/economia/portada', 311, 8],
];
export const FASTEXT = { red: '101', green: '200', yellow: '300', blue: '400', index: '100' };
export const CITIES = [
  ['Barcelona', 41.39, 2.17], ['Madrid', 40.42, -3.7], ['Valencia', 39.47, -0.38], ['Sevilla', 37.39, -5.98],
  ['Bilbao', 43.26, -2.93], ['Zaragoza', 41.65, -0.89], ['Palma', 39.57, 2.65], ['Las Palmas', 28.12, -15.43],
];
export const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=' + CITIES.map((c) => c[1]).join(',')
  + '&longitude=' + CITIES.map((c) => c[2]).join(',')
  + '&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto';
const WMO = {
  0: 'Despejado', 1: 'Poco nuboso', 2: 'Intervalos', 3: 'Nublado', 45: 'Niebla', 48: 'Niebla', 51: 'Llovizna', 53: 'Llovizna',
  55: 'Llovizna', 61: 'Lluvia', 63: 'Lluvia', 65: 'Lluvia fuerte', 71: 'Nieve', 73: 'Nieve', 75: 'Nieve fuerte', 80: 'Chubascos',
  81: 'Chubascos', 82: 'Chubascos+', 95: 'Tormenta', 96: 'Tormenta', 99: 'Tormenta',
};
export const MAX_SUMMARY = 600; // what is kept of each summary: the pages are rebuilt from these and stored in 256 KB

// Spanish/Portuguese national subset: these ASCII codes are drawn as accented letters by a teletext decoder.
const NATIONAL = { ñ: '|', á: '[', é: '\\', í: ']', ó: '^', ú: '_', '¿': '`', '¡': '@', ç: '#', ü: '{' };
const UNSAFE = { '#': 'n', '@': 'a', '[': '(', ']': ')', '\\': '/', '^': ' ', _: '-', '`': "'", '{': '(', '|': '/', '}': ')', '~': '-' };
const PUNCT = { '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '«': '"', '»': '"', '\u00a0': ' ' };

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
/** The five XML entities and the numeric ones, and nothing else. */
export function unescapeText(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : all;
  });
}

/** Plain text -> the 7-bit characters of the Spanish teletext set (capitals lose their accent). */
export function teletextText(text) {
  let out = '';
  for (const ch of unescapeText(text).replace(/[’“”–—«»\u00a0]/g, (c) => PUNCT[c]).replace(/…/g, '...')) {
    if (Object.hasOwn(NATIONAL, ch)) out += NATIONAL[ch];
    else if (Object.hasOwn(UNSAFE, ch)) out += UNSAFE[ch];
    else if (ch >= ' ' && ch < '\x7f') out += ch;
    else {
      const folded = ch.normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
      out += folded && !Object.hasOwn(UNSAFE, folded) ? folded : ' ';
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function wrap(text, width) {
  const lines = [];
  let cur = '';
  for (const word of text.split(' ')) {
    if (cur.length + word.length + (cur ? 1 : 0) <= width) cur = (cur + ' ' + word).trim();
    else {
      if (cur) lines.push(cur);
      cur = word.slice(0, width);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

const ctl = (code) => '\x1b' + String.fromCharCode(0x40 + code);
const [RED, GREEN, YELLOW, BLUE, MAGENTA, CYAN, WHITE] = [1, 2, 3, 4, 5, 6, 7].map(ctl);
const DOUBLE = ctl(0x0d);
const NEW_BACKGROUND = ctl(0x1d);

/** Keep `cells` cells of a row; a control code takes two characters but one cell. */
export function clip(row, cells = 40) {
  let out = '';
  let n = 0;
  for (let i = 0; i < row.length && n < cells; n++) {
    const step = row[i] === '\x1b' ? 2 : 1;
    out += row.slice(i, i + step);
    i += step;
  }
  return out;
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[^a-z0-9])([a-z])/g, (_, a, b) => a + b.toUpperCase());

/** One 40x24 subpage: a blue title bar on row 1, content, and the fastext labels on row 24. */
class Page {
  constructor(left, right = '') {
    const body = (' ' + left).padEnd(36 - right.length) + right + ' ';
    this.rows = [BLUE + NEW_BACKGROUND + WHITE + body.slice(0, 37)];
  }

  add(row) { this.rows.push(clip(row)); }

  blank() { this.rows.push(''); }

  space() { return 23 - this.rows.length; }

  done() {
    const rows = [...this.rows, ...Array(23).fill('')].slice(0, 23);
    rows.push(RED + 'Portada' + GREEN + 'Deport.' + YELLOW + 'Econom.' + CYAN + 'Tiempo');
    const outputLines = rows.map((r, i) => (r ? `OL,${i + 1},${r}` : '')).filter(Boolean).join('\n');
    return { outputLines, fastext: { ...FASTEXT } };
  }
}

const tagText = (item, tag) => {
  const m = new RegExp(`<${tag}\\b[^>]*>(?:\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*|([\\s\\S]*?))</${tag}>`, 'i').exec(item);
  if (!m) return '';
  return m[1] !== undefined ? m[1] : unescapeText(m[2]);
};

/**
 * `[{title, summary, pub}]` of an RSS feed. Documents declaring entities are rejected. It reads the items with plain patterns: a feed
 * is a list of `<item>` with a title, a description and a date, and nothing here needs more.
 */
export function parseFeed(text, limit) {
  if (/<!ENTITY/i.test(text)) throw new Error('el RSS declara entidades XML');
  const items = [];
  for (const m of String(text).matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const title = tagText(m[0], 'title').trim();
    const summary = tagText(m[0], 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY);
    if (title) items.push({ title: title.slice(0, 300), summary, pub: tagText(m[0], 'pubDate').trim().slice(0, 60) });
    if (items.length >= limit) break;
  }
  if (!items.length) throw new Error('el RSS no trae noticias');
  return items;
}

export function shortDate(pub) {
  const m = /(\d{1,2}) (\w{3}) \d{4} (\d\d:\d\d)/.exec(pub);
  return m ? `${String(Number(m[1])).padStart(2, '0')} ${m[2]} ${m[3]}` : '';
}

export function indexPages(src, items) {
  const subs = [];
  let page = null;
  items.forEach((item, i) => {
    let lines = wrap(teletextText(item.title), 34);
    if (lines.length > 3) lines = [...lines.slice(0, 2), lines[2].slice(0, 31) + '...'];
    if (!lines.length) lines = ['(sin titulo)'];
    if (!page || page.space() < lines.length + 2) {
      if (page) subs.push(page.done());
      page = new Page(src[1], 'titulares');
    }
    page.add(CYAN + String(src[3] + i) + WHITE + ' ' + lines[0]);
    for (const line of lines.slice(1)) page.add('     ' + line);
    page.blank();
  });
  if (page) subs.push(page.done());
  return { [src[0]]: { subpages: subs } };
}

export function articlePages(src, items) {
  const pages = {};
  items.forEach((item, i) => {
    const number = String(src[3] + i);
    const titleLines = wrap(teletextText(item.title), 37).slice(0, 3);
    let body = item.summary ? wrap(teletextText(item.summary), 38) : ['(sin resumen: mira la web de la fuente)'];
    const subs = [];
    const capacity = [23 - 4 - 2 * titleLines.length - 1, 20, 20, 20, 20, 20, 20];
    for (const [k, cap] of capacity.entries()) {
      if (!body.length && subs.length) break;
      const take = body.slice(0, cap);
      body = body.slice(cap);
      const page = new Page(src[1], number);
      if (k === 0) {
        for (const line of titleLines) {
          page.add(DOUBLE + YELLOW + line);
          page.blank();
        }
        page.add(CYAN + (shortDate(item.pub) || 'hoy') + '  ' + WHITE + titleCase(src[1]).slice(0, 14));
        page.blank();
      }
      for (const line of take) page.add(WHITE + line);
      if (body.length) {
        page.blank();
        page.add(CYAN + 'continua en la siguiente subpagina');
      }
      subs.push(page.done());
    }
    pages[number] = { subpages: subs };
  });
  return pages;
}

const rounded = (n, width) => String(Math.round(n)).padStart(width);

/** `reports`: what Open-Meteo answers for the cities (a list, in the order of CITIES). */
export function weatherPage(reports) {
  const list = Array.isArray(reports) ? reports : [reports];
  const page = new Page('EL TIEMPO', 'ahora');
  page.blank();
  page.add(CYAN + 'Ciudad'.padEnd(10) + ' ' + 'Cielo'.padEnd(12) + ' ' + '  T' + ' ' + 'Mn/Mx' + ' ' + 'Vto');
  page.blank();
  CITIES.forEach(([name], i) => {
    const report = list[i];
    if (!report) return;
    const cur = report.current;
    const day = report.daily;
    const sky = teletextText(WMO[cur.weather_code] || '-').slice(0, 12).padEnd(12);
    const span = (rounded(day.temperature_2m_min[0], 3) + '/' + String(Math.round(day.temperature_2m_max[0])).padEnd(2)).slice(0, 6);
    page.add(YELLOW + name.slice(0, 10).padEnd(10) + WHITE + sky + GREEN + rounded(cur.temperature_2m, 3) + WHITE + span + MAGENTA + rounded(cur.wind_speed_10m, 3));
  });
  page.blank();
  page.add(CYAN + 'Temperaturas en C, viento en km/h');
  page.add(CYAN + 'Datos: Open-Meteo.com');
  return { 400: { subpages: [page.done()] } };
}

const hm = (ts) => {
  const d = new Date(ts * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

/** `rows`: `{name, now: [start, end, title] | null, next: [...] | null}` for each channel. */
export function tvPages(rows) {
  let page = new Page('TELEVISION', 'ahora');
  page.blank();
  const subs = [];
  for (const row of rows) {
    if (page.space() < 3) {
      subs.push(page.done());
      page = new Page('TELEVISION', 'ahora');
      page.blank();
    }
    page.add(CYAN + teletextText(row.name).slice(0, 14));
    page.add(WHITE + (row.now ? hm(row.now[0]) + ' ' + teletextText(row.now[2]).slice(0, 32) : 'sin guia'));
    if (row.next) page.add(GREEN + hm(row.next[0]) + ' ' + teletextText(row.next[2]).slice(0, 32));
  }
  subs.push(page.done());
  return { 500: { subpages: subs } };
}

export function indexPage(have, stamp) {
  const page = new Page('INDICE', '100');
  page.blank();
  page.add(DOUBLE + YELLOW + 'TELETEXTO');
  page.blank();
  const sections = [
    ['101', 'Portada: EL PAIS'], ['102', 'Portada: EL MUNDO'], ['103', 'Portada: EUROPA PRESS'], ['200', 'Deportes'],
    ['300', 'Economia'], ['400', 'El tiempo'], ['500', 'Television ahora'],
  ];
  for (const [number, name] of sections) if (have.has(number)) page.add(CYAN + number + WHITE + '  ' + name);
  page.blank();
  page.add(GREEN + 'Teclas roja/verde/amarilla/azul:');
  page.add(GREEN + 'acceso directo. Escribe 3 cifras para');
  page.add(GREEN + 'ir a una pagina.');
  page.blank();
  page.add(MAGENTA + 'Actualizado ' + stamp);
  page.add(MAGENTA + 'Fuentes: RSS publicos y Open-Meteo');
  return { 100: { subpages: [page.done()] } };
}

/**
 * Every page there is, from what was read: `feeds` (source index page -> items), `weather` (Open-Meteo's answer or null), `tv` (rows or
 * null) and `stamp` (the time of the last update, as text). A source that is missing leaves its pages out and the index does not list them.
 * @returns {Record<string, {subpages: {outputLines: string, fastext: object}[]}>}
 */
export function buildPages({ feeds = {}, weather = null, tv = null, stamp = '' }) {
  const pages = {};
  for (const src of SOURCES) {
    const items = feeds[src[0]];
    if (items && items.length) Object.assign(pages, indexPages(src, items), articlePages(src, items));
  }
  if (weather) Object.assign(pages, weatherPage(weather));
  if (tv && tv.length) Object.assign(pages, tvPages(tv));
  if (!Object.keys(pages).length) return {};
  Object.assign(pages, indexPage(new Set(Object.keys(pages)), stamp));
  return pages;
}
