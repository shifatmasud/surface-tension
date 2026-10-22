import { props } from '../state/props'
import { clamp, damp } from '../core/math'
import { houseInOut } from '../core/house'
import { wrapFade } from './wrapFade'

/**
 * Layer 3 — virtual scroll (handbook ch.5.2–5.4), written fresh after Lusion's ScrollPane.
 *
 * The browser never scrolls on its own any more: wheel, touch and keys are captured, turned into one virtual
 * scroll position by the same physics Lusion uses, and that position is applied once per frame inside the one
 * clock (app/clock.ts), before sections and GL read it — DOM and WebGL move in the same frame, every frame.
 *
 *   wheel / keys / anchors / scrollTo   target += Δ (wheel Δ normalised, clamped ±200 px per event);
 *                                       current += (target − current)·(1 − e^(−12·dt))     ← Lusion wheelEaseCoeff 12
 *   finger down                         1:1 follow, direction locked on the first move, last 0.1 s of samples kept
 *   finger up                           v = time-weighted mean of those samples;
 *                                       v += −mix(2.1, 1.9, |v / vh / 5|)·v·dt          ← Lusion friction 2.1 → 1.9
 *
 * Carrier. Lusion moves #page-container with translate3d and keeps window.scrollY at 0. This page pins its
 * scenes with position: sticky and relies on native focus / find-in-page / screen-reader scrolling, so the same
 * value is written to the document's own scroll offset instead (overflow stays native, user scrolling is
 * cancelled at the event). Identical curve and frame timing; sticky, a11y and anchors keep working.
 * Anything the browser scrolls by itself (focus, find-in-page, scrollbar drag, VoiceOver) is adopted.
 *
 * prefers-reduced-motion: reduce → the engine stands down and the page scrolls natively (props still fed).
 */

// ── Lusion ScrollPane / Input constants (120_ScrollPane.js, 008_Input.js) ──
const WHEEL_EASE = 8             // W19 (Shifat 19:44Z "scrolls too fast"): 12 → 8, a softer glide toward the target
const WHEEL_CLAMP = 120          // W19: 200 → 120 px per event (a hard flick no longer throws a section)
const WHEEL_GAIN = 0.6           // W19 (Shifat 19:44Z): each notch / trackpad delta moves the world 60 % as far
const LINE_PX = 40, PAGE_PX = 800 // normalizeWheel LINE_HEIGHT / PAGE_HEIGHT for deltaMode 1 / 2
const MIN_PX = 0.1               // minScrollPixel: snap to target under this
const DRAG_HISTORY = 0.1         // dragHistoryMaxTime, s
const FRICTION_FROM = 2.1, FRICTION_TO = 1.9, FRICTION_DIV = 5
const KEY_STEP = 100             // arrow keys, px

type Tween = { from: number; to: number; t: number; dur: number; ease: (t: number) => number; done?: () => void }
type Sample = { time: number; dt: number; d: number }

const isEditable = (el: Element | null) =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ||
    (el as HTMLElement).isContentEditable)

