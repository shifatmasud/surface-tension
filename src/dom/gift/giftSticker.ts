/**
 * R6.89 GIFT STICKER (Shifat Oct 23 3:43 AM: "Lets use gift scene as full scroll surprise gift. No need double click to
 * trigger. Show a gift sticker (same as our other stickers in portfolio) in bottom part of footer that appears as particle
 * morphing"; tap to open, confirmed 3:46 AM).
 *
 * The logo no longer opens the gift. At the very end of the scroll a sticker cut like the CTA wall's vinyl stickers (a
 * white die-cut margin round a printed face, a slight tilt, a soft cast shadow) gathers out of hot-pink embers on the footer:
 * the same particle-morph language as the Shade DS dissolve, run in reverse. Tapping it (or Enter / Space: it is a real
 * button, "Open gift") opens the existing gift scene (gift.ts → GiftStage), which is unchanged.
 *
 * Drawn on a small 2D canvas at the device's full density (a 76–96 px sticker costs nothing), so it is at least as sharp
 * as the hero pass. The morph is ~1.5 s of one putImageData per frame (~1.4k points written straight into a pixel
 * buffer: no per-point draw calls), then the crisp sticker; nothing runs once it has landed or while it is hidden.
 */
import { giftOpen } from './gift'
import { Spring } from '../../core/spring'   // R6.91: the wall stickers' springs
import { audio } from '../../services/audio'
import { stickerGL } from '../../gl/post/stickerGL'   // R6.92b: the trail refracts the sticker (drawn by the hero pass)

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

// R6.89 (Shifat 4:36 AM "Gift sticker must have hot pink instead of green accent"): the sticker's accent and its embers are
// hot pink #FF2E93 (the rest of the site stays lime)
const ACC = [255, 46, 147]
const GIFT_D = 'M216,72H180.92c.39-.33.79-.65,1.17-1A29.53,29.53,0,0,0,192,49.57,32.62,32.62,0,0,0,158.44,16,29.53,29.53,0,0,0,137,25.91a54.94,54.94,0,0,0-9,14.48,54.94,54.94,0,0,0-9-14.48A29.53,29.53,0,0,0,97.56,16,32.62,32.62,0,0,0,64,49.57,29.53,29.53,0,0,0,73.91,71c.38.33.78.65,1.17,1H40A16,16,0,0,0,24,88v32a16,16,0,0,0,16,16v64a16,16,0,0,0,16,16h60a4,4,0,0,0,4-4V120H40V88h80v32h16V88h80v32H136v92a4,4,0,0,0,4,4h60a16,16,0,0,0,16-16V136a16,16,0,0,0,16-16V88A16,16,0,0,0,216,72ZM84.51,59a13.69,13.69,0,0,1-4.5-10A16.62,16.62,0,0,1,96.59,32h.49a13.69,13.69,0,0,1,10,4.5c8.39,9.48,11.35,25.2,12.39,34.92C109.71,70.39,94,67.43,84.51,59Zm87,0c-9.49,8.4-25.24,11.36-35,12.4C137.7,60.89,141,45.5,149,36.51a13.69,13.69,0,0,1,10-4.5h.49A16.62,16.62,0,0,1,176,49.08,13.69,13.69,0,0,1,171.49,59Z'
const TILT = -8 * Math.PI / 180

type P = { tx: number; ty: number; sx: number; sy: number; c: number; d: number; sw: number }

/** the sticker, drawn into a canvas of css size W × W at density k: margin, face, glyph, shadow (the CTA wall's recipe) */
function drawSticker(W: number, S: number, k: number, shadow: boolean) {
  const cv = document.createElement('canvas'); cv.width = cv.height = Math.round(W * k)
  const c = cv.getContext('2d')!
  c.scale(k, k); c.translate(W / 2, W / 2); c.rotate(TILT)
  const R = S / 2, m = S * 0.075
  const shape = (r: number) => { c.beginPath(); (c as any).roundRect ? (c as any).roundRect(-r, -r, r * 2, r * 2, r * 0.36) : c.rect(-r, -r, r * 2, r * 2) }
  if (shadow) { c.save(); c.shadowColor = 'rgba(10, 12, 14, .28)'; c.shadowBlur = S * 0.14; c.shadowOffsetY = S * 0.05; c.fillStyle = '#f4f4f2'; shape(R); c.fill(); c.restore() }
  c.fillStyle = '#f4f4f2'; shape(R); c.fill()             // the die-cut white vinyl margin
  c.fillStyle = '#121315'; shape(R - m); c.fill()          // the printed face (ink)
  const s = (R - m) * 1.08, g = s / 128                    // the gift glyph (Phosphor "Gift", fill), hot pink
  c.save(); c.scale(g, g); c.translate(-128, -128); c.fillStyle = '#ff2e93'; c.fill(new Path2D(GIFT_D)); c.restore()
  // a broad soft sheen across the vinyl, as on the wall's stickers under their raking light
  const gr = c.createLinearGradient(-R, -R, R, R)
  gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.0)'); gr.addColorStop(1, 'rgba(255,255,255,0.04)')
  c.fillStyle = gr; shape(R); c.fill()
  return cv
}

