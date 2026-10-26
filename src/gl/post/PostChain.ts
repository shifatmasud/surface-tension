import * as THREE from 'three'
import { BloomEffect, EffectComposer, EffectPass, FXAAEffect, KernelSize, Pass, RenderPass, SMAAEffect, SMAAPreset } from 'postprocessing'
import { GradeEffect, ScreenPaintDistortionEffect, trailFilterMode } from './effects'
import { DiveGodRaysPass } from './DiveGodRays'
import { ClipCompositeEffect } from './ClipComposite'
import { clip } from '../systems/clip'
import { diveRays, diveLo, DIVE_LAYER } from '../stages/dive/diveState'
import { journey } from '../stages/journey/journeyState'
import { props, shared } from '../../state/props'
import { settings } from '../../services/settings'
import { quality, paintState, PHONE_SHARP, DENS_ONE } from '../quality' // PERF HOOK
import { warmGate } from '../../services/preload'
import { InlineSharpenEffect } from './perfEffects' // PERF HOOK
import type { Look } from '../../state/props'
import { ufx } from '../ufx/ufx'
import { SharpText } from './SharpText'
import { stickerMask, gemMask } from '../systems/stickerMask'
import { makeSelective, syncSelective } from '../fx/hotBloom' // CINEMATIC: selective bloom (hot spots only)
import { FOOT_MODE, FooterWorldEffect } from './footerWorld' // FOOTER MOCKUP (VITE_FOOT 1|2; 0 = live, effect absent)
import { heroPass, HeroHidePass, HeroDrawPass, UiHidePass } from './heroPass' // R6.87 SPLIT RESOLUTION
import { SPLIT } from '../quality'
import { PHONE } from '../../core/viewport'
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

/** R7.08b rest supersampling: ?taa=0 off, ?taa=1 on any device (default: phones); the blend floor (8-frame memory) */
const TAA_Q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('taa') : null
const TAA_MODE = TAA_Q === '1' ? 1 : TAA_Q === 'phone' ? 2 : 0   // R7.08c (Shifat 8:22 PM on his M02s: "hero feels jittery"): rest supersampling OFF by default (its sub-pixel jitter + history clamp shimmered on the animated hero and toggled with every touch); ?taa=phone = 7.08b
const TAA_FLOOR = 0.125
const NOCAS = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nocas')

/** R7.10 SPLIT DENSITY (diveState.diveLo): shades the dive's water volume at half the density into its own target and
 *  points the backdrop sphere at it for the scene render; BackdropRestore hands the sphere its own shader back. */
class BackdropLoPass extends Pass {
  private rt = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
  constructor(private cam: THREE.Camera) { super('BackdropLo'); this.needsSwap = false }
  render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget) {
    const L = diveLo, m = L.mesh, b = L.blit
    if (!m || !b || !L.full) return
    const W = inputBuffer.width, H = inputBuffer.height, w = Math.ceil(W * 0.5), h = Math.ceil(H * 0.5)
    if (this.rt.texture.type !== inputBuffer.texture.type) { this.rt.dispose(); this.rt.texture.type = inputBuffer.texture.type }
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h)
    m.material = L.lo ?? L.full!
    const sc = renderer.getScissorTest(), ac = renderer.autoClear
    renderer.setScissorTest(false); renderer.autoClear = false   // the sphere covers every pixel
    renderer.setRenderTarget(this.rt); renderer.render(m, this.cam)
    renderer.autoClear = ac; renderer.setScissorTest(sc)
    b.uniforms.tLo.value = this.rt.texture
    b.uniforms.u_full.value.set(W, H); b.uniforms.u_loSize.value.set(w, h)
    m.material = b
  }
  dispose() { this.rt.dispose(); super.dispose() }
}
class BackdropRestorePass extends Pass {
  constructor() { super('BackdropRestore'); this.needsSwap = false }
  render() { if (diveLo.mesh && diveLo.full) diveLo.mesh.material = diveLo.full }
}

export class PostChain {
  composer: EffectComposer
  entries: Entry[] = []
  grade = new GradeEffect()
  /** R7.10: kept so the merged pass can take its composite */
  rays!: DiveGodRaysPass
  /** R7.10: the same grade without its lens mainUv (shares every uniform with `grade`), for the merged SMAA pass */
  gradeNoUv = (() => { const g = new GradeEffect(false); this.grade.uniforms.forEach((u, k) => g.uniforms.set(k, u)); return g })()
  distortion = new ScreenPaintDistortionEffect(trailFilterMode(settings.TIER === 'low' || !!settings.WEAK_GPU)) // R7.07 HI-RES TRAIL
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
  /** R6.87: the footer effect's uniforms (the hero composite rides the same curtain) */
  footer: FooterWorldEffect | null = null
  private ufxUnderRef: THREE.Scene; private ufxCameraRef: THREE.Camera

