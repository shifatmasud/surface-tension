import { HOUSE, cssBezier } from '../core/house'
import { browser } from './settings'

/**
 * BUTTON v2 (mockup for Shifat 11:48Z "We can do better for button", 11:50Z "Svg filter ripple on click button please",
 * 11:52Z "Svg displacement filter circle ripple"). The CTA pill and the header sound pill, everything on ONE rAF loop
 * (so it runs on the page clock and stops when the buttons are still: zero cost at rest):
 *  1. INK FLOOD: the inverse colour floods out as a solid circle from the exact pointer / finger point, and drains toward
 *     the point where the pointer leaves. It is an overlay holding an inverse-coloured copy of the label and arrow, cut by
 *     clip-path: circle(), so the label swaps colour exactly where the ink is (no blend modes, exact palette colours).
 *     Flood 0.6 s on the house expo-out; drain 0.5 s on the house in-out.
 *  2. MAGNET (mouse with (hover: hover) and (pointer: fine) only): inside the pill rect grown by 20 % of its width (min
 *     24 px) on every side, the pill follows the cursor by up to 8 px (sound pill 4 px) and the label/arrow by 1.5× that
 *     (parallax); a spring (2.6 Hz, ζ 0.55) carries it and brings it home on leave. CSS `translate`, never `transform`.
 *  3. ROLL: the house masked line roll (0.6 s expo-out, always upward) swaps the label on hover and on release; the arrow
 *     leaves along its own ↗ and a fresh one arrives from ↙.
 *  4. PRESS: soft-body squash to scaleX 1.04 / scaleY 0.92 (spring 7 Hz, ζ 0.8), released on a jelly spring that
 *     overshoots once (2.4 Hz, ζ 0.45: ~20 % overshoot, ~0.45 s to rest). CSS `scale`.
 *  5. RIPPLE: an SVG displacement filter: a generated concentric-ring normal map (R/G = outward normal, no noise) in an
 *     feImage, centred on the click / tap point, grows from 0 past the pill while feDisplacementMap's scale goes
 *     scale 0 → 20 (a 10 px push at the crest; sound pill 10) → 0 over 0.76 s,
 *     held down while the ring is still small so a tight ring never tears the edge. The filter is attached only while it plays (filter: none at rest).
 *  Phone: a tap gets the whole show from the finger (flood + squash + roll + ripple) and the ink drains on release, never
 *  stuck. Keyboard: focus-visible floods from the centre, Enter / Space press and ripple from the centre.
 *  Reduced motion: the flood is an instant colour swap; no magnet, squash, roll or ripple.
 */
type Kind = 'cta' | 'sound'
type V2 = { x: number; y: number }
type Spr = { x: number; v: number; t: number; f: number; z: number }
type Btn = {
  el: HTMLElement; kind: Kind; ink: HTMLElement; par: HTMLElement[]; rollA: HTMLElement[]; rollB: HTMLElement[]; arrA: HTMLElement[]; arrB: HTMLElement[]
  w: number; h: number
  fl: { x: number; y: number; r: number }; flA: null | { a: { x: number; y: number; r: number }; b: { x: number; y: number; r: number }; t0: number; d: number; e: (t: number) => number }
  on: boolean; pressT0: number; downPt: V2 | null; drainAt: number; drainPt: V2 | null
  mx: Spr; my: Spr; sx: Spr; sy: Spr
  roll: number; rollA0: number; rollB1: number; rollT0: number
  rip: null | { x: number; y: number; t0: number }
  filt: SVGFilterElement; fimg: SVGFEImageElement; disp: SVGFEDisplacementMapElement; filtOn: boolean
}

const EIN = cssBezier(...HOUSE.IN), EINOUT = cssBezier(...HOUSE.INOUT)
export const INK = {
  FLOOD: 0.6, DRAIN: 0.5, TAP_HOLD: 0.32,
  MAG_MAX: { cta: 8, sound: 4 }, MAG_PAD: 0.2, MAG_PAD_MIN: 24, PARALLAX: 1.5, MAG_F: 2.6, MAG_Z: 0.55,
  SQ_X: 1.04, SQ_Y: 0.92, SQ_F: 7, SQ_Z: 0.8, REL_F: 2.4, REL_Z: 0.45,
  ROLL: HOUSE.DUR_UI,
  RIP_DUR: 0.76, RIP_PEAK: { cta: 20, sound: 10 },
}
const btns: Btn[] = []
let raf = 0, last = 0, ringURL = '', svgRoot: SVGSVGElement | null = null, magnetOn = false

