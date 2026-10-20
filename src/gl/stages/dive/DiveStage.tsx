import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { props, shared } from '../../../state/props'
import { settings } from '../../../services/settings'
import { portrait } from '../../../core/frame'
import { engine } from '../../engine'
import { GEM_LAYER } from '../hero/HeroStage'
import { dive, DIVE_LAYER, TOOL_POS } from './diveState'
import { backdropVert, backdropFrag, floorVert, floorFrag, siltVert, siltFrag, starVert, starFrag } from './shaders'

const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** The sun: 58° up in air, a little left of the dive axis; refracted into the water by Snell's law. */
function sunDirs() {
  const el = (58 * Math.PI) / 180, az = -0.32
  const air = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize()
  const tx = air.x / 1.333, tz = air.z / 1.333
  const toSunWater = new THREE.Vector3(tx, Math.sqrt(1 - tx * tx - tz * tz), tz)
  return { air, travel: toSunWater.clone().negate() }
}

/**
 * S5 — the dive. One star: the light coming through the surface (Snell's window + the shafts under it).
 * Everything lives on its own layer so the hero's cube/planar captures never see it.
 */
export function DiveStage() {
  const { camera, scene } = useThree() as { camera: THREE.PerspectiveCamera; scene: THREE.Scene }
  const group = useRef<THREE.Group>(null!)
  const backdrop = useRef<THREE.Mesh>(null!)
  const tier = settings.TIER
  const hi = tier === 'high', low = tier === 'low'

  const u = useMemo(() => {
    const { air, travel } = sunDirs()
    return {
      u_cam: { value: new THREE.Vector3() },
      u_sun: { value: travel },
      u_sunAir: { value: air },
      u_time: shared.u_time,
      u_deep: { value: 0 },
      u_split: { value: -1 },
      u_star: { value: 0 },
      u_res: shared.u_resolution,
      u_bn: shared.u_blueNoise,
    }
  }, [])

  const mats = useMemo(() => {
    const defines = low ? { LOW: 1 } : {}
    const backdrop = new THREE.ShaderMaterial({
      vertexShader: backdropVert, fragmentShader: backdropFrag,
      uniforms: { ...u, u_raySteps: { value: hi ? 16 : low ? 7 : 11 } },
      side: THREE.BackSide, depthTest: false, depthWrite: false, defines,
    })
    const floor = new THREE.ShaderMaterial({ vertexShader: floorVert, fragmentShader: floorFrag, uniforms: { ...u }, defines, transparent: true })
    const silt = new THREE.ShaderMaterial({
      vertexShader: siltVert, fragmentShader: siltFrag,
      uniforms: { ...u, u_box: { value: low ? 9 : 11 }, u_pxScale: { value: 800 }, u_size: { value: 0.016 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    const stars = new THREE.ShaderMaterial({
      vertexShader: starVert, fragmentShader: starFrag,
      uniforms: { ...u, u_dpr: { value: 1 } },
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    })
    return { backdrop, floor, silt, stars }
  }, [u, hi, low])

  const geos = useMemo(() => {
    const sphere = new THREE.SphereGeometry(60, 48, 24)
    const floor = new THREE.PlaneGeometry(90, 100, low ? 70 : 150, low ? 80 : 170)
    floor.rotateX(-Math.PI / 2)
    const rnd = (n: number) => { const a = new Float32Array(n * 3); for (let i = 0; i < a.length; i++) a[i] = Math.random(); return a }
    const siltN = hi ? 1100 : low ? 380 : 750
    const silt = new THREE.BufferGeometry()
    silt.setAttribute('position', new THREE.BufferAttribute(rnd(siltN), 3))
    silt.setAttribute('aRand', new THREE.BufferAttribute(rnd(siltN), 3))
    const starN = low ? 140 : 220
    const sp = new Float32Array(starN * 3)
    for (let i = 0; i < starN; i++) {
      const v = new THREE.Vector3().randomDirection()
      sp.set([v.x, v.y, v.z], i * 3)
    }
    const stars = new THREE.BufferGeometry()
    stars.setAttribute('position', new THREE.BufferAttribute(sp, 3))
    stars.setAttribute('aRand', new THREE.BufferAttribute(rnd(starN), 3))
    return { sphere, floor, silt, stars }
  }, [hi, low])

  useEffect(() => {
    camera.layers.enable(DIVE_LAYER)
    return () => {
      Object.values(mats).forEach((m) => m.dispose()); Object.values(geos).forEach((g) => g.dispose())
      const g = engine.chain?.grade; if (g) g.u('u_waterline').value = -1
    }
  }, [camera, mats, geos])

  const st = useMemo(() => ({
    hero: null as THREE.Object3D | null, searched: 0, lineWas: false,
    labels: [] as HTMLElement[], labelsAt: 0, v: new THREE.Vector3(), w: new THREE.Vector3(),
  }), [])

  useFrame(() => {
    const camY = camera.position.y
    dive.camY = camY
    dive.camZ = camera.position.z
    const on = props.stage === 'dive'
    const showGL = on && camY < 0.3
    dive.active = showGL
    dive.under = on && camY < 0
    group.current.visible = showGL

    // the lens crossing the surface: the water rises over the frame, bottom to top
    const split = showGL && camY > -0.25 ? Math.min(1, Math.max(0, 0.5 - camY * 2)) : -1
    dive.split = split
    u.u_split.value = split
    const grade = engine.chain?.grade
    if (grade) {
      if (split > 0 && split < 1) { grade.u('u_waterline').value = split; st.lineWas = true }
      else if (st.lineWas) { grade.u('u_waterline').value = -1; st.lineWas = false }
    }

    // fully under: the lake above (and its diamond) is replaced by the view from below
    if (!st.hero && st.searched < 120) {
      st.searched++
      for (const c of scene.children) {
        let hit = false
        c.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.layers.isEnabled(GEM_LAYER) && !o.layers.isEnabled(DIVE_LAYER)) hit = true })
        if (hit && c !== group.current) { st.hero = c; break }
      }
    }
    if (st.hero && on && camY < -0.3) st.hero.visible = false

    if (!showGL) { hideLabels(st.labels); return }

    u.u_cam.value.copy(camera.position)
    backdrop.current.position.copy(camera.position)
    dive.deep = ss(-11, -25, camY) * 0.97
    dive.star = ss(-15, -25.5, camY)
    u.u_deep.value = dive.deep
    u.u_star.value = dive.star
    mats.silt.uniforms.u_pxScale.value = props.renderH / (2 * Math.tan((camera.fov * Math.PI) / 360))
    mats.stars.uniforms.u_dpr.value = props.dpr

    // his tools: crisp DOM labels pinned to points in the water
    if (!st.labels.length && props.time - st.labelsAt > 1) {
      st.labelsAt = props.time
      st.labels = Array.from(document.querySelectorAll<HTMLElement>('#dive .dive__tool'))
    }
    const xk = 1 - 0.58 * portrait()
    const gate = ss(0.54, 0.62, dive.u)
    st.labels.forEach((el, i) => {
      const p = TOOL_POS[i % TOOL_POS.length]
      st.v.set(p[0] * xk, p[1] + 0.08 * Math.sin(props.time * 0.35 + i * 1.7), p[2])
      const dist = st.v.distanceTo(camera.position)
      st.w.copy(st.v).project(camera)
      const inFront = st.w.z < 1 && st.w.z > -1
      const sx = (st.w.x * 0.5 + 0.5) * props.width, sy = (-st.w.y * 0.5 + 0.5) * props.height
      const fx = st.w.x * 0.5 + 0.5, fy = 0.5 - st.w.y * 0.5             // 0..1 from left / top
      const edge = ss(0.03, 0.1, Math.min(fx, 1 - fx)) * ss(0.11, 0.2, fy) * ss(0.04, 0.12, 1 - fy)   // clear of the nav at the top
      const a = inFront ? gate * Math.exp(-0.075 * dist) * ss(1.4, 3.2, dist) * edge * (1 - dive.deep) * 1.6 : 0
      el.style.opacity = Math.min(1, a).toFixed(3)
      if (a > 0.002) el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`
    })
  })

  return (
    <group ref={group} visible={false}>
      <mesh ref={backdrop} geometry={geos.sphere} material={mats.backdrop} renderOrder={10} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />
      <mesh geometry={geos.floor} material={mats.floor} position={[0, 0, 28]} renderOrder={11} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />
      <points geometry={geos.silt} material={mats.silt} renderOrder={12} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />
      <points geometry={geos.stars} material={mats.stars} renderOrder={13} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />
    </group>
  )
}

function hideLabels(els: HTMLElement[]) { for (const el of els) if (el.style.opacity !== '0') el.style.opacity = '0' }
