/**
 * Second-order dynamics (f, zeta, r) — the spring behind every "alive" motion (handbook ch.5.5).
 * Written fresh from the closed-form semi-implicit Euler formulation:
 *   y + k1*y' + k2*y'' = x + k3*x'
 *   f    natural frequency (Hz)   — how fast it responds
 *   zeta damping ratio            — <1 wobbles, 1 critical, >1 sluggish
 *   r    initial response         — <0 anticipates, >1 overshoots
 */
export class Spring {
  private k1 = 0; private k2 = 0; private k3 = 0
  private xp: number; value: number; velocity = 0
  constructor(public x0 = 0, f = 2, zeta = 0.6, r = 1) {
    this.xp = x0; this.value = x0
    this.tune(f, zeta, r)
  }
  tune(f: number, zeta: number, r: number) {
    const w = 2 * Math.PI * f
    this.k1 = zeta / (Math.PI * f)
    this.k2 = 1 / (w * w)
    this.k3 = (r * zeta) / w
    return this
  }
  reset(v: number) { this.value = this.xp = v; this.velocity = 0 }
  update(x: number, dt: number, xd?: number) {
    if (dt <= 0) return this.value
    if (xd === undefined) { xd = (x - this.xp) / dt; this.xp = x }
    // clamp k2 for stability (pole matching lite)
    const k2 = Math.max(this.k2, (dt * dt) / 2 + (dt * this.k1) / 2, dt * this.k1)
    this.value += dt * this.velocity
    this.velocity += (dt * (x + this.k3 * xd - this.value - this.k1 * this.velocity)) / k2
    return this.value
  }
}

/** Vector convenience: three independent springs sharing one tuning. */
export class Spring3 {
  x: Spring; y: Spring; z: Spring
  constructor(v = { x: 0, y: 0, z: 0 }, f = 2, zeta = 0.6, r = 1) {
    this.x = new Spring(v.x, f, zeta, r); this.y = new Spring(v.y, f, zeta, r); this.z = new Spring(v.z, f, zeta, r)
  }
  update(t: { x: number; y: number; z: number }, dt: number) {
    return { x: this.x.update(t.x, dt), y: this.y.update(t.y, dt), z: this.z.update(t.z, dt) }
  }
}
