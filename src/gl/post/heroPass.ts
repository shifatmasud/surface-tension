import * as THREE from 'three'
import { Pass } from 'postprocessing'
import { props } from '../../state/props'
import { settings } from '../../services/settings'
import { SPLIT, LOW_END_GPU, paintState } from '../quality'
import { clip } from '../systems/clip'
import { WL_EDGE } from '../water/waterline'
import type { GradeEffect, ScreenPaintDistortionEffect } from './effects'
import { stickerGL } from './stickerGL'   // R6.92b GIFT STICKER IN THE TRAIL

/**
 * R6.87 SPLIT RESOLUTION — the hero pass (Shifat 5:46–5:48 PM Oct 22: "Resolution Quality down the bg scene but quality
 * up the stone, project images, [...] crewmate model only"; "Only crewmate, stone, project images/videos are my true hi
 * res subjects"; the tablet is background).
 *
 * The background (water, sky, environment, fog, bloom, particles, the tablet, the journey's scenery) is the post chain as
 * before, at the governor's DPR. The hero subjects never draw into it:
 *   1. HIDE (order -1): every registered, visible hero root is hidden for the scene pass, so the low-res background holds
 *      no low-res copy of them (no soft fringe can show outside their crisp edge).
 *   2. DRAW (order 1, right after the scene pass): the scene pass's depth (a depth texture on the chain's input buffer)
 *      is written into the hero target's depth at the canvas density, then the scene is drawn again with the camera on the
 *      hero layer only: the heroes, with their own fog, lights and environment, at full density, occluded by whatever of
 *      the background stands in front of them. Only the heroes' screen rectangle is touched (scissor).
 *   3. COMPOSITE (after the chain's one upscale onto the canvas): the hero target goes over the canvas through the same
 *      Grade (the chain's own uniforms, shared objects: identical numbers), the footer curtain's lift, and the locked trail
 *      (the same 9-tap smear and wake fringe the ScreenPaintDistortion pass applies), premultiplied, so their antialiased
 *      edges blend straight onto the background.
 *   4. UI heroes (the project slides + their reels, drawn by the GL-text 'under' layer after the grade): hidden from that
 *      layer in the chain and drawn at canvas density after step 3, through the trail only (they were never graded).
 * Background reflections (the lake's mirror of the stone) are drawn by their own passes and still see the heroes.
 * ?nosplit turns all of this off (the R6.83 single-resolution path).
 */
export const HERO_LAYER = 11
type Root = { o: THREE.Object3D; ui: boolean; was: boolean }

const VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`
const DEPTH_FS = /* glsl */ `uniform sampler2D u_depth; varying vec2 vUv; void main(){ gl_FragDepth = texture2D(u_depth, vUv).r; gl_FragColor = vec4(0.0); }`

class HeroPass {
  enabled = SPLIT
  private roots: Root[] = []
  private pending: Root[] = []
  private warmScene: THREE.Scene | null = null; private warmCam: THREE.Camera | null = null
  private hiddenUi: Root[] = []
  /** the hero target at canvas density; MSAA where the GPU is not a budget part */
  rt: THREE.WebGLRenderTarget | null = null
  depth: THREE.DepthTexture | null = null
  private box = { x: 0, y: 0, w: 0, h: 0, on: false }
  private drawn = false
  private lightsAt = -1
  private v = new THREE.Vector3(); private v2 = new THREE.Vector2(); private sp = new THREE.Sphere(); private bb = new THREE.Box3()
  private quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
  private qcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private depthMat = new THREE.ShaderMaterial({ uniforms: { u_depth: { value: null } }, vertexShader: VS, fragmentShader: DEPTH_FS, depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth, colorWrite: false })
  /** R6.92b WATERLINE: re-writes the depth of the surface the heroes pierce at the canvas density (set by the stage) */
  depthFix: ((gl: THREE.WebGLRenderer, camera: THREE.Camera) => void) | null = null
  private comp: THREE.ShaderMaterial | null = null
  private stk: THREE.ShaderMaterial | null = null
  private stkTex: THREE.CanvasTexture | null = null
  private stkCls = false
  private ui: THREE.ShaderMaterial | null = null
  private qscene = new THREE.Scene()
  stats = { heroes: 0, ui: 0, box: [0, 0, 0, 0] as number[], w: 0, h: 0 }

  constructor() { this.quad.frustumCulled = false; this.qscene.add(this.quad) }

  /** register a hero root (scene heroes are graded; ui heroes ride the 'under' GL-text layer). Returns the unregister. */
  add(o: THREE.Object3D, ui = false) {
    if (!this.enabled) return () => {}
    const r: Root = { o, ui, was: true }
    this.roots.push(r)
    this.pending.push(r) // its programs are linked a frame later (warmPending), ahead of its first appearance
    o.traverse((c) => c.layers.enable(HERO_LAYER))
    return () => { const i = this.roots.indexOf(r); if (i >= 0) this.roots.splice(i, 1) }
  }
  private shown(o: THREE.Object3D) { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true }
  /** any scene hero on screen this frame (the hide / draw passes run only then) */
  active() {
    if (!this.enabled) return false
    for (const r of this.roots) if (!r.ui && this.shown(r.o)) return true
    return false
  }
  hasUi() {
    if (!this.enabled) return false
    for (const r of this.roots) if (r.ui && this.shown(r.o)) return true
    return false
  }

  /** the chain's input buffer gets a depth texture (our own: the composer's depth bookkeeping never sees or deletes it) */
  attachDepth(input: THREE.WebGLRenderTarget) {
    if (!this.enabled) return
    this.input = input
    if (input.depthTexture) return
    const d = new THREE.DepthTexture(input.width, input.height)
    d.type = THREE.UnsignedIntType
    input.depthTexture = d; input.dispose()
    this.depth = d
  }
  /** R6.88 (Shifat 10:31–10:32 PM: the stone must sit INSIDE the Shade DS ring, near parts in front of it): the composer
   *  swaps the input buffer's depth texture for its own whenever a pass that reads depth joins the chain, so the copy read
   *  an orphan texture nothing was drawn into and every hero drew over the whole scene. The depth the scene pass actually
   *  wrote is whatever the input buffer carries at draw time; read that one. */
  private input: THREE.WebGLRenderTarget | null = null
  private sceneDepth() {
    const i = this.input
    if (!i) return this.depth
    if (!i.depthTexture) { const d = this.depth ?? new THREE.DepthTexture(i.width, i.height); d.type = THREE.UnsignedIntType; i.depthTexture = d; i.dispose(); this.depth = d }
    return i.depthTexture
  }

  private ensure(gl: THREE.WebGLRenderer) {
    const v = gl.getDrawingBufferSize(this.v2)
    // R6.89 (Shifat 4:09–4:10 AM): the heroes have their own density (props.heroDpr: phones 1.0) under the canvas's (the
    // text's: phones 1.5); the composite samples this target by screen uv, so it upsamples onto the canvas
    const k = Math.min(1, (props.heroDpr || gl.getPixelRatio()) / Math.max(1e-3, gl.getPixelRatio()))
    const w = Math.max(1, Math.round(v.x * k)), h = Math.max(1, Math.round(v.y * k))
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, samples: (LOW_END_GPU || settings.TIER === 'low') && (props.heroDpr || 2) > 1.01 ? 0 : 4, generateMipmaps: false })
      // R6.89: at the 1.0 phone hero density the silhouettes (the crewmate's rim, the stone's girdle) stepped and read as a
      // thin fringe once upsampled onto the 1.5 canvas; 4x MSAA on this small target (resolved on-chip on tile GPUs) smooths them
      this.rt.texture.minFilter = this.rt.texture.magFilter = THREE.LinearFilter
    } else if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h)
    this.stats.w = w; this.stats.h = h
    return this.rt
  }

  /** the screen rectangle (canvas px, bottom-left origin) covered by the visible heroes, or none */
  private measure(camera: THREE.Camera, ui: boolean, cam2?: THREE.Camera) {
    const W = this.rt!.width, H = this.rt!.height
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, any = false, full = false
    for (const r of this.roots) {
      if (r.ui !== ui || !this.shown(r.o)) continue
      if (ui) { full = true; any = true; continue }   // the slides place their vertices in the shader (no usable bounds)
      // a hero that knows its own screen rectangle (the crewmate twins of the screens: only the crewmate's part of the glass)
      const hr = r.o.userData.heroRect as ((c: THREE.Camera) => number[] | null) | undefined
      if (hr) {
        const q = hr(camera)
        if (!q) continue
        x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[2]); y1 = Math.max(y1, q[3]); any = true
        continue
      }
      const c = cam2 ?? camera
      r.o.updateWorldMatrix(true, true)
      this.bb.setFromObject(r.o, false)
      if (this.bb.isEmpty() || r.o.userData.heroFull) { full = true; any = true; continue }
      // the 8 corners of the world box, projected (a corner behind the camera = the whole screen)
      const b = this.bb
      for (let i = 0; i < 8; i++) {
        this.v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(c.matrixWorldInverse)
        if (this.v.z > -((c as THREE.PerspectiveCamera).near ?? 0.01)) { full = true; break }
        this.v.applyMatrix4(c.projectionMatrix)
        x0 = Math.min(x0, this.v.x); x1 = Math.max(x1, this.v.x); y0 = Math.min(y0, this.v.y); y1 = Math.max(y1, this.v.y)
      }
      any = true
    }
    const B = this.box
    if (!any) { B.on = false; return B }
    if (full) { B.x = 0; B.y = 0; B.w = W; B.h = H; B.on = true; return B }
    // NDC → px, with a margin for vertex animation the bounds do not carry (sway, bob) and for the trail's smear, which
    // pulls hero pixels up to ~8 % of the screen: the whole grown box is cleared and drawn, so the composite never reads a
    // stale pixel from an earlier frame
    const trail = props.look.paintAmount > 0 && !paintState.asleep
    const mx = 0.06 + (trail ? 0.16 * Math.max(W, H) / W : 0), my = 0.06 + (trail ? 0.16 * Math.max(W, H) / H : 0)
    x0 = Math.max(-1, x0 - mx); y0 = Math.max(-1, y0 - my); x1 = Math.min(1, x1 + mx); y1 = Math.min(1, y1 + my)
    if (x1 <= x0 || y1 <= y0) { B.on = false; return B }
    B.x = Math.floor((x0 * 0.5 + 0.5) * W); B.y = Math.floor((y0 * 0.5 + 0.5) * H)
    B.w = Math.min(W - B.x, Math.ceil((x1 - x0) * 0.5 * W) + 2); B.h = Math.min(H - B.y, Math.ceil((y1 - y0) * 0.5 * H) + 2)
    B.on = B.w > 0 && B.h > 0
    return B
  }

  /** order -1: hide the scene heroes for the scene pass */
  hide() {
    for (const r of this.roots) { if (r.ui) continue; r.was = r.o.visible; if (r.was && this.shown(r.o)) r.o.visible = false; else r.was = false }
  }
  private restore() { for (const r of this.roots) if (!r.ui && r.was) { r.o.visible = true; r.was = false } }

  /** the lights join the hero layer (the hero draw uses a hero-only camera mask; lights are layer-tested too) */
  private lights(scene: THREE.Scene) {
    if (props.frame - this.lightsAt < 30) return
    this.lightsAt = props.frame
    scene.traverse((o) => { if ((o as THREE.Light).isLight) o.layers.enable(HERO_LAYER) })
  }

  /** order 1: the heroes at canvas density into the hero target, depth-tested against the scene pass */
  draw(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.restore()
    this.drawn = false
    const rt = this.ensure(gl)
    const B = this.measure(camera, false)
    if (!B.on) return
    this.lights(scene)
    const prev = gl.getRenderTarget(), auto = gl.autoClear, ca = gl.getClearAlpha(), cc = gl.getClearColor(new THREE.Color())
    const bg = scene.background, mask = camera.layers.mask, su = gl.shadowMap.autoUpdate
    rt.scissor.set(B.x, B.y, B.w, B.h); rt.scissorTest = true
    rt.viewport.set(0, 0, rt.width, rt.height)
    gl.setRenderTarget(rt)
    gl.setClearColor(0x000000, 0); gl.autoClear = false
    gl.clear(true, true, false)
    // the background's depth at canvas density
    const sd = this.sceneDepth()
    if (sd) { this.depthMat.uniforms.u_depth.value = sd; this.quad.material = this.depthMat; gl.render(this.qscene, this.qcam) }
    // R6.92b WATERLINE (Shifat 9:59–10:02 AM: the line where the stone pierces the water was jagged and crawled on his
    // weak-GPU PC and his phone): the depth above is the background's, upsampled from ITS density (0.5 on the low path),
    // so the smooth plane of the lake arrived as 2x2 depth steps and the stone's cut along it was a sawtooth that shifted
    // as the stone moved. The stage redraws just the lake's depth here at the canvas density (same vertex shader, an
    // empty fragment), so the cut is computed per canvas pixel, as on desktop high.
    if (this.depthFix) this.depthFix(gl, camera)
    scene.background = null; camera.layers.set(HERO_LAYER); gl.shadowMap.autoUpdate = false
    try { gl.render(scene, camera) } finally {
      scene.background = bg; camera.layers.mask = mask; gl.shadowMap.autoUpdate = su
      gl.setClearColor(cc, ca); gl.autoClear = auto; gl.setRenderTarget(prev)
    }
    this.stats.box = [B.x, B.y, B.w, B.h]
    this.drawn = true
  }

  // ---- composite
  private build(grade: GradeEffect, dist: ScreenPaintDistortionEffect, foot: Map<string, THREE.Uniform> | null) {
    const gsrc = (grade as any).fragmentShader as string
    const un: Record<string, THREE.IUniform> = {}
    grade.uniforms.forEach((u, k) => { un[k] = u })
    dist.uniforms.forEach((u, k) => { if (!un[k]) un[k] = u })
    const fk = foot?.get('u_fk') ?? new THREE.Uniform(0), ft = foot?.get('u_ft') ?? new THREE.Uniform(0)
    const fa = foot?.get('u_fasp') ?? new THREE.Uniform(1), fv = foot?.get('u_fvel') ?? new THREE.Uniform(0)
    const common = (graded: boolean) => ({
      ...un, u_fk: fk, u_ft: ft, u_fasp: fa, u_fvel: fv,
      tHero: { value: null as THREE.Texture | null }, u_trail: { value: 0 }, u_curtain: { value: foot ? 1 : 0 },
    })
    // the grade's own functions (mainUv, mainImage) are spliced in as written; `inputBuffer` is never read by them
    const body = (graded: boolean) => /* glsl */ `
