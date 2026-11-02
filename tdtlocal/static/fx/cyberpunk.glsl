//!HOOK OUTPUT
//!BIND HOOKED
//!DESC TDT local fx: cyberpunk
// SPDX-License-Identifier: Apache-2.0 - TDT local contributors. WebGL2 (browser) and mpv (--glsl-shaders) share this file.
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec4 hook(){
  float t=float(frame)/25.0; vec2 S=HOOKED_size; vec2 uv=HOOKED_pos;
  float band=floor(uv.y*28.0); float gl=step(0.93,hash(vec2(band,floor(t*9.0))));
  uv.x+=gl*(hash(vec2(band,t))-0.5)*0.12;
  float ab=0.0035+gl*0.012+0.002*sin(t*3.0);
  vec3 c=vec3(HOOKED_tex(uv+vec2(ab,0.0)).r,HOOKED_tex(uv).g,HOOKED_tex(uv-vec2(ab,0.0)).b);
  float lum=dot(c,vec3(.299,.587,.114));
  vec3 shadow=vec3(0.02,0.10,0.28), mid=vec3(0.0,0.9,0.95), high=vec3(1.0,0.12,0.62);
  vec3 g=lum<0.5?mix(shadow,mid,lum*2.0):mix(mid,high,(lum-0.5)*2.0);
  c=mix(c,g,0.55)*1.15;
  vec3 bloom=vec3(0.0); for(int i=0;i<8;i++){float a=float(i)*0.785; vec3 s=HOOKED_tex(uv+vec2(cos(a),sin(a))*0.012).rgb; bloom+=max(s-0.65,0.0);}
  c+=bloom*vec3(0.6,0.15,0.5)*0.55;
  c*=0.82+0.18*sin(uv.y*S.y*3.14159);
  vec2 q=HOOKED_pos-0.5; c*=1.0-dot(q,q)*1.1;
  return vec4(c,1.0);
}
