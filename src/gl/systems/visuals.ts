import * as THREE from 'three'
import { props, makeLook, type Look } from '../../state/props'
import { damp } from '../../core/math'
import { dive } from '../stages/dive/diveState'
import { clip, BLOCKS } from './clip'

/**
 * Visuals — the stage switcher (ch.7.1). Each stage registers a camera pose + a look; every frame the
 * DOM sections set weights from their scroll ratios, the heaviest active stage owns the camera, and the
 * looks are blended into props.look which the post chain reads.
 */
export type Pose = { pos: THREE.Vector3; target: THREE.Vector3; fov: number }
export type StageDef = { name: string; pose: () => Pose; look: Look; weight: number; ew?: number }

const _pos = new THREE.Vector3(), _tgt = new THREE.Vector3() // PERF HOOK
class Visuals {
  private upLit = false
  stages = new Map<string, StageDef>()
  private ownerKey = -1
  private tones: Record<number, string> = {}
  private acc?: Look; private keys?: (keyof Look)[] // PERF HOOK
  register(name: string, pose: () => Pose, look: Partial<Record<keyof Look, any>>) {
    const s = { name, pose, look: makeLook(look), weight: 0 }
    this.stages.set(name, s); return s
  }
  setWeight(name: string, w: number) { const s = this.stages.get(name); if (s) s.weight = w }
  private nbPos = new THREE.Vector3(); private nbTgt = new THREE.Vector3()
  /** NEIGHBOUR HOOK: the pose + look of the block clip.allowed() names right now (the neighbour pass calls it inside
   *  clip.flip()), with no side effects: no props.stage, no damping, no owner key, no UI tone. Returns the heaviest stage. */
  resolvePure(out: Pose, look: Look): string {
    let total = 0, best = '', bw = -1
    const W = this.nbW
    W.clear()
    for (const s of this.stages.values()) { const w = clip.allowed(s.name) ? s.weight : 0; W.set(s.name, w); total += w }
    if (clip.enabled && total <= 1e-6) { const lead = BLOCKS[clip.owner][0]; if (this.stages.has(lead)) { W.set(lead, 1); total = 1 } }
    for (const [n, w] of W) if (w > bw) { bw = w; best = n }
    if (total <= 0 || !best) return best
    const keys = this.keys ??= Object.keys(look) as (keyof Look)[]
    for (const k of keys) { const v = (look as any)[k]; if (typeof v === 'number') (look as any)[k] = 0; else if (v instanceof THREE.Color) v.setRGB(0, 0, 0) }
    const bestPose = this.stages.get(best)!.pose()
    const bpx = bestPose.pos.x, bpy = bestPose.pos.y, bpz = bestPose.pos.z
    let pw = 0
    for (const s of this.stages.values()) {
      const w = W.get(s.name)!; if (w <= 0) continue
      const p = s.pose(); if (Math.hypot(p.pos.x - bpx, p.pos.y - bpy, p.pos.z - bpz) <= 30) pw += w
    }
    const pos = this.nbPos.set(0, 0, 0), tgt = this.nbTgt.set(0, 0, 0); let fov = 0
    for (const s of this.stages.values()) {
      const ew = W.get(s.name)!; if (ew <= 0) continue
      const w = ew / total, p = s.pose()
      if (Math.hypot(p.pos.x - bpx, p.pos.y - bpy, p.pos.z - bpz) <= 30) { const wp = ew / pw; pos.addScaledVector(p.pos, wp); tgt.addScaledVector(p.target, wp); fov += p.fov * wp }
      for (const k of keys) {
        const v = (s.look as any)[k]
        if (typeof v === 'number') (look as any)[k] += v * w
        else if (v instanceof THREE.Color) (look as any)[k].r += v.r * w, (look as any)[k].g += v.g * w, (look as any)[k].b += v.b * w
      }
    }
    out.pos.copy(pos); out.target.copy(tgt); out.fov = fov
    return best
  }
  private nbW = new Map<string, number>()
  /** blend poses + looks by weight */
  resolve(out: Pose, dt: number) {
    // clipped sections: only the owning block's stages count; a block entering from the bottom owns the
    // live render from its first pixel (its first stage stands in at full weight until its own ramps up)
    let total = 0, best = '', bw = -1
    for (const s of this.stages.values()) s.ew = clip.allowed(s.name) ? s.weight : 0
    for (const s of this.stages.values()) total += s.ew!
    if (clip.enabled && total <= 1e-6) {
      const lead = this.stages.get(BLOCKS[clip.owner][0])
      if (lead) { lead.ew = 1; total = 1 }
    }
    for (const s of this.stages.values()) if (s.ew! > bw) { bw = s.ew!; best = s.name }
    props.stage = best
    if (total <= 0) return out
    // PERF HOOK: scratch accumulators (this ran 2 Vector3 + a Look + 3 Colors + a keys array per frame)
    const pos = _pos.set(0, 0, 0), tgt = _tgt.set(0, 0, 0); let fov = 0
    const L = props.look, acc = this.acc ??= makeLook({ bg: new THREE.Color(0, 0, 0), fogColor: new THREE.Color(0, 0, 0), tint: new THREE.Color(0, 0, 0) })
    const keys = this.keys ??= Object.keys(acc) as (keyof Look)[]
    for (const k of keys) { const v = (acc as any)[k]; if (typeof v === 'number') (acc as any)[k] = 0; else if (v instanceof THREE.Color) v.setRGB(0, 0, 0) }
    // poses blend only between neighbouring stages; a far-away stage (the journey) is a cut
    const bestPose = this.stages.get(best)!.pose()
    let pw = 0
    for (const s of this.stages.values()) {
      if (s.ew! <= 0) continue
      const p = s.pose()
      if (p.pos.distanceTo(bestPose.pos) > 30) continue
      pw += s.ew!
    }
    for (const s of this.stages.values()) {
      if (s.ew! <= 0) continue
      const w = s.ew! / total, p = s.pose()
      if (p.pos.distanceTo(bestPose.pos) <= 30) {
        const wp = s.ew! / pw
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
    // a new block owner snaps (its first frames are only a sliver at the bottom of the card)
    const lam = 7, snap = clip.enabled && clip.ownerKey !== this.ownerKey
    this.ownerKey = clip.ownerKey
    for (const k of keys) {
      const v = (acc as any)[k]
      if (typeof v === 'number') (L as any)[k] = snap ? v : damp((L as any)[k], v, lam, dt)
      else if (v instanceof THREE.Color) (L as any)[k].lerp(v, snap ? 1 : 1 - Math.exp(-lam * dt))
    }
    // UI tone follows the field every frame (black UI on light water, white UI in the deep / in space)
    // W23 (scorer-r618/r621 #4): under water, while the lens looks up at the lit surface (Shifat's +40° godray look-up) the
    // header row sits on bright cyan, where the white UI vanished; the UI goes to ink there. Hysteresis 14°/20° so it
    // never flickers; the slot is empty in this stretch (TEXT GAP rule), so only the header follows it.
    const hz = Math.hypot(out.target.x - out.pos.x, out.target.z - out.pos.z), up = (out.target.y - out.pos.y) / Math.max(1e-3, hz)
    this.upLit = this.upLit ? up > Math.tan((14 * Math.PI) / 180) : up > Math.tan((20 * Math.PI) / 180)
    const dark = props.stage === 'dive' ? dive.under && !this.upLit : L.dive > 0.5
    let want = dark ? 'dark' : 'light'
    // during a boundary the header still sits over the outgoing block until the card reaches it
    this.tones[clip.owner] = want
    if (clip.boundary) { const under = clip.yTop > 64 ? clip.lower - 1 : clip.lower; if (this.tones[under]) want = this.tones[under] }
    if (document.documentElement.dataset.bg !== want) document.documentElement.dataset.bg = want
    return out
  }
}
export const visuals = new Visuals()
;(window as any).__visuals = visuals
