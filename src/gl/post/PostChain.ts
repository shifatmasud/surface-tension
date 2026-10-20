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
import { InlineSharpenEffect } from './perfEffects' // PERF HOOK

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
  scenePass: RenderPass
  preUfx: RenderPass
  postUfx: RenderPass

  constructor(public gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, ufxUnder: THREE.Scene, ufxOver: THREE.Scene, ufxCamera: THREE.Camera) {
    this.composer = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 0 })
    this.scenePass = new RenderPass(scene, camera)
    this.bloom = settings.BLOOM_HQ
      ? new BloomEffect({ mipmapBlur: true, levels: 8, radius: 0.72, intensity: 0.4, luminanceThreshold: 0.9, luminanceSmoothing: 0.08 })
      : new BloomEffect({ mipmapBlur: false, kernelSize: KernelSize.SMALL, intensity: 0.35, luminanceThreshold: 0.9, luminanceSmoothing: 0.1, resolutionScale: 0.5 })
    this.preUfx = new RenderPass(ufxUnder, ufxCamera); this.preUfx.clear = false; this.preUfx.ignoreBackground = true
    this.postUfx = new RenderPass(ufxOver, ufxCamera); this.postUfx.clear = false; this.postUfx.ignoreBackground = true
    const smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM })
    const fxaa = new FXAAEffect()
    const renderScale = () => props.dpr / Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
    // sharpen (convolution) first, then the grade on its result: one pass instead of two when below native size
    const gradeOnly = new EffectPass(camera, this.grade)
    const sharpGrade = new EffectPass(camera, new InlineSharpenEffect(), this.grade)
    const sharp = () => renderScale() < 0.99
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
      { name: 'ClipComposite', order: 3000, pass: new EffectPass(camera, new ClipCompositeEffect()), needsRender: () => clip.boundary || clip.capture >= 0 },
    ]
  }
  setSize(w: number, h: number) {
    this.composer.setSize(w, h, false)
    const pw = Math.max(1, (w * props.dpr) >> 2), ph = Math.max(1, (h * props.dpr) >> 2)
    this.distortion.u('u_screenPaintTexelSize').value.set(1 / pw, 1 / ph)
    this.grade.u('u_aspect').value = w / h
  }
  /** Copy the blended section look into the passes (ch.7.1: visuals → post stack). */
  sync() {
    const L = props.look
    const g = (n: string) => this.grade.u(n)
    g('u_exposure').value = L.exposure; g('u_saturation').value = L.saturation; g('u_contrast').value = L.contrast
    g('u_brightness').value = L.brightness; g('u_vignette').value = L.vignette; g('u_vignetteSoft').value = L.vignetteSoft
    g('u_fade').value = L.fade; g('u_lift').value = L.lift; ;(g('u_tint').value as THREE.Color).copy(L.tint); ;(g('u_fadeColor').value as THREE.Color).copy(L.bg)
    this.bloom.intensity = L.bloom
    this.bloom.luminanceMaterial.threshold = L.bloomThreshold
    const d = (n: string) => this.distortion.u(n)
    d('u_amount').value = L.paintAmount; d('u_rgbShift').value = L.paintRGBShift
    d('u_multiplier').value = L.paintMultiplier; d('u_colorMultiplier').value = L.paintColorMultiplier
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
    if (warm) this.warmAll = false
    if (sig !== this.signature) {
      this.signature = sig
      this.composer.removeAllPasses()
      this.entries.filter((e) => e.on).sort((a, b) => a.order - b.order).forEach((e) => this.composer.addPass(e.pass))
      ;(window as any).__chain = this.entries.filter((e) => e.on).map((e) => `${e.order}:${e.name}`)
    }
    this.composer.render(dt)
    void shared
  }
}
