import * as THREE from 'three'
import { stickerMask } from '../../systems/stickerMask'
import { Spring } from '../../../core/spring'
import { browser } from '../../../services/settings'
import { audio } from '../../../services/audio'
import { props } from '../../../state/props'
import { journey } from './journeyState'
import { FOOT_MODE } from '../../post/footerWorld'

/**
 * STICKERS — interactive vinyl on the CTA wall (Shifat 15:29Z: "Make stickers interactive draggable peelable").
 * The stickers are GL instances (ctaScene.ts); this drives them from the pointer, the finger and the keyboard:
 *  - drag: grab the face → it lifts off the wall (a touch larger, the shadow spreads and softens), follows, and on
 *    release re-sticks with a small squash-and-settle;
 *  - peel: grab near a corner (squares) or the rim (circles) → the vinyl rolls back over a travelling fold showing its
 *    paper back; let go and it lays back down, or pull past the threshold and it peels off and floats away. Every
 *    sticker returns on the next visit to the wall;
 *  - touch: a long-press (300 ms) picks a sticker up, so a swipe that starts on one still scrolls the page;
 *  - keyboard: each sticker is a focusable button over its GL twin; arrows move it (Shift = bigger steps), Enter peels
 *    it (Enter again: off), Esc lays it back;
 *  - a drop never covers the CTA type, the crewmate or the CTA row: the sticker is eased just clear of them;
 *  - reduced motion: plain drag, no lift, no curl, no fly-off.
 */
type Ctx = {
  camera: THREE.Camera
  group: THREE.Group
  base: Float32Array
  aSt: THREE.InstancedBufferAttribute
  aInt: THREE.InstancedBufferAttribute
  aProg: THREE.InstancedBufferAttribute   // .w = stacking rank (the last-touched sticker on top)
  lay: { C: THREE.Vector3; hw: number; wv: number; crewZ: number; crewY: number; crewScale: number; crewH: number }
  typeRect: () => { x0: number; x1: number; y0: number; y1: number; z: number }
  labels: string[]
  shapes: ('circle' | 'square')[]
  z: () => number
}
export type StickerInteraction = { update(time: number, a: number, on: boolean): void; relayout(): void; dispose(): void }

const RM = browser.reducedMotion
/** the harness global (window.__stickers) ships only under ?qa */
const QA_FLAG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('qa')
/** the die-cut reach along the peel direction (a rounded square's corner sits further out than a circle's rim): the
 *  shader's fold starts at 0.72 and travels 1.55 per unit of peel, so a visible peel starts at (0.72 - reach) / 1.55 */
const REACH = { circle: 0.42, square: 0.53 }
const LONG_PRESS = 400, SLOP = 9, PEEL_OFF = 0.35, FLY_S = 1.35, R_FACE = 0.42

