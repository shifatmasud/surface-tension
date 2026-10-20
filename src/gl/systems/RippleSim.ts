import * as THREE from 'three'
import { fboHelper, FS_VERT } from '../core/fbo'
import { props, shared } from '../../state/props'
import { settings, browser } from '../../services/settings'
import { waterInput } from '../water/waterInput'

/**
 * Heightfield wave sim on the GPU (ping-pong half-float). R = height, G = velocity.
 * The pointer (projected onto the pool) paints a capsule impulse each tick; clicks and the intro add drops.
 * The lake samples this texture for its normals, its refraction offsets and the caustic rings on the bed.
 *
 * WATER LANE (Shifat 16:21Z "touch drag mouse move ripples trails"):
 *  - 512² on desktop, 256² on phones, with the SAME world wave speed and pointer footprint on both (the coupling
 *    constant scales with the cell size: c ∝ √k·dx, so k₂₅₆ = k₅₁₂ / 4) — a ring looks and travels the same everywhere
 *  - fixed 60 Hz ticks (frame-rate independent; at most 3 catch-up ticks a frame) instead of one step per frame
 *  - sleeps while the lake is not drawn (waterInput.visible), and wakes clean after a long sleep
 *  - touch drags paint even while they scroll the page (waterInput: passive touch listeners), with a ring where the
 *    finger lands; a fast stroke leaves a wake (the capsule is swept along the path every tick)
 *  - idles: 8 s after the last stroke/drop the field is cleared once and ticks stop until the next input
 *  - reduced motion: strokes and drops at a third of their strength (a guard: today pickTier() renders no GL at all
 *    under reduced motion, so this only matters if that changes)
 */
