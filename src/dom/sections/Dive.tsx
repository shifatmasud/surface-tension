import * as THREE from 'three'
import { useRef, useState } from 'react'
import { Odometer } from '../ui/Odometer'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { vfovFor } from '../../core/frame'
import { dive, divePath, gemPath, U_MAX, SINK_M, TAB_GLASS, PORTAL0, PORTAL1, GEM_BEHIND, tabletUpright, tabletPresentDist, tabletFillDist, portalKe } from '../../gl/stages/dive/diveState'
import { GLIDE_PRE } from '../../gl/stages/journey/spaceSky' // R6.88 PORTAL
import { portrait } from '../../core/frame'
import { sections } from '../../app/sections'
import { TOOLS } from '../../content/site'
import { scroll } from '../../services/scroll'
import { pool } from '../../gl/systems/pool'
import { browser } from '../../services/settings'
import { noOrphan } from '../a11y/noOrphans'

/** dive progress where the work (lab) takes over, and where the scene ends under the Shade DS card */
const LOOK_BG0 = new THREE.Color('#020405'), LOOK_BG1 = new THREE.Color('#020203') // R6.88: the dive's and the journey's grade backgrounds
export const U_LAB = 0.88, U_END = 1.0
const ss = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t) }
/** R6.88b: the camera's sink to the deep tablet (smootherstep: no speed step at either end) */
const sinkK = (p: number) => { const t = clamp((p - 0.04) / 0.38); return t * t * t * (t * (6 * t - 15) + 10) }
/** smoothstep's inverse on 0..1 */
const invSS = (y: number) => { let lo = 0, hi = 1; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (m * m * (3 - 2 * m) < y) lo = m; else hi = m } return (lo + hi) / 2 }
/** the systems progress where the glass's picture starts converging on the journey's frame (TabletWindow: h = ss(0.8, 1, k),
 *  k = ss(PORTAL0, 1, push), push = ss(0.56, 1, sys)) — GLIDE_PRE runs from here to the switch */
/**
 * R6.89 SCROLL BUDGET (Shifat Oct 23 3:43 AM: "Shade ds … need more scroll zone. The ds section feels too fast" and "Crewmate
 * tablet in ocean should need more scroll to reach. Its too fast"; both +50 %, confirmed 3:46 AM). Every phase of the
 * systems section was tuned on R6.88d's 310vh section, so the section's scroll is warped back onto those 310vh:
 *   - the section arriving (the first 0.93 screens): 1:1, unchanged;
 *   - the Shade DS ring (sys 0 → 0.56) and the parts' dissolve + the sink to the tablet waiting in the deep (push 0 → 0.42):
 *     1.5× the scroll (the speed eases 1 → 2/3 → 1 over 0.2 screens at each end, so no step in pace is felt);
 *   - the diamond behind the tablet and the zero-cut portal push (push 0.42 → 1): 1:1, the same scroll as R6.88d.
 * x: px from the section's top entering the bottom of the screen; H: the section's height; vh: the screen height.
 * Returns R6.88d's rawS (0..1). Reduced motion (an unpinned 100vh section) keeps the plain fraction.
 */
