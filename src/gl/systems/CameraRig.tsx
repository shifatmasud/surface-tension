import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useMemo } from 'react'
import { visuals, type Pose } from './visuals'
import { props } from '../../state/props'
import { input } from '../../services/input'
import { Spring3, Spring } from '../../core/spring'
import { BrownianMotion } from '../../core/math'
import { tilt } from '../../services/tilt'

/** The active stage owns the camera; pointer parallax (desktop) / tilt parallax (phones) + idle drift. */
export function CameraRig() {
  const { camera } = useThree() as { camera: THREE.PerspectiveCamera }
  const st = useMemo(() => ({
    pose: { pos: new THREE.Vector3(0, 6, 9), target: new THREE.Vector3(), fov: 35 } as Pose,
    pos: new Spring3({ x: 0, y: 6, z: 9 }, 0.9, 1, 0),
    tgt: new Spring3({ x: 0, y: 0, z: 0 }, 0.9, 1, 0),
    fov: new Spring(35, 0.9, 1, 0),
    par: new Spring3({ x: 0, y: 0, z: 0 }, 1.1, 0.9, 0),
    drift: new BrownianMotion(0.12, 3),
    init: false,
  }), [])
  useFrame((_, dt) => {
    visuals.resolve(st.pose, dt)
    if (!st.init) { st.pos.x.reset(st.pose.pos.x); st.pos.y.reset(st.pose.pos.y); st.pos.z.reset(st.pose.pos.z); st.tgt.x.reset(st.pose.target.x); st.tgt.y.reset(st.pose.target.y); st.tgt.z.reset(st.pose.target.z); st.init = true }
    const p = st.pos.update(st.pose.pos, dt), t = st.tgt.update(st.pose.target, dt)
    const f = st.fov.update(st.pose.fov, dt)
    // mouse-move parallax (damped) — or device tilt on phones
    const mx = tilt.active ? tilt.x : input.mouseXY.x, my = tilt.active ? tilt.y : input.mouseXY.y
    const strength = props.overlayOpen ? 0 : 1
    const par = st.par.update({ x: mx * 0.55 * strength, y: my * 0.3 * strength, z: 0 }, dt)
    const d = st.drift.update(dt)
    camera.position.set(p.x + par.x + d.x * 0.12, p.y + par.y + d.y * 0.08, p.z + d.z * 0.1)
    camera.lookAt(t.x + par.x * 0.25, t.y + par.y * 0.2, t.z)
    if (Math.abs(camera.fov - f) > 1e-3) { camera.fov = f; camera.updateProjectionMatrix() }
  }, -1)
  return null
}