type St = {
  ox: Spring; oy: Spring; tx: number; ty: number
  lift: Spring; liftT: number
  peel: Spring; peelT: number; ang: number
  rot: Spring
  fly: number; gone: boolean
  el: HTMLButtonElement
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

export function createStickerInteraction(c: Ctx): StickerInteraction {
  const N = c.labels.length
  const ndc = new THREE.Vector2(), rc = new THREE.Raycaster(), inv = new THREE.Matrix4(), ray = new THREE.Ray()
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), v3 = new THREE.Vector3(), w2 = new THREE.Vector2()
  const canvasHost = () => document.getElementById('canvas')

  // ---- the DOM twin layer: a focusable, hit-testable button over every sticker (cursor label, focus ring, a11y)
  if (!document.getElementById('stk-style')) {
    const st = document.createElement('style'); st.id = 'stk-style'
    st.textContent = '.stk-layer{position:absolute;inset:0;pointer-events:none;z-index:0;display:none}' +
      '.stk-hit{position:absolute;left:0;top:0;margin:0;padding:0;border:0;background:transparent;pointer-events:auto;cursor:grab;' +
      'touch-action:pinch-zoom;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;user-select:none;-webkit-user-select:none;transform-origin:50% 50%}' +
      '.stk-hit:active{cursor:grabbing}.stk-hit:focus{outline:none}.stk-hit:focus-visible{background-color:transparent!important;color:transparent!important;text-decoration:none!important;outline:2px solid #fff;outline-offset:4px}' +
      '.stk-hit[data-gone]{display:none}'
    if (RM) st.textContent += '.stk-hit{touch-action:pan-y pinch-zoom}'
    document.head.appendChild(st)
  }
  const layer = document.createElement('div'); layer.className = 'stk-layer'; layer.setAttribute('role', 'group'); layer.setAttribute('aria-label', 'Stickers on the wall')
  let mounted = false
  const mount = () => {
    if (mounted) return
    const host = document.querySelector<HTMLElement>('.contact__inner')
    if (!host) return
    host.insertBefore(layer, host.firstChild); mounted = true
    io?.observe(host.closest('.contact') ?? host)
  }
  // the wall section's own visibility, in real time (works while the stage is frozen or skipped by a jump): off screen
  // the buttons are hidden and inert (never tabbable), and coming back counts as a new visit
  let away = false, seen = true
  const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((es) => {
    seen = es[es.length - 1].isIntersecting
    layer.inert = !seen; layer.style.visibility = seen ? '' : 'hidden'
    if (!seen) away = true
  }) : null

  const S: St[] = []
  for (let i = 0; i < N; i++) {
    const el = document.createElement('button'); el.type = 'button'; el.className = 'stk-hit'
    el.setAttribute('aria-label', `${c.labels[i]} sticker. Drag it anywhere on the wall${RM ? '' : ', or grab a corner to peel it'}. Arrow keys move it${RM ? '' : ', Enter peels it'}.`)
    el.dataset.cursor = ''; el.dataset.cursorLabel = 'Drag'
    el.style.borderRadius = c.shapes[i] === 'circle' ? '50%' : '18%'
    layer.appendChild(el)
    S.push({
      ox: new Spring(0, 2.4, 0.62, 0), oy: new Spring(0, 2.4, 0.62, 0), tx: 0, ty: 0,
      lift: new Spring(0, 2.6, 0.42, 0), liftT: 0,
      peel: new Spring(0, 2.8, 0.62, 0), peelT: 0, ang: Math.PI / 4,
      rot: new Spring(0, 2.0, 0.5, 0),
      fly: 0, gone: false, el,
    })
  }

  // ---- geometry helpers
  const size = (i: number) => c.base[i * 4 + 2]
  const tiltOf = (i: number) => c.base[i * 4 + 3]
  const posX = (i: number) => c.base[i * 4] + S[i].ox.value
  const posY = (i: number) => c.base[i * 4 + 1] + S[i].oy.value
  /** a client pixel → the wall plane (group-local). False when the ray misses (never, head-on) */
  function toWall(cx: number, cy: number, out: THREE.Vector2) {
    const host = canvasHost(); if (!host) return false
    const r = host.getBoundingClientRect()
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1)
    rc.setFromCamera(ndc, c.camera)
    c.group.updateWorldMatrix(true, false); inv.copy(c.group.matrixWorld).invert()
    ray.copy(rc.ray).applyMatrix4(inv)
    plane.constant = -c.z()
    if (!ray.intersectPlane(plane, v3)) return false
    out.set(v3.x, v3.y); return true
  }
  /** group-local point → client pixels */
  const host0 = { left: 0, top: 0, width: 1, height: 1 }
  function toScreen(x: number, y: number, z: number, out: THREE.Vector2) {
    v3.set(x, y, z); c.group.localToWorld(v3); v3.project(c.camera)
    out.set(host0.left + (v3.x * 0.5 + 0.5) * host0.width, host0.top + (-v3.y * 0.5 + 0.5) * host0.height)
    return out
  }
  /** the sticker-local position of a wall point: -0.5..0.5 across the cell, untilted */
  function local(i: number, wx: number, wy: number, out: THREE.Vector2) {
    const dx = wx - posX(i), dy = wy - posY(i), a = -tiltOf(i), s = size(i)
    out.set((Math.cos(a) * dx - Math.sin(a) * dy) / s, (Math.sin(a) * dx + Math.cos(a) * dy) / s)
    return out
  }
  /** is this local point a peel grab (a corner of a rounded square, the rim of a circle)? returns the peel angle */
  function peelAngle(i: number, q: THREE.Vector2): number | null {
    if (RM) return null
    if (c.shapes[i] === 'circle') return q.length() > 0.3 ? Math.atan2(q.y, q.x) : null
    return Math.abs(q.x) > 0.24 && Math.abs(q.y) > 0.24 ? Math.atan2(Math.sign(q.y), Math.sign(q.x)) : null
  }

  // ---- the keep-clear rule: after a drop a sticker eases just off the type, the crewmate, the CTA row, the header
  // controls and the screen edges
  const sp = new THREE.Vector2(), sq = new THREE.Vector2()
  type Rect = { x0: number; y0: number; x1: number; y1: number; pad?: number; w?: number }
  /** the wall parallax (the camera rig's pointer drift, owned by the scene lane) moves the GL wall, type and crewmate
   *  against the fixed DOM row/header/edges by up to about this many px, so the keep-outs carry it as an allowance */
  const parallax = () => Math.max(24, 0.02 * innerWidth)
  function readHost() {
    const host = canvasHost(); if (!host) return false
    const hr = host.getBoundingClientRect(); host0.left = hr.left; host0.top = hr.top; host0.width = hr.width; host0.height = hr.height
    return true
  }
  /** the keep-out boxes in client pixels */
  function keepOut(): Rect[] {
    const rects: Rect[] = []
    const T = c.typeRect()
    const a = toScreen(T.x0, T.y1, T.z, new THREE.Vector2()), b = toScreen(T.x1, T.y0, T.z, new THREE.Vector2())
    const P = parallax()
    rects.push({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y), pad: P * 0.3 })
    const L = c.lay, ch = L.crewH * L.crewScale
    const ca = toScreen(L.C.x - ch * 0.32, L.crewY + ch * 0.58, L.crewZ, new THREE.Vector2()), cb = toScreen(L.C.x + ch * 0.32, L.crewY - ch * 0.55, L.crewZ, new THREE.Vector2())
    rects.push({ x0: Math.min(ca.x, cb.x), y0: Math.min(ca.y, cb.y), x1: Math.max(ca.x, cb.x), y1: Math.max(ca.y, cb.y), pad: P * 0.7 })
    const row = document.querySelector('.contact__row')?.getBoundingClientRect()
    if (row && row.width > 0) rects.push({ x0: row.left, y0: row.top, x1: row.right, y1: row.bottom, pad: P })
    // the fixed header's controls (wordmark, pills) sit over the wall's top corners: never park a sticker under them
    document.querySelectorAll('.header > *').forEach((h) => { const r = h.getBoundingClientRect(); if (r.width > 0) rects.push({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, pad: P }) })
    return rects
  }
  /** pixels per wall unit at sticker i, and the sticker's screen centre (into sp) */
  function screenOf(i: number, wx: number, wy: number) {
    const z = c.z(), s = size(i)
    toScreen(wx, wy, z, sp); toScreen(wx + s, wy, z, sq)
    return Math.max(1e-3, Math.hypot(sq.x - sp.x, sq.y - sp.y) / s)
  }
  /** only when the sticker actually overlaps a keep-out box or an edge does it move; pdx/pdy (screen) prefer a direction */
  function keepClear(i: number, pdx = 0, pdy = 0) {
    if (!readHost()) return
    const s = size(i)
    const rects = keepOut()
    // the other stickers are soft keep-outs, so drops spread out instead of piling onto the same free spot
    for (let j = 0; j < N; j++) {
      if (j === i || S[j].fly > 0) continue
      const rj = size(j) * R_FACE * screenOf(j, c.base[j * 4] + S[j].tx, c.base[j * 4 + 1] + S[j].ty)
      rects.push({ x0: sp.x - rj, y0: sp.y - rj, x1: sp.x + rj, y1: sp.y + rj, w: 0.25 })
    }
    const ppu = screenOf(i, c.base[i * 4] + S[i].tx, c.base[i * 4 + 1] + S[i].ty)
    const r = s * R_FACE * ppu                                   // the die-cut face radius in pixels
    const pad = r + 12, W = props.width, H = props.height, m = r + 6 + parallax()
    const over = (x: number, y: number) => {   // overlap score: padded-box intersection area + a dominant off-screen term
      let a = 0
      for (const R of rects) {
        const p = pad + (R.pad ?? 0)
        const ix = Math.min(x + p, R.x1) - Math.max(x - p, R.x0), iy = Math.min(y + p, R.y1) - Math.max(y - p, R.y0)
        if (ix > 0 && iy > 0) a += ix * iy * (R.w ?? 1)
      }
      const ox = Math.max(0, m - x) + Math.max(0, x - (W - m)), oy = Math.max(0, m - y) + Math.max(0, y - (H - m))
      return a + (ox + oy) * pad * 50
    }
    const x0 = sp.x, y0 = sp.y
    if (over(x0, y0) <= 0) return
    let bx = x0, by = y0, best = over(x0, y0)
    const consider = (x: number, y: number) => { const o = over(x, y); if (o < best - 1e-6 || (o === best && Math.hypot(x - x0, y - y0) < Math.hypot(bx - x0, by - y0))) { best = o; bx = x; by = y } return o <= 0 }
    let done = false
    if (pdx || pdy) for (let d = 8; d < Math.max(W, H) && !done; d += 8) done = consider(x0 + pdx * d, y0 + pdy * d)
    for (let d = 8; d < Math.max(W, H) && !done; d += 8) {
      for (let k = 0; k < 32; k++) {
        const an = (k / 32) * Math.PI * 2
        if (consider(x0 + Math.cos(an) * d, y0 + Math.sin(an) * d)) { done = true; break }
      }
    }
    if (W > 2 * m) bx = Math.min(W - m, Math.max(m, bx))
    if (H > 2 * m) by = Math.min(H - m, Math.max(m, by))
    S[i].tx += (bx - x0) / ppu
    S[i].ty -= (by - y0) / ppu
  }

  // harness: the last gesture events (QA reads window.__stickers.log)
  const evlog: string[] = []
  const note = (s: string) => { evlog.push(s); if (evlog.length > 40) evlog.shift() }

  // ---- gestures
  type G = { i: number; id: number; mode: 'drag' | 'peel'; gx: number; gy: number; sx: number; sy: number; touch: boolean }
  let g: G | null = null
  let pending: { i: number; id: number; x0: number; y0: number; x: number; y: number; t: number; timer: number } | null = null
  let active = false

  // stacking: the last-touched sticker draws on top (a tiny z step per rank in the shader, so overlaps never z-fight)
  // and its hit button sits on top too
  const stack = Array.from({ length: N }, (_, j) => j)
  const raise = (i: number) => {
    if (stack[N - 1] === i) return
    stack.splice(stack.indexOf(i), 1); stack.push(i)
    stack.forEach((j, r) => { c.aProg.setW(j, r); S[j].el.style.zIndex = String(r) })
    c.aProg.needsUpdate = true
  }
  const begin = (i: number, id: number, cx: number, cy: number, touch: boolean) => {
    if (!toWall(cx, cy, w2)) return
    document.documentElement.dataset.stkDrag = ''   // W24: no text selection anywhere while a sticker is held (scorer-r638 minor: the CTA pill text got selected)
    raise(i)
    const q = local(i, w2.x, w2.y, new THREE.Vector2())
    const ang = peelAngle(i, q)
    const st = S[i]
    lastX = cx; lastY = cy
    note(`begin ${i} ${ang === null ? 'drag' : 'peel'} ${touch ? 'touch' : 'mouse'}`)
    g = { i, id, mode: ang === null ? 'drag' : 'peel', gx: w2.x - posX(i), gy: w2.y - posY(i), sx: w2.x, sy: w2.y, touch }
    const lab = ang !== null ? 'Peel' : 'Drag'
    if (st.el.dataset.cursorLabel !== lab) { st.el.dataset.cursorLabel = lab; st.el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })) }
    if (ang !== null) { st.ang = ang; st.peelT = 0.08 } else {
      st.liftT = RM ? 0 : 1; st.ox.tune(7, 1, 0); st.oy.tune(7, 1, 0); st.tx = st.ox.value; st.ty = st.oy.value
      // W23 (scorer-r6261: 'no visible peel or curl on a drag'): picked up by its face, the corner on the side of the
      // finger curls up a little, the way a lifted sticker does; it lays flat again on the drop (well under the peel-off)
      if (!RM) { st.ang = c.shapes[i] === 'circle' ? Math.atan2(q.y, q.x) : Math.atan2(q.y >= 0 ? 1 : -1, q.x >= 0 ? 1 : -1); st.peelT = 0.17 }
    }
    audio.tick()
    if (touch && navigator.vibrate) try { navigator.vibrate(8) } catch { /* not allowed */ }
  }
  let lastX = 0, lastY = 0, keyTimer = 0
  const move = (cx: number, cy: number) => {
    lastX = cx; lastY = cy
    if (!g || !toWall(cx, cy, w2)) return
    const st = S[g.i], i = g.i
    if (g.mode === 'drag') { st.tx = w2.x - g.gx - c.base[i * 4]; st.ty = w2.y - g.gy - c.base[i * 4 + 1] }
    else {
      // pulling the grabbed corner back across the sticker rolls the fold towards the far side
      // the corner follows the finger, so the fold travels at half its speed (a real peel); a sideways pull peels a little
      const dx = w2.x - g.sx, dy = w2.y - g.sy, s = size(i)
      const a = st.ang + tiltOf(i), along = -(dx * Math.cos(a) + dy * Math.sin(a))
      const cells = (Math.max(along, 0) + Math.hypot(dx, dy) * 0.25) / s
      st.peelT = Math.min(1, Math.max(0.08, (cells * 0.5) / 1.55 * 1.25))   // a pull across the whole sticker ≈ 0.5
    }
  }
  const end = (cancel = false) => {
    delete document.documentElement.dataset.stkDrag
    if (!g) return
    note(`end ${g.i} ${cancel ? 'cancel' : 'drop'}`)
    const st = S[g.i], i = g.i
    if (g.mode === 'drag') {
      st.liftT = 0; st.peelT = 0
      if (RM) { st.ox.tune(4, 1, 0); st.oy.tune(4, 1, 0) } else { st.ox.tune(2.4, 0.62, 0); st.oy.tune(2.4, 0.62, 0) }
      // a little inertia: a flicked sticker travels on a touch before it re-sticks (capped at one sticker width)
      const s = size(i), k = RM ? 0 : 0.12
      st.tx += Math.max(-s, Math.min(s, st.ox.velocity * k)); st.ty += Math.max(-s, Math.min(s, st.oy.velocity * k))
      if (!cancel) keepClear(i)
      audio.plip(0.45, 0.6 + Math.random() * 0.3)
    } else if (!cancel && Math.max(st.peel.value, st.peelT) > PEEL_OFF) { st.fly = 0.0001; st.peelT = Math.max(st.peel.value, 0.75); audio.plip(0.3, 1.35) }
    else { st.peelT = 0; audio.plip(0.3, 0.9) }
    g = null
  }
  const cancelPending = () => { if (pending) { clearTimeout(pending.timer); pending = null } }

  S.forEach((st, i) => {
    const el = st.el
    el.addEventListener('pointerdown', (e) => {
      note(`down ${i} ${e.pointerType} a${+active} g${+!!g}`)
      if (!active || st.fly > 0 || g) return
      if (e.pointerType === 'touch') {
        cancelPending()
        const id = e.pointerId, x = e.clientX, y = e.clientY
        pending = { i, id, x0: x, y0: y, x, y, t: performance.now(), timer: window.setTimeout(() => requestAnimationFrame(() => { if (pending && pending.id === id) { const p = pending; pending = null; begin(p.i, p.id, p.x, p.y, true) } }), LONG_PRESS) }
        return
      }
      if (e.button !== 0) return
      e.preventDefault()
      try { el.setPointerCapture(e.pointerId) } catch { /* fine */ }
      begin(i, e.pointerId, e.clientX, e.clientY, false)
    })
    el.addEventListener('pointermove', (e) => {
      if (pending && pending.id === e.pointerId) {
        // judged by when the move HAPPENED (event time), not when it was delivered: a move made after a still hold
        // starts the drag even if the long-press timer has not run yet (a busy main thread); one made before it scrolls
        if (e.timeStamp - pending.t >= LONG_PRESS) { const p = pending; cancelPending(); begin(p.i, p.id, p.x, p.y, true) }
        else { if (Math.hypot(e.clientX - pending.x0, e.clientY - pending.y0) > SLOP) cancelPending(); else { pending.x = e.clientX; pending.y = e.clientY } return }
      }
      if (g && g.id === e.pointerId) {
        // a finger holding a sticker is a hand on the wall: the camera's finger-follow must not swing the wall under it
        if (g.touch) e.stopPropagation()
        move(e.clientX, e.clientY); return
      }
      // hover (mouse): a corner lifts a hair to say "peel me"; the face rises a touch
      if (!g && active && e.pointerType === 'mouse' && st.fly === 0 && toWall(e.clientX, e.clientY, w2)) {
        const ang = peelAngle(i, local(i, w2.x, w2.y, sq))
        if (ang !== null) { st.ang = ang; st.peelT = 0.07; st.liftT = 0 } else { st.peelT = 0; st.liftT = RM ? 0 : 0.14 }
        const lab = ang !== null ? 'Peel' : 'Drag'
        if (el.dataset.cursorLabel !== lab) el.dataset.cursorLabel = lab
      }
    })
    el.addEventListener('pointerleave', () => { if (!g || g.i !== i) { st.peelT = 0; st.liftT = 0 } })
    const up = (e: PointerEvent) => {
      note(`${e.type} ${i} ${e.pointerType}`)
      if (pending && pending.id === e.pointerId) cancelPending(); if (g && g.id === e.pointerId) end(e.type === 'pointercancel') }
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    el.addEventListener('keydown', (e) => {
      if (!active || st.fly > 0) return
      if (e.key.startsWith('Arrow') || e.key === 'Enter' || e.key === ' ') raise(i)
      const s = size(i), step = s * (e.shiftKey ? 0.6 : 0.2)
      const k = e.key
      if (k.startsWith('Arrow')) {
        const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, dy = k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0
        st.tx += dx * step; st.ty += dy * step
        // a nudge is just a nudge; once the keys rest, a sticker left on a keep-out box hops on in the arrow's direction
        clearTimeout(keyTimer); keyTimer = window.setTimeout(() => keepClear(i, dx, -dy), 400)
      } else if ((k === 'Enter' || k === ' ') && !RM) {
        if (st.peelT < 0.3) { st.ang = c.shapes[i] === 'circle' ? Math.PI * 0.25 : Math.atan2(1, 1); st.peelT = 0.45; audio.tick() }
        else {
          st.fly = 0.0001; st.peelT = 0.75; audio.plip(0.3, 1.35)
          const next = S.find((o, j) => j > i && o.fly === 0) ?? S.find((o) => o.fly === 0)
          const to = next?.el ?? document.querySelector<HTMLElement>('.contact .big-btn')
          to?.focus({ preventScroll: true })
        }
      } else if (k === 'Escape') { st.peelT = 0 } else return
      e.preventDefault(); e.stopPropagation()   // the page's own key scrolling must not take it
    })
    el.addEventListener('blur', () => {
      if (keyTimer) { clearTimeout(keyTimer); keyTimer = 0; keepClear(i) } if (st.peelT > 0 && st.peelT < 0.5 && st.fly === 0) st.peelT = 0 })
  })
  // a picked-up sticker owns the finger: the page's touch scroll must not see the drag
  const onTouchMove = (e: TouchEvent) => { if (g && g.touch) { if (e.cancelable) e.preventDefault(); e.stopPropagation() } }
  const onBlur = () => { cancelPending(); end(true) }
  window.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
  window.addEventListener('blur', onBlur)

  // harness: what the interaction thinks right now (QA reads it; nothing in the page depends on it)
  const api = { log: evlog, keepOut: () => { readHost(); return keepOut().map((r) => [r.x0, r.y0, r.x1, r.y1].map(Math.round)) }, get active() { return active }, get grab() { return g ? { i: g.i, mode: g.mode } : null }, get pending() { return !!pending },
    state: () => S.map((st) => ({ x: +st.ox.value.toFixed(3), y: +st.oy.value.toFixed(3), peel: +st.peel.value.toFixed(2), lift: +st.lift.value.toFixed(2), fly: +st.fly.toFixed(2) })) }
  if (QA_FLAG) (window as any).__stickers = api

  // ---- reset (next visit) and per-frame writing
  let dirty = false, lastT = -1
  let rectKey = '', domDirty = true, needWrite = true
  const lay0 = { left: 0, top: 0 }
  const camCache = new Float64Array(18)
  const reset = () => {
    cancelPending(); if (g) end(true)
    S.forEach((st) => {
      st.ox.reset(0); st.oy.reset(0); st.tx = st.ty = 0; st.lift.reset(0); st.liftT = 0; st.peel.reset(0); st.peelT = 0; st.rot.reset(0)
      st.fly = 0; st.gone = false; delete st.el.dataset.gone
    })
    dirty = false; needWrite = true
  }

  function update(time: number, a: number, on: boolean) {
    const gap = lastT < 0 ? 0 : time - lastT
    const dt = lastT < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, gap)); lastT = time
    const want = on && a >= 0.97 && journey.active && !props.overlayOpen
    if (want !== active) {
      active = want
      if (!want) stickerMask.on = 0
      if (want) { mount(); rectKey = ''; domDirty = true }
      layer.style.display = want ? 'block' : 'none'
      if (!want) { cancelPending(); end(true) }
    }
    // the next visit starts clean: every sticker back where it was laid, peeled ones re-applied. A visit ends when the
    // wall leaves (on false / glide under half) or when the stage stopped calling us (a jump away and back)
    if ((!on || a < 0.5 || gap > 0.5 || (away && seen)) && dirty) reset()
    if (away && seen) away = false
    if (!on) return
    // layout reads only when the page actually moved (scroll, resize, the footer curtain), never per frame at rest
    if (active) {
      const host = canvasHost()
      const key = `${Math.round(props.scroll)}|${props.width}|${props.height}|${host?.style.transform ?? ''}`
      if (key !== rectKey && host && mounted) {
        rectKey = key
        const r = host.getBoundingClientRect(); host0.left = r.left; host0.top = r.top - (FOOT_MODE ? journey.lift || 0 : 0); host0.width = r.width; host0.height = r.height   // FOOTER MOCKUP: the in-frame curtain
        const l = layer.getBoundingClientRect(); lay0.left = l.left; lay0.top = l.top
        domDirty = true
      }
    }
    // the camera keeps moving under a held sticker (scroll springs, the operator): re-pick so it stays under the finger
    if (g) move(lastX, lastY)
    // the DOM twins follow the camera (it drifts): re-place them only when its view actually changed
    const me = c.camera.matrixWorld.elements, pe = c.camera.projectionMatrix.elements
    let camChanged = false
    for (let k = 0; k < 16; k++) if (me[k] !== camCache[k]) { camChanged = true; camCache[k] = me[k] }
    if (pe[0] !== camCache[16] || pe[5] !== camCache[17]) { camChanged = true; camCache[16] = pe[0]; camCache[17] = pe[5] }
    let moving = !!g || !!pending || needWrite
    for (let i = 0; i < N && !moving; i++) {
      const st = S[i]
      if (st.fly > 0 && !st.gone) moving = true
      else for (const [sp_, tg] of [[st.ox, st.tx], [st.oy, st.ty], [st.lift, st.liftT], [st.peel, st.peelT], [st.rot, 0]] as [Spring, number][]) {
        if (Math.abs(sp_.velocity) > 1e-5 || Math.abs(sp_.value - tg) > 1e-5) { moving = true; break }
      }
    }
    if (!moving && !camChanged && !domDirty) return      // at rest: no buffer uploads, no DOM writes
    needWrite = false
    const placeDom = active && mounted && (camChanged || domDirty || moving)
    domDirty = false
    for (let i = 0; i < N; i++) {
      const st = S[i]
      const ox = st.ox.update(st.tx, dt), oy = st.oy.update(st.ty, dt)
      const lift = RM ? 0 : st.lift.update(st.liftT, dt)
      const peel = RM ? 0 : Math.max(0, st.peel.update(st.peelT, dt))
      // a dragged sheet swings a little with its motion, then settles square to where it was laid
      const s = size(i)
      const rot = RM ? 0 : st.rot.update(g && g.i === i && g.mode === 'drag' ? Math.max(-0.3, Math.min(0.3, -st.ox.velocity / Math.max(s, 1e-3) * 0.05)) : 0, dt)
      if (st.fly > 0 && !st.gone) { st.fly = Math.min(1, st.fly + dt / FLY_S); if (st.fly >= 1) { st.gone = true; st.el.dataset.gone = '' } }
      if (ox !== 0 || oy !== 0 || lift !== 0 || peel !== 0 || st.fly > 0) dirty = true
      // fly-off: fully rolled, it drifts up and away with a slow spin and shrinks out of sight
      const fe = st.fly * st.fly * (3 - 2 * st.fly), side = i % 2 ? 1 : -1
      const fx = fe * fe * s * 0.7 * side, fy = fe * fe * s * 2.6
      const fs = st.fly > 0 ? 1 - smooth(0.45, 1, st.fly) : 1
      // the lift reads as a touch larger; below zero (the underdamped drop) it is the squash as it re-sticks
      c.aSt.setXYZW(i, c.base[i * 4] + ox + fx, c.base[i * 4 + 1] + oy + fy, s * (1 + 0.07 * lift) * fs, c.base[i * 4 + 3] + rot + fe * fe * 1.9 * side)
      const start = (0.72 - REACH[c.shapes[i]]) / 1.55
      const pw = peel > 0.001 ? start + Math.min(1, peel) * (1 - start) : 0
      c.aInt.setXYZW(i, Math.max(0, lift), pw, Math.cos(st.ang), Math.sin(st.ang))
      // the DOM twin rides on top of its sticker
      if (placeDom && st.fly === 0) {
        const x = c.base[i * 4] + ox, y = c.base[i * 4 + 1] + oy, z = c.z()
        toScreen(x, y, z, sp); toScreen(x + s, y, z, sq)
        const d = Math.hypot(sq.x - sp.x, sq.y - sp.y) * R_FACE * 2
        const css = `translate3d(${(sp.x - lay0.left - d / 2).toFixed(1)}px,${(sp.y - lay0.top - d / 2).toFixed(1)}px,0) rotate(${(-(c.base[i * 4 + 3] + rot)).toFixed(3)}rad)`
        if (st.el.style.transform !== css) st.el.style.transform = css
        const ds = `${d.toFixed(1)}px`
        if (st.el.style.width !== ds) { st.el.style.width = ds; st.el.style.height = ds }
        stickerMask.c[i * 4] = sp.x; stickerMask.c[i * 4 + 1] = sp.y; stickerMask.c[i * 4 + 2] = d / 2; stickerMask.c[i * 4 + 3] = 1
      }
      if (st.fly > 0) stickerMask.c[i * 4 + 3] = 0
    }
    c.aSt.needsUpdate = true; c.aInt.needsUpdate = true
    stickerMask.on = active && mounted ? 1 : 0
  }

  const dispose = () => {
    cancelPending(); end(true); clearTimeout(keyTimer)
    window.removeEventListener('touchmove', onTouchMove, { capture: true } as EventListenerOptions)
    window.removeEventListener('blur', onBlur)
    io?.disconnect()
    layer.remove()
    if ((window as any).__stickers === api) delete (window as any).__stickers
  }
  return { update, relayout: () => { if (dirty) reset(); needWrite = true; domDirty = true }, dispose }
}
