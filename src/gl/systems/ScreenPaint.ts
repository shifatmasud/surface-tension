import * as THREE from 'three'
import { fboHelper, FS_VERT } from '../core/fbo'
import { input } from '../../services/input'
import { props, shared } from '../../state/props'
import { browser, settings } from '../../services/settings'
import { trailField, type TrailImpulseKind } from './ScreenPaintField'
import { trailSound } from './ScreenPaintSound'
import { pool } from './pool'

/**
 * ScreenPaint — the cursor trail as a real (small) fluid. Written fresh for this codebase.
 *
 * A stable-fluids solver on a coarse grid of square texels (velocity, curl, divergence, pressure) carries an
 * ink field at a finer resolution. The pointer is a capsule brush swept from last frame's point to this
 * frame's: its radius, force and ink all come from pointer SPEED (CSS px / s, smoothed), so a slow drift draws
 * a thin silver thread and a fast flick throws a wide splash. Vorticity confinement keeps the wake curling,
 * and everything settles on its own (per-second dissipation, so 60 Hz and 120 Hz look the same).
 * Clicks / taps fire a radial burst (outward velocity ring + ink ring), and a flick that stops hard blooms.
 *
 * Outputs
 *   trailField.uniforms.u_trailDye / u_trailVelocity    half-float fields (see ScreenPaintField.ts)
 *   shared.u_currPaintTexture                           RGBA8 pack kept for the type shader: xy velocity
 *                                                       biased at 0.5, z ink, w head — the old contract
 * The post pass (ScreenPaintDistortion) turns the ink into a lens over the finished frame.
 *
 * Cost (per sim step, all tiny targets): advect ×2, curl, vorticity, divergence, pressure fade, Jacobi ×N,
 * gradient, pack. High tier: 112-texel-tall grid, N = 18, ink at 1/3 render. Phone tier: 64-tall grid,
 * N = 12, ink at 1/4 render. Steps are capped at 50 Hz substeps (≤ 3 per frame).
 * ?notrail turns it off; prefers-reduced-motion turns it off.
 */

const PRE = /* glsl */ `
precision highp float;
varying vec2 v_uv;
`

