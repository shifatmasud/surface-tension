/**
 * R6.83 GIFT (Shifat Oct 22 07:03 PT, option A: "A but card appears closed beautifully wrapped, then users clicks on box
 * hitzone to click & open. Everything must feel alive & premium quality worthy"; 07:04 "Card should feel to be in same
 * scene but its background must be blurred"; 07:04 "No jump cut, pop. Smooth gentle anim in out").
 *
 * The logo (nav + footer) opens a dialog over the page. This file is the only part in the main bundle (~2 KB): it freezes
 * the frame the visitor is looking at (copied right after the scene drew it, like the loop wrap), blurs that still ONCE
 * at a tiny size and lays it over the page as a cross-fade (sharp → blurred, a compositor-only opacity), then holds the
 * main scene's frame loop while the dialog is open (nothing of the page renders under an opaque still). The WebGL gift
 * box itself (./GiftStage) is a dynamic import fetched on the first click only; its small context is destroyed on close.
 */
import { engine } from '../../gl/engine'
import { props } from '../../state/props'
import { scroll } from '../../services/scroll'

type Stage = { close(): Promise<void> }
/** R7.09 QA: a step of the open, in ms since the tap (window.__giftT) */
export function giftMark(k: string) { const T = (window as any).__giftT; if (T && T[k] === undefined) T[k] = Math.round(performance.now() - T.tap) }
let state: 'idle' | 'open' | 'closing' = 'idle'
let root: HTMLDivElement | null = null
let stage: Stage | null = null
let back: HTMLElement | null = null
let held = false

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** the frozen frame, blurred once at ~1/8 size; drawn back up by the browser (bilinear), so it costs nothing per frame */
function blurInto(bg: HTMLCanvasElement, src: HTMLCanvasElement) {
  const W = Math.max(48, Math.round(innerWidth / 6)), H = Math.max(48, Math.round(innerHeight / 6))
  bg.width = W; bg.height = H
  const g = bg.getContext('2d')!
  // a halving first (a box-filter pyramid), then the soft blur at the small size
  const t = document.createElement('canvas'); t.width = W * 2; t.height = H * 2
  const tg = t.getContext('2d')!
  tg.imageSmoothingQuality = 'high'
  tg.drawImage(src, 0, 0, t.width, t.height)
  g.drawImage(t, 0, 0, W, H)                          // the sharp copy fills the edges the blur would pull in
  if ('filter' in (g as object)) { (g as CanvasRenderingContext2D).filter = 'blur(2.5px) saturate(1.08)'; g.drawImage(t, 0, 0, W, H); g.filter = 'none' }
  else { g.globalAlpha = 0.5; for (const d of [-2, 2]) { g.drawImage(bg, d, 0); g.drawImage(bg, 0, d) } g.globalAlpha = 1 }
}

/** the dialog shell: the frozen-frame canvas and the tint (the stage adds its own layers) */
function makeEl() {
  const el = document.createElement('div')
  el.className = 'gift'
  el.setAttribute('role', 'dialog'); el.style.outline = 'none'; el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Surface Tension')
  const bg = document.createElement('canvas'); bg.className = 'gift__bg'; bg.setAttribute('aria-hidden', 'true')
  const tint = document.createElement('div'); tint.className = 'gift__tint'; tint.setAttribute('aria-hidden', 'true')
  el.append(bg, tint)
  return { el, bg }
}

/**
 * R7.09 GIFT PREWARM (Shifat 10:00 PM: "Gift scene ... too slow to trigger. & jittery. Frame drops"). Measured on 7.08
 * (sim, 412 lowend): tap -> box visible ~3.5 s, of which ~0.6 s was the new WebGL context, ~0.6 s building the scene and
 * ~2.2 s linking every shader on the first draw (his phone has no parallel shader compile). The stage is now built ahead of
 * the tap, off screen, in slices of one frame each (GiftStage mountGiftParked), its programs submitted one object per
 * frame, drawn once, and parked; the tap only reveals it. Started from the preloader (Scene.tsx, once the hero's own
 * programs are linked), and again a few seconds after each close. ?giftold = the 7.08 tap path.
 */
