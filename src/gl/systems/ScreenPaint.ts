import * as THREE from 'three'
import { fboHelper, FS_VERT } from '../core/fbo'
import { input } from '../../services/input'
import { props, shared } from '../../state/props'
import { browser, settings } from '../../services/settings'
import { fit } from '../../core/math'

/**
 * ScreenPaint — the cursor fluid trail (handbook ch.14), implemented to behaviour parity and written
 * fresh for this codebase. The pointer becomes an 8-bit velocity+weight texture that keeps moving and
 * fading by itself:
 *   R,G  velocity x/y biased around 0.5 (rest = 0.5)       fade ×0.975 / frame
 *   B    weight 1 — the long tail                          fade ×0.95  / frame
 *   A    weight 2 — the short bright head                  fade ×0.8   / frame
 * Four RGBA8 targets: prev/curr at 1/4 render size (ping-pong), low/lowBlur at 1/8 (blurred push field).
 * Per frame: swap → paint (reads prev + last frame's blurred low) → copy curr→low → blur(8,1) low in place.
 */

// Gradient noise with an analytic derivative (value, d/dx, d/dy). The lattice hash is the 2-out
// fractional-sine-free hash so the swirl field matches the reference field texel for texel.
const PAINT_NOISE = /* glsl */ `
vec2 pn_hash(vec2 p){
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy) * 2.0 - 1.0;
}
vec3 noised(in vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);        // quintic fade
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);              // its derivative
  vec2 ga = pn_hash(i), gb = pn_hash(i + vec2(1.0, 0.0)), gc = pn_hash(i + vec2(0.0, 1.0)), gd = pn_hash(i + vec2(1.0, 1.0));
  float va = dot(ga, f), vb = dot(gb, f - vec2(1.0, 0.0)), vc = dot(gc, f - vec2(0.0, 1.0)), vd = dot(gd, f - vec2(1.0, 1.0));
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
         + du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va);
  return vec3(v, d);
}`

