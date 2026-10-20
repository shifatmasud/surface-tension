import { HOUSE, cssBezier } from '../../core/house'

/**
 * MASKED ROLL (Shifat 19:15Z: "Masked Rolling is our signature move in this text & number case in this page"; 19:16Z: "For
 * text case line rolls instead of per chars"). One move, two modes, one easing and one duration:
 *  - digits: every digit column is a vertical reel in an overflow-hidden mask; the value rolls continuously, and a column
 *    left of the units turns IN STEP with the digits to its right passing 8 → 9 → 0 (a carry slides, never swaps; 099 → 100
 *    rolls all three columns together).
 *  - line: each text line sits in one mask; the old line rolls out upwards as the new line rolls in from below, as a whole.
 * Reduced motion: an instant change. The preloader counter (Intro.tsx + the inline shell in index.html) is the reference.
 * Use: `createRoller(el, { mode: 'digits', digits: 3 }).set(42)` or `createRoller(el, { mode: 'line' }).set('New line')`;
 * in React, <MaskedRoll mode="digits" value={42} digits={3} /> or <MaskedRoll mode="line" text="…" />.
 */
export const ROLL_EASE = HOUSE.IN               // expo-out, the house entrance curve
export const ROLL_EASE_CSS = HOUSE.CSS_IN
export const ROLL_DURATION = HOUSE.DUR_UI       // seconds
/** the carry window, in units of the column to the right: the column turns while those digits pass 8 → 10 */
export const ROLL_CARRY = 2
const ease = cssBezier(...ROLL_EASE)
const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
/** unwrapped reel positions (leftmost first) for a continuous value: the odometer with an in-step carry */
export function rollPositions(v: number, digits: number, carry = ROLL_CARRY): number[] {
  const out: number[] = []
  for (let i = 0; i < digits; i++) {
    const p = digits - 1 - i
    if (!p) { out.push(v); continue }
    const u = Math.pow(10, p), b = Math.floor(v / u), lower = v - b * u
    out.push(b + smooth((lower - (u - carry)) / carry))
  }
  return out
}
/** paint reels (each `.odo__strip` holds 0–9 three times; the middle copy is the window) */
export function paintReels(strips: ArrayLike<HTMLElement>, pos: number[]) {
  for (let i = 0; i < strips.length; i++) {
    const m = ((pos[i] % 10) + 10) % 10
    strips[i].style.transform = `translate3d(0, ${(-(m + 10) * 100 / 30).toFixed(3)}%, 0)`
  }
}
/** the reel markup (span.odo > span.odo__col > span.odo__strip > 30 spans), styled by .odo in app.css */
export function buildReels(digits: number): HTMLElement {
  const odo = document.createElement('span'); odo.className = 'odo'; odo.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < digits; i++) {
    const col = document.createElement('span'); col.className = 'odo__col'
    const strip = document.createElement('span'); strip.className = 'odo__strip'
    for (let k = 0; k < 30; k++) { const d = document.createElement('span'); d.textContent = String(k % 10); strip.appendChild(d) }
    col.appendChild(strip); odo.appendChild(col)
  }
  return odo
}

export type Roller = { set(next: number | string): void; destroy(): void }
export function createRoller(el: HTMLElement, o: { mode: 'digits'; digits?: number; value?: number } | { mode: 'line'; text?: string }): Roller {
  let raf = 0
  if (o.mode === 'digits') {
    const n = o.digits ?? 3
    let v = o.value ?? 0
    const odo = el.querySelector<HTMLElement>('.odo') ?? el.appendChild(buildReels(n))
    const strips = odo.querySelectorAll<HTMLElement>('.odo__strip')
    paintReels(strips, rollPositions(v, n))
    return {
      set(next) {
        const to = Math.max(0, Number(next)); cancelAnimationFrame(raf)
        if (reduced() || to === v) { v = to; paintReels(strips, rollPositions(v, n)); return }
        const from = v, t0 = performance.now()
        const step = (now: number) => {
          const k = Math.min(1, (now - t0) / (ROLL_DURATION * 1000))
          v = from + (to - from) * ease(k); paintReels(strips, rollPositions(v, n))
          if (k < 1) raf = requestAnimationFrame(step)
        }
        raf = requestAnimationFrame(step)
      },
      destroy() { cancelAnimationFrame(raf) },
    }
  }
  // line mode: one mask, the whole line moves
  el.style.display = el.style.display || 'block'
  el.style.overflow = 'hidden'; el.style.position = el.style.position || 'relative'
  let cur = document.createElement('span'); cur.style.display = 'block'; cur.textContent = o.text ?? el.textContent ?? ''
  el.replaceChildren(cur)
  return {
    set(next) {
      const text = String(next); if (text === cur.textContent) return
      cancelAnimationFrame(raf)
      const nu = document.createElement('span'); nu.style.display = 'block'; nu.textContent = text
      if (reduced()) { el.replaceChildren(nu); cur = nu; return }
      // the old line stays in flow (keeps the height) and leaves upwards; the new one rides in from below
      nu.style.position = 'absolute'; nu.style.left = '0'; nu.style.right = '0'; nu.style.top = '0'; nu.style.transform = 'translate3d(0, 100%, 0)'
      for (const c of [...el.children]) if (c !== cur) c.remove()
      el.appendChild(nu)
      const old = cur, t0 = performance.now()
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / (ROLL_DURATION * 1000)), e = ease(k)
        old.style.transform = `translate3d(0, ${(-100 * e).toFixed(3)}%, 0)`
        nu.style.transform = `translate3d(0, ${(100 * (1 - e)).toFixed(3)}%, 0)`
        if (k < 1) { raf = requestAnimationFrame(step); return }
        nu.style.position = ''; nu.style.transform = ''; old.remove()
      }
      cur = nu
      raf = requestAnimationFrame(step)
    },
    destroy() { cancelAnimationFrame(raf) },
  }
}
