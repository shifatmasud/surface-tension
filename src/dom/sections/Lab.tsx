import { useRef, useState } from 'react'
import { useSection } from './useSection'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { PROJECTS } from '../../content/site'
import { Odometer } from '../ui/Odometer'
import { overlay } from '../ui/overlayState'
import { audio } from '../../services/audio'
import { labGL } from '../../gl/stages/lab/labGL'
import { scroll } from '../../services/scroll'
import './lab.css'

/**
 * SECTION CUT (Shifat 15:41Z): no longer a chapter of its own. This is the dive's WORK tail: the three best pieces
 * float as slides in the dive's water (the dive keeps the camera; Dive.tsx reads this range as dive.u U_LAB → U_END).
 * The DOM id and section name stay 'lab' so the GL cards (labGL), the card morph (ProjectOverlay) and the stage
 * checks keep working unchanged; nav calls it "Work".
 * Was: S3 — Lab (inside the water scene: the projects float over the sand, under the caustics). Pinned; vertical scroll slides the shelf sideways. North-star frame: the centred reel is
 * the star (upper ~60 %), its name huge on the bottom margin (mask slide-up per card), one specific
 * line + tags as the small caption on the right, the count rolling as an odometer.
 */
export function Lab() {
  const ref = useRef<HTMLElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  const [active, setActive] = useState(0)
  useSection(ref, (range) => {
    // STRUCTURE v2: no stage of its own — the work floats in the dive's water (the dive keeps the camera and the look)
    let lastActive = -1
    return {
      name: 'lab',
      init() { if (track.current) labGL.mount(track.current) },
      show() { setSeen(true) },
      update(dt) {
        const pinLen = Math.max(1, range.height - props.height)
        const p = clamp((props.scroll - range.docTop) / pinLen)
        props.lab = p
        // dwell: each slide holds the centre of the arc for over half of its scroll and the arc turns between them,
        // so wherever the reader stops there is one centred slide (never two half slides)
        // SLIDES (Shifat 17:49Z): the track no longer slides sideways and nothing is measured here per frame (eng #7):
        // labGL turns the cylinder and places every card (GL and DOM) from layout cached on resize
        const nn = PROJECTS.length - 1, sIdx = p * nn, i0 = Math.max(0, Math.min(nn - 1, Math.floor(sIdx))), fr = sIdx - i0
        const tt = clamp((fr - 0.26) / 0.48), q = nn > 0 ? i0 + tt * tt * (3 - 2 * tt) : 0
        labGL.update(q, dt)
        const a = Math.round(p * (PROJECTS.length - 1))
        if (a !== lastActive) { lastActive = a; setActive(a); if (p > 0.01 && p < 0.99) audio.tick() }
      },
      resize() { labGL.measure() },
      dispose() { labGL.unmount() },
    }
  })
  const cur = PROJECTS[active]
  return (
    <section id="lab" className="section lab" ref={ref} aria-label="Selected work">
      <div className="sticky lab__inner">
        <p className="lab__count" aria-hidden><Odometer value={active + 1} digits={2} play={seen} /> <span>/ <Odometer value={PROJECTS.length} digits={2} play={seen} delay={0.15} /></span></p>
        <div className="lab__track" ref={track}>
          {PROJECTS.map((p, i) => (
            <div key={p.id} className={'card' + (i === active ? ' is-active' : '')} data-id={p.id} data-cursor data-cursor-label="Open" tabIndex={0} role="button"
              onClick={() => { overlay.open(p.id, { morph: true, from: labGL.rectOf(p.id) }); audio.splash() }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); overlay.open(p.id, { morph: true, from: labGL.rectOf(p.id) }) } }}
              onFocus={(e) => {
                labGL.hover(p.id, true)
                // W29 (scorer-r666 #1/#2): a keyboard stop on a card brings THAT card to the centre of the arc (its dwell, where
                // the slide sits whole on screen), a jump-cut like Systems.tsx / the CTA. The browser's own focus scroll lands
                // after this handler and the virtual engine adopts it as a glide (Water Sim landed at y928, Jelly Drag at y-163 at
                // 1440), so the jump is re-applied on the next two frames. Keyboard focus only: a click or tap is untouched.
                const el = e.currentTarget, sec = ref.current
                if (!sec || !el.matches(':focus-visible')) return
                const nn = PROJECTS.length - 1
                const go = () => scroll.scrollTo(sec, { offset: Math.max(0, sec.offsetHeight - window.innerHeight) * (nn > 0 ? i / nn : 0), immediate: true })
                go(); requestAnimationFrame(() => { go(); requestAnimationFrame(go) })
              }} onBlur={() => labGL.hover(p.id, false)}
              onPointerEnter={(e) => { if (e.pointerType !== 'mouse') return; audio.tick(); labGL.hover(p.id, true) }} onPointerLeave={(e) => { if (e.pointerType === 'mouse') labGL.hover(p.id, false) }} aria-label={`${p.title}, ${p.year}, ${p.no} ${p.tags.join(' · ')} — ${p.blurb} Open project.`}>
              <div className="card__dom">
                <img className="card__media" src={p.poster} alt="" loading="lazy" />
                <div className="card__label"><span>{p.no}</span><span>{p.tags.join(' · ')}</span></div>
              </div>
            </div>
          ))}
        </div>
        <div className="lab__foot">
          <div className="lab__names" aria-hidden>
            {PROJECTS.map((p, i) => <span key={p.id} className={'lab__name' + (i === active ? ' is-on' : i < active ? ' is-past' : '')}>{p.title}</span>)}
          </div>
          <p className="lab__cap" aria-live="polite">{cur.blurb}<br /><span><Odometer value={Number(cur.year)} digits={4} play={seen} /> · {cur.tags.join(', ')}</span></p>
        </div>
      </div>
    </section>
  )
}
