//!HOOK OUTPUT
//!BIND HOOKED
//!DESC TDT local fx: glitch
// SPDX-License-Identifier: Apache-2.0 - TDT local contributors. WebGL2 (browser) and mpv (--glsl-shaders) share this file.
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec4 hook(){
  float t=float(frame)/25.0; vec2 uv=HOOKED_pos; float k=floor(t*7.0);
  vec2 blk=floor(uv*vec2(10.0,18.0)); float h=hash(blk+k); float on=step(0.9,h)*step(0.35,hash(vec2(k,3.0)));
  vec2 off=on*vec2((hash(blk+k*1.3)-0.5)*0.25,(hash(blk+k*2.1)-0.5)*0.05);
  float ab=0.004+on*0.02; vec3 c=vec3(HOOKED_tex(uv+off+vec2(ab,0.0)).r,HOOKED_tex(uv+off).g,HOOKED_tex(uv+off-vec2(ab,0.0)).b);
  c=mix(c,c.gbr,on*0.5); float row=step(0.985,hash(vec2(floor(uv.y*220.0),k))); c=mix(c,vec3(1.0)-c,row);
  return vec4(c,1.0);
}
