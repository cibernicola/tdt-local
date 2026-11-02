//!HOOK OUTPUT
//!BIND HOOKED
//!DESC TDT local fx: matrix
// SPDX-License-Identifier: Apache-2.0 - TDT local contributors. WebGL2 (browser) and mpv (--glsl-shaders) share this file.
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec4 hook(){
  float t=float(frame)/25.0; vec2 S=HOOKED_size; float cw=max(8.0,S.y/72.0), ch=cw*1.7;
  vec2 px=HOOKED_pos*S; vec2 cell=floor(px/vec2(cw,ch)); vec2 f=fract(px/vec2(cw,ch));
  vec3 src=HOOKED_tex((cell+0.5)*vec2(cw,ch)/S).rgb; float lum=dot(src,vec3(.299,.587,.114));
  float rows=S.y/ch; float cr=hash(vec2(cell.x,3.0)); float speed=0.35+cr*0.9, len=8.0+cr*20.0;
  float head=fract(t*speed*0.25+cr*7.0)*(rows+len)-len*0.2; float d=head-cell.y;
  float trail=(d>0.0&&d<len)?pow(1.0-d/len,1.6):0.0; float isHead=(d>0.0&&d<1.0)?1.0:0.0;
  vec2 g=floor(f*vec2(5.0,7.0)); float seed=hash(cell+floor(t*6.0*(0.4+cr)+d));
  float bit=step(0.5,hash(g+seed*31.0)); float inside=step(0.12,f.x)*step(f.x,0.88)*step(0.08,f.y)*step(f.y,0.92);
  float on=bit*inside*(trail*0.85+isHead);
  vec3 green=mix(vec3(0.0,0.75,0.2),vec3(0.8,1.0,0.85),isHead);
  vec3 base=vec3(0.0,lum*0.55,lum*0.12);
  return vec4(base+green*on*(0.45+lum*1.3),1.0);
}
