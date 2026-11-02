//!HOOK OUTPUT
//!BIND HOOKED
//!DESC TDT local fx: vhs
// SPDX-License-Identifier: Apache-2.0 - TDT local contributors. WebGL2 (browser) and mpv (--glsl-shaders) share this file.
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec4 hook(){
  float t=float(frame)/25.0; vec2 S=HOOKED_size; vec2 uv=HOOKED_pos;
  float m=smoothstep(0.455,0.5,abs(fract(uv.y-t*0.11)-0.5)); // narrow tracking band
  uv.x+=sin(uv.y*40.0+t*6.0)*0.0012+ m*0.02*sin(uv.y*200.0+t*30.0);
  float bleed=0.004; vec3 c=vec3(HOOKED_tex(uv+vec2(bleed,0.0)).r,HOOKED_tex(uv).g,HOOKED_tex(uv-vec2(bleed,0.0)).b);
  float lum=dot(c,vec3(.299,.587,.114)); c=mix(vec3(lum),c,0.8)*vec3(1.04,1.0,0.94);
  c+=(hash(uv*S+t*13.0)-0.5)*0.10*(1.0+m*3.0);
  c*=0.9+0.1*sin(uv.y*S.y*1.5); c=pow(c,vec3(1.08)); c=(c-0.5)*0.92+0.5;
  return vec4(c,1.0);
}
