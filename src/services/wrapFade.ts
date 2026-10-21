/**
 * W21 — the loop wrap without a jump cut (Shifat 19:12Z "No pop ok? No jump cut", the wrap included) and without a
 * veil (Shifat 18:47Z: the stone must never disappear at the wrap).
 *
 * The frame the visitor is looking at when the loop fires (the CTA curtain lifted over the footer) is frozen: the GL
 * canvas is copied right after it was drawn (Scene calls grab() after the chain renders, while the drawing buffer is
 * still intact), and the footer's DOM is cloned beside it. That still sits over the page while the page jumps to the
 * hero underneath, then dissolves away (0.5 s; the dark curtain part clears first, see grab()). Nothing is hidden behind a flat colour: the hero, its stone and its
 * name come up THROUGH the outgoing frame. If no frame can be grabbed (no GL, a skipped frame), the wrap jumps as
 * before. QA: ?wrapfade=<ms> slows the dissolve.
 */
const q = /[?&]wrapfade=(\d+)/.exec(location.search)
const QA_MS = q ? +q[1] : 0

export const wrapFade = {
  want: false,
  go: null as null | (() => void),
  timer: 0,
  start(go: () => void): boolean {
    if (this.want || document.documentElement.classList.contains('no-gl')) return false
    this.want = true; this.go = go
    // a frame that never comes (a paused loop) must not hold the wrap: jump plain after 150 ms
    this.timer = window.setTimeout(() => { if (!this.want) return; this.want = false; const g = this.go; this.go = null; g?.() }, QA_MS ? 8000 : 150)   // QA: a slow remote rig draws a frame every second or two
    return true
  },
  grab(src: HTMLCanvasElement) {
    if (!this.want) return
    this.want = false; clearTimeout(this.timer)
    const go = this.go; this.go = null
    let ov: HTMLDivElement | null = null
    try {
      ov = document.createElement('div')
      ov.className = 'wrap-fade'; ov.setAttribute('aria-hidden', 'true'); (ov as any).inert = true
      const foot = document.querySelector('.site-footer') as HTMLElement | null
      if (foot) {
        const fc = foot.cloneNode(true) as HTMLElement
        fc.removeAttribute('id'); fc.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'))
        fc.style.zIndex = fc.classList.contains('site-footer--world') ? '2' : '0'   // FOOTER MOCKUP: its world is in the frozen canvas below it
        ov.appendChild(fc)
      }
      const r = src.getBoundingClientRect()
      const c = document.createElement('canvas'); c.width = src.width; c.height = src.height
      c.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`
      const ctx = c.getContext('2d'); if (!ctx) throw new Error('2d')
      ctx.drawImage(src, 0, 0)
      ov.appendChild(c)
      document.body.appendChild(ov)
    } catch (e) { ov?.remove(); ov = null }
    go?.()
    if (!ov) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const ms = QA_MS || (reduced ? 220 : 520)
    const el = ov
    // the frozen frame is dark above (the curtain) and paper below (the footer), the hero is light: one shared fade
    // passes the top through grey while the bottom stays light, a seam across the stone for a moment. So the dark part
    // clears first (40 % of the time) and the paper part, already close to the hero's own tone, fades over the whole
    // time: no frame shows a dark half against a light one.
    const parts = Array.from(el.children) as HTMLElement[]
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const p of parts) {
        const dark = p.tagName === 'CANVAS', t = dark ? Math.round(ms * 0.4) : ms
        p.style.transition = `opacity ${t}ms cubic-bezier(${dark ? '0.2, 0.7, 0.3, 1' : '0.4, 0, 0.2, 1'})`
        p.style.opacity = '0'
      }
      window.setTimeout(() => el.remove(), ms + 120)
    }))
  },
}
;(window as any).__wrapFade = wrapFade
