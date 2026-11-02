//!HOOK OUTPUT
//!BIND HOOKED
//!DESC TDT local fx: ascii
// SPDX-License-Identifier: Apache-2.0 - TDT local contributors. WebGL2 (browser) and mpv (--glsl-shaders) share this file.
// 10 glyphs of 5x7 for " .:-=+*#%@" (7 rows of 5 bits each)
const int G[70]=int[](0,0,0,0,0,0,0, 0,0,0,0,0,12,12, 0,12,12,0,12,12,0, 0,0,0,31,0,0,0, 0,0,31,0,31,0,0,
 0,4,4,31,4,4,0, 0,21,14,31,14,21,0, 10,10,31,10,31,10,10, 25,26,2,4,8,11,19, 14,17,23,21,23,16,14);
vec4 hook(){
  vec2 S=HOOKED_size; float cw=max(6.0,S.y/90.0), ch=cw*1.75; vec2 px=HOOKED_pos*S;
  vec2 cell=floor(px/vec2(cw,ch)); vec2 f=fract(px/vec2(cw,ch));
  vec2 c0=(cell+0.5)*vec2(cw,ch);
  vec3 s=(HOOKED_tex(c0/S).rgb*2.0+HOOKED_tex((c0+vec2(cw,0.0)*0.3)/S).rgb+HOOKED_tex((c0-vec2(cw,0.0)*0.3)/S).rgb)*0.25;
  float lum=clamp(pow(dot(s,vec3(.299,.587,.114)),0.8)*1.15,0.0,0.999);
  int gi=int(lum*10.0); ivec2 g=ivec2(floor(f*vec2(5.0,7.0))); float inside=step(0.1,f.x)*step(f.x,0.9);
  int bit=(G[gi*7+min(g.y,6)]>>(4-min(g.x,4)))&1; float on=float(bit)*inside;
  #ifdef COLOR
  vec3 col=s*1.6*on+s*0.04;
  #else
  vec3 col=vec3(0.15,1.0,0.35)*on*(0.55+lum*0.8)+vec3(0.0,0.03,0.01);
  #endif
  return vec4(col,1.0);
}
