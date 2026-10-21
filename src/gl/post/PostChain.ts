import * as THREE from 'three'
import { BloomEffect, EffectComposer, EffectPass, FXAAEffect, KernelSize, Pass, RenderPass, SMAAEffect, SMAAPreset } from 'postprocessing'
import { GradeEffect, ScreenPaintDistortionEffect } from './effects'
import { DiveGodRaysPass } from './DiveGodRays'
import { ClipCompositeEffect } from './ClipComposite'
import { clip } from '../systems/clip'
import { diveRays } from '../stages/dive/diveState'
import { props, shared } from '../../state/props'
import { settings } from '../../services/settings'
import { quality, paintState } from '../quality' // PERF HOOK
import { warmGate } from '../../services/preload'
import { InlineSharpenEffect } from './perfEffects' // PERF HOOK
import type { Look } from '../../state/props'
import { ufx } from '../ufx/ufx'
import { SharpText } from './SharpText'
import { stickerMask, gemMask } from '../systems/stickerMask'
import { makeSelective, syncSelective } from '../fx/hotBloom' // CINEMATIC: selective bloom (hot spots only)
import { gpuTimer } from '../systems/perfGovernor' // SHARP: the governor's GPU frame timer ends after the last draw

/**
 * The render queue (handbook ch.3 / 8). Effects are data: { pass, renderOrder, enabled }.
 * Every frame the queue is filtered by needsRender and sorted by renderOrder; a disabled pass is
 * removed from the composer entirely, so "off" costs nothing. Ping-pong + last-pass-to-screen are
 * handled by the composer. Scene target is flat (no MSAA) because SMAA does the anti-aliasing.
 *
 * PERF HOOK (Shifat 10:21Z + his r3f optimization skill): no MSAA anywhere; SMAA (MEDIUM preset) is the ONE
 * anti-aliasing step and it runs LAST, after the trail; the sharpen that runs below native size rides inside the
 * Grade pass (one full-screen pass fewer); the trail distortion pass drops out while the trail sim sleeps (no input
 * for ~6 s); on phones at the very bottom of the governor's ladder SMAA (3 passes) gives way to FXAA (1 pass).
 * Phone hero, before: Scene, Grade, SMAA×3, Sharpen, Distortion = 7 full-screen passes; after: Scene, Sharpen+Grade,
 * SMAA×3 = 5 (6 while the trail is live).
 *
 *   0    Scene            (world stage, camera rig)
 *   10   Bloom            (HQ: mipmap pyramid, 8 levels; LQ: small Kawase kernel)
 *   30   Grade            (Final: grade, vignette, fade, dither, waterline band)
 *   50   PreUfx           (DOM-mirrored layer that bends with the cursor paint)
 *   3100 ScreenPaintDistortion (after the clip composite: the cursor trail is one global, always-live layer that
 *        never freezes in a section's still frame and never shifts with a card — Shifat 09:38Z)
 *   100  PostUfx          (crisp layer drawn over the distortion)
 *   3000 ClipComposite   (clipped-section boundary: live card over the outgoing block's captured frame)
 *   4000 SMAA / FXAA     (final, screen-space; FXAA only on phones at the governor's floor)
 */
type Entry = { name: string; order: number; pass: Pass; needsRender: () => boolean; on?: boolean }

const NOCAS = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nocas')

export class PostChain {
  composer: EffectComposer
  entries: Entry[] = []
  grade = new GradeEffect()
  distortion = new ScreenPaintDistortionEffect()
  bloom: BloomEffect
  private signature = -1
  /** PERF HOOK: set once behind the preloader curtain — the next render runs every pass this tier can use, so each
   *  pass program (clip composite, god rays, trail, SMAA/FXAA) compiles during loading, not at its first boundary */
  warmAll = false
  /** DIAG: the warm-up frame above has run (the preloader counts it) */
  warmDone = false
  scenePass: RenderPass
  /** W18 (Shifat 14:01Z): the global text slot at the canvas's full density */
  text: SharpText
  preUfx: RenderPass
  postUfx: RenderPass

