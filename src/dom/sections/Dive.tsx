import * as THREE from 'three'
import { useRef, useState } from 'react'
import { Odometer } from '../ui/Odometer'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { vfovFor } from '../../core/frame'
import { dive, divePath, gemPath, U_MAX, SYS_C, TAB_F } from '../../gl/stages/dive/diveState'
import { portrait } from '../../core/frame'
import { sections } from '../../app/sections'
import { TOOLS } from '../../content/site'
import { pool } from '../../gl/systems/pool'
import { browser } from '../../services/settings'
import { noOrphan } from '../a11y/noOrphans'

/** dive progress where the work (lab) takes over, and where the scene ends under the Shade DS card */
export const U_LAB = 0.88, U_END = 1.0
const ss = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t) }
const RM = browser.reducedMotion
/** QA: the scroll position at which the dive reaches progress u (0 … U_LAB, the dive section only) */
let scrollForU: ((u: number) => number) | null = null
;(window as any).__diveScrollFor = (u: number) => (scrollForU ? scrollForU(u) : 0)

/**
 * S5 — Dive. Pinned ~200vh. The camera skims the lake, breaks through, looks up into the light
 * (Snell's window, the star), then sinks over the sand and off the drop-off until the water is black
 * and the silt turns into stars. One display line early; afterwards only his tools, small, in the water.
 */
