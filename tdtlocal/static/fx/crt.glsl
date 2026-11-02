//!HOOK OUTPUT
//!BIND HOOKED
//!DESC TDT local fx: crt
// SPDX-License-Identifier: Apache-2.0 - TDT local contributors. WebGL2 (browser) and mpv (--glsl-shaders) share this file.
vec4 hook(){
  float t=float(frame)/25.0; vec2 S=HOOKED_size; vec2 uv=HOOKED_pos*2.0-1.0;
  uv*=1.0+dot(uv,uv)*0.07; vec2 p=uv*0.5+0.5;
  if(p.x<0.0||p.x>1.0||p.y<0.0||p.y>1.0) return vec4(0.0,0.0,0.0,1.0);
  float ab=0.0012; vec3 c=vec3(HOOKED_tex(p+vec2(ab,0.0)).r,HOOKED_tex(p).g,HOOKED_tex(p-vec2(ab,0.0)).b);
  float scan=0.78+0.22*sin(p.y*S.y*3.14159); float mask=0.86+0.14*sin(p.x*S.x*3.14159*1.0+vec3(0.0,2.1,4.2)).x;
  vec3 m=0.85+0.15*sin(p.x*S.x*2.094+vec3(0.0,2.094,4.188));
  c*=scan*m*(0.96+0.04*sin(t*55.0)); c*=1.12;
  vec2 q=p-0.5; c*=1.0-dot(q,q)*0.9; return vec4(c,1.0);
}