  /** NEIGHBOUR HOOK: the outgoing section's own small chain (systems/neighbour.ts) — created on first use */
  private nbc: { composer: EffectComposer; grade: GradeEffect; bloom: BloomEffect; w: number; h: number; swaps: number } | null = null
  private nbFull = new THREE.Vector2()
  private nbArgs: [THREE.Scene, THREE.Camera, THREE.Scene, THREE.Scene, THREE.Camera]

  constructor(public gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, ufxUnder: THREE.Scene, ufxOver: THREE.Scene, ufxCamera: THREE.Camera) {
    this.nbArgs = [scene, camera, ufxUnder, ufxOver, ufxCamera]
    this.composer = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 0 })
    // W18 fps fix: the whole chain (AA included) stays at the scene's adaptive DPR; only one bilinear blit touches the
    // full-density canvas, then the text layer (scissored to its boxes). Before this the last pass (SMAA/FXAA) ran at
    // the canvas's native density, ~3x the pixels on a 3x phone, with its full tap count.
    this.composer.autoRenderToScreen = false
    this.text = new SharpText(this.distortion)
    this.scenePass = new RenderPass(scene, camera)
    this.bloom = settings.BLOOM_HQ
      ? new BloomEffect({ mipmapBlur: true, levels: 8, radius: 0.72, intensity: 0.4, luminanceThreshold: 0.9, luminanceSmoothing: 0.08 })
      : new BloomEffect({ mipmapBlur: false, kernelSize: KernelSize.SMALL, intensity: 0.35, luminanceThreshold: 0.9, luminanceSmoothing: 0.1, resolutionScale: 0.5 })
    makeSelective(this.bloom) // CINEMATIC: the same bloom pass, its luminance pre-pass masked to hot spots
    this.preUfx = new RenderPass(ufxUnder, ufxCamera); this.preUfx.clear = false; this.preUfx.ignoreBackground = true
    this.postUfx = new RenderPass(ufxOver, ufxCamera); this.postUfx.clear = false; this.postUfx.ignoreBackground = true
    // W22 (scorer-r614 #3, the stepped stone outline at 390): MEDIUM searches 8 px along an edge, so the stone's long, shallow
    // silhouette (upscaled ~2x on phones) kept its stair steps. HIGH searches 16: same three passes, more taps on edge pixels only
    const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH })
    const fxaa = new FXAAEffect()
    const renderScale = () => props.dpr / Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
    // sharpen (convolution) first, then the grade on its result: one pass instead of two when below native size
    const gradeOnly = new EffectPass(camera, this.grade)
    const sharpGrade = new EffectPass(camera, new InlineSharpenEffect(), this.grade)
    const sharp = () => false && renderScale() < 0.99   // W18: CAS in the final upscale replaces the inline sharpen
    this.entries = [
      { name: 'Scene', order: 0, pass: this.scenePass, needsRender: () => true },
      { name: 'DiveGodRays', order: 5, pass: new DiveGodRaysPass(camera), needsRender: () => diveRays.on },
      { name: 'Bloom', order: 10, pass: new EffectPass(camera, this.bloom), needsRender: () => settings.USE_BLOOM && props.look.bloom > 0.001 },
      { name: 'Grade', order: 30, pass: gradeOnly, needsRender: () => !sharp() },
      { name: 'Sharpen+Grade', order: 30, pass: sharpGrade, needsRender: () => sharp() },
      { name: 'PreUfx', order: 50, pass: this.preUfx, needsRender: () => ufxUnder.children.some((c) => c.visible) },
      { name: 'ScreenPaintDistortion', order: 3100, pass: new EffectPass(camera, this.distortion), needsRender: () => props.look.paintAmount > 0 && !paintState.asleep },
      { name: 'PostUfx', order: 100, pass: this.postUfx, needsRender: () => ufxOver.children.some((c) => c.visible) },
      { name: 'SMAA', order: 4000, pass: new EffectPass(camera, smaa), needsRender: () => quality.aa === 'smaa' },
      { name: 'FXAA', order: 4000, pass: new EffectPass(camera, fxaa), needsRender: () => quality.aa === 'fxaa' },
      // W17 GLOBAL TEXT LAYER (Shifat 10:17Z + 11:46Z): all copy in one fixed slot, drawn ONCE over the composited frame
      // (so a boundary never doubles it or slides it with a card) and BEFORE the trail, so the trail still bends it
      // (W18, Shifat 14:01Z) the slot is no longer a pass in this chain: drawText() draws it after the final pass, at the
      // canvas's full density, through the same trail displacement
      { name: 'ClipComposite', order: 3000, pass: new EffectPass(camera, new ClipCompositeEffect()), needsRender: () => clip.boundary || clip.capture >= 0 },
    ]
  }
  // the one full-density pass: the finished frame (in the composer's input buffer after its last swap) upscaled once
  private blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private blitMat = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null as THREE.Texture | null }, u_texel: { value: new THREE.Vector2(1, 1) }, u_sharp: { value: 0 }, u_up: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    // SHARP UPSCALE (Shifat 15:39Z + the sharp lane): when the scene is upscaled onto the canvas, a Catmull-Rom bicubic
    // in 5 bilinear taps (the same tap count as the old bilinear+CAS cross) instead of bilinear, clamped to the taps'
    // min/max so its negative lobe cannot ring, then contrast-adaptive sharpening (AMD CAS-style weight: strong on soft
    // detail, backing off at hard edges and in flat areas) with the strength following the upscale ratio. At 1:1 (the
    // rest refinement: native density) a mild 1-texel CAS only, to take back the softness SMAA leaves on texture.
    fragmentShader: `uniform sampler2D tMap; uniform vec2 u_texel; uniform float u_sharp; uniform float u_up; varying vec2 vUv;
vec3 casW(vec3 mn, vec3 mx, float s){ vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0)); return -amp * mix(0.125, 0.2, s); }
void main(){
  vec3 e;
  if (u_up > 0.5) {
    vec2 ts = 1.0 / u_texel;
    vec2 sp = vUv * ts; vec2 tc = floor(sp - 0.5) + 0.5; vec2 f = sp - tc;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2; vec2 t12 = (tc + w2 / w12) * u_texel, t0 = (tc - 1.0) * u_texel, t3 = (tc + 2.0) * u_texel;
    vec3 c = texture2D(tMap, t12).rgb;
    vec3 n = texture2D(tMap, vec2(t12.x, t0.y)).rgb, s = texture2D(tMap, vec2(t12.x, t3.y)).rgb;
    vec3 wv = texture2D(tMap, vec2(t0.x, t12.y)).rgb, ea = texture2D(tMap, vec2(t3.x, t12.y)).rgb;
    float kc = w12.x * w12.y, kn = w12.x * w0.y, ks = w12.x * w3.y, kw = w0.x * w12.y, ke = w3.x * w12.y;
    e = (c * kc + n * kn + s * ks + wv * kw + ea * ke) / (kc + kn + ks + kw + ke);
    vec3 mn = min(c, min(min(n, s), min(wv, ea))), mx = max(c, max(max(n, s), max(wv, ea)));
    e = clamp(e, mn, mx);
    if (u_sharp > 0.0) { vec3 w = casW(mn, mx, u_sharp) * 0.6; e = clamp((e + (n + s + wv + ea) * w) / (1.0 + 4.0 * w), mn, mx); }
  } else {
    e = texture2D(tMap, vUv).rgb;
    if (u_sharp > 0.0) {
      vec3 b = texture2D(tMap, vUv + vec2(0.0, -u_texel.y)).rgb, d = texture2D(tMap, vUv + vec2(-u_texel.x, 0.0)).rgb;
      vec3 f = texture2D(tMap, vUv + vec2(u_texel.x, 0.0)).rgb, h = texture2D(tMap, vUv + vec2(0.0, u_texel.y)).rgb;
      vec3 mn = min(e, min(min(b, d), min(f, h))), mx = max(e, max(max(b, d), max(f, h)));
      vec3 w = casW(mn, mx, u_sharp);
      e = clamp((e + (b + d + f + h) * w) / (1.0 + 4.0 * w), 0.0, 64.0);
    }
  }
  gl_FragColor = vec4(e, 1.0);
  #include <colorspace_fragment>
}`,
    depthTest: false, depthWrite: false, toneMapped: false,
  })
  private blitScene = (() => { const s = new THREE.Scene(); const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat); m.frustumCulled = false; s.add(m); return s })()
  private blit() {
    const gl = this.gl, prev = gl.getRenderTarget(), auto = gl.autoClear
    this.blitMat.uniforms.tMap.value = this.composer.inputBuffer.texture
    this.blitMat.uniforms.u_texel.value.set(1 / this.bw, 1 / this.bh)
    // sharpen only when the scene is upscaled onto the canvas (its DPR below the canvas's)
    // SHARP: bicubic + CAS when upscaled (strength by ratio); a mild CAS at 1:1 (rest: native density, SMAA). ?nocas: off
    const up = props.textDpr > props.dpr * 1.05
    this.blitMat.uniforms.u_up.value = up ? 1 : 0
    this.blitMat.uniforms.u_sharp.value = NOCAS ? 0 : up ? Math.min(1, (props.textDpr / props.dpr - 1) * 0.8) : 0.25
    gl.setRenderTarget(null); gl.autoClear = false
    gl.render(this.blitScene, this.blitCam)
    gl.autoClear = auto; gl.setRenderTarget(prev)
    this.hdrProbe()
  }
  // W24 R6.36 (Shifat's AA rule; Tab 05:50Z): the header's ink follows the frame actually behind it. Every 250 ms the finished
  // frame under the wordmark (left half) and the sound control (right half) is box-sampled into a 16×4 8-bit target with the
  // screen's own encoding and read back ASYNCHRONOUSLY (PBO + fence: no GPU stall). The tone that gives the better worst-case
  // WCAG contrast over both wins, with a 15 % margin before it flips back, so it never flickers; the CSS colour transition
  // keeps the change continuous. Until the first reading (or on the no-GL page) the header keeps the scene's UI tone.
  private hdrRT = (() => { const t = new THREE.WebGLRenderTarget(16, 4, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false }); t.texture.colorSpace = THREE.SRGBColorSpace; return t })()
  private hdrBuf = new Uint8Array(16 * 4 * 4)
  private hdrMat = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null }, u_a: { value: new THREE.Vector4(0, 0, 0, 0) }, u_b: { value: new THREE.Vector4(0, 0, 0, 0) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D tMap; uniform vec4 u_a, u_b; varying vec2 vUv;
void main(){
  vec4 r = vUv.x < 0.5 ? u_a : u_b; float fx = fract(vUv.x * 2.0);
  vec2 uv = vec2(mix(r.x, r.z, fx), mix(r.y, r.w, vUv.y));
  vec3 e = clamp(texture2D(tMap, uv).rgb, 0.0, 1.0);
  gl_FragColor = vec4(e, 1.0);
  #include <colorspace_fragment>
}`,
    depthTest: false, depthWrite: false, toneMapped: false,
  })
  private hdrScene = (() => { const s = new THREE.Scene(); const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.hdrMat); m.frustumCulled = false; s.add(m); return s })()
  private hdrT = 0
  private hdrBusy = false
  private hdrTone = ''
  private hdrVotes = 0
  private hdrRects() {
    const W = innerWidth, H = innerHeight, toUv = (el: Element | null, fb: number[]) => {
      const r = el ? el.getBoundingClientRect() : null
      const [l, t, rr, b] = r && r.width > 2 ? [r.left - 6, r.top - 4, r.right + 6, r.bottom + 4] : fb
      return [Math.max(0, l / W), Math.max(0, 1 - b / H), Math.min(1, rr / W), Math.min(1, 1 - t / H)]
    }
    ;(this.hdrMat.uniforms.u_a.value as THREE.Vector4).fromArray(toUv(document.querySelector('.header .wordmark'), [24, 16, 130, 58]))
    ;(this.hdrMat.uniforms.u_b.value as THREE.Vector4).fromArray(toUv(document.querySelector('.header .pills'), [W - 90, 16, W - 20, 58]))
  }
  private hdrBg = ''
  private hdrEma = [-1, -1]
  private hdrProbe() {
    const now = performance.now()
    // W24 R6.39 (scorer-r638 #1: ink lingered seconds on the deep after the dive): when the scene's own tone flips, the header
    // takes it at once and the measurement starts fresh; the readback then only corrects it where the frame disagrees
    const bg = document.documentElement.dataset.bg === 'dark' ? 'dark' : 'light'
    if (bg !== this.hdrBg) {
      this.hdrBg = bg; this.hdrTone = bg; this.hdrVotes = 0; this.hdrEma = [-1, -1]
      if (document.documentElement.dataset.hdr !== bg) document.documentElement.dataset.hdr = bg
    }
    if (this.hdrBusy || now - this.hdrT < 250) return
    const gl = this.gl as THREE.WebGLRenderer & { readRenderTargetPixelsAsync?: (...a: unknown[]) => Promise<unknown> }
    if (!gl.readRenderTargetPixelsAsync) return
    this.hdrT = now; this.hdrBusy = true
    this.hdrRects()
    this.hdrMat.uniforms.tMap.value = this.composer.inputBuffer.texture
    const prev = gl.getRenderTarget()
    gl.setRenderTarget(this.hdrRT); gl.render(this.hdrScene, this.blitCam); gl.setRenderTarget(prev)
    gl.readRenderTargetPixelsAsync(this.hdrRT, 0, 0, 16, 4, this.hdrBuf).then(() => {
      this.hdrBusy = false
      const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
      let worstInk = 99, worstWhite = 99
      for (let half = 0; half < 2; half++) {
        // each half: the mean luminance of its 8×4 box samples (extremes swing with every bubble and frond that drifts past)
        let sum = 0
        for (let y = 0; y < 4; y++) for (let x = half * 8; x < half * 8 + 8; x++) {
          const i = (y * 16 + x) * 4
          sum += 0.2126 * lin(this.hdrBuf[i]) + 0.7152 * lin(this.hdrBuf[i + 1]) + 0.0722 * lin(this.hdrBuf[i + 2])
        }
        // R6.39 (scorer-r638 #1: the 390 sky blinked under passing leaves): an EMA over readings (~1 s at 250 ms)
        const e0 = this.hdrEma[half], L = e0 < 0 ? sum / 32 : e0 + (sum / 32 - e0) * 0.3
        this.hdrEma[half] = L
        worstInk = Math.min(worstInk, (L + 0.05) / (0.0065 + 0.05))   // ink #121315 over it
        worstWhite = Math.min(worstWhite, (1.0 + 0.05) / (L + 0.05))  // white over it
      }
      const cur = this.hdrTone || bg
      // R6.39 decision (scorer-r638 #1; Tab 07:27Z): the scene's own tone is the default; the header leaves it only where the
      // frame gives it under 3:1 AND the other colour does 25 % better, and returns once the scene tone reaches 3.3:1 again (or
      // the other colour stops clearly winning). Mid-tone skies where both colours sit near 3:1 keep the scene tone (no blink).
      // A colour reading under 2:1 with the other clearly better switches at once; anything else needs ~0.75 s of agreement.
      const ct: Record<string, number> = { light: worstInk, dark: worstWhite }
      const alt = bg === 'dark' ? 'light' : 'dark'
      let other = ''
      if (cur === bg) { if (ct[bg] < 3.0 && ct[alt] > ct[bg] * 1.25) other = alt }
      else if (ct[bg] >= 3.3 || ct[alt] < ct[bg] * 1.1) other = bg
      const urgent = other !== '' && ct[cur] < 2.0 && ct[other] > ct[cur] * 1.25
      this.hdrVotes = other ? this.hdrVotes + 1 : 0
      const want = other && (urgent || this.hdrVotes >= 3) ? other : cur
      if (want !== cur) this.hdrVotes = 0
      this.hdrTone = want
      if (document.documentElement.dataset.hdr !== want) document.documentElement.dataset.hdr = want
    }).catch(() => { this.hdrBusy = false })
  }
  /** the chain's own buffer size (scene density), independent of the canvas (text density) */
  bw = 1; bh = 1
  setSize(w: number, h: number) {
    // NOT composer.setSize: that sizes every target from the canvas, which now runs at the text density (Scene.tsx
    // applyTextDpr). The scene, bloom, grade, trail and AA all keep the governor's DPR.
    const bw = Math.max(1, Math.round(w * props.dpr)), bh = Math.max(1, Math.round(h * props.dpr))
    this.bw = bw; this.bh = bh
    this.composer.inputBuffer.setSize(bw, bh); this.composer.outputBuffer.setSize(bw, bh)
    for (const e of this.entries) e.pass.setSize(bw, bh)
    this.text.resize(w, h)
    const pw = Math.max(1, (w * props.paintDpr) >> 2), ph = Math.max(1, (h * props.paintDpr) >> 2)
    this.distortion.u('u_screenPaintTexelSize').value.set(1 / pw, 1 / ph)
    this.grade.u('u_aspect').value = w / h
  }
  /** NEIGHBOUR HOOK: the grade the stages should write to right now (the dive's waterline): the neighbour's own while
   *  its pass runs, else the main one */
  gradeFor(neighbour: boolean) { return neighbour && this.nbc ? this.nbc.grade : this.grade }
  /** NEIGHBOUR HOOK: draw the scene as it stands (the neighbour context is set by the caller) through scene → bloom +
   *  grade (one pass) → GL text under/over, at `scale` of the main render size, and return the image. The same
   *  look keys as the main chain; no god rays, trail, composite or AA (the trail and AA are applied to the final frame). */
  renderNeighbour(look: Look, scale: number, dt: number): THREE.Texture {
    const [scene, camera, ufxUnder, ufxOver, ufxCamera] = this.nbArgs
    if (!this.nbc) {
      const composer = new EffectComposer(this.gl, { frameBufferType: THREE.HalfFloatType, multisampling: 0 })
      composer.autoRenderToScreen = false
      const grade = new GradeEffect()
      const bloom = makeSelective(new BloomEffect({ mipmapBlur: false, kernelSize: KernelSize.SMALL, intensity: 0.35, luminanceThreshold: 0.9, luminanceSmoothing: 0.1, resolutionScale: 0.5 }))
      const passes: Pass[] = [new RenderPass(scene, camera), new EffectPass(camera, bloom, grade)]
      const pre = new RenderPass(ufxUnder, ufxCamera); pre.clear = false; pre.ignoreBackground = true
      const post = new RenderPass(ufxOver, ufxCamera); post.clear = false; post.ignoreBackground = true
      passes.push(pre, post)
      for (const p of passes) { p.renderToScreen = false; composer.addPass(p) }
      this.nbc = { composer, grade, bloom, w: 0, h: 0, swaps: passes.filter((p) => p.needsSwap).length }
    }
    const n = this.nbc
    const full = this.nbFull.set(this.bw, this.bh)
    const w = Math.max(2, Math.round(full.x * scale)), h = Math.max(2, Math.round(full.y * scale))
    if (w !== n.w || h !== n.h) {
      n.w = w; n.h = h
      n.composer.inputBuffer.setSize(w, h); n.composer.outputBuffer.setSize(w, h)
      for (const p of n.composer.passes) p.setSize(w, h)
      n.grade.u('u_aspect').value = full.x / Math.max(1, full.y)
    }
    const g = (k: string) => n.grade.u(k)
    g('u_exposure').value = look.exposure; g('u_saturation').value = look.saturation; g('u_contrast').value = look.contrast
    g('u_brightness').value = look.brightness; g('u_vignette').value = look.vignette; g('u_vignetteSoft').value = look.vignetteSoft
    g('u_fade').value = look.fade; g('u_lift').value = look.lift; ;(g('u_tint').value as THREE.Color).copy(look.tint); ;(g('u_fadeColor').value as THREE.Color).copy(look.bg)
    syncSelective(n.bloom, settings.USE_BLOOM ? look.bloom : 0, look.bloomThreshold)
    n.composer.render(dt)
    return (n.swaps % 2 === 1 ? n.composer.outputBuffer : n.composer.inputBuffer).texture
  }
  /** Copy the blended section look into the passes (ch.7.1: visuals → post stack). */
  private darkT = 0
  sync() {
    const L = props.look
    const g = (n: string) => this.grade.u(n)
    g('u_exposure').value = L.exposure; g('u_saturation').value = L.saturation; g('u_contrast').value = L.contrast
    g('u_brightness').value = L.brightness; g('u_vignette').value = L.vignette; g('u_vignetteSoft').value = L.vignetteSoft
    g('u_fade').value = L.fade; g('u_lift').value = L.lift; ;(g('u_tint').value as THREE.Color).copy(L.tint); ;(g('u_fadeColor').value as THREE.Color).copy(L.bg)
    syncSelective(this.bloom, L.bloom, L.bloomThreshold)
    const d = (n: string) => this.distortion.u(n)
    d('u_amount').value = L.paintAmount; d('u_rgbShift').value = L.paintRGBShift
    d('u_multiplier').value = L.paintMultiplier; d('u_colorMultiplier').value = L.paintColorMultiplier
    // W23: the trail's dark-wall mode follows the UI tone in the journey (space) and on the CTA wall, eased so it never pops
    const wantDark = (props.stage === 'journey' || props.stage === 'contact') && document.documentElement.dataset.bg === 'dark' ? 1 : 0   // the CTA wall is the 'contact' stage
    const ud = d('u_dark'), now = performance.now(), kd = 1 - Math.exp(-Math.min(1, (now - this.darkT) / 1000) * 6); this.darkT = now
    ud.value += (((window as any).__trailDark ?? wantDark) - ud.value) * kd
    // W23: the stickers keep out of the trail's smear (stickerInteract.ts writes where they sit)
    d('u_stkOn').value = stickerMask.on && !(window as any).__stkSmear ? 1 : 0
    if (stickerMask.on) { const v = d('u_stk').value as THREE.Vector4[]; for (let i = 0; i < 4; i++) v[i].fromArray(stickerMask.c, i * 4); (d('u_view').value as THREE.Vector2).set(innerWidth, innerHeight) }
    // W23: and so does the hero stone (HeroStage.tsx writes where it sits)
    { const W = window as any; const on = gemMask.on && !W.__gemSmear ? 1 : 0; (d('u_gem').value as THREE.Vector4).set(gemMask.x, gemMask.y, gemMask.r, on); if (on) (d('u_view').value as THREE.Vector2).set(innerWidth, innerHeight) }
  }
  render(dt: number) {
    this.sync()
    let sig = 0  // PERF HOOK: a bitmask, not a string built every frame (no per-frame garbage)
    const warm = this.warmAll
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]
      e.on = warm ? !(e.name === 'Bloom' && !settings.USE_BLOOM) && !(e.name === 'FXAA' && settings.TIER !== 'low') : e.needsRender()
      if (e.on) sig |= 1 << i
    }
    if (warm) {
      this.warmAll = false
      // NEIGHBOUR HOOK: link the neighbour chain's programs (bloom+grade pass, its targets) behind the curtain too
      try { this.renderNeighbour(props.look, 0.5, dt) } catch { /* warm-up only */ }
      // DIAG (preloader): this frame links every post program at once without parallel compile (4.8 s on live at 1440,
      // ANGLE/D3D11) and used to run AFTER the counter read 100. It now counts: the counter holds an honest ~85 % through
      // it and reaches 100 only after it. (Spreading it one pass per frame was measured: it doubled the total wait.)
      if (!warmGate.active) this.warmDone = true // PRELOAD: gated frames are not the warm frame
    }
    if (sig !== this.signature) {
      this.signature = sig
      this.composer.removeAllPasses()
      this.entries.filter((e) => e.on).sort((a, b) => a.order - b.order).forEach((e) => { e.pass.renderToScreen = false; this.composer.addPass(e.pass); e.pass.setSize(this.bw, this.bh) })
      ;(window as any).__chain = this.entries.filter((e) => e.on).map((e) => `${e.order}:${e.name}`)
    }
    this.composer.render(dt)
    this.blit()
    this.text.draw(this.gl)
    gpuTimer.end()
    void shared
  }
}
