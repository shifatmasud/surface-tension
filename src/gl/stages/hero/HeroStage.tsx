import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
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

export const GEM_LAYER = 2
export const gem = { pos: new THREE.Vector3(0, 0.45, 0), radius: 0.42, touch: 0 }

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
  const gemGeo = useMemo(() => brilliantGeometry(gem.radius), [])
  fboHelper.track(water)

  // env capture for the gem (sky + lake, gem hidden), and the planar reflection of the gem for the lake
  const env = useMemo(() => {
    const rt = new THREE.WebGLCubeRenderTarget(hi ? 256 : 128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter })
    const cam = new THREE.CubeCamera(0.05, 200, rt)
    return { rt, cam, frame: 0 }
  }, [hi])
  const refl = useMemo(() => {
    const s = hi ? 0.5 : 0.35
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType })
    const cam = new THREE.PerspectiveCamera()
    cam.layers.set(GEM_LAYER)
    const proxy = new THREE.MeshStandardMaterial({ color: '#3f7bff', metalness: 0.2, roughness: 0.05, emissive: '#0f2a80', emissiveIntensity: 0.6 })
    return { rt, cam, proxy, scale: s, bias: new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1) }
  }, [hi])
  useEffect(() => {
    refl.rt.setSize(Math.max(2, Math.floor(size.width * props.dpr * refl.scale)), Math.max(2, Math.floor(size.height * props.dpr * refl.scale)))
  }, [size, refl])
  useEffect(() => { wu.u_reflTex.value = refl.rt.texture; wu.u_reflOn.value = 1 }, [refl, wu])

  const st = useMemo(() => ({
    tiltX: new Spring(0, 1.1, 0.55, 0), tiltZ: new Spring(0, 1.1, 0.55, 0), lift: new Spring(0, 0.9, 0.45, 0),
    spin: 0, lastTouch: 0, phase: 0,
  }), [])

  useFrame((_, dt) => {
    const t = props.time
    const vis = props.look.dive < 0.999 || props.stage === 'dive'
    group.current.visible = vis
    if (!vis) return
    // gem: slow breathing hover; the tip dips into the water once per ~3.4 s
    st.phase += dt * (Math.PI * 2 / 3.4)
    const bob = Math.cos(st.phase)                     // -1 = lowest (touching)
    const pointer = input.everMoved ? input.mouseXY : { x: 0, y: 0 }
    const lift = st.lift.update(props.heroPin * 0.9, dt)
    const tipY = 0.86 * gem.radius
    gem.pos.set(0, tipY - 0.07 + (bob * 0.5 + 0.5) * 0.045 + lift, 0)
    st.spin += dt * 0.16
    const m = gemMesh.current
    m.position.copy(gem.pos)
    m.rotation.set(st.tiltX.update(-0.42 - pointer.y * 0.1, dt), st.spin, st.tiltZ.update(pointer.x * -0.12, dt), 'XYZ')
    if (bob < -0.985 && t - st.lastTouch > 2.5 && lift < 0.05) {
      pool.drop(0, 0, 0.035, 0.014); st.lastTouch = t
    }
    gem.touch = Math.max(0, -bob)
    wu.u_gem.value.set(gem.pos.x, gem.pos.y, gem.pos.z, 0.85)

    // planar reflection of the gem (mirror camera, gem layer only)
    const c = camera as THREE.PerspectiveCamera
    const rc = refl.cam
    rc.copy(c, false); rc.layers.set(GEM_LAYER)
    const p = c.position, look = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion).add(p)
    rc.position.set(p.x, -p.y, p.z)
    rc.up.set(0, -1, 0).applyQuaternion(new THREE.Quaternion()).set(0, -1, 0)
    rc.lookAt(look.x, -look.y, look.z)
    rc.updateMatrixWorld(); rc.projectionMatrix.copy(c.projectionMatrix)
    wu.u_reflMatrix.value.copy(refl.bias).multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse)
    const mat = m.material as THREE.Material
    m.material = refl.proxy
    const prevRT = gl.getRenderTarget(), prevClear = gl.getClearAlpha(), cc = new THREE.Color(); gl.getClearColor(cc)
    gl.setRenderTarget(refl.rt); gl.setClearColor(0x000000, 0); gl.clear(true, true, false)
    const bg = scene.background; scene.background = null
    gl.render(scene, rc)
    m.material = mat

    // env capture: first frames, then every 24 frames on capable tiers
    if (env.frame < 3 || (hi && env.frame % 24 === 0)) {
      m.visible = false
      env.cam.position.copy(gem.pos)
      env.cam.update(gl, scene)
      m.visible = true
    }
    env.frame++
    scene.background = bg
    gl.setRenderTarget(prevRT); gl.setClearColor(cc, prevClear)
  })

  return (
    <group ref={group}>
      <primitive object={dome} />
      <mesh geometry={waterGeo} material={water} rotation-x={-Math.PI / 2} frustumCulled={false} />
      <mesh ref={gemMesh} geometry={gemGeo} onUpdate={(o) => o.layers.enable(GEM_LAYER)}>
        <MeshRefractionMaterial envMap={env.rt.texture as any} bounces={hi ? 3 : 2} ior={2.2} fresnel={0.85} aberrationStrength={hi ? 0.03 : 0.02} fastChroma={!hi} color={new THREE.Color(0.36, 0.6, 1.75)} toneMapped />
      </mesh>
    </group>
  )
}
void sky; void engine
