import * as THREE from 'three'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useThree } from '@react-three/fiber'
import { nb, useStageFrame } from '../../systems/neighbour' // NEIGHBOUR HOOK
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { props } from '../../../state/props'
import { input } from '../../../services/input'
import { engine } from '../../engine'
import { settings } from '../../../services/settings'
import { mix, smoothstep as ss } from '../../../core/math'
import { journey } from './journeyState'
import { Crewmate, crewGeometrySteps, CREW_HEIGHT, CREW_CENTER_Y, crewMaterials } from './crewmate'
import { makeEnvsSteps } from './env'
import { buildForestSteps, buildShadows, longShadowGeometry, longShadowMaterial } from './forest'
import { buildSunFan, buildMist, buildMotes } from './forestFx'
import { buildFoliageSteps, GROUND_U } from './foliage' // FOLIAGE HOOK (foliage helper): fluffy grass + trees
import { runToEnd, prewarm, type CompileJob } from '../../prewarm' // PERFGOV
import { buildFireflies, buildCanopy } from './nightFx'
import { buildTunnel, buildTunnelLights } from './tunnel'
import { buildTunnelBlur } from './tunnelBlur' // TUNNEL DRAMA: half-res zoom blur
const OLDT = typeof location !== 'undefined' && /[?&]oldtrans/.test(location.search) // R7.04 QA: ?oldtrans = 7.03 transitions

// R7.05 GROUND: ?oldground = the 7.04 land during the descent (A/B)
const STK_OLD = typeof location !== 'undefined' && /[?&]stkold/.test(location.search) // R7.07 #8 QA: the 7.06 sticker lift-away
const OLD_GROUND = typeof location !== 'undefined' && /[?&]oldground/.test(location.search)
const _tN = new THREE.Color(0.1, 0.17, 0.3), _tD = new THREE.Color(1.0, 0.7, 0.55)
const _hz = new THREE.Color(), _hzA = new THREE.Color(), _hzB = new THREE.Color()
const _ss = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }
/** the inner sky shader's colour just above the horizon (y = 0, away from the sun) as a function of u_atmos, linear */
function horizonColor(a: number, out: THREE.Color) {
  if (a < 0.5) {
    _hzA.setRGB(0.003, 0.0035, 0.009).lerp(_hzB.setRGB(0.033, 0.053, 0.118), _ss(0, 0.22, a))
    return out.copy(_hzA).lerp(_hzB.setRGB(0.926, 0.335, 0.223), _ss(0.22, 0.5, a))
  }
  return out.setRGB(0.926, 0.335, 0.223).lerp(_hzB.setRGB(0.94, 0.497, 0.207), _ss(0.5, 1, a))
}
import { buildCta, WALL_Z } from './ctaScene'
import { screenMaterial, backdropMaterial, SUN_DIR } from './shaders'
const QA_J = typeof location !== 'undefined' && /[?&]qa\b/.test(location.search)
import { buildSpaceSky, SkyExtras, SPACE_LIGHT, starPrFor, isSharedSkyGeometry, JOURNEY_LENS, glideOffset, SPACE_RICH } from './spaceSky' // R6.87 SINGLE SKY
import { buildShatterGeometry, shatterMaterial, buildGlints } from './shatter'
import { inner, outer, T, type Inner, type Outer } from './timeline'
import { journeyAudio, resetJourneyAudio } from './journeyAudio'
import { heroPass } from '../../post/heroPass' // R6.87 SPLIT
import { SPLIT } from '../../quality'
import { CrewLayer } from './crewLayer'
import { audio } from '../../../services/audio' // W29 R6.74: mute the primed cue calls
import { viewport } from '../../../core/viewport'

/** Where the stage lives in the main world (the pool owns the origin). */
export const JOURNEY_ORIGIN = new THREE.Vector3(200, 0, 0)
const SCREEN_Z = 0.29
const OVERSCAN = 1.14

function rectPath<T extends THREE.Path>(s: T, w: number, h: number, r: number) {
  const x = -w / 2, y = -h / 2
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y)
  return s
}
/** the black glass around the screen: a rounded frame with the screen cut out */
function bezelGeometry(w: number, h: number, r: number, sw: number, sh: number) {
  const s = rectPath(new THREE.Shape(), w, h, r)
  s.holes.push(rectPath(new THREE.Path(), sw, sh, 0.06))
  return new THREE.ShapeGeometry(s, 6)
}

/**
 * S6 — Journey. One star per beat: the red crewmate.
 * An inner world (space → forest) renders into a render target that plays on a tablet screen; the main
 * camera starts flush against that screen (the screen *is* the viewport), pulls back to reveal the tablet,
 * and the crewmate breaks out: two hits crack the cover glass, the third shatters it into hundreds of pieces of the
 * picture that fly at the lens in a slow-motion beat (shatter.ts).
 * The stage never renders the main scene and never moves the camera: it writes journey.pose.
 */
const RIM_PX = +(new URLSearchParams(location.search).get('rimpx') ?? 2) || 0   // R6.96: min rim width, background px
const CTA_GLIDE = new URLSearchParams(location.search).has('ctaglide')   // R6.92b: off = the CTA rides up as a sheet