// semi-Lagrangian advection + the brush, one pass per field
const ADVECT_FRAG = /* glsl */ `${PRE}
uniform sampler2D u_velocity;
uniform sampler2D u_source;
uniform vec2 u_simTexel;      // velocity is stored in sim texels / s
uniform float u_dt;
uniform vec4 u_dissipation;   // per-channel per-second decay rates
uniform vec2 u_scroll;        // page moved this frame (uv): the fluid rides with the content
uniform float u_aspect;
uniform vec4 u_segA;          // brush capsule: xy = point (aspect space), z = radius (viewport heights), w = amount
uniform vec4 u_segB;
uniform vec2 u_force;         // brush velocity in sim texels / s
uniform vec4 u_burst[4];      // xy point (aspect space), z radius, w strength (0 = none)
uniform vec4 u_burstDir[4];   // xy forward kick for flicks
uniform float u_hue;          // speed colour 0..1 injected with the ink
uniform float u_mode;         // 0 = velocity field, 1 = ink field
uniform float u_headGain;

vec2 capsule(vec2 p, vec2 a, vec2 b){
  vec2 ap = p - a, ab = b - a;
  float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
  return vec2(length(ap - ab * t), t);
}

void main(){
  vec2 vel = texture2D(u_velocity, v_uv - u_scroll).xy;
  vec2 coord = v_uv - u_scroll - u_dt * vel * u_simTexel;
  // nothing flows in from beyond the screen edge (clamp-to-edge would smear the border texel inward)
  vec2 inside = step(vec2(0.0), coord) * step(coord, vec2(1.0));
  vec4 src = texture2D(u_source, coord) * inside.x * inside.y;
  vec4 decay = exp(-u_dissipation * u_dt);
  vec4 o = src * decay;

  vec2 p = vec2(v_uv.x * u_aspect, v_uv.y);
  vec2 cap = capsule(p, u_segA.xy, u_segB.xy);
  float r = mix(u_segA.z, u_segB.z, cap.y);
  float amt = mix(u_segA.w, u_segB.w, cap.y);
  float fall = r > 0.0 ? exp(-(cap.x * cap.x) / (r * r)) : 0.0;     // soft gaussian brush: no hard rim

  if (u_mode < 0.5) {
    // velocity: pull toward the brush velocity inside a WIDER soft brush (bounded, rate independent). A wide,
    // smooth shear profile rolls up into a few large elegant curls instead of a chain of grid-sized eddies.
    float rv = max(r * 2.2, u_simTexel.y * 4.0);
    float fallV = r > 0.0 ? exp(-(cap.x * cap.x) / (rv * rv)) : 0.0;
    o.xy = mix(o.xy, u_force, clamp(fallV * 0.6, 0.0, 1.0));
    for (int i = 0; i < 4; i++) {
      vec4 b = u_burst[i];
      if (b.w <= 0.0) continue;
      vec2 d = p - b.xy; float l = length(d); float q = l / b.z;
      // an outward ring impulse (zero at the centre so it opens a hole and throws a rim) + a forward kick
      o.xy += (d / max(l, 1e-5)) * b.w * q * exp(-q * q) * (1.5 / u_simTexel.y);   // peak ≈ 0.65 viewport heights / s
      o.xy += u_burstDir[i].xy * b.w * exp(-q * q * 1.5);
    }
  } else {
    // ink: R density (saturating add), G bright head, B speed-colour carried with the ink, A burst ring
    float ink = amt * fall;
    o.r = o.r + ink * max(0.0, 1.0 - o.r);
    o.g = max(o.g, ink * u_headGain);
    o.b = o.b + ink * max(0.0, 1.0 - o.r * 0.5) * u_hue;
    for (int i = 0; i < 4; i++) {
      vec4 b = u_burst[i];
      if (b.w <= 0.0) continue;
      float q = length(p - b.xy) / b.z;
      float ring = exp(-pow((q - 0.75) * 3.2, 2.0)) * b.w;   // a ring of ink that the outward flow carries open
      float core = exp(-q * q * 4.0) * b.w * 0.35;
      o.r = o.r + (ring + core) * max(0.0, 1.0 - o.r);
      o.g = max(o.g, ring * 0.9);
      o.b = o.b + ring * 0.8;
      o.a = max(o.a, ring);
    }
    // thin leftovers clear out instead of lingering as a faint film (constant floor on top of the decay)
    float floorK = u_dt * 0.06;
    o.r = max(0.0, o.r - floorK);
    o.b = min(o.b, o.r * 1.2);
    o.a = max(0.0, o.a - floorK);
  }
  gl_FragColor = o;
}`

const CURL_FRAG = /* glsl */ `${PRE}
uniform sampler2D u_velocity; uniform vec2 u_texel;
void main(){
  float L = texture2D(u_velocity, v_uv - vec2(u_texel.x, 0.0)).y;
  float R = texture2D(u_velocity, v_uv + vec2(u_texel.x, 0.0)).y;
  float T = texture2D(u_velocity, v_uv + vec2(0.0, u_texel.y)).x;
  float B = texture2D(u_velocity, v_uv - vec2(0.0, u_texel.y)).x;
  gl_FragColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
}`

const VORTICITY_FRAG = /* glsl */ `${PRE}
uniform sampler2D u_velocity; uniform sampler2D u_curl; uniform vec2 u_texel; uniform float u_strength; uniform float u_dt;
void main(){
  float L = texture2D(u_curl, v_uv - vec2(u_texel.x, 0.0)).x;
  float R = texture2D(u_curl, v_uv + vec2(u_texel.x, 0.0)).x;
  float T = texture2D(u_curl, v_uv + vec2(0.0, u_texel.y)).x;
  float B = texture2D(u_curl, v_uv - vec2(0.0, u_texel.y)).x;
  float C = texture2D(u_curl, v_uv).x;
  vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  f /= length(f) + 1e-4;
  f *= u_strength * C;
  f.y = -f.y;
  vec2 v = texture2D(u_velocity, v_uv).xy + f * u_dt;
  gl_FragColor = vec4(clamp(v, -4000.0, 4000.0), 0.0, 1.0);
}`