const now = () => performance.now() / 1000
const spr = (x: number, f: number, z: number): Spr => ({ x, v: 0, t: x, f, z })
function stepSpr(s: Spr, dt: number) {
  const w = 2 * Math.PI * s.f, n = Math.max(1, Math.ceil(dt * 240)), h = dt / n
  for (let i = 0; i < n; i++) { s.v += (-w * w * (s.x - s.t) - 2 * s.z * w * s.v) * h; s.x += s.v * h }
  if (Math.abs(s.x - s.t) < 1e-4 && Math.abs(s.v) < 1e-3) { s.x = s.t; s.v = 0; return false }
  return true
}

/** the concentric-ring normal map, drawn once (768² so it is never magnified much: no blocky steps on the edge): R/G carry the outward normal × a damped ring profile (front at r 0.9) */
function ringMap() {
  if (ringURL) return ringURL
  const N = 768, c = document.createElement('canvas'); c.width = c.height = N
  const g = c.getContext('2d')!, img = g.createImageData(N, N), d = img.data
  const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N * 2 - 1, v = (j + 0.5) / N * 2 - 1, r = Math.hypot(u, v)
    let f = 0
    if (r < 1 && r > 1e-4) {
      const env = (1 - sm(0.9, 1, r)) * Math.exp(-2.6 * Math.max(0, 0.9 - r)) * sm(0.04, 0.3, r)
      f = Math.sin((1 - r) * Math.PI * 2 * 1.75) * env         // two rings, the leading one strongest
    }
    const k = (j * N + i) * 4, nx = r > 1e-4 ? u / r : 0, ny = r > 1e-4 ? v / r : 0
    d[k] = Math.round(128 + 127 * nx * f); d[k + 1] = Math.round(128 + 127 * ny * f); d[k + 2] = 128; d[k + 3] = 255
  }
  g.putImageData(img, 0, 0)
  ringURL = c.toDataURL('image/png')
  return ringURL
}