export function JourneyStage(): JSX.Element {
  const { gl } = useThree()
  const [portrait, setPortrait] = useState(() => window.innerHeight > window.innerWidth * 1.05)
  const low = settings.TIER === 'low'
  const S = useMemo(() => takePrebuilt(portrait, low) ?? build(gl, portrait, low), [gl, portrait, low]) // PERFGOV: built behind the preloader
  const group = useRef<THREE.Group>(null!)
  // W18 (Shifat 14:01Z): the CTA odometer type at full device density, drawn by the text layer behind the crewmate's depth
  const { camera: mainCam } = useThree()
  // STICKERS HOOK: drag / peel / keyboard on the CTA wall's stickers (stickerInteract.ts), bound to the real camera
  useEffect(() => { S.cta.attach(mainCam); return () => S.cta.detach() }, [S, mainCam])
  // R6.87 SPLIT RESOLUTION: the crewmate that breaks out is a hero subject (drawn at the canvas density, post/heroPass.ts)
  useEffect(() => { const a = heroPass.add(S.crewOut.root), b = S.crewScreen ? heroPass.add(S.crewScreen) : () => {}
    const c = heroPass.add(S.cta.stickers) // R6.89: the CTA wall's stickers are heroes too (Shifat "same hero dpr")
    return () => { a(); b(); c() } }, [S])
  useEffect(() => {
    S.cta.typeRoot.position.copy(JOURNEY_ORIGIN)
    const body = S.crewOut.root
    // the crewmate's depth only (one cheap override program), so the type sits BEHIND it at full density
    const depthScene = new THREE.Scene()
    depthScene.position.copy(JOURNEY_ORIGIN)
    depthScene.overrideMaterial = new THREE.MeshBasicMaterial({ colorWrite: false })
    const v = new THREE.Vector3()
    const extra = {
      active: () => journey.active && S.cta.type.visible && S.cta.group.visible,
      // the scissor for the full-density pass: the type's box projected to the screen (CSS px), plus a trail margin
      box: () => {
        const r = S.cta.typeRect(), W = props.width, H = props.height
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
        for (let i = 0; i < 4; i++) {
          v.set((i & 1 ? r.x1 : r.x0) + JOURNEY_ORIGIN.x, (i & 2 ? r.y1 : r.y0) + JOURNEY_ORIGIN.y, r.z + JOURNEY_ORIGIN.z).project(mainCam)
          if (v.z > 1) return null
          const sx = (v.x * 0.5 + 0.5) * W, sy = (0.5 - v.y * 0.5) * H
          x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy)
        }
        const m = 28
        return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m }
      },
      draw: (r: THREE.WebGLRenderer) => {
        const parent = body.parent
        if (parent && body.visible) {
          depthScene.add(body); depthScene.updateMatrixWorld(true)
          r.render(depthScene, mainCam)
          parent.add(body); parent.updateMatrixWorld(true)
        }
        S.cta.typeRoot.updateMatrixWorld()
        r.render(S.cta.typeRoot, mainCam)
      },
    }
    const list = (engine as any).chain?.text?.extras as typeof extra[] | undefined
    list?.push(extra)
    // PERFGOV: the CTA type and the crewmate's depth-only pass, compiled behind the preloader into a target like the text layer's
    const off = prewarm.add('journey', () => {
      const rt = engine.chain?.composer.inputBuffer ?? null
      return { jobs: [
        { roots: [S.cta.typeRoot], scene: S.cta.typeRoot as unknown as THREE.Scene, camera: mainCam, target: rt },
        { roots: [S.crewOut.root], scene: depthScene, camera: mainCam, target: rt, override: depthScene.overrideMaterial },
      ] }
    })
    return () => { off(); if (list) { const i = list.indexOf(extra); if (i >= 0) list.splice(i, 1) } }
  }, [S, mainCam])

  useEffect(() => {
    // warm the inner world's programs up front (its lights live in its own scene, so they compile exactly once)
    // PERF HOOK: compiled with the tablet target bound — the inner world only ever draws into it (linear, no tone
    // mapping), and a compile against the screen built variants it never used, so it compiled again on first view
    // PERFGOV: behind the preloader this is done in short steps (prewarm.ts, jobs below); a later re-mount still does it here
    if (!innerWarm.has(S) && !prewarm.active) {
      const prev = gl.getRenderTarget()
      try { gl.setRenderTarget(S.rt); gl.compile(S.inner, S.icam) } catch { /* compile is a warm-up only */ } finally { gl.setRenderTarget(prev) }
    }
    const off = prewarm.add('journey', () => {
      innerWarm.add(S)
      const blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), S.tunnelBlur.material); blurQuad.frustumCulled = false
      const jobs: CompileJob[] = [
        { roots: [S.inner], scene: S.inner, camera: S.icam, target: S.rt, force: S.inner },
        { roots: [blurQuad], scene: new THREE.Scene(), camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), target: S.tunnelBlur.rt },
        ...(S.crewL ? [S.crewL.warmJob()] : []),   // R6.95: the crewmate layer's depth copy (shared program with the tablet's)
      ]
      return { jobs, targets: [S.rt, S.tunnelBlur.rt], steps: (function* () { yield; prebuildShards(S, gl, portrait) })() }
    })
    return () => { off(); S.dispose() }
  }, [S, gl])

  useStageFrame('journey', (state) => {
    ;(window as any).__scene = state.scene // QA
    const g = group.current
    if (!journey.active) {
      if (g.visible) { g.visible = false; if (!nb.active) { resetJourneyAudio(); journey.beat = -1 } } // NEIGHBOUR HOOK: no audio from the neighbour pass
      S.lastP = -1
      return
    }
    const W = state.size.width, H = state.size.height
    const wantPortrait = H > W * 1.05
    if (wantPortrait !== portrait) { if (!nb.active) setPortrait(wantPortrait); return }
    g.visible = true
    const p = props.journey, dt = Math.min(props.dt, 1 / 20), time = props.time
    const snap = journey.snap || S.lastP < 0 || Math.abs(p - S.lastP) > 0.06
    journey.snap = false
    const prevP = S.lastP
    S.lastP = p
    if (!nb.active) {
      // W29 R6.74 (Shifat "Glass sound has bugs?"): journeyAudio.ts is locked, and it fires a beat's cue on ANY change of
      // beat. So (a) landing mid-journey cold (a jump, a re-entry after the stage hid) fired the cue of wherever you landed:
      // a shatter with no break on screen; (b) scrolling back UP out of the bloop beat into the break beat shattered again.
      // Those two calls now run with the cues muted, so the beat is primed silently and the glass only sounds on the
      // forward crossing into the break. Entering from the top (beat 0) still plays the space hum. Edges: journeyAudio EDGES/HYST.
      const prev = journey.beat
      const mute = (prev < 0 && p >= 0.24) || (prev === 5 && p < 0.9 - 0.012)
      const was = audio.enabled
      if (mute) audio.enabled = false
      journey.beat = journeyAudio(p) // NEIGHBOUR HOOK: the soundtrack follows the live section only
      if (mute) audio.enabled = was
    }

    // ---- inner world
    const I = inner(p, S.I, portrait)
    S.crewIn.root.visible = I.visible
    S.crewIn.update({ pos: I.crew, yaw: I.yaw, pitch: I.pitch, roll: I.roll, walk: I.walk, phase: I.phase, float: I.float, squash: I.squash, scale: 1 }, dt, time, snap)
    S.icam.position.copy(I.cam)
    // R6.87 GENTLE DIVE: the push carries on into the sky through the hand-off (spaceSky.ts glideOffset; 0 once inside)
    if (p <= 0.0001) S.icam.position.add(glideOffset(portrait, W, H, S.tmp))
    S.icam.lookAt(I.look)
    ;(window as any).__jI = S.icam // QA (R6.88b switch probe)
    // ultrawide: the screen covers the viewport, so its top and bottom crop away; widen the inner lens by the same
    // amount so the 16:10 composition (feet, horizon, lead room) survives at 21:9
    const wideK = portrait ? 1 : Math.max(1, (W / H) / 1.6)
    const fovIn = (f: number) => THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(f) / 2) * wideK))
    const fI = fovIn(I.fov)
    if (Math.abs(S.icam.fov - fI) > 1e-3) { S.icam.fov = fI; S.icam.updateProjectionMatrix() }
    S.lightRig.position.copy(I.crew)
    S.sky.position.copy(S.icam.position); S.stars.position.copy(S.icam.position)
    S.skyMat.uniforms.u_atmos.value = I.atmos; S.skyMat.uniforms.u_time.value = time
    if (QA_J && !(window as any).__jS) (window as any).__jS = S // QA (?qa): the journey stage's parts
    S.skyMat.uniforms.u_rich.value = SPACE_RICH // R7.01 RICH: space keeps the tablet picture's colour (spaceSky.ts)
    S.starMat.uniforms.u_opacity.value = I.stars; S.starMat.uniforms.u_time.value = time
    S.glintMat.uniforms.u_opacity.value = I.stars; S.glintMat.uniforms.u_time.value = time
    S.stars.visible = I.stars > 0.001
    // R6.87 SINGLE SKY: the rocks + dust the glass showed, where it showed them, on the same clock; they leave with space
    // (gone before the tunnel opens at 0.12)
    S.skyExtras.layout(portrait, W, H)
    S.skyExtras.update(time, I.stars * (1 - ss(0.07, 0.115, p)), rtPerCss(S, W, H) * Math.min(Math.max(props.dpr || 1, 0.6), 2))
    props.bgCeil = props.stage === 'journey' ? Math.round(Math.max(0.75, rtPerCss(S, W, H) * 1.25) * 20) / 20 : 0   // R7.00 PHONE SHARP: the journey's world is its own 512 target
    // R6.97 TRANSITIONS: the forest switched on at atmos 0.2, a few frames after the bore had gone, so the ground popped
    // into the night sky. It now waits under the closing tunnel and is already there when the view clears.
    S.forest.visible = I.atmos > 0.1
    // forest air: grass sway, the sun fan behind the tree line, mist veils and pollen once we are near the ground
    const land = ss(0.42, 0.52, p)
    S.grass.material.uniforms.u_time.value = time
    S.fan.material.uniforms.u_time.value = time; S.fan.material.uniforms.u_opacity.value = ss(0.3, 0.5, I.atmos) * mix(0.55, 1, land)
    S.fan.mesh.visible = I.atmos > 0.3
    S.fan.mesh.position.copy(S.icam.position).addScaledVector(SUN_DIR, 260); S.fan.mesh.position.y = Math.max(S.fan.mesh.position.y, 16)
    S.fan.mesh.scale.setScalar(300); S.fan.mesh.lookAt(S.icam.position)
    for (const m of S.mist.mats) { m.uniforms.u_time.value = time; m.uniforms.u_opacity.value = land }
    S.mist.group.visible = land > 0.01
    S.treeRim.value = 0.3 * ss(0.3, 0.6, I.atmos)
    S.foliage.update(time, S.treeRim.value, I.crew) // FOLIAGE HOOK (foliage helper)
    S.motes.material.uniforms.u_time.value = time; S.motes.material.uniforms.u_opacity.value = land
    S.motes.points.visible = land > 0.01
    // W18 (Shifat 14:25Z): the TUNNEL between the starry sky and the night sky over the forest (journey 0.12 → 0.31)
    {
      const u = Math.min(1, Math.max(0, (p - 0.12) / 0.19))
      const tu = S.tunnel.material.uniforms
      const inn = ss(0.0, OLDT ? 0.2 : 0.34, u), out = 1 - ss(0.8, 1.0, u) // R7.04: the bore opened over ~250 px (dark → full glow in 2 phone notches); now ~1.7x longer
      tu.u_on.value = Math.min(inn, out)
      tu.u_stretch.value = Math.min(ss(0.0, OLDT ? 0.28 : 0.4, u), 1 - ss(0.74, 1.0, u))  // stars stretch into streaks, then back to points
      tu.u_travel.value = u * 900 + time * 6                                     // the rush is the scroll; a slow shimmer on top
      tu.u_phase.value = u * 5.0; tu.u_bend.value = 0.6 + 0.4 * Math.sin(u * Math.PI)
      tu.u_exit.value = ss(0.6, 1.0, u); tu.u_time.value = time
      // TUNNEL DRAMA (Shifat Oct 21 12:44Z): the RUSH is the scroll speed (smoothed, 0..1; a brisk notch reads ~1), and it
      // drives the streak stretch, the zoom blur and the chromatic split; the hue drifts down the bore; the rings pulse
      // with the travel; a warp flash on the way in and on the way out. All scroll-driven, reversible, no clock state
      // beyond one smoothed number (no per-frame allocations).
      const vel = snap ? 0 : Math.abs(p - prevP) / Math.max(dt, 1e-3)
      S.rush += (Math.min(1, vel / 0.09) - S.rush) * (1 - Math.exp(-dt / 0.12))
      tu.u_rush.value = S.rush
      tu.u_hue.value = u * 0.9 + time * 0.01
      tu.u_pulse.value = 0.6 + 0.4 * Math.sin(tu.u_travel.value * 0.15)
      const vis = u > 0 && u < 1
      S.tunnel.mesh.visible = vis; S.tunnelLights.orbs.visible = vis; S.tunnelLights.rings.visible = vis
      if (vis) {
        S.tunnel.mesh.position.copy(S.icam.position); S.tunnel.mesh.quaternion.copy(S.icam.quaternion)
        S.tunnelLights.orbs.position.copy(S.icam.position); S.tunnelLights.orbs.quaternion.copy(S.icam.quaternion)
        S.tunnelLights.rings.position.copy(S.icam.position); S.tunnelLights.rings.quaternion.copy(S.icam.quaternion)
      }
      // R6.97 TRANSITIONS: the warp flashes were symmetric 0.03/0.04-wide spikes, gated off the moment the bore closed, so on
      // a phone fling they strobed for 1–2 frames and the exit cut from a grey wash straight to the black night sky. Now each
      // rises the way it did but eases out more slowly; the exit's tail runs on past the bore (u > 1) and melts into the sky.
      // R6.98: the exit tail is shorter (0.07, was 0.11): still no cut to the sky, but the night sky's contrast is back sooner
      const ur = (p - 0.12) / 0.19
      // R7.04: the in-flash rose over ~45 px (a strobe on a fling); it rises over ~85 px now, a beat later
      const fIn = (ur - (OLDT ? 0.07 : 0.1)) / (ur < (OLDT ? 0.07 : 0.1) ? (OLDT ? 0.035 : 0.065) : 0.06), fOut = (ur - 0.9) / (ur < 0.9 ? 0.04 : 0.07)
      const flash = (ur > -0.2 && ur < 1.4) ? Math.exp(-fIn * fIn) * 0.32 + Math.exp(-fOut * fOut) * 0.28 : 0
      S.tunnelFx.zoom = vis ? tu.u_stretch.value * tu.u_on.value * (0.35 + 0.65 * S.rush) + flash * 0.6 : 0
      S.tunnelFx.chroma = vis ? 0.028 * tu.u_stretch.value * (0.25 + 0.75 * S.rush) + flash * 0.03 : 0
      S.tunnelFx.flash = flash
      // the vanishing point: where the bent bore goes at mid-depth, projected into the screen picture's uv
      const dd = 0.7, bendK = tu.u_bend.value * dd * 0.12 / Math.tan((S.icam.fov * Math.PI) / 360)
      S.tunnelFx.cx = 0.5 + 0.5 * Math.sin(tu.u_phase.value + dd * 2.2) * bendK / S.icam.aspect
      S.tunnelFx.cy = 0.5 + 0.5 * Math.cos(tu.u_phase.value * 0.7 + dd * 1.7) * 0.6 * bendK
    }
    // W18 (13:24Z): stars → fireflies, then the fall through the canopy
    {
      const fu = S.fireflies.material.uniforms
      fu.u_time.value = time; fu.u_px.value = S.rt.height; fu.u_day.value = ss(0.5, 0.9, I.atmos)
      fu.u_on.value = ss(0.26, 0.36, p) * mix(1, 0.45, ss(0.5, 0.62, p)) * (1 - ss(0.74, 0.8, p))
      S.fireflies.points.visible = fu.u_on.value > 0.002
      const cu = S.canopy.material.uniforms
      cu.u_time.value = time; cu.u_on.value = ss(0.3, 0.35, p) * (1 - ss(0.455, 0.49, p))
      S.canopy.mesh.visible = cu.u_on.value > 0.002
    }
    const h = Math.max(0, I.crew.y)
    // long shadow from the feet, cast towards the camera by the low sun behind the clearing
    S.shadow.position.set(I.crew.x, 0.04, I.crew.z - 0.25)
    S.shadow.rotation.y = Math.atan2(-SUN_DIR.x, -SUN_DIR.z)
    S.shadowMat.uniforms.u_opacity.value = I.shadow * Math.exp(-h * 0.6) * 1.6 * (I.visible ? 1 : 0)
    S.shadow.scale.set(1.15 + h * 0.1, 1, 4.2)
    // light + haze follow the atmosphere: violet/teal rim in space → warm sun and green bounce in the forest
    const a = I.atmos
    S.hemi.color.copy(S.c.hSpace).lerp(S.c.hSky, a); S.hemi.groundColor.copy(S.c.gSpace).lerp(S.c.gForest, a)
    S.hemi.intensity = mix(SPACE_LIGHT.hemi, 0.8, a)
    S.sun.color.copy(S.c.kSpace).lerp(S.c.kSun, a); S.sun.intensity = mix(SPACE_LIGHT.keyI, 1.7, a)
    S.sun.position.set(mix(5, 3, a), mix(6, 3, a), 6)
    S.rim.color.copy(S.c.rSpace).lerp(S.c.rSun, a); S.rim.intensity = mix(SPACE_LIGHT.rimI, 3.0, a)
    S.rim.position.set(mix(-6, SUN_DIR.x * 10, a), mix(3, 1.2, a), mix(-7, SUN_DIR.z * 10, a))
    const fog = S.inner.fog as THREE.Fog
    fog.color.copy(S.c.fogDusk).lerp(S.c.fogDay, ss(0.55, 1, a))
    if (!OLD_GROUND) {
      // R7.05 GROUND: the haze is the sky's own horizon colour through night and dusk (inner sky shader at y = 0), and
      // eases into the old day haze before touchdown, so the land meets the sky without a line and the forest is unchanged
      horizonColor(a, _hz)
      fog.color.copy(_hz).lerp(S.c.fogDay, ss(0.72, 1, a))
      GROUND_U.u_high.value = ss(1.5, 9, I.crew.y) * (I.visible ? 1 : 0)
      GROUND_U.u_tint.value.copy(_tN).lerp(_tD, ss(0.18, 0.45, a)).lerp(_hzA.setRGB(1, 1, 1), ss(0.6, 0.9, a))
    }
    fog.near = mix(20, 60, a); fog.far = mix(220, 380, a)
    const env = a > 0.5 ? S.envs.forest : S.envs.space
    if (S.innerMats.body.envMap !== env) S.innerMats.body.envMap = env
    // the visor: studio highlights in space, the sky (blue over amber over green) once it is in the forest
    const venv = a > 0.5 ? S.envs.forest : S.envs.page
    if (S.innerMats.visor.envMap !== venv) S.innerMats.visor.envMap = venv
    // the visor catches a little more sky as it lands
    S.innerMats.visor.envMapIntensity = mix(SPACE_LIGHT.visorEnv, 1.2, a)
    S.innerMats.body.envMapIntensity = mix(SPACE_LIGHT.bodyEnv, 0.25, a)

    // ---- outer world (local to the tablet)
    const aspect = W / H
    const vh = (d: number) => 2 * d * Math.tan(THREE.MathUtils.degToRad(35) / 2)
    const fillH = Math.min(S.sh / OVERSCAN, S.sw / (OVERSCAN * aspect))
    const needH = Math.max((S.sh + 1) * 1.75, ((S.sw + 1) * 1.45) / aspect)
    const fit = { dFill: fillH / vh(1), dFar: needH / vh(1), lateral: aspect > 1.1 ? S.sw * 0.16 : 0 }
    // where the inner crewmate sits on the glass at the moment of the break (same pose, so the hand-off is seamless)
    const start = breakStart(S, portrait, fovIn)
    const O = outer(p, S.O, fit, start, SCREEN_Z, farCorner(S.sw, S.sh, start.x, start.y))
    let shardOut = 0
    // ---- W18 THE ENDING (STRUCTURE v3 13:27Z–13:33Z): glide down past the tablet with the crewmate alongside into the
    // aligned CTA on the black wall (ctaScene.ts). g: a first touch of the glide as the crewmate floats free, the rest
    // over the CTA section's arrival (journey.cta 0 → 1). Pure functions of scroll: reversible, never frozen.
    {
      const key = `${aspect.toFixed(3)}|${portrait}`
      if (key !== S.ctaKey || S.cta.dirty) { S.ctaKey = key; S.cta.layout(S.sw, S.sh, aspect, CREW_HEIGHT) }
      const L = S.cta.lay
      const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
      const cta = Math.min(1, Math.max(0, journey.cta))
      const g = 0.16 * ease(Math.min(1, Math.max(0, (p - 0.88) / 0.12))) + 0.84 * ease(cta)
      journey.ctaTime += dt
      if (g > 0) {
        const k = S.tmp.set(L.C.x, L.C.y, L.C.z + L.D)
        // cursor / tilt parallax: the camera drifts, the aim stays on the wall's centre, so the three planes separate
        S.par.lerp(input.isTouch ? S.par.set(0, 0) : input.mouseXY, 1 - Math.exp(-dt * 3))
        const mx = S.par.x * g, my = S.par.y * g
        k.x += mx * L.wv * 0.035; k.y += my * L.hw * 0.03
        O.camPos.lerp(k, g)
        O.camPos.z += Math.sin(Math.PI * g) * L.D * 0.08                       // a breath of pull-back mid-glide
        O.camTarget.lerp(L.C, g)
        O.fov = mix(O.fov, L.fov, g)
        // the crewmate flies alongside, a little ahead of the camera, swooping out and back in
        const gc = Math.pow(g, 0.8)
        S.tmp2.set(L.C.x + Math.sin(Math.PI * gc) * S.sw * 0.12, L.crewY + Math.sin(journey.ctaTime * 0.9) * 0.06 * L.crewScale, L.crewZ)
        O.crew.lerp(S.tmp2, gc)
        O.crewScale = mix(O.crewScale, L.crewScale, gc)
        O.yaw = mix(O.yaw, Math.sin(journey.ctaTime * 0.35) * 0.2 - 0.25 * Math.sin(Math.PI * gc), gc)
        O.pitch = mix(O.pitch, 0.05, gc)
        O.roll = mix(O.roll, Math.sin(journey.ctaTime * 0.27) * 0.06 + 0.22 * Math.sin(Math.PI * gc), gc)
        O.float = 1
        shardOut = Math.min(1, Math.max(0, (g - 0.16) / 0.14)); shardOut = shardOut * shardOut * (3 - 2 * shardOut)
        if (g > 0.3) O.shardsVisible = false
        journey.crew.set(O.crew.x + JOURNEY_ORIGIN.x, O.crew.y, O.crew.z)
        journey.crewScale = O.crewScale
      }
      // R6.89 FOOTER (Shifat 3:43 AM "When reaching footer the [crewmate] model & [big CTA] text must not animate mask out";
      // 3:57 AM option C): as the curtain lifts over the footer, the big type and the crewmate glide up together and settle
      // fully visible above it, easing to ~85 % size, instead of riding off the top (the crewmate used to be cut there) or
      // rolling out. The post chain shifts the whole picture up by the lift; this moves the two of them against that shift
      // so their on-screen path is a straight glide from where they hold to where they settle. Pure function of scroll.
      {
        const fh = journey.footH, lift = Math.max(0, journey.lift || 0), H = Math.max(1, props.height)
        // R6.92b (Shifat Oct 23 9:03 AM, from the desktop video: the CTA shrank to ~40 % and lifted as the footer revealed —
        // "looks bad"; 9:58 AM option B): full size, NO scale ever, a translate-only settle. The type and the crewmate ride up
        // 1:1 with the page as the footer starts to show, then ease to rest where both stay in frame at full reveal (the type
        // under the header, the crewmate above the button; where the two cannot both fit above the footer the type keeps its
        // place under the header and the feet go behind the curtain). One cubic of scroll: starts at the page's own speed,
        // lands with zero speed, never overshoots. ?ctaglide brings back the R6.89 option-C settle (with its scale).
        const ft = fh > 0 && g > 0.999 ? Math.min(1, lift / fh) : 0; (window as any).__ctaFt = ft
        if (ft > 0) {
          const tanH = Math.tan((O.fov * Math.PI) / 360), cz = O.camPos.z, cy = O.camPos.y
          const hAt = (z: number) => 2 * Math.max(0.01, cz - z) * tanH                 // world units per screen height at depth z
          const fr = (y: number, z: number) => 0.5 - (y - cy) / hAt(z)                // screen fraction from the top
          const A = S.cta.typeAnchor()
          const top0 = fr(A.top, A.z), feetY = L.crewY - CREW_CENTER_Y * L.crewScale, bot0 = fr(feetY, L.crewZ)
          // R6.89: the heroes settle above the CTA button, which lifts off the footer with the page
          const edge = (Math.min(H, viewport.vis || H) - fh) / H, bot1 = edge - Math.max(0.06, ((journey.pillRes || 0) + 6) / H), span = Math.max(0.05, bot0 - top0)
          const hdr = CTA_GLIDE ? (H > props.width ? 0.12 : 0.095) : (H > props.width ? 0.085 : 0.075)   // R6.92b B: the type may sit closer under the header (full size)
          let s: number, top1: number
          if (CTA_GLIDE) { s = Math.min(0.85, (bot1 - hdr) / span); top1 = bot1 - s * span }   // R6.89: clear air under the header too
          else { s = 1; top1 = Math.max(hdr, Math.min(top0, bot1 - span)) }
          const lf = lift / H, sc = 1 + ft * (s - 1)
          let dFrac: (y0: number) => number
          if (CTA_GLIDE) {
            // a point at screen fraction y0 (curtain down) is shown at y0 + ft (m(y0) − y0); the chain then lifts it by lf
            dFrac = (y0: number) => ft * (top1 + s * (y0 - top0) - y0) + lf
          } else {
            // on screen every point moves by off(ft) (down +); the chain lifts the picture by lf, so the stage adds off + lf
            const T = top1 - top0, FH = fh / H
            let off: number
            if (T > -1e-4) off = 0
            else { const k = Math.min(2.5, FH / -T); off = T * (k * ft + (3 - 2 * k) * ft * ft + (k - 2) * ft * ft * ft) }
            dFrac = () => off + lf
          }
          const ty0 = fr(A.y, A.z)
          // the stickers ride the curtain and lift on away past the top (the lower pair would otherwise end under the type)
          S.cta.setFoot(-dFrac(ty0) * hAt(A.z), sc, ft, (STK_OLD ? 0.8 : 0.3) * ft * hAt(WALL_Z), STK_OLD ? 0 : Math.min(1, ft / 0.45))   // R7.07 #8: a gentler lift; the stickers particle-morph out over the first 45 % of the footer (?stkold = 7.06)   // R6.89: far enough that no sticker edge is left at the top (1440 check)
          const cy0 = fr(O.crew.y, O.crew.z)
          O.crew.y -= dFrac(cy0) * hAt(O.crew.z)
          O.crewScale *= sc
          journey.crew.set(O.crew.x + JOURNEY_ORIGIN.x, O.crew.y, O.crew.z); journey.crewScale = O.crewScale
        } else S.cta.setFoot(0, 1, 0)
      }
      S.rimU.u_rim.value = 0.55 * ss(0.3, 0.9, g)
      S.cta.update(time, cta, O.camPos, p > 0.55); (window as any).__ctaDbg = { p, cta, ft: (window as any).__ctaFt }
    }
    journey.pose.pos.copy(O.camPos).add(JOURNEY_ORIGIN)
    journey.pose.target.copy(O.camTarget).add(JOURNEY_ORIGIN)
    journey.pose.fov = O.fov

    // R6.96 RIM LINE: keep the metal rim at least RIM_PX background pixels wide (0 on sharp tiers; ?rimpx=0 turns it off)
    if (RIM_PX > 0) {
      const pxu = screenPx(S, state.camera as THREE.PerspectiveCamera, W, H) / S.sh * Math.max(0.25, props.dpr || 1)
      S.bezelU.u_bezelInset.value = Math.min(0.06, Math.max(0, RIM_PX / pxu - 0.04))
    }
    const su = S.screenMat.uniforms
    su.u_bulge.value = O.bulge; su.u_width.value = O.width; su.u_center.value.copy(O.center)
    su.u_ringT.value = O.ringT; su.u_ringAmp.value = O.ringAmp; su.u_bright.value = O.screenBright
    su.u_time.value = time; su.u_gloss.value = O.gloss
    su.u_zoom.value = S.tunnelFx.zoom; su.u_chroma.value = S.tunnelFx.chroma; su.u_flash.value = S.tunnelFx.flash
    su.u_zoomC.value.set(S.tunnelFx.cx, S.tunnelFx.cy)
    S.backdropMat.uniforms.u_amount.value = O.gloss
    // the backdrop always sits square behind what the REAL camera looks at (the rig damps toward journey.pose, so on
    // the pull-back and on a fast scroll it lags O.camPos; a plane aimed at O.camPos was seen at an angle and its edge
    // showed as a slanted seam with the grey page field beside the tablet), and it always overfills the frustum
    {
      const cam = state.camera as THREE.PerspectiveCamera
      const camL = S.tmp.copy(cam.position).sub(JOURNEY_ORIGIN)
      const fwd = cam.getWorldDirection(S.tmp2)
      const D = Math.max(1, camL.distanceTo(O.camTarget)) + 55
      S.backdrop.position.copy(camL).addScaledVector(fwd, D)
      S.backdrop.lookAt(cam.position) // Object3D.lookAt takes a WORLD point (the group sits at JOURNEY_ORIGIN; aiming at
      // the local camL turned the plane ~70° away, which was the real cause of the seam)
      const hh = D * Math.tan(((cam.fov || O.fov) * Math.PI) / 360), asp = Math.max(1, props.width / Math.max(1, props.height))
      S.backdrop.scale.setScalar(Math.max(1, (hh * 2.4) / 80, (hh * asp * 2.4) / 130))
    }
    S.crewOut.root.visible = O.crewVisible
    if (O.crewVisible) {
      // center → feet: the rig's origin is between the feet
      S.tmp.copy(O.crew); S.tmp.y -= CREW_CENTER_Y * O.crewScale
      S.crewOut.update({ pos: S.tmp, yaw: O.yaw, pitch: O.pitch, roll: O.roll, walk: 0, phase: 0, float: O.float, squash: 0, scale: O.crewScale }, dt, time, snap || p - T.BREAK < 0.004)
    }
    // ---- the glass: cracks, then the burst (built for the current impact point; rebuilt only if a resize moves it)
    const far = farCorner(S.sw, S.sh, start.x, start.y)
    S.shards.visible = O.shardsVisible
    if (O.shardsVisible || p > 0.7) {
      ensureShards(S, start)
    }
    if (O.shardsVisible) {
      const u = S.shardMat.uniforms
      u.u_t.value = O.shatterT; u.u_crackR.value = O.crackR; u.u_ringR.value = O.ringR; u.u_frost.value = O.frost; u.u_tilt.value = O.tilt
      u.u_hole.value = O.hole; u.u_k.value = start.k; u.u_impact.value.set(start.x, start.y); u.u_time.value = time
      u.u_bright.value = O.bright; u.u_gloss.value = O.gloss; u.u_out.value = shardOut
    }
    S.glints.points.visible = O.shatterT > 0 && O.shatterT < 4
    if (S.glints.points.visible) {
      const g = S.glints.material.uniforms
      g.u_t.value = O.shatterT; g.u_impact.value.set(start.x, start.y, SCREEN_Z + 0.05); g.u_k.value = start.k; g.u_time.value = time
      g.u_scale.value = Math.min(W, H) / 900
    }

    // ---- render the inner world into the screen texture (offscreen only; the main frame is the post chain's)
    // POLISH (perf cross-lane A): once the CTA holds (journey.cta = 1) the camera rests on the wall, past the tablet: the
    // screen and its shards are out of frame, so the inner world (forest + 100k blades) is not drawn there
    if (journey.cta < 0.999) {
      const prev = gl.getRenderTarget()
      gl.setRenderTarget(S.rt)
      gl.clear()
      // R6.87 SPLIT: until the glass cracks the crewmate is drawn at the canvas density (crewLayer.ts), not in this target
      const split = !!S.crewL && S.crewIn.root.visible && p < T.HIT1 - 0.0015
      if (split) S.crewIn.root.visible = false
      gl.render(S.inner, S.icam)
      if (split) S.crewIn.root.visible = true
      if (split && S.crewL) {
        const ph = screenPx(S, state.camera as THREE.PerspectiveCamera, W, H)
        const hd = (props.heroDpr || props.textDpr || 1) * (nb.active ? nb.scale : 1)   // R6.89: hero density
        let ch = Math.min(H * 1.2, ph) * hd, cw = ch * (S.sw / S.sh)
        const lim = Math.max(W, H) * 1.25 * (props.heroDpr || props.textDpr || 1)
        if (Math.max(cw, ch) > lim) { const k = lim / Math.max(cw, ch); cw *= k; ch *= k }
        S.crewL.render(gl, S.inner, S.icam, S.crewIn.root, S.rt, S.one, cw, ch)
        ;(S.screenMat.uniforms.u_crewScale.value as THREE.Vector2).copy(S.crewL.scale)
        gl.setRenderTarget(S.rt)
      }
      if (S.crewScreen) S.crewScreen.visible = split
      // TUNNEL DRAMA: the half-res zoom blur of that picture, only while the tunnel wants it (tunnelBlur.ts)
      if (S.tunnelFx.zoom > 0.005) {
        const bu = S.tunnelBlur.material.uniforms
        bu.u_amt.value = 0.3 * Math.min(1, S.tunnelFx.zoom); bu.u_c.value.set(S.tunnelFx.cx, S.tunnelFx.cy)
        S.tunnelBlur.render(gl)
      }
      gl.setRenderTarget(prev)
    }
  }, group)

  return (
    <group ref={group} position={JOURNEY_ORIGIN} visible={false}>
      <primitive object={S.outer} />
    </group>
  )
}

