//!HOOK OUTPUT
//!BIND HOOKED
//!DESC TDT local fx: pixel
// SPDX-License-Identifier: Apache-2.0 - TDT local contributors. WebGL2 (browser) and mpv (--glsl-shaders) share this file.
vec4 hook(){
  vec2 S=HOOKED_size; float px=max(4.0,S.y/150.0)*1.0; vec2 uv=(floor(HOOKED_pos*S/px)+0.5)*px/S; vec3 c=HOOKED_tex(uv).rgb;
  c=floor(c*5.0+0.5)/5.0; vec2 f=fract(HOOKED_pos*S/px); c*=0.85+0.15*step(0.08,f.x)*step(0.08,f.y); return vec4(c,1.0);
}
