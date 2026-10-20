import * as THREE from 'three'
import { props, makeLook, type Look } from '../../state/props'
import { damp } from '../../core/math'
import { dive } from '../stages/dive/diveState'

/**
 * Visuals — the stage switcher (ch.7.1). Each stage registers a camera pose + a look; every frame the
 * DOM sections set weights from their scroll ratios, the heaviest active stage owns the camera, and the
 * looks are blended into props.look which the post chain reads.
 */
export type Pose = { pos: THREE.Vector3; target: THREE.Vector3; fov: number }
export type StageDef = { name: string; pose: () => Pose; look: Look; weight: number }

class Visuals {
  stages = new Map<string, StageDef>()
  register(name: string, pose: () => Pose, look: Partial<Record<keyof Look, any>>) {
    const s = { name, pose, look: makeLook(look), weight: 0 }
    this.stages.set(name, s); return s
  }
  setWeight(name: string, w: number) { const s = this.stages.get(name); if (s) s.weight = w }
  /** blend poses + looks by weight */
  resolve(out: Pose, dt: number) {
    let total = 0, best = '', bw = -1
    for (const s of this.stages.values()) { total += s.weight; if (s.weight > bw) { bw = s.weight; best = s.name } }
    props.stage = best
    if (total <= 0) return out
    const pos = new THREE.Vector3(), tgt = new THREE.Vector3(); let fov = 0
    const L = props.look, acc = makeLook({ bg: new THREE.Color(0, 0, 0), fogColor: new THREE.Color(0, 0, 0), tint: new THREE.Color(0, 0, 0) })
    const keys = Object.keys(acc) as (keyof Look)[]
    keys.forEach((k) => { if (typeof (acc as any)[k] === 'number') (acc as any)[k] = 0 })
    // poses blend only between neighbouring stages; a far-away stage (the journey) is a cut
    const bestPose = this.stages.get(best)!.pose()
    let pw = 0
    for (const s of this.stages.values()) {
      if (s.weight <= 0) continue
      const p = s.pose()
      if (p.pos.distanceTo(bestPose.pos) > 30) continue
      pw += s.weight
    }
    for (const s of this.stages.values()) {
      if (s.weight <= 0) continue
      const w = s.weight / total, p = s.pose()
      if (p.pos.distanceTo(bestPose.pos) <= 30) {
        const wp = s.weight / pw
        pos.addScaledVector(p.pos, wp); tgt.addScaledVector(p.target, wp); fov += p.fov * wp
      }
      for (const k of keys) {
        const v = (s.look as any)[k]
        if (typeof v === 'number') (acc as any)[k] += v * w
        else if (v instanceof THREE.Color) (acc as any)[k].r += v.r * w, (acc as any)[k].g += v.g * w, (acc as any)[k].b += v.b * w
      }
    }
    out.pos.copy(pos); out.target.copy(tgt); out.fov = fov
    // looks ease toward the blend (no hard cuts between sections)
    const lam = 7
    for (const k of keys) {
      const v = (acc as any)[k]
      if (typeof v === 'number') (L as any)[k] = damp((L as any)[k], v, lam, dt)
      else if (v instanceof THREE.Color) (L as any)[k].lerp(v, 1 - Math.exp(-lam * dt))
    }
    // UI tone follows the field every frame (black UI on light water, white UI in the deep / in space)
    const dark = props.stage === 'dive' ? dive.under : L.dive > 0.5
    const want = dark ? 'dark' : 'light'
    if (document.documentElement.dataset.bg !== want) document.documentElement.dataset.bg = want
    return out
  }
}
export const visuals = new Visuals()
;(window as any).__visuals = visuals
