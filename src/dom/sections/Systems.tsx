import * as THREE from 'three'
import { useEffect, useRef, useState } from 'react'
import { useSection, weightFrom } from './useSection'
import { clip } from '../../gl/systems/clip'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { settings, browser } from '../../services/settings'
import { clamp, mix } from '../../core/math'
import { vfovFor, portrait } from '../../core/frame'
import { sys, SYSTEMS_ORIGIN, TOKENS, type ControlId } from '../../gl/stages/systems/state'
import { noOrphan } from '../a11y/noOrphans'
import { scroll } from '../../services/scroll'

const ease = (t: number) => t * t * (3 - 2 * t)
const PAPER = new THREE.Color('#f7f7f8'), DIM = new THREE.Color('#c9ccd1')

/**
 * S4 — Systems. Pinned 260vh. The star is the glass stack (GL); these are the real, accessible controls
 * it shows — the stage moves each hit area onto its part of the glass every frame. Without WebGL they
 * render as a plain row of controls. Copy names the system and who it is for; the glass shows the rest.
 */
export function Systems() {
  const ref = useRef<HTMLElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const [on, setOn] = useState(sys.on)
  const [token, setToken] = useState(sys.token)
  const [level, setLevel] = useState(Math.round(sys.level * 100))
  const [inView, setInView] = useState(false)

  useSection(ref, (range) => {
    sys.reduced = browser.reducedMotion
    // v3 (Shifat 11:56Z): no stage of its own. The Systems section is the deep end of the dive: the dive keeps the
    // camera and the look, the stone settles in the middle of the cylinder of 3D Shade DS parts (gl/stages/dive/UiCylinder)
    let shown = false
    return {
      name: 'systems',
      update() {
        const pinLen = Math.max(1, range.height - props.height)
        props.systems = clamp((props.scroll - range.docTop) / pinLen)
        sys.weight = 0; sys.weightRaw = 0; sys.active = false
        const vis = range.isActive && range.ratio > -0.75
        if (vis !== shown) { shown = vis; setInView(vis) }
      },
    }
  })

  useEffect(() => {
    sys.layer = layer.current
    return () => { sys.layer = null; sys.els = {} }
  }, [])

  const bind = (id: ControlId) => (el: HTMLElement | null) => { if (el) sys.els[id] = el; else delete sys.els[id] }
  const press = (id: ControlId) => () => { sys.press[id] = performance.now() }
  const gl = settings.USE_GL

  return (
    <section id="systems" className={`section systems systems--deep${inView ? ' is-in' : ''}${gl ? '' : ' systems--dom'}`} ref={ref} aria-labelledby="systems-title">
      <div className="sticky systems__inner">
        <div className="systems__eyebrow eyebrow">Systems</div>
        <div className="systems__parts" ref={layer} role="group" aria-label="Shade DS, live parts"
          onFocus={() => {
            sys.focus = 1
            // W25 R6.53 (scorer-r652 #2): a keyboard stop on a Shade DS control brings the drum on screen first (the middle of
            // the pin, where the parts have formed), so focus never sits on a control below the fold
            const sec = ref.current; if (!sec) return
            // W26: a jump-cut (immediate), not a glide, so the drum has formed before the focus ring needs a place to sit
            const r = sec.getBoundingClientRect()
            if (!sys.formed || r.top > 1 || r.bottom < window.innerHeight - 1) scroll.scrollTo(sec, { offset: Math.max(0, sec.offsetHeight - window.innerHeight) * 0.5, immediate: true })
          }} onBlur={() => (sys.focus = 0)}>
          <button type="button" className="systems__hit systems__hit--toggle" role="switch" aria-checked={on} ref={bind('toggle')}
            onPointerDown={press('toggle')} onClick={() => { sys.on = !sys.on; setOn(sys.on); if (!gl) press('toggle')() }}>
            <span className="systems__label">Light</span>
          </button>
          <button type="button" className="systems__hit" ref={bind('button')}
            onPointerDown={press('button')} onClick={(e) => { if (e.detail === 0) press('button')(); sys.presses++ }}>
            <span className="systems__label">Ship</span>
          </button>
          <label className="systems__hit systems__hit--range" ref={bind('slider')}>
            <span className="systems__label">Light level</span>
            <input type="range" min={0} max={100} value={level} aria-label="Light level" aria-valuetext={`${level} percent`}
              onPointerDown={press('slider')}
              onChange={(e) => { const v = +e.target.value; setLevel(v); sys.level = v / 100 }} />
          </label>
          {TOKENS.map((t, i) => (
            <button key={t.name} type="button" className="systems__hit systems__hit--chip" aria-pressed={token === i} ref={bind(('chip' + i) as ControlId)}
              onPointerDown={press(('chip' + i) as ControlId)} onClick={(e) => { if (e.detail === 0) press(('chip' + i) as ControlId)(); sys.token = i; setToken(i) }}>
              <span className="systems__label">{t.name}</span>
            </button>
          ))}
        </div>
        <div className="systems__row">
          <h2 className="systems__title" id="systems-title"><span className="systems__line"><span>Shade DS</span></span></h2>
          <div className="systems__copy">
            <p className="systems__lede"><span className="systems__line"><span>{noOrphan('A generative design system for teams who ship fast and want every screen to feel like one product.')}</span></span></p>
            <p className="systems__note"><span className="systems__line"><span>{noOrphan('Plus the tooling that hands it to agents: MCP servers and the Upsy OAuth bridge, so they can work inside real apps.')}</span></span></p>
          </div>
        </div>
      </div>
    </section>
  )
}
