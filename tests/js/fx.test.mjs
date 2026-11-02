import assert from 'node:assert/strict';
import { test } from 'node:test';

import { effectList, fragmentSource, VERTEX } from '../../tdtlocal/static/js/lib/fx.js';

test('fragmentSource drops the mpv directives and adds the WebGL2 bridge', () => {
  const src = fragmentSource('//!HOOK OUTPUT\n//!BIND HOOKED\n//!DESC x\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n');
  assert.ok(src.startsWith('#version 300 es'));
  assert.ok(!src.includes('//!'));
  assert.ok(src.includes('vec4 hook()'));
  assert.ok(src.trimEnd().endsWith('void main() { outColor = hook(); }'));
});

test('the vertex shader puts the origin at the top left, like mpv', () => {
  assert.ok(VERTEX.includes('0.5 - a.y * 0.5'));
});

test('effectList keeps the order and fills in the labels', () => {
  const list = effectList({ a: { label: 'A', desc: 'x' }, b: { tone: 9000 } });
  assert.deepEqual(list.map((e) => e.name), ['a', 'b']);
  assert.equal(list[1].label, 'b');
  assert.equal(list[1].tone, 9000);
  assert.equal(list[0].tone, 0);
});
