import * as THREE from 'three'
import { props, shared } from '../../state/props'
import { BLUE_NOISE } from '../shaders/chunks'
import { ufx } from '../ufx/ufx'
import { paintState } from '../quality'
import { journey } from '../stages/journey/journeyState'
import type { ScreenPaintDistortionEffect } from './effects'
const TXT_SPLIT = !/[?&]txtold\b/.test(location.search)   // R7.06
const TEXT_BEND = /[?&]textbend\b/.test(location.search)   // W21: QA only

/**
 * W18 — Shifat 14:01Z: "Ensure every big text is sharpest not low quality gpu layer like other parts of 3d scene".
 *
 * The global text slot (TextLayer.tsx) is drawn into its OWN target at the canvas's full density (props.textDpr: the
 * device's own DPR, cap 3), never at the scene's adaptive DPR or the neighbour pass's reduced scale. After the post
 * chain has put the (upscaled) scene on the canvas, this composites the text over it, once, through the SAME trail
 * displacement the ScreenPaintDistortion pass applies to the scene (same paint texture, same 9-tap smear, same wake
 * fringe), so the cursor trail still bends and silvers the type exactly as before — now from a full-res source.
 * The target is scissored to the slot's own box (plus a margin for the smear), so the cost is that box only.
 */
const VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`
const FRAG = /* glsl */ `
uniform sampler2D u_text;
uniform sampler2D u_screenPaintTexture;
uniform vec2 u_screenPaintTexelSize;
uniform float u_amount, u_rgbShift, u_multiplier, u_colorMultiplier, u_shade, u_on;
uniform float u_lift;   // W28: the footer curtain's lift, fraction of the screen height (footerWorld.ts u_fk)
${BLUE_NOISE}
varying vec2 vUv;
vec3 enc(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main(){
  // W28 (fast-scroll stress, 390 + 1440): the type belongs to the picture ABOVE the footer curtain. Footer B lifts the
  // curtain inside the frame (footerWorld.ts shifts the picture up by u_fk and draws the footer under the edge), but this
  // pass composites after it, so a beat still rolling out after a jump into the footer was drawn over the footer's own
  // text. It now rides up with the picture and stops at the curtain's edge, as it did when the whole canvas slid (R6.63).
  if (vUv.y < u_lift) discard;
  vec2 tUv = vec2(vUv.x, vUv.y - u_lift);
  vec4 data = texture2D(u_screenPaintTexture, vUv);
  float weight = (data.z + data.w) * 0.5;
  vec2 vel = (0.5 - data.xy - 0.001) * 2.0 * weight;
  vec2 stepUv = vel * u_amount / 4.0 * u_screenPaintTexelSize * u_multiplier * u_on;
  vec4 acc;
  if (dot(stepUv, stepUv) < 1e-12) acc = texture2D(u_text, tUv);
  else {
    vec3 bn = getBlueNoise(gl_FragCoord.xy + vec2(17.0, 29.0));
    vec2 p = tUv + bn.xy * stepUv;
    acc = vec4(0.0);
    for (int i = 0; i < 9; i++) { acc += texture2D(u_text, p); p += stepUv; }
    acc /= 9.0;
  }
  if (acc.a < 0.002) discard;
  vec3 c = enc(acc.rgb / acc.a);
  // the wake's sine fringe, on the type only (the scene got its own in the distortion pass)
  c += sin(vec3(vel.x + vel.y) * 40.0 + vec3(0.0, 2.0, 4.0) * u_rgbShift) * smoothstep(0.4, -0.9, weight) * u_shade * max(abs(vel.x), abs(vel.y)) * u_colorMultiplier * u_on;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0) * acc.a, acc.a);
}`

export class SharpText {
  rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, generateMipmaps: false })
  /** other full-density type drawn into the same target after the slot (the CTA odometer: JourneyStage registers it) */
  extras: { active: () => boolean; draw: (gl: THREE.WebGLRenderer) => void; box?: () => { x: number; y: number; w: number; h: number } | null }[] = []
  private mat: THREE.ShaderMaterial
  private scene = new THREE.Scene()
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private cc = new THREE.Color()
  private w = 1; private h = 1
  /** slot box in css px (top-left origin) incl. the smear margin; null = whole screen */
  box: { x: number; y: number; w: number; h: number } | null = null
  constructor(private distortion: ScreenPaintDistortionEffect) {
    const d = (k: string) => distortion.u(k)
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        u_text: { value: this.rt.texture }, u_on: { value: 0 }, u_lift: { value: 0 },
        u_screenPaintTexture: d('u_screenPaintTexture'), u_screenPaintTexelSize: d('u_screenPaintTexelSize'),
        u_amount: d('u_amount'), u_rgbShift: d('u_rgbShift'), u_multiplier: d('u_multiplier'), u_colorMultiplier: d('u_colorMultiplier'), u_shade: d('u_shade'),
        u_blueNoise: shared.u_blueNoise as any, u_blueNoiseOffset: shared.u_blueNoiseOffset as any, u_blueNoiseSize: shared.u_blueNoiseSize as any,
      },
    })
    const tri = new THREE.BufferGeometry()
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    const m = new THREE.Mesh(tri, this.mat); m.frustumCulled = false
    this.scene.add(m)
  }
  private n = 0
  resize(w: number, h: number) {
    this.w = w; this.h = h
    this.rt.setSize(Math.max(2, Math.round(w * props.textDpr)), Math.max(2, Math.round(h * props.textDpr)))
    this.measure()
  }
  /** the union of every beat's box (they all share the fixed slot), widened by the trail's smear reach */
  measure() {
    const els = document.querySelectorAll<HTMLElement>('.slot__beat')
    if (!els.length) { this.box = null; return }
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
    els.forEach((e) => { const r = e.getBoundingClientRect(); if (r.width < 1) return; x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom) })
    if (x1 < x0) { this.box = null; return }
    const m = Math.max(48, this.h * 0.12)
    const x = Math.max(0, x0 - m), y = Math.max(0, y0 - m)
    this.box = { x, y, w: Math.min(this.w, x1 + m) - x, h: Math.min(this.h, y1 + m) - y }
  }
  /** R7.06 PERF: the type is drawn into its own target BEFORE the scene goes onto the canvas (prepare), and only
   *  composited after it (draw). Before, the canvas was bound for the upscale and the hero composite, left for this
   *  target, then bound again for the text, which on a phone GPU stores the whole canvas out and loads it back each frame.
   *  Same target, same draws, same composite: only the order of the two targets changed. ?txtold = 7.05 order */
  private pre: { b: { x: number; y: number; w: number; h: number } | null } | null = null
  prepare(gl: THREE.WebGLRenderer) { this.pre = null; if (TXT_SPLIT) this.pre = this.drawText(gl) }
  draw(gl: THREE.WebGLRenderer) {
    const p = TXT_SPLIT ? this.pre : this.drawText(gl)
    this.pre = null
    if (!p) return
    this.compose(gl, p.b)
  }
  private drawText(gl: THREE.WebGLRenderer): { b: { x: number; y: number; w: number; h: number } | null } | null {
    const slot = ufx.slot
    let any = false
    for (let i = 0; i < slot.children.length; i++) if (slot.children[i].visible) { any = true; break }
    let ext = false
    for (let i = 0; i < this.extras.length; i++) if (this.extras[i].active()) { ext = true; break }
    if (!any && !ext) return null
    if ((++this.n & 63) === 0) this.measure()   // fonts / late layout: re-read the slot box every 64 frames
    const prev = gl.getRenderTarget(), auto = gl.autoClear, ca = gl.getClearAlpha()
    gl.getClearColor(this.cc)
    const k = props.textDpr
    // the scissor: the slot's box, grown to every extra's box (an extra with no box means the whole screen)
    let b: { x: number; y: number; w: number; h: number } | null = any ? this.box : null
    if (ext) {
      let full = false
      for (const e of this.extras) {
        if (!e.active()) continue
        const eb = e.box ? e.box() : null
        if (!eb) { full = true; break }
        if (!b) b = { ...eb }
        else { const x0 = Math.min(b.x, eb.x), y0 = Math.min(b.y, eb.y); b = { x: x0, y: y0, w: Math.max(b.x + b.w, eb.x + eb.w) - x0, h: Math.max(b.y + b.h, eb.y + eb.h) - y0 } }
      }
      if (full) b = null
      else if (b) { const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y); b = { x: x0, y: y0, w: Math.min(this.w, b.x + b.w) - x0, h: Math.min(this.h, b.y + b.h) - y0 }; if (b.w <= 0 || b.h <= 0) b = { x: 0, y: 0, w: 1, h: 1 } }
    }
    // 1) the slot's lines into the full-density target (only the slot's box is cleared and drawn)
    gl.setRenderTarget(this.rt)
    gl.setClearColor(0x000000, 0)
    if (b) {
      const x = Math.max(0, Math.floor(b.x * k)), y = Math.max(0, Math.floor((this.h - b.y - b.h) * k))
      const sw = Math.min(this.rt.width - x, Math.ceil(b.w * k)), shh = Math.min(this.rt.height - y, Math.ceil(b.h * k))
      this.rt.scissor.set(x, y, Math.max(1, sw), Math.max(1, shh)); this.rt.scissorTest = true
    } else this.rt.scissorTest = false
    gl.clear(true, true, false)
    gl.autoClear = false
    if (any) gl.render(slot, ufx.slotCamera)
    if (ext) for (const e of this.extras) if (e.active()) e.draw(gl)
    gl.autoClear = auto
    gl.setClearColor(this.cc, ca)
    gl.setRenderTarget(prev)
    return { b }
  }
  private compose(gl: THREE.WebGLRenderer, b: { x: number; y: number; w: number; h: number } | null) {
    const prev = gl.getRenderTarget(), auto = gl.autoClear
    gl.autoClear = false
    // 2) composite over the finished frame on the canvas, through the trail
    // W21 (scorer-r610/r614: the pointer trail refracted 'PORTFOLIO' and the name, so the type wobbled under the cursor):
    // the copy sits ABOVE the trail now; the trail bends the scene under it, never the words. (?textbend restores it)
    this.mat.uniforms.u_on.value = TEXT_BEND && props.look.paintAmount > 0 && !paintState.asleep ? 1 : 0
    const lift = Math.max(0, journey.lift || 0)
    this.mat.uniforms.u_lift.value = lift / Math.max(1, this.h)
    if (b && lift > 0) b = { x: b.x, y: b.y - lift, w: b.w, h: b.h }   // the scissor rides up with the type
    gl.setRenderTarget(null)
    if (b) { gl.setScissorTest(true); gl.setScissor(b.x, this.h - b.y - b.h, b.w, b.h) }
    gl.render(this.scene, this.cam)
    if (b) gl.setScissorTest(false)
    gl.autoClear = auto
    gl.setRenderTarget(prev)
  }
}
