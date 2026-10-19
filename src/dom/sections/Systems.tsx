import * as THREE from 'three'
import { useRef } from 'react'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { Cube, Plugs, Key } from '@phosphor-icons/react'

/** S4 — Systems. One star: the tray of real UI parts as jelly pucks. Copy stays quiet on the left. */
export function Systems() {
  const ref = useRef<HTMLElement>(null)
  const tray = useRef<HTMLDivElement>(null)
  useSection(ref, (range) => {
    const pose = { pos: new THREE.Vector3(0, 24, 1.5), target: new THREE.Vector3(0, 0, 0), fov: 40 }
    const st = visuals.register('systems', () => pose, { fade: 0.78, vignette: 0.1, bloom: 0.15 })
    return {
      name: 'systems',
      update() { st.weight = weightFrom(range.ratio) * 0.9; props.systems = clamp(range.progress) },
    }
  })
  return (
    <section id="systems" className="section systems" ref={ref} aria-label="Systems">
      <div className="systems__copy">
        <div className="eyebrow">Systems</div>
        <h2>Design systems that behave like materials.</h2>
        <p>Shade DS is my generative design system: tokens, motion and components that stay consistent because they are computed, not copied.</p>
        <p>On the other side of the stack I build agent tooling — MCP servers and an OAuth bridge so agents can work inside real apps.</p>
        <ul>
          <li><Cube size={18} weight="duotone" /> Shade DS — generative tokens &amp; components</li>
          <li><Plugs size={18} weight="duotone" /> MCP servers for agent tooling</li>
          <li><Key size={18} weight="duotone" /> Upsy OAuth bridge</li>
        </ul>
      </div>
      <div className="systems__tray" ref={tray} id="systems-tray" />
    </section>
  )
}