/** R6.87: the screen's height on screen (CSS px), from its corners through the real camera */
const _sp = new THREE.Vector3()
function screenPx(S: Built, cam: THREE.PerspectiveCamera, W: number, H: number) {
  S.screen.updateWorldMatrix(true, false)
  let y0 = 1e9, y1 = -1e9
  for (let i = 0; i < 4; i++) {
    _sp.set((i & 1 ? 0.5 : -0.5) * S.sw, (i & 2 ? 0.5 : -0.5) * S.sh, 0).applyMatrix4(S.screen.matrixWorld).project(cam)
    if (_sp.z > 1) return H * 1.2
    y0 = Math.min(y0, _sp.y); y1 = Math.max(y1, _sp.y)
  }
  return Math.max(16, (y1 - y0) * 0.5 * H)
}
/** R6.87: the inner target's pixels per CSS px of the screen as it covers the viewport (the glass's dust uses the same rule) */
function rtPerCss(S: Built, W: number, H: number) {
  const fillH = Math.min(S.sh / JOURNEY_LENS.crop, S.sw / (JOURNEY_LENS.crop * (W / Math.max(1, H))))
  return S.rt.height * (fillH / S.sh) / Math.max(1, H)
}
/** every material under an object (the crewmate's depth pre-pass toggles their colour writes) */
function crewMatsOf(root: THREE.Object3D) {
  const out = new Set<THREE.Material>()
  root.traverse((o: any) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: THREE.Material) => out.add(m)) })
  return [...out]
}

