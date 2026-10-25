import { Odometer } from '../ui/Odometer'
import * as THREE from 'three'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSection } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { SITE } from '../../content/site'
import { ArrowUpRight, GithubLogo, XLogo } from '@phosphor-icons/react'
import { scroll } from '../../services/scroll'
import { audio } from '../../services/audio'
import { settings } from '../../services/settings'
import { journey } from '../../gl/stages/journey/journeyState'
import './contact.css'
import { Logo } from '../../assets/logo/Logo'
import { mountGiftSticker } from '../gift/giftSticker' // R6.89: the gift opens from a sticker at the end of the scroll (no more logo double-click)
import { ProjectLinks } from '../a11y/ProjectLinks'
import { noOrphan } from '../a11y/noOrphans'
import { lineRoll, type LineRoll } from '../ui/maskedRoll'
import { bindInk } from '../../services/inkButton'
import { FOOT_MODE } from '../../gl/post/footerWorld'
import { loopPull } from '../../services/loopPull'
import { viewport } from '../../core/viewport'
import { scrollHost } from '../../services/scrollHost'
const RM = window.matchMedia('(prefers-reduced-motion: reduce)')
let footEl: HTMLElement | null = null

/** W19: the fixed footer's height (50vh / 50svh since 19:06Z), cached by a ResizeObserver so the frame loop reads no layout */
let footH = 0
// R7.07 #9: the CTA pill is fixed to the screen and placed per frame (?pillold = 7.06, carried by the sticky frame)
const PILL_FIXED = settings.USE_GL && typeof location !== 'undefined' && !/[?&]pillold\b/.test(location.search)
if (PILL_FIXED && typeof document !== 'undefined') document.documentElement.classList.add('pill-fixed')
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
    let pillVhG = -1
    let lastK = -1, fired = false, lastExtra = -1, pillVh = -1, pillGap = -1, pillH = 0, pillCur = 0
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
        // R6.89 (Shifat 5:25 AM): the button's label no longer rolls in; it is simply there (its hover roll stays)
        void btnEl
      },
      dispose() { btnRoll?.destroy(); btnRoll = null; journey.ctaOut = 0; footRoll(0) },
      update(dt = 0.016) {
        const vh = viewport.vis // R7.07: the footer / curtain / pill are anchored to the VISIBLE bottom (address bar shown or not)
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
        journey.footH = fh   // R6.89: the CTA heroes settle above it (JourneyStage)
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
        // R6.89 (Shifat 5:25 AM "reveal footer"; "The CTA button has no in or out animation"): the button is part of the page:
        // its DOM scrolls up 1:1 with the curtain's edge as the footer is uncovered, then holds with it; never fading or rolling
        // As the footer is uncovered it eases down a little toward the curtain's edge (to ~50 px above it, clear of the water line's slosh), so the crewmate and
        // the type keep room above it (a scroll-tied glide, no fade, no scale)
        let pillDown = 0
        if (ctaEl && k > 0 && settings.USE_GL) {
          if (vh !== pillVh || pillGap < 0) { const r = ctaEl.getBoundingClientRect(); pillVh = vh; pillGap = PILL_FIXED ? vh - (r.bottom - lastExtra) : (vh - k) - (r.bottom - pillCur); pillH = r.height }
          // R6.92b option B: the pill keeps its R6.89 translate-only glide toward the edge (the heroes settle above it)
          pillDown = Math.round((k / Math.max(1, fh)) * Math.max(0, pillGap - 18))   // R6.92b B: settles 18 px above the edge (was 50): full-size heroes need the room
          // the room it takes above the curtain's edge, for the crewmate and the type settling above it (JourneyStage)
          journey.pillRes = pillGap - pillDown + pillH + 18
        } else if (k <= 0) pillGap = -1
        pillCur = pillDown
        // R7.07 #9 (Shifat: on a hard fling the CTA block slid over the big headline): the pill was carried by the browser's
        // own scroll (the sticky frame) while the headline and crewmate move with the WebGL frame, which lands a frame or more
        // later on a fast fling. The pill is now fixed to the screen and placed by this same frame from the same scroll
        // value the GL used (where the sticky frame would put it, plus the curtain glide), so the two can no longer part.
        const pillY = PILL_FIXED ? Math.round(Math.min(vh + 40, Math.max(0, top)) - k + pillDown) : extra + pillDown
        // R7.08: the pill's top with no translate (measured once per viewport height, before this frame's write), for the stage's guard
        if (ctaEl && PILL_FIXED && lastExtra !== -1 && (journey.pill.restTop < 0 || vh !== pillVhG)) { pillVhG = vh; journey.pill.restTop = ctaEl.getBoundingClientRect().top - (lastExtra + journey.pill.push) }
        if (ctaEl && pillY !== lastExtra) { lastExtra = pillY; journey.pill.push = 0; ctaEl.style.transform = pillY !== 0 || PILL_FIXED ? `translateX(-50%) translate3d(0, ${pillY}px, 0)` : '' }
        journey.pill.el = PILL_FIXED ? ctaEl : null; journey.pill.y = pillY; journey.pill.k = k

        // once the footer is fully uncovered, keep scrolling: the flat bar fills and floats you back to the surface
        // W19: the bar fills over the second half of the footer's reveal and wraps as it lands (no empty band above a half-height footer)
        // TEXTROLL: the CTA lines (GL, ctaScene) leave rolling up as the curtain lifts; the footer's lines
        // roll up into place as it is uncovered (both scroll-driven, so scrolling back reverses them)
        // R6.89 (Shifat Oct 23 3:43 AM "When reaching footer the [crewmate] model & [big CTA] text must not animate mask out"):
        // the CTA lines no longer roll out; ctaOut stays 0 (ctaScene keeps reading it, so the old behaviour is one line back)
        journey.ctaOut = 0
        // (the pill stays on screen above the footer, so its label stays: it only rolls in, never leaves an empty button)
        // R6.92b (Shifat 9:06 AM: the footer's logo/text were not seen in the reveal): its lines roll in earlier, readable by
        // ~60 % of the reveal and all in by ~85 % (was: starting at 8 %, done at 70 % + the stagger, ~100 %)
        footRoll(clamp((k0 - 0.03 * fh) / (0.45 * fh)))
        // R6.89 GIFT STICKER: the surprise at the very end of the scroll (the footer fully uncovered); it gathers once each
        // time you arrive, and is put away again when you scroll back up off the end
        if (giftBtn.ctl) { const end = k0 >= fh - 2; if (end) giftBtn.ctl.set(true); else if (k0 < fh * 0.85) giftBtn.ctl.set(false) }
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
        // R6.81 (Shifat Oct 22 05:12 "When fill is 80% auto fill to 100% and loop back to top & stop scroll a bit moment",
        // option B): past 80 % loopPull fills itself to 100 % and the loop then holds the page at the top for 0.8 s
        const rubber = !(RM.matches || !settings.USE_GL)
        if ((rubber ? f >= 1 : f > 0.985) && !fired) { fired = true; audio.swell(false); scroll.wrapToTop(rubber ? 800 : 0); loopPull.reset(); setTimeout(() => (fired = false), 900) }
      },
    }
  })
  return (
    <>
      <section id="contact" className="section contact" ref={ref} aria-labelledby="contact-title">
        <div className="sticky contact__inner">
          <div className="contact__grid">
            <h2 className="contact__title" id="contact-title"><span className="contact__line" ref={l1}>Let’s make</span><span className="contact__line" ref={l2}>it ripple</span></h2>
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
/** R6.89: the gift sticker's button and its controller (dom/gift/giftSticker.ts) */
const giftBtn = { el: null as HTMLElement | null, ctl: null as ReturnType<typeof mountGiftSticker> | null }
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
    if (giftBtn.el) giftBtn.ctl = mountGiftSticker(giftBtn.el as HTMLButtonElement)
    return () => { footRolls.splice(0).forEach((r) => r.destroy()); footP = -1; giftBtn.ctl?.destroy(); giftBtn.ctl = null }
  }, [])
  return createPortal(
    <footer className={FOOT_MODE ? `site-footer site-footer--world site-footer--w${FOOT_MODE}` : 'site-footer'} aria-label="Footer"
      onFocus={() => {
        // W28 (scorer-r664 #1): a keyboard stop inside the footer while the curtain still covers it (GitHub, X; R6.81: the
        // Back to the surface link is gone) took focus behind the clip, no ring on screen) jumps to where the footer is fully uncovered and the bar is
        // still empty (k0 = fh + 2, f = 0: no wrap), the same jump-cut Systems.tsx uses for its drum controls
        if (!settings.USE_GL || !FOOT_MODE) return
        const sec = document.getElementById('contact'), vh = viewport.vis || props.height
        const fh = footerH(vh)
        if (!sec || (journey.lift || 0) >= fh) return
        const y = scrollHost.y() + sec.getBoundingClientRect().bottom - vh + fh + 2
        scroll.scrollTo(y, { immediate: true })
      }}>
      <div className="site-footer__top">
        <p className="site-footer__name" data-roll="marked"><span data-roll-line=""><span className="site-footer__lockup"><span className="site-footer__mark" aria-hidden="true"><Logo size="100%" /></span><span aria-hidden="true">Shifat</span></span></span><span data-roll-line=""><span>{SITE.role}.</span></span></p>
        <nav className="site-footer__links" aria-label="Elsewhere" data-roll="marked">
          <a href={SITE.github} target="_blank" rel="noreferrer" aria-label="GitHub" data-cursor data-roll-line="inline"><GithubLogo size={16} /> GitHub</a>
          <a href={SITE.x} target="_blank" rel="noreferrer" aria-label="X / Twitter" data-cursor data-roll-line="inline"><XLogo size={16} /> X / Twitter</a>
        </nav>
      </div>
      <div className="overscroll__bar" aria-hidden="true"><p className="overscroll__label" data-roll="split">{noOrphan('Keep scrolling — back to the surface')}</p><div className="overscroll__track"><div className="overscroll__fill" ref={(e) => { footerBar.el = e }} /></div></div>
      <div className="site-footer__bottom" data-roll="marked">
        <span data-roll-line="inline">© <Odometer value={new Date().getFullYear()} digits={4} /> {SITE.name}. Surface Tension.</span>
        {/* R6.81 (Shifat Oct 22 05:12/05:18, option A for both sites): the "Back to the surface" text link is gone; the rubber band is the way back */}
      </div>
      {/* R6.89 GIFT STICKER: gathers out of hot-pink embers at the very end of the scroll; opens the gift scene */}
      <button type="button" className="gift-sticker" aria-label="Open gift" aria-haspopup="dialog" data-cursor ref={(e) => { giftBtn.el = e }} />
    </footer>, document.body)
}
