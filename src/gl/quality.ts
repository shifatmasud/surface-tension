import { PHONE } from '../core/viewport'
import { settings, browser, MAX_RENDER_PIXELS } from '../services/settings'
import { props } from '../state/props'
import { input } from '../services/input'

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
 * QA: ?q=-B..N pins a level (no governor; negative = boost), ?nogov disables the governor, ?norest disables the rest
 * refinement, ?restpin keeps a rest frame at native on a slow QA rig (no rest judge), window.__quality is the live
 * object (stats, gpuMs, rest, restCap).
 */
export type QualityState = { level: number; dpr: number; aa: 'smaa' | 'fxaa' }
type Listener = (q: QualityState) => void

const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
const tier = settings.TIER

/** DPR ladders by tier (his skill: phones live inside 0.75–1.25). Level 0 = today's cap, so nothing changes on a
 *  device that already holds 60. Entries above the device's own DPR or the total-pixel cap are clipped at runtime.
 *  SHARP (Shifat: "crisp at full quality yet fast on phones"): BOOST steps sit ABOVE level 0 as negative levels
 *  (-1, -2, …), reached only on measured headroom; level 0 keeps today's meaning for every reader of `level`
 *  (render-target scales, tap counts, the neighbour pass, the stage window). Phones floor at 1.0. */
const LADDER: Record<string, number[]> = {
  // W27 R6.65 (Shifat 16:03Z "For dpr can be adaptive for better performance", 16:07Z "Min of phone & desktop should
  // be same & lower"): one shared floor of 0.6 for every tier (= the capDpr hard floor in settings.ts), reached through
  // 0.85 / 0.72, so a slow device can hold 60 instead of settling at ~30 on the old floor. Level 0 and every rung that
  // existed before are unchanged; only the ladder's tail grew.
  high: [1.5, 1.3, 1.15, 1.0, 0.85, 0.72, 0.6],
  mid: [1.5, 1.3, 1.15, 1.0, 0.85, 0.72, 0.6],
  low: [1.3, 1.15, 1.0, 0.85, 0.72, 0.6],
  none: [1],
}
const BOOST: Record<string, number[]> = {          // nearest first: BOOST[0] is level -1
  high: [1.75, 2.0],
  mid: [1.75, 2.0],
  low: [1.5],                      // W20 (Shifat 22:27Z 'hero feels heavy on phone'): phones never go past 1.5
  none: [],
}
/** render-target scale per level (multiplies a stage's own base scale) and loop-count scale */
const RT = [1, 0.9, 0.8, 0.7, 0.6, 0.55, 0.5]      // W27 R6.65: 7 rungs, one per ladder level (high/mid)
const TAPS = [1, 0.85, 0.75, 0.62, 0.5, 0.45, 0.4]

const BUDGET_MS = 1000 / 60          // the target is 60; a low-end phone that cannot hold it settles at the floor (≈30 fps, steady)
const WINDOW = 50                    // frames per decision (~0.8 s at 60)
const STEP_COOLDOWN_MS = 1500        // a DPR step re-allocates targets: ignore the frames right after it
const PROBE_CALM_MS = 4000           // full-rate time before probing a step up
const MAX_BACKOFF_MS = 60000
// SHARP: measured headroom (GPU ms per frame from the timer query, systems/perfGovernor.ts)
const GPU_UP = 0.7                   // probe up only if the predicted GPU time at the next DPR is under 70 % of budget
const GPU_NO = 0.95                  // never probe into a step predicted over 95 %
const GPU_CALM_MS = 2500             // with a measurement, a shorter calm is enough (PERFGOV: 1.5 → 2.5 s, slow climb)
// SHARP: rest refinement (idle → native DPR + SMAA)
const REST_AFTER_MS = 300
// PERFGOV: a rest frame is NOT a still picture (the lake, the stone, the jellies and the trail keep moving), and the
// hero above the water is where people sit still — a rest frame that was allowed to settle at 30 fps was a visible
// frame drop there. It now has to hold the same 60 as a moving frame, else it steps down (x0.8) and then suspends.
// A device that holds 60 at rest keeps the identical refined frame.
const REST_BUDGET_MS = 1000 / 60
const REST_WINDOW = 8                // frames per rest verdict (short: a refined frame that is too slow is dropped fast)
const REST_STEP = 0.8
const REST_BACKOFF_MS = 30000
const HOVER_EXIT_MS = 500            // a mouse twitch keeps the rest frame; only a sustained hover (≥ 0.5 s) leaves rest
const SETTLE_MS = 250                // the frames right after a re-allocation (rest in/out) are not a governor verdict
// PERFGOV (Shifat 17:23Z Oct 21: "Frame drop happens when gpu in phone gets overwhelmed. Need fix"). The window above
// needs ≥ 12 frames AND ≥ 1 s (or 50 frames) per verdict and then ignores 1.5 s after every step, so a phone whose GPU
// chokes mid-scroll dropped frames for ~2.5 s per rung (~12 s from level 0 to the floor). The FAST path below reacts
// per frame: 3 dropped frames among the last 4 → one rung down within ~4 frames; 3 of them missing two vsyncs (under
// ~27 fps) → the EMERGENCY rung, two levels at once (render-target scale + taps + DPR together, toward the 0.6 floor;
// objects and the text layer untouched). The way back up stays slow: a probe only after 2.5 s+ of full-rate frames, a
// failed probe is caught by the same fast path and doubles the back-off. A device holding 60 never meets a fast verdict,
// so level 0 is untouched.
const FAST_OVER_MS = BUDGET_MS * 1.5      // a frame that missed its vsync (≥ 25 ms at 60 Hz)
const FAST_SEVERE_MS = BUDGET_MS * 2.2    // a frame that missed two (≥ 36.7 ms)
const FAST_NEED = 3                       // over-budget frames among the last FAST_OF
const FAST_OF = 4
const FAST_SETTLE_MS = 200                // after a step the re-allocation frames are not a verdict
const GPU_OVER = 1.2                      // timer-query GPU time over 120 % of budget counts as a dropped frame
const CLIMB_HOLD_MS = 2500                // after a fast step down, at least this long at full rate before any probe up
/** SHARP (eng review #25): ONE density ceiling for everything. The canvas (= the text layer, SharpText + the final
 *  upscale) never exceeds the device's own DPR (cap 3) nor ~9 Mpx of backing store; the scene never exceeds the text. */