const SYS_OLD_VH = 3.1                                  // R6.88d: 310vh
const W_X0 = 0.93, W_X1 = 0.93 + 0.7 * SYS_OLD_VH * (0.56 + 0.44 * 0.4466)   // old vh units: the ring starts / the tablet is reached (push 0.42)
const W_R = 0.2                                         // the speed's ease at each end (screens of new scroll)
function sysWarp(x: number, H: number, vh: number) {
  const hn = H / Math.max(1, vh)
  if (hn < 1.5) return clamp(x / Math.max(1, H))
  const xn = clamp(x / Math.max(1, vh), 0, hn)
  // slow factor K, solved so the whole section maps exactly onto the old 310vh: hn = W_X0 + K (W_X1 - W_X0) + (3.1 - W_X1)
  const K = Math.max(1, (hn - W_X0 - (SYS_OLD_VH - W_X1)) / (W_X1 - W_X0))
  const b1 = W_X0, b2 = W_X0 + K * (W_X1 - W_X0)          // the boundaries in new units (the ideal piecewise map)
  // the piecewise-linear map, with each corner rounded by a speed ramp centred on it (a centred ramp leaves the map exact
  // outside it: the integral of the ramp equals the two straight halves)
  const v = 1 / K
  const seg = (a: number) => (a <= b1 ? a : a <= b2 ? b1 + (a - b1) * v : W_X1 + (a - b2))
  const corner = (a: number, c: number, v0: number, v1: number) => {
    // inside [c - R/2, c + R/2] the speed eases v0 → v1 (smoothstep); returns the correction to the straight map
    const h = W_R / 2, t = clamp((a - (c - h)) / W_R)
    if (t <= 0 || t >= 1) return 0
    const S = (u: number) => u * u * u - 0.5 * u * u * u * u   // ∫ smoothstep = u³ − u⁴/2
    const smooth = (v0 * t + (v1 - v0) * S(t)) * W_R            // distance covered by the ramp so far
    const straight = a <= c ? v0 * (a - (c - h)) : v0 * h + v1 * (a - c)
    return smooth - straight
  }
  const xo = seg(xn) + corner(xn, b1, 1, v) + corner(xn, b2, v, 1)
  return clamp(xo / SYS_OLD_VH)
}
const SYS_H = 0.56 + 0.44 * invSS(PORTAL0 + (1 - PORTAL0) * invSS(0.8))
const RM = browser.reducedMotion
/** QA: the scroll position at which the dive reaches progress u (0 … U_LAB, the dive section only) */
let scrollForU: ((u: number) => number) | null = null
;(window as any).__diveScrollFor = (u: number) => (scrollForU ? scrollForU(u) : 0)

/**
 * S5 — Dive. Pinned ~200vh. The camera skims the lake, breaks through, looks up into the light
 * (Snell's window, the star), then sinks over the sand and off the drop-off until the water is black
 * and the silt turns into stars. One display line early; afterwards only his tools, small, in the water.
 */
/** W19 (Shifat 20:40Z m:0578f462 + 20:44Z m:d3c2c6e4): under water the look UP holds for the first ~60 % of the span (god
 *  rays, the surface ripples from below); from there the lens eases to looking a little DOWN (base −6° − 4.5°) and dollies
 *  ~0.8 forward to sell depth, then hands back to the fixed −6° of the deep descent. Scroll-driven, reversible. Applied to
 *  the camera AND to the guide stone's path pose, so the stone keeps its place in the frame. */
