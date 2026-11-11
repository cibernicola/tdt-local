window.busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* hog */ } return 'busy done'; };
window.mem = (mb) => { window.__hold = window.__hold || []; for (let i = 0; i < mb; i++) window.__hold.push(new Uint8Array(1024 * 1024).fill(i & 255)); return window.__hold.length + ' MB held'; };
window.flood = (n) => { for (let i = 0; i < n; i++) window.parent.postMessage({ tdt: 1, id: 1e9 + i, method: 'player.state', args: [] }, '*'); return n + ' posted'; };
window.bench = async (method, n, ...args) => { const t0 = performance.now(); for (let i = 0; i < n; i++) await method.split('.').reduce((o, k) => o[k], tdt)(...args.map((a) => (typeof a === 'string' && a.includes('{i}') ? a.replace('{i}', i) : a))); return ((performance.now() - t0) / n).toFixed(3) + ' ms/call'; };
// the code of the error of a call, or OK: what the bench asks to see that errors can be told apart
window.code = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return e.code || ('SIN-CODIGO:' + e.message); } };
// nothing is read from the answer of a call that is never made: this only floods
window.callMany = async (n) => { const codes = {}; await Promise.all(Array.from({ length: n }, () => tdt.player.state().then(() => 'OK', (e) => e.code).then((c) => { codes[c] = (codes[c] || 0) + 1; }))); return JSON.stringify(codes); };
