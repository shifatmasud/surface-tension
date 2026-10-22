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

function hold(on: boolean) {
  if (held === on) return
  held = on; props.sceneHold = on
  if (on) scroll.stop(); else scroll.start()
}

export function giftOpen(from?: HTMLElement | null) {
  if (state !== 'idle') return
  state = 'open'
  back = from ?? (document.activeElement as HTMLElement | null)
  const el = document.createElement('div')
  el.className = 'gift'
  el.setAttribute('role', 'dialog'); el.style.outline = 'none'; el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Surface Tension')
  const bg = document.createElement('canvas'); bg.className = 'gift__bg'; bg.setAttribute('aria-hidden', 'true')
  const tint = document.createElement('div'); tint.className = 'gift__tint'; tint.setAttribute('aria-hidden', 'true')
  el.append(bg, tint)
  document.body.appendChild(el); root = el
  document.documentElement.classList.add('gift-open')
  const show = () => requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-in')))
  // the frame is copied right after the scene draws it (the drawing buffer is only intact inside that task)
  let done = false
  const fallback = () => { if (done) return; done = true; engine.grab = null; el.classList.add('gift--live'); hold(true); show() }
  if (engine.canvas && engine.warm && !document.documentElement.classList.contains('no-gl')) {
    engine.grab = (src) => { if (done) return; done = true; try { blurInto(bg, src) } catch { el.classList.add('gift--live') } hold(true); show() }
    setTimeout(fallback, 250)
  } else fallback()
  import('./GiftStage').then((m) => {
    if (state !== 'open' || root !== el) return
    stage = m.mountGift(el, { reduced: reduced(), close: giftClose })
  }).catch(() => { /* offline: the blurred page and the close path still work */ })
  // Esc closes from the first moment, even before the stage arrives; focus moves into the dialog at once
  document.addEventListener('keydown', onEsc, true)
  el.tabIndex = -1; el.focus({ preventScroll: true })
  el.addEventListener('click', (e) => { if (e.target === el || e.target === tint || e.target === bg) giftClose() })
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