  /** NEIGHBOUR HOOK: the outgoing section's own small chain (systems/neighbour.ts) — created on first use */
  private nbc: { composer: EffectComposer; grade: GradeEffect; bloom: BloomEffect; w: number; h: number; swaps: number } | null = null
  private nbFull = new THREE.Vector2()
  private nbArgs: [THREE.Scene, THREE.Camera, THREE.Scene, THREE.Scene, THREE.Camera]

  constructor(public gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, ufxUnder: THREE.Scene, ufxOver: THREE.Scene, ufxCamera: THREE.Camera) {
    this.nbArgs = [scene, camera, ufxUnder, ufxOver, ufxCamera]
    this.ufxUnderRef = ufxUnder; this.ufxCameraRef = ufxCamera
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
    this.jitWrap(this.scenePass, camera); this.jitWrap(this.preUfx, ufxCamera); this.jitWrap(this.postUfx, ufxCamera)   // R7.08b
    ;(window as any).__post = this; (window as any).__heroPass = heroPass   // R7.10 QA: per-pass cost probe
    ;(window as any).__taa = () => ({ on: this.taaOn, k: this.taaK })   // R7.08b QA: rest supersampling state
    // W22 (scorer-r614 #3, the stepped stone outline at 390): MEDIUM searches 8 px along an edge, so the stone's long, shallow
    // silhouette (upscaled ~2x on phones) kept its stair steps. HIGH searches 16: same three passes, more taps on edge pixels only
    // R6.95 QUALITY: SMAA ULTRA on every tier: edge threshold 0.1 -> 0.05 and a 32 px search, so the low-contrast silhouettes
    // (the stone's long rim, kelp, the card edges) lose their last stair steps. Same three passes, at the background's own
    // density (0.1-1 Mpx on phones and weak PCs); only edge pixels pay the longer search. ?aa=high = the R6.94 preset.
    this.rays = new DiveGodRaysPass(camera)
    const AA_Q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('aa') : null
    const smaa = new SMAAEffect({ preset: DENS_ONE && !AA_Q ? (PHONE ? SMAAPreset.MEDIUM : SMAAPreset.ULTRA /* R7.10: his PC at full res keeps 7.09's ULTRA (finer threshold catches the gem's inner facet steps; 1 Mpx, edge pixels only) */) : AA_Q === 'high' || (PHONE_SHARP && AA_Q !== 'ultra') ? SMAAPreset.HIGH : SMAAPreset.ULTRA })   /* R7.08b: at the phone's one density SMAA MEDIUM (8 search steps) is enough */   // R7.00: budget phones HIGH (16 search steps, was ULTRA 32 + corners): the cost moves into pixels, not edge searches
    const fxaa = new FXAAEffect()
    const renderScale = () => props.dpr / Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
    // sharpen (convolution) first, then the grade on its result: one pass instead of two when below native size
    // FOOTER MOCKUP: the footer's world and the in-frame curtain ride in the Grade pass (no extra full-screen pass)
    this.footer = FOOT_MODE ? new FooterWorldEffect(FOOT_MODE) : null
    const gradeOnly = this.footer ? new EffectPass(camera, this.grade, this.footer) : new EffectPass(camera, this.grade)
    heroPass.attachDepth(this.composer.inputBuffer) // R6.87: the scene pass's depth, for the heroes' occlusion
    const sharpGrade = new EffectPass(camera, new InlineSharpenEffect(), this.grade)
    const sharp = () => false && renderScale() < 0.99   // W18: CAS in the final upscale replaces the inline sharpen
    const bloomOn = () => settings.USE_BLOOM && props.look.bloom > 0.001
    const RAYS_M = !(typeof location !== 'undefined' && /[?&]raysep\b/.test(location.search))   // R7.10 b4: on (?raysep = 7.09's separate rays composite)
    const BD_LO = !(typeof location !== 'undefined' && /[?&]bdfull\b/.test(location.search))   // R7.10 b4: on (?bdfull = shaded at full density as in 7.09)
    const shown = (o: THREE.Object3D | null) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return !!o }
    const backdropLo = () => DENS_ONE && PHONE && BD_LO && props.dpr >= 0.99 && !!diveLo.blit && shown(diveLo.mesh) && camera.layers.isEnabled(DIVE_LAYER) && diveLo.split() < -0.5
    // R7.10 ONE PASS FEWER (phones + weak PC at the one density; first principles: each full-screen pass is a full write +
    // read of the frame on a tiled, low-bandwidth GPU): SMAA's blend joins the bloom + grade pass (SMAA first, then bloom and
    // the grade on its result) on every frame where nothing is drawn between them (no UI effects, no boundary composite)
    // and the lens waterline and the footer curtain are hidden (their mainUv, a UV transform, cannot share a pass with SMAA). Edge detection
    // and weights are unchanged. ?aasep = the 7.09 separate SMAA pass.
    // R7.10 FOOTER LOCK (Shifat 3:22 AM "Lock footer too. Never touch it."): from the moment the CTA wall enters
    // (journey.cta > 0) through the footer, the frame goes through riptide v2's own passes (no merge).
    // R7.10 FOOTER FIX (Shifat 2:33 AM "Broke footer", build 2): the footer test read the curtain's own uniform, which only
    // the footer effect's update() writes, and that update never ran once the merged pass (no footer in it) was chosen, so
    // the curtain stayed down for good. The test now reads the source (journey.lift, as update() does) and the footer's
    // state keeps ticking on merged frames (below), so the curtain, its bar and --kd behave exactly as in 7.08/7.09.
    const AA_SEP = typeof location !== 'undefined' && /[?&]aasep\b/.test(location.search)
    // R7.11 (seabed far-edge stairs on his M02s): the phone's MEDIUM preset finds edges above 0.1 luma, and the sand's far
    // crest against the deep water sits just under that (teal on teal), so the crest kept its 1-px stairs. Below the water
    // in the dive, the phone's AA uses a twin SMAA with ULTRA's 0.05 threshold (same 8-step search, same passes; only the
    // edge pixels it newly finds pay). A twin, not a switch: the threshold is a shader define, and flipping it would relink
    // the program at every waterline crossing. Hero, journey and footer keep the original. R7.11 b5: ON by default on the phone path; ?aadive=0 turns it off (= riptide v3)
    const AA_DIVE = DENS_ONE && PHONE && !AA_Q && typeof location !== 'undefined' && !/[?&]aadive=0\b/.test(location.search)   // b5 default on (phone); ?aadive=0 = riptide v3
    // R7.11 b4 QA (opt-in ?aaj=1): extends the same twin to the journey (phone only) while neither the CTA nor the footer is up (footer AA stays locked)
    const AA_J = DENS_ONE && PHONE && !AA_Q && typeof location !== 'undefined' && /[?&]aaj=1\b/.test(location.search)   // b5: stays opt-in (?aaj=1): +~13 ms AA at 85% (grass edges), fails the gate
    const smaaD = (AA_DIVE || AA_J) ? new SMAAEffect({ preset: SMAAPreset.MEDIUM }) : null
    if (smaaD) smaaD.edgeDetectionMaterial.edgeDetectionThreshold = 0.05
    // R7.11 b5 STONE LOCK: inside the heroes' drawn box (the gem, grown 40 px: past SMAA's ~18 px search reach plus a frame of the gem's motion, as the box is last frame's) the twin keeps v3's 0.1, so the
    // edges, weights and blend over the stone are v3's exactly; only the water and the seabed around it get the lower threshold
    const keepU = { value: new THREE.Vector4(0, 0, -1, -1) }
    if (smaaD) {
      const em = smaaD.edgeDetectionMaterial as any
      em.uniforms.u_keep = keepU
      em.fragmentShader = 'uniform vec4 u_keep;\n' + em.fragmentShader.replace('const vec2 threshold=vec2(EDGE_THRESHOLD);',
        'vec2 threshold=vec2((vUv.x>=u_keep.x&&vUv.y>=u_keep.y&&vUv.x<=u_keep.z&&vUv.y<=u_keep.w)?0.1:EDGE_THRESHOLD);')
      em.needsUpdate = true
    }
    const keepBox = () => {
      const h = heroPass as any, b = h.box, rt = h.rt
      if (!rt || !b || !b.on || !heroPass.active()) { keepU.value.set(0, 0, -1, -1); return }
      const gx = 40 / Math.max(1, this.gl.domElement.width), gy = 40 / Math.max(1, this.gl.domElement.height)
      keepU.value.set(b.x / rt.width - gx, b.y / rt.height - gy, (b.x + b.w) / rt.width + gx, (b.y + b.h) / rt.height + gy)
    }
    const diveAA = () => !!smaaD && (keepBox(), true) && ((AA_DIVE && props.stage === 'dive' && !props.aboveWater) || (AA_J && props.stage === 'journey' && !((journey.cta || 0) > 0) && !((journey.lift || 0) > 0)))
    const mergeAA = () => DENS_ONE && !AA_SEP && !((journey.cta || 0) > 0) && (!this.footer || !((journey.lift || 0) > 0)) && quality.aa === 'smaa' && !sharp() && (this.grade.u('u_waterline').value as number) < -0.5
      && !((clip.boundary && !clip.cut) || clip.capture >= 0) && !ufxUnder.children.some((c) => c.visible) && !ufxOver.children.some((c) => c.visible) && !heroPass.hasUi()
    this.entries = [
      // R7.10 SPLIT DENSITY: the dive's water volume at half density (?bdfull = the full density, as in 7.09)
      { name: 'BackdropLo', order: -3, pass: new BackdropLoPass(camera), needsRender: () => backdropLo() },
      { name: 'BackdropRestore', order: 0.5, pass: new BackdropRestorePass(), needsRender: () => backdropLo() },
      { name: 'HeroHide', order: -1, pass: new HeroHidePass(), needsRender: () => heroPass.active() },   // R6.87 SPLIT
      { name: 'Scene', order: 0, pass: this.scenePass, needsRender: () => true },
      { name: 'HeroDraw', order: 1, pass: new HeroDrawPass(scene, camera), needsRender: () => heroPass.active() },   // R6.87 SPLIT
      { name: 'DiveGodRays', order: 5, pass: this.rays, needsRender: () => diveRays.on },
      // R7.08c ONE FINAL PASS (first principles: on a tiled, low-bandwidth GPU every full-screen pass is a full write + read of
      // the frame): bloom's composite and the grade run in ONE EffectPass (the neighbour chain's own pairing), so a frame with
      // bloom pays one full-screen pass at the scene density instead of two. Same maths, one half-float round trip fewer.
      { name: 'Bloom+Grade', order: 30, pass: this.footer ? new EffectPass(camera, this.bloom, this.grade, this.footer) : new EffectPass(camera, this.bloom, this.grade), needsRender: () => !sharp() && bloomOn() && !mergeAA() },
      { name: 'Grade', order: 30, pass: gradeOnly, needsRender: () => !sharp() && !bloomOn() && !mergeAA() },
      { name: 'SMAA+Bloom+Grade', order: 30, pass: new EffectPass(camera, smaa, this.bloom, this.gradeNoUv), needsRender: () => bloomOn() && mergeAA() },   // R7.10
      { name: 'SMAA+Grade', order: 30, pass: new EffectPass(camera, smaa, this.gradeNoUv), needsRender: () => !bloomOn() && mergeAA() && !(diveRays.on && RAYS_M) && !diveAA() },   // R7.10
      ...(smaaD ? [{ name: 'SMAAd+Grade', order: 30, pass: new EffectPass(camera, smaaD, this.gradeNoUv), needsRender: () => !bloomOn() && mergeAA() && !(diveRays.on && RAYS_M) && diveAA() }] : []),   // R7.11
      // R7.10: with no bloom between them (phones), the dive's god-ray add joins too: one full-screen pass for AA + rays + grade
      { name: 'SMAA+Rays+Grade', order: 30, pass: new EffectPass(camera, smaa, this.rays.effect(), this.gradeNoUv), needsRender: () => !bloomOn() && mergeAA() && diveRays.on && RAYS_M && !diveAA() },
      ...(smaaD ? [{ name: 'SMAAd+Rays+Grade', order: 30, pass: new EffectPass(camera, smaaD, this.rays.effect(), this.gradeNoUv), needsRender: () => !bloomOn() && mergeAA() && diveRays.on && RAYS_M && diveAA() }] : []),   // R7.11
      { name: 'Sharpen+Grade', order: 30, pass: sharpGrade, needsRender: () => sharp() },
      { name: 'UiHide', order: 49, pass: new UiHidePass(false), needsRender: () => heroPass.hasUi() },   // R6.87 SPLIT
      { name: 'PreUfx', order: 50, pass: this.preUfx, needsRender: () => ufxUnder.children.some((c) => c.visible) },
      { name: 'UiShow', order: 51, pass: new UiHidePass(true), needsRender: () => heroPass.hasUi() },   // R6.87 SPLIT
      { name: 'ScreenPaintDistortion', order: 3100, pass: new EffectPass(camera, this.distortion), needsRender: () => props.look.paintAmount > 0 && !paintState.asleep && !(this.distortion.hr && paintState.empty) },
      { name: 'PostUfx', order: 100, pass: this.postUfx, needsRender: () => ufxOver.children.some((c) => c.visible) },
      { name: 'SMAA', order: 4000, pass: new EffectPass(camera, smaa), needsRender: () => quality.aa === 'smaa' && !mergeAA() && !diveAA() },
      ...(smaaD ? [{ name: 'SMAAd', order: 4000, pass: new EffectPass(camera, smaaD), needsRender: () => quality.aa === 'smaa' && !mergeAA() && diveAA() }] : []),   // R7.11
      { name: 'FXAA', order: 4000, pass: new EffectPass(camera, fxaa), needsRender: () => quality.aa === 'fxaa' },
      // W17 GLOBAL TEXT LAYER (Shifat 10:17Z + 11:46Z): all copy in one fixed slot, drawn ONCE over the composited frame
      // (so a boundary never doubles it or slides it with a card) and BEFORE the trail, so the trail still bends it
      // (W18, Shifat 14:01Z) the slot is no longer a pass in this chain: drawText() draws it after the final pass, at the
      // canvas's full density, through the same trail displacement
      { name: 'ClipComposite', order: 3000, pass: new EffectPass(camera, new ClipCompositeEffect()), needsRender: () => (clip.boundary && !clip.cut) || clip.capture >= 0 },
    ]
  }
  // the one full-density pass: the finished frame (in the composer's input buffer after its last swap) upscaled once
  private blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private blitMat = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null as THREE.Texture | null }, u_texel: { value: new THREE.Vector2(1, 1) }, u_sharp: { value: 0 }, u_up: { value: 0 },
      // R7.08 HI-RES TRAIL: the wake fringe at the canvas's full density (the same numbers the 7.07 trail pass added, now
      // after the upscale instead of before it), from the display field; u_trail = 0 while the trail sleeps
      u_trailField: this.distortion.u('u_screenPaintTexture'), u_rgbShift: this.distortion.u('u_rgbShift'),
      u_shade: this.distortion.u('u_shade'), u_colorMultiplier: this.distortion.u('u_colorMultiplier'),
      // R7.08b REST SUPERSAMPLING (Shifat 6:37/6:47 PM: phone 3D looks low res, edges pixelated; "best perceived resolution"
      // at no moving cost): history of the finished upscaled frame (the canvas itself, copied back), the scene's sub-pixel
      // jitter (scene-buffer uv) and the blend weight; read only by the BLIT_TAA program, which runs only on still frames
      u_hist: { value: null as THREE.Texture | null }, u_hs: { value: new THREE.Vector2(1, 1) }, u_jit: { value: new THREE.Vector2() }, u_alpha: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    // SHARP UPSCALE (Shifat 15:39Z + the sharp lane): when the scene is upscaled onto the canvas, a Catmull-Rom bicubic
    // in 5 bilinear taps (the same tap count as the old bilinear+CAS cross) instead of bilinear, clamped to the taps'
    // min/max so its negative lobe cannot ring, then contrast-adaptive sharpening (AMD CAS-style weight: strong on soft
    // detail, backing off at hard edges and in flat areas) with the strength following the upscale ratio. At 1:1 (the
    // rest refinement: native density) a mild 1-texel CAS only, to take back the softness SMAA leaves on texture.
    fragmentShader: `uniform sampler2D tMap; uniform vec2 u_texel; uniform float u_sharp; uniform float u_up; varying vec2 vUv;
uniform sampler2D u_trailField; uniform float u_rgbShift, u_shade, u_colorMultiplier;
uniform sampler2D u_hist; uniform vec2 u_hs, u_jit; uniform float u_alpha;
vec3 casW(vec3 mn, vec3 mx, float s){ vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0)); return -amp * mix(0.125, 0.2, s); }
void main(){
  vec3 e; float tmark = 1.0;   // R7.08: the trail pass marks the pixels it bent (alpha x0.997; read free from the centre tap)
  if (u_up > 0.5) {
    vec2 ts = 1.0 / u_texel;
#ifdef BLIT_TAA
    vec2 sp = (vUv + u_jit) * ts;   // this frame's scene was drawn shifted by the jitter: read it back in place
#else
    vec2 sp = vUv * ts;
#endif
    vec2 tc = floor(sp - 0.5) + 0.5; vec2 f = sp - tc;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2; vec2 t12 = (tc + w2 / w12) * u_texel, t0 = (tc - 1.0) * u_texel, t3 = (tc + 2.0) * u_texel;
    vec4 c4 = texture2D(tMap, t12); vec3 c = c4.rgb; tmark = c4.a;
    vec3 n = texture2D(tMap, vec2(t12.x, t0.y)).rgb, s = texture2D(tMap, vec2(t12.x, t3.y)).rgb;
    vec3 wv = texture2D(tMap, vec2(t0.x, t12.y)).rgb, ea = texture2D(tMap, vec2(t3.x, t12.y)).rgb;
    float kc = w12.x * w12.y, kn = w12.x * w0.y, ks = w12.x * w3.y, kw = w0.x * w12.y, ke = w3.x * w12.y;
    e = (c * kc + n * kn + s * ks + wv * kw + ea * ke) / (kc + kn + ks + kw + ke);
    vec3 mn = min(c, min(min(n, s), min(wv, ea))), mx = max(c, max(max(n, s), max(wv, ea)));
    e = clamp(e, mn, mx);
    if (u_sharp > 0.0) { vec3 w = casW(mn, mx, u_sharp) * 0.6; e = clamp((e + (n + s + wv + ea) * w) / (1.0 + 4.0 * w), mn, mx); }
#ifdef BLIT_TAA
    // history (the canvas as last drawn: display-encoded 8-bit) back to linear, clamped to this frame's 5-tap neighbourhood
    // so anything that moved or animated cannot ghost; edges keep both sides in range, so their sub-pixel average survives
    vec3 hs = texture2D(u_hist, vUv * u_hs).rgb;
    hs = mix(hs / 12.92, pow((hs + 0.055) / 1.055, vec3(2.4)), step(0.04045, hs));
    e = mix(clamp(hs, mn, mx), e, u_alpha);
#endif
  } else {
    vec4 e4 = texture2D(tMap, vUv); e = e4.rgb; tmark = e4.a;
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
  // R7.08c INVERSION (low-res dither): the 1/255 dither moved here from the grade, which ran at the scene's density (a 1.0
  // phone scene stretched 1.5x made each dither dot a soft blob, and SMAA saw it as texture); here it lands per canvas
  // pixel, right where the frame is quantised to 8 bits
  gl_FragColor.rgb += (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
#ifdef BLIT_TRAIL
  if (tmark < 0.999) {   // marked by the trail pass (alpha x0.997)
    // the 7.07 pass added this to the display-encoded (sRGB) average and clamped; gl_FragColor is display-encoded here
    vec4 data = texture2D(u_trailField, vUv);
    float weight = (data.z + data.w) * 0.5;
    if (weight > 0.001) {
      vec2 vel = (0.5 - data.xy - 0.001) * 2.0 * weight;
      gl_FragColor.rgb = clamp(gl_FragColor.rgb + sin(vec3(vel.x + vel.y) * 40.0 + vec3(0.0, 2.0, 4.0) * u_rgbShift)
        * smoothstep(0.4, -0.9, weight) * u_shade * max(abs(vel.x), abs(vel.y)) * u_colorMultiplier, 0.0, 1.0);
    }
  }
#endif
}`,
    depthTest: false, depthWrite: false, toneMapped: false,
  })
  /** R7.08: the same blit + the full-density wake fringe, used only on frames with a live trail (and the warm-up frames,
   *  so it compiles behind the preloader); every other frame runs the 7.07 blit program unchanged */
  private blitMatTrail = new THREE.ShaderMaterial({ uniforms: this.blitMat.uniforms, vertexShader: this.blitMat.vertexShader, fragmentShader: this.blitMat.fragmentShader, defines: { BLIT_TRAIL: '' }, depthTest: false, depthWrite: false, toneMapped: false })
  /** R7.08b: the rest-supersampling blit (phones, still frames only; see taaTick). Moving frames never use it. */
  private blitMatTaa = new THREE.ShaderMaterial({ uniforms: this.blitMat.uniforms, vertexShader: this.blitMat.vertexShader, fragmentShader: this.blitMat.fragmentShader, defines: { BLIT_TAA: '' }, depthTest: false, depthWrite: false, toneMapped: false })
  private taaTex: THREE.FramebufferTexture | null = null
  private taaWarm = false; private taaOn = false; private taaK = 0; private taaStill = 0; private taaKey = ''; private taaPrevOn = false
  private taaVp = new THREE.Vector4(); private taaJx = 0; private taaJy = 0
  private taaSaved = new THREE.Matrix4(); private taaSavedInv = new THREE.Matrix4()
  /** Halton(2,3), 8 points, centred: the sub-pixel offsets a still scene cycles through */
  private static HAL = [[0.5, 0.333], [0.25, 0.667], [0.75, 0.111], [0.125, 0.444], [0.625, 0.778], [0.375, 0.222], [0.875, 0.556], [0.0625, 0.889]].map(([x, y]) => [x - 0.5, y - 0.5])
  private blitWarm = false
  private blitMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat)
  private blitScene = (() => { const s = new THREE.Scene(); this.blitMesh.frustumCulled = false; s.add(this.blitMesh); return s })()
  private blit() {
    const gl = this.gl, prev = gl.getRenderTarget(), auto = gl.autoClear
    this.blitMat.uniforms.tMap.value = this.composer.inputBuffer.texture
    this.blitMat.uniforms.u_texel.value.set(1 / this.bw, 1 / this.bh)
    // sharpen only when the scene is upscaled onto the canvas (its DPR below the canvas's)
    // SHARP: bicubic + CAS when upscaled (strength by ratio); a mild CAS at 1:1 (rest: native density, SMAA). ?nocas: off
    const up = props.textDpr > props.dpr * 1.05
    this.blitMat.uniforms.u_up.value = up ? 1 : 0
    const trail = this.distortion.hr && !(window as any).__trailNoBlit && props.look.paintAmount > 0 && !paintState.asleep && !paintState.empty
    this.blitMesh.material = trail || (this.blitWarm && this.distortion.hr) ? this.blitMatTrail : this.taaOn && up ? this.blitMatTaa : this.blitMat
    const taa = this.blitMesh.material === this.blitMatTaa
    // R6.87 SPLIT: the background is meant to be soft under the sharp heroes; a strong CAS on a 2.5–4x upscale reads crunchy
    // R7.08c INVERSION (a stretched buffer with sharpening on top = haloed stair steps): phones at their one density get the
    // clamped Catmull-Rom upscale only, no CAS on top (the stretch is 1.5x now, not 3x; CAS ringed every edge it found)
    this.blitMat.uniforms.u_sharp.value = NOCAS || DENS_ONE ? 0 : up ? Math.min(SPLIT ? 0.4 : 1, (props.textDpr / props.dpr - 1) * 0.8) : 0.25
    gl.setRenderTarget(null); gl.autoClear = false
    if (taa) this.taaBind(gl)
    if (this.blitWarm && !this.taaWarm && TAA_MODE !== 0) {   // R7.08b: link the rest program behind the preloader too
      const m = this.blitMesh.material; this.blitMesh.material = this.blitMatTaa; gl.compile(this.blitScene, this.blitCam); this.blitMesh.material = m; this.taaWarm = true
    }
    gl.render(this.blitScene, this.blitCam)
    if (taa) { gl.copyFramebufferToTexture(this.taaTex!); this.taaK++ }   // before the heroes and the type: history holds the scene only
    else this.taaK = 0
    gl.autoClear = auto; gl.setRenderTarget(prev)
  }
  /** R7.08b: history texture (the canvas's own size, RGB like the canvas) and this frame's blend; a new size or render
   *  scale (sub-rectangle) restarts the history */
  private taaBind(gl: THREE.WebGLRenderer) {
    const el = gl.domElement; gl.getCurrentViewport(this.taaVp)
    const key = `${el.width}x${el.height}|${this.taaVp.z}x${this.taaVp.w}|${this.bw}x${this.bh}`
    if (!this.taaTex || this.taaTex.image.width !== el.width || this.taaTex.image.height !== el.height) {
      this.taaTex?.dispose()
      this.taaTex = new THREE.FramebufferTexture(el.width, el.height); this.taaTex.format = THREE.RGBFormat
      this.taaTex.minFilter = this.taaTex.magFilter = THREE.LinearFilter; this.taaK = 0
    }
    if (key !== this.taaKey) { this.taaKey = key; this.taaK = 0 }
    const u = this.blitMat.uniforms
    u.u_hist.value = this.taaTex
    u.u_hs.value.set(this.taaVp.z / el.width, this.taaVp.w / el.height)
    u.u_jit.value.set(this.taaJx / this.bw, this.taaJy / this.bh)
    u.u_alpha.value = Math.max(1 / (this.taaK + 1), TAA_FLOOR)
  }
  /** R7.08b: still = no scroll, no press, no live trail, no overlay, no scene-boundary composite, intro done; four still
   *  frames in a row arm it. Phones only (SPLIT, the upscaled background); ?taa=0 off, ?taa=1 on any device. */
  private taaTick() {
    const still = TAA_MODE !== 0 && ((SPLIT && quality.tier === 'low' && PHONE) || TAA_MODE === 1) && props.introDone && !props.overlayOpen && Math.abs(props.scrollVel) < 0.5
      && (paintState.asleep || paintState.empty || props.look.paintAmount <= 0) && !(clip.boundary && !clip.cut) && this.warmDone && !this.blitWarm && props.textDpr > props.dpr * 1.05
    this.taaStill = still ? this.taaStill + 1 : 0
    this.taaOn = this.taaStill >= 4
    if (!this.taaOn) { this.taaJx = this.taaJy = 0; this.taaK = 0; return }
    const h = PostChain.HAL[this.taaK % 8]; this.taaJx = h[0]; this.taaJy = h[1]
  }
  /** R7.08b: the scene and GL-text passes draw with the projection shifted by the jitter (clip-space translate, any camera) */
  private jitWrap(pass: Pass, cam: THREE.Camera) {
    const orig = pass.render.bind(pass)
    pass.render = ((...a: any[]) => {
      if (!this.taaOn) return (orig as any)(...a)
      const c = ((pass as any).camera as THREE.Camera) || cam, P = c.projectionMatrix, e = P.elements, dx = (2 * this.taaJx) / this.bw, dy = (2 * this.taaJy) / this.bh
      this.taaSaved.copy(P); this.taaSavedInv.copy(c.projectionMatrixInverse)
      e[0] += dx * e[3]; e[4] += dx * e[7]; e[8] += dx * e[11]; e[12] += dx * e[15]
      e[1] += dy * e[3]; e[5] += dy * e[7]; e[9] += dy * e[11]; e[13] += dy * e[15]
      c.projectionMatrixInverse.copy(P).invert()
      try { return (orig as any)(...a) } finally { P.copy(this.taaSaved); c.projectionMatrixInverse.copy(this.taaSavedInv) }
    }) as any
  }
  // W25 R6.46 (Shifat 2:22 AM PT Oct 21, LOCKED: "Only on above water surface, keep logo & sound line black. Then full white"):
  // the measured-frame header picker (R6.36-R6.44: readback, EMA, votes) is gone. The header ink is a fixed rule tied to the
  // scroll position, set in visuals.resolve (html[data-hdr]); see there.
  /** the chain's own buffer size (scene density), independent of the canvas (text density) */
  bw = 1; bh = 1
  setSize(w: number, h: number) {
    // NOT composer.setSize: that sizes every target from the canvas, which now runs at the text density (Scene.tsx
    // applyTextDpr). The scene, bloom, grade, trail and AA all keep the governor's DPR.
    const bw = Math.max(1, Math.round(w * props.dpr)), bh = Math.max(1, Math.round(h * props.dpr))
    this.bw = bw; this.bh = bh
    this.composer.inputBuffer.setSize(bw, bh); this.composer.outputBuffer.setSize(bw, bh)
    // R7.00 PHONE SHARP: the bloom keeps its absolute size when the phone's background refines (quarter-res post, like
    // lusion.co): 0.5 of a 0.5 background = 0.25 of the css size, so a 1.0 background blooms at 0.25
    // R7.10: the weak PC at the phone's one density keeps the phone's bloom size rule too (same glow size per css px as 7.09)
    if ((PHONE_SHARP || DENS_ONE) && !settings.BLOOM_HQ) (this.bloom as any).resolution.scale = Math.max(0.25, Math.min(0.5, 0.25 / Math.max(0.01, props.dpr)))
    // R7.10: and its bright-pass at 0.5 css density as in 7.09 (an exact 2x2 average of the 1.0 frame, not a full-res pass)
    if (DENS_ONE && settings.WEAK_GPU && !settings.BLOOM_HQ) (this.bloom as any).luminancePass.resolution.scale = Math.max(0.5, Math.min(1, 0.5 / Math.max(0.01, props.dpr)))
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
    if (stickerMask.on) { const v = d('u_stk').value as THREE.Vector4[]; for (let i = 0; i < 4; i++) v[i].fromArray(stickerMask.c, i * 4); (d('u_view').value as THREE.Vector2).set(props.width, props.height) }
    // W23: and so does the hero stone (HeroStage.tsx writes where it sits)
    { const W = window as any; const on = gemMask.on && !W.__gemSmear ? 1 : 0; (d('u_gem').value as THREE.Vector4).set(gemMask.x, gemMask.y, gemMask.r, on); if (on) (d('u_view').value as THREE.Vector2).set(props.width, props.height) }
  }
  render(dt: number) {
    if (this.gl.getContext().isContextLost()) return   // R6.92: nothing to draw into while the context is lost (the loss handler reloads or goes static)
    this.sync()
    let sig = 0  // PERF HOOK: a bitmask, not a string built every frame (no per-frame garbage)
    const warm = this.warmAll
    this.blitWarm = warm   // R7.08: the warm frame links the trail blit program too
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]
      e.on = warm ? !((e.name === 'Bloom+Grade' || e.name === 'SMAA+Bloom+Grade') && !settings.USE_BLOOM) && !(e.name === 'FXAA' && settings.TIER !== 'low') && !(e.name.startsWith('SMAA+') && !DENS_ONE) : e.needsRender()
      if (e.on) sig |= 1 << i
    }
    { this.rays.merged = !warm && this.entries.some((e) => (e.name === 'SMAA+Rays+Grade' || e.name === 'SMAAd+Rays+Grade') && !!e.on) }   // R7.10 (R7.11: or its dive twin)
    if (this.footer && !warm && this.entries.some((e) => e.on && (e.name.startsWith('SMAA+') || e.name.startsWith('SMAAd+')))) this.footer.update(this.gl, null as any, dt)   // R7.10 FOOTER FIX
    if (warm) {
      this.warmAll = false
      // NEIGHBOUR HOOK: link the neighbour chain's programs (bloom+grade pass, its targets) behind the curtain too
      try { this.renderNeighbour(props.look, 0.5, dt) } catch { /* warm-up only */ }
      heroPass.warm(this.gl, this.nbArgs[0], this.nbArgs[1], this.grade, this.distortion, this.footer ? this.footer.uniforms : null) // R6.87 SPLIT
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
    this.taaTick()   // R7.08b: still frames jitter the scene and accumulate in the blit
    this.composer.render(dt)
    this.text.prepare(this.gl) // R7.06 PERF: the type's own target first, so the canvas is bound once (blit, heroes, type)
    this.blit()
    heroPass.composite(this.gl, this.grade, this.distortion, this.footer ? this.footer.uniforms : null, this.ufxUnderRef, this.ufxCameraRef) // R6.87 SPLIT
    this.text.draw(this.gl)
    gpuTimer.end()
    void shared
  }
}
