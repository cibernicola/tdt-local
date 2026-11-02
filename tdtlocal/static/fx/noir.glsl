//!HOOK OUTPUT
//!BIND HOOKED
//!DESC TDT local fx: noir
// SPDX-License-Identifier: Apache-2.0 - TDT local contributors. WebGL2 (browser) and mpv (--glsl-shaders) share this file.
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec4 hook(){
  float t=float(frame)/25.0; vec2 S=HOOKED_size; vec2 uv=HOOKED_pos; vec3 c=HOOKED_tex(uv).rgb;
  float lum=dot(c,vec3(.299,.587,.114)); lum=smoothstep(0.08,0.92,lum); lum+=(hash(uv*S+t*9.0)-0.5)*0.07;
  float scratch=step(0.9985,hash(vec2(floor(uv.x*S.x*0.5),floor(t*12.0)))); lum=mix(lum,1.0,scratch*0.6);
  vec2 q=uv-0.5; lum*=1.0-dot(q,q)*1.3; return vec4(vec3(lum),1.0);
}
