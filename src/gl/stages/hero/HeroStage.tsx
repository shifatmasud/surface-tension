import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { nb, useStageFrame } from '../../systems/neighbour' // NEIGHBOUR HOOK
import { MeshRefractionMaterial } from '@react-three/drei'
import { createWaterMaterial } from '../../materials/water'
import { createSkyDome, sky } from '../../shaders/sky'
import { brilliantGeometry } from './diamond'
import { props } from '../../../state/props'
import { settings } from '../../../services/settings'
import { fboHelper } from '../../core/fbo'
import { pool } from '../../systems/pool'
import { input } from '../../../services/input'
import { Spring } from '../../../core/spring'
import { engine } from '../../engine'
import { dive } from '../dive/diveState'
import { quality } from '../../quality' // PERF HOOK

export const GEM_LAYER = 2
export const gem = { pos: new THREE.Vector3(0, 0.45, 0), radius: 0.5, touch: 0 }
/** env-capture-only layer: the studio cards the gem "sees" but the camera never does */
export const STUDIO_LAYER = 6

/**
 * S1 — the lake. One star: a blue brilliant-cut glass diamond hovering over calm water, its tip kissing
 * the surface every few seconds (soft rings). Water: real optics, cheap tricks (see materials/water.ts).
 */
export function HeroStage() {
  const { gl, scene, camera, size } = useThree()
  const group = useRef<THREE.Group>(null!)
  const gemMesh = useRef<THREE.Mesh>(null!)
  const hi = settings.TIER === 'high' || settings.TIER === 'mid'
  const { material: water, uniforms: wu } = useMemo(createWaterMaterial, [])
  ;(window as any).__wu = wu // QA: water uniforms
  ;(window as any).__gem = { gem, gemMesh } // QA
  const dome = useMemo(createSkyDome, [])
  const waterGeo = useMemo(() => {
    const g = new THREE.PlaneGeometry(500, 500, hi ? 260 : 140, hi ? 260 : 140)
    // concentrate vertices near the gem (where the sim and the camera are): r' = r^1.8 remap
    const p = g.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) / 250, y = p.getY(i) / 250, r = Math.hypot(x, y)
      if (r > 0) { const k = Math.pow(r, 2.4) / r; p.setXY(i, x * k * 250, y * k * 250) }
    }
    g.computeBoundingSphere()
    return g
  }, [hi])
  const gemGeo = useMemo(() => brilliantGeometry(1), [])
  fboHelper.track(water)

  // env capture for the gem (sky + lake, gem hidden), and the planar reflection of the gem for the lake
  const env = useMemo(() => {
    const rt = new THREE.WebGLCubeRenderTarget(hi ? 256 : 128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter })
    const cam = new THREE.CubeCamera(0.05, 200, rt)
    cam.children.forEach((c) => c.layers.enable(STUDIO_LAYER))
    return { rt, cam, frame: 0 }
  }, [hi])
  // product-photography trick: a near-white world gives a pastel stone, so the env capture alone sees a ring of
  // dark flags with bright gaps around the gem (plus a deep floor card). The facets then tile into crisp
  // dark/bright blues — a vivid stone with real sparkle — while the visible frame stays airy and white.
  const studio = useMemo(() => {
    const g = new THREE.Group()
    const dark = new THREE.MeshBasicMaterial({ color: '#05070f', side: THREE.DoubleSide, fog: false, toneMapped: false })
    const deep = new THREE.MeshBasicMaterial({ color: '#0a1a4a', side: THREE.DoubleSide, fog: false, toneMapped: false })
    const soft = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.2, 2.25), side: THREE.DoubleSide, fog: false, toneMapped: false })
    const add = (m: THREE.Mesh) => { m.layers.set(STUDIO_LAYER); g.add(m) }
    const n = 7
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3, w = 2 * Math.PI * 3 / n * 0.5
      const card = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.9), dark)
      card.position.set(Math.cos(a) * 3, 0.35, Math.sin(a) * 3); card.lookAt(0, 0.35, 0); add(card)
    }
    const floor = new THREE.Mesh(new THREE.CircleGeometry(2.2, 32), deep)
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.9; add(floor)
    const box = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.4), soft)
    box.position.set(-0.6, 3.2, -0.8); box.lookAt(0, 0, 0); add(box)
    // PERF HOOK (same objects on every tier): the env-capture-only studio cards exist on phones too. They are drawn
    // only into the gem's env capture (first 3 frames on phones), so they cost nothing per frame and the phone stone
    // now gets the same dark/bright facet tiling as desktop.
    g.visible = true
    return g
  }, [])
  const refl = useMemo(() => {
    const s = hi ? 0.5 : 0.35
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType })
    const cam = new THREE.PerspectiveCamera()
    cam.layers.set(GEM_LAYER)
    const proxy = new THREE.MeshStandardMaterial({ color: '#3f7bff', metalness: 0.2, roughness: 0.05, emissive: '#0f2a80', emissiveIntensity: 0.6 })
    return { rt, cam, proxy, scale: s, bias: new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1) }
  }, [hi])
  useEffect(() => {
    // PERF HOOK: the reflection target follows the governor (DPR step × its render-target scale)
    const fit = () => { const s = quality.rt(refl.scale), d = quality.dprFor(size.width, size.height); refl.rt.setSize(Math.max(2, Math.floor(size.width * d * s)), Math.max(2, Math.floor(size.height * d * s))) }
    fit()
    return quality.on(fit)
  }, [size, refl])
  useEffect(() => { wu.u_reflTex.value = refl.rt.texture; wu.u_reflOn.value = 1 }, [refl, wu])

  const st = useMemo(() => ({
    tiltX: new Spring(0, 1.1, 0.55, 0), tiltZ: new Spring(0, 1.1, 0.55, 0), lift: new Spring(0, 0.9, 0.45, 0),
    spin: 0, lastTouch: 0, phase: 0,
    // PERF HOOK: scratch objects (no per-frame allocation → no GC pauses mid-scroll)
    look: new THREE.Vector3(), cc: new THREE.Color(),
  }), [])

  useStageFrame('hero', (_, dt) => {
    const t = props.time
    // underwater, the gem's reflection/env capture are wasted work: stop once the dive camera is below the surface
    const vis = (props.look.dive < 0.999 || props.stage === 'dive') && props.stage !== 'journey' && props.stage !== 'systems'
      && !(props.stage === 'dive' && dive.camY < -0.3)
      && !(props.stage === 'lab' && props.look.fade > 0.965)  // the lab fades the lake to 97 %: skip its 138k-tri water + reflection/env passes there
    group.current.visible = vis
    if (!vis) return
    // gem: slow breathing hover; the tip dips into the water once per ~3.4 s
    st.phase += dt * (Math.PI * 2 / 3.4)
    const bob = Math.cos(st.phase)                     // -1 = lowest (touching)
    const pointer = input.everMoved ? input.mouseXY : { x: 0, y: 0 }
    // lifted while the hero cranes up; settles back onto the water for the contact bookend
    const lift = st.lift.update(props.heroPin * 0.9 * (1 - Math.min(1, (props.resurface || 0) * 2.5)), dt)
    const tipY = 0.86 * gem.radius
    gem.pos.set(0, tipY - 0.07 + (bob * 0.5 + 0.5) * 0.045 + lift, 0)
    st.spin += dt * 0.16
    const m = gemMesh.current
    m.position.copy(gem.pos)
    m.scale.setScalar(gem.radius)
    // contact bookend: the low camera saw the hero's forward tilt edge-on (a flat sliver); tip the table toward the lens
    // hero: the classic three-quarter jewel view: crown, table and pavilion point all read (at -0.42 the camera
    // saw the stone side-on: a thin crown over a dark pavilion window; at 0 and above it reads as a flat oval). The statement's top-down shot was framed for -0.42
    const baseTilt = props.stage === 'contact' ? 0.2 : props.stage === 'statement' ? -0.42 : ((window as any).__heroTilt ?? -0.25)
    m.rotation.set(st.tiltX.update(baseTilt - pointer.y * 0.1, dt), st.spin, st.tiltZ.update(pointer.x * -0.12, dt), 'XYZ')
    if (bob < -0.985 && t - st.lastTouch > 2.5 && lift < 0.05) {
      pool.drop(0, 0, 0.035, 0.014); st.lastTouch = t
    }
    gem.touch = Math.max(0, -bob)
    wu.u_gem.value.set(gem.pos.x, gem.pos.y, gem.pos.z, 0.85)

    // planar reflection of the gem (mirror camera, gem layer only)
    const c = camera as THREE.PerspectiveCamera
    const rc = refl.cam
    rc.copy(c, false); rc.layers.set(GEM_LAYER)
    const p = c.position, look = st.look.set(0, 0, -1).applyQuaternion(c.quaternion).add(p)
    rc.position.set(p.x, -p.y, p.z)
    rc.up.set(0, -1, 0)
    rc.lookAt(look.x, -look.y, look.z)
    rc.updateMatrixWorld(); rc.projectionMatrix.copy(c.projectionMatrix)
    wu.u_reflMatrix.value.copy(refl.bias).multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse)
    const mat = m.material as THREE.Material
    m.material = refl.proxy
    const prevRT = gl.getRenderTarget(), prevClear = gl.getClearAlpha(), cc = st.cc; gl.getClearColor(cc)
    gl.setRenderTarget(refl.rt); gl.setClearColor(0x000000, 0); gl.clear(true, true, false)
    const bg = scene.background; scene.background = null
    gl.render(scene, rc)
    m.material = mat

    // env capture: first frames, then every 24 frames on capable tiers
    if (env.frame < 3 || (hi && env.frame % 24 === 0 && props.stage !== 'contact')) {  // contact keeps the hero's studio env: a re-capture of the bright contact field washed the pavilion out
      m.visible = false
      env.cam.position.copy(gem.pos)
      studio.position.copy(gem.pos)
      env.cam.update(gl, scene)
      m.visible = true
    }
    env.frame++
    scene.background = bg
    gl.setRenderTarget(prevRT); gl.setClearColor(cc, prevClear)
  }, group)

  return (
    <group ref={group}>
      <primitive object={dome} />
      <primitive object={studio} />
      <mesh geometry={waterGeo} material={water} rotation-x={-Math.PI / 2} frustumCulled={false} />
      <mesh ref={gemMesh} geometry={gemGeo} onUpdate={(o) => o.layers.enable(GEM_LAYER)}>
        <MeshRefractionMaterial envMap={env.rt.texture as any} bounces={hi ? 3 : 2} ior={2.2} fresnel={0.85} aberrationStrength={hi ? 0.03 : 0.02} fastChroma={!hi} color={new THREE.Color(0.1, 0.34, 2.1)} toneMapped />
      </mesh>
    </group>
  )
}
void sky; void engine