const DIVERGENCE_FRAG = /* glsl */ `${PRE}
uniform sampler2D u_velocity; uniform vec2 u_texel;
void main(){
  vec2 C = texture2D(u_velocity, v_uv).xy;
  float L = texture2D(u_velocity, v_uv - vec2(u_texel.x, 0.0)).x;
  float R = texture2D(u_velocity, v_uv + vec2(u_texel.x, 0.0)).x;
  float T = texture2D(u_velocity, v_uv + vec2(0.0, u_texel.y)).y;
  float B = texture2D(u_velocity, v_uv - vec2(0.0, u_texel.y)).y;
  // walls at the screen edge: mirror the normal component
  if (v_uv.x - u_texel.x < 0.0) L = -C.x;
  if (v_uv.x + u_texel.x > 1.0) R = -C.x;
  if (v_uv.y + u_texel.y > 1.0) T = -C.y;
  if (v_uv.y - u_texel.y < 0.0) B = -C.y;
  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`

const SCALE_FRAG = /* glsl */ `${PRE}
uniform sampler2D u_source; uniform float u_k;
void main(){ gl_FragColor = vec4(texture2D(u_source, v_uv).x * u_k, 0.0, 0.0, 1.0); }`

const PRESSURE_FRAG = /* glsl */ `${PRE}
uniform sampler2D u_pressure; uniform sampler2D u_divergence; uniform vec2 u_texel;
void main(){
  float L = texture2D(u_pressure, v_uv - vec2(u_texel.x, 0.0)).x;
  float R = texture2D(u_pressure, v_uv + vec2(u_texel.x, 0.0)).x;
  float T = texture2D(u_pressure, v_uv + vec2(0.0, u_texel.y)).x;
  float B = texture2D(u_pressure, v_uv - vec2(0.0, u_texel.y)).x;
  float div = texture2D(u_divergence, v_uv).x;
  gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`

const GRADIENT_FRAG = /* glsl */ `${PRE}
uniform sampler2D u_pressure; uniform sampler2D u_velocity; uniform vec2 u_texel;
void main(){
  float L = texture2D(u_pressure, v_uv - vec2(u_texel.x, 0.0)).x;
  float R = texture2D(u_pressure, v_uv + vec2(u_texel.x, 0.0)).x;
  float T = texture2D(u_pressure, v_uv + vec2(0.0, u_texel.y)).x;
  float B = texture2D(u_pressure, v_uv - vec2(0.0, u_texel.y)).x;
  vec2 v = texture2D(u_velocity, v_uv).xy - vec2(R - L, T - B);
  gl_FragColor = vec4(v, 0.0, 1.0);
}`

// the old 8-bit contract for the type shader (ufx): xy velocity biased at 0.5, z ink, w head
const PACK_FRAG = /* glsl */ `${PRE}
uniform sampler2D u_velocity; uniform sampler2D u_dye; uniform vec2 u_simTexel;
void main(){
  vec2 v = texture2D(u_velocity, v_uv).xy * u_simTexel;   // uv / s
  vec4 d = texture2D(u_dye, v_uv);
  gl_FragColor = vec4(clamp(0.5 + v * 0.12, 0.0, 1.0), clamp(d.r, 0.0, 1.0), clamp(d.g, 0.0, 1.0));
}`

type DoubleRT = { read: THREE.WebGLRenderTarget; write: THREE.WebGLRenderTarget; swap: () => void }
function double(): DoubleRT {
  const o = {
    read: fboHelper.createRenderTarget(1, 1, { float: true }),
    write: fboHelper.createRenderTarget(1, 1, { float: true }),
    swap() { const t = o.read; o.read = o.write; o.write = t },
  }
  return o
}
const mat = (frag: string, uniforms: Record<string, THREE.IUniform>) => fboHelper.track(new THREE.ShaderMaterial({
  vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
}))

