import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { setOdometer } from './Odometer'
import { boot } from '../../app/boot'
import { mix } from '../../core/math'

/** S0 — "Drop". A real progress counter (files + shader warm-up), then one droplet opens the page. */
export function Intro() {
  const [gone, setGone] = useState(false)
  const [hidden, setHidden] = useState(false)
  const count = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0, eased = 0, t0 = performance.now(), last = t0, nearT = 0
    const minDur = 1600
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
      const cap = Math.min(1, (now - t0) / minDur)
      const target = Math.min(real, cap)
      eased = mix(eased, target, 1 - Math.exp(-7 * dt))
      if (target >= 1 && (eased > 0.995 || now - t0 > 12000)) eased = 1
      if (count.current) setOdometer(count.current, eased * 100, 3)
      if (eased >= 1) { boot.drop().then(() => setGone(true)); return }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  // hidden, never unmounted: removing the node mid-commit could tear down the sibling Canvas
  return (
    <motion.div className="intro" aria-hidden={gone} initial={{ opacity: 1 }} animate={{ opacity: gone ? 0 : 1 }}
      transition={{ duration: 0.9, ease: [0.22, 0.9, 0.24, 1] }}
      onAnimationComplete={() => { if (gone) setHidden(true) }}
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
