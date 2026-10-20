import { settings, browser, MAX_RENDER_PIXELS } from '../services/settings'

/**
 * PERF HOOK — the adaptive quality governor (Shifat 10:16Z "heavily optimized for fast speed in mobile",
 * 10:21Z rules + his r3f-3d-optimization skill).
 *
 * Rules it keeps: the SAME objects on every tier and every level (nothing is dropped); only the cost of drawing
 * them moves: device-pixel ratio, render-target scales, shader sample counts, and (last resort on phones) SMAA → FXAA.
 *
 * How it decides: every frame the clock hands it the real frame delta. Over a ~1 s window it takes the median and the
 * 90th percentile. Too slow for the window (median over budget, or p90 far over) → one step DOWN the ladder.
 * Then, after a calm spell at full rate, it probes one step UP; if that probe drops frames it goes back down and
 * waits longer before probing again (back-off doubles, so it settles instead of see-sawing).
 * 60 Hz vsync hides headroom (a frame that took 6 ms and one that took 15 ms both read 16.7 ms), which is why
 * the way up is a probe and not a measurement.
 *
 * Levels: 0 = the tier's full quality (today's look), higher = cheaper. Each level is a DPR step; render targets
 * and sample counts follow `quality.rt()` / `quality.taps()`. Stages subscribe with `quality.on(fn)`.
 * New stages (v3 cube, HUD) plug in the same way: read `quality.rt(base)` for their target scales and
 * `quality.taps(n)` for loop counts, and re-size in a `quality.on` callback.
 *
 * QA: ?q=0..N pins a level (no governor), ?nogov disables the governor, window.__quality is the live object.
 */
export type QualityState = { level: number; dpr: number; aa: 'smaa' | 'fxaa' }
type Listener = (q: QualityState) => void

const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
const tier = settings.TIER

/** DPR ladders by tier (his skill: phones live inside 0.75–1.25). Level 0 = today's cap, so nothing changes on a
 *  device that already holds 60. Entries above the device's own DPR or the total-pixel cap are clipped at runtime. */
const LADDER: Record<string, number[]> = {
  high: [1.5, 1.3, 1.15, 1.0, 0.85],
  // Shifat 15:39Z sharper 3D: phones start higher and floor at ~1.0 where the frame budget allows (the governor
  // still steps down a phone that cannot hold 60)
  mid: [1.5, 1.3, 1.15, 1.0, 0.85],
  low: [1.3, 1.15, 1.0, 0.9, 0.8],
  none: [1],
}
/** render-target scale per level (multiplies a stage's own base scale) and loop-count scale */
const RT = [1, 0.9, 0.8, 0.7, 0.6]
const TAPS = [1, 0.85, 0.75, 0.62, 0.5]

const BUDGET_MS = 1000 / 60          // the target is 60; a low-end phone that cannot hold it settles at the floor (≈30 fps, steady)
const WINDOW = 50                    // frames per decision (~0.8 s at 60)
const STEP_COOLDOWN_MS = 1500        // a DPR step re-allocates targets: ignore the frames right after it
const PROBE_CALM_MS = 4000           // full-rate time before probing a step up
const MAX_BACKOFF_MS = 60000

class Quality {
  readonly tier = tier
  readonly ladder = LADDER[tier] ?? [1]
  level = 0
  aa: 'smaa' | 'fxaa' = 'smaa'
  pinned = q.has('q')
  enabled = settings.USE_GL && !q.has('nogov') && !q.has('q')
  /** when false, frames are not judged (intro, hidden tab, a scroll jump, a step's re-allocation) */
  judging = false
  private listeners = new Set<Listener>()
  private buf = new Float32Array(WINDOW)
  private n = 0
  private lastStep = 0
  private calmSince = 0
  private backoff = PROBE_CALM_MS
  private probing = -1               // level we probed up from (-1 = not probing)
  private stallRun = 0
  private winStart = 0
  private sorted = new Float32Array(WINDOW)
  stats = { median: 0, p90: 0, steps: 0, probes: 0, failedProbes: 0 }