const CANVAS_PIXELS = 9.0e6
/** W20 (Shifat 22:27Z on his phone: "Hero section feels heavy on phone but beautiful"): phones (tier low) render the
 *  3D scene at no more than 1.5x and the canvas/text layer at no more than 2x, at rest too. Rest used to refine to the
 *  native 3x (a 3x phone drew 4x the scene pixels of 1.5x and 2.25x the canvas pixels of 2x, every frame it sat still,
 *  with the lake, the stone and the trail still animating). At the phone's viewing size 1.5x + SMAA reads the same;
 *  text stays at 2x, the sharpest thing on screen. */
const PHONE_SCENE_DPR = 1.0 // TUNE (Shifat 16:41 PT Oct 21: "On phone low dpr make site faster. Set max dpr to 1 max"): was 1.5; also caps the phone text layer (textDprFor)
/** W27 R6.65: phone text density drops from 2x to 1.5x at this governor level and holds there (see textDprFor) */
const TEXT_DROP_LEVEL = 1
const PHONE_CANVAS_DPR = 2
/** R6.79 (Shifat 04:38 PT Oct 22: "We need max dpr 1.2 in desktop"): desktop/tablet scene ceiling — moving, boost and rest all clip here. The text layer stays native. */
const DESKTOP_SCENE_DPR = 1.2

/** PERFGOV: phone GPUs well under a 2019 mid-range part (Adreno 3xx/4xx/50x, Mali-4xx/T6xx–T8xx/G31/G51/G52,
 *  PowerVR GE8xxx) — ?lowend forces it (QA) */
export const LOW_END_GPU = /Adreno \(TM\) (3\d\d|4\d\d|50\d)\b|Mali-(4\d\d|T[678]\d\d|G31|G51|G52)|PowerVR Rogue GE/i.test(settings.GPU) || q.has('lowend')
  || settings.WEAK_GPU   // R6.92: weak desktop GPUs (Intel UHD 6xx class) take the budget-GPU split: background 0.5–0.75

/** R6.87 SPLIT RESOLUTION (Shifat 5:46–5:48 PM Oct 22: "Resolution Quality down the bg scene but quality up the stone,
 *  project images, [...] crewmate model only"; "Only crewmate, stone, project images/videos are my true hi res subjects").
 *  The scene (water, sky, environment, fog, bloom, particles, the tablet, the journey's scenery) renders at the governor's
 *  background DPR (props.dpr); the hero subjects (the stone, the project slides with their reels, the crewmate) render
 *  at the hero density (props.heroDpr: the device's own DPR, phones capped at 2) in their own pass (post/heroPass.ts) and
 *  are composited over the upscaled background through the same grade and trail. The canvas (and with it the text
 *  layer) runs at the hero density. The governor moves the background only; the heroes stay sharp.
 *  Budget GPUs (LOW_END_GPU) take the biggest background cut: ceiling 0.75, floor 0.5. ?nosplit = the R6.83 path. */
export const SPLIT = settings.USE_GL && !q.has('nosplit')
const LOW_BG_CAP = 0.75
/** R6.92 (Shifat 8:46 AM: "Ensure my device gets the best treatment possible"): a weak DESKTOP GPU starts on the budget
 *  floor (0.5) like a budget phone, but the governor may climb the background to 1.0 where its GPU timer measures headroom
 *  (one rung at a time, probes only under 70 % of the frame budget, failed probes back off). Phones keep 0.75. */
