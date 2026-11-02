//!HOOK OUTPUT
//!BIND HOOKED
//!DESC TDT local fx: negative
// SPDX-License-Identifier: Apache-2.0 - TDT local contributors. WebGL2 (browser) and mpv (--glsl-shaders) share this file.
vec4 hook(){ return vec4(1.0-HOOKED_tex(HOOKED_pos).rgb,1.0); }
