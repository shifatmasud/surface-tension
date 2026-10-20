import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { setOdometer } from './Odometer'
import { boot } from '../../app/boot'
import { mix } from '../../core/math'
import { HOUSE } from '../../core/house'
import { preload } from '../../services/preload'
import { logo3d } from '../../preloader/hook' // logo3d hook (helper 99499b45): drives the inline 3D logo

/** S0 — "Drop". A real progress counter (files + shader warm-up), then one droplet opens the page. */
export function Intro() {
  const [gone, setGone] = useState(false)
  const [hidden, setHidden] = useState(false)
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const count = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // PRELOAD: continue from the number the static shell counter already reached (never count backwards); a repeat
    // visit keeps the counter short (its files come from cache; the brand moment stays, the wait does not)
    let raf = 0, eased = preload.shown(), t0 = performance.now(), last = t0, nearT = 0
    const minDur = preload.repeat ? 350 : 1200
    const loop = (now: number) => {
      // real elapsed time (not a per-frame cap): during shader warm-up a frame can take seconds, and a capped dt
      // turned the last 3 % of the counter into ~15 more multi-second frames (60 s+ intros at 2560 px)
      const dt = Math.min((now - last) / 1000, 0.5); last = now
      // never ahead of reality, never faster than the intro needs
      // a stalled loader (slow/software GPU, a lost texture) must never trap the visitor behind the counter:
      // after 12 s, or 3 s parked at >= 97 %, treat the load as done
      let real = boot.progress()
      if (real >= 0.97) { if (!nearT) nearT = now } else nearT = 0
      if (now - t0 > 12000 || (nearT && now - nearT > 3000)) real = 1
      const cap = Math.max(preload.shown(), Math.min(1, (now - t0) / minDur))
      const target = Math.min(real, cap)
      eased = mix(eased, target, 1 - Math.exp(-7 * dt))
      if (target >= 1 && (eased > 0.995 || now - t0 > 12000)) eased = 1
      if (count.current) setOdometer(count.current, eased * 100, 3)
      logo3d.progress(eased) // logo3d hook
      // the curtain starts lifting with the first droplet, so the ring opens as the hero is revealed
      // QA: ?introhold parks the counter at 60 % until window.__introGo is set (frames of the panel + its logo)
      if (/[?&]introhold/.test(location.search) && !(window as any).__introGo) { eased = Math.min(eased, 0.6); if (count.current) setOdometer(count.current, eased * 100, 3); raf = requestAnimationFrame(loop); return }
      if (eased >= 1) { logo3d.exit(); boot.drop(); setTimeout(() => setGone(true), 120); return }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  // hidden, never unmounted: removing the node mid-commit could tear down the sibling Canvas
  return (
    // Shifat 08:51Z: the black panel lifts off like a curtain (expo in-out, flat edge) over the already-rendered hero;
    // reduced motion: a quick fade
    <motion.div className="intro" aria-hidden={gone} initial={reduced ? { opacity: 1 } : { y: '0%' }}
      animate={reduced ? { opacity: gone ? 0 : 1 } : { y: gone ? '-100%' : '0%' }}
      transition={reduced ? { duration: 0.35, ease: HOUSE.INOUT } : { duration: /[?&]introslow/.test(location.search) ? 12 : 1.05, ease: [0.87, 0, 0.13, 1] }}
      onAnimationComplete={() => { if (gone) { setHidden(true); document.documentElement.classList.add('is-lifted') } }}
      style={{ pointerEvents: gone ? 'none' : undefined, visibility: hidden ? 'hidden' : undefined }}>
      <div className="intro__count" ref={count} aria-label="Loading">
        <span className="odo">
          {[0, 1, 2].map((i) => (
            <span className="odo__col" key={i}><span className="odo__strip">{Array.from({ length: 30 }, (_, k) => <span key={k}>{k % 10}</span>)}</span></span>
          ))}
        </span>
      </div>
      <div className="intro__meta">Shifat Masud — portfolio prototype.<br />Warming up the water.</div>
    </motion.div>
  )
}