let parked: { el: HTMLDivElement; bg: HTMLCanvasElement; stage: Stage & { show?: () => void } } | null = null
let warming = false
const GIFT_OLD = typeof location !== 'undefined' && /[?&]giftold\b/.test(location.search)
export function giftPrewarm() {
  if (GIFT_OLD || parked || warming || state !== 'idle') return
  if (!engine.canvas || document.documentElement.classList.contains('no-gl')) return
  warming = true
  const shell = makeEl()
  import('./GiftStage').then(async (m) => {
    const s = await m.mountGiftParked(shell.el, { reduced: reduced(), close: giftClose })
    warming = false
    if (shell.el.classList.contains('gift--flat') || !s.show) { void s.close(); return }   // no WebGL here: the tap path stays
    parked = { ...shell, stage: s }
  }).catch(() => { warming = false })
}
;(window as any).__giftPark = () => ({ parked: !!parked, warming })

function hold(on: boolean) {
  if (held === on) return
  held = on; props.sceneHold = on
  if (on) scroll.stop(); else scroll.start()
}

export function giftOpen(from?: HTMLElement | null) {
  if (state !== 'idle') return
  state = 'open'
  ;(window as any).__giftT = { tap: performance.now() }   // R7.09 QA: the open's timeline (ms since the tap)
  back = from ?? (document.activeElement as HTMLElement | null)
  // R7.09: a stage parked ahead of the tap (giftPrewarm) is taken as is: its dialog, built and linked, only waits to be shown
  const pk = parked; parked = null
  const { el, bg } = pk ?? makeEl()
  document.body.appendChild(el); root = el
  if (pk) { stage = pk.stage; giftMark('parkedTaken') }
  document.documentElement.classList.add('gift-open')
  const show = () => { if (pk) pk.stage.show?.(); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-in'))) }
  // the frame is copied right after the scene draws it (the drawing buffer is only intact inside that task)
  let done = false
  const fallback = () => { if (done) return; done = true; engine.grab = null; el.classList.add('gift--live'); hold(true); show() }
  if (engine.canvas && engine.warm && !document.documentElement.classList.contains('no-gl')) {
    engine.grab = (src) => { if (done) return; done = true; try { blurInto(bg, src) } catch { el.classList.add('gift--live') } hold(true); show() }
    setTimeout(fallback, 250)
  } else fallback()
  if (!pk) import('./GiftStage').then((m) => {
    giftMark('imported')
    if (state !== 'open' || root !== el) return
    stage = m.mountGift(el, { reduced: reduced(), close: giftClose })
  }).catch(() => { /* offline: the blurred page and the close path still work */ })
  // Esc closes from the first moment, even before the stage arrives; focus moves into the dialog at once
  document.addEventListener('keydown', onEsc, true)
  el.tabIndex = -1; el.focus({ preventScroll: true })
  el.addEventListener('click', (e) => { const t = e.target as HTMLElement | null; if (e.target === el || e.target === bg || (t && t.classList && t.classList.contains('gift__tint'))) giftClose() })
}

function onEsc(e: KeyboardEvent) { if (e.key === 'Escape' && state === 'open') { e.preventDefault(); e.stopPropagation(); giftClose() } }

export async function giftClose() {
  if (state !== 'open' || !root) return
  state = 'closing'
  document.removeEventListener('keydown', onEsc, true)
  const el = root
  hold(false)   // the live page resumes UNDER the still, so the still fades into the moving scene, not into a frozen one
  el.classList.remove('is-in'); el.classList.add('is-out')
  const st = stage; stage = null
  await Promise.all([st?.close(), new Promise((r) => setTimeout(r, reduced() ? 180 : 720))])
  el.remove(); root = null
  document.documentElement.classList.remove('gift-open')
  state = 'idle'
  // R7.09: park the next one about a second after the close, in an idle moment (the reopen is instant too)
  setTimeout(() => { const ric = (window as any).requestIdleCallback as ((f: () => void, o?: { timeout: number }) => void) | undefined; if (ric) ric(giftPrewarm, { timeout: 2000 }); else giftPrewarm() }, 1000)
  const b = back; back = null
  if (b && b.isConnected) b.focus({ preventScroll: true })
}

/** wires a logo element: click / Enter / Space opens the gift (the logo's look is untouched) */
export function giftTrigger(e: { preventDefault(): void; currentTarget: EventTarget | null }) {
  e.preventDefault()
  giftOpen(e.currentTarget as HTMLElement)
}
export function giftKey(e: { key: string; preventDefault(): void; currentTarget: EventTarget | null }) {
  if (e.key === 'Enter' || e.key === ' ') giftTrigger(e)
}
;(window as any).__gift = { open: giftOpen, close: giftClose }
