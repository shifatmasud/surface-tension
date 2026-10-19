import * as THREE from 'three'
import { useEffect, useRef } from 'react'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp, mix } from '../../core/math'
import { ufxText } from '../../gl/ufx/UfxText'
import { SITE } from '../../content/site'
import gsap from 'gsap'
import { vfovFor, portrait } from '../../core/frame'

// A: eye level over the lake, the gem centred low in frame; B: a slow crane up until it is a point of blue
const A = { pos: new THREE.Vector3(0, 3.3, 5.4), tgt: new THREE.Vector3(0, -0.15, 0) }
const B = { pos: new THREE.Vector3(0, 10.5, 3.2), tgt: new THREE.Vector3(0, 0, -0.4) }
const ease = (t: number) => t * t * (3 - 2 * t)

/** S1 — Surface. Pinned for 150vh: scrubbing tilts the camera top-down and drifts the tiles apart. */
export function Hero() {
  const ref = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  useSection(ref, (range) => {
    const pose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 35 }
    const st = visuals.register('hero', () => {
      const t = ease(props.heroPin)
      const pr = portrait()
      pose.pos.lerpVectors(A.pos, B.pos, t); pose.target.lerpVectors(A.tgt, B.tgt, t)
      // north-star frame: the gem centred in the upper ~60 %, giant type on the bottom margin
      pose.pos.z -= pr * 1.6 * (1 - t); pose.pos.y -= pr * 0.9 * (1 - t); pose.target.y -= pr * 0.55 * (1 - t)
      pose.fov = mix(vfovFor(44, 22, 58), vfovFor(58), t)
      return pose
    }, { vignette: 0.0, bloom: 0.3, contrast: 1.0, saturation: 1.05 })
    let handle: ReturnType<typeof ufxText> | null = null
    let reveal = { v: 0 }
    // the gem is the star: the name surfaces only after it has settled
    const onDrop = () => gsap.to(reveal, { v: 1, duration: 1.8, ease: 'expo.out', delay: 1.6 })
    return {
      name: 'hero',
      init() {
        window.addEventListener('st:drop', onDrop)
        document.fonts.ready.then(() => { if (title.current) handle = ufxText(title.current, { color: '#0a0a0b', sheen: '#9fb4d6' }) })
      },
      update() {
        const pinLen = Math.max(1, range.height - props.height)
        props.heroPin = clamp((props.scroll - range.docTop) / pinLen)
        st.weight = props.scroll < range.docTop + range.height ? Math.max(0.0001, weightFrom(range.ratio)) : 0
        // title: chars rise on the drop; fade as the camera goes top-down
        handle?.mats.forEach((m, i) => { m.uniforms.u_reveal.value = clamp(reveal.v * 1.2 - i * 0.12); m.uniforms.u_opacity.value = 1 - clamp(props.heroPin * 2.2 - 0.6) })
      },
      dispose() { window.removeEventListener('st:drop', onDrop); handle?.dispose() },
    }
  })
  return (
    <section id="hero" className="section hero" ref={ref} aria-label="Intro">
      <div className="sticky hero__inner">
        <div className="hero__row">
          <h1 className="hero__title" ref={title}>Shifat<br />Masud</h1>
          <p className="hero__sub">Design engineer &amp;<br />creative technologist, Dhaka.</p>
        </div>
      </div>
    </section>
  )
}