const WEAK_BG_CAP = 1.0
const BG_FLOOR = SPLIT && LOW_END_GPU ? 0.5 : 0.6
/** R7.08b ONE DENSITY (Shifat 7:32-7:43 PM: "edges still feel pixelated on phone"; first principles for the M02s): the phone
 *  background was drawn at 0.5-0.75 of the CSS size and stretched 2.3-3.5x onto a 1.5-1.75 canvas (the stairs he sees).
 *  Phones now draw the scene and the heroes at ONE static density (DENS_PHONE, never moved by the governor or a rest
 *  toggle: no re-allocation, no pop), so the stretch to the canvas is 1.2x moving / 1.4x at rest. ?dens=old = 7.08 */
// R7.10 (Shifat 12:52 AM Oct 25: "My Pc should get equal or better quality than my phone"): his weak-GPU PC (Intel UHD 600,
// &weakgpu) took the 7.07 governed background, 0.5 css-density in every section (sim), half the phone's 1.0 below the water.
// It now takes the phone's one static density too (1.0 below the water = its native 1:1, 0.5 above it, no governor, no rest
// refine, no CAS on top). Its canvas, heroes and text stay at native 1:1 (a 1.25 supersample on a 1x screen is a non-integer
// downscale by the browser = softer). ?dens=old = the 7.09 paths.
export const DENS_ONE = SPLIT && tier === 'low' && (PHONE || settings.WEAK_GPU) && q.get('dens') !== 'old'   // phones + weak-GPU PCs (tablet, desktop unchanged)
const DENS_PHONE = Math.max(0.75, Math.min(1.75, parseFloat(q.get('dens') || '') || 1.0))   // simulated: 1.25 cost 1.3-2.3x 7.07 moving, 1.0 holds it outside the hero
/** R7.10 b5 (Shifat 4:42 AM: cost <= riptide v2 on BOTH devices, every section): the weak PC below the water was at its native
 *  1.0 since b1 (1.5-2.2x riptide v2 there, sim); it is back at riptide v2's 0.5 (its governor floor; headless sim). ?pcund=<x> */
const DENS_UNDER = settings.WEAK_GPU && !PHONE ? Math.max(0.5, Math.min(1, parseFloat(q.get('pcund') || '') || 0.5)) : DENS_PHONE
/** R7.08c (Shifat 8:22 PM on his M02s: "hero feels jittery"; 4:20 AM Oct 24: the hero above the water needs "no hi res, just
 *  performance"): above the water the background (sky, lake, haze: soft by nature) holds 7.07's density (0.5); the gem
 *  keeps its own sharp MSAA layer. One switch per crossing (it rides the waterline wobble), never while moving inside a
 *  stage. ?abg=1 = the 7.08b hero background. */
const DENS_ABOVE = Math.max(0.5, Math.min(1.75, parseFloat(q.get('abg') || '') || 0.5))   // simulated hero frame vs 7.07: 0.5 ~1.15x, 0.75 ~1.35x, 7.08b's 1.0 ~1.8x
const DENS_HERO = Math.max(0.75, Math.min(1.75, parseFloat(q.get('hdens') || '') || 1.25))  // the heroes (gem, crewmate, slides): 4x MSAA kept
const PHONE_HERO_DPR = 1  // R6.89 (Shifat 4:09 AM Oct 23): phone heroes at 1.0 (was 1.5 since 3:15 AM; 2 before)
/** R6.89 (Shifat 4:10 AM Oct 23 "keep the TEXT at 1.5 while heroes go to 1.0"): the phone canvas (the GPU text layer) has
 *  its own density now; the hero pass renders into its own target at PHONE_HERO_DPR and is composited up onto it */
const PHONE_TEXT_DPR = 1.5
/** R7.07 #10: the phone text layer's density once the page is still (the screen's own, max 2x) */
const PHONE_TEXT_REST_DPR = 2
const TEXT_REST_MS = 350
const TEXT_REST_OFF = q.get('txtrest') === '0'
/** R7.00 PHONE SHARP (Shifat 4:18 AM Oct 24: "0 pixelation + smooth fast performance"; lusion.co draws its whole scene at
 *  1.5x with cheap quarter-res post). A budget phone's background ran at 0.5 (a 3x stretch onto the 1.5x canvas) all the
 *  time. Now, outside the hero above the water, it refines to SHARP_BG whenever the scroll is still or slow, drops back
 *  to the governor's moving DPR only during a fast fling, and returns within a few frames once the fling slows. The post
 *  effects stay on the governor's cheapest rung (render-target scales, sample counts), so the pixels are paid for by
 *  effects, not the other way round. A sharp frame that cannot hold ~30 fps steps itself down (×0.8) and finally backs
 *  off, like the rest refinement on other devices. Hero above water: unchanged density (Shifat 4:20 AM: "No need hi res
 *  on that. Just performance boost"). ?res=old = the R6.99 behaviour; ?bgdpr=1.25 tries another sharp density (QA). */
