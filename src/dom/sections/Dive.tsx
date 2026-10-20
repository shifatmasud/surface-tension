import * as THREE from 'three'
import { useRef } from 'react'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { vfovFor } from '../../core/frame'
import { dive, divePath } from '../../gl/stages/dive/diveState'
import { TOOLS } from '../../content/site'
import { pool } from '../../gl/systems/pool'

const ss = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t) }

/**
 * S5 — Dive. Pinned ~200vh. The camera skims the lake, breaks through, looks up into the light
 * (Snell's window, the star), then sinks over the sand and off the drop-off until the water is black
 * and the silt turns into stars. One display line early; afterwards only his tools, small, in the water.
 */
export function Dive() {
  const ref = useRef<HTMLElement>(null)
  const line = useRef<HTMLSpanElement>(null)
  const cap = useRef<HTMLParagraphElement>(null)
  useSection(ref, (range) => {
    const pose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45 }
    const st = visuals.register('dive', () => {
      const h = divePath(dive.u, pose.pos, pose.target)
      pose.fov = vfovFor(h, 30, 74)
      dive.pose.copy(pose.pos)
      return pose
    }, {
      bg: new THREE.Color('#020405'), fogColor: new THREE.Color('#020405'),
      saturation: 1.02, contrast: 1.05, vignette: 0.34, vignetteSoft: 0.7, bloom: 0.5, bloomThreshold: 0.86, dive: 1,
    })
    let lastT = -1
    let stirT = 0
    return {
      name: 'dive',
      update() {
        st.weight = weightFrom(range.ratio) * 1.2
        // 0 when the section's top meets the bottom of the screen, 1 at the end of the pin
        dive.u = clamp((props.scroll - range.docTop + props.height) / Math.max(1, range.height))
        props.dive = dive.u
        // the approach is a wide calm lake: stir it with a few rings ahead of the camera so the frame before the
        // crossing always reads as water (a horizon of moving rings), never a blank light field
        if (props.stage === 'dive' && dive.u > 0.0 && dive.u < 0.34 && !dive.under) {
          stirT -= props.dt
          if (stirT <= 0) {
            stirT = 0.22 + Math.random() * 0.3
            const z = Math.min(10.4, dive.camZ + 2.2 + Math.random() * 5.5), x = (Math.random() - 0.5) * (2.0 + (z - dive.camZ) * 0.9)
            pool.drop(x, z, 0.1 + Math.random() * 0.06, 0.02 + Math.random() * 0.015)
          }
        }
        // UI tone (data-bg) is set every frame in visuals.resolve
        // the one display line: mask slide-up in, slide-up out
        const inn = ss(0.405, 0.455, dive.u), out = ss(0.555, 0.6, dive.u)
        const y = (1 - inn) * 105 - out * 105
        const k = Math.round(y * 10) / 10
        if (k !== lastT && line.current) {
          lastT = k
          line.current.style.transform = `translate3d(0, ${k}%, 0)`
          if (cap.current) cap.current.style.opacity = (inn * (1 - out)).toFixed(3)
        }
      },
    }
  })
  return (
    <section id="dive" className="section dive" ref={ref} aria-labelledby="dive-title">
      <div className="sticky dive__inner">
        <ul className="dive__tools" aria-label="Tools I work with">
          {TOOLS.map((t, i) => (
            <li className="dive__tool" key={t}><span className="dive__idx" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>{t}</li>
          ))}
        </ul>
        <div className="dive__foot">
          <h2 className="dive__title" id="dive-title"><span className="dive__line" ref={line}>Under the surface</span></h2>
          <p className="dive__cap" ref={cap}>Shaders, physics and the GPU. The part of the work you feel before you see it.</p>
        </div>
      </div>
    </section>
  )
}
