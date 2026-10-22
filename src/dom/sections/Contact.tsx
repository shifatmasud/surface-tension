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
import { lineRoll, type LineRoll } from '../ui/maskedRoll'
import { bindInk } from '../../services/inkButton'
import { FOOT_MODE } from '../../gl/post/footerWorld'
import { loopPull } from '../../services/loopPull'
const RM = window.matchMedia('(prefers-reduced-motion: reduce)')
let footEl: HTMLElement | null = null

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
/** W19 (Shifat 19:49Z): the loop runway after the footer is fully in view (100vh / 120svh), read off the spacer's own height */
let spH = 0
let spObs: ResizeObserver | null = null
function runwayPx(vh: number, fh: number) {
  if (!spObs && typeof ResizeObserver !== 'undefined') {
    const el = document.querySelector('.footer-spacer') as HTMLElement | null
    if (el) { spH = el.offsetHeight; spObs = new ResizeObserver(() => { spH = el.offsetHeight }); spObs.observe(el) }
  }
  return spH > fh + 4 ? spH - fh - 4 : vh
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
  const btnRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => bindInk(btnRef.current, 'cta'), [])
  useSection(ref, (range) => {
    // same camera as the journey (one continuous scene); its own calm look: no bloom on the white type, no vignette
    const st = visuals.register('contact', () => journey.pose, {
      bg: new THREE.Color('#000000'), fogColor: new THREE.Color('#000000'), dive: 1,
      vignette: 0.0, bloom: 0.18, bloomThreshold: 0.97, contrast: 1.0, saturation: 1.04, exposure: 1.0, paintOffsetRatio: 0.6,
    })
    const canvasEl = document.getElementById('canvas')
    let lastK = -1, fired = false, lastExtra = -1
    const ctaEl = ref.current?.querySelector<HTMLElement>('.contact__cta') ?? null
    // TEXTROLL: the CTA label rolls up into its pill after the headline (scroll-driven, reversible)
    const btnEl = ref.current?.querySelector<HTMLElement>('.big-btn__label')
    let btnRoll: LineRoll | null = null
    return {
      name: 'contact',
      init() {
        // W18: the CTA type is drawn in GL on the wall (ctaScene.ts, the odometer); the DOM heading stays for AT
        if (settings.USE_GL) document.documentElement.classList.add('cta-gl')
        loopPull.init(() => props.scroll >= scroll.limit - 2)
        if (btnEl && settings.USE_GL) btnRoll = lineRoll(btnEl, { split: false, pad: 0.25 })
      },
      dispose() { btnRoll?.destroy(); btnRoll = null; journey.ctaOut = 0; footRoll(0) },
      update(dt = 0.016) {
        const vh = props.height
        const top = range.docTop - props.scroll
        // 0 when the wall's edge enters at the bottom → 1 when it reaches the top (then the CTA holds, pinned)
        journey.cta = clamp((vh - top) / vh)
        st.weight = journey.cta > 0 ? 0.2 + 1.2 * journey.cta : 0
        // W21 (scorer-r614 #1): through the footer's reveal and runway (lastK > 0) the CTA scene keeps drawing; past the
        // section's own range it had stopped, leaving the lifted curtain as an empty black slab until the wrap
        if (journey.cta > 0 && (range.isActive || lastK > 0)) journey.active = true
        props.resurface = clamp(range.progress)
        // sticky footer: once the section's bottom passes the bottom of the screen, the whole scene (canvas + DOM)
        // travels up with the scroll and uncovers the fixed footer beneath
        // W19 (Shifat 19:06Z footer at half height): the footer's own height, not a full viewport
        const fh = footerH(vh)
        const k0 = Math.max(0, vh - (top + range.height)), k = Math.round(Math.min(k0, fh + 2))
        // (W21 tried a soft mask on the curtain's lower edge: it read as a grey gradient band, against the no-gradient rule; the edge stays hard)
        // FOOTER MOCKUP: the canvas no longer slides; the curtain lifts inside the frame (gl/post/footerWorld.ts reads
        // journey.lift) and the footer's DOM (now over the canvas, transparent) is uncovered by the same edge (--k clip)
        if (k !== lastK && canvasEl) {
          lastK = k
          if (FOOT_MODE) { footEl ??= document.querySelector<HTMLElement>('.site-footer'); footEl?.style.setProperty('--k', `${k}px`) }
          else canvasEl.style.transform = k > 0 ? `translate3d(0, ${-k}px, 0)` : ''
        }

        journey.lift = k   // W21: how far the curtain has lifted (css px); read by nothing that moves the picture (see Scene.tsx)
        // W21 (scorer-r614: 'Say hi on X' crossed the crewmate's visor in the runway): the canvas stops lifting at the
        // footer's height, but the section's DOM kept scrolling, so the pill slid up over the held picture. It now holds
        // with the curtain: same place under the crewmate's feet as at the CTA hold, riding the curtain's edge
        const extra = Math.max(0, Math.round(k0 - k))
        if (ctaEl && extra !== lastExtra) { lastExtra = extra; ctaEl.style.transform = extra > 0 ? `translateX(-50%) translate3d(0, ${extra}px, 0)` : '' }
        // once the footer is fully uncovered, keep scrolling: the flat bar fills and floats you back to the surface
        // W19: the bar fills over the second half of the footer's reveal and wraps as it lands (no empty band above a half-height footer)
        // TEXTROLL: the CTA lines (GL, ctaScene) leave rolling up as the curtain lifts; the footer's lines
        // roll up into place as it is uncovered (both scroll-driven, so scrolling back reverses them)
        journey.ctaOut = clamp(k0 / (0.32 * fh))
        // (the pill stays on screen above the footer, so its label stays: it only rolls in, never leaves an empty button)
        btnRoll?.set(clamp((journey.cta - 0.62) / 0.34))
        footRoll(clamp((k0 - 0.08 * fh) / (0.62 * fh)))
        // W19 (Shifat 19:49Z): the footer is fully in view at k0 = fh; it then HOLDS for the runway while the bar fills, and wraps at the end
        // R6.80 (Shifat Oct 22 "scroll hard to loop to top", 04:55 "Rubber band is enough"; services/loopPull.ts): the
        // footer is the page's end. Scrolling on past it only stretches the bar and it springs back; a hard, sustained
        // push fills it and loops. Reduced motion (and the no-GL page) keep the runway.
        let f: number
        if (RM.matches || !settings.USE_GL) f = clamp((k0 - fh - 2) / Math.max(1, runwayPx(vh, fh) - 6))
        else {
          const sy = props.scroll, lim = scroll.limit
          f = loopPull.step(dt, sy >= lim - 2 && !(scroll as any).tween)
        }
        props.overscroll = f
        footerBar.el?.style.setProperty('--f', f.toFixed(3))
        if (FOOT_MODE) footerBar.el?.parentElement?.parentElement?.style.setProperty('--f', f.toFixed(3))   // FOOTER MOCKUP: the lime glow reads it
        if (f > 0.985 && !fired) { fired = true; audio.swell(false); scroll.wrapToTop(); loopPull.reset(); setTimeout(() => (fired = false), 900) }
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
                <a className="big-btn" ref={btnRef} href={SITE.email ? `mailto:${SITE.email}` : SITE.x} target={SITE.email ? undefined : '_blank'} rel="noreferrer" aria-label={SITE.email ? 'Write to me' : 'Say hi on X'} data-cursor onPointerEnter={(e) => { if (e.pointerType === 'mouse') audio.tick() }}
                  onFocus={() => {
                    // W28 (scorer-r657 #2 / r664 #2, W27's parked fix, same as Systems.tsx): a keyboard stop on the CTA brings the pill on
                    // screen first; the section is pinned and the pill only sits in place at the end of its pin, so the browser's own focus
                    // scroll left it below the fold
                    // (W28: the browser's own focus scroll lands AFTER this handler and the virtual engine adopts it as a glide, so the
                    // jump is re-applied on the next two frames, after the engine has read that scroll)
                    const sec = ref.current, b = btnRef.current; if (!sec || !b) return
                    const go = () => {
                      const r = b.getBoundingClientRect()
                      if (r.top < 0 || r.bottom > window.innerHeight) scroll.scrollTo(sec, { offset: Math.max(0, sec.offsetHeight - window.innerHeight), immediate: true })
                    }
                    go(); requestAnimationFrame(() => { go(); requestAnimationFrame(go) })
                  }}>
                  {/* BUTTON v2 (mockup): the label and the arrow each carry two copies for the masked roll; .ink is the
                      inverse-coloured copy the flood reveals (services/inkButton.ts) */}
                  <span className="big-btn__label ink-par"><span className="ir"><span className="ir-a">{SITE.email ? 'Write to me' : 'Say hi on X'}</span><span className="ir-b" aria-hidden="true">{SITE.email ? 'Write to me' : 'Say hi on X'}</span></span></span> <i className="ink-par"><span className="ia-a"><ArrowUpRight size={20} weight="bold" /></span><span className="ia-b" aria-hidden="true"><ArrowUpRight size={20} weight="bold" /></span></i>
                  <span className="ink" aria-hidden="true"><span className="big-btn__label ink-par"><span className="ir"><span className="ir-a">{SITE.email ? 'Write to me' : 'Say hi on X'}</span><span className="ir-b">{SITE.email ? 'Write to me' : 'Say hi on X'}</span></span></span><i className="ink-par"><span className="ia-a"><ArrowUpRight size={20} weight="bold" /></span><span className="ia-b"><ArrowUpRight size={20} weight="bold" /></span></i></span>
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
/** TEXTROLL: the footer's text blocks, each rolled per line (lineRoll), staggered left to right / top to bottom */
const footRolls: LineRoll[] = []
let footP = -1
function footRoll(p: number) {
  if (p === footP) return
  footP = p
  const n = footRolls.length
  footRolls.forEach((r, i) => r.set(Math.min(1, Math.max(0, p * (1 + 0.1 * (n - 1)) - i * 0.1))))
}
/** The fixed footer the CTA uncovers (flat, minimal), with the flat back-to-the-surface bar. Portalled to <body> so it
 * sits under the canvas in the root stacking order (the CTA slides up over it like a curtain). */
export function Footer() {
  useEffect(() => {
    if (!settings.USE_GL) return
    const root = document.querySelector<HTMLElement>('.site-footer'); if (!root) return
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-roll]'))) footRolls.push(lineRoll(el, { split: el.dataset.roll !== 'whole', pad: 0.22 }))
    const p = footP; footP = -1; footRoll(Math.max(0, p))
    return () => { footRolls.splice(0).forEach((r) => r.destroy()); footP = -1 }
  }, [])
  return createPortal(
    <footer className={FOOT_MODE ? `site-footer site-footer--world site-footer--w${FOOT_MODE}` : 'site-footer'} aria-label="Footer"
      onFocus={() => {
        // W28 (scorer-r664 #1): a keyboard stop inside the footer while the curtain still covers it (GitHub, X, Back to the
        // surface took focus behind the clip, no ring on screen) jumps to where the footer is fully uncovered and the bar is
        // still empty (k0 = fh + 2, f = 0: no wrap), the same jump-cut Systems.tsx uses for its drum controls
        if (!settings.USE_GL || !FOOT_MODE) return
        const sec = document.getElementById('contact'), vh = props.height || window.innerHeight
        const fh = footerH(vh)
        if (!sec || (journey.lift || 0) >= fh) return
        const y = window.scrollY + sec.getBoundingClientRect().bottom - vh + fh + 2
        scroll.scrollTo(y, { immediate: true })
      }}>
      <div className="site-footer__top">
        <p className="site-footer__name" data-roll="marked"><span data-roll-line=""><span className="site-footer__lockup" role="img" aria-label={SITE.name}><span className="site-footer__mark" aria-hidden="true"><Logo size="100%" /></span><span aria-hidden="true">Shifat</span></span></span><span data-roll-line=""><span>{SITE.role}.</span></span></p>
        <nav className="site-footer__links" aria-label="Elsewhere" data-roll="marked">
          <a href={SITE.github} target="_blank" rel="noreferrer" aria-label="GitHub" data-cursor data-roll-line="inline"><GithubLogo size={16} /> GitHub</a>
          <a href={SITE.x} target="_blank" rel="noreferrer" aria-label="X / Twitter" data-cursor data-roll-line="inline"><XLogo size={16} /> X / Twitter</a>
        </nav>
      </div>
      <div className="overscroll__bar" aria-hidden="true"><p className="overscroll__label" data-roll="split">{noOrphan('Keep scrolling — back to the surface')}</p><div className="overscroll__track"><div className="overscroll__fill" ref={(e) => { footerBar.el = e }} /></div></div>
      <div className="site-footer__bottom" data-roll="marked">
        <span data-roll-line="inline">© <Odometer value={new Date().getFullYear()} digits={4} /> {SITE.name}. Surface Tension.</span>
        {/* POLISH (one CTA button): a plain text link, not a button */}
        <a className="site-footer__top-link" href="#hero" aria-label="Back to the surface" data-cursor data-roll-line="inline" onClick={(e) => { e.preventDefault(); audio.swell(false); scroll.scrollTo(0, { duration: 3.2 }) }}>Back to the surface <ArrowUp size={14} weight="bold" /></a>
      </div>
    </footer>, document.body)
}
