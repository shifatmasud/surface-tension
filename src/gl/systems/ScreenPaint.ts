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
      },
      depthTest: false, depthWrite: false,
    }))
    shared.u_currPaintTexture.value = this.curr.texture
  }

  resize(w: number, h: number) {
    // render size → 1/4 paint, 1/8 feedback (integer shifts like the original's >>2 / >>3)
    const pw = Math.max(1, w >> 2), ph = Math.max(1, h >> 2)
    const lw = Math.max(1, w >> 3), lh = Math.max(1, h >> 3)
    this.prev.setSize(pw, ph); this.curr.setSize(pw, ph)
    this.low.setSize(lw, lh); this.lowBlur.setSize(lw, lh)
    this.material.uniforms.u_paintTexelSize.value.set(1 / pw, 1 / ph)
    shared.u_paintTextureSize.value.set(pw, ph)
    this.maxRadius = Math.max(40, props.width / 20)
    this.clear()
  }

  clear() {
    for (const t of [this.prev, this.curr, this.low, this.lowBlur]) fboHelper.clearColor(0.5, 0.5, 0, 0, t)
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
    u.u_scrollOffset.value.set(0, scrollView * ratio)

    // 2) radius from speed: px moved this frame (plus the scroll streak, ×3 for the radius test)
    this.v2.copy(input.mousePixelXY); this.v2.y -= props.scrollDelta * ratio * 3
    const moved = this.v2.distanceTo(input.prevMousePixelXY)
    let radius = fit(moved, 0, this.radiusDistanceRange, this.minRadius, this.maxRadius)
    // 3) when it refuses to paint
    const touchRule = (this.needsMouseDown || browser.isMobile || input.isTouch) && (!input.isDown || !input.wasDown)
    if (Math.abs(props.scrollDelta) === 0 && (!input.hadMoved || !this.drawEnabled || touchRule)) radius = 0
    if (!input.everMoved || !this.drawEnabled) radius = 0
    radius = (radius / props.height) * ph // CSS px → paint px

    // 4) the brush is a segment: from = last to
    this.from.copy(this.to)
    const mx = input.mouseXY.x, my = input.mouseXY.y + offY
    this.to.set(((mx + 1) * pw) / 2, ((my + 1) * ph) / 2, radius, 1)
    if (!this.started) { this.from.copy(this.to); this.started = true }

    // 5) leaky-integrated brush velocity
    this.v2.set(this.to.x - this.from.x, this.to.y - this.from.y).multiplyScalar(dt * 0.8)
    u.u_vel.value.multiplyScalar(this.accelerationDissipation).add(this.v2)

    // live tuning → uniforms
    u.u_pushStrength.value = this.pushStrength
    u.u_curlScale.value = this.curlScale
    u.u_curlStrength.value = this.curlStrength
    const f = settings.PAINT_DT_SCALED ? dt * 60 : 1 // parity: per-frame constants (see checklist note)
    u.u_dissipations.value.set(Math.pow(this.velocityDissipation, f), Math.pow(this.weight1Dissipation, f), Math.pow(this.weight2Dissipation, f))
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
