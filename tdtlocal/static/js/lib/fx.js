// Visual effects for the picture: the GLSL files in /fx are written for mpv ("hook" shaders). This turns one of them
// into a WebGL2 fragment shader. Pure functions: the browser tests can run them without a GPU.

export const VERTEX = `#version 300 es
in vec2 a;
out vec2 v_pos;
void main() { v_pos = vec2(a.x * 0.5 + 0.5, 0.5 - a.y * 0.5); gl_Position = vec4(a, 0.0, 1.0); }`;

const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_tex;
uniform vec2 u_size;
uniform int frame;
uniform float random;
in vec2 v_pos;
out vec4 outColor;
#define HOOKED_pos v_pos
#define HOOKED_size u_size
vec4 HOOKED_tex(vec2 p) { return texture(u_tex, p); }
`;

/** The mpv directives (`//!HOOK`, `//!BIND`, `//!DESC`) are comments for WebGL: they are dropped. */
export function fragmentSource(mpvShader) {
  const body = mpvShader.split('\n').filter((l) => !l.startsWith('//!')).join('\n');
  return PRELUDE + body + '\nvoid main() { outColor = hook(); }\n';
}

/** `{name: {label, desc, tone?}}` -> list for the dialog, in file order. */
export function effectList(defs) {
  return Object.entries(defs).map(([name, d]) => ({ name, label: d.label || name, desc: d.desc || '', tone: d.tone || 0 }));
}
