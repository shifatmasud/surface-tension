import * as THREE from 'three'
import { useRef, useState } from 'react'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp, damp } from '../../core/math'
import { PROJECTS, SITE } from '../../content/site'
import { Odometer } from '../ui/Odometer'
import { overlay } from '../ui/overlayState'
import { audio } from '../../services/audio'
import { labGL } from '../../gl/stages/lab/labGL'

/** S3 — Lab Tank. Pinned; vertical scroll drives the track sideways. One star: the card in the middle. */
export function Lab() {
  const ref = useRef<HTMLElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  useSection(ref, (range) => {
    const pose = { pos: new THREE.Vector3(0, 24, 1.5), target: new THREE.Vector3(0, 0, 0), fov: 40 }
    const st = visuals.register('lab', () => pose, { fade: 0.72, vignette: 0.1, bloom: 0.3, bloomThreshold: 0.85, contrast: 1.04 })
    let x = 0, lastX = 0
    return {
      name: 'lab',
      init() { if (track.current) labGL.mount(track.current) },
      show() { setSeen(true) },
      update(dt) {
        st.weight = weightFrom(range.ratio)
        const el = track.current; if (!el) return
        const pinLen = Math.max(1, range.height - props.height)
        const p = clamp((props.scroll - range.docTop) / pinLen)
        props.lab = p
        const max = Math.max(0, el.scrollWidth - (props.width - parseFloat(getComputedStyle(el).paddingLeft || '0')) + 40)
        const target = -p * max
        x = damp(x, target, 9, dt)
        el.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`
        props.labVel = (x - lastX) / Math.max(dt, 1e-3); lastX = x
        labGL.offsetX = x
      },
      resize() { labGL.measure() },
      dispose() { labGL.unmount() },
    }
  })
  return (
    <section id="lab" className="section lab" ref={ref} aria-label="The lab">
      <div className="sticky lab__inner">
        <div className="lab__head">
          <div>
            <div className="eyebrow">Selected experiments</div>
            <h2 className="lab__title">The lab tank</h2>
          </div>
          <div className="lab__stats">
            <div className="stat"><span className="stat__n"><Odometer value={PROJECTS.length} digits={2} play={seen} /></span><span className="stat__l">in the tank</span></div>
            <div className="stat"><span className="stat__n"><Odometer value={SITE.publicRepos} digits={3} play={seen} delay={0.15} /></span><span className="stat__l">public repos</span></div>
          </div>
        </div>
        <div className="lab__track" ref={track}>
          {PROJECTS.map((p) => (
            <article key={p.id} className="card" data-id={p.id} data-cursor data-cursor-label="Open" tabIndex={0}
              onClick={() => { overlay.open(p.id); audio.splash() }} onKeyDown={(e) => { if (e.key === 'Enter') overlay.open(p.id) }}
              onMouseEnter={() => { audio.tick(); labGL.hover(p.id, true) }} onMouseLeave={() => labGL.hover(p.id, false)} aria-label={`${p.title} — open project`}>
              <div className="card__dom">
                <img className="card__media" src={p.poster} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
                <div className="card__top"><span className="card__no">{p.no} / {String(PROJECTS.length).padStart(2, '0')}</span><span className="card__no">{p.year}</span></div>
                <div className="card__bottom"><h3 className="card__title">{p.title}</h3><div className="tags">{p.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div></div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
