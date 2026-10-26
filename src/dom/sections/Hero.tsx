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

// A: eye level over the lake; B: a slow crane up until it is a point of blue
// first frame, optically centred (Shifat 11:05Z): the stone + its reflection read as one mass whose centre sits at
// ~47 % of the frame height (true centre, a hair above). Only the aim moves: the lens looks a touch higher
// (target -0.3 -> 0.11), so the stone drops from ~33 % to ~47 % without changing size or the type slot.
// W19 (Shifat 17:13Z "Remove top down camera" + 16:33Z front view only): the lens now sits on the dive's side of the
// stone (−z, facing +z, the direction the dive travels), so hero → dive is one front-facing move with no orbit and no
// crane-up. A keeps the approved 11:05Z first frame (same distance, height and aim, seen from the other side); B no
// longer cranes up to a top-down view: it settles low over the water, facing the stone at the scene's −6° pitch, which
// is exactly where the dive's first key (diveState KEYS u = 0) starts.
const A = { pos: new THREE.Vector3(0, 2.8, -4.5), tgt: new THREE.Vector3(0, 0.11, 0) }
const B = { pos: new THREE.Vector3(0, 0.78, -4.3), tgt: new THREE.Vector3(0, 0.33, 0) }
;(window as any).__heroA = A // QA
// portrait framing offsets (phones): closer and lower; the aim offset keeps the optical centre at ~46 % on phones too
const HP = { z: 1.7, y: 0.9, ty: 0.06 } // stone ~62% of a phone's width: it breathes
;(window as any).__heroP = HP // QA
const ease = (t: number) => t * t * (3 - 2 * t)
const HERO_LIFT_EASE = !/[?&]hl=0\b/.test(location.search)   // R7.11 b6
const HERO_EXP_EASE = !/[?&]he=0\b/.test(location.search)    // R7.11 b6d

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
      // north-star frame: the stone optically centred, giant type on the bottom margin
      pose.pos.z -= Math.sign(A.pos.z) * pr * HP.z * (1 - t); pose.pos.y -= pr * HP.y * (1 - t); pose.target.y -= pr * HP.ty * (1 - t)   // W19: phones come closer to the stone on either side
      pose.fov = mix(vfovFor(44, 22, 58), vfovFor(58), t)
      // ultrawide: the vertical fov hits its 22° floor and the stone grew past the header; back off along the view
      // line so it keeps its 16:10 share of the frame height
      const wideK = Math.max(1, Math.tan((14.2 * Math.PI) / 180) / Math.tan((pose.fov * Math.PI) / 360))
      if (wideK > 1.001) pose.pos.sub(pose.target).multiplyScalar(mix(wideK, 1, t)).add(pose.target)
      // R7.11 b6 (Shifat's real M02s: "This one looks best... then it changes to lighter water" on scroll): the hero's airy lift
      // (near-white greys pulled to paper white, 0.6) is what turned the lake floor white once the lens dropped: from the low,
      // level lens the floor reads a little lighter (longer water path, more sky in it), just enough to cross into the lift's
      // band, and the lift blew it out to a flat milky white (lum 246, no cells). The lift now eases out as the lens drops
      // (x1 at and above 1.6 m = the hero's first frame, unchanged; x0.15 at 1.0 m and below, where the dive's look (lift 0)
      // takes over anyway). ?hl=0 = b5
      // R7.11 b6b (stone lock): only the BACKGROUND pass (lake, sky) takes the eased lift (look.liftLake scales it in the chain's
      // Grade); the hero composite that draws the stone keeps the full 0.6 at every scroll position (effects.ts GRADE_CHAIN)
      if (st) {
        const k = clamp((1.6 - pose.pos.y) / 0.6), s = k * k * (3 - 2 * k)
        if (HERO_LIFT_EASE) st.look.liftLake = 1 - 0.85 * s
        // b6d: the background's exposure too, 1.12 -> ~0.99 (the dive look's 1.0, which owns the frame from ~8%); ?he=0 = b5
        if (HERO_EXP_EASE) st.look.expLake = 1 - 0.12 * s
      }
      return pose
    }, { vignette: 0.0, bloom: 0.3, contrast: 1.0, saturation: 1.05, exposure: 1.12, lift: 0.6 })
    let handle = null as ReturnType<typeof ufxText> | null
    let reveal = { v: 0 }
    // the gem is the star: the name surfaces only after it has settled
    const onDrop = () => gsap.to(reveal, { v: 1, duration: 1.8, ease: 'expo.out', delay: 1.6 })
    return {
      name: 'hero',
      init() {
        window.addEventListener('st:drop', onDrop)
        // W17: the name is drawn by the global text layer (dom/ui/TextLayer.tsx); this h1 stays for screen readers / SEO
        void ufxText
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
          <p className="hero__sub">Design engineer &amp;<br />creative technologist</p>
        </div>
      </div>
    </section>
  )
}
