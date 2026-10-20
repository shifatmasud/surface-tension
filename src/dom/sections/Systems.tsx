import * as THREE from 'three'
import { useEffect, useRef, useState } from 'react'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { settings, browser } from '../../services/settings'
import { clamp, mix } from '../../core/math'
import { vfovFor, portrait } from '../../core/frame'
import { sys, SYSTEMS_ORIGIN, TOKENS, type ControlId } from '../../gl/stages/systems/state'

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
    const pose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 30 }
    const C = SYSTEMS_ORIGIN.clone().add(new THREE.Vector3(0, 0.95, 0))
    const dir = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3()
    let p = 0, out = 0
    const st = visuals.register('systems', () => {
      const pr = portrait()
      const a = props.width / Math.max(1, props.height)
      const az = mix(-0.12, 0.1, ease(p))
      const ex = ease(sys.exit)
      const el = mix(0.5, 0.58, Math.min(1, sys.openVis)) - ex * 0.1
      pose.fov = vfovFor(mix(26, 33, pr), 16, 52)
      // ultrawide (21:9): the short frame pushed the opened stack against the top edge — pull back and sit it lower
      const wide = Math.min(1, Math.max(0, (a - 1.9) / 0.5)) * (1 - Math.min(1, pr * 1.8))
      const dist = mix(14.2, 9.8, pr) + sys.openVis * mix(6.2, 2.0, pr) - ex * 1.4 + wide * 1.0  // the opened staircase is taller: pull back so the top tile keeps headroom
      dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
      right.set(Math.cos(az), 0, -Math.sin(az))
      up.crossVectors(dir, right).normalize()
      // composition: the star just right of centre, larger (north-star); upper middle / upper middle (portrait); type owns the rest
      const th = Math.tan((pose.fov * Math.PI) / 360) * dist, tw = th * a
      const sx = mix(a > 2 ? 0.26 : 0.18, 0, Math.min(1, pr * 1.8)), sy = mix(0.29 - wide * 0.2, 0.36, pr)  // tablets centre the star like phones
      pose.target.copy(C).addScaledVector(right, -sx * tw).addScaledVector(up, -sy * th)
      pose.target.y += sys.openVis * mix(1.35, 0.85, pr) - ex * 0.35
      // scrolling out: the star leaves with the page instead of sitting still under the rising type
      pose.target.addScaledVector(up, -out * 2 * th)
      pose.pos.copy(pose.target).addScaledVector(dir, dist)
      return pose
    }, { bg: PAPER.clone(), fogColor: PAPER.clone(), vignette: 0, bloom: 0.18, bloomThreshold: 0.9, contrast: 1.0, saturation: 1.1, exposure: 1 })
    let shown = false
    return {
      name: 'systems',
      update() {
        st.weight = weightFrom(range.ratio) * 0.95
        sys.weight = st.weight
        const pinLen = Math.max(1, range.height - props.height)
        p = clamp((props.scroll - range.docTop) / pinLen)
        out = Math.max(0, range.ratio)
        props.systems = p
        sys.enter = clamp((1 + range.ratio) * 1.25)
        sys.open = ease(clamp((p - 0.1) / 0.22)) * (1 - ease(clamp((p - 0.68) / 0.12)))
        sys.exit = range.ratio > 0 ? 1 : ease(clamp((p - 0.8) / 0.2))
        sys.active = props.stage === 'systems'
        // the hook: the light goes down (toggle off, or scrolling on) and the field greys toward the deep
        const dim = Math.max(sys.on ? 0 : 0.55, sys.exit)
        st.look.bg.copy(PAPER).lerp(DIM, dim); st.look.fogColor.copy(st.look.bg)
        st.look.exposure = 1 - 0.18 * dim
        const vis = range.isActive && sys.enter > 0.55
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
    <section id="systems" className={`section systems${inView ? ' is-in' : ''}${gl ? '' : ' systems--dom'}`} ref={ref} aria-labelledby="systems-title">
      <div className="sticky systems__inner">
        <div className="systems__eyebrow eyebrow">Systems</div>
        <div className="systems__parts" ref={layer} role="group" aria-label="Shade DS, live parts"
          onFocus={() => (sys.focus = 1)} onBlur={() => (sys.focus = 0)}>
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
            <input type="range" min={0} max={100} value={level} aria-valuetext={`${level} percent`}
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
            <p className="systems__lede"><span className="systems__line"><span>A generative design system for teams who ship fast and want every screen to feel like one product.</span></span></p>
            <p className="systems__note"><span className="systems__line"><span>Plus the tooling that hands it to agents: MCP servers and the Upsy OAuth bridge, so they can work inside real apps.</span></span></p>
          </div>
        </div>
      </div>
    </section>
  )
}
