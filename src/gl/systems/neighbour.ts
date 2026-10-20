import { useFrame, type RootState } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type * as THREE from 'three'
import { settings } from '../../services/settings'
import { quality } from '../quality'

/**
 * NEIGHBOUR — the outgoing section stays LIVE through a boundary (Shifat 10:51Z: "Preload before & after section of
 * current section. No need freezing them." + 10:52Z: "You can quality down before after sections though like dpr
 * reduction etc").
 *
 * Before: during a clipped-section boundary the block you scroll away from was its last live frame, frozen.
 * Now: that block is drawn again every frame (or every 2nd/3rd on phones, by the governor's level) from ITS OWN camera,
 * with ITS OWN look and stages, at a reduced render scale, into its own small composer; the composite shows that
 * live image instead of the frozen one. The pass runs in the opposite-direction context the clip already defines
 * (scrolling down the upper block is the still; scrolling up the card is), so every offset (card shift, lag, the
 * GL text's camera offset) is the one that block would have had if it were the live render.
 *
 * Side effects are fenced: stage ticks run with `nb.active` true; DOM writes (dive tool labels, Shade DS hit areas),
 * journey audio and React state are skipped there; shared state read between passes (props.stage, props.look, the
 * dive flags, the god-ray switch) is restored after the pass. The camera rig, the look damping, the UI tone and the
 * sliding mount window are never run in it.
 *
 * Quality: the scale ramps from 1.0 down to the level's scale over ~0.4 s when a block becomes the neighbour (no
 * sudden soft frame); a block that becomes the live render is drawn by the main chain at full quality at once.
 * QA: ?nonb turns it off (the frozen still returns), window.__nb is the live object (ms, renders, scale, block).
 */
type Tick = (state: RootState, dt: number) => void
type StageReg = { tick: Tick; root: () => THREE.Object3D | null | undefined }

/** which registered stages draw each block (index = clip block) */
const BLOCK_STAGES: string[][] = [['hero'], ['hero'], ['systems'], ['dive', 'hero'], ['journey'], ['hero']]

class Neighbour {
  enabled = settings.USE_GL && !(typeof location !== 'undefined' && /[?&]nonb/.test(location.search))
  /** true while the neighbour pass runs (stages fence their side effects on it) */
  active = false
  /** block drawn by the last neighbour pass, and the frame it was drawn on */
  block = -1
  drawnAt = -1
  /** render scale of the last pass (fraction of the main render size) */
  scale = 1
  /** the neighbour's latest image (the composite shows it while fresh) */
  texture: THREE.Texture | null = null
  /** QA / cost */
  ms = 0
  renders = 0
  stages = new Map<string, StageReg>()
  private rampFrom = 0
  private dtAcc = 0
  register(name: string, tick: Tick, root: () => THREE.Object3D | null | undefined) {
    this.stages.set(name, { tick, root }); this.forBlock.clear()
    return () => { if (this.stages.get(name)?.tick === tick) { this.stages.delete(name); this.forBlock.clear() } }
  }
  private forBlock = new Map<number, StageReg[]>()
  /** the registered (mounted) stages that draw `block` (cached; no per-frame arrays) */
  stagesFor(block: number) {
    let r = this.forBlock.get(block)
    if (!r) { r = (BLOCK_STAGES[block] || []).map((n) => this.stages.get(n)).filter(Boolean) as StageReg[]; this.forBlock.set(block, r) }
    return r
  }
  /** steady-state scale for this device and governor level */
  private targetScale() {
    const phone = settings.TIER === 'low'
    const base = phone ? 0.6 : settings.TIER === 'mid' ? 0.7 : 0.75
    return Math.max(0.4, base - quality.level * 0.05)
  }
  /** Shifat 11:47Z: "Never freeze animation for before & after scene." Every frame, everywhere; the cost is paid in
   *  render scale, not in frames. Only a phone already at the governor's floor draws it every 2nd frame (with the
   *  accumulated real dt, so its motion stays time-correct). */
  every() {
    return settings.TIER === 'low' && quality.level >= quality.maxLevel ? 2 : 1
  }
  /** called by the pass each frame of a boundary; returns [draw now?, dt to advance, scale] */
  plan(block: number, frame: number, dt: number): [boolean, number, number] {
    if (block !== this.block) { this.block = block; this.rampFrom = frame; this.dtAcc = 0; this.drawnAt = -1 }
    this.dtAcc += dt
    const first = this.drawnAt < 0
    const due = first || frame - this.drawnAt >= this.every()
    // ramp: 1.0 for the first frames, then down to the target over ~24 frames, in 3 steps (each step reallocates)
    const k = Math.min(1, Math.max(0, (frame - this.rampFrom - 4) / 24))
    const tgt = this.targetScale()
    const steps = [1, 1 - (1 - tgt) / 3, 1 - (2 * (1 - tgt)) / 3, tgt]
    const scale = steps[Math.min(3, Math.floor(k * 3.999))]
    if (!due) return [false, 0, scale]
    const d = Math.min(this.dtAcc, 0.1); this.dtAcc = 0
    return [true, d, scale]
  }
  /** a boundary ended (or the pass was skipped): the next one starts a fresh ramp */
  reset() { this.block = -1; this.drawnAt = -1 }
  /** the composite may use the neighbour image for `block` (drawn within the last few frames) */
  fresh(block: number, frame: number) { return this.enabled && block === this.block && this.drawnAt >= 0 && frame - this.drawnAt <= 4 }
}
export const nb = new Neighbour()
;(window as any).__nb = nb

/** A stage's frame callback, registered for the neighbour pass too (same function, run again in the neighbour context
 *  with that block's dt). Use exactly like useFrame(cb) at priority 0; `root` is the stage's top object (its visibility is
 *  put back after the neighbour pass so the main pass sees what it set). */
export function useStageFrame(name: string, cb: Tick, root: { current: THREE.Object3D | null }) {
  const ref = useRef(cb)
  ref.current = cb
  useFrame((s, dt) => ref.current(s, dt))
  useEffect(() => nb.register(name, (s, dt) => ref.current(s, dt), () => root.current), [name, root])
}
