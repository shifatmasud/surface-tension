import { Spring } from '../../../core/spring'
import { BrownianMotion, decay } from '../../../core/math'

/**
 * Tiny bespoke physics for the floating letter tiles (pattern from ch.7.2, written fresh, no library):
 * spring-to-home, pairwise overlap correction + elastic impulse along the normal, pointer push,
 * exponential damping v *= k^dt, buoyancy on an analytic ring field (CPU mirror of the GPU ripples),
 * and second-order springs on height/tilt for the jelly settle.
 */
export type Ring = { x: number; z: number; t: number; a: number }
export class Body {
  x = 0; z = 0; vx = 0; vz = 0; hx = 0; hz = 0
  r = 0.7; mass = 1
  y = new Spring(0, 1.6, 0.35, 1.4)
  tiltX = new Spring(0, 1.4, 0.3, 1)
  tiltZ = new Spring(0, 1.4, 0.3, 1)
  spin = 0; spinV = 0
  bob = new BrownianMotion(0.25, 3)
  lift = 0
  constructor(public i: number) {}
}
export class HeroPhysics {
  bodies: Body[] = []
  rings: Ring[] = []
  spread = 1
  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const b = new Body(i)
      b.x = (i - (n - 1) / 2) * 3.2 + (Math.random() - 0.5) * 1.2; b.z = -6 - Math.random() * 5 // fly in from the far side, in order
      this.bodies.push(b)
    }
    this.layout(n)
  }
  layout(n: number, gap = 1.5) {
    this.bodies.forEach((b, i) => { b.hx = (i - (n - 1) / 2) * gap - (i === n - 1 ? gap * 0.3 : 0); b.hz = 0.4 + Math.sin(i * 1.7) * 0.25 + (i === n - 1 ? 0.35 : 0) })
  }
  addRing(x: number, z: number, a: number) { this.rings.push({ x, z, t: 0, a }); if (this.rings.length > 24) this.rings.shift() }
  /** analytic water height: travelling damped rings + slow swell */
  height(x: number, z: number, time: number) {
    let h = (Math.sin(x * 0.55 + time * 0.6) * 0.5 + Math.sin(z * 0.42 - time * 0.45 + 1.3) * 0.5) * 0.06
    for (const r of this.rings) {
      const d = Math.hypot(x - r.x, z - r.z), c = r.t * 3.2, w = d - c
      h += -r.a * Math.exp(-r.t * 1.4) * Math.exp(-w * w * 1.2) * Math.cos(w * 3.0)
    }
    return h
  }
  update(dt: number, time: number, pointer: { x: number; z: number; vx: number; vz: number; active: boolean }) {
    for (const r of this.rings) r.t += dt
    this.rings = this.rings.filter((r) => r.t < 4)
    const B = this.bodies
    const k = decay(0.93, dt)
    for (const b of B) {
      // spring to (spread) home
      const tx = b.hx * this.spread, tz = b.hz * this.spread
      b.vx += (tx - b.x) * 6 * dt; b.vz += (tz - b.z) * 6 * dt
      // pointer push (a finger dragging through water shoves what it touches)
      if (pointer.active) {
        const dx = b.x - pointer.x, dz = b.z - pointer.z, d = Math.hypot(dx, dz)
        if (d < 1.5 && d > 1e-4) {
          const sp = Math.min(Math.hypot(pointer.vx, pointer.vz), 30)
          const f = (1 - d / 1.5) * (2 + sp * 0.6)
          b.vx += (dx / d) * f * dt; b.vz += (dz / d) * f * dt
          b.spinV += (pointer.vx * dz - pointer.vz * dx) * 0.02 * (1 - d / 1.5)
        }
      }
    }
    // pairwise overlap correction + elastic impulse
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
      const a = B[i], b = B[j]
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = a.r + b.r
      if (d < min && d > 1e-5) {
        const nx = dx / d, nz = dz / d, o = (min - d) * 0.5
        a.x -= nx * o; a.z -= nz * o; b.x += nx * o; b.z += nz * o
        const rv = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz
        if (rv < 0) { const jimp = -(1 + 0.6) * rv * 0.5; a.vx -= jimp * nx; a.vz -= jimp * nz; b.vx += jimp * nx; b.vz += jimp * nz }
      }
    }
    for (const b of B) {
      b.vx *= k; b.vz *= k
      b.x += b.vx * dt; b.z += b.vz * dt
      b.spinV *= decay(0.95, dt); b.spin += b.spinV * dt; b.spin *= decay(0.985, dt)
      const bob = b.bob.update(dt)
      const h = this.height(b.x, b.z, time)
      const e = 0.35
      const gx = (this.height(b.x + e, b.z, time) - this.height(b.x - e, b.z, time)) / (2 * e)
      const gz = (this.height(b.x, b.z + e, time) - this.height(b.x, b.z - e, time)) / (2 * e)
      b.y.update(h + bob.y * 0.05 + b.lift, dt)
      b.tiltX.update(gz * 0.9 + bob.x * 0.04, dt)
      b.tiltZ.update(-gx * 0.9 + bob.z * 0.04, dt)
    }
  }
}
