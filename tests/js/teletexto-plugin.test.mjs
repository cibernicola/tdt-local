// The teletext plugin of the examples (docs/ejemplos/teletexto): the decoder and the pages. No DOM, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLS, ROWS, decodePage, decodeRow, headerRow, parseOutputLines, plainText } from '../../docs/ejemplos/teletexto/decode.js';
import {
  CITIES, SOURCES, buildPages, clip, parseFeed, shortDate, teletextText, unescapeText, weatherPage, wrap,
} from '../../docs/ejemplos/teletexto/pages.js';
import { readPlugin } from '../../desktop/lib/plugins.js';

const FEED = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Portada</title>
<item><title>Ministros &amp; alcaldes: «reunión» en Cádiz sobre el año nuevo</title>
<description><![CDATA[<p>El gobierno anuncia una <b>reunión</b> con los alcaldes de la provincia para hablar del año que viene y de las ayudas.</p>]]></description>
<pubDate>Tue, 03 Nov 2026 21:15:00 +0100</pubDate></item>
<item><title><![CDATA[Segunda noticia, con ñ y ¿preguntas?]]></title><description>Resumen &lt;i&gt;corto&lt;/i&gt;</description></item>
<item><title></title><description>sin titulo: se descarta</description></item>
</channel></rss>`;

const lines = (sub) => plainText(parseOutputLines(sub.outputLines));
const items = (n, summary = 'palabra '.repeat(80)) => Array.from({ length: n }, (_, i) => ({ title: 'Titular número ' + (i + 1) + ' de la portada', summary, pub: '' }));

test('a feed is read: CDATA, entities, markup in the summary, empty titles, and no entity declarations', () => {
  const got = parseFeed(FEED, 8);
  assert.equal(got.length, 2);
  assert.equal(got[0].title, 'Ministros & alcaldes: «reunión» en Cádiz sobre el año nuevo');
  assert.match(got[0].summary, /^El gobierno anuncia una reunión con los alcaldes/);
  assert.doesNotMatch(got[0].summary, /[<>]/);
  assert.equal(got[0].pub, 'Tue, 03 Nov 2026 21:15:00 +0100');
  assert.equal(got[1].title, 'Segunda noticia, con ñ y ¿preguntas?');
  assert.equal(got[1].summary, 'Resumen corto');
  assert.equal(parseFeed(FEED, 1).length, 1);
  assert.throws(() => parseFeed('<!DOCTYPE x [<!ENTITY a "b">]><rss><item><title>x</title></item></rss>', 8), /entidades/);
  assert.throws(() => parseFeed('<rss><channel></channel></rss>', 8), /no trae noticias/);
  assert.equal(parseFeed(`<rss><item><title>x</title><description>${'a'.repeat(5000)}</description></item></rss>`, 8)[0].summary.length, 600);
});

test('text becomes the 7 bit teletext set: national letters, unsafe codes replaced, capitals lose the accent', () => {
  assert.equal(teletextText('Cádiz, año nuevo ¿sí?'), 'C[diz, a|o nuevo `s]?');
  assert.equal(teletextText('Ñandú ÁÉ'), 'Nand_ AE');
  assert.equal(teletextText('precio #1 @casa [x] {y}'), 'precio n1 acasa (x) (y)');
  assert.equal(teletextText('«hola» — “mundo”…'), '"hola" - "mundo"...');
  assert.equal(teletextText('  muchos   espacios\n\ty  saltos '), 'muchos espacios y saltos');
  assert.equal(teletextText('emoji 😀 fin'), 'emoji fin');
  assert.equal(unescapeText('a &amp; b &#241; &#xE9; &lt;x&gt; &nada;'), 'a & b ñ é <x> &nada;');
});

test('wrapping and clipping count cells, not characters', () => {
  assert.deepEqual(wrap('uno dos tres cuatro', 8), ['uno dos', 'tres', 'cuatro']);
  assert.deepEqual(wrap('supercalifragilistico y ya', 10), ['supercalif', 'y ya']);
  const row = '\x1b\x43' + 'x'.repeat(60);
  assert.equal(clip(row).length, 2 + 39); // a control code is two characters and one cell
  assert.equal(clip('abc', 2), 'ab');
  assert.equal(shortDate('Tue, 03 Nov 2026 21:15:00 +0100'), '03 Nov 21:15');
  assert.equal(shortDate('ayer'), '');
});