// The feedback blur: separable 9-tap (weights .1633 / .1531 / .12245 / .0918 / .051), the tap step is
// radius * 0.25 texels, so blur(8) reaches 8 texels each side at 1/8 res. H into the scratch target,
// V back into the source, so the low copy is blurred in place.
const BLUR9_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D u_texture; uniform vec2 u_delta; varying vec2 v_uv;
void main(){
  vec4 c = texture2D(u_texture, v_uv) * 0.1633;
  vec2 d = u_delta;
  c += (texture2D(u_texture, v_uv - d) + texture2D(u_texture, v_uv + d)) * 0.1531;  d += u_delta;
  c += (texture2D(u_texture, v_uv - d) + texture2D(u_texture, v_uv + d)) * 0.12245; d += u_delta;
  c += (texture2D(u_texture, v_uv - d) + texture2D(u_texture, v_uv + d)) * 0.0918;  d += u_delta;
  c += (texture2D(u_texture, v_uv - d) + texture2D(u_texture, v_uv + d)) * 0.051;
  gl_FragColor = c;
}`
const blur9 = new THREE.ShaderMaterial({
  uniforms: { u_texture: { value: null }, u_delta: { value: new THREE.Vector2() } },
  vertexShader: FS_VERT, fragmentShader: BLUR9_FRAG, depthTest: false, depthWrite: false,
})
function blurInPlace(radius: number, src: THREE.WebGLRenderTarget, scratch: THREE.WebGLRenderTarget) {
  const u = blur9.uniforms, k = 0.25
  u.u_texture.value = src.texture; u.u_delta.value.set((radius / src.width) * k, 0)
  fboHelper.render(blur9, scratch)
  u.u_texture.value = scratch.texture; u.u_delta.value.set(0, (radius / src.height) * k)
  fboHelper.render(blur9, src)
}

// Exact clear. WebGLRenderer.setClearColor premultiplies the clear colour by its alpha, so a (0.5, 0.5, 0, 0) clear
// lands as (0, 0, 0, 0): the velocity channels start at -0.5 and decay towards rest only until the 8-bit step stalls them
// at 108/255, which leaves a permanent -0.076 velocity everywhere (a 1.9-texel diagonal push on the whole field, the
// trail slid down-left instead of curling in place, and a constant smear direction in the distortion). The reference
// clears with raw gl.clearColor, so rest is 128/255. A tiny fill pass writes the exact value.
const FILL = new THREE.ShaderMaterial({
  vertexShader: FS_VERT,
  fragmentShader: `precision highp float; varying vec2 v_uv; void main(){ gl_FragColor = vec4(0.5, 0.5, 0.0, 0.0); }`,
  depthTest: false, depthWrite: false, blending: THREE.NoBlending,
})

/** The reference sizes the paint from its own render size: CSS viewport × min(1.5, devicePixelRatio), capped at
 * 2560×1440 px (MAX_PIXEL_COUNT), then >>2 / >>3. Our renderer's DPR is adaptive (tier caps, perf scaling), and the
 * paint's behaviour is resolution-dependent (push and curl are in texels, the brush velocity in paint px), so the paint
 * keeps the reference's own size, independent of the render DPR, and a DPR change never resets it. */
function referenceRenderSize(vw: number, vh: number) {
  // R6.89 (Shifat Oct 23 4:13 AM "Cursor trail dpr should be 1 too"): on phones the trail's own field is sized at 1.0x
  // (was the reference's 1.5x); its shaders, look and motion are untouched. Desktop keeps the reference's 1.5x.
  const dpr = Math.min(settings.TIER === 'low' ? 1 : 1.5, window.devicePixelRatio || 1) || 1
  let w = vw * dpr, h = vh * dpr
  const MAX = 2560 * 1440
  if (w * h > MAX) { const a = w / h; h = Math.sqrt(MAX / a); w = Math.ceil(h * a); h = Math.ceil(h) }
  return [Math.ceil(w), Math.ceil(h)]
}

const PAINT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D u_prevPaintTexture;
uniform sampler2D u_lowPaintTexture;
uniform vec2 u_paintTexelSize;
uniform vec4 u_drawFrom;   // x, y (paint px), radius (paint px), weight
uniform vec4 u_drawTo;
uniform vec2 u_vel;        // smoothed brush velocity (paint px per frame-ish)
uniform float u_pushStrength;
uniform float u_curlScale;
uniform float u_curlStrength;
uniform vec3 u_dissipations; // velocity, weight1, weight2
uniform vec2 u_scrollOffset;
uniform float u_velSnap;   // POLISH: touch snaps the 8-bit velocity residue to rest (0 on desktop = unchanged)
varying vec2 v_uv;
#ifdef USE_NOISE
${PAINT_NOISE}
#endif

// capsule distance: (distance to segment, position along it 0..1)
vec2 capsule(vec2 p, vec2 a, vec2 b){
  vec2 ap = p - a, ab = b - a;
  float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return vec2(length(ap - ab * t), t);
}

void main(){
  vec2 seg = capsule(gl_FragCoord.xy, u_drawFrom.xy, u_drawTo.xy);
  vec2 rw = mix(u_drawFrom.zw, u_drawTo.zw, seg.y);              // radius & weight tapered along the stroke
  float brush = 1.0 - smoothstep(-0.01, rw.x, seg.x);            // radius 0 → nothing painted

  // the push: read the blurred 1/8 copy, flip its velocity → sample upstream (semi-Lagrangian, one step)
  vec4 low = texture2D(u_lowPaintTexture, v_uv - u_scrollOffset);
  vec2 upstream = (0.5 - low.xy) * u_pushStrength;

#ifdef USE_NOISE
  // gradient-noise derivative bends the advection so the wake curls; coords warped by the flow itself
  vec3 n0 = noised(gl_FragCoord.xy * u_curlScale * (1.0 - low.xy));
  vec2 n1 = noised(gl_FragCoord.xy * u_curlScale * (2.0 - low.xy * (0.5 + n0.x) + n0.yz * 0.1)).yz;
  upstream += n1 * (low.z + low.w) * u_curlStrength;
#endif

  vec4 data = texture2D(u_prevPaintTexture, v_uv - u_scrollOffset + upstream * u_paintTexelSize);
  data.xy -= 0.5;                                                // signed velocity

  // all three fades in one line: adding (k-1)*v is multiplying by k
  vec4 change = (u_dissipations.xxyz - 1.0) * data;
  change += vec4(u_vel * brush, rw.yy * brush);                  // inject inside the brush
  // 8-bit floor: every weight step is at least ~1/255 so the trail always reaches exactly 0 or 1
  change.zw = sign(change.zw) * max(vec2(0.004), abs(change.zw));
  data += change;
  data.xy *= step(vec2(u_velSnap), abs(data.xy));               // POLISH: below the snap the residue is rest, not a push

  data.xy += 0.5;
  gl_FragColor = clamp(data, 0.0, 1.0);
}`

