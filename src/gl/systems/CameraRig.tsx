import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useMemo } from 'react'
import { visuals, type Pose } from './visuals'
import { props } from '../../state/props'
import { input } from '../../services/input'
import { Spring3, Spring } from '../../core/spring'
import { BrownianMotion } from '../../core/math'
import { tilt } from '../../services/tilt'
import { clip } from './clip'

const FINE_POINTER = typeof matchMedia === 'function' ? matchMedia('(any-pointer: fine)').matches : true

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
    parK: 1,
    stage: '',
    owner: -1,
  }), [])
  useFrame((_, dt) => {
    visuals.resolve(st.pose, dt)
    if (!st.init) { st.pos.x.reset(st.pose.pos.x); st.pos.y.reset(st.pose.pos.y); st.pos.z.reset(st.pose.pos.z); st.tgt.x.reset(st.pose.target.x); st.tgt.y.reset(st.pose.target.y); st.tgt.z.reset(st.pose.target.z); st.init = true }
    // a stage that lives far away (the journey sits 200 m off) is a cut, not a 200 m dolly through the void
    // a new block owner (clipped sections) starts on its own pose: the first frames of the incoming scene are
    // a sliver at the bottom of its card, so its camera must not fly in from the previous block's
    const newOwner = clip.enabled && clip.ownerKey !== st.owner
    st.owner = clip.ownerKey
    if (props.stage !== st.stage || newOwner) {
      st.stage = props.stage
      const cur = new THREE.Vector3(st.pos.x.value, st.pos.y.value, st.pos.z.value)
      if (newOwner || cur.distanceTo(st.pose.pos) > 30) {
        st.pos.x.reset(st.pose.pos.x); st.pos.y.reset(st.pose.pos.y); st.pos.z.reset(st.pose.pos.z)
        st.tgt.x.reset(st.pose.target.x); st.tgt.y.reset(st.pose.target.y); st.tgt.z.reset(st.pose.target.z)
        if (newOwner) st.fov.reset(st.pose.fov)
      }
    }
    const p = st.pos.update(st.pose.pos, dt), t = st.tgt.update(st.pose.target, dt)
    const f = st.fov.update(st.pose.fov, dt)
    // mouse-move parallax (damped) — or device tilt on phones
    // a touch is not a hover: on coarse pointers the last tap point must not park the camera off-centre
    const fine = FINE_POINTER
    const mx = tilt.active ? tilt.x : fine ? input.mouseXY.x : 0, my = tilt.active ? tilt.y : fine ? input.mouseXY.y : 0
    // stages that frame an exact composition (the journey's screen fills the viewport) take the parallax away
    st.parK += ((props.overlayOpen || props.stage === 'journey' ? 0 : 1) - st.parK) * (1 - Math.exp(-4 * dt))
    const strength = st.parK
    const par = st.par.update({ x: mx * 0.55 * strength, y: my * 0.3 * strength, z: 0 }, dt)
    const d = st.drift.update(dt)
    camera.position.set(p.x + par.x + d.x * 0.12 * strength, p.y + par.y + d.y * 0.08 * strength, p.z + d.z * 0.1 * strength)
    camera.lookAt(t.x + par.x * 0.25, t.y + par.y * 0.2, t.z)
    if (Math.abs(camera.fov - f) > 1e-3) { camera.fov = f; camera.updateProjectionMatrix() }
  }, -1)
  return null
}
