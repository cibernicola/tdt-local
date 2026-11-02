// The "Efectos" dialog: image effects (Matrix, ASCII, Canal+, cyberpunk…) on the picture of the active tile.
// Each effect is a GLSL file in /fx (see fx.json). They run in WebGL2 on a canvas laid over the <video>; the same files
// work as mpv "hook" shaders. The audio is untouched, except the whistle of the Canal+ decoder.
import { $, el } from './dom.js';
import { VERTEX, effectList, fragmentSource } from './lib/fx.js';
import { focusTile } from './state.js';
import { store } from './store.js';

const MAX_WIDTH = 1280; // the canvas is not bigger than this; CSS scales it to the tile
const WHISTLE_GAIN = 0.03;
const programs = new Map(); // effect name -> {program, uniforms}
let defs = null;
let current = store.get('fx', '') || '';
let gl = null;
let canvas = null;
let texture = null;
let active = null; // the program being drawn
let host = null; // the tile element that holds the canvas
let raf = 0;
let whistle = null; // {ctx, osc, gain}

const dlg = () => $('fxDlg');

async function loadDefs() {
  if (defs) return true;
  try {
    defs = await (await fetch('/fx/fx.json', { cache: 'no-store' })).json();
    return true;
  } catch { return false; }
}

function ensureGl() {
  if (gl) return true;
  canvas = el('canvas', 'fx-canvas');
  canvas.setAttribute('aria-hidden', 'true');
  gl = canvas.getContext('webgl2', { alpha: false });
  if (!gl) return false;
  texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  return true;
}

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader');
  return shader;
}

async function programFor(name) {
  if (programs.has(name)) return programs.get(name);
  const text = await (await fetch('/fx/' + defs[name].shader, { cache: 'no-store' })).text();
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource(text)));
  gl.bindAttribLocation(program, 0, 'a');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'link');
  const uniforms = Object.fromEntries(['u_tex', 'u_size', 'frame', 'random'].map((k) => [k, gl.getUniformLocation(program, k)]));
  const entry = { program, uniforms };
  programs.set(name, entry);
  return entry;
}

/** Keep the canvas inside the focused tile, right after its <video>. */
function attach(tile) {
  const parent = tile && tile.video && tile.video.parentElement;
  if (parent === host) return;
  host = parent || null;
  if (host && canvas) host.insertBefore(canvas, tile.video.nextSibling);
}

function draw() {
  raf = requestAnimationFrame(draw);
  const tile = focusTile();
  attach(tile);
  const v = tile && tile.video;
  if (!active || !v || v.readyState < 2 || !v.videoWidth) { canvas.style.visibility = 'hidden'; return; }
  const w = Math.min(v.videoWidth, MAX_WIDTH);
  const h = Math.round((w * v.videoHeight) / v.videoWidth);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h);
  gl.useProgram(active.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
  } catch { canvas.style.visibility = 'hidden'; return; } // a picture the page may not read: leave the video as it is
  const u = active.uniforms;
  gl.uniform1i(u.u_tex, 0);
  gl.uniform2f(u.u_size, w, h);
  gl.uniform1i(u.frame, Math.floor(performance.now() / 40)); // 25 frames per second, like the mpv shaders expect
  gl.uniform1f(u.random, Math.random());
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  canvas.style.visibility = 'visible';
}

function setWhistle(hz) {
  if (!hz) { if (whistle) whistle.gain.gain.value = 0; return; }
  if (!whistle) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    whistle = { ctx, osc, gain };
  }
  whistle.ctx.resume();
  whistle.osc.frequency.value = hz;
  whistle.gain.gain.value = WHISTLE_GAIN;
}

function paint() {
  for (const input of document.querySelectorAll('#fxList input')) input.checked = input.value === current;
  $('btnFx').setAttribute('aria-pressed', current ? 'true' : 'false');
}

/** Choose an effect (`''` for none). Resolves once it is on, or says why it could not be. */
export async function applyFx(name) {
  const msg = $('fxMsg');
  msg.textContent = '';
  if (!name) {
    current = '';
    active = null;
    cancelAnimationFrame(raf);
    raf = 0;
    if (canvas) canvas.style.visibility = 'hidden';
    setWhistle(0);
  } else {
    if (!(await loadDefs()) || !ensureGl()) { msg.textContent = 'Tu navegador no puede aplicar efectos (hace falta WebGL 2).'; return; }
    try { active = await programFor(name); } catch (e) { msg.textContent = 'No se pudo cargar el efecto: ' + e.message; return; }
    current = name;
    setWhistle(defs[name].tone || 0);
    if (!raf) raf = requestAnimationFrame(draw);
  }
  store.set('fx', current);
  paint();
}

async function buildList() {
  if (!(await loadDefs())) { $('fxMsg').textContent = 'No se pudo leer la lista de efectos.'; return; }
  const items = [{ name: '', label: 'Sin efecto', desc: 'La imagen tal cual llega.' }, ...effectList(defs)];
  $('fxList').replaceChildren(...items.map((item) => {
    const input = el('input');
    input.type = 'radio';
    input.name = 'fxChoice';
    input.value = item.name;
    input.addEventListener('change', () => applyFx(item.name));
    const text = el('span');
    text.append(el('strong', '', item.label), el('small', '', item.desc));
    const label = el('label', 'fx-item');
    label.append(input, text);
    return label;
  }));
  paint();
}

export async function toggleFxDialog() {
  if (dlg().open) { dlg().close(); return; }
  await buildList();
  dlg().showModal();
}

export function initFx() {
  $('btnFx').addEventListener('click', toggleFxDialog);
  $('fxClose').addEventListener('click', () => dlg().close());
  if (current) applyFx(current); // the effect chosen last time comes back with the page
}
