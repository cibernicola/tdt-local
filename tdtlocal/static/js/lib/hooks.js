// The hooks of the page: the way the application lets others look at, change or replace what it does (docs/HACKEABLE.md).
//   action    ``on(name, fn, priority)`` / ``do(name, data)``      something happened: whoever listens reacts. It is the event hub of the page.
//   filter    ``filter(name, fn, priority)`` / ``apply(name, v, ctx)``   a value goes through a chain and each link may change it.
//   registry  ``register(registry, id, entry, priority)`` / ``get`` / ``list``   things the application treats alike whoever brought them.
// Every way of adding something returns the way to take it away again, and taking it away puts back what was there before.
// The lowest priority number goes first (filters) or wins (registries); the same number, the one that came last.
// Nothing here knows what a player or an ad break is: the application names its own hooks.
export const DEFAULT_PRIORITY = 10;

const byOrder = (a, b) => a.priority - b.priority || a.seq - b.seq;

/**
 * @param {{hub: {on: Function, emit: Function}, onError?: (name: string, error: unknown) => void}} options
 *   ``hub``: the events of the page (lib/events.js ``createHub``); ``onError``: a filter that throws is skipped, and what it threw goes here.
 */
export function createHooks({ hub, onError = () => {} }) {
  let seq = 0;
  const filters = new Map(); // name -> [{fn, priority, seq}] in the order they run
  const registries = new Map(); // registry -> Map(id -> [{entry, priority, seq}])
  const watchers = new Map(); // registry -> Set of functions told when something is added to it or taken away

  const changed = (registry) => {
    for (const fn of [...(watchers.get(registry) || [])]) {
      try {
        fn();
      } catch (error) {
        onError('registro «' + registry + '»', error);
      }
    }
  };

  const winner = (list) => list.reduce((best, item) => (!best || item.priority < best.priority || (item.priority === best.priority && item.seq > best.seq) ? item : best), null);

  return {
    /** Listen to an event: `fn(data, name)` (the hub itself says `(name, data)`; this is the order a plugin reads). Returns the way to stop. */
    on(name, fn, priority = DEFAULT_PRIORITY) {
      if (typeof fn !== 'function') throw new TypeError('on(evento, función)');
      return hub.on(name, (told, data) => fn(data, told), priority);
    },

    /** Tell that something happened (the event goes into the log of the page, too). */
    do: (name, data = {}) => hub.emit(name, data),

    /** Add a link to the chain of a filter. A link returns the new value, or nothing to leave it as it is. */
    filter(name, fn, priority = DEFAULT_PRIORITY) {
      if (typeof fn !== 'function') throw new TypeError('filter(nombre, función)');
      if (!filters.has(name)) filters.set(name, []);
      const list = filters.get(name);
      const item = { fn, priority: Number(priority) || 0, seq: ++seq };
      list.push(item);
      list.sort(byOrder);
      return () => {
        const at = list.indexOf(item);
        if (at >= 0) list.splice(at, 1);
      };
    },

    /** Pass a value through the chain. A link that throws is skipped (and told to ``onError``): the chain never breaks. */
    apply(name, value, ctx = {}) {
      for (const { fn } of [...(filters.get(name) || [])]) {
        try {
          const out = fn(value, ctx);
          if (out !== undefined) value = out;
        } catch (error) {
          onError(name, error);
        }
      }
      return value;
    },

    /** Add a thing to a registry. The one with the lowest priority number is used; if the same number, the last one added. */
    register(registry, id, entry, priority = DEFAULT_PRIORITY) {
      if (!registries.has(registry)) registries.set(registry, new Map());
      const ids = registries.get(registry);
      if (!ids.has(id)) ids.set(id, []);
      const item = { entry, priority: Number(priority) || 0, seq: ++seq };
      ids.get(id).push(item);
      changed(registry);
      return () => {
        const list = ids.get(id);
        const at = list ? list.indexOf(item) : -1;
        if (at < 0) return; // already taken away
        list.splice(at, 1);
        if (!list.length) ids.delete(id);
        changed(registry);
      };
    },

    /** Be told (`fn()`, no arguments: ask `list` again) whenever something is added to a registry or taken away, a plugin going away included. Returns the way to stop. */
    watch(registry, fn) {
      if (typeof fn !== 'function') throw new TypeError('watch(registro, función)');
      if (!watchers.has(registry)) watchers.set(registry, new Set());
      watchers.get(registry).add(fn);
      return () => watchers.get(registry).delete(fn);
    },

    /** The thing in force under this name, or ``undefined``. */
    get(registry, id) {
      const list = registries.get(registry) && registries.get(registry).get(id);
      const item = list && winner(list);
      return item ? item.entry : undefined;
    },

    /** Everything in force in a registry, as ``[{id, entry}]``, in the order it came in. */
    list(registry) {
      const ids = registries.get(registry);
      return ids ? [...ids].map(([id, list]) => ({ id, entry: winner(list).entry })) : [];
    },

    /** What is in the filters (the names and how many links each has): to see it in the inspector. */
    chains() {
      return [...filters].filter(([, list]) => list.length).map(([name, list]) => ({ name, links: list.length }));
    },
  };
}