const ZERO4 = new THREE.Vector4()
const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

export class ScreenPaint {
  // fields
  private velocity = double()
  private dye = double()
  private pressure = double()
  private curl = fboHelper.createRenderTarget(1, 1, { float: true })
  private divergence = fboHelper.createRenderTarget(1, 1, { float: true })
  private pack = fboHelper.createRenderTarget(1, 1)
  private simTexel = new THREE.Vector2(1, 1)
  private dyeTexel = new THREE.Vector2(1, 1)
  private aspect = 1

  // passes
  private advect: THREE.ShaderMaterial
  private curlMat: THREE.ShaderMaterial
  private vortMat: THREE.ShaderMaterial
  private divMat: THREE.ShaderMaterial
  private scaleMat: THREE.ShaderMaterial
  private presMat: THREE.ShaderMaterial
  private gradMat: THREE.ShaderMaterial
  private packMat: THREE.ShaderMaterial

  // live tuning (window.__trail)
  /** brush radius (viewport heights) at a slow drift and at a full flick */
  radiusSlow = 0.0045
  radiusFast = 0.045
  /** CSS px / s that count as slow / fast */
  speedSlow = 90
  speedFast = 2600
  /** ink laid at a slow drift / fast flick */
  inkSlow = 0.42
  inkFast = 1.0
  /** brush velocity gain (pointer speed → fluid speed) */
  force = 0.4
  curlStrength = settings.TIER === 'low' ? 14 : 16
  pressureIterations = settings.TIER === 'low' ? 12 : settings.TIER === 'mid' ? 14 : 18
  /** per-second decay rates */
  velocityDecay = 1.25
  inkDecay = 1.05
  headDecay = 5.5
  hueDecay = 1.05
  ringDecay = 2.2
  /** scrolling adds only a little ink (the page moving under a still cursor) */
  scrollInk = 0.35
  drawEnabled = !browser.reducedMotion && !/[?&]notrail/.test(location.search)
  needsMouseDown = false

  // pointer state
  private segA = new THREE.Vector4()
  private segB = new THREE.Vector4()
  private force2 = new THREE.Vector2()
  private speed = 0
  private peak = 0
  private peakAge = 0
  private lastDir = new THREE.Vector2(1, 0)
  private started = false
  private bursts: { x: number; y: number; r: number; s: number; dx: number; dy: number }[] = []
  private pendingDown: { x: number; y: number }[] = []
  private hue = 0
  private activity = 0

  constructor() {
    const T = () => new THREE.Vector2(1, 1)
    this.advect = mat(ADVECT_FRAG, {
      u_velocity: { value: null }, u_source: { value: null }, u_simTexel: { value: this.simTexel }, u_dt: { value: 1 / 60 },
      u_dissipation: { value: new THREE.Vector4() }, u_scroll: { value: new THREE.Vector2() }, u_aspect: { value: 1 },
      u_segA: { value: this.segA }, u_segB: { value: this.segB }, u_force: { value: this.force2 },
      u_burst: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, u_burstDir: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
      u_hue: { value: 0 }, u_mode: { value: 0 }, u_headGain: { value: 1 },
    })
    this.curlMat = mat(CURL_FRAG, { u_velocity: { value: null }, u_texel: { value: T() } })
    this.vortMat = mat(VORTICITY_FRAG, { u_velocity: { value: null }, u_curl: { value: null }, u_texel: { value: T() }, u_strength: { value: 0 }, u_dt: { value: 0 } })
    this.divMat = mat(DIVERGENCE_FRAG, { u_velocity: { value: null }, u_texel: { value: T() } })
    this.scaleMat = mat(SCALE_FRAG, { u_source: { value: null }, u_k: { value: 0.8 } })
    this.presMat = mat(PRESSURE_FRAG, { u_pressure: { value: null }, u_divergence: { value: null }, u_texel: { value: T() } })
    this.gradMat = mat(GRADIENT_FRAG, { u_pressure: { value: null }, u_velocity: { value: null }, u_texel: { value: T() } })
    this.packMat = mat(PACK_FRAG, { u_velocity: { value: null }, u_dye: { value: null }, u_simTexel: { value: this.simTexel } })
    shared.u_currPaintTexture.value = this.pack.texture
    input.onDown.push((e) => { this.pendingDown.push({ x: e.clientX, y: e.clientY }) })
    ;(window as any).__trail = this
  }

