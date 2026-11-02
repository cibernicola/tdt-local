//!HOOK OUTPUT
//!BIND HOOKED
//!DESC TDT local fx: canalplus
// SPDX-License-Identifier: Apache-2.0 - TDT local contributors. WebGL2 (browser) and mpv (--glsl-shaders) share this file.
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec4 hook(){
  float t=float(frame)/25.0; vec2 S=HOOKED_size; vec2 uv=HOOKED_pos;
  float line=floor(uv.y*S.y/3.0); float cut=hash(vec2(line,floor(t*25.0)));
  // 'line cut and rotate': every line is cut at a random point and rotated horizontally
  vec2 u=vec2(fract(uv.x+cut*step(0.5,hash(vec2(line,7.0)))),fract(uv.y+t*0.03));
  vec3 c=HOOKED_tex(u).rgb; float lum=dot(c,vec3(.299,.587,.114));
  float inv=step(0.55,hash(vec2(line,floor(t*12.0)+2.0)));       // partial video inversion
  c=mix(vec3(lum),c,0.2); c=mix(c,1.0-c,inv*0.6);
  // the grey bars of the scrambling
  float bandH=1.0/11.0; float band=floor(uv.y/bandH); float by=fract(uv.y/bandH);
  float on=step(0.8,hash(vec2(band,floor(t*4.0))));
  float edge=step(0.06,by)*step(by,0.94);
  float grey=0.42+0.22*hash(vec2(floor(uv.x*S.x/4.0),line+floor(t*30.0)));
  c=mix(c,vec3(grey),on*edge*0.9);
  float sync=step(0.97,hash(vec2(floor(t*8.0),line*0.0+3.0)))*step(uv.y,0.04); c=mix(c,vec3(0.9),sync);
  c+=(hash(uv*S+t)-0.5)*0.08;
  return vec4(c,1.0);
}