const NS = 'http://www.w3.org/2000/svg'
function makeFilter(id: string) {
  if (!svgRoot) {
    svgRoot = document.createElementNS(NS, 'svg')
    svgRoot.setAttribute('aria-hidden', 'true'); svgRoot.setAttribute('width', '0'); svgRoot.setAttribute('height', '0')
    svgRoot.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
    document.body.appendChild(svgRoot)
  }
  const f = document.createElementNS(NS, 'filter')
  f.id = id
  for (const [k, v] of [['filterUnits', 'userSpaceOnUse'], ['primitiveUnits', 'userSpaceOnUse'], ['color-interpolation-filters', 'sRGB']]) f.setAttribute(k, v)
  const flood = document.createElementNS(NS, 'feFlood'); flood.setAttribute('flood-color', 'rgb(128,128,128)'); flood.setAttribute('result', 'n')
  const im = document.createElementNS(NS, 'feImage') as SVGFEImageElement
  const setMap = () => { im.setAttribute('href', ringMap()); im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', ringMap()) }
  // the map costs a few tens of ms once: drawn when the page is idle, never on the tap itself
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
  if (ringURL) setMap(); else if (ric) ric(setMap, { timeout: 2500 }); else window.setTimeout(setMap, 1200)
  im.setAttribute('preserveAspectRatio', 'none'); im.setAttribute('result', 'r')
  const mg = document.createElementNS(NS, 'feMerge'); mg.setAttribute('result', 'm')
  for (const s of ['n', 'r']) { const mn = document.createElementNS(NS, 'feMergeNode'); mn.setAttribute('in', s); mg.appendChild(mn) }
  const dm = document.createElementNS(NS, 'feDisplacementMap') as SVGFEDisplacementMapElement
  dm.setAttribute('in', 'SourceGraphic'); dm.setAttribute('in2', 'm'); dm.setAttribute('scale', '0'); dm.setAttribute('xChannelSelector', 'R'); dm.setAttribute('yChannelSelector', 'G')
  f.append(flood, im, mg, dm); svgRoot.appendChild(f)
  return { f, im, dm }
}

function measure(b: Btn) { b.w = b.el.offsetWidth; b.h = b.el.offsetHeight }
const farR = (b: Btn, x: number, y: number) => Math.hypot(Math.max(x, b.w - x), Math.max(y, b.h - y)) + 1
/** client point → the pill's own (untransformed) box */
function local(b: Btn, cx: number, cy: number): V2 {
  const r = b.el.getBoundingClientRect(), mx = (r.left + r.right) / 2, my = (r.top + r.bottom) / 2
  return { x: Math.min(b.w, Math.max(0, (cx - mx) / (b.sx.x || 1) + b.w / 2)), y: Math.min(b.h, Math.max(0, (cy - my) / (b.sy.x || 1) + b.h / 2)) }
}
function flood(b: Btn, p: V2) {
  measure(b); b.on = true; b.drainAt = 0
  const to = { x: p.x, y: p.y, r: farR(b, p.x, p.y) }
  if (browser.reducedMotion) { b.fl = to; b.flA = null; kick(); return }
  // already partly flooded: grow from where the ink is, else from a point at the pointer
  const from = b.fl.r > 0.5 ? { ...b.fl } : { x: p.x, y: p.y, r: 0 }
  b.flA = { a: from, b: to, t0: now(), d: INK.FLOOD, e: EIN }; kick()
}
function drain(b: Btn, p: V2) {
  b.on = false; b.drainAt = 0; measure(b)
  if (browser.reducedMotion) { b.fl = { x: p.x, y: p.y, r: 0 }; b.flA = null; kick(); return }
  let from = { ...b.fl }
  // a full flood is re-centred on the exit point first (invisible: both circles cover the whole pill)
  if (from.r >= farR(b, from.x, from.y) - 1) from = { x: p.x, y: p.y, r: farR(b, p.x, p.y) }
  b.flA = { a: from, b: { x: p.x, y: p.y, r: 0 }, t0: now(), d: INK.DRAIN, e: EINOUT }; kick()
}
function roll(b: Btn) {
  if (browser.reducedMotion) return
  if (b.roll < b.rollB1 - 0.02) return               // mid-roll: let it land
  b.rollA0 = b.roll; b.rollB1 = Math.floor(b.roll + 0.02) + 1; b.rollT0 = now(); kick()
}
function press(b: Btn, p: V2) {
  if (browser.reducedMotion) return
  b.sx.f = b.sy.f = INK.SQ_F; b.sx.z = b.sy.z = INK.SQ_Z; b.sx.t = INK.SQ_X; b.sy.t = INK.SQ_Y
  b.rip = { x: p.x, y: p.y, t0: now() }; kick()
}
function release(b: Btn) {
  b.sx.f = b.sy.f = INK.REL_F; b.sx.z = b.sy.z = INK.REL_Z; b.sx.t = 1; b.sy.t = 1; kick()
}

function frame() {
  raf = 0
  const t = now(), dt = Math.min(1 / 20, Math.max(0, t - last)); last = t
  let live = false
  for (const b of btns) {
    // flood
    if (b.drainAt && t >= b.drainAt && b.drainPt) { const p = b.drainPt; b.drainPt = null; drain(b, p) }
    if (b.drainAt) live = true
    if (b.flA) {
      const k = Math.min(1, (t - b.flA.t0) / b.flA.d), e = b.flA.e(k), A = b.flA.a, B = b.flA.b
      b.fl = { x: A.x + (B.x - A.x) * e, y: A.y + (B.y - A.y) * e, r: A.r + (B.r - A.r) * e }
      if (k >= 1) b.flA = null; else live = true
    }
    if (b.fl.r <= 0.25) { b.ink.style.visibility = 'hidden'; b.ink.style.clipPath = 'circle(0px at 0px 0px)' }
    else { b.ink.style.visibility = 'visible'; b.ink.style.clipPath = `circle(${b.fl.r.toFixed(2)}px at ${b.fl.x.toFixed(2)}px ${b.fl.y.toFixed(2)}px)` }
    // springs: magnet + squash
    for (const s of [b.mx, b.my, b.sx, b.sy]) if (stepSpr(s, dt)) live = true
    b.el.style.translate = (b.mx.x || b.my.x) ? `${b.mx.x.toFixed(2)}px ${b.my.x.toFixed(2)}px` : ''
    b.el.style.scale = (b.sx.x !== 1 || b.sy.x !== 1) ? `${b.sx.x.toFixed(4)} ${b.sy.x.toFixed(4)}` : ''
    const px = b.mx.x * (INK.PARALLAX - 1), py = b.my.x * (INK.PARALLAX - 1)
    for (const e of b.par) e.style.translate = (px || py) ? `${px.toFixed(2)}px ${py.toFixed(2)}px` : ''
    // roll (always upward; the two copies trade places)
    if (b.roll !== b.rollB1) {
      const k = Math.min(1, (t - b.rollT0) / INK.ROLL)
      b.roll = k >= 1 ? b.rollB1 : b.rollA0 + (b.rollB1 - b.rollA0) * EIN(k)
      if (k < 1) live = true
    }
    const fr = b.roll - Math.floor(b.roll)
    for (const e of b.rollA) e.style.transform = fr ? `translate3d(0,${(-fr * 100).toFixed(3)}%,0)` : ''
    for (const e of b.rollB) e.style.transform = `translate3d(0,${((1 - fr) * 100).toFixed(3)}%,0)`
    for (const e of b.arrA) e.style.transform = fr ? `translate3d(${(fr * 130).toFixed(3)}%,${(-fr * 130).toFixed(3)}%,0)` : ''
    for (const e of b.arrB) e.style.transform = `translate3d(${((fr - 1) * 130).toFixed(3)}%,${((1 - fr) * 130).toFixed(3)}%,0)`
    // ripple
    if (b.rip) {
      const k = (t - b.rip.t0) / INK.RIP_DUR
      if (k >= 1) { b.rip = null }
      else {
        live = true
        const pad = 24
        if (!b.filtOn) {
          measure(b)
          b.filt.setAttribute('x', String(-pad)); b.filt.setAttribute('y', String(-pad)); b.filt.setAttribute('width', String(b.w + 2 * pad)); b.filt.setAttribute('height', String(b.h + 2 * pad))
          b.el.style.filter = `url(#${b.filt.id})`; b.filtOn = true
        }
        const front = 4 + (farR(b, b.rip.x, b.rip.y) * 1.15) * EIN(k), half = front / 0.9
        // the push is tied to the ring's size (a tight ring with a big push folds over and tears the edge)
        const grow = Math.min(1, front / (0.75 * farR(b, b.rip.x, b.rip.y)))
        const amp = INK.RIP_PEAK[b.kind] * grow * grow * Math.pow(1 - k, 1.6)
        b.fimg.setAttribute('x', (b.rip.x - half).toFixed(2)); b.fimg.setAttribute('y', (b.rip.y - half).toFixed(2))
        b.fimg.setAttribute('width', (2 * half).toFixed(2)); b.fimg.setAttribute('height', (2 * half).toFixed(2))
        b.disp.setAttribute('scale', amp.toFixed(3))
      }
    }
    if (!b.rip && b.filtOn) { b.el.style.filter = ''; b.disp.setAttribute('scale', '0'); b.filtOn = false }
  }
  if (live) raf = requestAnimationFrame(frame)
}
function kick() { if (!raf) { last = now(); raf = requestAnimationFrame(frame) } }

function onMove(e: PointerEvent) {
  if (e.pointerType !== 'mouse') return
  for (const b of btns) {
    const r = b.el.getBoundingClientRect()
    const cx = (r.left + r.right) / 2 - b.mx.x, cy = (r.top + r.bottom) / 2 - b.my.x
    const w = b.el.offsetWidth, h = b.el.offsetHeight, pad = Math.max(INK.MAG_PAD * w, INK.MAG_PAD_MIN)
    const dx = e.clientX - cx, dy = e.clientY - cy
    const ox = Math.max(0, Math.abs(dx) - w / 2), oy = Math.max(0, Math.abs(dy) - h / 2), out = Math.hypot(ox, oy) / pad
    let tx = 0, ty = 0
    if (out < 1) {
      const s = 1 - out * out * (3 - 2 * out), M = INK.MAG_MAX[b.kind]
      tx = Math.max(-1, Math.min(1, dx / (w / 2 + pad))) * M * s
      ty = Math.max(-1, Math.min(1, dy / (h / 2 + pad))) * M * s
    }
    if (tx !== b.mx.t || ty !== b.my.t) { b.mx.t = tx; b.my.t = ty; kick() }
  }
}

/** bind one button: `ink` is its overlay (the inverse copy), `.ir-a/.ir-b` its roll copies, `.ia-a/.ia-b` the arrows */
export function bindInk(el: HTMLElement | null, kind: Kind) {
  if (!el || btns.some((b) => b.el === el)) return () => {}
  const ink = el.querySelector<HTMLElement>(':scope > .ink')!
  const q = (s: string) => Array.from(el.querySelectorAll<HTMLElement>(s))
  const { f, im, dm } = makeFilter('ink-rip-' + kind)
  const b: Btn = {
    el, kind, ink, par: q('.ink-par'), rollA: q('.ir-a'), rollB: q('.ir-b'), arrA: q('.ia-a'), arrB: q('.ia-b'), w: 0, h: 0,
    fl: { x: 0, y: 0, r: 0 }, flA: null, on: false, pressT0: 0, downPt: null, drainAt: 0, drainPt: null,
    mx: spr(0, INK.MAG_F, INK.MAG_Z), my: spr(0, INK.MAG_F, INK.MAG_Z), sx: spr(1, INK.SQ_F, INK.SQ_Z), sy: spr(1, INK.SQ_F, INK.SQ_Z),
    roll: 0, rollA0: 0, rollB1: 0, rollT0: 0, rip: null, filt: f, fimg: im, disp: dm, filtOn: false,
  }
  btns.push(b); measure(b); kick()
  const P = (e: PointerEvent) => local(b, e.clientX, e.clientY)
  const enter = (e: PointerEvent) => { if (e.pointerType === 'mouse') { flood(b, P(e)); roll(b) } }
  const leave = (e: PointerEvent) => { if (e.pointerType === 'mouse') { drain(b, P(e)); release(b) } }
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    const p = P(e); b.pressT0 = now(); b.downPt = p
    if (e.pointerType !== 'mouse') flood(b, p)        // the finger: the flood starts where it lands
    press(b, p)
  }
  const up = (e: PointerEvent) => {
    if (!b.downPt) return
    b.downPt = null; release(b)
    roll(b)                                            // the label rolls as the button lets go (the ripple owns the press)
    if (e.pointerType !== 'mouse') {
      const p = P(e), at = b.pressT0 + INK.TAP_HOLD
      if (e.type === 'pointercancel' || now() >= at) drain(b, p); else { b.drainAt = at; b.drainPt = p; kick() }
    }
  }
  const focus = () => { if (el.matches(':focus-visible')) { measure(b); flood(b, { x: b.w / 2, y: b.h / 2 }) } }
  const blur = () => { if (b.on) { measure(b); drain(b, { x: b.w / 2, y: b.h / 2 }) } }
  const kd = (e: KeyboardEvent) => { if (!e.repeat && (e.key === 'Enter' || e.key === ' ')) { measure(b); b.downPt = { x: b.w / 2, y: b.h / 2 }; press(b, b.downPt) } }
  const ku = (e: KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && b.downPt) { b.downPt = null; release(b); roll(b) } }
  el.addEventListener('pointerenter', enter); el.addEventListener('pointerleave', leave)
  el.addEventListener('pointerdown', down); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
  el.addEventListener('focus', focus); el.addEventListener('blur', blur); el.addEventListener('keydown', kd); el.addEventListener('keyup', ku)
  if (!magnetOn && !browser.reducedMotion && matchMedia('(hover: hover) and (pointer: fine)').matches) { magnetOn = true; window.addEventListener('pointermove', onMove, { passive: true }) }
  return () => {
    el.removeEventListener('pointerenter', enter); el.removeEventListener('pointerleave', leave)
    el.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
    el.removeEventListener('focus', focus); el.removeEventListener('blur', blur); el.removeEventListener('keydown', kd); el.removeEventListener('keyup', ku)
    const i = btns.indexOf(b); if (i >= 0) btns.splice(i, 1); f.remove()
  }
}
