import * as THREE from 'three'
/**
 * Layer 2 — the blackboard ("properties", handbook ch.11). One mutable bag every system reads and
 * writes inside the frame. No React re-renders: React state is only for UI (menu, overlay, sound).
 */
export type Look = {
  bg: THREE.Color; fogColor: THREE.Color
  exposure: number; saturation: number; contrast: number; brightness: number
  vignette: number; vignetteSoft: number; fade: number; tint: THREE.Color
  /** lifts near-white, near-neutral pixels toward paper white (the airy north-star field) without touching colour */
  lift: number
  bloom: number; bloomThreshold: number
  paintAmount: number; paintRGBShift: number; paintOffsetRatio: number; paintColorMultiplier: number; paintMultiplier: number
  dive: number
}
export const makeLook = (o: Partial<Record<keyof Look, any>> = {}): Look => ({
  bg: new THREE.Color('#e7e8ea'), fogColor: new THREE.Color('#e7e8ea'),
  exposure: 1, saturation: 1, contrast: 1.04, brightness: 0, vignette: 0.18, vignetteSoft: 0.75, fade: 0, lift: 0,
  tint: new THREE.Color('#ffffff'), bloom: 0.25, bloomThreshold: 0.92,
  paintAmount: 3, paintRGBShift: 0.5, paintOffsetRatio: 1, paintColorMultiplier: 10, paintMultiplier: 5,
  dive: 0,
  ...o,
})

export const props = {
  time: 0, dt: 1 / 60, frame: 0,
  width: window.innerWidth, height: window.innerHeight, dpr: 1,
  renderW: 1, renderH: 1,
  /** Shifat 14:01Z: the canvas runs at the device's own density (cap 3) for the text layer; the 3D scene and the post
   *  chain render at `dpr` (the governor's 0.75–1.25 ladder) and are upscaled once in the final pass */
  textDpr: 1,
  /** R6.89: the hero pass's density (post/heroPass.ts): phones 1.0, desktop native; never above textDpr */
  heroDpr: 1,
  useMobileLayout: window.innerWidth <= 812,
  // scroll (Lenis is the source)
  paintDpr: 1,
  scroll: 0, scrollVel: 0, scrollDelta: 0, scrollStrength: 0, scrollLimit: 1, scrollProgress: 0,
  // the look the post chain reads this frame, blended from section looks
  look: makeLook(),
  // stage weights (Visuals switcher): which stage owns the camera
  stage: 'hero' as string,
  /** R7.00: the camera is in the hero/statement/dive above the water (visuals.ts) — the phone keeps its light density there */
  aboveWater: true,
  /** R7.00: a stage whose picture comes from its own fixed target (the journey's 512 world) caps the phone's sharp
   *  background near that target's density (0 = no cap): more background pixels there would only magnify it */
  bgCeil: 0,
  // section-local progress values written by DOM sections, read by GL stages
  heroPin: 0, statement: 0, lab: 0, labVel: 0, systems: 0, dive: 0, journey: 0, resurface: 0, overscroll: 0,
  introDrop: 0, introDone: false,
  // pointer projected on the water plane
  waterPointer: new THREE.Vector2(0.5, 0.5), waterPointerActive: false,
  drops: [] as { x: number; y: number; r: number; s: number }[],
  overlayOpen: false,
  /** R6.83 GIFT: the gift dialog holds the main scene's frame loop (its frozen, blurred frame covers the page) */
  sceneHold: false,
}
;(window as any).__props = props

/** Shared uniforms: one object instance per uniform, passed by reference into every material (ch.8.6 / ch.14 S.8). */
export const shared = {
  u_time: { value: 0 },
  u_dt: { value: 1 / 60 },
  u_resolution: { value: new THREE.Vector2(1, 1) },
  u_blueNoise: { value: null as THREE.Texture | null },
  u_blueNoiseOffset: { value: new THREE.Vector2() },
  u_blueNoiseSize: { value: new THREE.Vector2(64, 64) },
  u_currPaintTexture: { value: null as THREE.Texture | null },
  u_paintTextureSize: { value: new THREE.Vector2(1, 1) },
  u_rippleTexture: { value: null as THREE.Texture | null },
  u_rippleTexel: { value: new THREE.Vector2(1 / 256, 1 / 256) },
}
