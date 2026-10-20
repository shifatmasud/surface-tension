import * as THREE from 'three'

/**
 * The cursor trail's public face — what a stage may read or listen to without touching the trail itself.
 *
 *   trailField.uniforms.u_trailDye / u_trailVelocity   pass these BY REFERENCE into any material; they always
 *                                                     point at this frame's textures (screen uv, y up)
 *     dye       R = ink density (long tail)  G = bright head  B = speed-colour × density  A = burst ring
 *     velocity  RG = fluid velocity in sim texels / s (square texels: multiply by u_trailSimTexel for uv / s)
 *   trailField.uniforms.u_trailSimTexel / u_trailDyeTexel
 *   trailField.getTrailField()            the same handles as a plain object (for CPU-side code)
 *   trailField.onPointerImpulse(fn)       every stroke / flick / click-burst the pointer makes, in screen uv
 *                                         (y up), with speed in CSS px / s — return value unsubscribes
 *
 * Coordinates: x, y in 0..1 screen uv (y up). Radius is in viewport heights. vx, vy are viewport heights / s.
 */
export type TrailImpulseKind = 'stroke' | 'flick' | 'burst'
export type TrailImpulse = {
  kind: TrailImpulseKind
  x: number; y: number
  vx: number; vy: number
  /** pointer speed in CSS px / s (smoothed) */
  speed: number
  /** brush radius in viewport heights */
  radius: number
  /** 0..1 how hard (speed-mapped for strokes, peak speed for flicks, 1 for a click) */
  strength: number
  /** the stage that owned the camera when it happened */
  stage: string
}
type Listener = (e: TrailImpulse) => void

const listeners = new Set<Listener>()

export const trailField = {
  uniforms: {
    u_trailDye: { value: null as THREE.Texture | null },
    u_trailVelocity: { value: null as THREE.Texture | null },
    u_trailSimTexel: { value: new THREE.Vector2(1 / 128, 1 / 128) },
    u_trailDyeTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
  },
  /** 0..1 how much the trail is showing right now (cheap CPU estimate: recent ink still settling) */
  activity: 0,
  getTrailField() {
    const u = this.uniforms
    return { dye: u.u_trailDye.value, velocity: u.u_trailVelocity.value, simTexel: u.u_trailSimTexel.value, dyeTexel: u.u_trailDyeTexel.value, activity: this.activity }
  },
  onPointerImpulse(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn) } },
  /** @internal the trail calls this */
  emit(e: TrailImpulse) { listeners.forEach((f) => { try { f(e) } catch (err) { console.warn('[trail] listener', err) } }) },
}
export const getTrailField = () => trailField.getTrailField()
export const onPointerImpulse = (fn: Listener) => trailField.onPointerImpulse(fn)
;(window as any).__trailField = trailField
