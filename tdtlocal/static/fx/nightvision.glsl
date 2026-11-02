//!HOOK OUTPUT
//!BIND HOOKED
//!DESC TDT local fx: nightvision
// SPDX-License-Identifier: Apache-2.0 - TDT local contributors. WebGL2 (browser) and mpv (--glsl-shaders) share this file.
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec4 hook(){
  float t=float(frame)/25.0; vec2 S=HOOKED_size; vec2 uv=HOOKED_pos; vec3 c=HOOKED_tex(uv).rgb;
  float lum=dot(c,vec3(.299,.587,.114)); lum=clamp(pow(lum,0.7)*1.8,0.0,1.0)+(hash(uv*S+t*17.0)-0.5)*0.22;
  vec3 g=vec3(0.1,1.0,0.25)*lum; g*=0.88+0.12*sin(uv.y*S.y*2.0);
  vec2 q=uv-0.5; float v=smoothstep(0.62,0.28,length(q*vec2(1.0,0.8))); return vec4(g*v,1.0);
}
