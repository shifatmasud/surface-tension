import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { setOdometer } from './Odometer'
import { boot } from '../../app/boot'
import { mix } from '../../core/math'

/** S0 — "Drop". A real progress counter (files + shader warm-up), then one droplet opens the page. */
export function Intro() {
  const [gone, setGone] = useState(false)
  const count = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0, eased = 0, t0 = performance.now(), last = t0
    const minDur = 1600
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05); last = now
      // never ahead of reality, never faster than the intro needs
      const real = boot.progress()
      const cap = Math.min(1, (now - t0) / minDur)
      const target = Math.min(real, cap)
      eased = mix(eased, target, 1 - Math.exp(-7 * dt))
      if (target >= 1 && eased > 0.995) eased = 1
      if (count.current) setOdometer(count.current, eased * 100, 3)
      if (eased >= 1) { boot.drop().then(() => setGone(true)); return }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <AnimatePresence>
      {!gone && (
        <motion.div className="intro" initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.9, ease: [0.22, 0.9, 0.24, 1] } }}>
          <div className="intro__count" ref={count} aria-label="Loading">
            <span className="odo">
              {[0, 1, 2].map((i) => (
                <span className="odo__col" key={i}><span className="odo__strip">{Array.from({ length: 30 }, (_, k) => <span key={k}>{k % 10}</span>)}</span></span>
              ))}
            </span>
          </div>
          <div className="intro__meta">Shifat Masud — portfolio prototype.<br />Warming up the water.</div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
