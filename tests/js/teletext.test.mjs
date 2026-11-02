import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COLS, ROWS, decodePage, decodeRow, headerRow, mosaicBits, parseOutputLines, plainText } from '../../tdtlocal/static/js/lib/teletext.js';

const row = (s) => s.padEnd(COLS, ' ');
const E = '\x1b';

test('parseOutputLines decodes ESC-coded control codes and pads the rows', () => {
  const rows = parseOutputLines(`OL,1,${E}CHola\nOL,24,${E}ARojo`);
  assert.equal(rows.length, ROWS);
  assert.equal(rows[1].length, COLS);
  assert.equal(rows[1].charCodeAt(0), 0x03); // ESC C = code 3 = yellow
  assert.equal(rows[1].slice(1, 5), 'Hola');
  assert.equal(rows[24].charCodeAt(0), 0x01);
  assert.equal(rows[0], ' '.repeat(COLS)); // rows that are not in the page are blank
});

test('parseOutputLines ignores nonsense and rows outside the screen', () => {
  const rows = parseOutputLines('basura\nOL,99,x\nOL,2,ok');
  assert.equal(rows[2].slice(0, 2), 'ok');
  assert.equal(parseOutputLines(undefined).length, ROWS);
});

test('a colour code is shown as a blank and changes the cells after it', () => {
  const { cells } = decodeRow(row('\x03AB\x06C'));
  assert.deepEqual(cells[0], { ch: ' ', fg: 7, bg: 0, bits: 0, separated: false, tall: false });
  assert.equal(cells[1].ch, 'A');
  assert.equal(cells[1].fg, 3);
  assert.equal(cells[2].fg, 3);
  assert.equal(cells[4].fg, 6);
});

test('new background takes the current colour at its own cell; black background resets it', () => {
  const { cells } = decodeRow(row('\x04\x1d\x07A\x1cB'));
  assert.equal(cells[1].bg, 4); // the control cell itself already has the new background
  assert.equal(cells[3].bg, 4);
  assert.equal(cells[3].fg, 7);
  assert.equal(cells[5].bg, 0);
});

test('double height marks the row and covers the next one', () => {
  const rows = [row(''), row('\x0d\x03TITULAR'), row('no se pinta'), row('normal')];
  const page = decodePage(rows);
  assert.equal(page[1].tall, true);
  assert.equal(page[1].cells[2].tall, true);
  assert.equal(page[2].covered, true);
  assert.equal(page[3].covered, false);
  assert.equal(page[0].covered, false);
});

test('mosaic graphics: bits, colour and contiguous or separated blocks', () => {
  assert.equal(mosaicBits(0x20), 0);
  assert.equal(mosaicBits(0x7f), 0x3f);
  assert.equal(mosaicBits(0x21), 0b000001); // top-left
  assert.equal(mosaicBits(0x60 | 0x01), 0b100001); // bottom-right plus top-left
  const { cells } = decodeRow(row('\x12\x7f\x1a\x7f\x19\x7f\x41'));
  assert.equal(cells[1].bits, 0x3f);
  assert.equal(cells[1].fg, 2);
  assert.equal(cells[3].separated, true);
  assert.equal(cells[5].separated, false);
  assert.equal(cells[6].bits, 0); // 0x41 is a capital letter even in mosaic mode
  assert.equal(cells[6].ch, 'A');
});

test('the Spanish national characters', () => {
  const { cells } = decodeRow(row('A|o [ \\ ] ^ _ ` @'));
  assert.equal(cells.map((c) => c.ch).join('').trimEnd(), 'Año á é í ó ú ¿ ¡');
});

test('headerRow is exactly one row and carries the page number and the time in yellow', () => {
  const h = headerRow('101', new Date(2026, 10, 2, 8, 5, 9));
  assert.equal(h.length, COLS);
  assert.ok(h.includes('TELETEXTO 101'));
  assert.ok(h.includes('Lun 2 Nov'));
  assert.ok(h.endsWith('\x0308:05/09'));
});

test('plainText gives readable lines without control codes', () => {
  const text = plainText([row('\x03A|o'), row('')]);
  assert.equal(text[0], ' Año');
  assert.equal(text[1], '');
});
