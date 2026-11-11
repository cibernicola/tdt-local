// The slot «tile.overlay»: layers that plugins put over the picture of a tile (docs/HACKEABLE.md). Each overlay is an entry of the registry «tile.overlay»:
//
//   tdt.register('tile.overlay', 'my-clock', { mount(ctx) { const el = document.createElement('div'); ...; return { el, update(ctx) { ... }, destroy() { ... } }; } });
//
// `mount(ctx)` is called once for EACH tile (there are four) and returns an element, or `{el, update, destroy}`, or nothing if this overlay does not want this tile (it is asked
// again whenever something about the tile changes: the channel, which tile has the sound, single or multi view). `update(ctx)` is called on those changes and `destroy()` when
// the overlay goes: because its plugin was turned off, replaced by another with the same id, or the tile was emptied. `ctx` is `{tile: {index, focus, channel: {id, name, kind} | null},
// mode: 'single' | 'multi'}`. The box they go in covers the tile, lets every click through, and sits above the picture and the bar; an overlay that wants clicks asks for them
// (`pointer-events: auto` on its element). Pure: the DOM it works on comes in as `container`, so it is tested without a browser.

const isElement = (x) => !!x && typeof x === 'object' && x.nodeType === 1;

/**
 * @param {object} o
 * @param {() => {id: string, entry: {mount: Function}}[]} o.list the overlays in force (`hooks.list('tile.overlay')`)
 * @param {{append: (el: object) => void}} o.container where they go
 * @param {() => object} o.context what `mount` and `update` are given
 * @param {(id: string, error: unknown) => void} [o.onError] an overlay that throws is skipped, and told here
 */
export function createOverlays({ list, container, context, onError = () => {} }) {
  const live = new Map(); // id -> {entry, el, handle}

  const call = (id, where, fn) => {
    try {
      return fn();
    } catch (error) {
      onError(id, new Error(`${where}: ${error && error.message ? error.message : error}`));
      return undefined;
    }
  };

  function drop(id) {
    const item = live.get(id);
    live.delete(id);
    if (!item) return;
    if (item.handle && typeof item.handle.destroy === 'function') call(id, 'destroy', () => item.handle.destroy());
    call(id, 'quitar', () => item.el.remove());
  }

  function mount(id, entry) {
    const made = call(id, 'mount', () => entry.mount(context()));
    const el = made && made.el !== undefined ? made.el : made;
    if (!isElement(el)) return; // it does not want this tile (for now)
    call(id, 'añadir', () => container.append(el));
    live.set(id, { entry, el, handle: made && made.el !== undefined ? made : {} });
  }

  /** The overlays in force changed (or the tile did): take away those that are gone or replaced, put in those that are new. */
  function sync() {
    const wanted = new Map(list().map(({ id, entry }) => [id, entry]));
    for (const [id, item] of [...live]) if (wanted.get(id) !== item.entry) drop(id);
    for (const [id, entry] of wanted) if (!live.has(id) && entry && typeof entry.mount === 'function') mount(id, entry);
  }

  /** Something about the tile changed: those that were not wanted may be now, and those that are there are told. */
  function refresh() {
    sync();
    const ctx = context();
    for (const [id, item] of live) if (item.handle && typeof item.handle.update === 'function') call(id, 'update', () => item.handle.update(ctx));
  }

  /** Take everything away (the tile is emptied). They come back, asked again, on the next refresh. */
  function clear() {
    for (const id of [...live.keys()]) drop(id);
  }

  return { sync, refresh, clear, ids: () => [...live.keys()] };
}
