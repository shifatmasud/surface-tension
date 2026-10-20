import { props } from '../../state/props'
import { scroll } from '../../services/scroll'
/**
 * The project overlay runs the page state machine from ch.6.2 (single page, so no router):
 *   idle → hide (ink in) → load (video) → show (ink out) ; requests made mid-transition are queued.
 */
type State = 'idle' | 'hiding' | 'loading' | 'showing' | 'open' | 'closing'
class OverlayMachine {
  state: State = 'idle'
  current: string | null = null
  /** true when the open/close plays as the slide→card morph (the view owns the timing) instead of the ink wipe */
  morph = false
  /** the slide's on-screen rect, measured at the click (before anything about the page changes) */
  from: { left: number; top: number; width: number; height: number; radius: number } | null = null
  private queued: string | null | undefined = undefined
  private subs = new Set<(id: string | null, s: State) => void>()
  sub(f: (id: string | null, s: State) => void) { this.subs.add(f); return () => { this.subs.delete(f) } }
  private set(s: State) { this.state = s; this.subs.forEach((f) => f(this.current, s)) }
  open(id: string, opts: { morph?: boolean; from?: { left: number; top: number; width: number; height: number; radius: number } | null } = {}) {
    if (this.state !== 'idle' && this.state !== 'open') { this.queued = id; return }
    this.current = id; this.morph = !!opts.morph; this.from = opts.from ?? null; props.overlayOpen = true
    document.documentElement.classList.add('overlay-open'); scroll.stop()
    this.set('hiding')
  }
  /** morph path: the card has landed, skip the wipe phases */
  opened() { if (this.state === 'hiding' || this.state === 'loading' || this.state === 'showing') { this.set('open'); this.flush() } }
  close() {
    if (this.state !== 'open') { this.queued = null; return }
    this.set('closing')
  }
  /** called by the overlay view as each animation phase completes */
  advance() {
    if (this.state === 'hiding') this.set('loading')
    else if (this.state === 'loading') this.set('showing')
    else if (this.state === 'showing') { this.set('open'); this.flush() }
    else if (this.state === 'closing') { this.current = null; props.overlayOpen = false; document.documentElement.classList.remove('overlay-open'); scroll.start(); this.set('idle'); this.flush() }
  }
  private flush() {
    const q = this.queued; this.queued = undefined
    if (q === undefined) return
    if (q === null) this.close(); else if (q !== this.current) { this.state = 'idle'; this.open(q) }
  }
}
export const overlay = new OverlayMachine()
