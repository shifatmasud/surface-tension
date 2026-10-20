import * as THREE from 'three'

/**
 * SLIDES (Shifat 17:49Z: "Ensure cursor move fluid displaces each slide image"). A tiny per-card fluid made of splats:
 * every stretch of pointer / finger travel over a slide drops a splat (where, which way, how fast); the fragment
 * shader turns the live splats into a UV displacement — the image is dragged along the stroke, the splat drifts on
 * its own momentum, widens and fades, and a soft ring rolls out of it — then the slide settles. No render targets,
 * no simulation passes: the same cost on every tier, and an idle slide loops over zero splats.
 */
export const NS = 16              // splats per slide (compiled into the shader's loop bound)
export const LIFE = 2.4           // s: a splat's weight is ~0 well before this (exp(-2.2·age))

export class SlideFluid {
  /** packed live splats, oldest first: xy = card-local CSS px (origin top-left, y down), zw = velocity px/s */
  sp: THREE.Vector4[] = Array.from({ length: NS }, () => new THREE.Vector4())
  /** x = birth time (s, shared u_time clock), y = strength 0..1 */
  st: THREE.Vector2[] = Array.from({ length: NS }, () => new THREE.Vector2())
  n = 0
  add(x: number, y: number, vx: number, vy: number, strength: number, t: number) {
    if (this.n === NS) {
      // full: drop the oldest (it is the faintest)
      for (let k = 1; k < NS; k++) { this.sp[k - 1].copy(this.sp[k]); this.st[k - 1].copy(this.st[k]) }
      this.n--
    }
    this.sp[this.n].set(x, y, vx, vy); this.st[this.n].set(t, strength); this.n++
  }
  /** forget splats that have faded out (keeps the shader's loop short on an idle slide) */
  prune(t: number) {
    if (this.n && t - this.st[this.n - 1].x > LIFE) { this.n = 0; return }   // all faded: the idle slide skips the loop
    let k = 0
    while (k < this.n && t - this.st[k].x > LIFE) k++
    if (!k) return
    for (let j = k; j < this.n; j++) { this.sp[j - k].copy(this.sp[j]); this.st[j - k].copy(this.st[j]) }
    this.n -= k
  }
  clear() { this.n = 0 }
}

/** GLSL: the displacement (in card px) and a ring highlight at card px p. Needs u_sp, u_st, u_n, u_time, u_size. */
export const FLUID_GLSL = /* glsl */ `
#define NS ${NS}
uniform vec4 u_sp[NS];
uniform vec2 u_st[NS];
uniform int u_n;
vec2 slideFluid(vec2 p, float W, out float hl){
  vec2 disp = vec2(0.0); hl = 0.0;
  for (int k = 0; k < NS; k++){
    if (k >= u_n) break;
    vec4 s = u_sp[k]; vec2 st = u_st[k];
    float age = max(u_time - st.x, 0.0);
    float fall = exp(-age * 2.2) * st.y;
    // the splat rides its own momentum for a moment (advection), then hangs and spreads
    vec2 c = s.xy + s.zw * (1.0 - exp(-age * 3.0)) * 0.11;
    vec2 dp = p - c;
    float sig = W * (0.055 + 0.11 * age);
    float r = length(dp) / sig;
    float g = exp(-r * r) * fall;
    // drag: sample upstream, so the picture is pulled along the stroke (a smear, like a hand through water)
    disp -= s.zw * g * 0.022;
    // and a soft ring that rolls outward from where the finger went in
    float ring = sin(r * 5.2 - age * 9.0) * exp(-r * 1.1) * fall;
    disp += (dp / max(length(dp), 1e-3)) * ring * W * 0.0065;
    hl += ring * exp(-r * 1.4);
  }
  return disp;
}`
