import * as THREE from 'three'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { props } from '../../../state/props'
import { settings } from '../../../services/settings'
import { mix, smoothstep as ss } from '../../../core/math'
import { journey } from './journeyState'
import { Crewmate, CREW_HEIGHT, CREW_CENTER_Y, crewMaterials } from './crewmate'
import { makeEnvs } from './env'
import { buildForest, buildShadows, longShadowGeometry, longShadowMaterial } from './forest'
import { buildGrass, buildSunFan, buildMist, buildMotes } from './forestFx'
import { skyMaterial, starMaterial, screenMaterial, dropletMaterial, backdropMaterial, SUN_DIR } from './shaders'
import { inner, outer, T, type Inner, type Outer } from './timeline'
import { journeyAudio, resetJourneyAudio } from './journeyAudio'

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
 * and the crewmate breaks out through the glass as if it were a water surface.
 * The stage never renders the main scene and never moves the camera: it writes journey.pose.
 */
export function JourneyStage(): JSX.Element {
  const { gl } = useThree()
  const [portrait, setPortrait] = useState(() => window.innerHeight > window.innerWidth * 1.05)
  const low = settings.TIER === 'low'
  const S = useMemo(() => build(gl, portrait, low), [gl, portrait, low])
  const group = useRef<THREE.Group>(null!)
  useEffect(() => {
    // warm the inner world's programs up front (its lights live in its own scene, so they compile exactly once)
    try { gl.compile(S.inner, S.icam) } catch { /* compile is a warm-up only */ }
    return () => S.dispose()
  }, [S, gl])

  useFrame((state) => {
    const g = group.current
    if (!journey.active) {
      if (g.visible) { g.visible = false; resetJourneyAudio(); journey.beat = -1 }
      S.lastP = -1
      return
    }
    const W = state.size.width, H = state.size.height
    const wantPortrait = H > W * 1.05
    if (wantPortrait !== portrait) { setPortrait(wantPortrait); return }
    g.visible = true
    const p = props.journey, dt = Math.min(props.dt, 1 / 20), time = props.time
    const snap = journey.snap || S.lastP < 0 || Math.abs(p - S.lastP) > 0.06
    journey.snap = false
    S.lastP = p
    journey.beat = journeyAudio(p)

    // ---- inner world
    const I = inner(p, S.I, portrait)
    S.crewIn.root.visible = I.visible
    S.crewIn.update({ pos: I.crew, yaw: I.yaw, pitch: I.pitch, roll: I.roll, walk: I.walk, phase: I.phase, float: I.float, squash: I.squash, scale: 1 }, dt, time, snap)
    S.icam.position.copy(I.cam); S.icam.lookAt(I.look)
    // ultrawide: the screen covers the viewport, so its top and bottom crop away; widen the inner lens by the same
    // amount so the 16:10 composition (feet, horizon, lead room) survives at 21:9
    const wideK = portrait ? 1 : Math.max(1, (W / H) / 1.6)
    const fovIn = (f: number) => THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(f) / 2) * wideK))
    const fI = fovIn(I.fov)
    if (Math.abs(S.icam.fov - fI) > 1e-3) { S.icam.fov = fI; S.icam.updateProjectionMatrix() }
    S.lightRig.position.copy(I.crew)
    S.sky.position.copy(S.icam.position); S.stars.position.copy(S.icam.position)
    S.skyMat.uniforms.u_atmos.value = I.atmos; S.skyMat.uniforms.u_time.value = time
    S.starMat.uniforms.u_opacity.value = I.stars; S.starMat.uniforms.u_time.value = time
    S.stars.visible = I.stars > 0.001
    S.forest.visible = I.atmos > 0.2
    // forest air: grass sway, the sun fan behind the tree line, mist veils and pollen once we are near the ground
    const land = ss(0.42, 0.52, p)
    S.grass.material.uniforms.u_time.value = time
    S.fan.material.uniforms.u_time.value = time; S.fan.material.uniforms.u_opacity.value = ss(0.3, 0.5, I.atmos) * mix(0.55, 1, land)
    S.fan.mesh.visible = I.atmos > 0.3
    S.fan.mesh.position.copy(S.icam.position).addScaledVector(SUN_DIR, 260); S.fan.mesh.position.y = Math.max(S.fan.mesh.position.y, 16)
    S.fan.mesh.scale.setScalar(300); S.fan.mesh.lookAt(S.icam.position)
    for (const m of S.mist.mats) { m.uniforms.u_time.value = time; m.uniforms.u_opacity.value = land }
    S.mist.group.visible = land > 0.01
    S.treeRim.value = 0.42 * ss(0.3, 0.6, I.atmos)
    S.motes.material.uniforms.u_time.value = time; S.motes.material.uniforms.u_opacity.value = land
    S.motes.points.visible = land > 0.01
    const h = Math.max(0, I.crew.y)
    // long shadow from the feet, cast towards the camera by the low sun behind the clearing
    S.shadow.position.set(I.crew.x, 0.04, I.crew.z - 0.25)
    S.shadow.rotation.y = Math.atan2(-SUN_DIR.x, -SUN_DIR.z)
    S.shadowMat.uniforms.u_opacity.value = I.shadow * Math.exp(-h * 0.6) * 1.6 * (I.visible ? 1 : 0)
    S.shadow.scale.set(1.15 + h * 0.1, 1, 4.2)
    // light + haze follow the atmosphere: violet/teal rim in space → warm sun and green bounce in the forest
    const a = I.atmos
    S.hemi.color.copy(S.c.hSpace).lerp(S.c.hSky, a); S.hemi.groundColor.copy(S.c.gSpace).lerp(S.c.gForest, a)
    S.hemi.intensity = mix(0.7, 0.8, a)
    S.sun.color.copy(S.c.kSpace).lerp(S.c.kSun, a); S.sun.intensity = mix(2.6, 1.7, a)
    S.sun.position.set(mix(5, 3, a), mix(6, 3, a), 6)
    S.rim.color.copy(S.c.rSpace).lerp(S.c.rSun, a); S.rim.intensity = mix(3.4, 3.0, a)
    S.rim.position.set(mix(-6, SUN_DIR.x * 10, a), mix(3, 1.2, a), mix(-7, SUN_DIR.z * 10, a))
    const fog = S.inner.fog as THREE.Fog
    fog.color.copy(S.c.fogDusk).lerp(S.c.fogDay, ss(0.55, 1, a))
    fog.near = mix(20, 60, a); fog.far = mix(220, 380, a)
    const env = a > 0.5 ? S.envs.forest : S.envs.space
    if (S.innerMats.body.envMap !== env) S.innerMats.body.envMap = env
    // the visor: studio highlights in space, the sky (blue over amber over green) once it is in the forest
    const venv = a > 0.5 ? S.envs.forest : S.envs.page
    if (S.innerMats.visor.envMap !== venv) S.innerMats.visor.envMap = venv
    // the visor catches a little more sky as it lands
    S.innerMats.visor.envMapIntensity = mix(3.0, 1.2, a)
    S.innerMats.body.envMapIntensity = mix(1.0, 0.25, a)

    // ---- outer world (local to the tablet)
    const aspect = W / H
    const vh = (d: number) => 2 * d * Math.tan(THREE.MathUtils.degToRad(35) / 2)
    const fillH = Math.min(S.sh / OVERSCAN, S.sw / (OVERSCAN * aspect))
    const needH = Math.max((S.sh + 1) * 1.75, ((S.sw + 1) * 1.45) / aspect)
    const fit = { dFill: fillH / vh(1), dFar: needH / vh(1), lateral: aspect > 1.1 ? S.sw * 0.16 : 0 }
    // where the inner crewmate sits on the glass at the moment of the break (same pose, so the hand-off is seamless)
    const B = inner(T.BREAK, S.IB, portrait)
    const proj = S.tmp.set(B.crew.x, B.crew.y + CREW_CENTER_Y, B.crew.z)
    S.bcam.position.copy(B.cam); S.bcam.fov = fovIn(B.fov); S.bcam.updateProjectionMatrix(); S.bcam.lookAt(B.look); S.bcam.updateMatrixWorld()
    const top = S.tmp2.set(B.crew.x, B.crew.y + CREW_HEIGHT, B.crew.z).project(S.bcam)
    proj.project(S.bcam)
    const start = { x: proj.x * S.sw / 2, y: proj.y * S.sh / 2, k: Math.max(0.6, (top.y - proj.y) * S.sh / 2 / (CREW_HEIGHT - CREW_CENTER_Y)) }
    const O = outer(p, S.O, fit, start, SCREEN_Z)
    journey.pose.pos.copy(O.camPos).add(JOURNEY_ORIGIN)
    journey.pose.target.copy(O.camTarget).add(JOURNEY_ORIGIN)
    journey.pose.fov = O.fov

    const su = S.screenMat.uniforms
    su.u_bulge.value = O.bulge; su.u_width.value = O.width; su.u_center.value.copy(O.center)
    su.u_ringT.value = O.ringT; su.u_ringAmp.value = O.ringAmp; su.u_bright.value = O.bright
    su.u_time.value = time; su.u_gloss.value = O.gloss
    S.backdropMat.uniforms.u_amount.value = O.gloss
    // the backdrop always sits square behind what the camera looks at, so its glow stays composed
    S.tmp2.copy(O.camTarget).sub(O.camPos).normalize()
    S.backdrop.position.copy(O.camTarget).addScaledVector(S.tmp2, 55)
    S.backdrop.lookAt(S.tmp.copy(O.camPos))
    S.crewOut.root.visible = O.crewVisible
    if (O.crewVisible) {
      // center → feet: the rig's origin is between the feet
      S.tmp.copy(O.crew); S.tmp.y -= CREW_CENTER_Y * O.crewScale
      S.crewOut.update({ pos: S.tmp, yaw: O.yaw, pitch: O.pitch, roll: O.roll, walk: 0, phase: 0, float: O.float, squash: 0, scale: O.crewScale }, dt, time, snap || p - T.BREAK < 0.004)
    }
    // the hand-off frame: while the glass is still pressed, nobody is in front of it
    // droplets — ballistic, scroll-scrubbed (reversible), each a tiny lens carrying the forest
    S.drops.visible = O.dropT >= 0
    if (O.dropT >= 0) {
      const t = O.dropT
      for (let i = 0; i < S.dropData.length; i++) {
        const d = S.dropData[i]
        const tt = Math.max(0, t - d.delay)
        const rr = start.k * (d.crown ? 0.62 : 0.45)
        const x = O.center.x + d.dir.x * rr + d.vel.x * tt
        const y = O.center.y + d.dir.y * rr + d.vel.y * tt - (d.crown ? 0 : 2.2 * tt * tt)
        const z = SCREEN_Z + d.vel.z * tt - (d.crown ? 3.4 * tt * tt : 0) // the crown falls back into the glass
        const grow = d.crown ? ss(0, 0.08, tt) * (1 - ss(0.55, 0.95, tt)) * (z > SCREEN_Z ? 1 : 0) : ss(0, 0.12, tt) * (1 - ss(1.4, 2.6, tt))
        S.o3.position.set(x, y, z)
        const st = 1 + Math.min(1.6, Math.hypot(d.vel.x, d.vel.y - 4.4 * tt, d.vel.z) * 0.12) // stretch along velocity
        S.o3.scale.set(d.r * grow, d.r * grow, d.r * grow * st)
        S.o3.lookAt(x + d.vel.x, y + d.vel.y - 4.4 * tt, z + d.vel.z)
        S.o3.updateMatrix(); S.drops.setMatrixAt(i, S.o3.matrix)
      }
      S.drops.instanceMatrix.needsUpdate = true
    }

    // ---- render the inner world into the screen texture (offscreen only; the main frame is the post chain's)
    const prev = gl.getRenderTarget()
    gl.setRenderTarget(S.rt)
    gl.clear()
    gl.render(S.inner, S.icam)
    gl.setRenderTarget(prev)
  })

  return (
    <group ref={group} position={JOURNEY_ORIGIN} visible={false}>
      <primitive object={S.outer} />
    </group>
  )
}