export function mountGiftSticker(btn: HTMLButtonElement) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const S = btn.offsetWidth || 80                           // the sticker's css size (the button is the hit area)
  const W = Math.round(S * 2.4)                             // the canvas: room for the embers to gather from
  const k = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
  const cv = document.createElement('canvas'); cv.className = 'gift-sticker__cv'; cv.setAttribute('aria-hidden', 'true')
  cv.width = cv.height = Math.round(W * k); cv.style.width = cv.style.height = W + 'px'
  btn.appendChild(cv)
  stickerGL.cv = cv; stickerGL.el = btn; stickerGL.W = W; stickerGL.dirty = true
  const cx2 = cv.getContext('2d')!
  const img = drawSticker(W, S, k, true)
  // the points: one per ~2 css px cell of the sticker (no shadow), each with its target, colour, delay and swirl
  const ref = drawSticker(W, S, 1, false), rg = ref.getContext('2d')!.getImageData(0, 0, W, W).data
  const pts: P[] = []
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const step = 2
  for (let y = 0; y < W; y += step) for (let x = 0; x < W; x += step) {
    const i = (y * W + x) * 4
    if (rg[i + 3] < 160) continue
    const a = rnd() * Math.PI * 2, r = S * (0.55 + rnd() * 0.75)
    // the front: the sticker gathers from its lower edge up (with noise), the way the Shade DS parts went top → bottom
    const front = 1 - y / W
    pts.push({ tx: x, ty: y, sx: W / 2 + Math.cos(a) * r, sy: W / 2 + Math.sin(a) * r * 0.8 + S * 0.25, c: (rg[i] << 16) | (rg[i + 1] << 8) | rg[i + 2], d: 0.5 * (front * 0.7 + rnd() * 0.3), sw: (rnd() - 0.5) * 2 })
  }
  const buf = cx2.createImageData(cv.width, cv.height), px = new Uint32Array(buf.data.buffer)
  let shown = false, t0 = 0, raf = 0
  const DUR = 1.55, TRAVEL = 0.75
  const ease = (x: number) => 1 - Math.pow(1 - x, 3)
  let fixedT = -1   // QA: __giftSticker.at(t) draws the morph at t seconds (frame-by-frame captures)
  const frame = (now: number) => {
    raf = 0
    const t = fixedT >= 0 ? fixedT : (now - t0) / 1000
    cx2.setTransform(1, 0, 0, 1, 0, 0)
    cx2.clearRect(0, 0, cv.width, cv.height)
    const land = Math.min(1, Math.max(0, (t - 1.05) / 0.4))   // the crisp sticker fades up as the last embers land
    if (land < 1) {
      px.fill(0)
      const fade = 1 - land, cw = cv.width, ch = cv.height, full = Math.max(1, Math.round(step * k))
      for (const p of pts) {
        const u = Math.min(1, Math.max(0, (t - p.d) / TRAVEL))
        if (u <= 0) continue
        const e = ease(u)
        // a slow swirl that settles: the embers drift in, they do not fly
        const sw = (1 - e) * p.sw * S * 0.18
        const x = p.sx + (p.tx - p.sx) * e + sw, y = p.sy + (p.ty - p.sy) * e - sw * 0.5
        // a pink ember → the sticker's own colour over the last stretch of the flight
        const m = Math.min(1, Math.max(0, (u - 0.45) / 0.45)), r0 = (p.c >> 16) & 255, g0 = (p.c >> 8) & 255, b0 = p.c & 255
        const a = Math.min(1, u * 3) * fade
        const R = ACC[0] + (r0 - ACC[0]) * m, G = ACC[1] + (g0 - ACC[1]) * m, B = ACC[2] + (b0 - ACC[2]) * m
        const col = (Math.round(a * 255) << 24) | (Math.round(B) << 16) | (Math.round(G) << 8) | Math.round(R)   // straight alpha, little-endian RGBA
        const X = Math.round(x * k), Y = Math.round(y * k), sz = u < 1 ? Math.max(1, Math.round(step * k * 0.7)) : full   // landed points tile the face solid
        for (let yy = 0; yy < sz; yy++) { const row = Y + yy; if (row < 0 || row >= ch) continue; for (let xx = 0; xx < sz; xx++) { const col_ = X + xx; if (col_ >= 0 && col_ < cw) px[row * cw + col_] = col } }
      }
      cx2.putImageData(buf, 0, 0)
    }
    if (land > 0) { cx2.globalAlpha = land; cx2.drawImage(img, 0, 0); cx2.globalAlpha = 1 }
    stickerGL.dirty = true
    if (t < DUR && shown && fixedT < 0) raf = requestAnimationFrame(frame)
  }
  // ---- R6.91 (Shifat Oct 23 6:51 AM "make gift sticker behave same like others. Peel, & draggable"): the CTA wall's
  // sticker handling (stickerInteract.ts), replicated on this canvas so it reads the same: the same springs, thresholds,
  // peel geometry (a fold perpendicular to the grabbed corner, rolling back over a small radius to show the white backing
  // paper), lift (a touch larger, the shadow dropping away and softening), swing, squash on the drop, long-press pick-up
  // on touch and the fly-off past the peel threshold. A tap or click that does not drag still opens the gift; Enter /
  // Space too (it is a real button). The wall's stickers come back on the next visit; this one, being the way into the
  // gift, gathers again out of its embers a moment after it has flown off.
  const face = drawSticker(W, S, k, false)
  // R6.92c: the scratch canvases the shadows are cast on (see draw)
  const shadowCv = document.createElement('canvas'), flapCv = document.createElement('canvas')
  shadowCv.width = shadowCv.height = flapCv.width = flapCv.height = cv.width
  const LONG_PRESS = 400, SLOP = 9, PEEL_OFF = 0.35, FLY_S = 1.35, REACH = 0.53
  const st = {
    ox: new Spring(0, 2.4, 0.62, 0), oy: new Spring(0, 2.4, 0.62, 0), tx: 0, ty: 0,
    lift: new Spring(0, 2.6, 0.42, 0), liftT: 0, peel: new Spring(0, 2.8, 0.62, 0), peelT: 0, ang: Math.PI / 4,
    rot: new Spring(0, 2.0, 0.5, 0), fly: 0,
  }
  let g: null | { id: number; mode: 'drag' | 'peel'; gx: number; gy: number; sx: number; sy: number; x0: number; y0: number; moved: boolean; touch: boolean } = null
  let pending: null | { id: number; x0: number; y0: number; x: number; y: number; t: number; timer: number } = null
  let suppressClick = false, iraf = 0, last = 0, reborn = 0
  const landed = () => shown && !raf && fixedT < 0
  /** a client point → sticker space (css px from the sticker's centre, un-tilted), and as a fraction of its size */
  const local = (cx: number, cy: number) => {
    const r = btn.getBoundingClientRect(), x = cx - (r.left + r.width / 2), y = cy - (r.top + r.height / 2)
    const a = -(TILT + st.rot.value), ca = Math.cos(a), sa = Math.sin(a)
    const sc = 1 + 0.07 * Math.max(0, st.lift.value)
    return { x: (x * ca - y * sa) / sc, y: (x * sa + y * ca) / sc }
  }
  const peelAngle = (q: { x: number; y: number }) => (reduced ? null : Math.abs(q.x) > 0.24 * S && Math.abs(q.y) > 0.24 * S ? Math.atan2(Math.sign(q.y), Math.sign(q.x)) : null)
  const shape = (c: CanvasRenderingContext2D, r: number) => { c.beginPath(); (c as any).roundRect ? (c as any).roundRect(-r, -r, r * 2, r * 2, r * 0.36) : c.rect(-r, -r, r * 2, r * 2) }
  /** the sticker as it is now: its shadow (higher = further and softer), the flat face up to the fold, the backing paper of
   *  the rolled-back flap (shaded by the roll) casting onto the face, and the bright rolled edge */
  const draw = () => {
    const L = reduced ? 0 : Math.max(0, st.lift.value), pe = reduced ? 0 : Math.max(0, st.peel.value)
    const start = (0.72 - REACH) / 1.55, pw = pe > 0.001 ? start + Math.min(1, pe) * (1 - start) : 0
    const t = (0.72 - pw * 1.55) * S, rr = (0.055 + 0.05 * pw) * S, cdx = Math.cos(st.ang), cdy = Math.sin(st.ang)
    const R = S / 2, base = (c: CanvasRenderingContext2D = cx2) => { c.setTransform(k, 0, 0, k, 0, 0); c.translate(W / 2, W / 2); c.rotate(TILT) }
    // the half-plane on one side of the fold (sticker space), as a big quad
    const half = (beyond: boolean, at: number, c: CanvasRenderingContext2D = cx2) => {
      const nx = cdx, ny = cdy, px = -ny, py = nx, B = S * 3, s = beyond ? 1 : -1
      c.beginPath(); c.moveTo(nx * at + px * B, ny * at + py * B); c.lineTo(nx * at - px * B, ny * at - py * B)
      c.lineTo(nx * (at + s * B) - px * B, ny * (at + s * B) - py * B); c.lineTo(nx * (at + s * B) + px * B, ny * (at + s * B) + py * B); c.closePath()
    }
    // R6.92c (the dark ring round the sticker after a hover / under the trail): Chromium keeps a canvas that takes a
    // shadowBlur fill and then a drawImage in the same frame from clearing between frames once its pixels are read back
    // (each frame the hero pass uploads it to the GPU), so the soft shadow piled up frame after frame into a thick black
    // ring (measured: alpha 49 → 253 one row under the edge in ~20 hover frames; clearRect and reset() both left it).
    // Every shadow is now cast on its own scratch canvas that only ever takes plain fills (never a drawImage), and the
    // visible canvas only takes clears, drawImages and plain fills: the same shadow, the same numbers, nothing piles up.
    const sh = shadowCv.getContext('2d')!
    sh.setTransform(1, 0, 0, 1, 0, 0); sh.clearRect(0, 0, shadowCv.width, shadowCv.height)
    // the cast shadow (the flat part only; the flap's own shadow follows)
    base(sh); sh.save()
    if (pw > 0) { half(false, t, sh); sh.clip() }
    sh.shadowColor = `rgba(10, 12, 14, ${(0.28 * (1 - 0.45 * L)).toFixed(3)})`; sh.shadowBlur = S * (0.14 + 0.3 * L); sh.shadowOffsetY = S * (0.05 + 0.16 * L)   // (device px, as drawSticker's)
    sh.fillStyle = '#f4f4f2'; shape(sh, R); sh.fill(); sh.restore()
    sh.setTransform(1, 0, 0, 1, 0, 0)
    cx2.setTransform(1, 0, 0, 1, 0, 0); cx2.clearRect(0, 0, cv.width, cv.height)
    cx2.drawImage(shadowCv, 0, 0)
    // the flat face up to the fold
    base(); cx2.save()
    if (pw > 0) { half(false, t); cx2.clip() }
    cx2.setTransform(1, 0, 0, 1, 0, 0); cx2.drawImage(face, 0, 0); cx2.restore()
    if (pw > 0) {
      // the flap: what lay beyond the fold, rolled back over it (mirrored about the roll's far side) showing its paper;
      // drawn with its shadow on the flap scratch canvas (plain fills only), then laid over the face
      const fl = flapCv.getContext('2d')!
      fl.setTransform(1, 0, 0, 1, 0, 0); fl.clearRect(0, 0, flapCv.width, flapCv.height)
      const tr = t + rr * 1.2
      base(fl)
      const m11 = 1 - 2 * cdx * cdx, m12 = -2 * cdx * cdy, m22 = 1 - 2 * cdy * cdy
      fl.transform(m11, m12, m12, m22, 2 * tr * cdx, 2 * tr * cdy)
      fl.save(); half(true, t, fl); fl.clip()
      const gr = fl.createLinearGradient(cdx * t, cdy * t, cdx * (t + S), cdy * (t + S))
      gr.addColorStop(0, '#e6e6e6'); gr.addColorStop(0.35, '#d2d2d2'); gr.addColorStop(1, '#c4c4c4')
      fl.shadowColor = 'rgba(8, 10, 12, .26)'; fl.shadowBlur = S * 0.07
      fl.fillStyle = gr; shape(fl, R); fl.fill(); fl.restore()
      fl.setTransform(1, 0, 0, 1, 0, 0)
      cx2.setTransform(1, 0, 0, 1, 0, 0); cx2.drawImage(flapCv, 0, 0)
      // the rolled edge: a bright crease along the fold, inside the sticker's outline
      base(); cx2.save(); shape(cx2, R); cx2.clip()
      const eg = cx2.createLinearGradient(cdx * (t - rr), cdy * (t - rr), cdx * (t + rr * 1.6), cdy * (t + rr * 1.6))
      eg.addColorStop(0, 'rgba(255,255,255,0)'); eg.addColorStop(0.55, 'rgba(255,255,255,.55)'); eg.addColorStop(1, 'rgba(255,255,255,0)')
      half(true, t - rr); cx2.fillStyle = eg; cx2.fill(); cx2.restore()
    }
    cx2.setTransform(1, 0, 0, 1, 0, 0)
    stickerGL.dirty = true
  }
  const place = () => {
    const L = reduced ? 0 : st.lift.value, fe = st.fly * st.fly * (3 - 2 * st.fly), side = 1
    const fx = fe * fe * S * 0.7 * side, fy = -fe * fe * S * 2.6, fs = st.fly > 0 ? 1 - smooth(0.45, 1, st.fly) : 1
    const rot = st.rot.value + fe * fe * 1.9 * side
    const css = `translate3d(${(st.ox.value + fx).toFixed(1)}px,${(st.oy.value + fy).toFixed(1)}px,0) rotate(${rot.toFixed(3)}rad) scale(${((1 + 0.07 * L) * fs).toFixed(3)})`
    if (btn.style.transform !== css) btn.style.transform = css
    stickerGL.rot = rot; stickerGL.sc = (1 + 0.07 * L) * fs
  }
  const moving = () => !!g || !!pending || st.fly > 0 || [[st.ox, st.tx], [st.oy, st.ty], [st.lift, st.liftT], [st.peel, st.peelT], [st.rot, 0]].some(([s_, tg]) => Math.abs((s_ as Spring).velocity) > 1e-4 || Math.abs((s_ as Spring).value - (tg as number)) > 1e-4)
  const tick = (now: number) => {
    iraf = 0
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now
    st.ox.update(st.tx, dt); st.oy.update(st.ty, dt); st.lift.update(st.liftT, dt); st.peel.update(st.peelT, dt)
    st.rot.update(g && g.mode === 'drag' && !reduced ? Math.max(-0.3, Math.min(0.3, st.ox.velocity / S * 0.05 * 0.5)) : 0, dt)
    if (st.fly > 0) {
      st.fly = Math.min(1, st.fly + dt / FLY_S)
      if (st.fly >= 1) { btn.classList.add('is-gone'); reborn = window.setTimeout(regather, 1100) }
    }
    if (landed()) draw()
    place()
    if (moving() && st.fly < 1) iraf = requestAnimationFrame(tick); else last = 0
  }
  const kick = () => { if (!iraf) { last = 0; iraf = requestAnimationFrame(tick) } }
  const resetAll = () => {
    st.ox.reset(0); st.oy.reset(0); st.tx = st.ty = 0; st.lift.reset(0); st.liftT = 0; st.peel.reset(0); st.peelT = 0; st.rot.reset(0); st.fly = 0
    g = null; if (pending) { clearTimeout(pending.timer); pending = null } btn.style.transform = ''; btn.classList.remove('is-gone'); stickerGL.rot = 0; stickerGL.sc = 1
  }
  function regather() { reborn = 0; if (!shown) return; resetAll(); shown = false; set(true) }   // the embers gather it again where it lived
  const begin = (id: number, cx: number, cy: number, touch: boolean) => {
    const q = local(cx, cy), ang = peelAngle(q)
    g = { id, mode: ang === null ? 'drag' : 'peel', gx: cx - st.ox.value, gy: cy - st.oy.value, sx: cx, sy: cy, x0: cx, y0: cy, moved: false, touch }
    document.documentElement.dataset.stkDrag = ''
    if (ang !== null) { st.ang = ang; st.peelT = 0.08 }
    else {
      st.liftT = reduced ? 0 : 1; st.ox.tune(7, 1, 0); st.oy.tune(7, 1, 0); st.tx = st.ox.value; st.ty = st.oy.value
      if (!reduced) { st.ang = Math.atan2(q.y >= 0 ? 1 : -1, q.x >= 0 ? 1 : -1); st.peelT = 0.17 }
    }
    btn.dataset.cursorLabel = ang !== null ? 'Peel' : 'Drag'
    audio.tick()
    if (touch && navigator.vibrate) try { navigator.vibrate(8) } catch { /* not allowed */ }
    kick()
  }
  const move = (cx: number, cy: number) => {
    if (!g) return
    if (!g.moved && Math.hypot(cx - g.x0, cy - g.y0) > SLOP) g.moved = true
    if (g.mode === 'drag') { st.tx = cx - g.gx; st.ty = cy - g.gy }
    else {
      // pulling the grabbed corner back across the sticker rolls the fold toward the far side, at half the finger's speed
      const dx = cx - g.sx, dy = cy - g.sy, a = st.ang + TILT, along = -(dx * Math.cos(a) + dy * Math.sin(a))
      const cells = (Math.max(along, 0) + Math.hypot(dx, dy) * 0.25) / S
      st.peelT = Math.min(1, Math.max(0.08, (cells * 0.5) / 1.55 * 1.25))
    }
    kick()
  }
  const end = (cancel = false) => {
    delete document.documentElement.dataset.stkDrag
    if (!g) return
    const was = g; g = null
    if (!was.moved && !cancel) { st.liftT = 0; st.peelT = 0; st.ox.tune(2.4, 0.62, 0); st.oy.tune(2.4, 0.62, 0); kick(); return }   // a click / tap: it opens (the click event follows)
    suppressClick = true; window.setTimeout(() => { suppressClick = false }, 400)   // the click that ends a drag lands at once; a touch drag may send none
    if (was.mode === 'drag') {
      st.liftT = 0; st.peelT = 0
      if (reduced) { st.ox.tune(4, 1, 0); st.oy.tune(4, 1, 0) } else { st.ox.tune(2.4, 0.62, 0); st.oy.tune(2.4, 0.62, 0) }
      const kk = reduced ? 0 : 0.12
      st.tx += Math.max(-S, Math.min(S, st.ox.velocity * kk)); st.ty += Math.max(-S, Math.min(S, st.oy.velocity * kk))
      // dropped where it can still be seen and reached (the screen, clear of its edges)
      const r = btn.getBoundingClientRect(), cx0 = r.left + r.width / 2 - st.ox.value, cy0 = r.top + r.height / 2 - st.oy.value, m = S * 0.6
      st.tx = Math.max(m - cx0, Math.min(innerWidth - m - cx0, st.tx)); st.ty = Math.max(m + 56 - cy0, Math.min(innerHeight - m - cy0, st.ty))
      audio.plip(0.45, 0.6 + Math.random() * 0.3)
    } else if (!cancel && Math.max(st.peel.value, st.peelT) > PEEL_OFF && !reduced) { st.fly = 0.0001; st.peelT = Math.max(st.peel.value, 0.75); audio.plip(0.3, 1.35) }
    else { st.peelT = 0; audio.plip(0.3, 0.9) }
    kick()
  }
  const cancelPending = () => { if (pending) { clearTimeout(pending.timer); pending = null } }
  const onDown = (e: PointerEvent) => {
    if (!landed() || st.fly > 0 || g || e.button > 0) return
    if (e.pointerType === 'mouse') { e.preventDefault(); try { btn.setPointerCapture(e.pointerId) } catch { /* gone */ } begin(e.pointerId, e.clientX, e.clientY, false); return }
    // touch / pen: a long press picks it up, so a swipe that starts on it still scrolls (and a quick tap opens the gift)
    const id = e.pointerId, x = e.clientX, y = e.clientY
    pending = { id, x0: x, y0: y, x, y, t: performance.now(), timer: window.setTimeout(() => { if (pending && pending.id === id) { const p = pending; pending = null; try { btn.setPointerCapture(id) } catch { /* gone */ } begin(id, p.x, p.y, true); if (g) g.moved = true } }, LONG_PRESS) }
  }
  const onMove = (e: PointerEvent) => {
    if (pending && pending.id === e.pointerId) {
      // as on the wall: judged by when the move HAPPENED, so a move after a still hold picks it up even on a busy main thread
      if (e.timeStamp - pending.t >= LONG_PRESS) { const p = pending; cancelPending(); try { btn.setPointerCapture(p.id) } catch { /* gone */ } begin(p.id, p.x, p.y, true); if (g) g.moved = true }
      else { if (Math.hypot(e.clientX - pending.x0, e.clientY - pending.y0) > SLOP) cancelPending(); else { pending.x = e.clientX; pending.y = e.clientY } return }
    }
    if (g && g.id === e.pointerId) { if (g.touch) e.preventDefault(); move(e.clientX, e.clientY); return }
    // hover (mouse): a corner lifts a hair to say "peel me"; the face rises a touch
    if (!g && e.pointerType === 'mouse' && landed() && st.fly === 0) {
      const ang = peelAngle(local(e.clientX, e.clientY))
      if (ang !== null) { st.ang = ang; st.peelT = 0.07; st.liftT = 0 } else { st.peelT = 0; st.liftT = reduced ? 0 : 0.14 }
      btn.dataset.cursorLabel = ang !== null ? 'Peel' : 'Open'
      kick()
    }
  }
  const onUp = (e: PointerEvent) => { if (pending && pending.id === e.pointerId) cancelPending(); if (g && g.id === e.pointerId) end(e.type === 'pointercancel') }
  const onLeave = () => { if (!g) { st.peelT = 0; st.liftT = 0; kick() } }
  btn.addEventListener('pointerdown', onDown); btn.addEventListener('pointermove', onMove); btn.addEventListener('pointerup', onUp)
  btn.addEventListener('pointercancel', onUp); btn.addEventListener('pointerleave', onLeave)
  btn.addEventListener('contextmenu', (e) => { if (g || pending) e.preventDefault() })
  // a picked-up sticker owns the finger: the page's touch scroll must not see the drag (the wall's own guard)
  const onTouchMove = (e: TouchEvent) => { if (g && g.touch) { if (e.cancelable) e.preventDefault(); e.stopPropagation() } }
  const onBlur = () => { cancelPending(); if (g) end(true) }
  window.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
  window.addEventListener('blur', onBlur)

  const still = () => { cx2.setTransform(1, 0, 0, 1, 0, 0); cx2.clearRect(0, 0, cv.width, cv.height); cx2.drawImage(img, 0, 0); stickerGL.dirty = true }
  function set(on: boolean) {
    if (on === shown) return
    shown = on
    btn.classList.toggle('is-on', on)
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    if (!on) { if (reborn) { clearTimeout(reborn); reborn = 0 } resetAll() }
    if (on) {
      if (reduced) { still(); return }
      t0 = performance.now(); raf = requestAnimationFrame(frame)
    } else { cx2.clearRect(0, 0, cv.width, cv.height); stickerGL.dirty = true }
  }
  // a click opens the gift unless it ended a drag or a peel (Enter / Space on the button arrive here as clicks too)
  const open = (e: Event) => { e.preventDefault(); if (suppressClick) { suppressClick = false; return } if (st.fly > 0) return; giftOpen(btn) }
  btn.addEventListener('click', open)
  ;(window as any).__giftSticker = { set, state: () => ({ shown, points: pts.length, S, W, k, peel: +st.peel.value.toFixed(3), lift: +st.lift.value.toFixed(3), ox: +st.ox.value.toFixed(1), oy: +st.oy.value.toFixed(1), fly: st.fly }), at: (t: number) => { fixedT = t; if (raf) { cancelAnimationFrame(raf); raf = 0 } frame(0) }, live: () => { fixedT = -1 } }
  return { set, still, destroy() { if (stickerGL.el === btn) { stickerGL.el = null; stickerGL.cv = null }; if (raf) cancelAnimationFrame(raf); if (iraf) cancelAnimationFrame(iraf); if (reborn) clearTimeout(reborn); btn.removeEventListener('click', open); window.removeEventListener('touchmove', onTouchMove, { capture: true } as EventListenerOptions); window.removeEventListener('blur', onBlur); cv.remove() } }
}