  resize(w: number, h: number) {
    // square sim texels (so the pressure solve is isotropic); ink a few times finer
    const aspect = Math.max(0.2, w / Math.max(1, h))
    this.aspect = aspect
    const simH = settings.TIER === 'low' ? 64 : settings.TIER === 'mid' ? 96 : 112
    const sh = Math.min(simH, Math.max(16, h >> 2)), sw = Math.max(16, Math.round(sh * aspect))
    const div = settings.TIER === 'high' ? 3 : 4
    const maxDye = settings.TIER === 'low' ? 320 : 760
    let dh = Math.max(32, Math.round(h / div)), dw = Math.max(32, Math.round(dh * aspect))
    const k = Math.min(1, maxDye / Math.max(dw, dh)); dw = Math.round(dw * k); dh = Math.round(dh * k)
    for (const t of [this.velocity.read, this.velocity.write, this.pressure.read, this.pressure.write, this.curl, this.divergence]) t.setSize(sw, sh)
    for (const t of [this.dye.read, this.dye.write, this.pack]) t.setSize(dw, dh)
    this.simTexel.set(1 / sw, 1 / sh)
    this.dyeTexel.set(1 / dw, 1 / dh)
    for (const m of [this.curlMat, this.vortMat, this.divMat, this.presMat, this.gradMat]) m.uniforms.u_texel.value.set(1 / sw, 1 / sh)
    trailField.uniforms.u_trailSimTexel.value.copy(this.simTexel)
    trailField.uniforms.u_trailDyeTexel.value.copy(this.dyeTexel)
    shared.u_paintTextureSize.value.set(dw, dh)
    this.clear()
  }

  clear() {
    for (const t of [this.velocity.read, this.velocity.write, this.dye.read, this.dye.write, this.pressure.read, this.pressure.write, this.curl, this.divergence])
      fboHelper.clearColor(0, 0, 0, 0, t)
    fboHelper.clearColor(0.5, 0.5, 0, 0, this.pack)
    this.publish()
  }

  private publish() {
    trailField.uniforms.u_trailDye.value = this.dye.read.texture
    trailField.uniforms.u_trailVelocity.value = this.velocity.read.texture
    shared.u_currPaintTexture.value = this.pack.texture
  }

  private emit(kind: TrailImpulseKind, x: number, y: number, vx: number, vy: number, radius: number, strength: number) {
    trailField.emit({ kind, x, y, vx, vy, speed: this.speed, radius, strength, stage: props.stage })
  }

  /** a radial splash at CSS px (x, y), strength 0..1; dir = forward kick in viewport heights / s */
  burst(px: number, py: number, strength = 1, dirX = 0, dirY = 0) {
    if (!this.drawEnabled || this.bursts.length >= 4) return
    const H = Math.max(1, props.height)
    const x = (px / H), y = 1 - py / H
    const r = (props.useMobileLayout ? 0.058 : 0.06) * (0.6 + 0.6 * strength)
    this.bursts.push({ x, y, r, s: strength, dx: dirX, dy: dirY })
  }

