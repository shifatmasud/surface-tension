import * as THREE from 'three'
import { useRef } from 'react'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { journey } from '../../gl/stages/journey/journeyState'

/** S6 — Journey. Scroll-scrubbed: space → forest landing → it was all inside a tablet → break out. */
export function Journey() {
  const ref = useRef<HTMLElement>(null)
  useSection(ref, (range) => {
    const st = visuals.register('journey', () => journey.pose, { bg: new THREE.Color('#020203'), fogColor: new THREE.Color('#020203'), vignette: 0.4, bloom: 0.5, bloomThreshold: 0.75, contrast: 1.06, dive: 1, paintOffsetRatio: 0.6 })
    return {
      name: 'journey',
      update() {
        st.weight = weightFrom(range.ratio) * 1.4
        const pinLen = Math.max(1, range.height - props.height)
        props.journey = clamp((props.scroll - range.docTop) / pinLen)
        journey.active = range.isActive
      },
    }
  })
  return (
    <section id="journey" className="section journey" ref={ref} aria-label="Journey">
      <div className="sticky journey__inner"><p className="journey__cap sr-only">A small red explorer drifts through space, lands in a forest, and breaks out of a tablet screen.</p></div>
    </section>
  )
}
