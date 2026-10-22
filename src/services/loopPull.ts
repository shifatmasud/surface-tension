import { props } from '../state/props'

/**
 * R6.80 (Shifat Oct 22 04:41 "scroll hard to loop to top"; 04:55 "Rubber band is enough. No snap needed.")
 *
 * Rubber band. The footer is the bottom of the page (no runway any more). Scrolling on past it only stretches the
 * bar; when the input stops it springs back to 0. Only a hard, sustained push (wheel, finger or held key) outruns
 * the leak and fills it, and a full bar loops to the top (the existing wrap, unchanged).
 * Input is read with passive listeners only; per frame it is a handful of multiplies (no layout reads, no DOM writes
 * beyond the bar's --f the page already wrote).
 */
const WHEEL_K = 1150          // raw wheel px (deltaMode-normalised, each event clamped) for a full bar
const WHEEL_CLAMP = 120
const TOUCH_K = 0.6           // × viewport height of finger travel past the end for a full bar
const KEY_STEP = 0.05         // per keydown (held keys repeat ~30/s)
const LEAK = 0.3              // per s, always, so a slow trickle never adds up
const GRACE = 0.13            // s without input before the band springs back
const SPRING = 6.5            // per s, exponential return to 0
const ARM = 0.3               // s resting at the footer before input counts (the arrival's own inertia never fills it)
// R6.81 (Shifat Oct 22 05:12 "When fill is 80% auto fill to 100% and loop back to top & stop scroll a bit moment", option B):
// past COMMIT it is the point of no return: a tiny buzz (Android; only once the visitor has tapped the page, the browser's
// own rule, so no console noise), then the bar fills itself to 100 % over AUTO s (ease out) and loops; nothing drains it
const COMMIT = 0.8
const AUTO = 0.3

let pull = 0
let lastPush = -1e9
let restSince = -1
let fingerDown = false
let fingerY = 0
let bound = false
let atEnd = () => false
let cAt = -1                  // s when the bar passed COMMIT (-1: not committed)
let cFrom = 0

const now = () => performance.now() / 1000
const armed = () => restSince > 0 && now() - restSince >= ARM
function buzz() {
  try {
    const n = navigator as any
    if (typeof n.vibrate === 'function' && (!n.userActivation || n.userActivation.hasBeenActive)) n.vibrate(10)
  } catch { /* no haptics here */ }
}
function commit() {
  if (cAt >= 0) return
  // the bar never drew past COMMIT before this (it draws once per frame), so a big last push still gets the full 0.3 s fill
  pull = Math.min(pull, COMMIT)
  cAt = now(); cFrom = pull
  buzz()
}
function push(v: number) {
  if (cAt >= 0 || !armed() || !atEnd()) return
  pull = Math.min(1, pull + v)
  lastPush = now()
  if (pull >= COMMIT) commit()
}

function bind() {
  if (bound) return
  bound = true
  const pv = { passive: true } as AddEventListenerOptions
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return
    let dy = e.deltaY
    if (Math.abs(e.deltaX) > Math.abs(dy)) return
    if (e.deltaMode === 1) dy *= 40; else if (e.deltaMode === 2) dy *= 800
    if (dy > 0) push(Math.min(dy, WHEEL_CLAMP) / WHEEL_K)
    else if (dy < 0 && cAt < 0) pull = Math.max(0, pull + dy / WHEEL_K * 3)
  }, pv)
  window.addEventListener('touchstart', (e) => { fingerDown = e.touches.length === 1; fingerY = e.touches[0]?.clientY ?? 0 }, pv)
  window.addEventListener('touchmove', (e) => {
    if (!fingerDown || e.touches.length !== 1) return
    const y = e.touches[0].clientY, dy = y - fingerY
    fingerY = y
    const vh = props.height || window.innerHeight
    if (dy < 0) push(-dy / (TOUCH_K * vh))
    else if (dy > 0 && cAt < 0) pull = Math.max(0, pull - dy / (TOUCH_K * vh) * 2)
  }, pv)
  const up = () => { fingerDown = false }
  window.addEventListener('touchend', up, pv)
  window.addEventListener('touchcancel', up, pv)
  window.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const t = e.target as HTMLElement | null
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) push(KEY_STEP)
  })
}

export const loopPull = {
  get value() { return pull },
  get committed() { return cAt >= 0 },
  init(isAtEnd: () => boolean) { atEnd = isAtEnd; bind() },
  reset() { pull = 0; lastPush = -1e9; restSince = -1; cAt = -1 },
  /** once per frame: dt in s; atRest = the page sits at the footer and nothing is gliding it */
  step(dt: number, atRest: boolean) {
    const t = now()
    if (cAt >= 0) {   // R6.81: committed: ease to 1 (the page wraps on 1), whatever the input or position does
      const k = Math.min(1, (t - cAt) / AUTO)
      pull = cFrom + (1 - cFrom) * (1 - (1 - k) ** 3)
      return pull
    }
    if (atRest) { if (restSince < 0) restSince = t } else { restSince = -1; pull = Math.max(0, pull - dt * SPRING * 2 * pull) }
    dt = Math.min(dt, 0.1)
    if (pull <= 0) return 0
    pull = Math.max(0, pull - LEAK * dt)
    if (!fingerDown && t - lastPush > GRACE) pull *= Math.exp(-SPRING * dt)
    if (pull < 0.002) pull = 0
    if (pull >= COMMIT) { commit(); return pull }
    return pull
  },
}
;(window as any).__loopPull = loopPull