  /**
   * QA / demo drive: window.__trailDrive = { path: [[x, y], …] (CSS px), speed: px/s, steps?: sim steps per frame,
   * clicks?: [index, …], hold?: s of settling after the path } plays a scripted stroke in SIM time (so a slow remote browser shows the true look).
   */
  private drive: { path: number[][]; speed: number; steps: number; clicks: number[]; t: number; len: number[]; total: number; hold: number; done: boolean } | null = null
  private dCur = new THREE.Vector2()
  private dPrev = new THREE.Vector2()
  private pollDrive() {
    const w = (window as any).__trailDrive
    if (!w) return
    ;(window as any).__trailDrive = null
    const len = [0]
    for (let i = 1; i < w.path.length; i++) len.push(len[i - 1] + Math.hypot(w.path[i][0] - w.path[i - 1][0], w.path[i][1] - w.path[i - 1][1]))
    if (w.clear) { this.clear(); this.speed = 0; this.peak = 0 }
    this.drive = { path: w.path, speed: w.speed || 1200, steps: w.steps || 6, clicks: w.clicks || [], t: 0, len, total: len[len.length - 1], hold: w.hold ?? 0, done: false }
    this.dCur.set(w.path[0][0], w.path[0][1]); this.dPrev.copy(this.dCur)
    this.segB.set(this.dCur.x / Math.max(1, props.height), 1 - this.dCur.y / Math.max(1, props.height), 0, 0); this.started = true
  }
  private drivePoint(d: number, out: THREE.Vector2) {
    const D = this.drive!
    let i = 1
    while (i < D.len.length - 1 && D.len[i] < d) i++
    const a = D.path[i - 1], b = D.path[i], seg = Math.max(1e-6, D.len[i] - D.len[i - 1])
    const t = Math.min(1, Math.max(0, (d - D.len[i - 1]) / seg))
    out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    return i
  }

  private frozen = false
  update(rawDt: number) {
    this.pollDrive()
    if (this.frozen && !this.drive) { if (!(window as any).__trailFreeze) this.frozen = false; else return }
    if (this.drive) {
      const D = this.drive, h = 1 / 60
      for (let s = 0; s < D.steps; s++) {
        const before = D.t * D.speed
        D.t += h
        const dist = Math.min(D.total, D.t * D.speed)
        this.dPrev.copy(this.dCur)
        const iBefore = this.drivePoint(before, new THREE.Vector2())
        const i = this.drivePoint(dist, this.dCur)
        for (let ci = D.clicks.length - 1; ci >= 0; ci--) {
          const c = D.clicks[ci]
          if (dist >= D.len[c] - 1e-6) { this.pendingDown.push({ x: D.path[c][0], y: D.path[c][1] }); D.clicks.splice(ci, 1) }
        }
        void before; void iBefore; void i
        const moving = dist < D.total
        this.frame(h, this.dCur, this.dPrev, moving, false, 0)
        if (!moving && D.t * D.speed >= D.total + D.hold * D.speed) { D.done = true; break }
      }
      if (D.done) { this.drive = null; (window as any).__trailDriveDone = true; if ((window as any).__trailFreeze) this.frozen = true }
      return
    }
    const touchRule = (this.needsMouseDown || browser.isMobile || input.isTouch) && (!input.isDown || !input.wasDown)
    // a jump (anchor link, programmatic scroll, resize) is a teleport, not a stroke: start clean
    if (Math.abs(props.scrollDelta) > props.height * 0.35) {
      this.clear(); this.speed = 0; this.peak = 0
      this.segB.set(input.mousePixelXY.x / Math.max(1, props.height), 1 - input.mousePixelXY.y / Math.max(1, props.height), 0, 0)
      this.frame(rawDt, input.mousePixelXY, input.mousePixelXY, false, true, 0)
      return
    }
    this.frame(rawDt, input.mousePixelXY, input.prevMousePixelXY, input.hadMoved, touchRule, props.scrollDelta)
  }

