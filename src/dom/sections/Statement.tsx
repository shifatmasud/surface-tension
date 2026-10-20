import * as THREE from 'three'
import { useRef } from 'react'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { ufxText } from '../../gl/ufx/UfxText'
import { audio } from '../../services/audio'

const PHRASES = [
  { t: ['Pixels', 'with mass.'], c: 'Springs, buoyancy and damping, written by hand, so an interface pushes back when you touch it.' },
  { t: ['Motion', 'with memory.'], c: 'Second-order motion that remembers its velocity: nothing snaps, everything settles.' },
  { t: ['Systems', 'that ship.'], c: 'A design system and the tooling around it, so the feel survives the hand-off.' },
]

/**
 * S2 — Statement. One star at a time: three display-size phrases surface (mask slide-up, staggered by
 * line) and sink away in turn while the pool idles, quiet, behind them.
 */
export function Statement() {
  const ref = useRef<HTMLElement>(null)
  const blocks = useRef<(HTMLParagraphElement | null)[]>([])
  const caps = useRef<(HTMLParagraphElement | null)[]>([])
  useSection(ref, (range) => {
    // the gem from directly above, close: its crown facets and the blue spill on the rings read as the star in the
    // upper third (a distinct shot from the hero's side view; it was a faint blue dot from 17 m behind a 0.55 fade)
    const pose = { pos: new THREE.Vector3(0, 5.6, 1.8), target: new THREE.Vector3(0, 0, 0.6), fov: 38 }
    ;(window as any).__stPose = pose // QA
    const st = visuals.register('statement', () => pose, { fade: 0.18, vignette: 0.04, bloom: 0.1, contrast: 1.02, exposure: 1.1 })
    const handles: ReturnType<typeof ufxText>[] = []
    let lastStep = -1
    return {
      name: 'statement',
      init() { document.fonts.ready.then(() => blocks.current.forEach((b) => { if (b) handles.push(ufxText(b, { color: '#0a0a0b', sheen: '#9fb4d6' })) })) },
      update() {
        st.weight = weightFrom(range.ratio)
        const pinLen = Math.max(1, range.height - props.height)
        const p = clamp((props.scroll - range.docTop + props.height * 0.2) / pinLen)
        props.statement = p
        const n = PHRASES.length
        handles.forEach((h, k) => {
          const a = k / n, b = (k + 1) / n
          const inT = clamp((p - a + 0.09 / n) / (0.42 / n)) // rise in — starts as the previous phrase sinks, so the swap never leaves a blank frame
          const outT = k === n - 1 ? 0 : clamp((p - (b - 0.12 / n)) / (0.22 / n)) // sink away (up, through the mask)
          h.mats.forEach((m, i) => {
            const stagger = i * 0.18
            m.uniforms.u_reveal.value = clamp(inT * 1.6 - stagger, 0, 1) + clamp(outT * 1.6 - stagger * 0.6, 0, 1)
          })
          const cap = caps.current[k]
          if (cap) { const v = Math.max(0, Math.min(1, inT * 1.4 - 0.4)) * (1 - Math.min(1, outT * 2)); cap.style.opacity = v.toFixed(3); cap.style.transform = `translate3d(0, ${((1 - v) * 12).toFixed(1)}px, 0)` }
        })
        const step = Math.floor(p * n)
        if (step !== lastStep && p > 0.02 && p < 0.98) { audio.plip(0.5, 0.6 + step * 0.12); lastStep = step }
      },
      dispose() { handles.forEach((h) => h.dispose()) },
    }
  })
  return (
    <section id="statement" className="section statement" ref={ref} aria-label="Statement">
      <div className="sticky statement__inner">
        {PHRASES.map((ph, i) => (
          <div key={i} className="statement__frame">
            <p className="statement__lines" ref={(el) => { blocks.current[i] = el }}>{ph.t[0]}<br />{ph.t[1]}</p>
            <p className="statement__cap" ref={(el) => { caps.current[i] = el }}>{ph.c}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
