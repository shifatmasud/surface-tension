// Layer 1 — pure maths, no imports: the site's one motion vocabulary (shared by DOM, WAAPI, framer-motion and scroll).
/**
 * HOUSE MOTION (Shifat 15:33Z m:fff1ca11 "make everything premium looking"): two curves, three durations, everywhere.
 * Entrances: expo-out cubic-bezier(0.19, 1, 0.22, 1). Exits and A→B moves: the matching in-out (0.65, 0, 0.35, 1).
 * Idle loops: a sine in-out. Reduced motion: crossfades on the exit curve. No default or linear easing anywhere.
 * The same values live in CSS as --ease / --ease-in-out / --ease-sine and --dur-* (styles/tokens.css).
 */
export const HOUSE = {
  IN: [0.19, 1, 0.22, 1] as [number, number, number, number],
  INOUT: [0.65, 0, 0.35, 1] as [number, number, number, number],
  CSS_IN: 'cubic-bezier(0.19, 1, 0.22, 1)',
  CSS_INOUT: 'cubic-bezier(0.65, 0, 0.35, 1)',
  DUR_IN: 1.0, DUR_OUT: 0.6, DUR_UI: 0.6, DUR_FADE: 0.24,
}
/** a CSS cubic-bezier as a JS easing (Newton–Raphson with a bisection fallback, the browser's own method) */
export function cssBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t
  const sy = (t: number) => ((ay * t + by) * t + cy) * t
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) { const e = sx(t) - x; if (Math.abs(e) < 1e-6) return sy(t); const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= e / d }
    let lo = 0, hi = 1; t = x
    for (let i = 0; i < 24; i++) { const v = sx(t); if (Math.abs(v - x) < 1e-6) break; if (x > v) lo = t; else hi = t; t = (lo + hi) / 2 }
    return sy(t)
  }
}
export const houseIn = cssBezier(...HOUSE.IN)
export const houseInOut = cssBezier(...HOUSE.INOUT)
