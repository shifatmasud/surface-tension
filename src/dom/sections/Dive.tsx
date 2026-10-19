import * as THREE from 'three'
import { useRef } from 'react'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp, mix } from '../../core/math'

/** S5 — Dive. Pinned 220vh: the camera pushes through the surface into the deep. */
export function Dive() {
  const ref = useRef<HTMLElement>(null)
  useSection(ref, (range) => {
    const pose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45 }
    const st = visuals.register('dive', () => {
      const p = props.dive
      const t = clamp(p / 0.35)            // 0..1 through the surface
      pose.pos.set(0, mix(5.5, -3.5, t * t * (3 - 2 * t)) - clamp((p - 0.35) / 0.65) * 7, mix(8, 3, t))
      pose.target.set(0, mix(-1, -6, t) - clamp((p - 0.35) / 0.65) * 8, mix(0, -4, t))
      pose.fov = mix(40, 52, t)
      return pose
    }, { bg: new THREE.Color('#040405'), fogColor: new THREE.Color('#050506'), saturation: 0.6, vignette: 0.55, vignetteSoft: 0.6, bloom: 0.55, bloomThreshold: 0.7, contrast: 1.12, dive: 1 })
    return {
      name: 'dive',
      update() {
        st.weight = weightFrom(range.ratio) * 1.2
        const pinLen = Math.max(1, range.height - props.height)
        props.dive = clamp((props.scroll - range.docTop + props.height * 0.5) / pinLen)
        document.documentElement.dataset.bg = props.look.dive > 0.5 ? 'dark' : 'light'
      },
    }
  })
  return (
    <section id="dive" className="section dive" ref={ref} aria-label="Dive">
      <div className="sticky dive__inner">
        <h2 className="dive__title" id="dive-title">Under the surface: the tools.</h2>
        <div className="dive__labels" id="dive-labels" />
      </div>
    </section>
  )
}
