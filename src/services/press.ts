import { HOUSE } from '../core/house'
import { browser } from './settings'
import { labGL } from '../gl/stages/lab/labGL'

/**
 * UI STATES (mockup for Shifat 11:23Z: "interactive ui states like hover even on phone"). One press language for every
 * DOM control, mouse, finger and keyboard alike:
 *  - press-in: the control sinks to --press (0.97; 0.94 on the 40 px pills) on the house expo-out in 160 ms
 *  - release: back to 1 on the same expo-out over --dur-ui (0.6 s), so a tap reads as press → settle, never a jump
 *  - a tap shorter than MIN_HOLD still shows the press (iOS gives :active nothing on a quick tap)
 *  - touch waits TOUCH_DELAY before sinking, so a swipe that starts on a control scrolls without a flash; a move past
 *    SLOP px or the browser taking the gesture (pointercancel) releases at once
 *  - Enter / Space on a focused control presses it the same way
 * It animates the CSS `scale` property through WAAPI, separate from `transform` and from every CSS transition list,
 * so the header ink transition, the CTA's translate and the cards' 3D transforms are untouched.
 * The GL work slides get the same press through labGL.press (a vertex-shader scale on a spring; no new pass).
 */
// BUTTON v2: the CTA pill and the sound pill have their own press (services/inkButton.ts)
const SEL = '.pill:not(.pill--sound), .wordmark, .skip-link, .overlay__link, .site-footer__links a, .site-footer__top-link, .lab .card'
const SMALL = '.pill'
const MIN_HOLD = 110, TOUCH_DELAY = 70, SLOP = 10
const PRESS_IN = 160, RELEASE = HOUSE.DUR_UI * 1000

type P = { el: HTMLElement; id: number; t0: number; x: number; y: number; on: boolean; timer: number; anim?: Animation }
let cur: P | null = null

function depth(el: HTMLElement) { return el.matches(SMALL) ? 0.94 : 0.97 }
function now() { return performance.now() }

function sink(p: P) {
  if (p.on) return
  p.on = true; p.t0 = now()
  p.el.classList.add('is-press')
  if (p.el.classList.contains('card') && p.el.dataset.id) labGL.press(p.el.dataset.id, true)
  if (browser.reducedMotion) return
  const from = getComputedStyle(p.el).scale
  p.anim?.cancel()
  p.anim = p.el.animate([{ scale: from === 'none' ? '1' : from }, { scale: String(depth(p.el)) }], { duration: PRESS_IN, easing: HOUSE.CSS_IN, fill: 'forwards' })
}
function rise(p: P) {
  clearTimeout(p.timer)
  if (!p.on) return
  const go = () => {
    p.on = false
    p.el.classList.remove('is-press')
    if (p.el.classList.contains('card') && p.el.dataset.id) labGL.press(p.el.dataset.id, false)
    if (browser.reducedMotion || !p.anim) return
    const from = getComputedStyle(p.el).scale
    p.anim.cancel()
    p.anim = p.el.animate([{ scale: from === 'none' ? '1' : from }, { scale: '1' }], { duration: RELEASE, easing: HOUSE.CSS_IN })
  }
  const held = now() - p.t0
  if (held >= MIN_HOLD) go(); else window.setTimeout(go, MIN_HOLD - held)
}

export function initPress() {
  if (typeof window === 'undefined') return
  const opts = { passive: true, capture: true } as AddEventListenerOptions
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const el = (e.target as Element | null)?.closest?.(SEL) as HTMLElement | null
    if (!el) return
    if (cur) rise(cur)
    const p: P = { el, id: e.pointerId, t0: 0, x: e.clientX, y: e.clientY, on: false, timer: 0 }
    cur = p
    if (e.pointerType === 'touch') p.timer = window.setTimeout(() => { if (cur === p) sink(p) }, TOUCH_DELAY)
    else sink(p)
  }, opts)
  window.addEventListener('pointermove', (e) => {
    const p = cur
    if (!p || e.pointerId !== p.id) return
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) { clearTimeout(p.timer); if (p.on) rise(p); cur = null }
  }, opts)
  const end = (e: PointerEvent) => {
    const p = cur
    if (!p || e.pointerId !== p.id) return
    cur = null
    if (!p.on && e.type === 'pointerup') sink(p)   // a quick tap under TOUCH_DELAY still shows the press
    rise(p)
  }
  window.addEventListener('pointerup', end, opts)
  window.addEventListener('pointercancel', end, opts)
  window.addEventListener('blur', () => { if (cur) { rise(cur); cur = null } })
  // keyboard: Enter / Space on a focused control press it like a tap
  window.addEventListener('keydown', (e) => {
    if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return
    const el = (document.activeElement as HTMLElement | null)
    if (!el || !el.matches?.(SEL)) return
    const p: P = { el, id: -1, t0: 0, x: 0, y: 0, on: false, timer: 0 }
    sink(p)
    const up = (k: KeyboardEvent) => { if (k.key === e.key) { window.removeEventListener('keyup', up, true); rise(p) } }
    window.addEventListener('keyup', up, true)
  }, true)
}
