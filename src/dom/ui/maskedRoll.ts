import { HOUSE, cssBezier } from '../../core/house'

/**
 * MASKED ROLL (Shifat 19:15Z: "Masked Rolling is our signature move in this text & number case in this page"; 19:16Z: "For
 * text case line rolls instead of per chars"). One move, two modes, one easing and one duration:
 *  - digits: every digit column is a vertical reel in an overflow-hidden mask; the value rolls continuously, and a column
 *    left of the units turns IN STEP with the digits to its right passing 8 → 9 → 0 (a carry slides, never swaps; 099 → 100
 *    rolls all three columns together).
 *  - line: each text line sits in one mask; the old line rolls out upwards as the new line rolls in from below, as a whole.
 * Reduced motion: an instant change. The preloader counter (Intro.tsx + the inline shell in index.html) is the reference.
 * Use: `createRoller(el, { mode: 'digits', digits: 3 }).set(42)` or `createRoller(el, { mode: 'line' }).set('New line')`;
 * in React, <MaskedRoll mode="digits" value={42} digits={3} /> or <MaskedRoll mode="line" text="…" />.
 */
export const ROLL_EASE = HOUSE.IN               // expo-out, the house entrance curve
export const ROLL_EASE_CSS = HOUSE.CSS_IN
export const ROLL_DURATION = HOUSE.DUR_UI       // seconds
/** the carry window, in units of the column to the right: the column turns while those digits pass 8 → 10 */
export const ROLL_CARRY = 2
const ease = cssBezier(...ROLL_EASE)
const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
/** unwrapped reel positions (leftmost first) for a continuous value: the odometer with an in-step carry */
export function rollPositions(v: number, digits: number, carry = ROLL_CARRY): number[] {
  const out: number[] = []
  for (let i = 0; i < digits; i++) {
    const p = digits - 1 - i
    if (!p) { out.push(v); continue }
    const u = Math.pow(10, p), b = Math.floor(v / u), lower = v - b * u
    out.push(b + smooth((lower - (u - carry)) / carry))
  }
  return out
}
/** paint reels (each `.odo__strip` holds 0–9 three times; the middle copy is the window) */
export function paintReels(strips: ArrayLike<HTMLElement>, pos: number[]) {
  for (let i = 0; i < strips.length; i++) {
    const m = ((pos[i] % 10) + 10) % 10
    strips[i].style.transform = `translate3d(0, ${(-(m + 10) * 100 / 30).toFixed(3)}%, 0)`
  }
}
/** the reel markup (span.odo > span.odo__col > span.odo__strip > 30 spans), styled by .odo in app.css */
export function buildReels(digits: number): HTMLElement {
  const odo = document.createElement('span'); odo.className = 'odo'; odo.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < digits; i++) {
    const col = document.createElement('span'); col.className = 'odo__col'
    const strip = document.createElement('span'); strip.className = 'odo__strip'
    for (let k = 0; k < 30; k++) { const d = document.createElement('span'); d.textContent = String(k % 10); strip.appendChild(d) }
    col.appendChild(strip); odo.appendChild(col)
  }
  return odo
}