const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D u_prev;
uniform vec2 u_texel;
uniform vec4 u_from, u_to;         // xy uv, z radius uv, w strength
uniform vec4 u_drops[4];           // xy uv, z radius, w strength
uniform float u_damping, u_k, u_hdecay;
varying vec2 v_uv;
vec2 capsule(vec2 p, vec2 a, vec2 b){ vec2 ap = p - a, ab = b - a; float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0); return vec2(length(ap - ab * t), t); }
void main(){
  vec4 c = texture2D(u_prev, v_uv);
  float h = c.r, v = c.g;
  float n = texture2D(u_prev, v_uv + vec2(0.0, u_texel.y)).r;
  float s = texture2D(u_prev, v_uv - vec2(0.0, u_texel.y)).r;
  float e = texture2D(u_prev, v_uv + vec2(u_texel.x, 0.0)).r;
  float w = texture2D(u_prev, v_uv - vec2(u_texel.x, 0.0)).r;
  float avg = (n + s + e + w) * 0.25;
  v += (avg - h) * u_k;
  v *= u_damping;
  h += v;
  h *= u_hdecay;
  // pointer stroke: a soft capsule swept from last tick's point to this one (a continuous wake, no beads)
  vec2 cap = capsule(v_uv, u_from.xy, u_to.xy);
  float r = mix(u_from.z, u_to.z, cap.y);
  if (r > 0.0) { float k = 1.0 - smoothstep(0.0, r, cap.x); h -= k * k * (3.0 - 2.0 * k) * mix(u_from.w, u_to.w, cap.y); }
  for (int i = 0; i < 4; i++) {
    vec4 d = u_drops[i];
    if (d.w != 0.0) { float dd = length(v_uv - d.xy) / d.z; h -= d.w * exp(-dd * dd * 3.0); }
  }
  // soft walls: calm down near the pool edge
  vec2 edge = smoothstep(0.0, 0.04, v_uv) * smoothstep(0.0, 0.04, 1.0 - v_uv);
  h *= mix(0.9, 1.0, edge.x * edge.y);
  gl_FragColor = vec4(h, v, 0.0, 1.0);
}`

const TICK = 1 / 60
const IDLE = 480   // 8 s of 60 Hz ticks
const RM = browser.reducedMotion

export class RippleSim {
  private a: THREE.WebGLRenderTarget
  private b: THREE.WebGLRenderTarget
  mat: THREE.ShaderMaterial
  private last = new THREE.Vector2(-1, -1)
  private lastR = 0
  private wasActive = false
  private acc = 0
  private sleptAt = -1
  private cur = new THREE.Vector2()
  private from = new THREE.Vector2()
  private p = new THREE.Vector2()
  /** ticks since the last stroke or drop; past IDLE the sim is cleared once and stops */
  idle = 0
  readonly size: number
  /** QA counters (window.__ripple): ticks run, last stroke strength */
  ticks = 0
  lastS = 0
  constructor() {
    // phones (low tier) 256², everything else 512²
    this.size = settings.TIER === 'low' ? 256 : 512
    this.a = fboHelper.createRenderTarget(this.size, this.size, { float: true })
    this.b = fboHelper.createRenderTarget(this.size, this.size, { float: true })
    const k = this.size >= 512 ? 1.0 : 0.25     // equal world wave speed (see header); ≈1.3 m/s, a calm-water ring
    this.mat = fboHelper.track(new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: FRAG,
      uniforms: {
        u_prev: { value: null }, u_texel: { value: new THREE.Vector2(1 / this.size, 1 / this.size) },
        u_from: { value: new THREE.Vector4() }, u_to: { value: new THREE.Vector4() },
        u_drops: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
        u_damping: { value: 0.988 }, u_k: { value: k }, u_hdecay: { value: 0.998 },
      },
      depthTest: false, depthWrite: false,
    }))
    shared.u_rippleTexel.value.set(1 / this.size, 1 / this.size)
    if (/[?&]qa\b/.test(location.search)) (window as any).__ripple = this   // QA only
  }
  clear() { fboHelper.clearColor(0, 0, 0, 1, this.a); fboHelper.clearColor(0, 0, 0, 1, this.b); shared.u_rippleTexture.value = this.a.texture }
  /** one 60 Hz step; `stroke` = paint the pointer this tick */
  private tick(p: THREE.Vector2 | null, speed: number, drops: { x: number; y: number; r: number; s: number }[]) {
    const u = this.mat.uniforms
    const t = this.a; this.a = this.b; this.b = t
    u.u_prev.value = this.b.texture
    const gain = RM ? 0.35 : 1
    let r = 0, s = 0
    if (p && this.last.x >= 0) {
      // radius and depth of the stroke from the pointer's speed (uv/s): a slow drag is a fine line, a flick a wake
      // (the pool is 22 m, so a brisk hand is only ~0.1–0.5 uv/s: the old 0.0016 gain left trails invisible)
      const moving = speed > 0.004 ? 1 : 0
      r = THREE.MathUtils.clamp(0.006 + speed * 0.012, 0.006, 0.022)
      s = THREE.MathUtils.clamp(0.006 + speed * 0.08, 0, 0.03) * gain * moving   // slope ≈ s·amp/cell: 0.006 → a visible 2–3° crest
    }
    if (p) {
      u.u_from.value.set(this.last.x < 0 ? p.x : this.last.x, this.last.x < 0 ? p.y : this.last.y, this.lastR, s)
      u.u_to.value.set(p.x, p.y, r, s)
      this.last.copy(p); this.lastR = r
    } else {
      u.u_from.value.set(0, 0, 0, 0); u.u_to.value.set(0, 0, 0, 0)
      this.last.set(-1, -1); this.lastR = 0
    }
    for (let i = 0; i < 4; i++) {
      const d = drops[i]
      u.u_drops.value[i].set(d ? d.x : 0, d ? d.y : 0, d ? d.r : 1, d ? d.s * gain : 0)
    }
    fboHelper.render(this.mat, this.a)
    this.ticks++; if (s > 0) this.lastS = s
  }
  update(dt: number) {
    // asleep while the lake is not on screen; drops queued meanwhile are for a surface nobody sees
    if (!waterInput.visible()) {
      if (this.sleptAt < 0) this.sleptAt = props.frame
      props.drops.length = 0; waterInput.qa.length = 0; this.acc = 0; this.wasActive = false; this.last.set(-1, -1)
      return
    }
    if (this.sleptAt >= 0) { if (props.frame - this.sleptAt > 90) this.clear(); this.sleptAt = -1 }
    // fixed 60 Hz ticks; QA hook __rippleSteps multiplies them on very slow remote GPUs
    const mult = (window as any).__rippleSteps ?? 1
    this.acc = Math.min(this.acc + Math.min(dt, 0.1), TICK * 3)
    let n = Math.floor(this.acc / TICK + 1e-4); this.acc -= n * TICK
    n *= mult
    // a QA stroke runs one tick per point, all of it this frame
    if (waterInput.qa.length) {
      this.idle = 0
      const q = waterInput.qa
      for (let i = 0; i < q.length; i++) {
        const sp = i > 0 ? q[i].distanceTo(q[i - 1]) / TICK : 0
        this.tick(q[i], Math.min(sp, 3), i === 0 ? [{ x: q[0].x, y: q[0].y, r: 0.012, s: 0.05 }] : [])
      }
      q.length = 0
      this.last.set(-1, -1)
    }
    // QA: let the rings spread a set number of ticks inside this same frame (the remote rig renders < 1 fps)
    if (waterInput.qaSettle > 0) { for (let i = 0; i < waterInput.qaSettle; i++) this.tick(null, 0, []); waterInput.qaSettle = 0 }
    // pointer source: a finger on the glass (even mid-scroll), else the mouse path (pool.ts)
    let active = false
    if (waterInput.active) { this.cur.copy(waterInput.uv); active = true }
    else if (props.waterPointerActive) { this.cur.copy(props.waterPointer); active = true }
    const speed = active && this.last.x >= 0 ? this.cur.distanceTo(this.last) / Math.max(dt, TICK) : 0
    // a finger landing on the water starts a ring
    if (active && !this.wasActive && waterInput.active) props.drops.push({ x: this.cur.x, y: this.cur.y, r: 0.012, s: 0.05 })
    this.wasActive = active
    // idle: nothing painted for IDLE ticks → clear once (the wake has died by then) and stop ticking until input
    const busy = active || props.drops.length > 0
    if (busy) this.idle = 0
    else if (this.idle >= IDLE) { this.last.set(-1, -1); return }
    // spread this frame's pointer travel over its ticks so the wake stays continuous at any frame rate
    this.from.copy(this.last.x >= 0 ? this.last : this.cur)
    for (let i = 0; i < n; i++) {
      const drops = props.drops.splice(0, 4)
      if (drops.length) this.idle = 0
      const p = active ? this.p.copy(this.from).lerp(this.cur, (i + 1) / n) : null
      this.tick(p, speed, drops)
      if (!active && ++this.idle >= IDLE) { this.clear(); break }
    }
    if (n > 0 || shared.u_rippleTexture.value !== this.a.texture) shared.u_rippleTexture.value = this.a.texture
  }
}
