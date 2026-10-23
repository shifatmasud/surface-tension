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
  const g = cv.getContext('2d')!
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
  const buf = g.createImageData(cv.width, cv.height), px = new Uint32Array(buf.data.buffer)
  let shown = false, t0 = 0, raf = 0
  const DUR = 1.55, TRAVEL = 0.75
  const ease = (x: number) => 1 - Math.pow(1 - x, 3)
  let fixedT = -1   // QA: __giftSticker.at(t) draws the morph at t seconds (frame-by-frame captures)
  const frame = (now: number) => {
    raf = 0
    const t = fixedT >= 0 ? fixedT : (now - t0) / 1000
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, cv.width, cv.height)
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
      g.putImageData(buf, 0, 0)
    }
    if (land > 0) { g.globalAlpha = land; g.drawImage(img, 0, 0); g.globalAlpha = 1 }
    if (t < DUR && shown && fixedT < 0) raf = requestAnimationFrame(frame)
  }
  const still = () => { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0) }
  const set = (on: boolean) => {
    if (on === shown) return
    shown = on
    btn.classList.toggle('is-on', on)
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    if (on) {
      if (reduced) { still(); return }
      t0 = performance.now(); raf = requestAnimationFrame(frame)
    } else g.clearRect(0, 0, cv.width, cv.height)
  }
  const open = (e: Event) => { e.preventDefault(); giftOpen(btn) }
  btn.addEventListener('click', open)
  ;(window as any).__giftSticker = { set, state: () => ({ shown, points: pts.length, S, W, k }), at: (t: number) => { fixedT = t; if (raf) { cancelAnimationFrame(raf); raf = 0 } frame(0) }, live: () => { fixedT = -1 } }
  return { set, still, destroy() { if (raf) cancelAnimationFrame(raf); btn.removeEventListener('click', open); cv.remove() } }
}
