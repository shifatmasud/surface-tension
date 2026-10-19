import * as THREE from 'three'
import { useRef } from 'react'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { ufxText } from '../../gl/ufx/UfxText'
import { audio } from '../../services/audio'

const PHRASES = ['Systems that feel physical.', 'Interfaces with weight.', 'Water with logic.']

/**
 * S2 — Statement. One star at a time: three display-size phrases surface (mask slide-up, staggered by
 * line) and sink away in turn while the pool idles, quiet, behind them.
 */
export function Statement() {
  const ref = useRef<HTMLElement>(null)
  const blocks = useRef<(HTMLParagraphElement | null)[]>([])
  useSection(ref, (range) => {
    const pose = { pos: new THREE.Vector3(0, 17, 1.2), target: new THREE.Vector3(0, 0, 0), fov: 38 }
    const st = visuals.register('statement', () => pose, { fade: 0.55, vignette: 0.1, bloom: 0.1, contrast: 1.02 })
    const handles: ReturnType<typeof ufxText>[] = []
    let lastStep = -1
    return {
      name: 'statement',
      init() { document.fonts.ready.then(() => blocks.current.forEach((b) => { if (b) handles.push(ufxText(b, { color: '#0b0b0d', sheen: '#b7bbc2' })) })) },
      update() {
        st.weight = weightFrom(range.ratio)
        const pinLen = Math.max(1, range.height - props.height)
        const p = clamp((props.scroll - range.docTop + props.height * 0.2) / pinLen)
        props.statement = p
        const n = PHRASES.length
        handles.forEach((h, k) => {
          const a = k / n, b = (k + 1) / n
          const inT = clamp((p - a) / (0.42 / n))          // rise in
          const outT = k === n - 1 ? 0 : clamp((p - (b - 0.12 / n)) / (0.22 / n)) // sink away (up, through the mask)
          h.mats.forEach((m, i) => {
            const stagger = i * 0.18
            m.uniforms.u_reveal.value = clamp(inT * 1.6 - stagger, 0, 1) + clamp(outT * 1.6 - stagger * 0.6, 0, 1)
          })
          if (blocks.current[k]) blocks.current[k]!.setAttribute('aria-hidden', inT > 0.5 && outT < 0.5 ? 'false' : 'true')
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
        {PHRASES.map((t, i) => (
          <p key={i} className="statement__lines" ref={(el) => { blocks.current[i] = el }}>{t}</p>
        ))}
      </div>
    </section>
  )
}
