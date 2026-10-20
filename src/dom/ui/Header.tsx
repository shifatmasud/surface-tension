import { Odometer } from './Odometer'
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { SpeakerSimpleHigh, SpeakerSimpleSlash, ArrowUpRight, X as XIcon, List } from '@phosphor-icons/react'
import { audio } from '../../services/audio'
import { scroll } from '../../services/scroll'
import { SITE } from '../../content/site'
import { Logo } from '../../assets/logo/Logo'

const LINKS = [
  { id: 'hero', label: 'Surface' }, { id: 'statement', label: 'Statement' }, { id: 'dive', label: 'Dive' }, { id: 'lab', label: 'Work' },
  { id: 'systems', label: 'Shade DS' }, { id: 'journey', label: 'Journey' }, { id: 'contact', label: 'Say hi' },
]

function Wave({ on }: { on: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current!; const ctx = c.getContext('2d')!
    const dpr = Math.min(devicePixelRatio, 2); c.width = 22 * dpr; c.height = 14 * dpr; ctx.scale(dpr, dpr)
    let raf = 0, amp = 0, n = 0, color = getComputedStyle(c).color
    const data = new Uint8Array(32)
    const draw = (t: number) => {
      amp += ((on ? 1 : 0.12) - amp) * 0.08
      ctx.clearRect(0, 0, 22, 14)
      if (audio.analyser && on) audio.analyser.getByteFrequencyData(data)
      // PERF HOOK: getComputedStyle forced a style recalculation every frame; the colour is re-read every 8th frame
      if ((++n & 7) === 0) color = getComputedStyle(c).color
      ctx.lineWidth = 1.4; ctx.lineCap = 'round'; ctx.strokeStyle = color
      ctx.beginPath()
      for (let x = 0; x <= 22; x += 1) {
        const band = data[(x % 16) + 2] / 255
        const y = 7 + Math.sin(x * 0.7 + t * 0.006) * (2 + band * 4) * amp
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [on])
  return <canvas ref={ref} className="wave" aria-hidden />
}

export function Header() {
  const [open, setOpen] = useState(false)
  const [sound, setSound] = useState(false)
  useEffect(() => audio.onChange(setSound), [])
  useEffect(() => { if (open) scroll.stop(); else scroll.start() }, [open])
  const go = (id: string) => { setOpen(false); setTimeout(() => scroll.scrollTo('#' + id, { duration: 2 }), 60); audio.swell(true) }
  return (
    <>
      <header className="header">
        <a className="wordmark" href="#hero" onClick={(e) => { e.preventDefault(); go('hero') }} aria-label="Shifat Masud — home" data-cursor><span className="wordmark__mark" aria-hidden="true"><Logo size="100%" /></span><span aria-hidden="true">Shifat</span></a>
        <nav className="pills" aria-label="Primary">
          <button className="pill" onClick={() => audio.toggle()} aria-pressed={sound} aria-label={sound ? 'Mute sound' : 'Turn sound on'} data-cursor onMouseEnter={() => audio.tick()}>
            {sound ? <SpeakerSimpleHigh size={16} weight="bold" /> : <SpeakerSimpleSlash size={16} weight="bold" />}
            <Wave on={sound} />
          </button>
          <button className="pill" onClick={() => go('contact')} data-cursor onMouseEnter={() => audio.tick()}>
            <span className="roll"><span>Say hi</span><span>Say hi</span></span>
          </button>
        </nav>
      </header>
      <AnimatePresence>
        {open && (
          <>
            <motion.div className="menu-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} />
            <motion.aside id="menu" className="menu" initial={{ x: '108%' }} animate={{ x: 0 }} exit={{ x: '108%' }} transition={{ type: 'spring', stiffness: 120, damping: 20, mass: 0.9 }}>
              <ol>
                {LINKS.map((l, i) => (
                  <li key={l.id}>
                    <motion.a href={'#' + l.id} onClick={(e) => { e.preventDefault(); go(l.id) }} initial={{ y: '110%' }} animate={{ y: 0 }} exit={{ y: '110%' }} transition={{ delay: 0.08 + i * 0.045, duration: 0.7, ease: [0.22, 0.9, 0.24, 1] }} onMouseEnter={() => audio.tick()}>
                      <small><Odometer value={i + 1} digits={2} delay={0.1 + i * 0.05} /></small>{l.label}
                    </motion.a>
                  </li>
                ))}
              </ol>
              <footer><span>{SITE.city}</span><a href={SITE.github} target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={12} /></a></footer>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