type Built = ReturnType<typeof build>
function build(gl: THREE.WebGLRenderer, portrait: boolean, low: boolean) {
  const sw = portrait ? 8.8 : 12.8, sh = portrait ? 12.8 : 8.8
  const long = low ? 512 : 1024 // the long side; the screen's aspect sets the other
  const rt = new THREE.WebGLRenderTarget(portrait ? Math.round(long * sw / sh) : long, portrait ? long : Math.round(long * sh / sw), {
    type: THREE.HalfFloatType, samples: low ? 0 : 4, depthBuffer: true, generateMipmaps: false,
  })
  const envs = makeEnvs(gl)

  // ===== inner world
  const innerScene = new THREE.Scene()
  innerScene.fog = new THREE.Fog('#e9c9a8', 40, 230)
  const icam = new THREE.PerspectiveCamera(42, sw / sh, 0.1, 2000)
  const bcam = icam.clone()
  const skyMat = skyMaterial()
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), skyMat)
  sky.renderOrder = -10; sky.frustumCulled = false
  // stars: modest and soft
  const N = low ? 110 : 220
  const sp = new Float32Array(N * 3), ss_ = new Float32Array(N), sc = new Float32Array(N * 3)
  let seed = 3; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const tint = [new THREE.Color('#ffffff'), new THREE.Color('#cfe3ff'), new THREE.Color('#ffe2c4'), new THREE.Color('#ffd0ec')]
  for (let i = 0; i < N; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u)
    sp.set([Math.cos(th) * s * 600, u * 600, Math.sin(th) * s * 600], i * 3)
    const big = r() > 0.95
    ss_[i] = big ? 2.4 + r() * 1.2 : 1.0 + r() * 1.0
    const c = tint[Math.floor(r() * 4)]
    const b = big ? 0.9 : 0.25 + r() * 0.35
    sc.set([c.r * b, c.g * b, c.b * b], i * 3)
  }
  const sg = new THREE.BufferGeometry()
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setAttribute('aSize', new THREE.BufferAttribute(ss_, 1)); sg.setAttribute('aColor', new THREE.BufferAttribute(sc, 3))
  const starMat = starMaterial(Math.min(gl.getPixelRatio(), 2) * (rt.width / 1024))
  const stars = new THREE.Points(sg, starMat); stars.frustumCulled = false; stars.renderOrder = -9

  // Lambert: matte foliage with no grazing sheen against the low sun (and cheaper on phones)
  const forestMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  // backlit canopy: the low sun sits behind the clearing, so every silhouette edge catches a warm rim
  const treeRim = { value: 0 }, treeRimCol = { value: new THREE.Color('#ffc58a') }
  forestMat.onBeforeCompile = (sh) => {
    sh.uniforms.u_rim = treeRim; sh.uniforms.u_rimCol = treeRimCol
    sh.fragmentShader = 'uniform float u_rim; uniform vec3 u_rimCol;\n' + sh.fragmentShader.replace('#include <opaque_fragment>',
      'float rimF = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 4.5);\n  outgoingLight += u_rimCol * rimF * u_rim;\n' +
      // leaf translucency: with the low sun behind the canopy, light scatters through the foliage edges (tinted by
      // the leaf colour, so trunks barely glow) — the soft gold-green backlight of a stylised forest
      '  #if NUM_DIR_LIGHTS > 0\n  { vec3 Lv = directionalLights[0].direction; vec3 Vv = normalize(vViewPosition);\n' +
      '    float back = pow(clamp(dot(-Lv, Vv), 0.0, 1.0), 3.0);\n    float edge = 0.35 + 0.65 * pow(1.0 - abs(dot(normal, Vv)), 1.5);\n' +
      '    float wrap = clamp(dot(normal, Lv) * 0.5 + 0.5, 0.0, 1.0);\n' +
      '    outgoingLight += diffuseColor.rgb * u_rimCol * (back * edge * 0.9 + wrap * 0.1) * u_rim; }\n  #endif\n  #include <opaque_fragment>')
  }
  // the ground is smooth (the grass carries the texture); the trees are soft stylised foliage (forest.ts)
  const groundMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  const { group: forest, spots } = buildForest(low, forestMat, groundMat)
  const treeShadows = buildShadows(spots, SUN_DIR)
  forest.add(treeShadows.mesh)
  const grass = buildGrass(low, settings.TIER as 'low' | 'mid' | 'high', SUN_DIR)
  const fan = buildSunFan(SUN_DIR)
  const mist = buildMist(low)
  const motes = buildMotes(low, Math.min(gl.getPixelRatio(), 2) * (rt.width / 1024), SUN_DIR)
  forest.add(grass.mesh, mist.group, motes.points)
  const innerMats = crewMaterials(envs.space)
  innerMats.visor.envMap = envs.page // the visor always catches two soft studio highlights: it reads as glass in every beat
  const crewIn = new Crewmate(innerMats, low)
  const shadowMat = longShadowMaterial(false)
  const shadow = new THREE.Mesh(longShadowGeometry(), shadowMat)
  const hemi = new THREE.HemisphereLight('#6a4cff', '#06121a', 0.6)
  const sun = new THREE.DirectionalLight('#ffd9b0', 2.4); sun.position.set(5, 6, 6)   // the key, from the camera side
  const rim = new THREE.DirectionalLight('#5fe3ff', 2.4); rim.position.set(-6, 3, -7)  // rim: cool in space, the low sun in the forest
  // lights ride with the crewmate so the key is always composed the same way
  const lightRig = new THREE.Group(); lightRig.add(sun, rim, sun.target, rim.target)
  innerScene.add(sky, stars, fan.mesh, forest, shadow, crewIn.root, hemi, lightRig)

  // ===== outer world: the tablet + the crewmate that breaks out
  const outerG = new THREE.Group()
  const metal = new THREE.MeshPhysicalMaterial({ color: '#b9bcc2', metalness: 1, roughness: 0.28, envMap: envs.page, envMapIntensity: 1.6, fog: false })
  const glass = new THREE.MeshPhysicalMaterial({ color: '#030304', metalness: 0, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.02, envMap: envs.page, envMapIntensity: 1.2, fog: false })
  const body = new THREE.Mesh(new RoundedBoxGeometry(sw + 1.0, sh + 1.0, 0.5, low ? 3 : 5, 0.24), metal)
  body.position.z = -0.03
  const bezel = new THREE.Mesh(bezelGeometry(sw + 0.92, sh + 0.92, 0.44, sw, sh), glass); bezel.position.z = 0.281
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.07, 20), new THREE.MeshBasicMaterial({ color: '#15171c', fog: false }))
  if (portrait) lens.position.set(0, sh / 2 + 0.23, 0.283); else lens.position.set(0, sh / 2 + 0.23, 0.283)
  const segX = low ? 72 : 144, segY = Math.round(segX * (sh / sw))
  const screenMat = screenMaterial(rt.texture, new THREE.Vector2(sw, sh))
  screenMat.side = THREE.DoubleSide
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh, segX, segY), screenMat)
  screen.position.z = SCREEN_Z; screen.frustumCulled = false
  const outerMats = crewMaterials(envs.page)
  outerMats.body.envMapIntensity = 1.0
  outerMats.visor.envMapIntensity = 2.6
  const crewOut = new Crewmate(outerMats, low)
  crewOut.root.visible = false
  // droplets
  const DN = low ? 8 : 12, CN = low ? 8 : 12 // free droplets + the splash crown
  const dropMat = dropletMaterial(rt.texture)
  const drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, low ? 2 : 3), dropMat, DN + CN)
  drops.frustumCulled = false; drops.visible = false
  const dropData = Array.from({ length: DN }, (_, i) => {
    const ang = (i / DN) * Math.PI * 2 + r() * 0.5
    const dir = new THREE.Vector2(Math.cos(ang), Math.sin(ang))
    const sp = 1.2 + r() * 2.4
    return { dir, vel: new THREE.Vector3(dir.x * sp, dir.y * sp + 1.6, 1.6 + r() * 3.2), r: 0.12 + Math.pow(r(), 2) * 0.24, delay: r() * 0.12, crown: false }
  }).concat(Array.from({ length: CN }, (_, i) => {
    const ang = (i / CN) * Math.PI * 2
    const dir = new THREE.Vector2(Math.cos(ang), Math.sin(ang))
    // a crown: tall, slow jets out of the glass that lean outwards and fall back
    return { dir, vel: new THREE.Vector3(dir.x * 0.9, dir.y * 0.9, 3.2 + r() * 0.8), r: 0.09 + r() * 0.05, delay: 0.02 * r(), crown: true }
  }))
  // the room behind the device: a graphite → deep-blue studio wash that melts into the page colour at its edges
  const backdropMat = backdropMaterial()
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(260, 160), backdropMat)
  backdrop.position.set(0, 0, -60); backdrop.renderOrder = -5
  outerG.add(backdrop, body, bezel, lens, screen, crewOut.root, drops)

  const c = {
    hSpace: new THREE.Color('#7a5cff'), hSky: new THREE.Color('#8a9cc0'), gSpace: new THREE.Color('#071a22'), gForest: new THREE.Color('#2f7a30'),
    kSpace: new THREE.Color('#ffd2c4'), kSun: new THREE.Color('#ffe6cc'), rSpace: new THREE.Color('#5fd8ff'), rSun: new THREE.Color('#ffb062'), fogDusk: new THREE.Color('#3a2a4a'), fogDay: new THREE.Color('#a9c3bd'),
  }
  const I: Inner = { crew: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, walk: 0, phase: 0, float: 0, squash: 0, visible: true, cam: new THREE.Vector3(), look: new THREE.Vector3(), fov: 40, atmos: 0, stars: 1, shadow: 0 }
  const IB: Inner = { ...I, crew: new THREE.Vector3(), cam: new THREE.Vector3(), look: new THREE.Vector3() }
  const O: Outer = { camPos: new THREE.Vector3(), camTarget: new THREE.Vector3(), fov: 35, crewVisible: false, crew: new THREE.Vector3(), crewScale: 1, yaw: 0, pitch: 0, roll: 0, float: 0, bulge: 0, width: 1, center: new THREE.Vector2(), ringT: -1, ringAmp: 0, dropT: -1, bright: 1, gloss: 0 }

  const keep = new Set<THREE.BufferGeometry>([crewIn.body.geometry, crewIn.visor.geometry, (crewIn.legL.children[0] as THREE.Mesh).geometry])
  const dispose = () => {
    rt.dispose(); Object.values(envs).forEach((t) => t.dispose())
    ;[innerScene, outerG].forEach((root) => root.traverse((o: any) => { if (o.geometry && !keep.has(o.geometry)) o.geometry.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m.dispose()) }))
  }
  return {
    sw, sh, rt, envs, inner: innerScene, grass, fan, mist, motes, treeRim, icam, bcam, sky, skyMat, stars, starMat, forest, crewIn, innerMats, shadow, shadowMat, hemi, sun, rim, lightRig,
    outer: outerG, backdrop, backdropMat, screenMat, crewOut, drops, dropData, c, I, IB, O, lastP: -1,
    tmp: new THREE.Vector3(), tmp2: new THREE.Vector3(), o3: new THREE.Object3D(), dispose,
  }
}
export type { Built }