class ScrollService {
  /** where the page is / wants to be, CSS px */
  scrollPixel = 0
  targetScrollPixel = 0
  velocityPixel = 0
  limit = 1
  /** true while easing toward target (wheel, keys, anchors, scrollTo) */
  isWheelScrolling = false
  isScrolling = false
  /** false = reduced motion or a touch-first phone: the browser scrolls natively and we only read it */
  virtual = true
  /** POLISH (eng #9): on a touch-first device (hover: none, pointer: coarse) the browser's own compositor scroll runs
   *  the page (never blocked by a long main-thread task; the iOS URL bar collapses), with passive touch listeners only.
   *  The scroll → progress mapping is the same (props.scroll = the page's scrollY, read once per frame in the clock);
   *  designed glides (anchors, the header pills) still ease by writing the page scroll, and any touch takes over.
   *  ?vscroll forces the virtual engine back on a phone (A/B). */
  nativeTouch = false
  private reduced = false
  private touchPassive: boolean | null = null
  private stopped = true
  private started = false
  private inited = false
  private last = 0
  private written = -1
  private tween: Tween | null = null
  // per-frame input accumulators (reset each frame, like Input.postUpdate)
  private wheelAcc = 0
  private keyTarget: number | null = null
  // touch
  private touchId: number | null = null
  private touchX = 0; private touchY = 0
  private touchLock: 0 | 1 | 2 = 0 // 0 undecided, 1 vertical (ours), 2 horizontal (left to the element)
  private touchDown = false; private touchWasDown = false
  private dragAcc = 0
  private history: Sample[] = []
  // native scroll the browser did on its own
  private external: number | null = null
  private lastFocusAt = -1e9
  private vw = 0; private vh = 0
  private needsMeasure = true

  init() {
    if (this.inited) return
    this.inited = true
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const tq = window.matchMedia('(hover: none) and (pointer: coarse)')
    const forceVirtual = /[?&]vscroll\b/.test(location.search)
    const apply = () => {
      this.reduced = mq.matches; this.nativeTouch = !forceVirtual && tq.matches
      this.virtual = !this.reduced && !this.nativeTouch
      this.bindTouch()
    }
    apply()
    const onChange = () => { apply(); this.tween = null; this.resetScroll(window.scrollY) }
    mq.addEventListener?.('change', onChange); tq.addEventListener?.('change', onChange)
    document.documentElement.classList.add('vscroll')
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
    const np = { passive: false } as AddEventListenerOptions
    window.addEventListener('wheel', this.onWheel, np)
    window.addEventListener('touchend', this.onTouchEnd, { passive: true })
    window.addEventListener('touchcancel', this.onTouchEnd, { passive: true })
    window.addEventListener('keydown', this.onKey)
    window.addEventListener('scroll', this.onNativeScroll, { passive: true })
    window.addEventListener('focusin', () => { this.lastFocusAt = performance.now() })
    document.addEventListener('click', this.onClick)
    window.addEventListener('hashchange', () => this.toHash(location.hash, false))
    window.addEventListener('resize', () => { this.needsMeasure = true })
    if (window.ResizeObserver) new ResizeObserver(() => { this.needsMeasure = true }).observe(document.body)
    this.measure(true)
    this.resetScroll(window.scrollY)
    this.stop()
  }

  /** touch listeners are non-passive only while the virtual engine needs preventDefault (POLISH, eng #9) */
  private bindTouch() {
    const passive = !this.virtual
    if (this.touchPassive === passive) return
    if (this.touchPassive !== null) { window.removeEventListener('touchstart', this.onTouchStart); window.removeEventListener('touchmove', this.onTouchMove) }
    this.touchPassive = passive
    window.addEventListener('touchstart', this.onTouchStart, { passive })
    window.addEventListener('touchmove', this.onTouchMove, { passive })
  }

  stop() {
    this.stopped = true; this.tween = null; this.resetScroll(this.scrollPixel)
    if (!this.virtual) document.documentElement.classList.add('vs-stopped') // native mode: lock the page under menus
  }
  start() {
    document.documentElement.classList.remove('vs-stopped')
    if (!this.stopped) return
    this.stopped = false
    this.resetScroll(this.virtual ? this.scrollPixel : window.scrollY)
    if (!this.started) { this.started = true; if (location.hash) this.toHash(location.hash, true) } // deep link on load
  }
  /** kept for the clock's old call site; the engine is ticked by update() */
  raf(_timeMs?: number) {}