function underwaterShape(u: number, pos: THREE.Vector3, target: THREE.Vector3) {
  const dx = target.x - pos.x, dz = target.z - pos.z, hz = Math.max(1e-3, Math.hypot(dx, dz))
  const fx = dx / hz, fz = dz / hz
  const kIn = ss(0.54, 0.62, u), kDeep = ss(0.70, 0.80, u), kBack = ss(0.92, 1.0, u)
  const dolly = 0.8 * ss(0.54, 0.68, u) * (1 - kBack)
  if (dolly > 0) { pos.x += fx * dolly; pos.z += fz * dolly; target.x += fx * dolly; target.z += fz * dolly }
  const D = Math.PI / 180
  // W19 (rules: only 2 tilts, UP +12–18°, DOWN −20–25°): the look-up is the path's own (peaks ~+40°, see below)
  // (a +15° cap was tried at 21:30Z: the look-up then shows only grey fog, not the surface ripples Shifat asked for; held for his call)
  let p = Math.atan2(target.y - pos.y, hz)
  p = p + (-10.5 * D - p) * kIn                 // from ~60 % of the underwater span: a little down (base −6° − 4.5°)
  p = p + (-22 * D - p) * kDeep                 // the deep descent tilt (−22°)
  p = p + (-6 * D - p) * kBack                  // and back to the fixed −6° as the work slides up
  target.y = pos.y + Math.tan(p) * hz
}

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
      underwaterShape(dive.u, pose.pos, pose.target)
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
      const pb = portrait() * ss(1.0, 1.22, dive.u) // R6.88b: held through the push (the deep framing takes over by its own blend)
      if (pb > 0) {
        // phones: the tall frame's horizontal fov is narrow — come in closer so the cylinder spans the width
        back.subVectors(pose.pos, pose.target).normalize(); pose.pos.addScaledVector(back, -pb * 1.8)
        // and the frame rides lower so the cylinder sits in the upper half, clear of the type slot
        pose.pos.y -= pb * 1.25; pose.target.y -= pb * 1.25
      }
      // R6.82 (Shifat 6:46 AM PT Oct 22): wide screens ride a little lower too, so the atom (the stone at its centre)
      // sits just above mid-frame, clear of the Systems type in the lower part. Phones (portrait = 1) get 0: unchanged.
      const db = (1 - portrait()) * ss(1.0, 1.22, dive.u)
      if (db > 0) { pose.pos.y -= db * 0.35; pose.target.y -= db * 0.35 }
      // W17 SCENE 3 ENTRY (STRUCTURE v3): at the end of the systems water the camera pushes INTO the stone, where the
      // tablet glows through its facets; the journey (stars + the crewmate) then takes over from inside it
      // R6.88b DEEP TABLET + PORTAL (Shifat 10:08 PM "0 jump cut … only smooth portal in", 10:41 PM the tablet waits in the
      // deep): over the push the camera sinks from the Shade DS framing to the tablet waiting SINK_M below (0.04 → 0.42),
      // square to its glass on its axis, the whole slab presented at the centre of the frame; holds there while the diamond
      // comes to dead centre behind it and dissolves (a slow drift in); then pushes straight through the glass
      // (PORTAL0 → PORTAL1): the bezel slides off the frame's edges and the display grows until it covers the frame, at a
      // constant rate of zoom (log distance, eased in and out). The stage switch comes after PORTAL1, at full cover.
      if (dive.push > 0) {
        const p = dive.push, fovD = vfovFor(46, 30, 74), aspect = props.width / Math.max(1, props.height), up = tabletUpright()
        const Dv = tabletPresentDist(fovD, aspect, up), Df = tabletFillDist(fovD, aspect, up)
        let dist = Dv * (1 - 0.08 * clamp((p - 0.42) / (PORTAL0 - 0.42)))
        // R6.99 (the zoom through the glass ran in ~0.2 screens of scroll: 70 % of it in 50 px on the 1366 PC, a jump on a
        // normal scroll, then the lens sat still until the switch): the same push now runs linear in the section's own
        // scroll (sys, not the push's smoothstep, which bunched it up) from PORTAL0 to just before the switch, eased with a
        // plain smoothstep, so the zoom is spread ~2.5× wider with no faster peak. Same start, same end pose, same scroll.
        const ke = portalKe(dive.sys)
        if (ke > 0) dist = dist * Math.pow(Df / dist, ke)
        const A = sinkK(p)
        deepP.set(TAB_GLASS.x, TAB_GLASS.y, TAB_GLASS.z - dist)
        pose.pos.lerp(deepP, A); pose.target.lerp(TAB_GLASS, A)
        pose.fov = pose.fov + (fovD - pose.fov) * A
        // where the diamond comes to rest: on the lens axis through the glass, GEM_BEHIND behind it, its girdle ≈ 1.45 × the
        // slab's width as seen from the held lens (upright on phones: it shows either side; wide: all round)
        const dG = Dv + 0.032 + GEM_BEHIND, R = (up ? 1.45 : 1.25) * (up ? 0.485 : 0.735) * dG / Dv
        dive.gemBig = R / 0.5
        dive.gemCtr.set(TAB_GLASS.x, TAB_GLASS.y, TAB_GLASS.z + 0.032 + GEM_BEHIND) // its girdle (the part that shows either side) on the axis
        dive.gemCtrOk = true
      }
      // R6.88 ZERO-CUT: over the last of the push the dive's grade arrives at the journey's (Journey.tsx), so the frame before
      // the stage switch and the frame after it are graded alike (it was a vignette / contrast / bloom-threshold step)
      { const k = ss(0.8, 1, dive.push), L = st.look
        L.saturation = 1.02 + (1.0 - 1.02) * k; L.contrast = 1.05 + (1.06 - 1.05) * k; L.vignette = 0.34 + (0.4 - 0.34) * k
        L.vignetteSoft = 0.7 + (0.75 - 0.7) * k; L.bloomThreshold = 0.86 + (0.75 - 0.86) * k; L.paintOffsetRatio = 1 + (0.6 - 1) * k
        L.bg.copy(LOOK_BG0).lerp(LOOK_BG1, k); L.fogColor.copy(L.bg) }
      dive.pose.copy(pose.pos)
      // QA (W19): the dive camera's pose as numbers (u, height, z, pitch in degrees) for the regression suite
      ;(window as any).__divePose = { u: +dive.u.toFixed(4), y: +pose.pos.y.toFixed(3), z: +pose.pos.z.toFixed(3), pitch: +(Math.atan2(pose.target.y - pose.pos.y, Math.hypot(pose.target.x - pose.pos.x, pose.target.z - pose.pos.z)) * 57.2958).toFixed(2) }
      return pose
    }, {
      bg: new THREE.Color('#020405'), fogColor: new THREE.Color('#020405'),
      saturation: 1.02, contrast: 1.05, vignette: 0.34, vignetteSoft: 0.7, bloom: 0.5, bloomThreshold: 0.86, dive: 1,
    })
    const back = new THREE.Vector3(), deepP = new THREE.Vector3()
    ;(window as any).__diveGo = (u: number) => { if (scrollForU) scroll.scrollTo(scrollForU(u), { immediate: true }) }
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
        const rawS = sysR ? sysWarp(props.scroll - sysR.docTop + props.height, sysR.height, props.height) : 0
        dive.u = rawS > 0 ? U_END + (U_MAX - U_END) * rawS : rawL > 0 ? U_LAB + (U_END - U_LAB) * rawL : raw * U_LAB
        dive.sys = clamp((rawS - 0.3) / 0.7)
        dive.push = ss(0.56, 1.0, dive.sys) // POLISH-2: starts as the parts finish forming (morph ends at 0.56), so the tablet's approach gets more scroll
        // R6.88 SINK (Shifat 10:04–10:05 PM Oct 22), all on the same push (no new scroll): the parts dissolve into falling
        // points (0 → 0.4); the tablet alone sinks SINK_M into the dark, the camera following a beat behind (both reach the
        // full depth at 1, so the hand-off pose is unchanged); the diamond comes to dead centre behind the tablet
        // (0.2 → 0.46) and dissolves the same way (0.44 → 0.7); then the push into the screen carries on as before
        // R6.88b (Shifat 10:41 PM: the tablet waits in the deep): the parts dissolve into falling points (0 → 0.3); the
        // camera sinks SINK_M through darkening water to the tablet waiting there (0.04 → 0.42); the diamond comes down to
        // dead centre behind it (0.3 → 0.48) and dissolves the same way (0.46 → 0.68); then the portal push (PORTAL0 → 1)
        dive.dis = ss(0.0, 0.38, dive.push)   // R6.89 GENTLE: the parts' dissolve runs on through the descent (was 0 → 0.3)
        dive.sink = dive.camSink = SINK_M * sinkK(dive.push)
        // R6.89 (Shifat 5:25 AM "The diamonds can stay at shade ds section & stop moving onwards"): the diamond stays parked
        // in the Shade DS section; it no longer comes down behind the tablet nor dissolves there (the camera sinks away from it)
        dive.gemC = 0
        dive.lock = ss(PORTAL0 - 0.06, PORTAL0 + 0.1, dive.push) // the lens leaves its springs as the portal begins (CameraRig)
        dive.gemDis = 0   // R6.89: parked (see gemC)
        // R6.88 PORTAL: the glide into the sky starts inside the glass as it converges (the push where the display's picture
        // starts converging on the journey's frame, TabletWindow h > 0), linear in scroll (spaceSky.ts GLIDE_PRE)
        GLIDE_PRE.t = clamp((dive.sys - SYS_H) / (1 - SYS_H))
        // R6.89: the portal's stretch keeps its R6.88d scroll length (sysWarp's last segment runs 1:1), so the span is read off
        // that section height, not the longer one
        if (sysR) GLIDE_PRE.span = (1 - SYS_H) * 0.7 * (sysR.height > props.height * 1.5 ? SYS_OLD_VH * props.height : sysR.height) / Math.max(1, props.height)
        dive.abyss = ss(0.96, 1.2, dive.u)
        { const base = 1 + 0.7 * ss(1.02, 1.2, dive.u), c = dive.gemC * dive.gemC * (3 - 2 * dive.gemC)
          dive.gemScale = base + (Math.max(base, dive.gemBig) - base) * c } // R6.88: larger behind the tablet, so it shows around it
        props.dive = dive.u
        // the guide gem: handed from the hero's physics to the dive path as the dive starts; it sinks, then leads
        const vf = vfovFor(divePath(dive.u, gp, gt), 30, 74); underwaterShape(dive.u, gp, gt)  // (path pose without the phone step-back: the stone's place is world-fixed in the deep)
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
    // TEXT GAP (Shifat 18:52Z m:ef4a3572): no words between the hero's name and the work. The tool labels, the
    // "Under the surface" line and its caption are gone; the dive is the world alone (its scroll length is unchanged)
    <section id="dive" className="section dive" ref={ref} aria-label="The dive">
      <div className="sticky dive__inner" />
    </section>
  )
}