  private frame(rawDt: number, cur: THREE.Vector2, prev: THREE.Vector2, hadMoved: boolean, touchRule: boolean, scrollDelta: number) {
    const dt = Math.min(Math.max(rawDt, 1 / 240), 1 / 15)
    const W = Math.max(1, props.width), H = Math.max(1, props.height)
    const ratio = props.look.paintOffsetRatio
    const scrollUv = scrollDelta / H * ratio

    // —— the pointer: speed-driven capsule brush ————————————————————————————————————————
    const can = this.drawEnabled && (input.everMoved || !!this.drive) && !props.overlayOpen
    // relative motion of pointer vs content: a still cursor over a scrolling page still stirs (a little)
    const dxp = cur.x - prev.x, dyp = (cur.y - prev.y) + scrollDelta * ratio * this.scrollInk
    const inst = Math.hypot(dxp, dyp) / dt                                     // CSS px / s this frame
    const k = 1 - Math.exp(-dt * (inst > this.speed ? 30 : 9))                 // rise fast, fall gently
    this.speed += (inst - this.speed) * k
    if (!hadMoved && Math.abs(scrollDelta) < 0.01) this.speed *= Math.exp(-dt * 10)
    const sN = smoothstep(this.speedSlow, this.speedFast, this.speed)
    const moving = (hadMoved || Math.abs(scrollDelta) > 0.01) && !touchRule
    let radius = moving && can ? this.radiusSlow + (this.radiusFast - this.radiusSlow) * Math.pow(sN, 1.25) : 0
    if (props.useMobileLayout) radius *= 0.95          // small screen: keep the thread fine
    const ink = this.inkSlow + (this.inkFast - this.inkSlow) * sN

    // brush segment in aspect space (x in viewport heights)
    const bx = cur.x / H, by = 1 - cur.y / H
    if (!this.started && (input.everMoved || this.drive)) { this.segB.set(bx, by, 0, 0); this.started = true }
    this.segA.copy(this.segB); this.segA.y += scrollUv     // last point rides with the page
    if (!input.wasDown && input.isDown && input.isTouch) this.segA.set(bx, by, 0, 0)   // a new finger never draws a line from the old one
    this.segB.set(bx, by, radius, radius > 0 ? ink : 0)

    // brush velocity: pointer velocity (viewport heights / s) → sim texels / s
    if (inst > 1) this.lastDir.set(dxp, -dyp).normalize()
    const vH = this.speed / H                                    // viewport heights / s
    const toSim = 1 / this.simTexel.y                            // 1 viewport height = simH texels
    this.force2.set(this.lastDir.x * vH * toSim * this.force, this.lastDir.y * vH * toSim * this.force)

    // flick bloom: a hard stop after a fast throw
    this.peakAge += dt
    if (this.speed > this.peak) { this.peak = this.speed; this.peakAge = 0 }
    this.peak *= Math.exp(-dt * 2.5)
    if (can && !touchRule && this.peak > 1700 && this.speed < this.peak * 0.32 && this.peakAge < 0.3) {
      const st = Math.min(1, (this.peak - 1500) / 2600)
      this.burst(cur.x, cur.y, 0.45 + 0.4 * st, this.lastDir.x * 0.7 * st, this.lastDir.y * 0.7 * st)
      this.emit('flick', bx / this.aspect, by, this.lastDir.x * vH, this.lastDir.y * vH, 0.05, st)
      trailSound.flick(st)
      // the lake answers a flick with a real drop
      if ((props.stage === 'hero' || props.stage === 'contact') && pool.pointer.active && props.waterPointerActive) pool.drop(pool.pointer.x, pool.pointer.z, 0.05 + 0.08 * st, 0.02 + 0.025 * st)
      this.peak = 0
    }
    // click / tap splash (boot.ts already drops into the lake on a press over the water)
    for (const d of this.pendingDown.splice(0)) {
      if (!can && !(this.drawEnabled && !props.overlayOpen)) continue
      this.burst(d.x, d.y, 1)
      this.emit('burst', d.x / W, 1 - d.y / H, 0, 0, 0.06, 1)
      trailSound.splash()
    }
    if (radius > 0) this.emit('stroke', bx / this.aspect, by, this.lastDir.x * vH, this.lastDir.y * vH, radius, sN)

    // speed colour: slow = cool pearl (0), fast = warm vivid (1); eased so a flick tints its own ink
    this.hue += (sN - this.hue) * (1 - Math.exp(-dt * 12))

    // —— the solver ——————————————————————————————————————————————————————————————————————
    const steps = Math.min(3, Math.max(1, Math.ceil(dt / (1 / 50))))
    const h = dt / steps
    for (let i = 0; i < steps; i++) this.step(h, i === 0 ? scrollUv : 0, i === 0)

    // pack for the type shader + publish
    this.packMat.uniforms.u_velocity.value = this.velocity.read.texture
    this.packMat.uniforms.u_dye.value = this.dye.read.texture
    fboHelper.render(this.packMat, this.pack)
    this.publish()

    // cheap activity estimate (no GPU readback): ink laid recently, decaying like the ink
    this.activity = Math.max(this.activity * Math.exp(-dt * this.inkDecay), radius > 0 ? Math.min(1, ink * (0.3 + sN)) : 0, this.bursts.length ? 1 : 0)
    trailField.activity = this.activity
    trailSound.update(dt, this.speed, sN, radius > 0)
    this.bursts.length = 0
  }