export class ScreenPaint {
  private prev = fboHelper.createRenderTarget(1, 1)
  private curr = fboHelper.createRenderTarget(1, 1)
  private low = fboHelper.createRenderTarget(1, 1)
  private lowBlur = fboHelper.createRenderTarget(1, 1)
  private from = new THREE.Vector4()
  private to = new THREE.Vector4()
  private v2 = new THREE.Vector2()
  material: THREE.ShaderMaterial
  // live tuning (ch.14 S.10 values)
  pushStrength = 25
  velocityDissipation = 0.975
  weight1Dissipation = 0.95
  weight2Dissipation = 0.8
  useNoise = true
  curlScale = 0.02
  curlStrength = 3
  accelerationDissipation = 0.8
  minRadius = 0
  maxRadius = 40
  radiusDistanceRange = 100
  drawEnabled = true
  needsMouseDown = false
  private started = false

  constructor() {
    this.material = fboHelper.track(new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: PAINT_FRAG,
      defines: { USE_NOISE: '' },
      uniforms: {
        u_prevPaintTexture: { value: null }, u_lowPaintTexture: { value: null },
        u_paintTexelSize: { value: new THREE.Vector2() },
        u_drawFrom: { value: this.from }, u_drawTo: { value: this.to },
        u_vel: { value: new THREE.Vector2() },
        u_pushStrength: { value: 25 }, u_curlScale: { value: 0.02 }, u_curlStrength: { value: 3 },
        u_dissipations: { value: new THREE.Vector3() },
        u_scrollOffset: { value: new THREE.Vector2() },
        u_velSnap: { value: 0 },
      },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    }))
    shared.u_currPaintTexture.value = this.curr.texture
    this.listenTouch()
  }

  // Touch, as the reference reads it (touchstart/touchmove/touchend on the document). Pointer events stop at
  // pointercancel the moment the page starts a native scroll, which would freeze the brush where the finger first
  // moved; touch events keep reporting the finger through the scroll, so the trail follows it like on the original.
  private touchDown = false
  private touchXY = new THREE.Vector2()
  private touchMoved = false
  private listenTouch() {
    const o = { passive: true } as AddEventListenerOptions
    const at = (e: TouchEvent) => e.changedTouches[0] || e.touches[0]
    document.addEventListener('touchstart', (e) => { const t = at(e); if (!t) return; this.touchDown = true; this.touchXY.set(t.clientX, t.clientY); this.touchMoved = true }, o)
    document.addEventListener('touchmove', (e) => { const t = at(e); if (!t) return; this.touchDown = true; this.touchXY.set(t.clientX, t.clientY); this.touchMoved = true }, o)
    const up = () => { this.touchDown = false }
    document.addEventListener('touchend', up, o); document.addEventListener('touchcancel', up, o)
  }
  private touchWasDown = false
  private touchPx = new THREE.Vector2(-1, -1)
  private touchPrevPx = new THREE.Vector2(-1, -1)
  private hasTouched = false
  private touchMode = false
  private pxNow = new THREE.Vector2()
  private pxPrev = new THREE.Vector2()

  resize(_renderW?: number, _renderH?: number) {
    const [rw, rh] = referenceRenderSize(props.width, props.height)
    const pw = Math.max(1, rw >> 2), ph = Math.max(1, rh >> 2)
    const lw = Math.max(1, rw >> 3), lh = Math.max(1, rh >> 3)
    this.maxRadius = Math.max(40, props.width / 20)
    if (pw === this.curr.width && ph === this.curr.height) return
    const had = this.curr.width > 1
    // new targets, the old field resampled into them: a resize (phone URL bar, rotation, window drag) never wipes the trail
    const make = (w: number, h: number) => { const t = fboHelper.createRenderTarget(1, 1); t.setSize(w, h); return t }
    const prev = make(pw, ph), curr = make(pw, ph), low = make(lw, lh), lowBlur = make(lw, lh)
    for (const t of [prev, curr, low, lowBlur]) fboHelper.render(FILL, t)
    if (had) { const sx = pw / this.curr.width, sy = ph / this.curr.height; this.to.x *= sx; this.to.y *= sy; this.from.x *= sx; this.from.y *= sy; this.to.z *= sy; this.from.z *= sy }
    if (had) { fboHelper.copy(this.curr.texture, curr); fboHelper.copy(this.curr.texture, prev); fboHelper.copy(this.curr.texture, low) }
    for (const t of [this.prev, this.curr, this.low, this.lowBlur]) t.dispose()
    this.prev = prev; this.curr = curr; this.low = low; this.lowBlur = lowBlur
    this.material.uniforms.u_paintTexelSize.value.set(1 / pw, 1 / ph)
    shared.u_paintTextureSize.value.set(pw, ph)
    shared.u_currPaintTexture.value = this.curr.texture
    if (!had) this.material.uniforms.u_vel.value.set(0, 0)
  }

  clear() {
    for (const t of [this.prev, this.curr, this.low, this.lowBlur]) fboHelper.render(FILL, t)
    this.material.uniforms.u_vel.value.set(0, 0)
  }

  update(dt: number) {
    const u = this.material.uniforms
    const pw = this.curr.width, ph = this.curr.height
    // 1) ping-pong first; shared uniform now points at the target about to be written
    const t = this.prev; this.prev = this.curr; this.curr = t
    u.u_prevPaintTexture.value = this.prev.texture
    shared.u_currPaintTexture.value = this.curr.texture

    // 6) scroll is part of the input (vertical page): shift the pointer and the advection lookup
    const ratio = props.look.paintOffsetRatio
    const scrollView = props.height > 0 ? props.scrollDelta / props.height : 0 // viewport fractions
    const offY = scrollView * ratio        // added to the -1..1 pointer as the reference does (one viewport = 1.0)
    u.u_scrollOffset.value.set(0, Math.abs(props.scrollDelta) > props.height * 0.5 ? 0 : scrollView * ratio)   // POLISH: a jump does not drag the field

    // pointer source: the mouse (input service), or the finger (own touch listeners) once a touch has been seen
    if (this.touchMoved) { this.touchMode = true; this.hasTouched = true }
    else if (input.hadMoved && !input.isTouch) this.touchMode = false
    const px = this.pxNow, prevPx = this.pxPrev
    let isDown: boolean, wasDown: boolean, moved: boolean, ever: boolean
    if (this.touchMode) {
      this.touchPrevPx.copy(this.touchPx.x < 0 ? this.touchXY : this.touchPx)
      this.touchPx.copy(this.touchXY)
      px.copy(this.touchPx); prevPx.copy(this.touchPrevPx)
      isDown = this.touchDown; wasDown = this.touchWasDown; moved = this.touchMoved; ever = true
    } else {
      px.copy(input.mousePixelXY); prevPx.copy(input.prevMousePixelXY)
      isDown = input.isDown; wasDown = input.wasDown; moved = input.hadMoved; ever = input.everMoved
    }
    this.touchMoved = false; this.touchWasDown = this.touchDown
    // POLISH (rv-visual #11): on touch the finger already moves WITH the page, so the scroll term double-counted it into
    // a full-height stroke, and momentum scroll kept painting at the lifted finger: screen-crack seams that lingered.
    // On touch the brush follows the finger only (no scroll term, paints only while held); desktop is unchanged.
    // a JUMP (the loop wrap, a nav/deep-link jump: more than half a screen in one frame) is not a scroll: it never
    // paints, on any device (the wrap used to draw a full-height seam over the hero)
    const jump = Math.abs(props.scrollDelta) > props.height * 0.5
    // W25 R6.47 (Shifat 2:28 AM Oct 21, LOCKED FOREVER: the lusion-decoded-source DESKTOP trail on every device): the finger drives
    // the desktop brush exactly as the mouse does, scroll term included; only a jump (more than half a screen in one frame: the
    // loop wrap, a deep link; the reference has none) never paints
    const scrollTerm = jump ? 0 : props.scrollDelta

    // 2) radius from speed: px moved this frame, the scroll added to the pointer ×3 viewports (the reference adds
    // scrollViewDelta × viewportHeight × 3 to the y-down pixel position), so a scroll paints even with a still pointer
    this.v2.copy(px); this.v2.y += scrollTerm * ratio * 3
    let radius = fit(this.v2.distanceTo(prevPx), 0, this.radiusDistanceRange, this.minRadius, this.maxRadius)
    // 3) when it refuses to paint: still and not scrolling; on touch / needsMouseDown only while held two frames
    // W25 R6.47: the desktop rule only (needsMouseDown is false, as on the reference's desktop): no mobile hold-to-paint path
    const touchRule = this.needsMouseDown && (!isDown || !wasDown)
    if (Math.abs(scrollTerm) === 0 && (!moved || !this.drawEnabled || touchRule)) radius = 0
    if (!ever || !this.drawEnabled) radius = 0
    radius = (radius / props.height) * ph // CSS px → paint px

    // 4) the brush is a segment: from = last to (pointer in -1..1, y up, plus the scroll in viewport units)
    this.from.copy(this.to)
    const mx = ever ? (px.x / props.width) * 2 - 1 : 0
    const my = (ever ? 1 - (px.y / props.height) * 2 : 0) + (jump ? 0 : offY)
    this.to.set(((mx + 1) * pw) / 2, ((my + 1) * ph) / 2, radius, 1)
    if (!this.started) { this.from.copy(this.to); this.started = true }

    // 5) leaky-integrated brush velocity
    this.v2.set(this.to.x - this.from.x, this.to.y - this.from.y).multiplyScalar(dt * 0.8)
    u.u_vel.value.multiplyScalar(this.accelerationDissipation).add(this.v2)

    // live tuning → uniforms
    u.u_pushStrength.value = this.pushStrength
    u.u_curlScale.value = this.curlScale
    u.u_curlStrength.value = this.curlStrength
    const f = settings.PAINT_DT_SCALED ? dt * 60 : 1 // parity: per-frame constants, as the reference (W25 R6.47: on touch too)
    u.u_dissipations.value.set(Math.pow(this.velocityDissipation, f), Math.pow(this.weight1Dissipation, f), Math.pow(this.weight2Dissipation, f))
    u.u_velSnap.value = 0   // W25 R6.47: the reference has no velocity snap
    if (this.useNoise !== ('USE_NOISE' in this.material.defines)) {
      if (this.useNoise) this.material.defines.USE_NOISE = ''; else delete this.material.defines.USE_NOISE
      this.material.needsUpdate = true
    }

    // 7) three GPU calls
    u.u_lowPaintTexture.value = this.low.texture
    fboHelper.render(this.material, this.curr)
    fboHelper.copy(this.curr.texture, this.low)
    blurInPlace(8, this.low, this.lowBlur)
  }
  get texture() { return this.curr.texture }
  get lowTexture() { return this.low.texture }
}
