import { Odometer } from './Odometer'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight, X } from '@phosphor-icons/react'
import { overlay } from './overlayState'
import { PROJECTS } from '../../content/site'
import { inkWipe } from './inkWipe'
import { labGL } from '../../gl/stages/lab/labGL'
import { browser } from '../../services/settings'

/**
 * Project detail card.
 * Story job: the slide you picked lifts out of the deep and becomes its own card. The same frame and image grow
 * and reshape in one move (shared element), the title settles, then the details arrive; closing folds it back
 * into the very slide it came from. Reduced motion: a soft crossfade. No GL / no slide: the older ink wipe.
 */
const EASE_OPEN = 'cubic-bezier(.76,0,.24,1)'
const EASE_CLOSE = 'cubic-bezier(.65,0,.35,1)'
const T_OPEN = 700, T_CLOSE = 640
type R = { left: number; top: number; width: number; height: number; radius: number }

const cardEl = (id: string) => document.querySelector<HTMLElement>(`#lab .card[data-id="${id}"]`)
function slideRect(id: string, given?: R | null): R | null {
  const r = given ?? labGL.rectOf(id)
  // only morph from a slide that is actually on screen
  if (!r || r.width < 4 || r.top + r.height < 0 || r.top > innerHeight || r.left + r.width < 0 || r.left > innerWidth) return null
  return r
}
const box = (r: R) => ({ left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', borderRadius: r.radius + 'px' })

export function ProjectOverlay() {
  const [id, setId] = useState<string | null>(null)
  const [phase, setPhase] = useState('idle')
  const [shown, setShown] = useState(false)       // details revealed (after the morph lands)
  const vid = useRef<HTMLVideoElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const media = useRef<HTMLDivElement>(null)
  const glass = useRef<HTMLDivElement>(null)
  const bg = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const back = useRef<HTMLElement | null>(null)   // where focus returns on close
  const morphing = useRef(false)

  const reduced = browser.reducedMotion

  const holdQA = (anims: Animation[]) => {
    const hold = (window as any).__morphHold as number | undefined   // QA: freeze the morph at a fraction 0..1
    if (hold == null) return
    anims.forEach((x) => { x.pause(); x.currentTime = hold * T_OPEN })
    ;(window as any).__morphRelease = () => anims.forEach((x) => x.play())
  }
  /** the image itself flies between two rects (viewport px), corners rounding as it goes; resolves when it lands */
  const fly = (from: R, to: R, src: string, ms: number, ease: string) => new Promise<void>((done) => {
    const f = document.createElement('div'); f.className = 'morph'; f.setAttribute('aria-hidden', 'true')
    const im = document.createElement('img'); im.className = 'morph__img'; im.src = src; im.alt = ''
    f.appendChild(im); document.body.appendChild(f)
    Object.assign(f.style, box(from))
    const a = f.animate([box(from), box(to)], { duration: ms, easing: ease, fill: 'forwards' })
    holdQA([a])
    a.onfinish = () => { done(); requestAnimationFrame(() => f.remove()) }
    a.oncancel = () => { f.remove(); done() }
  })

  useEffect(() => overlay.sub((cur, s) => {
    setPhase(s)
    if (overlay.morph) {
      if (s === 'hiding') { back.current = document.activeElement as HTMLElement; setShown(false); setId(cur) }
      if (s === 'closing') morphOut()
      return
    }
    if (s === 'hiding') { back.current = document.activeElement as HTMLElement; inkWipe.play('in').then(() => overlay.advance()) }
    if (s === 'loading') { setId(cur); setShown(true); setTimeout(() => overlay.advance(), 60) }
    if (s === 'showing') inkWipe.play('out').then(() => overlay.advance())
    if (s === 'closing') { inkWipe.play('in').then(() => { setId(null); inkWipe.play('out'); overlay.advance(); back.current?.focus?.() }) }
  }), [])

  // W18 (Shifat 13:47Z + 13:48Z): the slide image morphs into a COMPACT card. The image flies from its slide to the
  // card's thumb and stays on top as the anchor; a frosted-glass plane grows out from BEHIND it to the card's full size;
  // then the text arrives on the glass. The page behind blurs in step with the morph. Close plays it backwards.
  const glassClip = (pn: HTMLElement, md: HTMLElement, r = 18) => {
    const pr = pn.getBoundingClientRect(), mr = md.getBoundingClientRect()
    return `inset(${(mr.top - pr.top).toFixed(1)}px ${(pr.right - mr.right).toFixed(1)}px ${(pr.bottom - mr.bottom).toFixed(1)}px ${(mr.left - pr.left).toFixed(1)}px round ${r}px)`
  }
  const FULL = 'inset(0px 0px 0px 0px round 28px)'
  const texts = (pn: HTMLElement) => pn.querySelectorAll<HTMLElement>('.overlay__title, .overlay__in, .overlay__close')
  const blurIn = (ms: number, delay = 0) => bg.current?.animate(
    [{ opacity: 0, backdropFilter: 'blur(0px)', WebkitBackdropFilter: 'blur(0px)' } as any, { opacity: 1, backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' } as any],
    { duration: ms, delay, easing: 'cubic-bezier(.33,0,.2,1)', fill: 'both' })
  const blurOut = (ms: number, delay = 0) => bg.current?.animate(
    [{ opacity: 1, backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' } as any, { opacity: 0, backdropFilter: 'blur(0px)', WebkitBackdropFilter: 'blur(0px)' } as any],
    { duration: ms, delay, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' })

  // morph in: runs once the card is laid out (hidden) so its final rects can be measured
  useLayoutEffect(() => {
    if (!id || !overlay.morph || overlay.state !== 'hiding') return
    const p = PROJECTS.find((x) => x.id === id)!
    const pn = panel.current!, md = media.current!, gl = glass.current!
    const from = slideRect(id, overlay.from)
    const land = () => {
      pn.style.visibility = ''; md.style.opacity = ''; setShown(true); morphing.current = false; overlay.opened(); closeBtn.current?.focus({ preventScroll: true })
    }
    const arrive = (delay: number) => texts(pn).forEach((el, i) => {
      const dy = el.classList.contains('overlay__title') ? 16 : 10
      el.animate([{ opacity: 0, transform: `translate3d(0,${dy}px,0)` }, { opacity: 1, transform: 'none' }],
        { duration: reduced ? 200 : 520, delay: reduced ? 0 : delay + i * 55, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' })
    })
    if (reduced || !from) {
      pn.style.visibility = ''
      pn.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced ? 240 : 420, easing: 'ease-out' })
      blurIn(reduced ? 240 : 420); arrive(0); land(); return
    }
    morphing.current = true
    const mr = md.getBoundingClientRect()
    const imgTo: R = { left: mr.left, top: mr.top, width: mr.width, height: mr.height, radius: 18 }
    // the card is visible from the start, but only its glass (clipped to the thumb, so it is hidden under the flying
    // image) — the thumb itself waits for the image to land, the text waits for the glass
    md.style.opacity = '0'
    texts(pn).forEach((el) => { el.style.opacity = '0' })
    pn.style.visibility = ''
    labGL.hidden.add(id); cardEl(id)?.classList.add('is-lifted')
    blurIn(T_OPEN * 0.9)
    const g = gl.animate([{ clipPath: glassClip(pn, md), opacity: 0.0 }, { clipPath: glassClip(pn, md), opacity: 1, offset: 0.12 }, { clipPath: FULL, opacity: 1 }],
      { duration: T_OPEN * 0.62, delay: T_OPEN * 0.4, easing: 'cubic-bezier(.22,.9,.25,1)', fill: 'both' })
    holdQA([g])
    texts(pn).forEach((el) => { el.style.opacity = '' })
    arrive(T_OPEN * 0.72)
    fly({ ...from }, imgTo, p.poster, T_OPEN * 0.88, EASE_OPEN).then(land)
  }, [id])

  const morphOut = () => {
    const cur = overlay.current, pn = panel.current, md = media.current, gl = glass.current
    const finish = () => {
      if (cur) { labGL.hidden.delete(cur); cardEl(cur)?.classList.remove('is-lifted') }
      setId(null); setShown(false); morphing.current = false; overlay.advance()
      back.current?.focus?.({ preventScroll: true } as any)
    }
    // the page has not moved while the card was open: fold back into the rect it came from
    const to = cur ? slideRect(cur, overlay.from) : null
    if (!cur || !pn || !md || !gl || reduced || !to) {
      const ms = reduced ? 200 : 320
      pn?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: 'forwards' })
      blurOut(ms)
      setTimeout(finish, ms); return
    }
    morphing.current = true
    const p = PROJECTS.find((x) => x.id === cur)!
    // the text leaves, the glass folds back under the thumb, then the image flies home and the blur lifts
    texts(pn).forEach((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in', fill: 'forwards' }))
    gl.animate([{ clipPath: FULL, opacity: 1 }, { clipPath: glassClip(pn, md), opacity: 1, offset: 0.88 }, { clipPath: glassClip(pn, md), opacity: 0 }],
      { duration: T_CLOSE * 0.55, delay: 90, easing: 'cubic-bezier(.6,0,.4,1)', fill: 'forwards' })
    blurOut(T_CLOSE * 0.9, T_CLOSE * 0.25)
    setTimeout(() => {
      const mr = md.getBoundingClientRect()
      md.style.opacity = '0'
      fly({ left: mr.left, top: mr.top, width: mr.width, height: mr.height, radius: 18 }, { ...to }, p.poster, T_CLOSE * 0.8, EASE_CLOSE).then(() => { pn.style.visibility = 'hidden'; finish() })
    }, 90 + T_CLOSE * 0.5)
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!overlay.current) return
      if (e.key === 'Escape') overlay.close()
      if (e.key === 'Tab' && panel.current) {
        // keep focus inside the dialog
        const f = Array.from(panel.current.querySelectorAll<HTMLElement>('button, a[href], video[controls], [tabindex]:not([tabindex="-1"])'))
        if (!f.length) return
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [])

  // phones: swipe the card down to close (the card follows the finger, the field lightens)
  useEffect(() => {
    const pn = panel.current
    if (!id || !pn) return
    let y0 = 0, t0 = 0, dy = 0, drag = false
    const start = (e: TouchEvent) => { if (morphing.current || pn.scrollTop > 0) return; y0 = e.touches[0].clientY; t0 = performance.now(); dy = 0; drag = true }
    const move = (e: TouchEvent) => {
      if (!drag) return
      dy = Math.max(0, e.touches[0].clientY - y0)
      if (dy > 4) e.preventDefault()
      pn.style.transform = `translate3d(0,${dy}px,0)`
      if (bg.current) bg.current.style.opacity = String(1 - Math.min(0.6, dy / 600))
    }
    const end = () => {
      if (!drag) return; drag = false
      const v = dy / Math.max(1, performance.now() - t0)
      if (dy > 110 || (dy > 30 && v > 0.6)) { overlay.close(); return }   // morphOut measures the dragged rect
      pn.animate([{ transform: `translate3d(0,${dy}px,0)` }, { transform: 'translate3d(0,0,0)' }], { duration: 320, easing: 'cubic-bezier(.2,.9,.3,1.2)' })
      pn.style.transform = ''; if (bg.current) bg.current.style.opacity = ''
    }
    pn.addEventListener('touchstart', start, { passive: true })
    pn.addEventListener('touchmove', move, { passive: false })
    pn.addEventListener('touchend', end); pn.addEventListener('touchcancel', end)
    return () => { pn.removeEventListener('touchstart', start); pn.removeEventListener('touchmove', move); pn.removeEventListener('touchend', end); pn.removeEventListener('touchcancel', end) }
  }, [id])

  const p = PROJECTS.find((x) => x.id === id)
  const morph = overlay.morph
  return (
    <AnimatePresence>
      {p && (
        <motion.div className={'overlay' + (shown ? ' is-shown' : '')} role="dialog" aria-modal="true" aria-label={p.title}
          initial={morph ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={morph ? { opacity: 1, transition: { duration: 0 } } : { opacity: 0 }}>
          <div className="overlay__bg" ref={bg} onClick={() => overlay.close()} />
          <motion.div className="overlay__panel" ref={panel}
            initial={morph ? false : { y: 40, scale: 0.97 }} animate={{ y: 0, scale: 1 }} exit={morph ? undefined : { y: 30, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 140, damping: 20 }} style={morph ? { visibility: 'hidden' } : undefined}
            onPointerMove={(e) => { if (e.pointerType !== 'mouse') return; const r = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty('--tx', (((e.clientY - r.top) / r.height - 0.5) * -4).toFixed(2) + 'deg'); e.currentTarget.style.setProperty('--ty', (((e.clientX - r.left) / r.width - 0.5) * 5).toFixed(2) + 'deg') }}
            onPointerLeave={(e) => { e.currentTarget.style.setProperty('--tx', '0deg'); e.currentTarget.style.setProperty('--ty', '0deg') }}>
            <div className="overlay__glass" ref={glass} aria-hidden="true" />
            <button ref={closeBtn} className="pill overlay__close" onClick={() => overlay.close()} aria-label="Close project"><X size={16} weight="bold" /></button>
            <div className="overlay__media" ref={media}>
              <video ref={vid} src={p.media} poster={p.poster} autoPlay muted loop playsInline aria-hidden="true" />
            </div>
            <div className="overlay__body">
              <span className="eyebrow overlay__in">{shown && <><Odometer value={Number(p.no)} digits={2} delay={0.1} /> · <Odometer value={Number(p.year)} digits={4} delay={0.15} /></>}{!shown && <>{p.no} · {p.year}</>} · {p.role}</span>
              <h3 className="overlay__title">{p.title}</h3>
              <p className="overlay__in overlay__line">{p.blurb}</p>
              <a className="overlay__in overlay__link" href={p.url} target="_blank" rel="noreferrer">Live demo <ArrowUpRight size={16} weight="bold" /></a>
            </div>
          </motion.div>
        </motion.div>
      )}
      {phase === 'never' && null}
    </AnimatePresence>
  )
}