/** PERF HOOK: the furthest screen corner from a point, without the per-frame array spread/map garbage */
/** where the inner crewmate sits on the glass at the moment of the break, in screen units (the shatter's impact) */
function breakStart(S: Built, portrait: boolean, fovIn: (f: number) => number) {
  const B = inner(T.BREAK, S.IB, portrait)
  const proj = S.tmp.set(B.crew.x, B.crew.y + CREW_CENTER_Y, B.crew.z)
  S.bcam.position.copy(B.cam); S.bcam.fov = fovIn(B.fov); S.bcam.updateProjectionMatrix(); S.bcam.lookAt(B.look); S.bcam.updateMatrixWorld()
  const top = S.tmp2.set(B.crew.x, B.crew.y + CREW_HEIGHT, B.crew.z).project(S.bcam)
  proj.project(S.bcam)
  return { x: proj.x * S.sw / 2, y: proj.y * S.sh / 2, k: Math.max(0.6, (top.y - proj.y) * S.sh / 2 / (CREW_HEIGHT - CREW_CENTER_Y)) }
}
/** the burst's geometry for this impact (rebuilt only if a resize moves it) */
function ensureShards(S: Built, start: { x: number; y: number; k: number }) {
  const key = `${start.x.toFixed(1)},${start.y.toFixed(1)},${start.k.toFixed(1)}`
  if (key !== S.shardKey) {
    S.shards.geometry.dispose()
    S.shards.geometry = buildShatterGeometry({ sw: S.sw, sh: S.sh, impact: new THREE.Vector2(start.x, start.y), k: start.k, tier: S.tier }).geometry
    S.shardKey = key
  }
}
/** PERFGOV: the shatter built behind the preloader for the current viewport (it was a ~240 ms task at 6x on the way in) */
function prebuildShards(S: Built, gl: THREE.WebGLRenderer, portrait: boolean) {
  const v = gl.getSize(new THREE.Vector2())
  const wideK = portrait ? 1 : Math.max(1, (v.x / v.y) / 1.6)
  const fovIn = (f: number) => THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(f) / 2) * wideK))
  ensureShards(S, breakStart(S, portrait, fovIn))
}
function farCorner(sw: number, sh: number, x: number, y: number) {
  const hx = sw / 2, hy = sh / 2
  return Math.max(Math.hypot(-hx - x, -hy - y), Math.hypot(hx - x, -hy - y), Math.hypot(-hx - x, hy - y), Math.hypot(hx - x, hy - y))
}