uniform sampler2D tHero; uniform float u_trail, u_curtain; uniform float u_fk, u_ft, u_fasp, u_fvel;
uniform float u_fadeIn;
uniform sampler2D u_screenPaintTexture; uniform vec2 u_screenPaintTexelSize;
uniform float u_amount, u_rgbShift, u_multiplier, u_colorMultiplier, u_shade;
${graded ? gsrc : `uniform sampler2D u_blueNoise; uniform vec2 u_blueNoiseOffset; uniform vec2 u_blueNoiseSize;
vec3 getBlueNoise(vec2 coord){ return texture2D(u_blueNoise, coord / u_blueNoiseSize + u_blueNoiseOffset).rgb; }`}
${graded ? '' : WL_EDGE}
varying vec2 vUv;
float hEdge(float x){ return u_fk + (wlEdge(x * u_fasp, u_ft) * (0.9 + 1.6 * u_fvel)) * smoothstep(0.0, 0.06, u_fk); }
vec3 h_enc(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 h_dec(vec3 c){ c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
// one hero sample at screen uv p, as the chain would have it before the trail: (encoded straight colour, alpha)
vec4 heroAt(vec2 p){
  vec2 q = p;
  ${graded ? 'mainUv(q);' : ''}
  if (u_fk > 0.0) q.y -= u_fk;
  vec4 h = texture2D(tHero, q);
  if (h.a < 0.0005) return vec4(0.0);
  vec3 c = h.rgb / h.a;
  ${graded ? 'vec4 o; mainImage(vec4(c, 1.0), q, o); c = o.rgb;' : ''}
  return vec4(min(h_enc(c), 1.0), h.a);
}
void main(){
  if (u_curtain > 0.5 && u_fk > 0.0 && vUv.y < hEdge(vUv.x)) discard;   // the footer curtain covers the picture there
  vec4 acc;
  float fr = 0.0; vec2 vel = vec2(0.0); float weight = 0.0;
  if (u_trail > 0.5) {
    vec3 bn = getBlueNoise(gl_FragCoord.xy + vec2(17.0, 29.0));
    vec4 data = texture2D(u_screenPaintTexture, vUv);
    weight = (data.z + data.w) * 0.5;
    vel = (0.5 - data.xy - 0.001) * 2.0 * weight;
    vec2 stepUv = vel * u_amount / 4.0 * u_screenPaintTexelSize * u_multiplier;
    if (dot(stepUv, stepUv) > 1e-12) {
      vec2 p = vUv + bn.xy * stepUv;
      acc = vec4(0.0);
      for (int i = 0; i < 9; i++) { vec4 s = heroAt(p); acc += vec4(s.rgb * s.a, s.a); p += stepUv; }
      acc /= 9.0;
      fr = 1.0;
    } else { vec4 s = heroAt(vUv); acc = vec4(s.rgb * s.a, s.a); }
  } else { vec4 s = heroAt(vUv); acc = vec4(s.rgb * s.a, s.a); }
  float a = acc.a * u_fadeIn;
  if (a < 0.002) discard;
  vec3 c = acc.rgb / max(acc.a, 1e-4);
  if (fr > 0.5) c += sin(vec3(vel.x + vel.y) * 40.0 + vec3(0.0, 2.0, 4.0) * u_rgbShift) * smoothstep(0.4, -0.9, weight) * u_shade * max(abs(vel.x), abs(vel.y)) * u_colorMultiplier;
  gl_FragColor = vec4(h_dec(clamp(c, 0.0, 1.0)), 1.0);
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a);
}`
    const mk = (graded: boolean) => new THREE.ShaderMaterial({
      uniforms: { ...common(graded), u_fadeIn: { value: 1 } }, vertexShader: VS, fragmentShader: body(graded),
      depthTest: false, depthWrite: false, toneMapped: false, transparent: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    })
    this.comp = mk(true); this.ui = mk(false)
    // R6.92b GIFT STICKER IN THE TRAIL: the footer's gift sticker (a DOM button's 2D canvas, stickerGL.ts) at the canvas
    // density, through the same 9-tap smear and wake fringe as the heroes; placed by the button's CSS transform
    this.stk = new THREE.ShaderMaterial({
      uniforms: { ...un, tStk: { value: null as THREE.Texture | null }, u_trail: { value: 0 }, u_sk: { value: new THREE.Vector4(0, 0, 0, 1) }, u_sk2: { value: new THREE.Vector3(1, 1, 1) } },
      vertexShader: VS, depthTest: false, depthWrite: false, toneMapped: false, transparent: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      fragmentShader: /* glsl */ `
uniform sampler2D tStk; uniform float u_trail; uniform vec4 u_sk; uniform vec3 u_sk2;
uniform sampler2D u_screenPaintTexture; uniform vec2 u_screenPaintTexelSize;
uniform float u_amount, u_rgbShift, u_multiplier, u_colorMultiplier, u_shade;
uniform sampler2D u_blueNoise; uniform vec2 u_blueNoiseOffset; uniform vec2 u_blueNoiseSize;
vec3 getBlueNoise(vec2 coord){ return texture2D(u_blueNoise, coord / u_blueNoiseSize + u_blueNoiseOffset).rgb; }
varying vec2 vUv;
vec3 h_enc(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 h_dec(vec3 c){ c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
// the sticker at screen uv p (premultiplied): css px from the button's centre, un-rotated and un-scaled (CSS rotate, y down)
vec4 stkAt(vec2 p){
  vec2 pc = vec2(p.x * u_sk2.y, (1.0 - p.y) * u_sk2.z) - u_sk.xy;
  float c = cos(u_sk.z), s = sin(u_sk.z);
  vec2 t = vec2(c * pc.x + s * pc.y, -s * pc.x + c * pc.y) / (u_sk.w * u_sk2.x) + 0.5;
  if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) return vec4(0.0);
  vec4 h = texture2D(tStk, vec2(t.x, 1.0 - t.y));
  return vec4(h.rgb * h.a, h.a);
}
void main(){
  vec4 acc; float fr = 0.0; vec2 vel = vec2(0.0); float weight = 0.0;
  if (u_trail > 0.5) {
    vec3 bn = getBlueNoise(gl_FragCoord.xy + vec2(17.0, 29.0));
    vec4 data = texture2D(u_screenPaintTexture, vUv);
    weight = (data.z + data.w) * 0.5;
    vel = (0.5 - data.xy - 0.001) * 2.0 * weight;
    vec2 stepUv = vel * u_amount / 4.0 * u_screenPaintTexelSize * u_multiplier;
    if (dot(stepUv, stepUv) > 1e-12) {
      vec2 p = vUv + bn.xy * stepUv; acc = vec4(0.0);
      for (int i = 0; i < 9; i++) { acc += stkAt(p); p += stepUv; }
      acc /= 9.0; fr = 1.0;
    } else acc = stkAt(vUv);
  } else acc = stkAt(vUv);
  float a = acc.a;
  if (a < 0.002) discard;
  vec3 c = h_enc(acc.rgb / max(a, 1e-4));
  if (fr > 0.5) c += sin(vec3(vel.x + vel.y) * 40.0 + vec3(0.0, 2.0, 4.0) * u_rgbShift) * smoothstep(0.4, -0.9, weight) * u_shade * max(abs(vel.x), abs(vel.y)) * u_colorMultiplier;
  gl_FragColor = vec4(h_dec(clamp(c, 0.0, 1.0)), 1.0);
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a);
}`,
    })
  }

  /** the live block's share of the frame during a crossfading boundary (heroes belong to the live render) */
  private fade() {
    if (!clip.boundary || !clip.xfade || clip.cut) return 1
    const t = Math.min(1, Math.max(0, (clip.t - 0.15) / 0.7)), k = t * t * (3 - 2 * t)
    return clip.liveUpper ? 1 - k : k
  }

  private put(gl: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, B: { x: number; y: number; w: number; h: number }) {
    mat.uniforms.tHero.value = this.rt!.texture
    mat.uniforms.u_trail.value = props.look.paintAmount > 0 && !paintState.asleep ? 1 : 0
    mat.uniforms.u_fadeIn.value = this.fade()
    this.quad.material = mat
    const prev = gl.getRenderTarget(), auto = gl.autoClear
    gl.setRenderTarget(null); gl.autoClear = false
    // the box grown by the trail's reach (its smear pulls hero pixels up to ~10 % of the screen) — in canvas px
    // the box already carries the trail's reach (measure): exactly the pixels that were cleared and drawn this frame
    const W = this.rt!.width, H = this.rt!.height
    const pr = gl.getPixelRatio() * (this.rt!.width / Math.max(1, gl.getDrawingBufferSize(this.v2).x)) // R6.89: target px → css px
    // R6.89: under the footer curtain the composite shows the hero target lifted by u_fk (heroAt), so the drawn box is the
    // measured box lifted by the same rows; it was clipped at the unlifted box, which sliced the CTA crewmate's head off
    // as the footer came up (Shifat: "must not animate mask out")
    const fkPx = Math.max(0, (mat.uniforms.u_fk?.value as number) || 0) * H
    const x = Math.max(0, B.x), y = Math.max(0, B.y + fkPx), x1 = Math.min(W, B.x + B.w), y1 = Math.min(H, B.y + B.h + fkPx)
    if (x1 <= x || y1 <= y) { gl.autoClear = auto; gl.setRenderTarget(prev); return }
    gl.setScissorTest(true); gl.setScissor(x / pr, y / pr, (x1 - x) / pr, (y1 - y) / pr)
    gl.render(this.qscene, this.qcam)
    gl.setScissorTest(false)
    gl.autoClear = auto; gl.setRenderTarget(prev)
  }

  /** after the chain's upscale onto the canvas: the graded scene heroes, then the UI heroes */
  composite(gl: THREE.WebGLRenderer, grade: GradeEffect, dist: ScreenPaintDistortionEffect, foot: Map<string, THREE.Uniform> | null, ufxUnder: THREE.Scene, ufxCamera: THREE.Camera) {
    if (!this.enabled) return
    if (!this.comp) this.build(grade, dist, foot)
    this.compositeHeroes(gl, ufxUnder, ufxCamera)
    this.sticker(gl)
  }

  /** R6.92b: the gift sticker over everything (it sits over the canvas in the DOM too), through the trail */
  private sticker(gl: THREE.WebGLRenderer) {
    const S = stickerGL, el = S.el, cv = S.cv
    if (!el || !cv || !this.stk || !el.classList.contains('is-on') || el.classList.contains('is-gone')) return
    if (!this.stkTex || this.stkTex.image !== cv) {
      this.stkTex?.dispose()
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.premultiplyAlpha = false; t.generateMipmaps = false   // straight alpha: decoded from sRGB, then premultiplied in the shader (premultiplied sRGB bytes decoded as colour darkened the soft shadow into a hard ring)
      t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter
      this.stkTex = t; S.dirty = true
    }
    if (S.dirty) { this.stkTex.needsUpdate = true; S.dirty = false }
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2
    const vw = props.width, vh = props.height, u = this.stk.uniforms
    const trail = props.look.paintAmount > 0 && !paintState.asleep
    u.tStk.value = this.stkTex; u.u_trail.value = trail ? 1 : 0
    u.u_sk.value.set(cx, cy, S.rot, Math.max(0.01, S.sc)); u.u_sk2.value.set(Math.max(1, S.W), vw, vh)
    // the canvas square, turned and scaled, plus the trail's reach (its smear pulls pixels up to ~8 % of the screen)
    const half = S.W * Math.max(0.01, S.sc) * 0.72 + (trail ? 0.16 * Math.max(vw, vh) : 0)
    const x0 = Math.max(0, Math.floor(cx - half)), x1 = Math.min(vw, Math.ceil(cx + half)), y0 = Math.max(0, Math.floor(cy - half)), y1 = Math.min(vh, Math.ceil(cy + half))
    if (x1 <= x0 || y1 <= y0) return
    const prev = gl.getRenderTarget(), auto = gl.autoClear
    gl.setRenderTarget(null); gl.autoClear = false
    this.quad.material = this.stk
    gl.setScissorTest(true); gl.setScissor(x0, vh - y1, x1 - x0, y1 - y0)
    gl.render(this.qscene, this.qcam)
    gl.setScissorTest(false)
    gl.autoClear = auto; gl.setRenderTarget(prev)
    if (!this.stkCls) { this.stkCls = true; document.documentElement.classList.add('stk-gl') }
  }

  private compositeHeroes(gl: THREE.WebGLRenderer, ufxUnder: THREE.Scene, ufxCamera: THREE.Camera) {
    this.warmPending(gl)
    if (this.drawn) this.put(gl, this.comp!, this.box)
    this.drawn = false
    // UI heroes: drawn now at canvas density (the chain's 'under' layer skipped them), through the trail only
    if (!this.hasUi()) return
    const rt = this.ensure(gl)
    const B = this.measure(ufxCamera, true, ufxCamera)
    if (!B.on) return
    const prev = gl.getRenderTarget(), auto = gl.autoClear, ca = gl.getClearAlpha(), cc = gl.getClearColor(new THREE.Color())
    rt.scissor.set(B.x, B.y, B.w, B.h); rt.scissorTest = true
    gl.setRenderTarget(rt); gl.setClearColor(0x000000, 0); gl.autoClear = false
    gl.clear(true, true, false)
    const mask = ufxCamera.layers.mask, bgr = ufxUnder.background
    ufxUnder.background = null; ufxCamera.layers.set(HERO_LAYER)
    try { gl.render(ufxUnder, ufxCamera) } finally { ufxCamera.layers.mask = mask; ufxUnder.background = bgr; gl.setClearColor(cc, ca); gl.autoClear = auto; gl.setRenderTarget(prev) }
    this.put(gl, this.ui!, B)
  }

  /** PERFGOV: behind the preloader, every program this pass uses is linked (the composites, the depth copy, each hero's
   *  material as the hero target sees it), so none links at its first appearance mid-scroll */
  warm(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, grade: GradeEffect, dist: ScreenPaintDistortionEffect, foot: Map<string, THREE.Uniform> | null) {
    if (!this.enabled) return
    this.warmScene = scene; this.warmCam = camera; this.pending.length = 0
    try {
      if (!this.comp) this.build(grade, dist, foot)
      const prev = gl.getRenderTarget()
      gl.setRenderTarget(null)
      for (const m of [this.comp!, this.ui!, this.stk!]) { this.quad.material = m; gl.compile(this.qscene, this.qcam) }
      const rt = this.ensure(gl)
      gl.setRenderTarget(rt)
      this.quad.material = this.depthMat; gl.compile(this.qscene, this.qcam)
      for (const r of this.roots) {
        const v = r.o.visible; r.o.visible = true
        try { gl.compile(r.o as unknown as THREE.Scene, camera, scene) } catch { /* warm-up only */ }
        r.o.visible = v
      }
      gl.setRenderTarget(prev)
    } catch { /* warm-up only */ }
  }

  /** one late-registered hero's programs per frame, linked into the hero target before it is ever seen */
  private warmPending(gl: THREE.WebGLRenderer) {
    const r = this.pending.shift()
    if (!r || !this.warmScene || !this.warmCam) return
    const prev = gl.getRenderTarget(), v = r.o.visible
    try { gl.setRenderTarget(this.ensure(gl)); r.o.visible = true; gl.compile(r.o as unknown as THREE.Scene, this.warmCam, this.warmScene) } catch { /* warm-up only */ } finally { r.o.visible = v; gl.setRenderTarget(prev) }
  }

  /** the chain's 'under' GL-text layer runs without the UI heroes (they are drawn at canvas density instead) */
  hideUi() { this.hiddenUi.length = 0; for (const r of this.roots) if (r.ui && r.o.visible) { r.o.visible = false; this.hiddenUi.push(r) } }
  restoreUi() { for (const r of this.hiddenUi) r.o.visible = true; this.hiddenUi.length = 0 }
}

export const heroPass = new HeroPass()
if (typeof window !== 'undefined') (window as any).__hero = heroPass

/** order -1 / order 1 passes for the post chain (no swap, the input buffer is untouched) */
export class HeroHidePass extends Pass {
  constructor() { super('HeroHide'); this.needsSwap = false; this.renderToScreen = false }
  render() { heroPass.hide() }
}
export class HeroDrawPass extends Pass {
  constructor(private sceneRef: THREE.Scene, private cameraRef: THREE.Camera) { super('HeroDraw'); this.needsSwap = false; this.renderToScreen = false }
  render(renderer: THREE.WebGLRenderer) { heroPass.draw(renderer, this.sceneRef, this.cameraRef) }
}
/** around the 'under' GL-text layer pass: the UI heroes are skipped in it (drawn at canvas density instead) */
export class UiHidePass extends Pass {
  constructor(private show: boolean) { super(show ? 'UiShow' : 'UiHide'); this.needsSwap = false; this.renderToScreen = false }
  render() { if (this.show) heroPass.restoreUi(); else heroPass.hideUi() }
}
