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

let pull = 0
let lastPush = -1e9
let restSince = -1
let fingerDown = false
let fingerY = 0
let bound = false
let atEnd = () => false

const now = () => performance.now() / 1000
const armed = () => restSince > 0 && now() - restSince >= ARM
function push(v: number) {
  if (!armed() || !atEnd()) return
  pull = Math.min(1, pull + v)
  lastPush = now()
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
    else if (dy < 0) pull = Math.max(0, pull + dy / WHEEL_K * 3)
  }, pv)
  window.addEventListener('touchstart', (e) => { fingerDown = e.touches.length === 1; fingerY = e.touches[0]?.clientY ?? 0 }, pv)
  window.addEventListener('touchmove', (e) => {
    if (!fingerDown || e.touches.length !== 1) return
    const y = e.touches[0].clientY, dy = y - fingerY
    fingerY = y
    const vh = props.height || window.innerHeight
    if (dy < 0) push(-dy / (TOUCH_K * vh))
    else if (dy > 0) pull = Math.max(0, pull - dy / (TOUCH_K * vh) * 2)
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
  init(isAtEnd: () => boolean) { atEnd = isAtEnd; bind() },
  reset() { pull = 0; lastPush = -1e9; restSince = -1 },
  /** once per frame: dt in s; atRest = the page sits at the footer and nothing is gliding it */
  step(dt: number, atRest: boolean) {
    const t = now()
    if (atRest) { if (restSince < 0) restSince = t } else { restSince = -1; pull = Math.max(0, pull - dt * SPRING * 2 * pull) }
    dt = Math.min(dt, 0.1)
    if (pull <= 0) return 0
    pull = Math.max(0, pull - LEAK * dt)
    if (!fingerDown && t - lastPush > GRACE) pull *= Math.exp(-SPRING * dt)
    if (pull < 0.002) pull = 0
    return pull
  },
}
;(window as any).__loopPull = loopPull