export type Roller = { set(next: number | string): void; destroy(): void }
export function createRoller(el: HTMLElement, o: { mode: 'digits'; digits?: number; value?: number } | { mode: 'line'; text?: string }): Roller {
  let raf = 0
  if (o.mode === 'digits') {
    const n = o.digits ?? 3
    let v = o.value ?? 0
    const odo = el.querySelector<HTMLElement>('.odo') ?? el.appendChild(buildReels(n))
    const strips = odo.querySelectorAll<HTMLElement>('.odo__strip')
    paintReels(strips, rollPositions(v, n))
    return {
      set(next) {
        const to = Math.max(0, Number(next)); cancelAnimationFrame(raf)
        if (reduced() || to === v) { v = to; paintReels(strips, rollPositions(v, n)); return }
        const from = v, t0 = performance.now()
        const step = (now: number) => {
          const k = Math.min(1, (now - t0) / (ROLL_DURATION * 1000))
          v = from + (to - from) * ease(k); paintReels(strips, rollPositions(v, n))
          if (k < 1) raf = requestAnimationFrame(step)
        }
        raf = requestAnimationFrame(step)
      },
      destroy() { cancelAnimationFrame(raf) },
    }
  }
const LINE_PAD = '0.18em', LINE_PAD_X = '0.1em', LINE_OUT = 'calc(100% + 0.36em)'
  // line mode: one mask, the whole line moves
  el.style.display = el.style.display || 'block'
  el.style.overflow = 'hidden'; el.style.position = el.style.position || 'relative'
  // TEXTROLL: the mask is padded (and the padding given back) so ascenders and descenders are never clipped
  el.style.paddingBlock = LINE_PAD; el.style.marginBlock = `calc(-1 * ${LINE_PAD})`
  // W19 (Shifat 20:38Z "letter e is partly cutoff"): inline padding too (given back the same way), so italic overhang and the
  // last glyph's side bearing are never clipped by the mask
  el.style.paddingInline = LINE_PAD_X; el.style.marginInline = `calc(-1 * ${LINE_PAD_X})`
  let cur = document.createElement('span'); cur.style.display = 'block'; cur.textContent = o.text ?? el.textContent ?? ''
  el.replaceChildren(cur)
  return {
    set(next) {
      const text = String(next); if (text === cur.textContent) return
      cancelAnimationFrame(raf)
      const nu = document.createElement('span'); nu.style.display = 'block'; nu.textContent = text
      if (reduced()) { el.replaceChildren(nu); cur = nu; return }
      // the old line stays in flow (keeps the height) and leaves upwards; the new one rides in from below
      nu.style.position = 'absolute'; nu.style.left = '0'; nu.style.right = '0'; nu.style.top = LINE_PAD; nu.style.transform = `translate3d(0, ${LINE_OUT}, 0)`
      for (const c of [...el.children]) if (c !== cur) c.remove()
      el.appendChild(nu)
      const old = cur, t0 = performance.now()
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / (ROLL_DURATION * 1000)), e = ease(k)
        old.style.transform = `translate3d(0, calc(${(-e).toFixed(4)} * ${LINE_OUT}), 0)`
        nu.style.transform = `translate3d(0, calc(${(1 - e).toFixed(4)} * ${LINE_OUT}), 0)`
        if (k < 1) { raf = requestAnimationFrame(step); return }
        nu.style.position = ''; nu.style.transform = ''; old.remove()
      }
      cur = nu
      raf = requestAnimationFrame(step)
    },
    destroy() { cancelAnimationFrame(raf) },
  }
}


// ---------------------------------------------------------------- TEXTROLL: a whole text block, rolled per line
/**
 * TEXTROLL (Shifat 19:39Z "Text must always appear & disappear (even hero text contents) rolling up masked by each
 * lines"). `lineRoll(el)` splits a block into its real lines (measured after layout, re-measured on resize), puts each
 * line in its own overflow mask and drives it with ONE number:
 *   0 = every line under its mask · 1 = in place · 2 = every line gone up through the top of its mask.
 * Lines stagger by `stagger` (in units of the whole move). Scroll-driven callers pass a progress (reversible);
 * `play(to)` eases there over ROLL_DURATION on the house curve for one-off moments. The mask is padded by `pad` em
 * above and below (and the padding taken back with a negative margin, so layout never moves: CLS 0), which keeps tight
 * display type's ascenders and descenders whole. Elements marked `[data-roll-line]` inside `el` are used as the lines
 * as written (blocks holding icons or odometers), otherwise the block's text is split into lines. Reduced motion: no
 * move, the text is simply there between 0.5 and 1.5. Screen readers read the original element (no clones are made).
 */
