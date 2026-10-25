import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { boot } from '../../app/boot'
import { mix } from '../../core/math'
import { buildReels, paintReels, rollPositions } from './maskedRoll'
import { HOUSE } from '../../core/house'
import { preload } from '../../services/preload'
import { logo3d } from '../../preloader/hook' // logo3d hook (helper 99499b45): drives the inline 3D logo

/** the static shell's odometer (index.html), captured before React's first commit clears #root */
const shellOdo = typeof document !== 'undefined' ? document.querySelector<HTMLElement>('.shell-intro .intro__count .odo') : null

/** the counter's paint: dom/ui/maskedRoll.ts (Shifat 19:15Z, the masked roll is the page's signature move; this counter
 *  is its reference). Positions are a pure function of the value, so the shell → app handoff repaints the same frame */
function paintCounter(root: HTMLElement, v: number) { paintReels(root.querySelectorAll<HTMLElement>('.odo__strip'), rollPositions(v, 3)) }

/** S0 — "Drop". A real progress counter (files + shader warm-up), then one droplet opens the page. */
export function Intro() {
  const [gone, setGone] = useState(false)
  const [hidden, setHidden] = useState(false)
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const count = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  // DIAG: paint the reels before the first paint. Unpainted strips sit at their first glyph, so for the 2–3 frames
  // between mount and the first rAF the counter read "000" (the shell had just shown e.g. "019"): a visible drop to zero
  // PRELOAD (Shifat 18:46Z "first number jumps & changes"): adopt the shell's own reels (index.html), which have been
  // rolling since the first paint, instead of drawing new ones: same nodes, same value, same face, so the handoff is
  // invisible. React never owns these nodes (the count div has no React children); no shell (dev): build the same reels
  useLayoutEffect(() => {
    const el = count.current; if (!el) return
    if (!el.querySelector('.odo')) el.appendChild(shellOdo?.querySelector('.odo__strip') ? shellOdo : buildReels(3))
    const so = (window as any).__stodo; if (so) so.adopted = true
    paintCounter(el, preload.shown() * 100)
  }, [])
  useEffect(() => {
    // PRELOAD: continue from the number the static shell counter already reached (never count backwards); a repeat
    // visit keeps the counter short (its files come from cache; the brand moment stays, the wait does not)
    const s0 = preload.shown()
    let raf = 0, eased = s0, t0 = performance.now(), last = t0, nearT = 0, nearV = 0
    const minDur = preload.repeat ? 350 : 1200
    // R7.08b (Shifat 7:01 PM: "when it goes 95 or 96 it instantly jumps cuts to 100"): the 12 s stall cap used to set the
    // counter straight to 100 (his M02s loads for ~12 s+, so it cut from 95/96), and a finished load let the last points run
    // at the full no-snap speed (a few frames). Once the load is done the rest now rolls on an ease-out tail of at least
    // 400 ms (longer only when far from 100, keeping <= ~1.25 points a frame), and the drop waits for the painted 100
    let tailT = 0, tailFrom = 0, tailMs = 400
    const loop = (now: number) => {
      // real elapsed time (not a per-frame cap): during shader warm-up a frame can take seconds, and a capped dt
      // turned the last 3 % of the counter into ~15 more multi-second frames (60 s+ intros at 2560 px)
      const dt = Math.min((now - last) / 1000, 0.5); last = now
      // never ahead of reality, never faster than the intro needs
      // a stalled loader (slow/software GPU, a lost texture) must never trap the visitor behind the counter:
      // after 12 s, or 3 s parked at >= 97 %, treat the load as done
      let real = boot.progress()
      // PERFGOV: "parked" means not moving: the later stages' warm-up (gl/Scene.tsx) keeps the real progress rising
      // in small steps above 97 %, and that is not a stall
      if (real >= 0.97) { if (!nearT || real > nearV + 1e-4) { nearT = now; nearV = real } } else nearT = 0
      if (now - t0 > 12000 || (nearT && now - nearT > 3000)) real = 1
      // PRELOAD: the time cap continues from the number the shell handed over (it used to restart at 0, so the counter
      // parked on the shell's number for ~s0 × minDur, measured 430 ms at 1440)
      const cap = s0 + (1 - s0) * Math.min(1, (now - t0) / minDur)
      const target = Math.min(real, cap)
      // DIAG: never backwards (the shell counter's number, a late-registered next-section asset or a re-weighted task
      // can lower the target), and a bounded step: after a frame the main thread spent linking shaders the eased step
      // was ~97 % of the gap at once (the counter jumped 32 → 98 in one frame on ANGLE/D3D11). 6 points per frame at
      // 60 fps; on a slow GPU (long frames) up to 30 points, so the roll never takes more than a few frames
      // W22 (GL load-time cut, option b: the counter stays the hero's REAL progress): once the load is really done
      // (target 1) the last stretch rolled on an exponential tail (rate 7/s to 0.999: ~0.6–0.9 s of counting after the
      // hero was ready at 60 fps). It now rolls straight on at the fastest speed the no-snap rule allows (1.2 points a
      // frame at 60 fps), so the drop follows the real readiness by a few frames instead of most of a second
      const next = target >= 1 ? 1 : mix(eased, target, 1 - Math.exp(-7 * dt))
      // PRELOAD (Shifat 19:14Z, no snapping digits): at most ~1.2 points a frame at 60 fps, so the units reel never skips
      // digits and every carry slides over 2+ frames; long frames (a slow GPU) still catch up by time (dt × 0.6)
      if (target >= 1) {
        if (!tailT) { tailT = now; tailFrom = eased; tailMs = Math.max(400, (1 - tailFrom) * 100 / 75 * 1000) }
        const k = Math.min(1, (now - tailT) / tailMs)
        // and never more than ~1.25 points per painted frame, so 96, 97, 98, 99 each show even when the last load frames are long
        const tv = k >= 1 ? 1 : tailFrom + (1 - tailFrom) * (1 - (1 - k) * (1 - k))
        eased = Math.max(eased, Math.min(tv, eased + 0.0125))
        if (k >= 1 && eased > 0.9995) eased = 1
      } else eased = Math.max(eased, Math.min(next, eased + Math.max(0.012, dt * 0.6)))
      if (count.current) paintCounter(count.current, eased * 100)
      logo3d.progress(eased) // logo3d hook
      // the curtain starts lifting with the first droplet, so the ring opens as the hero is revealed
      // QA: ?introhold parks the counter at 60 % until window.__introGo is set (frames of the panel + its logo)
      if (/[?&]introhold/.test(location.search) && !(window as any).__introGo) { eased = Math.min(eased, 0.6); if (count.current) paintCounter(count.current, eased * 100); raf = requestAnimationFrame(loop); return }
      if (eased >= 1) { boot.drop(); settle(now); return }
      if (dts.length < 24) dts.push(dt); else { dts[di] = dt; di = (di + 1) % 24 }
      raf = requestAnimationFrame(loop)
    }
    // CURTAIN (Shifat 13:04Z "in my phone it instantly vanishes upon finishing"): the drop's first frames are the heaviest of
    // the load (full-rate chain from the drop on, 3 back-to-back env cube captures, the droplet), and the old path started
    // the lift ~120 ms + a React commit + a passive effect after the drop, so on a phone the curve's visible middle (it
    // crosses ~80 % of the screen in ~300 ms) landed on those stalled frames: two or three frames, i.e. a vanish. Now the
    // drop's heavy frames run first (the panel still covers them, the logo keeps spinning), the lift starts on the first
    // frame after two consecutive normal-length frames once the 3 env-capture frames are past (normal: ≤ 1.5× the counter's
    // own frame time, at least 24 ms, or within 30 % of the shortest frame since the drop), and it is
    // started here, in the frame, not through a timer and a React effect. Capped at 450 ms after the drop so a device whose
    // every frame is long still lifts. Same curve, same duration, same flat edge; reduced motion keeps its 350 ms fade.
    const dts: number[] = []; let di = 0
    const settle = (t0d: number) => {
      const s = dts.slice().sort((a, b) => a - b), med = s.length ? s[s.length >> 1] * 1000 : 16.7
      const thr = Math.max(24, med * 1.5)
      let prev = t0d, n = 0, lo = 1e9, d1 = 1e9
      const step = (now: number) => {
        const d = now - prev; prev = now; n++
        if (n > 1) lo = Math.min(lo, d)
        // normal = the counter's own frame time, or (a phone whose full-rate hero frame is simply longer than the counter's
        // third-rate one) within 30 % of the shortest frame since the drop; the first 3 frames (the env captures) never count
        const norm = (x: number) => x <= thr || x <= lo * 1.3
        if ((n >= 4 && norm(d) && norm(d1)) || now - t0d > 450) { lift(); return }
        d1 = d
        raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    }
    const lift = () => {
      const el = root.current
      logo3d.exit()
      if (el) {
        // W24 (framer-motion removed): the curtain lift as WAAPI — same curve (expo in-out, 1.05 s), same reduced-motion fade
        const a = reduced
          ? el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: HOUSE.CSS_INOUT, fill: 'forwards' })
          : el.animate([{ transform: 'translateY(0%)' }, { transform: 'translateY(-100%)' }], { duration: /[?&]introslow/.test(location.search) ? 12000 : 1050, easing: 'cubic-bezier(0.87, 0, 0.13, 1)', fill: 'forwards' })
        a.onfinish = () => { setHidden(true); document.documentElement.classList.add('is-lifted') }
      } else document.documentElement.classList.add('is-lifted')
      setGone(true)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  // hidden, never unmounted: removing the node mid-commit could tear down the sibling Canvas
  return (
    // Shifat 08:51Z: the black panel lifts off like a curtain (expo in-out, flat edge) over the already-rendered hero;
    // reduced motion: a quick fade
    <div ref={root} className="intro" aria-hidden={gone}
      style={{ pointerEvents: gone ? 'none' : undefined, visibility: hidden ? 'hidden' : undefined }}>
      <div className="intro__count" ref={count} aria-label="Loading" />
      {/* W19 (Shifat 21:21Z m:f74347cc "Just remove the text content"): the preloader is the odometer only */}
    </div>
  )
}