  /** Lusion resize(): applied on the next frame. A viewport change (rotate, window resize) keeps the reading
   *  position as a fraction and stops any glide, like Lusion; a content-only change just re-reads the limit. */
  private measure(force = false) {
    const doc = document.documentElement
    const vw = window.innerWidth, vh = window.innerHeight
    const viewportChanged = vw !== this.vw || vh !== this.vh
    const progress = this.limit > 1 ? this.scrollPixel / this.limit : 0
    this.vw = vw; this.vh = vh
    this.limit = Math.max(1, doc.scrollHeight - vh)
    if (force) return
    if (viewportChanged) { this.tween = null; this.resetScroll(progress * this.limit); this.written = -1 }
    else { this.scrollPixel = this.clampPx(this.scrollPixel); this.targetScrollPixel = this.clampPx(this.targetScrollPixel) }
  }
  private clampPx(v: number) { return clamp(v, 0, this.limit) }
  /** input arriving before this time (ms) is dropped: the wheel/trackpad inertia that carried you past the footer must not
   *  carry on from the top after the loop */
  private muteUntil = 0
  private muteCap = 0
  private muteDy = 1e9
  /**
   * The loop (Shifat 13:44Z: "Scrolling after footer doesn't wrap loop back to header & hero section. Instead goes to
   * crewmate scene."). It was a 3.2 s glide to the top that any further wheel/touch input cancelled half way (landing
   * in the crewmate scene). Now it is a real wrap: one instant jump to 0 — the header and the hero at progress 0 —
   * under a white veil that matches the white footer and fades off over the hero, and the leftover inertia is dropped.
   */
  /** R6.81: ms the page HOLDS at the top after a rubber-band loop (wheel, finger, keys do nothing); 0 = none */
  private holdUntil = 0
  private holdOff = 0
  private holdBlock = (e: Event) => { if (performance.now() < this.holdUntil && e.cancelable) e.preventDefault() }
  wrapToTop(hold = 0) {
    // drop input for 0.6 s, and for as long after that as the wheel/trackpad inertia keeps streaming (each event while
    // muted extends the window by 0.22 s), up to 1.8 s: a deliberate new scroll after the loop is taken at once
    const now = performance.now()
    this.muteUntil = now + 700; this.muteCap = now + 6000; this.muteDy = 1e9   // the mute holds until the gesture ends (see onWheel)
    this.wheelAcc = 0; this.keyTarget = null; this.dragAcc = 0
    // POLISH (Shifat 18:47Z: the stone must never disappear at the wrap): no white veil any more. The veil hid the jump
    // but it also hid the stone and then faded it back in (a disappear/appear). The footer and the hero are both on
    // white, and the hero is pre-positioned (HeroStage), so the first frame after the jump is a normal hero frame.
    document.getElementById('wrap-veil')?.remove()
    // W21 (Shifat 19:12Z: no jump cut, the wrap included): the outgoing frame is frozen and dissolves over the hero
    // (services/wrapFade.ts); without a frame to freeze, the plain jump
    const go = () => {
      if (hold > 0) this.hold(hold)
      this.scrollTo(0, { immediate: true })
      ;(document.querySelector('#hero, main, body') as HTMLElement | null)?.focus?.({ preventScroll: true } as any)
    }
    if (!wrapFade.start(go)) go()
  }
  /** R6.81 (Shifat Oct 22 05:12 "stop scroll a bit moment"): from the jump, input is ignored for `ms`. The virtual
   * engine drops wheel/keys/drag (update() zeroes them while muted, onWheel swallows even a fresh flick); native touch
   * also locks the page (overflow hidden: momentum stops) and swallows touchmove. One class toggle, no per-frame work. */
  private hold(ms: number) {
    const now = performance.now()
    this.holdUntil = now + ms
    this.muteUntil = Math.max(this.muteUntil, this.holdUntil)
    this.wheelAcc = 0; this.keyTarget = null; this.dragAcc = 0
    const d = document.documentElement, nf = { passive: false } as AddEventListenerOptions
    clearTimeout(this.holdOff)
    if (!this.virtual) d.classList.add('vs-hold')
    window.addEventListener('touchmove', this.holdBlock, nf)
    this.holdOff = window.setTimeout(() => { d.classList.remove('vs-hold'); window.removeEventListener('touchmove', this.holdBlock, nf) }, ms)
  }
  resetScroll(v: number) {
    this.scrollPixel = this.targetScrollPixel = this.clampPx(v)
    this.velocityPixel = 0; this.history.length = 0; this.isWheelScrolling = false
  }

