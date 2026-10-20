import * as THREE from 'three'
import { useRef } from 'react'
import { useSection, weightFrom } from './useSection'
import { clip } from '../../gl/systems/clip'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { journey } from '../../gl/stages/journey/journeyState'

/** S6 — Journey. Scroll-scrubbed: space → forest landing → it was all inside a tablet → break out. */
export function Journey() {
  const ref = useRef<HTMLElement>(null)
  const b1 = useRef<HTMLParagraphElement>(null), b2 = useRef<HTMLParagraphElement>(null)
  useSection(ref, (range) => {
    const st = visuals.register('journey', () => journey.pose, { bg: new THREE.Color('#020203'), fogColor: new THREE.Color('#020203'), vignette: 0.4, bloom: 0.5, bloomThreshold: 0.75, contrast: 1.06, dive: 1, paintOffsetRatio: 0.6 })
    return {
      name: 'journey',
      update() {
        st.weight = weightFrom(range.ratio) * 1.4
        const pinLen = Math.max(1, range.height - props.height)
        props.journey = clamp((props.scroll - range.docTop) / pinLen)
        journey.active = range.isActive && clip.allowed('journey')
        journey.activeRaw = range.isActive // NEIGHBOUR HOOK
        // two small lines, timed to beats: one in space, one at the reveal (mask slide-up in, slide on out)
        const p = props.journey
        b1.current?.classList.toggle('is-on', range.isActive && p > 0.03 && p < 0.2)
        b2.current?.classList.toggle('is-on', range.isActive && p > 0.6 && p < 0.79)
      },
    }
  })
  return (
    <section id="journey" className="section journey" ref={ref} aria-label="Journey">
      <div className="sticky journey__inner"><p className="journey__cap sr-only">A small red explorer drifts through space, lands in a forest, and breaks out of a tablet screen.</p>
        <p className="journey__beat" ref={b1} aria-hidden="true"><span><span>Next: playable worlds,</span></span><span><span>made for the browser.</span></span></p>
        <p className="journey__beat" ref={b2} aria-hidden="true"><span><span>Games, toys and tools that</span></span><span><span>don’t stay inside the screen.</span></span></p>
      </div>
    </section>
  )
}
