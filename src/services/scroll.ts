import Lenis from 'lenis'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { props } from '../state/props'
import { clamp, damp } from '../core/math'

gsap.registerPlugin(ScrollTrigger)

/**
 * Layer 3 — scroll service (handbook ch.5.2–5.4). Lenis gives the eased virtual scroll with fling;
 * ScrollTrigger reads Lenis, and both are ticked by the one GSAP clock (see app/clock.ts).
 */
class ScrollService {
  lenis!: Lenis
  private last = 0
  init() {
    this.lenis = new Lenis({
      duration: 1.15,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), // exp ease, fast then long settle
      smoothWheel: true,
      syncTouch: false,
      touchMultiplier: 1.4,
      autoRaf: false,
    })
    this.lenis.on('scroll', ScrollTrigger.update)
    this.stop()
  }
  stop() { this.lenis?.stop() }
  start() { this.lenis?.start() }
  raf(timeMs: number) { this.lenis.raf(timeMs) }
  update(dt: number) {
    const s = this.lenis.scroll
    props.scrollDelta = s - this.last
    this.last = s
    props.scroll = s
    props.scrollLimit = Math.max(1, this.lenis.limit)
    props.scrollProgress = clamp(s / props.scrollLimit)
    props.scrollVel = this.lenis.velocity
    // scroll strength: a 0..1 smoothed "how hard are we scrolling" signal used by bends and audio
    props.scrollStrength = damp(props.scrollStrength, clamp(Math.abs(this.lenis.velocity) / 40), 6, dt)
  }
  scrollTo(target: number | string | HTMLElement, opts: { duration?: number; immediate?: boolean } = {}) {
    this.lenis.scrollTo(target as any, { duration: opts.duration ?? 1.6, immediate: opts.immediate, easing: (t: number) => 1 - Math.pow(1 - t, 4) })
  }
}
export const scroll = new ScrollService()
;(window as any).__scroll = scroll

/**
 * ScrollDomRange equivalent (ch.5.4), written fresh. For an element, every frame:
 *  ratio:       -1 entering from below → 0 while it covers its range → +1 leaving at the top
 *  screenRatio: one linear -1 → 1 across the whole time it is visible
 *  progress:    0 → 1 from its top hitting the viewport bottom to its bottom leaving the top
 *  isActive:    on screen at all
 * Rects are measured on resize only (docTop), scroll is added each frame — no layout thrash.
 */
export class DomRange {
  docTop = 0; height = 0; docLeft = 0; width = 0
  ratio = 0; screenRatio = 0; progress = 0; isActive = false
  constructor(public el: HTMLElement) { this.measure() }
  measure() {
    const r = this.el.getBoundingClientRect()
    this.docTop = r.top + window.scrollY; this.height = r.height
    this.docLeft = r.left + window.scrollX; this.width = r.width
  }
  update() {
    const vh = props.height
    const top = this.docTop - props.scroll
    const bottom = top + this.height
    this.isActive = bottom > 0 && top < vh
    this.progress = clamp((vh - top) / (vh + this.height))
    this.screenRatio = this.progress * 2 - 1
    const range = Math.max(1, this.height - vh)
    if (top > 0) this.ratio = -clamp(top / vh)
    else if (bottom < vh) this.ratio = clamp((vh - bottom) / vh)
    else this.ratio = 0
    void range
    return this
  }
}