const RES_OLD = q.get('res') === 'old'
/** R7.07 #10: the phone canvas at its rest density, moving frames drawn into a 1.5x sub-rectangle (?txtrest=0 = 7.06) */
const SUBRECT = SPLIT && tier === 'low' && !TEXT_REST_OFF
export const PHONE_SHARP = SPLIT && LOW_END_GPU && tier === 'low' && !settings.WEAK_GPU && !RES_OLD
const SHARP_BG = Math.max(0.5, Math.min(1.5, parseFloat(q.get('bgdpr') || '') || 1.0))
const SHARP_FAST_V = 18        // css px per 60 Hz frame (~1100 px/s): faster is a fling, the frame may drop
const SHARP_SLOW_V = 9         // below this for SHARP_ENTER_MS the frame refines back to sharp
const SHARP_ENTER_MS = 120
const SHARP_BUDGET_MS = 1000 / 30

/** PERFGOV: set bits in a small history mask */
function bits(x: number) { let n = 0; while (x) { n += x & 1; x >>>= 1 } return n }

class Quality {
  readonly tier = tier
  readonly ladder = SPLIT && LOW_END_GPU && tier === 'low' ? [...LADDER.low, 0.5] : (LADDER[tier] ?? [1])  // R6.87: budget GPUs get one more background rung
  readonly boost = BOOST[tier] ?? []
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
  private probing = -99              // level we probed up from (-99 = not probing)
  private stallRun = 0
  private winStart = 0
  private sorted = new Float32Array(WINDOW)
  /** PERFGOV: the last FAST_OF frames as bit histories (bit 0 = newest): over budget / missing two vsyncs */
  private fastOver = 0
  private fastSevere = 0
  private climbAfter = 0
  private fastStall = 0
  /** the last window size the DPR was asked for (skips boost steps the device or the pixel cap clip to the same DPR) */
  private w = typeof window !== 'undefined' ? window.innerWidth : 1
  private h = typeof window !== 'undefined' ? window.innerHeight : 1
  /** GPU ms per frame (EMA) from the timer query; -1 = no measurement on this device (iOS, WebGL1, disjoint) */
  gpuMs = -1
  private gpuAt = 0
  stats = { median: 0, p90: 0, steps: 0, fastSteps: 0, emergency: 0, probes: 0, failedProbes: 0, gpuProbes: 0, gpuVetoes: 0, rests: 0, restDowns: 0, restSuspends: 0, restOut: { hard: 0, hover: 0, gate: 0 } }