type Built = ReturnType<typeof build>
/** PERFGOV: the build as steps, spread over frames behind the preloader (prebuildJourney); run in one go it is the
 *  same build as before (same order, same random streams) */
function build(gl: THREE.WebGLRenderer, portrait: boolean, low: boolean) { return runToEnd(buildSteps(gl, portrait, low)) }
let prebuilt: { key: string; S: Built } | null = null
/** PERFGOV: build the stage ahead of its mount (behind the odometer); the mount then takes it instead of building */
export function* prebuildJourney(gl: THREE.WebGLRenderer) {
  const portrait = window.innerHeight > window.innerWidth * 1.05, low = settings.TIER === 'low'
  const S = yield* buildSteps(gl, portrait, low)
  prebuilt = { key: `${portrait}|${low}`, S }
}
function takePrebuilt(portrait: boolean, low: boolean) {
  const p = prebuilt
  if (!p || p.key !== `${portrait}|${low}`) return null
  prebuilt = null
  return p.S
}
const innerWarm = new WeakSet<object>() // PERFGOV: inner worlds already compiled behind the preloader
export function* buildSteps(gl: THREE.WebGLRenderer, portrait: boolean, low: boolean) {
  const sw = portrait ? 8.8 : 12.8, sh = portrait ? 12.8 : 8.8
  const long = low ? 512 : 1024 // the long side; the screen's aspect sets the other
  const rt = new THREE.WebGLRenderTarget(portrait ? Math.round(long * sw / sh) : long, portrait ? long : Math.round(long * sh / sw), {
    type: THREE.HalfFloatType, samples: 0 /* PERF HOOK: no MSAA anywhere (SMAA on the final frame covers the tablet) */, depthBuffer: true, generateMipmaps: false,
  })
  const envs = yield* makeEnvsSteps(gl) // R6.77: each environment's PMREM one GPU pass per step
  yield // PERFGOV

  // ===== inner world
  const innerScene = new THREE.Scene()
  innerScene.fog = new THREE.Fog('#e9c9a8', 40, 230)
  const icam = new THREE.PerspectiveCamera(42, sw / sh, 0.1, 2000)
  const bcam = icam.clone()
  // R6.87 SINGLE SKY: the dome, the 6500 stars + band, the 12 glints (the very buffers the dive tablet's glass draws), and
  // the sky's rocks + dust, from spaceSky.ts — one sky, seen through the glass and then flown into
  const SK = buildSpaceSky(starPrFor(rt.width, props.dpr))
  const { sky, skyMat, stars, starMat, glintMat } = SK
  const skyExtras = new SkyExtras()
  yield // PERFGOV

  // Lambert: matte foliage with no grazing sheen against the low sun (and cheaper on phones)
  const forestMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  // backlit canopy: the low sun sits behind the clearing, so every silhouette edge catches a warm rim
  const treeRim = { value: 0 }, treeRimCol = { value: new THREE.Color('#ffc58a') }
  forestMat.onBeforeCompile = (sh) => {
    sh.uniforms.u_rim = treeRim; sh.uniforms.u_rimCol = treeRimCol
    sh.fragmentShader = 'uniform float u_rim; uniform vec3 u_rimCol;\n' + sh.fragmentShader.replace('#include <opaque_fragment>',
      'float rimF = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 6.0);\n  outgoingLight += u_rimCol * rimF * u_rim;\n' +
      // leaf translucency: with the low sun behind the canopy, light scatters through the foliage edges (tinted by
      // the leaf colour, so trunks barely glow) — the soft gold-green backlight of a stylised forest
      '  #if NUM_DIR_LIGHTS > 0\n  { vec3 Lv = directionalLights[0].direction; vec3 Vv = normalize(vViewPosition);\n' +
      '    float back = pow(clamp(dot(-Lv, Vv), 0.0, 1.0), 3.0);\n    float edge = 0.35 + 0.65 * pow(1.0 - abs(dot(normal, Vv)), 1.5);\n' +
      '    float wrap = clamp(dot(normal, Lv) * 0.5 + 0.5, 0.0, 1.0);\n' +
      '    outgoingLight += diffuseColor.rgb * u_rimCol * (back * edge * 0.9 + wrap * 0.1) * u_rim; }\n  #endif\n  #include <opaque_fragment>')
  }
  // the ground is smooth (the grass carries the texture); the trees are soft stylised foliage (forest.ts)
  const groundMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  // R7.05 GROUND (Shifat: after the tunnel the land read flat grey with a jagged horizon): while it is still high up
  // (u_high 1 → 0 by touchdown, so the forest at rest is untouched) the land keeps its greens — richer, with soft meadow /
  // woodland patches — and the haze rises later so near and mid ground stay alive; the far land still melts fully into
  // the haze, which now takes the sky's own horizon colour (journey frame), so there is no edge and no line
  const { group: forest, spots } = yield* buildForestSteps(low, forestMat, groundMat) // PERFGOV: in steps
  yield // PERFGOV
  const treeShadows = buildShadows(spots, SUN_DIR)
  forest.add(treeShadows.mesh)
  // FOLIAGE HOOK (foliage helper): fluffy grass, trees and meadow floor replace buildGrass and the old trees/shadows
  yield // PERFGOV
  const foliage = yield* buildFoliageSteps({ low, tier: settings.TIER as 'low' | 'mid' | 'high', portrait, sunDir: SUN_DIR, forest, shadows: treeShadows.mesh })
  const grass = foliage.grass
  const fan = buildSunFan(SUN_DIR)
  const mist = buildMist(low)
  const motes = buildMotes(low, Math.min(props.dpr, 2) * (rt.width / 1024), SUN_DIR)
  forest.add(grass.mesh, mist.group, motes.points)
  const innerMats = crewMaterials(envs.space)
  innerMats.visor.envMap = envs.page // the visor always catches two soft studio highlights: it reads as glass in every beat
  yield* crewGeometrySteps(false) // PERFGOV: the shared geometry in steps; full detail, as live (the dive's tablet-window crewmate always built it first)
  const crewIn = new Crewmate(innerMats, low)
  yield // PERFGOV
  const shadowMat = longShadowMaterial(false)
  const shadow = new THREE.Mesh(longShadowGeometry(), shadowMat)
  const hemi = new THREE.HemisphereLight('#6a4cff', '#06121a', 0.6)
  const sun = new THREE.DirectionalLight('#ffd9b0', 2.4); sun.position.set(5, 6, 6)   // the key, from the camera side
  const rim = new THREE.DirectionalLight('#5fe3ff', 2.4); rim.position.set(-6, 3, -7)  // rim: cool in space, the low sun in the forest
  // lights ride with the crewmate so the key is always composed the same way
  const lightRig = new THREE.Group(); lightRig.add(sun, rim, sun.target, rim.target)
  innerScene.add(sky, stars, skyExtras.rocks, skyExtras.dust, fan.mesh, forest, shadow, crewIn.root, hemi, lightRig)
  const fireflies = buildFireflies(260), canopy = buildCanopy()
  yield // PERFGOV
  const tunnel = buildTunnel()
  // TUNNEL DRAMA: the light objects share the wall's uniforms (one set per frame); the blur reads the inner target
  const tunnelLights = buildTunnelLights(tunnel.uniforms)
  const tunnelBlur = buildTunnelBlur(rt, (settings.TIER === 'low' || low ? 'low' : settings.TIER === 'mid' ? 'mid' : 'high'))
  innerScene.add(fireflies.points, canopy.mesh, tunnel.mesh, tunnelLights.orbs, tunnelLights.rings)
  yield // PERFGOV

  // ===== outer world: the tablet + the crewmate that breaks out
  const outerG = new THREE.Group()
  const metal = new THREE.MeshPhysicalMaterial({ color: '#b9bcc2', metalness: 1, roughness: 0.28, envMap: envs.page, envMapIntensity: 1.6, fog: false })
  const glass = new THREE.MeshPhysicalMaterial({ color: '#030304', metalness: 0, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.02, envMap: envs.page, envMapIntensity: 1.2, fog: false })
  const body = new THREE.Mesh(new RoundedBoxGeometry(sw + 1.0, sh + 1.0, 0.5, low ? 3 : 5, 0.24), metal)
  body.position.z = -0.03
  const bezel = new THREE.Mesh(bezelGeometry(sw + 0.92, sh + 0.92, 0.44, sw, sh), glass); bezel.position.z = 0.281
  // R6.96 RIM LINE: the metal rim between the bezel's outer edge and the body's edge is 0.04 units wide, about one background
  // pixel on the phone and weak-PC paths (background at 0.5-0.75x), so it broke into a dashed grey line along the tablet's top.
  // The bezel's OUTER contour is pulled in by u_bezelInset (set per frame from the rim's real width in background pixels, so the
  // rim is never thinner than ~2 of them); the screen opening and everything on a sharp tier are unchanged (inset 0 there).
  const bezelU = { u_bezelInset: { value: 0 } }
  { const hx = sw / 2 + 0.46, hy = sh / 2 + 0.46, mx = sw / 2 + 0.05, my = sh / 2 + 0.05
    glass.onBeforeCompile = (sh2) => {
      Object.assign(sh2.uniforms, bezelU)
      sh2.vertexShader = 'uniform float u_bezelInset;\n' + sh2.vertexShader.replace('#include <begin_vertex>',
        `#include <begin_vertex>\nif (abs(transformed.x) > ${mx.toFixed(4)} || abs(transformed.y) > ${my.toFixed(4)}) transformed.xy *= vec2((${hx.toFixed(4)} - u_bezelInset) / ${hx.toFixed(4)}, (${hy.toFixed(4)} - u_bezelInset) / ${hy.toFixed(4)});`)
    }
    glass.customProgramCacheKey = () => 'bezel-inset' }
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.07, 20), new THREE.MeshBasicMaterial({ color: '#15171c', fog: false }))
  if (portrait) lens.position.set(0, sh / 2 + 0.23, 0.283); else lens.position.set(0, sh / 2 + 0.23, 0.283)
  const segX = low ? 72 : 144, segY = Math.round(segX * (sh / sw))
  const screenMat = screenMaterial(rt.texture, new THREE.Vector2(sw, sh))
  screenMat.uniforms.u_blur.value = tunnelBlur.rt.texture // TUNNEL DRAMA
  screenMat.side = THREE.DoubleSide
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh, segX, segY), screenMat)
  screen.position.z = SCREEN_Z; screen.frustumCulled = false
  // R6.87 SPLIT RESOLUTION: the inner target holds the space/forest only; the crewmate is drawn into its own target at the
  // canvas density (crewLayer.ts) and this twin of the screen (same geometry, same uniforms, CREW_ONLY) lays it over the
  // low-res screen in the hero pass. (From the first crack on, the crewmate goes back into the inner target: the cracks
  // and the frost are drawn over it there.)
  const crewL = SPLIT ? new CrewLayer() : null
  let crewMat: THREE.ShaderMaterial | null = null, crewScreen: THREE.Mesh | null = null
  if (crewL) {
    CrewLayer.depthFor(rt)
    screenMat.uniforms.u_crew.value = crewL.rt.texture
    crewMat = new THREE.ShaderMaterial({ uniforms: screenMat.uniforms, vertexShader: screenMat.vertexShader, fragmentShader: screenMat.fragmentShader, defines: { CREW_ONLY: '' },
      extensions: { derivatives: true } as any, fog: false, side: THREE.DoubleSide, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })
    crewScreen = new THREE.Mesh(screen.geometry, crewMat); crewScreen.frustumCulled = false; crewScreen.visible = false
    screen.add(crewScreen)
    // the hero pass touches only the crewmate's part of the screen (the screen's uv → its local plane)
    const cs = crewScreen
    cs.userData.heroRect = (cam: THREE.Camera) => crewL.rectOn(cs, cam, (u, v, o) => o.set((u - 0.5) * sw, (v - 0.5) * sh, 0))
  }
  const outerMats = crewMaterials(envs.page)
  outerMats.body.envMapIntensity = 1.0
  outerMats.visor.envMapIntensity = 2.6
  const crewOut = new Crewmate(outerMats, low)
  yield // PERFGOV
  crewOut.root.visible = false
  // the cover glass that breaks (geometry built on first use for the real impact point) + its glass dust
  const tier = (settings.TIER === 'low' || low ? 'low' : settings.TIER === 'mid' ? 'mid' : 'high') as 'low' | 'mid' | 'high'
  const shardMat = shatterMaterial(rt.texture)
  const shards = new THREE.Mesh(new THREE.BufferGeometry(), shardMat)
  shards.position.z = SCREEN_Z + 0.002; shards.frustumCulled = false; shards.visible = false
  const glints = buildGlints(320, Math.min(props.dpr, 2) * (tier === 'low' ? 0.8 : 1)) // PERF HOOK (eng #5): one glint count; phones get smaller sprites
  glints.points.visible = false
  // the room behind the device: a graphite → deep-blue studio wash that melts into the page colour at its edges
  const backdropMat = backdropMaterial()
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(260, 160), backdropMat)
  backdrop.position.set(0, 0, -60); backdrop.renderOrder = -5
  outerG.add(backdrop, body, bezel, lens, screen, shards, glints.points, crewOut.root)
  // W18 THE ENDING: the tablet hangs on a matte black wall (ctaScene.ts); the wall replaces the studio backdrop
  yield // PERFGOV
  const cta = buildCta(portrait)
  outerG.add(cta.group)
  backdrop.visible = false
  // the hero's rim light on the crewmate in the CTA (13:33Z: the front plane)
  const rimU = { u_rim: { value: 0 }, u_rimColor: { value: new THREE.Color('#bfe3ff') } }
  outerMats.body.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, rimU)
    sh.fragmentShader = 'uniform float u_rim; uniform vec3 u_rimColor;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n{ float fr = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 3.0); totalEmissiveRadiance += u_rimColor * fr * u_rim; }')
  }
  outerMats.body.customProgramCacheKey = () => 'crew-rim'

  const c = {
    hSpace: new THREE.Color(SPACE_LIGHT.hemiSky), hSky: new THREE.Color('#8a9cc0'), gSpace: new THREE.Color(SPACE_LIGHT.hemiGround), gForest: new THREE.Color('#2f7a30'),
    kSpace: new THREE.Color(SPACE_LIGHT.key), kSun: new THREE.Color('#ffe6cc'), rSpace: new THREE.Color(SPACE_LIGHT.rim), rSun: new THREE.Color('#ffb062'), fogDusk: new THREE.Color('#3a2a4a'), fogDay: new THREE.Color('#a9c3bd'),
  }
  const I: Inner = { crew: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, walk: 0, phase: 0, float: 0, squash: 0, visible: true, cam: new THREE.Vector3(), look: new THREE.Vector3(), fov: 40, atmos: 0, stars: 1, shadow: 0 }
  const IB: Inner = { ...I, crew: new THREE.Vector3(), cam: new THREE.Vector3(), look: new THREE.Vector3() }
  const O: Outer = { camPos: new THREE.Vector3(), camTarget: new THREE.Vector3(), fov: 35, crewVisible: false, crew: new THREE.Vector3(), crewScale: 1, yaw: 0, pitch: 0, roll: 0, float: 0, bulge: 0, width: 1, center: new THREE.Vector2(), ringT: -1, ringAmp: 0, dropT: -1, bright: 1, gloss: 0, crackR: 0, ringR: 0, frost: 0, tilt: 0, shatterT: -1, hole: 4, screenBright: 1, shardsVisible: false }

  const keep = new Set<THREE.BufferGeometry>([crewIn.body.geometry, crewIn.visor.geometry, (crewIn.legL.children[0] as THREE.Mesh).geometry])
  const dispose = () => {
    rt.dispose(); Object.values(envs).forEach((t) => t.dispose()); crewL?.dispose()
    ;[innerScene, outerG].forEach((root) => root.traverse((o: any) => { if (o.geometry && !keep.has(o.geometry) && !isSharedSkyGeometry(o.geometry)) o.geometry.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m.dispose()) }))
  }
  return {
    sw, sh, rt, envs, inner: innerScene, skyExtras, crewL, crewScreen, screen, fireflies, canopy, tunnel, tunnelLights, tunnelBlur, rush: 0, tunnelFx: { zoom: 0, chroma: 0, flash: 0, cx: 0.5, cy: 0.5 }, grass, foliage, fan, mist, motes, treeRim, icam, bcam, sky, skyMat, stars, starMat, glintMat, forest, crewIn, innerMats, shadow, shadowMat, hemi, sun, rim, lightRig,
    outer: outerG, cta, rimU, bezelU, ctaKey: '', par: new THREE.Vector2(), backdrop, backdropMat, screenMat, crewOut, shards, shardMat, shardKey: '', tier, glints, c, I, IB, O, lastP: -1,
    tmp: new THREE.Vector3(), tmp2: new THREE.Vector3(), o3: new THREE.Object3D(), one: new THREE.Vector2(1, 1), dispose,
  }
}
export type { Built }