export type LineRoll = { set(p: number): void; play(to: number, delay?: number): void; get(): number; destroy(): void }
const easeOutRoll = cssBezier(...ROLL_EASE)
const easeInOutRoll = cssBezier(0.65, 0, 0.35, 1)
export function lineRoll(el: HTMLElement, o: { stagger?: number; pad?: number; split?: boolean } = {}): LineRoll {
  const stagger = o.stagger ?? 0.12, pad = o.pad ?? 0.2
  let ins: HTMLElement[] = [], masks: HTMLElement[] = [], p = 0, raf = 0, rt = 0, original: Node[] | null = null, destroyed = false
  const wrap = (mask: HTMLElement) => {
    const inner = document.createElement('span'); inner.className = 'mroll__in'
    while (mask.firstChild) inner.appendChild(mask.firstChild)
    mask.appendChild(inner); mask.classList.add('mroll'); if (mask.dataset.rollLine === 'inline') mask.classList.add('mroll--inline'); mask.style.setProperty('--mroll-pad', pad + 'em')
    masks.push(mask); ins.push(inner)
  }
  const unwrap = () => {
    for (let k = 0; k < masks.length; k++) { const m = masks[k], i = ins[k]; while (i.firstChild) m.insertBefore(i.firstChild, i); i.remove(); m.classList.remove('mroll', 'mroll--inline') }
    masks = []; ins = []
    if (original) { el.replaceChildren(...original); original = null }
  }
  const build = () => {
    unwrap()
    const marked = Array.from(el.querySelectorAll<HTMLElement>('[data-roll-line]'))
    if (marked.length) { marked.forEach(wrap) }
    else if (o.split === false) { wrap(el) }
    else {
      // split the block's text into its laid-out lines: one block span per line, words kept whole
      original = Array.from(el.childNodes)
      const text = (el.textContent || '').replace(/[ \t\n\r]+/g, ' ').trim()   // (no-break spaces stay: noOrphans)
      const words = text.split(' ')
      el.replaceChildren()
      const probe = words.map((w, k) => { const s = document.createElement('span'); s.textContent = w + (k < words.length - 1 ? ' ' : ''); el.appendChild(s); return s })
      const rows: string[][] = []; let lastTop = -1e9
      for (const s of probe) { const t = Math.round(s.getBoundingClientRect().top); if (Math.abs(t - lastTop) > 2) { rows.push([]); lastTop = t } rows[rows.length - 1].push(s.textContent || '') }
      el.replaceChildren()
      for (const r of rows) { const line = document.createElement('span'); line.style.display = 'block'; line.textContent = r.join('').replace(/[ \t\n\r]+$/, ''); el.appendChild(line); wrap(line) }
      // the screen reader keeps the block's text once: the line spans carry it, nothing is duplicated
    }
    paint()
  }
  const paint = () => {
    const n = ins.length; if (!n) return
    const k = 1 + stagger * (n - 1)
    for (let i = 0; i < n; i++) {
      let y: number, vis = true
      if (reduced()) { y = 0; vis = p > 0.5 && p < 1.5 }
      else {
        const xi = Math.min(1, Math.max(0, Math.min(p, 1) * k - i * stagger)), xo = Math.min(1, Math.max(0, Math.max(p - 1, 0) * k - i * stagger))
        y = (1 - easeOutRoll(xi)) - easeInOutRoll(xo)   // +1 under the mask … 0 in place … −1 gone through the top
        vis = xi > 0 && xo < 1
      }
      const s = ins[i].style
      s.transform = y === 0 ? '' : `translate3d(0, calc(${y.toFixed(4)} * (100% + ${(2 * pad).toFixed(3)}em)), 0)`
      s.visibility = vis ? '' : 'hidden'
    }
  }
  const onResize = () => { clearTimeout(rt); rt = window.setTimeout(() => { if (!destroyed) build() }, 160) }
  build()
  if (typeof document !== 'undefined' && document.fonts) document.fonts.ready.then(() => { if (!destroyed) build() })
  window.addEventListener('resize', onResize)
  return {
    set(next) { cancelAnimationFrame(raf); if (next === p) return; p = next; paint() },
    get: () => p,
    play(to, delay = 0) {
      cancelAnimationFrame(raf)
      if (reduced()) { p = to; paint(); return }
      const from = p, t0 = performance.now() + delay * 1000, n = Math.max(1, ins.length), dur = ROLL_DURATION * (1 + stagger * (n - 1)) * Math.max(0.5, Math.abs(to - from))
      const step = (now: number) => {
        const x = Math.min(1, Math.max(0, (now - t0) / (dur * 1000)))
        p = from + (to - from) * x; paint()   // the per-line curves above carry the easing
        if (x < 1) raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    },
    destroy() { destroyed = true; cancelAnimationFrame(raf); clearTimeout(rt); window.removeEventListener('resize', onResize); unwrap() },
  }
}