test('the index of a source numbers its articles, and an article is split in subpages', () => {
  const pages = buildPages({ feeds: { 101: items(8), 102: items(3, '') }, stamp: '03/11 21:50' });
  assert.deepEqual(Object.keys(pages).sort(), ['100', '101', '102', '111', '112', '113', '114', '115', '116', '117', '118', '121', '122', '123']);
  const idx = lines(pages['101'].subpages[0]);
  assert.match(idx[1], /EL PAIS\s+titulares/);
  assert.match(idx[2], /^\s*111\s+Titular número 1 de la portada/);
  assert.equal(pages['101'].subpages.length, 1, 'eight short headlines fit in one subpage');
  const wordy = items(8).map((i) => ({ ...i, title: 'titular largo '.repeat(8) }));
  assert.ok(buildPages({ feeds: { 101: wordy } })['101'].subpages.length >= 2, 'eight long headlines flow into more subpages');
  const long = pages['111'];
  assert.ok(long.subpages.length > 1);
  assert.match(lines(long.subpages[0]).join('\n'), /continua en la siguiente subpagina/);
  assert.doesNotMatch(lines(long.subpages.at(-1)).join('\n'), /continua en la siguiente/);
  assert.match(lines(pages['121'].subpages[0]).join('\n'), /sin resumen/);
  for (const page of Object.values(pages)) for (const sub of page.subpages) {
    assert.deepEqual(sub.fastext, { red: '101', green: '200', yellow: '300', blue: '400', index: '100' });
    for (const l of sub.outputLines.split('\n')) assert.match(l, /^OL,(?:[1-9]|1\d|2[0-3]|24),/);
    assert.match(sub.outputLines, /OL,24,/);
  }
});

test('the weather page lists the cities with temperature, range and wind', () => {
  const reports = CITIES.map((_, i) => ({
    current: { temperature_2m: 14.6 + i, weather_code: i === 1 ? 61 : 0, wind_speed_10m: 9.2 },
    daily: { temperature_2m_min: [9.1], temperature_2m_max: [18.6] },
  }));
  const text = lines(weatherPage(reports)[400].subpages[0]);
  assert.match(text[1], /EL TIEMPO\s+ahora/);
  assert.ok(text.some((l) => /^\s*Madrid\s+Lluvia\s+16\s+9\/19\s+9$/.test(l)), text.join('\n'));
  assert.ok(text.some((l) => /^\s*Barcelona\s+Despejado\s+15/.test(l)));
  assert.ok(text.some((l) => /Open-Meteo/.test(l)));
  assert.equal(Object.keys(weatherPage(reports[0])).length, 1); // one report, not a list: only the first city
});

test('the television pages show now and next, and flow into more subpages', () => {
  const at = (h, m) => new Date(2026, 10, 3, h, m).getTime() / 1000;
  const rows = Array.from({ length: 12 }, (_, i) => ({
    name: 'Canal ' + i, now: i === 3 ? null : [at(21, 30), at(22, 0), 'Programa ' + i], next: i % 2 ? [at(22, 0), at(23, 0), 'Siguiente ' + i] : null,
  }));
  const pages = buildPages({ tv: rows });
  const subs = pages['500'].subpages;
  assert.ok(subs.length >= 2);
  const all = subs.flatMap(lines).join('\n');
  assert.match(all, /Canal 0\n\s*21:30 Programa 0\n/);
  assert.match(all, /Canal 3\n\s*sin guia/);
  assert.match(all, /22:00 Siguiente 1/);
  assert.match(lines(subs[0])[1], /TELEVISION +ahora/);
});

test('without any data there is no teletext, and the index only lists what exists', () => {
  assert.deepEqual(buildPages({}), {});
  const pages = buildPages({ weather: null, feeds: { 300: items(2) }, stamp: 'x' });
  const idx = lines(pages['100'].subpages[0]).join('\n');
  assert.match(idx, /300 +Economia/);
  assert.doesNotMatch(idx, /101 +Portada|400 +El tiempo/);
  assert.equal(SOURCES.length, 5);
});

test('the decoder gives colours, mosaics and double height, and covers the row under a double one', () => {
  const row = parseOutputLines('OL,1,\x1b\x41hola\x1b\x43 amarillo\x1b\x4d XY').at(1);
  const d = decodeRow(row);
  assert.deepEqual([d.cells[0].ch, d.cells[0].fg], [' ', 7]); // the code itself is a blank
  assert.equal(d.cells[1].fg, 1); // red starts after the code
  assert.equal(d.cells[1].ch, 'h');
  assert.equal(d.tall, true);
  assert.equal(decodePage([row, row]).length, ROWS);
  const page = decodePage(Array.from({ length: ROWS }, (_, r) => (r === 1 ? row : ' '.repeat(COLS))));
  assert.equal(page[2].covered, true);
  assert.equal(page[3].covered, false);
  const mosaic = decodeRow('\x11 !' + ' '.repeat(37)).cells; // graphics red, then two mosaic cells: empty and the top-left block
  assert.deepEqual([mosaic[1].bits, mosaic[2].bits, mosaic[2].fg], [0, 1, 1]);
  assert.match(plainText(['C[diz a|o'.padEnd(COLS)])[0], /^Cádiz año$/);
  assert.match(headerRow('100', new Date(2026, 10, 3, 21, 5, 9)), /TELETEXTO 100 +Mar 3 Nov +\x03?21:05\/09$/);
});

test('the plugin is a valid plugin with permissions that takes the screen and names every server it talks to', () => {
  const dir = new URL('../../docs/ejemplos/teletexto', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const p = readPlugin(dir);
  assert.deepEqual(p.problems, []);
  assert.equal(p.panel.placement, 'screen');
  const hosts = p.permissions.filter((x) => x.startsWith('network:')).map((x) => x.slice(8)).sort();
  const wanted = [...new Set([...SOURCES.map((s) => new URL(s[2]).hostname), 'api.open-meteo.com'])].sort();
  assert.deepEqual(hosts, wanted, 'the manifest asks for exactly the servers the code uses');
});
