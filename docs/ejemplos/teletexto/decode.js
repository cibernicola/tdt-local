// Teletext level 1 (ETSI EN 300 706): decoding a page into cells to paint. Pure functions, no DOM.
// Adapted, almost unchanged, from the teletext of the pull request 3 of TDT local by Antonio Bueno Martín (antoniobuen0).
//
// A row is 40 cells. A cell is a character or a control code; control codes change colour, background, mosaic
// graphics and double height for the cells that follow, and are themselves shown as blanks. Not implemented (they do
// not appear in the pages this plugin builds): flash, concealed text, boxes, hold graphics and the higher levels.

export const COLS = 40;
export const ROWS = 25; // row 0 is the header, rows 1 to 24 come from the page
export const PALETTE = ['#000000', '#ff3030', '#30ff30', '#ffff30', '#4040ff', '#ff30ff', '#30ffff', '#ffffff'];

// The Spanish/Portuguese national option: these 7-bit codes are drawn as accented letters.
const NATIONAL = {
  '#': 'ç', '@': '¡', '[': 'á', '\\': 'é', ']': 'í', '^': 'ó', _: 'ú', '`': '¿', '{': 'ü', '|': 'ñ', '}': 'è', '~': 'à',
};
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const ESC = '\x1b';
const BLANK = ' '.repeat(COLS);

/**
 * "OL,<row>,<text>" lines -> 25 strings of 40 raw characters. A control code is written as ESC followed by
 * `code | 0x40` in the lines; in the result it is the character with the code itself (below 0x20).
 */
export function parseOutputLines(text) {
  const rows = Array.from({ length: ROWS }, () => BLANK);
  for (const line of String(text || '').split('\n')) {
    const m = /^OL,(\d{1,2}),(.*)$/s.exec(line);
    if (!m || Number(m[1]) >= ROWS) continue;
    let raw = '';
    const body = m[2];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === ESC && i + 1 < body.length) raw += String.fromCharCode(body.charCodeAt(++i) & 0x1f);
      else raw += body[i];
    }
    rows[Number(m[1])] = raw.slice(0, COLS).padEnd(COLS, ' ');
  }
  return rows;
}

/** Bits of a mosaic character (0x20-0x3F, 0x60-0x7F): top-left, top-right, middle-left, … bottom-right, as bits 0 to 5. */
export function mosaicBits(code) {
  return (code & 0x1f) | (code & 0x40 ? 0x20 : 0);
}

/**
 * One row -> `{cells, tall}`. Each cell: `{ch, fg, bg, bits, separated, tall}` where `bits` is 0 unless the cell is a
 * mosaic block. `tall` tells that some cell is double height: it takes the row below as well.
 */
export function decodeRow(row) {
  let fg = 7;
  let bg = 0;
  let mosaic = false;
  let separated = false;
  let tall = false;
  let any = false;
  const cells = [];
  for (let i = 0; i < COLS; i++) {
    const code = (row.charCodeAt(i) || 0x20) & 0x7f;
    let after = null; // attributes that start with the NEXT cell
    if (code < 0x20) {
      if (code >= 0x01 && code <= 0x07) after = () => { mosaic = false; fg = code; };
      else if (code >= 0x11 && code <= 0x17) after = () => { mosaic = true; fg = code - 0x10; };
      else if (code === 0x0d) after = () => { tall = true; any = true; };
      else if (code === 0x0c) tall = false;
      else if (code === 0x1d) bg = fg;
      else if (code === 0x1c) bg = 0;
      else if (code === 0x19) separated = false;
      else if (code === 0x1a) separated = true;
      cells.push({ ch: ' ', fg, bg, bits: 0, separated, tall });
      if (after) after();
      continue;
    }
    if (mosaic && (code < 0x40 || code >= 0x60)) {
      cells.push({ ch: ' ', fg, bg, bits: mosaicBits(code), separated, tall });
    } else {
      const ch = String.fromCharCode(code);
      cells.push({ ch: code === 0x7f ? '■' : NATIONAL[ch] || ch, fg, bg, bits: 0, separated, tall });
    }
  }
  return { cells, tall: any };
}

/** The 25 rows decoded. A row under a double-height row is `covered`: it is not painted. */
export function decodePage(rows) {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    const d = decodeRow(rows[r] || BLANK);
    out.push({ ...d, covered: r > 0 && out[r - 1].tall && !out[r - 1].covered });
  }
  return out;
}

/** Row 0: the service name, the page number, the date and the time (in yellow, like the real ones). */
export function headerRow(page, now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const left = `TELETEXTO ${page}  ${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]} `;
  const time = `${p2(now.getHours())}:${p2(now.getMinutes())}/${p2(now.getSeconds())}`;
  return ('\x07' + left).padEnd(COLS - time.length - 1, ' ') + '\x03' + time;
}

/** A page as readable lines (for assistive technology): control codes are blanks, national characters accented. */
export function plainText(rows) {
  return rows.map((row) => decodeRow(row).cells.map((c) => (c.bits ? ' ' : c.ch)).join('').trimEnd());
}
