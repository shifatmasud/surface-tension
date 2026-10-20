import { useRef, useState } from 'react'
import { useSection } from './useSection'
import { props } from '../../state/props'
import { clamp, damp } from '../../core/math'
import { PROJECTS } from '../../content/site'
import { Odometer } from '../ui/Odometer'
import { overlay } from '../ui/overlayState'
import { audio } from '../../services/audio'
import { labGL } from '../../gl/stages/lab/labGL'
import './lab.css'

/**
 * S3 — Lab (inside the water scene: the projects float over the sand, under the caustics). Pinned; vertical scroll slides the shelf sideways. North-star frame: the centred reel is
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
    let x = 0, lastX = 0, lastActive = -1, applied = 0, primed = false
    return {
      name: 'lab',
      init() { if (track.current) labGL.mount(track.current) },
      show() { setSeen(true) },
      update(dt) {
        const el = track.current; if (!el) return
        const pinLen = Math.max(1, range.height - props.height)
        const p = clamp((props.scroll - range.docTop) / pinLen)
        props.lab = p
        // centre card i when p = i / (n - 1)
        const cards = el.children
        const first = cards[0] as HTMLElement, last = cards[cards.length - 1] as HTMLElement
        if (!first) return
        // card centres in viewport space with the current transform removed (offsetLeft is relative to whichever
        // ancestor is positioned, which put the phone's first card ~90px off-centre at the section start)
        const r0 = first.getBoundingClientRect(), r1 = last.getBoundingClientRect()
        const c0 = r0.left + r0.width / 2 - applied, c1 = r1.left + r1.width / 2 - applied
        // dwell: each card holds the centre for over half of its scroll and the track moves between them,
        // so wherever the reader stops there is one centred star (never two half cards)
        const nn = PROJECTS.length - 1, sIdx = p * nn, i0 = Math.min(nn - 1, Math.floor(sIdx)), fr = sIdx - i0
        const tt = clamp((fr - 0.26) / 0.48), q = nn > 0 ? (i0 + tt * tt * (3 - 2 * tt)) / nn : 0
        const target = props.width / 2 - (c0 + (c1 - c0) * q)
        x = primed ? damp(x, target, 8, dt) : target; primed = true
        el.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`; applied = x
        props.labVel = (x - lastX) / Math.max(dt, 1e-3); lastX = x
        labGL.offsetX = x
        labGL.update(props.labVel, dt)
        const a = Math.round(p * (PROJECTS.length - 1))
        if (a !== lastActive) { lastActive = a; setActive(a); if (p > 0.01 && p < 0.99) audio.tick() }
      },
      resize() { labGL.measure() },
      dispose() { labGL.unmount() },
    }
  })
  const cur = PROJECTS[active]
  return (
    <section id="lab" className="section lab" ref={ref} aria-label="Lab: selected experiments">
      <div className="sticky lab__inner">
        <p className="lab__count" aria-hidden><Odometer value={active + 1} digits={2} play={seen} /> <span>/ <Odometer value={PROJECTS.length} digits={2} play={seen} delay={0.15} /></span></p>
        <div className="lab__track" ref={track}>
          {PROJECTS.map((p, i) => (
            <article key={p.id} className={'card' + (i === active ? ' is-active' : '')} data-id={p.id} data-cursor data-cursor-label="Open" tabIndex={0}
              onClick={() => { overlay.open(p.id, { morph: true, from: labGL.rectOf(p.id) }); audio.splash() }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); overlay.open(p.id, { morph: true, from: labGL.rectOf(p.id) }) } }}
              onFocus={() => labGL.hover(p.id, true)} onBlur={() => labGL.hover(p.id, false)}
              onMouseEnter={() => { audio.tick(); labGL.hover(p.id, true) }} onMouseLeave={() => labGL.hover(p.id, false)} aria-label={`${p.title}, ${p.year}. ${p.blurb} Open project.`}>
              <div className="card__dom">
                <img className="card__media" src={p.poster} alt="" loading="lazy" />
                <div className="card__label"><span>{p.no}</span><span>{p.tags.join(' · ')}</span></div>
              </div>
            </article>
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