  private step(dt: number, scrollUv: number, inject: boolean) {
    const a = this.advect.uniforms
    // brush + bursts only on the first substep (the capsule already spans the whole frame's motion)
    a.u_segA.value = inject ? this.segA : ZERO4
    a.u_segB.value = inject ? this.segB : ZERO4
    for (let i = 0; i < 4; i++) {
      const b = inject ? this.bursts[i] : undefined
      ;(a.u_burst.value[i] as THREE.Vector4).set(b ? b.x : 0, b ? b.y : 0, b ? b.r : 1, b ? b.s : 0)
      ;(a.u_burstDir.value[i] as THREE.Vector4).set(b ? b.dx / this.simTexel.y : 0, b ? b.dy / this.simTexel.y : 0, 0, 0)
    }
    a.u_dt.value = dt
    a.u_aspect.value = this.aspect
    a.u_scroll.value.set(0, scrollUv)
    a.u_hue.value = this.hue

    // 1) vorticity confinement: keeps the wake curling instead of smearing flat
    this.curlMat.uniforms.u_velocity.value = this.velocity.read.texture
    fboHelper.render(this.curlMat, this.curl)
    const v = this.vortMat.uniforms
    v.u_velocity.value = this.velocity.read.texture; v.u_curl.value = this.curl.texture
    v.u_strength.value = this.curlStrength; v.u_dt.value = dt
    fboHelper.render(this.vortMat, this.velocity.write); this.velocity.swap()

    // 2) make it incompressible: divergence → pressure (warm-started) → subtract the gradient
    this.divMat.uniforms.u_velocity.value = this.velocity.read.texture
    fboHelper.render(this.divMat, this.divergence)
    this.scaleMat.uniforms.u_source.value = this.pressure.read.texture
    fboHelper.render(this.scaleMat, this.pressure.write); this.pressure.swap()
    const p = this.presMat.uniforms
    p.u_divergence.value = this.divergence.texture
    for (let i = 0; i < this.pressureIterations; i++) {
      p.u_pressure.value = this.pressure.read.texture
      fboHelper.render(this.presMat, this.pressure.write); this.pressure.swap()
    }
    const g = this.gradMat.uniforms
    g.u_pressure.value = this.pressure.read.texture; g.u_velocity.value = this.velocity.read.texture
    fboHelper.render(this.gradMat, this.velocity.write); this.velocity.swap()

    // 3) advect velocity (+ brush force, bursts), then the ink through it (+ brush ink)
    a.u_mode.value = 0
    a.u_velocity.value = this.velocity.read.texture; a.u_source.value = this.velocity.read.texture
    a.u_dissipation.value.set(this.velocityDecay, this.velocityDecay, 0, 0)
    fboHelper.render(this.advect, this.velocity.write); this.velocity.swap()

    a.u_mode.value = 1
    a.u_velocity.value = this.velocity.read.texture; a.u_source.value = this.dye.read.texture
    a.u_dissipation.value.set(this.inkDecay, this.headDecay, this.hueDecay, this.ringDecay)
    fboHelper.render(this.advect, this.dye.write); this.dye.swap()
  }

  get texture() { return this.pack.texture }
  get lowTexture() { return this.pack.texture }
  get dyeTexture() { return this.dye.read.texture }
  get velocityTexture() { return this.velocity.read.texture }
}
