import { sections } from '../../app/sections'
import { props } from '../../state/props'
import { settings, browser } from '../../services/settings'

/**
 * Clip — clipped sections (Shifat, Oct 20: "no scene morphs into other sections' scene").
 *
 * The page is split into blocks; each block owns ONE scene (camera, look, stages) and nothing of it
 * bleeds into the next block's. Inside a block the camera may travel (hero lake → statement shot is one
 * continuous move; the dive's crossing and the journey are each one scene), but at a block boundary
 * the incoming block slides up over the outgoing one as a card:
 *   - the incoming scene is live, drawn only inside the card (rounded top corners that flatten as it lands,
 *     side insets that close), and moves up with its section with a little inner parallax;
 *   - the outgoing scene is the frame it last drew (captured as the boundary approached), and it sinks
 *     back: scale 1 → 0.94, darkens, lags behind the scroll — its DOM layer gets the same transform.
 * The boundary position is the incoming section's top on screen, read from Lenis's smoothed scroll,
 * so the move is continuous with the scroll in both directions (no cut, no snap, no blended frame).
 * Only the owning block's stages render (max one live scene + one still at a boundary).
 *
 * Blocks: hero+statement | lab | systems | dive | journey | contact.  ?noclip turns it off (QA).
 */
export const BLOCKS: string[][] = [['hero', 'statement'], ['lab'], ['systems'], ['dive'], ['journey'], ['contact']]
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

class Clip {
  enabled = settings.USE_GL && !(typeof location !== 'undefined' && /[?&]noclip/.test(location.search))
  reduced = browser.reducedMotion || (typeof location !== 'undefined' && /[?&]clipfade/.test(location.search))
  /** block that owns the live render (the incoming one during a boundary) */
  owner = 0
  /** bumps whenever the owner changes: camera springs and the look snap to the new block (hidden under the card) */
  ownerKey = 0
  boundary = false
  /** incoming card's top edge, CSS px from the viewport top */
  yTop = 0
  /** 0 → 1 as the card travels from the viewport bottom to the top */
  t = 0
  /** block index whose frame should be captured this frame (-1 = none) */
  capture = -1
  // composite parameters (CSS px)
  shift = 0; scale = 1; lag = 0; dark = 0; radius = 0; inset = 0; outRadius = 0
  private allowedSet = new Set<string>(BLOCKS[0])
  private styled: HTMLElement | null = null
  private readonly K = 0.85     // inner parallax of the incoming scene inside its card (0 = fixed scene, 1 = glued to the card)
  private readonly LAG = 0.28   // outgoing scene moves up at this fraction of the scroll

  allowed(name: string) { return !this.enabled || this.allowedSet.has(name) }
  /** screen top of block i (its first section) */
  private top(i: number) {
    const s = sections.list.find((x) => x.name === BLOCKS[i][0])
    return s?.range ? s.range.docTop - props.scroll : Infinity
  }
  private range(name: string) { return sections.list.find((x) => x.name === name)?.range }

  update() {
    if (!this.enabled) return
    const vh = props.height, vw = props.width
    const N = BLOCKS.length
    let owner = 0, b = -1, yTop = 0
    for (let i = 1; i < N; i++) {
      const tp = this.top(i)
      if (tp <= 0) owner = i
      else if (tp < vh) { owner = i; b = i; yTop = tp; break }
      else break
    }
    if (owner !== this.owner) {
      this.owner = owner; this.ownerKey++
      this.allowedSet = new Set(BLOCKS[owner])
    }
    this.boundary = b > 0
    this.capture = -1
    if (!this.boundary) {
      // arm: the next block is about to enter — keep the latest frame of this one
      if (owner + 1 < N && this.top(owner + 1) < vh * 1.6) this.capture = owner
      this.shift = 0; this.scale = 1; this.lag = 0; this.dark = 0; this.radius = 0; this.inset = 0; this.outRadius = 0; this.t = 0
      this.unstyle()
      return
    }
    const d = vh - yTop, t = Math.min(1, Math.max(0, d / vh))
    this.yTop = yTop; this.t = t
    const R = Math.min(64, Math.max(18, vw * 0.035))
    if (this.reduced) {
      // reduced motion: no card move — the composite crossfades the two frames (never a cut); the outgoing DOM fades
      this.shift = 0; this.scale = 1; this.lag = 0; this.dark = 0; this.radius = 0; this.inset = 0; this.outRadius = 0
    } else {
      this.shift = this.K * yTop
      // Shifat 08:37Z: "Sections must not scale & light down to transition out." The outgoing scene keeps 100 %
      // scale and full brightness; it only drifts up slower than the scroll (parallax) while the card covers it
      this.scale = 1
      this.lag = this.LAG * d
      this.dark = 0
      this.radius = R * (1 - smooth(0.5, 1, t))
      this.inset = vw * 0.022 * (1 - smooth(0.2, 0.95, t))
      this.outRadius = 0
    }
    this.styleOutgoing(BLOCKS[b - 1][BLOCKS[b - 1].length - 1], d, yTop)
    if (this.reduced && this.styled) { this.styled.style.transform = ''; this.styled.style.clipPath = ''; this.styled.style.opacity = (1 - smooth(0.15, 0.85, t)).toFixed(3) }
  }

  /** The outgoing section's DOM rides with its captured frame: same lag, scale, darkening; clipped at the card edge. */
  private styleOutgoing(name: string, d: number, yTop: number) {
    const r = this.range(name)
    const el = r?.el as HTMLElement | undefined
    if (!el || !r) return
    if (this.styled && this.styled !== el) this.unstyle()
    this.styled = el
    const vh = props.height
    const s = this.scale, ty = d - this.lag
    const elTop = r.docTop - props.scroll
    const oScreen = vh / 2 - d                       // where the captured frame's centre point sits naturally now
    const oLocal = oScreen - elTop
    const cut = (yTop - oScreen - ty) / s + oScreen - elTop
    const bottom = Math.max(0, r.height - cut)
    el.style.transformOrigin = `50% ${oLocal.toFixed(1)}px`
    el.style.transform = `translate3d(0, ${ty.toFixed(2)}px, 0) scale(${s.toFixed(5)})`
    el.style.clipPath = `inset(0px 0px ${bottom.toFixed(1)}px 0px)`
    el.style.filter = this.dark > 0.002 ? `brightness(${(1 - this.dark).toFixed(4)})` : ''
  }
  private unstyle() {
    const el = this.styled; if (!el) return
    el.style.transform = ''; el.style.transformOrigin = ''; el.style.clipPath = ''; el.style.filter = ''; el.style.opacity = ''
    this.styled = null
  }
}
export const clip = new Clip()
;(window as any).__clip = clip
