// Style sheets that plugins put in the page (a theme, or `tdt.css(text)`): each one under a key, after the page's own style sheet so that it wins ties, and taken away
// when the key is cleared. They are constructable style sheets: the policy of the page allows no `<style>` with text in it, and these are not that. Without the desktop app or a
// plugin there is nothing here and nothing happens.
const sheets = new Map(); // key -> CSSStyleSheet

/**
 * Put a style sheet in the page under `key` (or take it away, with an empty text). A key used before is replaced. Returns the way to take it away.
 * @param {string} key
 * @param {string} css
 * @returns {() => void}
 */
export function setStyle(key, css) {
  const old = sheets.get(key);
  if (old) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== old);
    sheets.delete(key);
  }
  let mine = null;
  if (css) {
    mine = new CSSStyleSheet();
    mine.replaceSync(css);
    sheets.set(key, mine);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, mine];
  }
  return () => {
    if (mine && sheets.get(key) === mine) setStyle(key, ''); // only the one this call put in: a later one under the same key stays
  };
}

/** The keys in use: to see what plugins have put in the page. */
export const styleKeys = () => [...sheets.keys()];