export function Dive() {
  const ref = useRef<HTMLElement>(null)
  const line = useRef<HTMLSpanElement>(null)
  const cap = useRef<HTMLParagraphElement>(null)
  const [toolsOn, setToolsOn] = useState(false)
  const toolsRef = useRef(false)
  useSection(ref, (range) => {
    const pose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45 }
    const st = visuals.register('dive', () => {
      const h = divePath(dive.u, pose.pos, pose.target)
      pose.fov = vfovFor(h, 30, 74)
      // W18-DIVE OVER-UNDER: a slow operator's float through the crane-down and the crossing (≈0.1–0.25°, two incommensurate
      // sines in yaw and pitch); none under reduced motion
      const fl = RM ? 0 : 1 - ss(0.4, 0.5, dive.u)
      if (fl > 0) {
        const dist = pose.pos.distanceTo(pose.target), tt = props.time
        pose.target.x += dist * fl * (0.0032 * Math.sin(tt * 0.31) + 0.0014 * Math.sin(tt * 0.83 + 1.3))
        pose.target.y += dist * fl * (0.0026 * Math.sin(tt * 0.23 + 0.7) + 0.0012 * Math.sin(tt * 0.67 + 2.1))
      }
      // v3: in the deep, phones step back so the whole UI cylinder fits the tall frame
      const pb = portrait() * ss(1.0, 1.22, dive.u) * (1 - dive.push)
      if (pb > 0) {
        // phones: the tall frame's horizontal fov is narrow — come in closer so the cylinder spans the width
        back.subVectors(pose.pos, pose.target).normalize(); pose.pos.addScaledVector(back, -pb * 1.8)
        // and the frame rides lower so the cylinder sits in the upper half, clear of the type slot
        pose.pos.y -= pb * 1.25; pose.target.y -= pb * 1.25
      }
      // W17 SCENE 3 ENTRY (STRUCTURE v3): at the end of the systems water the camera pushes INTO the stone, where the
      // tablet glows through its facets; the journey (stars + the crewmate) then takes over from inside it
      if (dive.push > 0) {
        // (13:24Z) focus moves from the stone to the tablet rising in front of it, then the camera pushes into its screen
        const a = ss(0.0, 0.5, dive.push), b = ss(0.5, 1.0, dive.push)
        tabW.copy(SYS_C).add(TAB_F)
        pushP.copy(tabW); pushP.y += 0.35; pushP.z -= 3.0 + 0.8 * portrait()
        pose.pos.lerp(pushP, a); pose.target.lerp(tabW, a)
        pushP.copy(tabW); pushP.z -= 0.62 - 0.2 * portrait()   // phones: the tall frame needs the screen closer to fill it
        pose.pos.lerp(pushP, b)
        pose.fov = pose.fov + (vfovFor(46, 30, 74) - pose.fov) * a
      }
      dive.pose.copy(pose.pos)
      return pose
    }, {
      bg: new THREE.Color('#020405'), fogColor: new THREE.Color('#020405'),
      saturation: 1.02, contrast: 1.05, vignette: 0.34, vignetteSoft: 0.7, bloom: 0.5, bloomThreshold: 0.86, dive: 1,
    })
    const back = new THREE.Vector3(), pushP = new THREE.Vector3(), tabW = new THREE.Vector3()
    scrollForU = (u: number) => range.docTop - props.height + Math.max(0, Math.min(1, u / U_LAB)) * Math.max(1, range.height)
    let lastT = -1
    const gp = new THREE.Vector3(), gt = new THREE.Vector3()
    let stirT = 0
    return {
      name: 'dive',
      update() {
        // STRUCTURE v2: the dive is the middle of the water scene. It starts under the statement (one camera: the lake,
        // the crossing, the window of light, his tools over the sand — Shifat 09:11Z: that beat stays as it was) and runs
        // on, falling into the deep, where the work slides up over the stone. Dive section: u 0 → U_LAB; the Lab section that follows: u U_LAB → U_END (a slow glide).
        const raw = clamp((props.scroll - range.docTop + props.height) / Math.max(1, range.height))
        const lab = sections.list.find((x) => x.name === 'lab')?.range
        const rawL = lab ? clamp((props.scroll - lab.docTop + props.height) / Math.max(1, lab.height)) : 0
        // v3 (Shifat 11:56Z): the Systems section is the same water, deeper — the dive runs on through it (u 1 → U_MAX)
        const sysR = sections.list.find((x) => x.name === 'systems')?.range
        const rawS = sysR ? clamp((props.scroll - sysR.docTop + props.height) / Math.max(1, sysR.height)) : 0
        dive.u = rawS > 0 ? U_END + (U_MAX - U_END) * rawS : rawL > 0 ? U_LAB + (U_END - U_LAB) * rawL : raw * U_LAB
        dive.sys = clamp((rawS - 0.3) / 0.7)
        dive.push = ss(0.62, 1.0, dive.sys)
        dive.abyss = ss(0.96, 1.2, dive.u)
        dive.gemScale = 1 + 0.7 * ss(1.02, 1.2, dive.u)
        props.dive = dive.u
        // the guide gem: handed from the hero's physics to the dive path as the dive starts; it sinks, then leads
        const vf = vfovFor(divePath(dive.u, gp, gt), 30, 74)  // (path pose without the phone step-back: the stone's place is world-fixed in the deep)
        gemPath(dive.u, gp, gt, vf, props.time, dive.gem)
        dive.gemMix = ss(0.0, 0.08, dive.u)
        dive.gemOn = props.stage === 'dive' && dive.gemMix > 0
        // his tools roll in (odometer) along the glide over the sand and the drop-off, and roll back out before the work
        const on = dive.u > 0.545 && dive.u < 0.86
        if (on !== toolsRef.current) { toolsRef.current = on; setToolsOn(on) }
        // the dive keeps the camera through the whole lab (the projects live in its water)
        const endR = sysR || lab
        st.weight = rawL > 0 && endR && props.scroll < endR.docTop + endR.height ? 1.2 : weightFrom(range.ratio) * 1.2
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
            <li className="dive__tool" key={t}><span className="dive__idx" aria-hidden="true"><Odometer value={i + 1} digits={2} play={toolsOn} delay={i * 0.06} /></span>{t}</li>
          ))}
        </ul>
        <div className="dive__foot">
          <h2 className="dive__title" id="dive-title"><span className="dive__line" ref={line}>Under the surface</span></h2>
          <p className="dive__cap" ref={cap}>{noOrphan('Shaders, physics and the GPU. The part of the work you feel before you see it.')}</p>
        </div>
      </div>
    </section>
  )
}
