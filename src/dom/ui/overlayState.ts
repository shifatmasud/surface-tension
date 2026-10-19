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
  private queued: string | null | undefined = undefined
  private subs = new Set<(id: string | null, s: State) => void>()
  sub(f: (id: string | null, s: State) => void) { this.subs.add(f); return () => { this.subs.delete(f) } }
  private set(s: State) { this.state = s; this.subs.forEach((f) => f(this.current, s)) }
  open(id: string) {
    if (this.state !== 'idle' && this.state !== 'open') { this.queued = id; return }
    this.current = id; props.overlayOpen = true; scroll.stop()
    this.set('hiding')
  }
  close() {
    if (this.state !== 'open') { this.queued = null; return }
    this.set('closing')
  }
  /** called by the overlay view as each animation phase completes */
  advance() {
    if (this.state === 'hiding') this.set('loading')
    else if (this.state === 'loading') this.set('showing')
    else if (this.state === 'showing') { this.set('open'); this.flush() }
    else if (this.state === 'closing') { this.current = null; props.overlayOpen = false; scroll.start(); this.set('idle'); this.flush() }
  }
  private flush() {
    const q = this.queued; this.queued = undefined
    if (q === undefined) return
    if (q === null) this.close(); else if (q !== this.current) { this.state = 'idle'; this.open(q) }
  }
}
export const overlay = new OverlayMachine()
