import { Odometer } from '../ui/Odometer'
import * as THREE from 'three'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSection } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { SITE } from '../../content/site'
import { ArrowUpRight, GithubLogo, XLogo, ArrowUp } from '@phosphor-icons/react'
import { scroll } from '../../services/scroll'
import { audio } from '../../services/audio'
import { settings } from '../../services/settings'
import { journey } from '../../gl/stages/journey/journeyState'
import './contact.css'
import { Logo } from '../../assets/logo/Logo'
import { ProjectLinks } from '../a11y/ProjectLinks'
import { noOrphan } from '../a11y/noOrphans'

/** W19: the fixed footer's height (50vh / 50svh since 19:06Z), cached by a ResizeObserver so the frame loop reads no layout */
let footH = 0
let footObs: ResizeObserver | null = null
function footerH(vh: number) {
  if (!footObs && typeof ResizeObserver !== 'undefined') {
    const el = document.querySelector('.site-footer') as HTMLElement | null
    if (el) { footH = el.offsetHeight; footObs = new ResizeObserver(() => { footH = el.offsetHeight }); footObs.observe(el) }
  }
  return footH > 0 ? footH : vh
}


function DhakaClock() {
  const [t, setT] = useState([0, 0, 0])
  useEffect(() => {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: SITE.tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    const tick = () => setT(f.format(new Date()).split(':').map(Number))
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id)
  }, [])
  // every second the reels roll one step (odometer); minutes and hours carry when they turn over
  return <span className="clock"><Odometer value={t[0]} digits={2} />:<Odometer value={t[1]} digits={2} />:<Odometer value={t[2]} digits={2} duration={0.7} /> GMT+6</span>
}

/**
 * S7 — the CTA (STRUCTURE v2, Shifat 08:32Z). The crewmate that broke out of the tablet lands in front of a plain black
 * wall with the huge flat white headline (drawn in GL behind the figure, from these DOM line boxes), a few stickers on
 * the wall you can drag and peel, and the flat CTA. Past the end, the whole scene slides up like a curtain and uncovers
 * the fixed footer underneath.
 */
export function Contact() {
  const ref = useRef<HTMLElement>(null)
  const l1 = useRef<HTMLSpanElement>(null), l2 = useRef<HTMLSpanElement>(null)
  useSection(ref, (range) => {
    // same camera as the journey (one continuous scene); its own calm look: no bloom on the white type, no vignette
    const st = visuals.register('contact', () => journey.pose, {
      bg: new THREE.Color('#000000'), fogColor: new THREE.Color('#000000'), dive: 1,
      vignette: 0.0, bloom: 0.18, bloomThreshold: 0.97, contrast: 1.0, saturation: 1.04, exposure: 1.0, paintOffsetRatio: 0.6,
    })
    const canvasEl = document.getElementById('canvas')
    let lastK = -1, fired = false
    return {
      name: 'contact',
      init() {
        // W18: the CTA type is drawn in GL on the wall (ctaScene.ts, the odometer); the DOM heading stays for AT
        if (settings.USE_GL) document.documentElement.classList.add('cta-gl')
      },
      update() {
        const vh = props.height
        const top = range.docTop - props.scroll
        // 0 when the wall's edge enters at the bottom → 1 when it reaches the top (then the CTA holds, pinned)
        journey.cta = clamp((vh - top) / vh)
        st.weight = journey.cta > 0 ? 0.2 + 1.2 * journey.cta : 0
        if (journey.cta > 0 && range.isActive) journey.active = true
        props.resurface = clamp(range.progress)
        // sticky footer: once the section's bottom passes the bottom of the screen, the whole scene (canvas + DOM)
        // travels up with the scroll and uncovers the fixed footer beneath
        // W19 (Shifat 19:06Z footer at half height): the footer's own height, not a full viewport
        const fh = footerH(vh)
        const k0 = Math.max(0, vh - (top + range.height)), k = Math.round(Math.min(k0, fh + 2))
        if (k !== lastK && canvasEl) { lastK = k; canvasEl.style.transform = k > 0 ? `translate3d(0, ${-k}px, 0)` : '' }
        // once the footer is fully uncovered, keep scrolling: the flat bar fills and floats you back to the surface
        // W19: the bar fills over the second half of the footer's reveal and wraps as it lands (no empty band above a half-height footer)
        const f = clamp((k0 - 0.45 * fh) / (0.5 * fh))
        props.overscroll = f
        footerBar.el?.style.setProperty('--f', f.toFixed(3))
        if (f > 0.985 && !fired) { fired = true; audio.swell(false); scroll.wrapToTop(); setTimeout(() => (fired = false), 900) }
      },
    }
  })
  return (
    <>
      <section id="contact" className="section contact" ref={ref} aria-labelledby="contact-title">
        <div className="sticky contact__inner">
          <div className="contact__grid">
            <h2 className="contact__title" id="contact-title"><span className="contact__line" ref={l1}>Let’s make</span><span className="contact__line" ref={l2}>it ripple.</span></h2>
            <div className="contact__row">
              <div className="contact__cta">
                <a className="big-btn" href={SITE.email ? `mailto:${SITE.email}` : SITE.x} target={SITE.email ? undefined : '_blank'} rel="noreferrer" data-cursor onMouseEnter={() => audio.tick()}>
                  {SITE.email ? 'Write to me' : 'Say hi on X'} <i><ArrowUpRight size={20} weight="bold" /></i>
                </a>
                {/* POLISH (Shifat 18:19Z/18:20Z "only one clean CTA button"): the message form and its send pill are gone */}
                <ProjectLinks />
              </div>
            </div>
          </div>
        </div>
      </section>
      <div className="footer-spacer" aria-hidden="true" />
    </>
  )
}

const footerBar = { el: null as HTMLDivElement | null }
/** The fixed footer the CTA uncovers (flat, minimal), with the flat back-to-the-surface bar. Portalled to <body> so it
 * sits under the canvas in the root stacking order (the CTA slides up over it like a curtain). */
export function Footer() {
  return createPortal(
    <footer className="site-footer" aria-label="Footer">
      <div className="site-footer__top">
        <p className="site-footer__name"><span className="site-footer__lockup" role="img" aria-label={SITE.name}><span className="site-footer__mark" aria-hidden="true"><Logo size="100%" /></span><span aria-hidden="true">Shifat</span></span><br /><span>{SITE.role}, {SITE.city}.</span></p>
        <nav className="site-footer__links" aria-label="Elsewhere">
          <a href={SITE.github} target="_blank" rel="noreferrer" data-cursor><GithubLogo size={16} /> GitHub</a>
          <a href={SITE.x} target="_blank" rel="noreferrer" data-cursor><XLogo size={16} /> X / Twitter</a>
        </nav>
        <div className="site-footer__time"><span>Local time, {SITE.city}</span><DhakaClock /></div>
      </div>
      <div className="overscroll__bar" aria-hidden="true"><p className="overscroll__label">{noOrphan('Keep scrolling — back to the surface')}</p><div className="overscroll__track"><div className="overscroll__fill" ref={(e) => { footerBar.el = e }} /></div></div>
      <div className="site-footer__bottom">
        <span>© <Odometer value={new Date().getFullYear()} digits={4} /> {SITE.name}. Surface Tension, portfolio prototype.</span>
        {/* POLISH (one CTA button): a plain text link, not a button */}
        <a className="site-footer__top-link" href="#hero" data-cursor onClick={(e) => { e.preventDefault(); audio.swell(false); scroll.scrollTo(0, { duration: 3.2 }) }}>Back to the surface <ArrowUp size={14} weight="bold" /></a>
      </div>
    </footer>, document.body)
}
