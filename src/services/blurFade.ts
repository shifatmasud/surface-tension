/**
 * MOCKUP (Shifat 12:51Z "It should not pop. But blur fade in out. Instead of pop, use fluid wobbly blur fade in out
 * animation" + 12:52Z LOCK "Don't touch text & numbers"): ONE enter / exit primitive for NON-TEXT UI (the frosted X,
 * icons, chips, scrims). Enter: blur 8px → 0, opacity 0 → 1, scale .97 → 1 on a damped spring (ζ 0.7, overshoot ≤ 1 %,
 * 550 ms). Exit: the reverse, a touch faster (450 ms), scale to .98; the element stays mounted until the exit has ended. WAAPI, so it runs
 * on the document timeline (and on the capture rig's virtual clock). Reduced motion: a plain 150 ms opacity.
 * Never for text or numbers (LOCKED 12:52Z).
 */
import { browser } from './settings'

// Shifat 12:53Z "Target is gentler in out": 550 / 450 ms, blur 8 px, scale .97 → 1 (exit 1 → .98), ζ 0.7 (overshoot ≤ 1 %), eased both ends
export const BF = { IN: 550, OUT: 450, BLUR: 8, SCALE: 0.97, SCALE_OUT: 0.98, ZETA: 0.7, N: 20 }

/** the spring's displacement x(t) ∈ [1 → 0] with a wobble, sampled on N keyframes */
function springFrames(ms: number, zeta: number, n: number) {
  const wn = 4.6 / (zeta * ms / 1000), wd = wn * Math.sqrt(1 - zeta * zeta), k = zeta / Math.sqrt(1 - zeta * zeta)
  const out: { o: number; x: number }[] = []
  for (let i = 0; i <= n; i++) {
    const o = i / n, t = o * ms / 1000
    const x = i === n ? 0 : Math.exp(-zeta * wn * t) * (Math.cos(wd * t) + k * Math.sin(wd * t))
    out.push({ o, x })
  }
  return out
}
const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
/** a soft sine in-out: no snap at either end */
const easeInOut = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t))

function framesIn(): Keyframe[] {
  return springFrames(BF.IN, BF.ZETA, BF.N).map(({ o, x }) => ({
    offset: o,
    opacity: easeInOut(o / 0.7),
    filter: `blur(${(BF.BLUR * (1 - easeInOut(o / 0.8))).toFixed(2)}px)`,
    transform: `scale(${(1 - (1 - BF.SCALE) * x).toFixed(4)})`,
  }))
}
function framesOut(): Keyframe[] {
  const n = BF.N
  const out: Keyframe[] = []
  for (let i = 0; i <= n; i++) {
    const o = i / n
    out.push({ offset: o, opacity: 1 - easeInOut(o / 0.9), filter: `blur(${(BF.BLUR * easeInOut(o)).toFixed(2)}px)`, transform: `scale(${(1 - (1 - BF.SCALE_OUT) * easeInOut(o)).toFixed(4)})` })
  }
  return out
}

export function blurFadeIn(el: HTMLElement | null, delay = 0): Animation | null {
  if (!el) return null
  el.getAnimations().forEach((a) => a.cancel())
  el.style.opacity = ''; el.style.visibility = ''
  if (browser.reducedMotion) return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, delay, easing: 'ease-out', fill: 'backwards' })
  el.style.willChange = 'filter, transform, opacity'
  const a = el.animate(framesIn(), { duration: BF.IN, delay, fill: 'backwards' })
  a.finished.then(() => { el.style.willChange = '' }).catch(() => {})
  return a
}

/** resolves when the element has faded out; it stays mounted (the caller hides / unmounts after) */
export function blurFadeOut(el: HTMLElement | null, delay = 0): Promise<void> {
  if (!el) return Promise.resolve()
  el.getAnimations().forEach((a) => a.cancel())
  const a = browser.reducedMotion
    ? el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, delay, easing: 'ease-in', fill: 'forwards' })
    : el.animate(framesOut(), { duration: BF.OUT, delay, fill: 'forwards' })
  if (!browser.reducedMotion) el.style.willChange = 'filter, transform, opacity'
  return a.finished.then(() => { el.style.willChange = '' }).catch(() => {})
}
