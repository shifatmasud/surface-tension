import { Odometer } from './Odometer'
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { SpeakerSimpleHigh, SpeakerSimpleSlash, ArrowUpRight, X as XIcon, List } from '@phosphor-icons/react'
import { audio } from '../../services/audio'
import { scroll } from '../../services/scroll'
import { SITE } from '../../content/site'
import { Logo } from '../../assets/logo/Logo'
import { HOUSE } from '../../core/house'

const LINKS = [
  // SECTION CUT (Shifat 15:41Z): Statement removed; Work is the dive's project slides (DOM id stays 'lab' for the card morph)
  { id: 'hero', label: 'Surface' }, { id: 'dive', label: 'Dive' }, { id: 'lab', label: 'Work' },
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

/** A11Y: everything focusable inside an element, in tab order */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Header() {
  const [open, setOpen] = useState(false)
  const [sound, setSound] = useState(false)
  const menuBtn = useRef<HTMLButtonElement>(null)
  const menuEl = useRef<HTMLElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)   // A11Y: where focus goes when the menu closes (the button, or the chosen section)
  const wasOpen = useRef(false)
  useEffect(() => audio.onChange(setSound), [])
  useEffect(() => { if (open) scroll.stop(); else scroll.start() }, [open])
  // A11Y (menu button): focus moves into the menu on open, Tab/Shift+Tab stay inside (menu button + links), Esc closes,
  // and focus returns to the button (or lands on the section a link chose) on close
  useEffect(() => {
    if (!open) {
      if (wasOpen.current) { wasOpen.current = false; const t = returnTo.current ?? menuBtn.current; returnTo.current = null; if (t !== document.body) t?.focus({ preventScroll: true }) }
      return
    }
    wasOpen.current = true
    const raf = requestAnimationFrame(() => menuEl.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true }))
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return }
      if (e.key !== 'Tab') return
      const ring = [menuBtn.current, ...Array.from(menuEl.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(Boolean) as HTMLElement[]
      if (!ring.length) return
      const i = ring.indexOf(document.activeElement as HTMLElement)
      e.preventDefault()
      ring[(i < 0 ? 0 : i + (e.shiftKey ? ring.length - 1 : 1)) % ring.length].focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onKey, true)
    return () => { cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  const go = (id: string) => { setOpen(false); setTimeout(() => scroll.scrollTo('#' + id, { duration: 2 }), 60); audio.swell(true) }
  /** A11Y (menu links): the same path as any same-page anchor and the skip link (scroll.ts toHash): the virtual scroll
   *  eases to the section and the section takes focus, so keyboard and screen-reader users land where the eye goes.
   *  The menu closes first (it holds the scroll), then the hash moves. */
  const goMenu = (id: string) => {
    returnTo.current = document.body   // the section takes focus, not the menu button
    setOpen(false); audio.swell(true)
    setTimeout(() => {
      if (location.hash !== '#' + id) history.pushState(null, '', '#' + id)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }, 60)
  }
  return (
    <>
      <header className="header">
        <a className="wordmark" href="#hero" onClick={(e) => { e.preventDefault(); go('hero') }} aria-label="Shifat Masud — home" data-cursor><span className="wordmark__mark" aria-hidden="true"><Logo size="100%" /></span><span aria-hidden="true">Shifat</span></a>
        <nav className="pills" aria-label="Primary">
          <button className="pill pill--quiet" onClick={() => audio.toggle()} aria-pressed={sound} aria-label={sound ? 'Mute sound' : 'Turn sound on'} data-cursor onMouseEnter={() => audio.tick()}>
            {sound ? <SpeakerSimpleHigh size={16} weight="bold" /> : <SpeakerSimpleSlash size={16} weight="bold" />}
            <Wave on={sound} />
          </button>
          {/* Shifat 18:19Z: ONE CTA on the whole page (the CTA section's); the header's "Say hi" pill is gone, "Say hi" stays in the menu */}
          {/* A11Y (cut review: no way to open the 6-link menu): the B/W menu pill; it stays above the open panel as its close */}
          <button ref={menuBtn} type="button" className="pill pill--quiet pill--menu" aria-expanded={open} aria-controls="menu" aria-label="Menu"
            onClick={() => setOpen((o) => !o)} data-cursor onMouseEnter={() => audio.tick()}>
            {open ? <XIcon size={16} weight="bold" aria-hidden="true" /> : <List size={16} weight="bold" aria-hidden="true" />}
            <span className="pill__txt" aria-hidden="true">{open ? 'Close' : 'Menu'}</span>
          </button>
        </nav>
      </header>
      <AnimatePresence>
        {open && (
          <>
            <motion.div className="menu-scrim" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} />
            <motion.nav ref={menuEl} id="menu" className="menu" aria-label="Sections" initial={{ x: '108%' }} animate={{ x: 0 }} exit={{ x: '108%' }} transition={{ type: 'spring', stiffness: 120, damping: 20, mass: 0.9 }}>
              <ol>
                {LINKS.map((l, i) => (
                  <li key={l.id}>
                    <motion.a href={'#' + l.id} onClick={(e) => { e.preventDefault(); goMenu(l.id) }} initial={{ y: '110%' }} animate={{ y: 0 }} exit={{ y: '110%' }} transition={{ delay: 0.08 + i * 0.045, duration: 0.7, ease: HOUSE.IN }} onMouseEnter={() => audio.tick()}>
                      <small aria-hidden="true"><Odometer value={i + 1} digits={2} delay={0.1 + i * 0.05} /></small>{l.label}
                    </motion.a>
                  </li>
                ))}
              </ol>
              <footer><span>{SITE.city}</span><a href={SITE.github} target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={12} aria-hidden="true" /></a></footer>
            </motion.nav>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