  constructor() {
    if (this.pinned) this.level = Math.max(this.minLevel, Math.min(this.maxLevel, parseInt(q.get('q') || '0', 10) || 0))
    // PERFGOV (Shifat 18:31Z, target device Galaxy M02s = Adreno 506): a known low-end phone GPU starts at the bottom of
    // its ladder (the 0.6 floor, where the governor settles on these parts) instead of at level 0, and climbs only on
    // measured headroom, so its first seconds are not spent dropping frames on the way down. Same objects, same text,
    // fewer pixels. Never matches iPhones / recent Androids.
    else if (this.enabled && tier === 'low' && LOW_END_GPU) this.level = this.maxLevel
    this.aa = this.aaFor(this.level)
  }
  get maxLevel() { return this.ladder.length - 1 }
  get minLevel() { return -this.boost.length }
  /** the ladder's DPR step at a level (negative = boost) */
  stepAt(level: number) { return level < 0 ? this.boost[Math.min(this.boost.length, -level) - 1] : this.ladder[Math.min(this.maxLevel, level)] }
  /** the device's own density for this window: device DPR (cap 3) within the canvas pixel cap — the single ceiling */
  nativeFor(w: number, h: number) { return Math.max(1, Math.min(3, window.devicePixelRatio || 1, Math.sqrt(CANVAS_PIXELS / Math.max(1, w * h)))) }
  private cap(w: number, h: number) { return Math.min(browser.dpr, this.nativeFor(w, h), Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, w * h)), tier === 'low' ? (SPLIT && LOW_END_GPU ? (settings.WEAK_GPU ? WEAK_BG_CAP : LOW_BG_CAP) : PHONE_SCENE_DPR) : DESKTOP_SCENE_DPR) }
  /** R6.87 SPLIT: the hero subjects' density — the device's own (canvas cap), phones at most 2x. Never moved by the governor. */
  heroDprFor(w: number, h: number) { const n = this.nativeFor(w, h); return tier === 'low' ? Math.min(n, DENS_ONE ? DENS_HERO : PHONE_HERO_DPR) : n }
  /** the rest target before the rest judge: native within 1.2x the scene pixel cap */
  private restTarget(w: number, h: number) { if (PHONE_SHARP) return Math.min(this.nativeFor(w, h), SHARP_BG, PHONE_TEXT_DPR, props.bgCeil > 0 ? props.bgCeil : 9); return Math.min(this.nativeFor(w, h), Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, w * h)) * 1.2, tier === 'low' ? PHONE_SCENE_DPR : DESKTOP_SCENE_DPR) }
  /** the canvas density a rest frame refines to: native, phones capped at PHONE_CANVAS_DPR */
  private textCeil(w: number, h: number) { const n = this.nativeFor(w, h); return tier === 'low' ? Math.min(n, PHONE_CANVAS_DPR, PHONE_SCENE_DPR) : n } // TUNE: phones max 1.0
  /** DPR for a window size: the level's step, clipped by the device DPR and the total-pixel cap, floored at 0.6.
   *  At rest: native (the device's own DPR, phones up to 3) within 1.2x the pixel cap, lowered by the rest judge.
   *  Never above the text density (eng review #25: text stays the sharpest thing on screen, at rest too). */
  dprFor(w: number, h: number, noRest = false) {
    this.w = w; this.h = h
    const td = this.textDprFor(w, h, noRest)
    if (DENS_ONE) return Math.min(td, this.nativeFor(w, h), props.aboveWater ? DENS_ABOVE : DENS_UNDER)   // R7.08b: static, same moving and still (R7.08c: per side of the waterline)
    const moving = Math.min(td, Math.max(BG_FLOOR, Math.min(this.stepAt(this.level), this.cap(w, h))))
    if (!this.rest || noRest) return moving
    return Math.min(td, Math.max(moving, Math.min(this.restTarget(w, h), this.restCap)))
  }
  /** SHARP (eng review #3): the canvas / text density is a governor rung too. Phones (tier low) on a 3x screen paid a
   *  full 3x upscale + text pass even at the governor floor (≈85 % of the fill there). Moving: 2x on phones (indistin-
   *  guishable from 3x at reading distance, 2.25x fewer pixels), 1.5x at the last two levels; at rest: native, so a
   *  still is as sharp as the screen. Desktop/tablet tiers: native always (≤ 2 on almost every desktop). */
  textDprFor(w: number, h: number, noRest = false) {
    const n = this.nativeFor(w, h)
    if (tier !== 'low') return n
    if (SPLIT) return Math.min(n, SUBRECT ? PHONE_TEXT_REST_DPR : PHONE_TEXT_DPR) // R6.89 (+ R7.07 #10: the canvas is allocated once at the rest density; renderScale): the canvas (the text) at 1.5 on phones; the heroes at their own density
    if (this.rest && !noRest) return this.textCeil(w, h)
    // W27 R6.65: the text rung drops to 1.5x from level 1 on (the same absolute level as before the ladder grew: it was
    // "the last two of three"), and NEVER lower — the new 0.85 / 0.72 / 0.6 scene steps keep the text at 1.5x, so
    // text stays the sharpest thing on screen at the floor too.
    return Math.min(n, PHONE_SCENE_DPR, this.level >= TEXT_DROP_LEVEL ? 1.5 : 2) // TUNE: phones max 1.0
  }
  /** SHARP REST REFINEMENT (Shifat 15:39Z + the sharp lane): after ~300 ms with no scroll or pointer the canvas renders
   *  at native density with SMAA (razor stills); motion drops it back. Every tier, phones included. A rest frame that
   *  cannot hold ~30 lowers the rest DPR (×0.8 per verdict); at the moving DPR rest is suspended with back-off.
   *  Leaving rest takes 2 moving ticks in a row, so hover jitter does not thrash the re-allocation. */
  rest = false
  restCap = 3
  private still = 0
  private movingRun = 0
  private hoverSince = 0
  private hoverLast = 0
  private lastDelta = 16
  private restAt = 0                 // the last rest in/out (its re-allocation frame is not a verdict)
  private settleUntil = 0
  private restBlockedUntil = 0
  private restBackoff = REST_BACKOFF_MS
  private restN = 0
  private restBuf = new Float32Array(REST_WINDOW)
  /** R7.07 #10 (Shifat "10 7 8 9"): the phone's big GPU text is drawn at 1.5x on a 1.75x / 3x screen, so the browser's
   *  upscale left it slightly soft. Once the page has been fully still for TEXT_REST_MS (no scroll, no finger), outside the
   *  hero above the water (never any cost there), the canvas / text layer refines to the screen's own density (max 2x) —
   *  one re-allocation in, one out on the first moving frame; while moving it is exactly 7.06 (1.5x). ?txtrest=0 = 7.06. */
  textRest = false
  private densAbove = true
  private textStill = 0
  private textRestTick(now: number) {
    if (tier !== 'low' || !SPLIT || TEXT_REST_OFF) return
    const can = this.enabled && props.introDone && !props.aboveWater && !props.overlayOpen
    const moving = Math.abs(props.scrollVel) > 0.5 || input.isDown
    if (!can || moving) { this.textStill = now; this.textRest = false; return }
    if (!this.textRest && now - this.textStill > TEXT_REST_MS) this.textRest = true
  }
  /** R7.07 #10, zero re-allocation (Shifat: "in phone height never grows or shrinks"): the phone canvas is allocated ONCE at
   *  the screen's own density (max 2x). While anything moves (and always in the hero above the water) the final pass draws
   *  into a 1.5x sub-rectangle of it, which the compositor scales up to the screen exactly as it scaled the old 1.5x canvas
   *  (same pixels, same cost); once still, the same buffer is drawn whole: crisp type. Only a viewport and a CSS transform
   *  change (gl/renderScale.ts), never a canvas or render-target size. 1 = draw the whole buffer. */
  renderScale(): number {
    if (!SUBRECT) return 1
    return this.textRest ? 1 : Math.min(1, PHONE_TEXT_DPR / Math.max(1e-3, props.textDpr || 1))
  }
  restTick(moving: boolean, now: number) {
    this.textRestTick(now)
    if (DENS_ONE) {   // R7.08b: one static density, no background rest refinement
      if (props.aboveWater !== this.densAbove) { this.densAbove = props.aboveWater; if (DENS_ABOVE !== DENS_UNDER) { const s = this.state(); this.listeners.forEach((fn) => fn(s)) } }   // R7.08c: re-size once per waterline crossing
      return
    }
    if (PHONE_SHARP) return this.sharpTick(now)
    // PERFGOV-3: a known low-end phone GPU settles with rest suspended (the native-DPR + SMAA still costs ~4–5x its
    // moving frame on an Adreno 50x and is judged straight back down, a few dropped frames every 30–120 s of idle), so it
    // starts there and never pays those detection frames; its moving frame is unchanged. Normal devices: untouched.
    const can = this.enabled && this.judging && this.probing === -99 && now >= this.restBlockedUntil && !q.has('norest') && !LOW_END_GPU
    if (!can) { this.still = now; this.movingRun = 0; if (this.rest) { this.stats.restOut.gate++; this.setRest(false, now) } return }
    // eng review #4: a hover (mouse move with no scroll, no press, no overlay) is not "moving" for an existing rest
    // frame — a twitch used to re-allocate every target twice. A sustained hover (the pointer parallax really moving
    // the frame for ≥ 0.5 s) still leaves rest; scroll, a press or a touch leave it at once (2 ticks).
    const hard = Math.abs(props.scrollVel) > 0.5 || input.isDown || props.overlayOpen
    if (moving && !hard) {
      if (now - this.hoverLast > Math.max(150, 2.5 * this.lastDelta)) this.hoverSince = now   // a gap ends a hover (≥ 2.5 frames on a slow device)
      this.hoverLast = now
    }
    if (moving) {
      this.still = now
      const leave = hard || now - this.hoverSince >= HOVER_EXIT_MS
      if (this.rest && leave && ++this.movingRun >= 2) { this.stats.restOut[hard ? 'hard' : 'hover']++; this.setRest(false, now) }
      return
    }
    this.movingRun = 0
    if (!this.rest && now - this.still > REST_AFTER_MS) {
      // nothing to refine: the moving DPR already is the rest target (native, or the pixel cap)
      const mv = this.dprFor(this.w, this.h, true)
      if (Math.min(this.restTarget(this.w, this.h), this.restCap) <= mv + 0.01 && this.textDprFor(this.w, this.h, true) >= this.textCeil(this.w, this.h) - 0.01) return
      this.setRest(true, now)
    }
  }
  /** R7.00 PHONE SHARP: the budget phone's rest = still or slow scroll, outside the hero above the water */
  private sharpSlowSince = 0
  private sharpCeil = 0
  private sharpTick(now: number) {
    const can = this.enabled && this.judging && this.probing === -99 && now >= this.restBlockedUntil && !q.has('norest') && !props.aboveWater && !props.overlayOpen
    if (!can) { this.sharpSlowSince = now; this.movingRun = 0; if (this.rest) { this.stats.restOut.gate++; this.setRest(false, now) } return }
    const v = Math.abs(props.scrollVel) * (1000 / 60) / Math.max(8, this.lastDelta)   // px per 60 Hz frame, frame-rate independent
    if (v > SHARP_FAST_V) {
      this.sharpSlowSince = now
      if (this.rest && ++this.movingRun >= 2) { this.stats.restOut.hard++; this.setRest(false, now) }
      return
    }
    this.movingRun = 0
    if (v > SHARP_SLOW_V) { if (!this.rest) this.sharpSlowSince = now; return }   // hysteresis: a medium speed keeps whatever it has
    if (this.rest && props.bgCeil !== this.sharpCeil) { this.sharpCeil = props.bgCeil; this.setRest(true, now); return }   // the stage's own ceiling moved (journey ↔ dive)
    if (!this.rest && now - this.sharpSlowSince > SHARP_ENTER_MS) {
      const mv = this.dprFor(this.w, this.h, true)
      this.sharpCeil = props.bgCeil
      if (Math.min(this.restTarget(this.w, this.h), this.restCap) <= mv + 0.01) return
      this.setRest(true, now)
    }
  }
  private setRest(v: boolean, now: number) {
    // eng review #4: rest does not touch the governor's lastStep (it used to mute the governor for 1.5 s after every
    // pause); only the re-allocation frames right after it are skipped
    this.rest = v; this.restAt = now; this.settleUntil = now + SETTLE_MS; this.n = 0; this.restN = 0; this.movingRun = 0
    if (v) this.stats.rests++
    this.aa = this.aaFor(this.level)
    const s = this.state(); this.listeners.forEach((fn) => fn(s))
  }
  /** a rest window's verdict: too slow → lower the rest DPR, or suspend rest once it is no better than moving */
  private judgeRest(deltaMs: number, now: number) {
    if (now - this.restAt < SETTLE_MS || q.has('restpin')) return  // the re-allocation frame is not a verdict; ?restpin (QA on the 1–3 fps rig): rest is never judged down
    this.restBuf[this.restN++] = Math.min(deltaMs, 1000)
    // a verdict every 8 frames, or after 3 once they add up to half a second (a slow device is not held at native for
    // 8 slow frames)
    let sum = 0; for (let i = 0; i < this.restN; i++) sum += this.restBuf[i]
    if (this.restN < REST_WINDOW && !(this.restN >= 3 && sum > 500)) return
    const n = this.restN; this.restN = 0
    const s = Array.from(this.restBuf.subarray(0, n)).sort((a, b) => a - b), med = s[n >> 1]
    const budget = PHONE_SHARP ? SHARP_BUDGET_MS : REST_BUDGET_MS
    if (med <= budget * 1.15) { this.restBackoff = REST_BACKOFF_MS; return }
    const moving = this.dprFor(this.w, this.h, true)
    const cur = this.dprFor(this.w, this.h)
    const next = med > budget * 3 ? moving : cur * REST_STEP     // hopeless (3x over) → straight back
    if (next <= moving * 1.05) {
      this.stats.restSuspends++
      this.restBlockedUntil = now + this.restBackoff
      this.restBackoff = Math.min(4 * REST_BACKOFF_MS, this.restBackoff * 2)
      this.restCap = 3                                       // the next try (after the back-off) starts at native again
      this.setRest(false, now)
    } else {
      this.stats.restDowns++
      this.restCap = next
      this.setRest(true, now)
    }
  }
  /** a stage's render-target scale at the current level (base = the stage's own tier scale) */
  rt(base: number) { return base * RT[Math.max(0, Math.min(this.level, RT.length - 1))] }
  /** a loop/sample count at the current level, never below `min` */
  taps(base: number, min = 1) { return Math.max(min, Math.round(base * TAPS[Math.max(0, Math.min(this.level, TAPS.length - 1))])) }
  state(): QualityState { return { level: this.level, dpr: this.stepAt(this.level), aa: this.aa } }
  on(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  /** phones only, and only at the very bottom of the ladder while moving: SMAA (3 passes) → FXAA (1 pass). Rest is SMAA. */
  // R6.95 (Shifat: a VISIBLE gain on his phone): phones no longer swap SMAA for FXAA at the floor while moving. The swap saved
  // little there (SMAA runs at the background's own density: ~0.1 Mpx at the phone floor) but FXAA's blur on a 3x-upscaled
  // background was the softest frame on the page, and the sharpness changed when the scroll stopped. ?aa=fxaa = the old swap.
  private aaFor(level: number): 'smaa' | 'fxaa' { return q.get('aa') === 'fxaa' && tier === 'low' && !settings.WEAK_GPU && level >= this.maxLevel && !this.rest ? 'fxaa' : 'smaa' }   // R6.92: a weak desktop keeps SMAA (FXAA's blur read as a soft halo on the stone's edge)
  set(level: number, now = performance.now()) {
    level = Math.max(this.minLevel, Math.min(this.maxLevel, level))
    if (level === this.level) return
    this.level = level
    this.aa = this.aaFor(level)
    this.lastStep = now; this.n = 0; this.calmSince = now
    this.stats.steps++
    const s = this.state()
    this.listeners.forEach((fn) => fn(s))
  }
  /** SHARP: the GPU frame timer's sample (ms of GPU work for one frame) */
  gpuSample(ms: number, now: number) {
    if (!(ms >= 0) || ms > 500) return
    this.gpuMs = this.gpuMs < 0 || now - this.gpuAt > 2000 ? ms : this.gpuMs * 0.9 + ms * 0.1
    this.gpuAt = now
  }
  private gpuFresh(now: number) { return this.gpuMs >= 0 && now - this.gpuAt < 1000 }
  /** the next level up whose effective DPR is actually higher (boost steps clipped to the same DPR are skipped) */
  private nextUp(): number {
    const cur = this.dprFor(this.w, this.h, true)
    for (let l = this.level - 1; l >= this.minLevel; l--) {
      const d = Math.max(BG_FLOOR, Math.min(this.stepAt(l), this.cap(this.w, this.h)))
      if (d > cur + 0.01) return l
    }
    return this.level
  }
  /** called once per frame by the clock with the raw frame delta (ms) */
  frame(deltaMs: number, now: number) {
    this.lastDelta = Math.min(1000, Math.max(1, deltaMs))
    if (!this.enabled || !this.judging) { this.n = 0; this.restN = 0; this.calmSince = now; return }
    if (this.rest) { this.calmSince = now; this.fastOver = this.fastSevere = 0; this.judgeRest(deltaMs, now); return }   // rest frames judge the rest DPR only
    if (this.fastJudge(deltaMs, now)) return    // PERFGOV
    if (now - this.lastStep < STEP_COOLDOWN_MS || now < this.settleUntil) return
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
    // hysteresis: down at > ~51 fps median (or 10 % of frames dropping 2+), up only after a calm spell at full rate
    const slow = med > BUDGET_MS * 1.18 || p90 > BUDGET_MS * 1.9
    if (slow) {
      if (this.probing !== -99) {                               // the probe failed: back down, wait longer next time
        this.stats.failedProbes++
        this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2)
        const back = this.probing; this.probing = -99
        this.set(back, now)
      } else if (this.level < this.maxLevel) this.set(this.level + 1, now)
      this.calmSince = now
      return
    }
    // full rate this window
    if (this.probing !== -99) { this.probing = -99; this.backoff = PROBE_CALM_MS }   // the probe held: stay
    const up = this.nextUp()
    if (up === this.level) return
    if (now < this.climbAfter) return           // PERFGOV: slow, hysteretic climb after a fast step down
    const calm = now - this.calmSince
    if (this.gpuFresh(now)) {
      // measured: predict the GPU time at the next DPR (cost ∝ pixels) and only probe where it fits
      const cur = this.dprFor(this.w, this.h, true), nd = Math.max(BG_FLOOR, Math.min(this.stepAt(up), this.cap(this.w, this.h)))
      const pred = this.gpuMs * (nd / cur) * (nd / cur)
      if (pred > BUDGET_MS * GPU_NO) { this.stats.gpuVetoes++; this.calmSince = now; return }
      if (pred < BUDGET_MS * GPU_UP && calm > GPU_CALM_MS) { this.stats.gpuProbes++; this.probe(up, now); return }
      if (calm > this.backoff) this.probe(up, now)
      return
    }
    // unmeasured (no timer query): today's blind probe; boost steps wait twice as long
    if (calm > this.backoff * (up < 0 ? 2 : 1)) this.probe(up, now)
  }
  /** PERFGOV: the per-frame verdict. Returns true when it stepped (the caller skips the slow window this frame). */
  private fastJudge(deltaMs: number, now: number): boolean {
    if (now - this.lastStep < FAST_SETTLE_MS || now < this.settleUntil) { this.fastOver = this.fastSevere = 0; return false }
    // a lone stall (tab switch, a decode, a first-use link) says nothing about the per-frame GPU cost; three in a row is
    // a device that is that slow (the window below clamps those too)
    this.fastStall = deltaMs > 250 ? this.fastStall + 1 : 0
    if (deltaMs > 250 && this.fastStall < 3) return false
    const gpuOver = this.gpuMs >= 0 && now - this.gpuAt < 250 && this.gpuMs > BUDGET_MS * GPU_OVER
    const m = (1 << FAST_OF) - 1
    this.fastOver = ((this.fastOver << 1) | (deltaMs > FAST_OVER_MS || gpuOver ? 1 : 0)) & m
    this.fastSevere = ((this.fastSevere << 1) | (deltaMs > FAST_SEVERE_MS ? 1 : 0)) & m
    if (bits(this.fastOver) < FAST_NEED) return false
    const severe = bits(this.fastSevere) >= FAST_NEED
    this.fastOver = this.fastSevere = 0
    this.calmSince = now
    this.climbAfter = now + CLIMB_HOLD_MS
    if (this.probing !== -99) {                                 // a probe that drops frames: back at once, wait longer
      this.stats.failedProbes++
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2)
      const back = this.probing; this.probing = -99
      this.set(back, now)
      return true
    }
    if (this.level >= this.maxLevel) return false
    this.stats.fastSteps++
    if (severe) this.stats.emergency++
    this.set(this.level + (severe ? 2 : 1), now)
    return true
  }
  private probe(up: number, now: number) {
    this.stats.probes++
    this.probing = this.level
    this.set(up, now)
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
/** R7.08: `empty` = awake but every trail weight is already exactly 0 (more than 80 frames since the last input: the 8-bit
 *  floor zeroes every weight within ~70). The display-only trail work (the field reconstruction, the smear pass and the
 *  full-density fringe) skips those frames; the sim itself and its sleep at 120 frames are unchanged. */
export const paintState = { asleep: false, empty: false }
;(window as any).__quality = quality
