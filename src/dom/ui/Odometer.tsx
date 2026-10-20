import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { browser } from '../../services/settings'

/**
 * Odometer — every number on the site is a mechanical counter (Shifat, Oct 20).
 * Each digit is a vertical reel (0–9 three times over, the middle copy is the window) behind a mask.
 * Small changes roll as a true odometer: one continuous value drives every reel, and a digit only turns
 * while the digits to its right pass from 9 to 0 (carry), so every intermediate value rolls past.
 * Large jumps (a year rolling in from 0000) roll each reel on its own, staggered, at least one full turn.
 * Eased with a slight overshoot; triggered on enter (play) and on every value change, both directions.
 * Reduced motion: instant swap. Screen readers get the plain number; the reels are aria-hidden.
 */
const STEP = 100 / 30
const mod10 = (x: number) => ((x % 10) + 10) % 10

/** reel positions for a continuous value (true odometer carry) */
export function reelPositions(v: number, digits: number) {
  const out: number[] = []
  for (let i = 0; i < digits; i++) {          // i = 0: leftmost
    const p = digits - 1 - i                  // power of ten
    if (p === 0) { out.push(mod10(v)); continue }
    const unit = Math.pow(10, p)
    const base = Math.floor(v / unit)
    const lower = v - base * unit             // value of the digits to the right (continuous)
    out.push(mod10(base) + Math.max(0, lower - (unit - 1)))
  }
  return out
}
function paint(strips: NodeListOf<HTMLElement> | HTMLElement[], pos: number[]) {
  strips.forEach((s, i) => { s.style.transform = `translate3d(0, ${(-(mod10(pos[i]) + 10) * STEP).toFixed(3)}%, 0)` })
}

export function Odometer({ value, digits, className, duration = 1.1, play = true, delay = 0 }: { value: number; digits?: number; className?: string; duration?: number; play?: boolean; delay?: number }) {
  const n = Math.max(0, Math.round(value))
  const len = digits ?? String(n).length
  const str = String(n).padStart(len, '0')
  const ref = useRef<HTMLSpanElement>(null)
  const st = useRef({ v: 0, pos: [] as number[], tween: null as gsap.core.Tween | null })
  useEffect(() => {
    const root = ref.current; if (!root) return
    const strips = root.querySelectorAll<HTMLElement>('.odo__strip')
    const s = st.current
    if (s.pos.length !== len) s.pos = reelPositions(s.v, len)
    const target = play ? n : 0
    s.tween?.kill()
    if (browser.reducedMotion || duration <= 0) { s.v = target; s.pos = reelPositions(target, len); paint(strips, s.pos); return }
    if (Math.abs(target - s.v) <= 12) {
      // true odometer: one value, carries roll the reels to the left
      const o = { v: s.v }
      s.tween = gsap.to(o, { v: target, duration: duration * (0.6 + 0.08 * Math.abs(target - s.v)), delay, ease: 'back.out(1.35)',
        onUpdate: () => { s.v = o.v; s.pos = reelPositions(o.v, len); paint(strips, s.pos) } })
    } else {
      // big jump: every reel rolls forward on its own to its digit, leading reels turn once more
      const from = s.pos.slice(), to = reelPositions(target, len).map((d, i) => {
        let t = Math.floor(from[i]) - mod10(from[i]) + d
        while (t <= from[i] + 0.01) t += 10
        return t + (i < len - 1 ? 10 : 0)
      })
      const o = { k: 0 }
      s.tween = gsap.to(o, { k: 1, duration: duration * 1.25, delay, ease: 'none',
        onUpdate: () => {
          s.pos = from.map((f, i) => { const local = Math.min(1, Math.max(0, (o.k - i * 0.06) / (1 - (len - 1) * 0.06))); return f + (to[i] - f) * gsap.parseEase('back.out(1.2)')(local) })
          paint(strips, s.pos)
        },
        onComplete: () => { s.v = target } })
    }
    return () => { s.tween?.kill() }
  }, [n, len, play, duration, delay])
  return (
    <span ref={ref} className={'odo ' + (className ?? '')}>
      <span className="sr-only">{str}</span>
      {str.split('').map((_, i) => (
        <span className="odo__col" key={i} aria-hidden="true">
          <span className="odo__strip">{Array.from({ length: 30 }, (_, k) => <span key={k}>{k % 10}</span>)}</span>
        </span>
      ))}
    </span>
  )
}

/** Per-frame odometer (the intro counter): a continuous value drives the reels with true carry. */
export function setOdometer(root: HTMLElement, value: number, digits = 3) {
  paint(root.querySelectorAll<HTMLElement>('.odo__strip'), reelPositions(Math.max(0, value), digits))
}
