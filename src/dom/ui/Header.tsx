import { useEffect, useRef, useState } from 'react'
import { audio } from '../../services/audio'
import { scroll } from '../../services/scroll'
import { Logo } from '../../assets/logo/Logo'

/**
 * W19 (Shifat 20:33Z m:2349f78f "No need menu button in nav"): the Menu button and its overlay are gone. It is one page
 * with one CTA. The nav is the wordmark (left) and the sound toggle.
 * W19 (Shifat 20:34Z m:89379c2e "Volume button doesn't need volume icon just animate simple single wave line"): the
 * toggle is ONE thin stroke. On, a gentle sine drifts; off, it eases to flat (reversible, no jump). Under reduced motion
 * it is static (a still wave when on, flat when off).
 */
function Wave({ on }: { on: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const onRef = useRef(on)
  onRef.current = on
  useEffect(() => {
    const c = ref.current!; const ctx = c.getContext('2d')!
    const W = 22, H = 14
    const dpr = Math.min(devicePixelRatio, 2); c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr)
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0, amp = onRef.current ? 1 : 0, phase = 0, n = 0, last = performance.now(), color = getComputedStyle(c).color, toneUntil = 0
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now
      const target = onRef.current ? 1 : 0
      amp = reduced ? target : amp + (target - amp) * (1 - Math.exp(-6 * dt))
      if (!reduced) phase += dt * 3.2
      if ((++n & 7) === 0 || now < toneUntil) color = getComputedStyle(c).color
      ctx.clearRect(0, 0, W, H)
      ctx.lineWidth = 1.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = color
      ctx.beginPath()
      for (let x = 1; x <= W - 1; x += 0.5) {
        const env = Math.sin(Math.PI * (x - 1) / (W - 2))           // the ends rest on the centre line
        const y = H / 2 + Math.sin(x * 0.62 - phase) * 3 * amp * env
        x === 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
      // settled and still: stop drawing until the state changes
      if ((reduced || (target === 0 && amp < 0.002)) && now >= toneUntil) { raf = 0; return }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    // W20 (scorer-r610 #3: the icon stayed dark on every dark section): a settled, silent wave stops drawing, so it kept
    // the colour it had when it stopped. Redraw once whenever the UI tone (html[data-bg]) flips.
    // W21: a slow device (or a cold jump, a few frames a second) can sample the colour mid-transition and then stop on
    // that in-between grey. One more redraw is pinned to the end of the .5 s transition, whatever the frame rate.
    const kick = (ms: number) => { toneUntil = Math.max(toneUntil, performance.now() + ms); if (!raf) { last = performance.now(); raf = requestAnimationFrame(draw) } }
    let tt = 0
    const mo = new MutationObserver(() => { kick(700); clearTimeout(tt); tt = window.setTimeout(() => kick(120), 620) }) // follows the .5 s colour transition
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bg', 'data-hdr'] })   // W24: the header's own measured tone too
    return () => { if (raf) cancelAnimationFrame(raf); clearTimeout(tt); mo.disconnect() }
  }, [on])
  return <canvas ref={ref} className="wave" aria-hidden />
}

export function Header() {
  const [sound, setSound] = useState(false)
  useEffect(() => audio.onChange(setSound), [])
  // W21: the no-GL page has no GL frame to set the UI tone (html[data-bg]), so its header (and the text slot) stayed
  // black on the dark sections. There the tone follows the section under the header: an opaque dark background or an
  // image/gradient section (the dive, the journey, the CTA) reads dark.
  useEffect(() => {
    const html = document.documentElement
    if (!html.classList.contains('no-gl')) return
    let raf = 0
    const tone = (y: number) => {
      let el = document.elementFromPoint(innerWidth / 2, y) as HTMLElement | null
      while (el && el !== document.body) {
        const cs = getComputedStyle(el)
        if (cs.backgroundImage !== 'none') return 'dark'
        const m = cs.backgroundColor.match(/[\d.]+/g)
        if (m && (m.length < 4 || +m[3] > 0.5)) return (0.2126 * +m[0] + 0.7152 * +m[1] + 0.0722 * +m[2]) < 128 ? 'dark' : 'light'
        el = el.parentElement
      }
      return 'light'
    }
    const run = () => { raf = 0; const t = tone(Math.max(8, Math.min(60, innerHeight * 0.05))); if (html.dataset.bg !== t) html.dataset.bg = t }
    const on = () => { if (!raf) raf = requestAnimationFrame(run) }
    run(); addEventListener('scroll', on, { passive: true }); addEventListener('resize', on)
    const iv = window.setInterval(on, 400)   // the virtual scroller moves the page without native scroll events
    return () => { removeEventListener('scroll', on); removeEventListener('resize', on); clearInterval(iv); if (raf) cancelAnimationFrame(raf) }
  }, [])
  const go = (id: string) => { scroll.scrollTo('#' + id, { duration: 2 }); audio.swell(true) }
  return (
    <header className="header">
      <a className="wordmark" href="#hero" onClick={(e) => { e.preventDefault(); go('hero') }} aria-label="Shifat Masud — home" data-cursor><span className="wordmark__mark" aria-hidden="true"><Logo size="100%" /></span><span aria-hidden="true">Shifat</span></a>
      <nav className="pills" aria-label="Primary">
        <button type="button" className="pill pill--quiet pill--sound" onClick={() => audio.toggle()} aria-pressed={sound} aria-label={sound ? 'Sound on' : 'Sound off'} data-cursor onMouseEnter={() => audio.tick()}>
          <Wave on={sound} />
        </button>
      </nav>
    </header>
  )
}