  // ── events: only collect numbers, never touch the DOM (ch.5.1) ──
  private onWheel = (e: WheelEvent) => {
    if (!this.virtual || e.ctrlKey) return // pinch-zoom on trackpads stays native
    let dy = e.deltaY, dx = e.deltaX
    if (e.deltaMode === 1) { dy *= LINE_PX; dx *= LINE_PX } else if (e.deltaMode === 2) { dy *= PAGE_PX; dx *= PAGE_PX }
    if (Math.abs(dx) > Math.abs(dy)) return // horizontal: not ours
    if (this.nativeScrollerFor(e.target as Element, dy)) return // an inner scroller (overlay body) takes it
    e.preventDefault()
    if (this.stopped) return
    const now = performance.now()
    if (now < this.holdUntil) { this.muteDy = Math.abs(dy); this.muteUntil = Math.max(this.muteUntil, Math.min(this.muteCap, now + 450)); return } // R6.81 hold
    if (now < this.muteUntil) {
      // still the gesture that hit the loop (trackpad/mouse inertia decays): keep dropping it until a 450 ms pause;
      // a fresh flick (the delta jumps back up) is a new, deliberate scroll and is taken at once
      const a = Math.abs(dy)
      if (a > 40 && a > this.muteDy * 1.8 && now > this.muteUntil - 450 + 120) { this.muteUntil = 0 }
      else { this.muteDy = a; this.muteUntil = Math.min(this.muteCap, now + 450); return }
    }
    this.wheelAcc += clamp(dy * WHEEL_GAIN, -WHEEL_CLAMP, WHEEL_CLAMP)
  }
  private onTouchStart = (e: TouchEvent) => {
    if (!this.virtual) { if (this.nativeTouch) { this.tween = null; this.isWheelScrolling = false } return } // a finger takes over a glide
    if (e.touches.length > 1) { this.touchId = null; this.touchDown = false; return } // pinch: native zoom
    if ((window.visualViewport?.scale ?? 1) > 1.01) return // zoomed in (low vision): one finger pans the zoom natively
    const t = e.changedTouches[0]
    const el = e.target as Element
    if (el?.closest?.('input[type=range], [data-vscroll-ignore], [data-lenis-prevent]')) return
    this.touchId = t.identifier; this.touchX = t.clientX; this.touchY = t.clientY
    this.touchLock = 0; this.touchDown = true; this.dragAcc = 0
  }
  private onTouchMove = (e: TouchEvent) => {
    if (!this.virtual || this.touchId === null) return
    if (e.touches.length > 1) { this.touchId = null; this.touchDown = false; return }
    let t: Touch | null = null
    for (let i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === this.touchId) t = e.changedTouches[i]
    if (!t) return
    const dx = t.clientX - this.touchX, dy = t.clientY - this.touchY
    this.touchX = t.clientX; this.touchY = t.clientY
    if (this.touchLock === 0) {
      if (dx === 0 && dy === 0) return
      // Lusion decides the drag axis once per gesture, from the first movement
      this.touchLock = Math.abs(dx) > Math.abs(dy) ? 2 : 1
      if (this.touchLock === 1 && this.nativeScrollerFor(e.target as Element, -dy)) this.touchLock = 2
    }
    if (this.touchLock !== 1) return
    if (e.cancelable) e.preventDefault()
    if (!this.stopped) this.dragAcc += -dy
  }
  private onTouchEnd = (e: TouchEvent) => {
    if (this.touchId === null) return
    for (let i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === this.touchId) {
      this.touchId = null; this.touchDown = false
    }
  }
  private onKey = (e: KeyboardEvent) => {
    if (!this.virtual || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
    const el = document.activeElement
    if (isEditable(el)) return
    const vh = this.vh || window.innerHeight
    const base = this.isWheelScrolling ? this.targetScrollPixel : this.scrollPixel
    let to: number | null = null
    switch (e.key) {
      case 'ArrowDown': to = base + KEY_STEP; break
      case 'ArrowUp': to = base - KEY_STEP; break
      case 'PageDown': to = base + vh; break
      case 'PageUp': to = base - vh; break
      case 'Home': to = 0; break
      case 'End': to = this.limit; break
      case ' ': case 'Spacebar':
        // space on a control activates it; on the page it pages (shift = back)
        if (el && el !== document.body && (el as HTMLElement).closest('a[href],button,[role=button],[role=link],summary,label')) return
        to = base + (e.shiftKey ? -vh : vh) * 0.875; break
      default: return
    }
    if (this.nativeScrollerFor(el as Element, to - base)) return
    e.preventDefault()
    if (this.stopped) return
    this.keyTarget = to
  }
  /** a same-page anchor eases there (and moves focus for screen readers / keyboard users) */
  private onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = (e.target as Element)?.closest?.('a[href*="#"]') as HTMLAnchorElement | null
    if (!a || a.target === '_blank') return
    const url = new URL(a.href, location.href)
    if (url.origin !== location.origin || url.pathname !== location.pathname || !url.hash) return
    if (!this.findHash(url.hash) && url.hash !== '#' && url.hash !== '#top') return
    e.preventDefault()
    if (location.hash !== url.hash) history.pushState(null, '', url.hash)
    this.toHash(url.hash, false)
  }
  private findHash(hash: string): HTMLElement | null {
    if (!hash || hash === '#') return null
    try { return document.getElementById(decodeURIComponent(hash.slice(1))) } catch { return null }
  }
  private toHash(hash: string, immediate: boolean) {
    const el = this.findHash(hash)
    if (!el && hash !== '#' && hash !== '#top' && hash !== '') return
    this.scrollTo(el ?? 0, { immediate })
    if (el) {
      if (!el.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.setAttribute('tabindex', '-1')
      el.focus({ preventScroll: true })
      this.lastFocusAt = -1e9 // our own focus: not a browser scroll to adopt
    }
  }
  private onNativeScroll = () => {
    if (!this.virtual) return
    const y = window.scrollY
    if (Math.abs(y - this.written) > 1) this.external = y
  }
  /** walks up from el: does an inner element (not the page) want this scroll? */
  private nativeScrollerFor(el: Element | null, dy: number) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if ((n as HTMLElement).dataset?.lenisPrevent !== undefined || (n as HTMLElement).dataset?.vscrollIgnore !== undefined) return true
      if (n.scrollHeight <= n.clientHeight + 1) continue
      const oy = getComputedStyle(n).overflowY
      if (oy !== 'auto' && oy !== 'scroll') continue
      if (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0) return true
    }
    return false
  }

  // ── one step per frame, called by the clock before sections and GL (ScrollPane.update) ──
  update(dt: number) {
    if (this.needsMeasure) { this.needsMeasure = false; this.measure() }
    const prev = this.scrollPixel
    if (!this.virtual) {
      const y = window.scrollY
      // native touch scroll: a designed glide (anchor, header pill) still eases, written to the page once per frame;
      // the page moving under it (a finger, momentum) ends it and the page's own position wins
      if (this.nativeTouch && !this.stopped && (this.tween || this.isWheelScrolling) && Math.abs(y - this.written) <= 1) {
        let a = 0
        if (this.tween) {
          const tw = this.tween
          tw.t = Math.min(1, tw.t + dt / tw.dur)
          a = tw.from + (tw.to - tw.from) * tw.ease(tw.t) - this.scrollPixel
          if (tw.t >= 1) { this.tween = null; tw.done?.() }
        } else {
          const f = this.targetScrollPixel - this.scrollPixel
          a = f * (1 - Math.exp(-WHEEL_EASE * dt))
          if (Math.abs(f) < MIN_PX) { a = f; this.isWheelScrolling = false }
        }
        this.scrollPixel = this.clampPx(this.scrollPixel + a)
        if (Math.abs(this.scrollPixel - this.written) > 0.01) {
          this.written = this.scrollPixel
          window.scrollTo({ top: this.scrollPixel, left: 0, behavior: 'instant' as ScrollBehavior })
        }
      } else {
        this.scrollPixel = this.targetScrollPixel = y
        this.tween = null; this.isWheelScrolling = false
      }
    } else {
      if (this.external !== null) {
        const y = this.external; this.external = null
        if (this.stopped) this.written = -1 // locked (menu, overlay, preloader): put the page back
        else if (performance.now() - this.lastFocusAt < 400 && !this.touchDown) {
          // focus moved by keyboard / AT: undo the browser's jump this frame and ease there instead
          this.written = -1; this.targetScrollPixel = this.clampPx(y); this.isWheelScrolling = true
          this.velocityPixel = 0; this.tween = null
        } else this.resetScroll(y) // scrollbar drag, find-in-page: follow the browser exactly
      }
      const dragging = this.touchDown && this.touchLock === 1 && !this.stopped
      if (this.touchDown && !this.touchWasDown) this.history.length = 0
      let a = 0
      if (!this.stopped) {
        if (performance.now() < this.muteUntil) { this.wheelAcc = 0; this.keyTarget = null; this.dragAcc = 0 }
        const wheel = this.wheelAcc
        if (wheel !== 0 || this.keyTarget !== null || dragging) this.tween = null
        if (this.tween) {
          const tw = this.tween
          tw.t = Math.min(1, tw.t + dt / tw.dur)
          a = tw.from + (tw.to - tw.from) * tw.ease(tw.t) - this.scrollPixel
          this.targetScrollPixel = this.clampPx(tw.to)
          if (tw.t >= 1) { this.tween = null; this.targetScrollPixel = this.scrollPixel + a; tw.done?.() }
        } else if (dragging) {
          const d = this.dragAcc
          this.history.push({ time: props.time, dt, d })
          while (this.history.length > 0 && props.time - this.history[0].time > DRAG_HISTORY) this.history.shift()
          this.targetScrollPixel = this.scrollPixel; this.isWheelScrolling = false; a = d
        } else {
          if (this.touchDown) this.resetScroll(this.scrollPixel) // a finger resting on the page catches the glide
          if (wheel !== 0) { this.isWheelScrolling = true; this.targetScrollPixel = this.clampPx(this.targetScrollPixel + wheel) }
          if (this.keyTarget !== null) { this.isWheelScrolling = true; this.targetScrollPixel = this.clampPx(this.keyTarget) }
          if (this.isWheelScrolling) {
            this.history.length = 0; this.velocityPixel = 0
            const f = this.targetScrollPixel - this.scrollPixel
            a = f * (1 - Math.exp(-WHEEL_EASE * dt))
            if (Math.abs(f) < MIN_PX) { a = f; this.isWheelScrolling = false }
          } else {
            if (this.history.length > 0) {
              // release: time-weighted mean of the last 0.1 s, newer samples weigh more (first one weighs 0)
              let w = 0, v = 0
              const h = this.history, t0 = h[0].time
              for (let i = 0; i < h.length; i++) {
                const s = h[i]; if (s.dt <= 0) continue
                const k = s.dt * (h.length === 1 ? 1 : (s.time - t0) / DRAG_HISTORY)
                v += (s.d / s.dt) * k; w += k
              }
              this.velocityPixel = w > 0 ? v / w : 0
              this.history.length = 0
            }
            const vh = this.vh || 1
            const coeff = FRICTION_FROM + (FRICTION_TO - FRICTION_FROM) * clamp(Math.abs(this.velocityPixel / vh / FRICTION_DIV), 0, 1)
            this.velocityPixel += -coeff * this.velocityPixel * dt
            if (Math.abs(this.velocityPixel) < 1) this.velocityPixel = 0
            a = this.velocityPixel * dt
          }
        }
      }
      this.scrollPixel = this.clampPx(this.scrollPixel + a)
      if (!this.isWheelScrolling && !this.tween && !dragging) this.targetScrollPixel = this.scrollPixel
      if (Math.abs(this.targetScrollPixel - this.scrollPixel) < MIN_PX) this.scrollPixel = this.targetScrollPixel
      // fling into an end: nothing left to glide
      if ((this.scrollPixel <= 0 && this.velocityPixel < 0) || (this.scrollPixel >= this.limit && this.velocityPixel > 0)) this.velocityPixel = 0
      this.isScrolling = this.targetScrollPixel !== this.scrollPixel || this.velocityPixel !== 0 || !!this.tween
      // the carrier: one write per frame, only when it moved
      if (Math.abs(this.scrollPixel - this.written) > 0.01) {
        this.written = this.scrollPixel
        window.scrollTo({ top: this.scrollPixel, left: 0, behavior: 'instant' as ScrollBehavior })
      }
      this.wheelAcc = 0; this.keyTarget = null; this.dragAcc = 0
      this.touchWasDown = this.touchDown
    }
    void prev
    // ── the blackboard (same fields and units as the Lenis version: px, px/frame) ──
    const s = this.scrollPixel
    props.scrollDelta = s - this.last
    this.last = s
    props.scroll = s
    props.scrollLimit = Math.max(1, this.limit)
    props.scrollProgress = clamp(s / props.scrollLimit)
    props.scrollVel = props.scrollDelta
    // scroll strength: a 0..1 smoothed "how hard are we scrolling" signal used by bends and audio
    props.scrollStrength = damp(props.scrollStrength, clamp(Math.abs(props.scrollVel) / 40), 6, dt)
  }

  /** programmatic scroll. No duration = Lusion's scrollToPixel (the wheel ease); a duration = a designed glide. */
  scrollTo(target: number | string | HTMLElement, opts: { duration?: number; immediate?: boolean; offset?: number; onComplete?: () => void } = {}) {
    let y: number
    if (typeof target === 'number') y = target
    else {
      const el = typeof target === 'string' ? (target.startsWith('#') ? this.findHash(target) : document.querySelector<HTMLElement>(target)) : target
      if (!el) return
      y = el.getBoundingClientRect().top + window.scrollY
    }
    y = this.clampPx(y + (opts.offset ?? 0))
    if (this.reduced || opts.immediate || (!this.virtual && !this.nativeTouch)) {
      this.tween = null
      this.resetScroll(y)
      this.written = y
      window.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior })
      opts.onComplete?.()
      return
    }
    if (!this.virtual) { this.scrollPixel = window.scrollY; this.written = this.scrollPixel } // native touch: glide from where the page is
    if (opts.duration && opts.duration > 0) {
      this.velocityPixel = 0; this.history.length = 0; this.isWheelScrolling = false
      this.tween = { from: this.scrollPixel, to: y, t: 0, dur: opts.duration, ease: houseInOut, done: opts.onComplete } // house A→B move: eases in and out, never a hard start
    } else {
      this.tween = null; this.velocityPixel = 0; this.history.length = 0
      this.targetScrollPixel = y; this.isWheelScrolling = true
    }
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
    if (top > 0) this.ratio = -clamp(top / vh)
    else if (bottom < vh) this.ratio = clamp((vh - bottom) / vh)
    else this.ratio = 0
    return this
  }
}
