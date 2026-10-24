/**
 * R7.07 PHONE SCROLLER (Shifat 1:17–1:20 PM Oct 24: "100svh. So in phone height never grows or shrinks." / "Don't let
 * phone address bar hide."). Browsers only slide the address bar away when the DOCUMENT scrolls, so on touch phones the
 * page scrolls inside one inner scroller (#root: html and body are 100svh and overflow hidden, #root overflow-y auto,
 * overscroll-behavior-y contain — so the bar stays put and pull-to-refresh is off on the site). Everything that read
 * window.scrollY / scrollTo / the window's scroll event / the document's scrollHeight goes through here: one source of
 * truth for the scroll offset. Desktop, PC and tablet: the document scrolls exactly as before. ?docscroll = the old way.
 */
import { PHONE } from '../core/viewport'

export const INNER = PHONE && typeof location !== 'undefined' && !/[?&]docscroll\b/.test(location.search)
let el: HTMLElement | null = null
if (INNER && typeof document !== 'undefined') document.documentElement.classList.add('vp-inner')
function host(): HTMLElement { return (el ??= document.getElementById('root') ?? document.body) }   // R7.07 2:52 PM: #root is the scroller
export const scrollHost = {
  inner: INNER,
  /** the page's scroll offset (css px) */
  y(): number { return INNER ? host().scrollTop : window.scrollY },
  /** jump the page to y (no smooth behaviour) */
  set(y: number) { if (INNER) host().scrollTop = y; else window.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior }) },
  /** the scrollable content height */
  height(): number { return INNER ? host().scrollHeight : document.documentElement.scrollHeight },
  /** the height of the scrolling viewport */
  view(): number { return INNER ? host().clientHeight : window.innerHeight },
  /** the page's scroll limit */
  max(): number { return Math.max(0, this.height() - this.view()) },
  /** R7.07: watch the page's CONTENT size with ro (the #root scroller itself is a fixed 100svh box that never resizes, so its
   *  children are observed, including ones React mounts later); the document scroll watches the body as before */
  observe(ro: ResizeObserver) {
    if (!INNER) { ro.observe(document.body); return }
    const h = host()
    for (const c of Array.from(h.children)) ro.observe(c)
    new MutationObserver((ms) => { for (const m of ms) m.addedNodes.forEach((n) => { if (n instanceof Element) ro.observe(n) }) }).observe(h, { childList: true })
  },
  /** the element that fires the page's scroll events */
  target(): EventTarget { return INNER ? host() : window },
}
if (typeof window !== 'undefined') (window as any).__sh = scrollHost

/**
 * R7.07 (Shifat 2:09 PM real phone: page stuck short of the end, no rubber band, no gift sticker). A finger that lands on a
 * position:fixed layer (the footer, the header, the canvas) is not inside the #root scroller: Chrome chains that gesture to
 * the document, which cannot scroll, so the page never reached its end (and a gesture on the document is what can move
 * the address bar). Those touches are carried to the #root scroller here: the finger's travel 1:1, then a short glide.
 * Taps are untouched (nothing happens until the finger moves); menus, overlays and the gift scene keep their own touch.
 */
if (INNER && typeof window !== 'undefined') {
  const SKIP = '.menu, .overlay, .gift, .intro, .menu-scrim, input, textarea, select'
  let fwd = false, lastY = 0, lastT = 0, v = 0, raf = 0
  const fixedLayer = (t: EventTarget | null): boolean => {
    let e = t instanceof Element ? t : null
    if (!e || e.closest(SKIP)) return false
    for (; e && e !== document.body && e !== document.documentElement; e = e.parentElement)
      if (getComputedStyle(e).position === 'fixed') return true
    return false
  }
  const glide = () => {
    let prev = performance.now()
    const step = (t: number) => {
      const dt = Math.min(48, t - prev); prev = t
      const b = host(), y0 = b.scrollTop
      b.scrollTop = y0 + v * dt
      v *= Math.exp(-dt / 325)
      if (Math.abs(v) < 0.02 || b.scrollTop === y0) { raf = 0; return }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }
  window.addEventListener('touchstart', (e) => {
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    fwd = e.touches.length === 1 && fixedLayer(e.target)
    lastY = e.touches[0]?.clientY ?? 0; lastT = performance.now(); v = 0
  }, { passive: true })
  window.addEventListener('touchmove', (e) => {
    if (!fwd || e.defaultPrevented || e.touches.length !== 1) return
    if (e.cancelable) e.preventDefault()
    const y = e.touches[0].clientY, t = performance.now(), dy = lastY - y
    host().scrollTop += dy
    const dt = Math.max(1, t - lastT)
    v = 0.8 * (dy / dt) + 0.2 * v
    lastY = y; lastT = t
  }, { passive: false })
  const end = () => {
    if (!fwd) return
    fwd = false
    if (performance.now() - lastT > 80) v = 0
    if (Math.abs(v) > 0.1) glide()
  }
  window.addEventListener('touchend', end, { passive: true })
  window.addEventListener('touchcancel', () => { fwd = false; v = 0 }, { passive: true })
}

