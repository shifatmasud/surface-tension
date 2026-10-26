// Layer 1 — pure maths. No DOM, no WebGL, no state.
export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))
export const mix = (a: number, b: number, t: number) => a + (b - a) * t
export const fit = (v: number, a: number, b: number, c: number, d: number, ease?: (t: number) => number) => {
  let t = clamp((v - a) / (b - a))
  if (ease) t = ease(t)
  return c + (d - c) * t
}
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
/** Frame-rate independent exponential approach: same feel at 30, 60 or 144 Hz. */
export const damp = (a: number, b: number, lambda: number, dt: number) => mix(a, b, 1 - Math.exp(-lambda * dt))
/** k^dt style decay, normalised to 60 Hz frames. */
export const decay = (k: number, dt: number) => Math.pow(k, dt * 60)
export const TAU = Math.PI * 2

/** 1D value noise (Simple1DNoise equivalent, written fresh): smooth, cheap, seeded. */
export class Noise1D {
  private r: Float32Array
  constructor(seed = 1, private size = 256) {
    this.r = new Float32Array(size)
    let s = seed * 9301 + 49297
    for (let i = 0; i < size; i++) { s = (s * 9301 + 49297) % 233280; this.r[i] = s / 233280 }
  }
  get(x: number) {
    const xi = Math.floor(x), t = x - xi
    const a = this.r[((xi % this.size) + this.size) % this.size]
    const b = this.r[(((xi + 1) % this.size) + this.size) % this.size]
    const u = t * t * (3 - 2 * t)
    return a + (b - a) * u
  }
}

/** Brownian motion: a few octaves of 1D noise per axis, used for idle camera drift and tile bob. */
export class BrownianMotion {
  private nx = new Noise1D(11); private ny = new Noise1D(23); private nz = new Noise1D(37)
  private t = Math.random() * 100
  value = { x: 0, y: 0, z: 0 }
  constructor(public speed = 0.35, public octaves = 3) {}
  private qid = 0
  update(dt: number) {
    const q = (globalThis as any).__qClock   // R7.11 QA CLOCK (absent by default): a fixed-step test restarts every drift at t = 0
    if (q && this.qid !== q.id) { this.qid = q.id; this.t = 0 }
    this.t += dt * this.speed
    let x = 0, y = 0, z = 0, amp = 1, f = 1, norm = 0
    for (let o = 0; o < this.octaves; o++) {
      x += (this.nx.get(this.t * f) - 0.5) * amp
      y += (this.ny.get(this.t * f + 13.1) - 0.5) * amp
      z += (this.nz.get(this.t * f + 71.7) - 0.5) * amp
      norm += amp; amp *= 0.5; f *= 2.03
    }
    this.value.x = (x / norm) * 2; this.value.y = (y / norm) * 2; this.value.z = (z / norm) * 2
    return this.value
  }
}
