import * as THREE from 'three'
import { BloomEffect, EffectComposer, EffectPass, KernelSize, Pass, RenderPass, SMAAEffect, SMAAPreset } from 'postprocessing'
import { GradeEffect, ScreenPaintDistortionEffect, SharpenEffect } from './effects'
import { DiveGodRaysPass } from './DiveGodRays'
import { ClipCompositeEffect } from './ClipComposite'
import { clip } from '../systems/clip'
import { diveRays } from '../stages/dive/diveState'
import { props, shared } from '../../state/props'
import { settings } from '../../services/settings'

/**
 * The render queue (handbook ch.3 / 8). Effects are data: { pass, renderOrder, enabled }.
 * Every frame the queue is filtered by needsRender and sorted by renderOrder; a disabled pass is
 * removed from the composer entirely, so "off" costs nothing. Ping-pong + last-pass-to-screen are
 * handled by the composer. Scene target is flat (no MSAA) because SMAA does the anti-aliasing.
 *
 *   0    Scene            (world stage, camera rig)
 *   10   Bloom            (HQ: mipmap pyramid, 8 levels; LQ: small Kawase kernel)
 *   30   Grade            (Final: grade, vignette, fade, dither, waterline band)
 *   50   PreUfx           (DOM-mirrored layer that bends with the cursor paint)
 *   75   ScreenPaintDistortion
 *   100  PostUfx          (crisp layer drawn over the distortion)
 *   500  SMAA
 *   2000 Sharpen         (only when the render scale is below native)
 *   3000 ClipComposite   (clipped-section boundary: live card over the outgoing block's captured frame)
 */
type Entry = { name: string; order: number; pass: Pass; needsRender: () => boolean; on?: boolean }

export class PostChain {
  composer: EffectComposer
  entries: Entry[] = []
  grade = new GradeEffect()
  distortion = new ScreenPaintDistortionEffect()
  bloom: BloomEffect
  private signature = ''
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
    const smaa = new SMAAEffect({ preset: settings.TIER === 'high' ? SMAAPreset.HIGH : SMAAPreset.MEDIUM })
    const renderScale = () => props.dpr / Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
    this.entries = [
      { name: 'Scene', order: 0, pass: this.scenePass, needsRender: () => true },
      { name: 'DiveGodRays', order: 5, pass: new DiveGodRaysPass(camera), needsRender: () => diveRays.on },
      { name: 'Bloom', order: 10, pass: new EffectPass(camera, this.bloom), needsRender: () => settings.USE_BLOOM && props.look.bloom > 0.001 },
      { name: 'Grade', order: 30, pass: new EffectPass(camera, this.grade), needsRender: () => true },
      { name: 'PreUfx', order: 50, pass: this.preUfx, needsRender: () => ufxUnder.children.some((c) => c.visible) },
      { name: 'ScreenPaintDistortion', order: 75, pass: new EffectPass(camera, this.distortion), needsRender: () => props.look.paintAmount > 0 },
      { name: 'PostUfx', order: 100, pass: this.postUfx, needsRender: () => ufxOver.children.some((c) => c.visible) },
      { name: 'SMAA', order: 500, pass: new EffectPass(camera, smaa), needsRender: () => true },
      { name: 'Sharpen', order: 2000, pass: new EffectPass(camera, new SharpenEffect()), needsRender: () => renderScale() < 0.99 },
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
    let sig = ''
    for (const e of this.entries) { e.on = e.needsRender(); sig += e.on ? '1' : '0' }
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