  constructor() {
    if (this.pinned) this.level = Math.max(0, Math.min(this.ladder.length - 1, parseInt(q.get('q') || '0', 10) || 0))
    this.aa = this.aaFor(this.level)
  }
  get maxLevel() { return this.ladder.length - 1 }
  /** DPR for a window size: the level's step, clipped by the device DPR and the total-pixel cap, floored at 0.6 */
  dprFor(w: number, h: number, noRest = false) {
    const byPixels = Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, w * h))
    // REST REFINEMENT (Shifat 15:39Z): at rest, with headroom (level 0), one step toward native (×1.35, ≤ 2)
    const r = this.rest && !noRest
    const step = this.ladder[this.level] * (r ? 1.35 : 1)
    return Math.max(0.6, Math.min(browser.dpr, r ? 2 : 9, step, byPixels * (r ? 1.2 : 1)))
  }
  /** at rest (no scroll, no pointer for ~300 ms) the canvas refines one step; any motion drops it back. Only at level 0
   *  on mid/high tiers and when the governor runs. */
  rest = false
  private still = 0
  restTick(moving: boolean, now: number) {
    const can = this.enabled && this.judging && this.level === 0 && tier !== 'low' && this.probing < 0
    if (moving || !can) { this.still = now; if (this.rest) this.setRest(false, now); return }
    if (!this.rest && now - this.still > 300) this.setRest(true, now)
  }
  private setRest(v: boolean, now: number) {
    this.rest = v; this.lastStep = now; this.n = 0
    const s = this.state(); this.listeners.forEach((fn) => fn(s))
  }
  /** a stage's render-target scale at the current level (base = the stage's own tier scale) */
  rt(base: number) { return base * RT[Math.min(this.level, RT.length - 1)] }
  /** a loop/sample count at the current level, never below `min` */
  taps(base: number, min = 1) { return Math.max(min, Math.round(base * TAPS[Math.min(this.level, TAPS.length - 1)])) }
  state(): QualityState { return { level: this.level, dpr: this.ladder[this.level], aa: this.aa } }
  on(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  /** phones only, and only at the very bottom of the ladder: SMAA (3 passes) → FXAA (1 pass) */
  private aaFor(level: number): 'smaa' | 'fxaa' { return tier === 'low' && level >= this.maxLevel && !q.has('smaa') ? 'fxaa' : 'smaa' }
  set(level: number, now = performance.now()) {
    level = Math.max(0, Math.min(this.maxLevel, level))
    if (level === this.level) return
    this.level = level
    this.aa = this.aaFor(level)
    this.lastStep = now; this.n = 0; this.calmSince = now
    this.stats.steps++
    const s = this.state()
    this.listeners.forEach((fn) => fn(s))
  }
  /** called once per frame by the clock with the raw frame delta (ms) */
  frame(deltaMs: number, now: number) {
    if (!this.enabled || !this.judging) { this.n = 0; this.calmSince = now; return }
    if (now - this.lastStep < STEP_COOLDOWN_MS) return
    // an isolated stall (tab switch, a big decode) is not a rendering verdict; a run of them is a device that is simply
    // that slow, and those frames count (clamped) so it still steps down
    if (deltaMs > 250) { if (++this.stallRun < 4) return; deltaMs = 250 } else this.stallRun = 0
    if (this.n === 0) this.winStart = now
    this.buf[this.n++] = deltaMs
    // a window is 50 frames, or 1 s once it holds 12 (so a 15-fps phone gets a verdict every second, not every 3)
    if (this.n < WINDOW && !(this.n >= 12 && now - this.winStart >= 1000)) return
    const n = this.n; this.n = 0
    const s = this.sorted.subarray(0, n); s.set(this.buf.subarray(0, n)); s.sort()
    const med = s[n >> 1], p90 = s[Math.floor(n * 0.9)]
    this.stats.median = med; this.stats.p90 = p90
    const slow = med > BUDGET_MS * 1.18 || p90 > BUDGET_MS * 1.9   // < ~51 fps median, or 10 % of frames dropping 2+
    if (slow) {
      if (this.probing >= 0) {                                  // the probe failed: back down, wait longer next time
        this.stats.failedProbes++
        this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2)
        const back = this.probing; this.probing = -1
        this.set(back, now)
      } else if (this.level < this.maxLevel) this.set(this.level + 1, now)
      this.calmSince = now
      return
    }
    // full rate this window
    if (this.probing >= 0) { this.probing = -1; this.backoff = PROBE_CALM_MS }   // the probe held: stay
    if (this.level > 0 && now - this.calmSince > this.backoff) {
      this.stats.probes++
      this.probing = this.level
      this.set(this.level - 1, now)
    }
  }
}

export const quality = new Quality()

/**
 * PERF HOOK — the section window (Shifat 10:51Z: "preload the sections BEFORE and AFTER the current one and keep them
 * live, not frozen"). The builder's preloading release owns WHICH sections are mounted (current ±1; the rest disposed);
 * this is the cost side of it, so three live sections do not cost three full renders on a phone:
 *   - `inView` stages (the owner, plus the card's other block during a boundary) render every frame at full quality;
 *   - `live` neighbours (current ±1, off screen) ADVANCE every frame (time, springs, sims: never frozen) and keep a
 *     fresh frame by rendering once every `warmEvery` frames into their own target at `neighbourScale`, so the first
 *     frame of a boundary is current and every program/texture stays resident (no compile or upload on entry);
 *   - anything else is not drawn (and is disposed by the builder's window).
 * A stage asks `stageWindow.render(name)` once per frame before its render work; `tick(name)` says whether to advance.
 * The governor sees the boundary frames (two scenes) as part of its 50-frame window, so a boundary does not step it down
 * on its own; a phone that cannot hold two scenes at once steps down during long boundaries, which is the right call.
 */
class StageWindow {
  inView = new Set<string>()
  live = new Set<string>()
  /** at 60 fps: a neighbour's frame refreshes 4x a second; phones at the floor level halve that */
  warmEvery = 15
  neighbourScale = 0.5
  private frame = 0
  set(inView: string[], live: string[]) {
    this.inView.clear(); inView.forEach((n) => this.inView.add(n))
    this.live.clear(); live.forEach((n) => this.live.add(n))
  }
  /** call once per frame (the clock) */
  step() { this.frame++ }
  /** advance this stage's state this frame? (in view or live neighbour: yes, so nothing ever freezes) */
  tick(name: string) { return this.inView.has(name) || this.live.has(name) }
  /** draw this stage this frame? in view: always; live neighbour: one frame in `warmEvery` (staggered by name) */
  render(name: string) {
    if (this.inView.has(name)) return true
    if (!this.live.has(name)) return false
    const every = quality.level >= quality.maxLevel ? this.warmEvery * 2 : this.warmEvery
    let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
    return (this.frame + (h & 0xff)) % every === 0
  }
  /** a live neighbour's render-target scale (its frame is only seen as the first frames of a boundary) */
  rt(name: string, base: number) { return this.inView.has(name) ? quality.rt(base) : quality.rt(base) * this.neighbourScale }
}
export const stageWindow = new StageWindow()
;(window as any).__perfWindow = stageWindow // (the builder's window.__stageWindow = {owner, mounted} is the mount state)
/** PERF HOOK: the trail sim's sleep state (Scene sets it, the post chain drops the distortion pass while asleep) */
export const paintState = { asleep: false }
;(window as any).__quality = quality
