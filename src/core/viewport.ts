/**
 * R7.07 VIEWPORT (Shifat 12:02/12:03 Oct 24: "svh will work better for phone", "Dvh looked best in desktop").
 * One stable viewport size for every JS reader (props.width/height mirror it). Desktop / mouse: exactly innerWidth x
 * innerHeight, every resize (as before). Touch phones/tablets (pointer: coarse): the height is the LARGE viewport (the
 * browser's 100lvh, read once per real change), and a height-only change under ADDR_BAR_PX with the same width is the
 * address bar sliding: ignored, so no canvas / render-target re-allocation, no re-measure and no scroll reset. A width or
 * orientation change (or a keyboard-sized height change) is a real resize. The fixed canvas layers take --app-h.
 */
export const COARSE = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches
export const ADDR_BAR_PX = 120
/** R7.07 (Shifat 1:17 PM): a touch PHONE (not a tablet: its short screen side under 600 css px) runs on one fixed height,
 *  100svh, for everything (sections, the 3D canvas, the overlays, the JS height); with the inner scroller (scrollHost.ts)
 *  the address bar never slides, so that height never changes. Tablets and desktops: the window, as before. */
export const PHONE = COARSE && typeof screen !== 'undefined' && Math.min(screen.width || 9999, screen.height || 9999) < 600

let probe: HTMLDivElement | null = null
const BAR_QA = typeof location !== 'undefined' ? Math.max(0, parseInt(new URLSearchParams(location.search).get('vpbar') || '0', 10) || 0) : 0
function largeH(): number {
  const ih = window.innerHeight
  if (COARSE && !PHONE && BAR_QA) return ih + BAR_QA   // QA: ?vpbar=56 = a tablet with its address bar showing (large viewport 56 px taller)
  if (typeof document === 'undefined' || !document.body) return ih
  if (!probe) {
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:fixed;left:-10px;top:0;width:1px;height:100vh;visibility:hidden;pointer-events:none'
    probe.style.setProperty('height', PHONE ? '100svh' : '100dvh')   // R7.07 3:11 PM: desktop / PC / tablet read 100dvh (was lvh)
    document.body.appendChild(probe)
  }
  const lh = probe.offsetHeight
  return lh > 0 && lh < ih * 1.6 ? lh : ih   // phones 100svh, everything else 100dvh
}

export const viewport = {
  w: typeof window !== 'undefined' ? window.innerWidth : 1,
  h: typeof window !== 'undefined' ? window.innerHeight : 1,
  /** bumps on every accepted (real) change */
  gen: 0,
  /** address-bar moves ignored so far (QA readout) */
  ignored: 0,
  /** the VISIBLE height right now (innerHeight; follows the address bar, read on every resize event, never re-allocates).
   *  The canvas is top-anchored, so anything the page anchors to the screen's BOTTOM (the fixed footer, the curtain's
   *  lift, the CTA pill riding it) maps to canvas y = vis - offset, not h - offset. Desktop: vis = h. */
  vis: typeof window !== 'undefined' ? window.innerHeight : 1,
}
const subs = new Set<() => void>()
function writeCss() {
  if (!COARSE || typeof document === 'undefined') return
  const r = document.documentElement
  r.style.setProperty('--app-h', `${viewport.h}px`)
  r.classList.add('vp-touch')
  if (PHONE) r.classList.add('vp-phone')
}
/** re-read the window; true when the stable size changed (callers then resize/re-measure) */
export function readViewport(): boolean {
  viewport.vis = PHONE ? largeH() : window.innerHeight
  const w = window.innerWidth, h = largeH()
  if (w === viewport.w && h === viewport.h) return false
  if (COARSE && !PHONE && w === viewport.w && Math.abs(h - viewport.h) < ADDR_BAR_PX) { viewport.ignored++; return false }   // tablets: an address-bar slide is not a resize
  viewport.w = w; viewport.h = h; viewport.gen++
  writeCss()
  return true
}
/** subscribe to real (stable) viewport changes; returns the unsubscribe */
export function onViewport(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } }
let inited = false
export function initViewport() {
  if (inited || typeof window === 'undefined') return
  inited = true
  viewport.w = window.innerWidth; viewport.h = largeH(); viewport.vis = PHONE ? viewport.h : window.innerHeight; writeCss()
  window.addEventListener('resize', () => { if (readViewport()) subs.forEach((fn) => fn()) })
  ;(window as any).__vp = viewport
}
