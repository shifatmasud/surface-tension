import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useMemo } from 'react'
import { visuals, type Pose } from './visuals'
import { props, makeLook } from '../../state/props'
import { input } from '../../services/input'
import { Spring3, Spring } from '../../core/spring'
import { BrownianMotion } from '../../core/math'
import { tilt } from '../../services/tilt'
import { clip } from './clip'

const FINE_POINTER = typeof matchMedia === 'function' ? matchMedia('(any-pointer: fine)').matches : true
const REDUCED = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false
// the handheld operator is a polish item awaiting the OK for LIVE: on everywhere except the live host (or with ?cam)
const OPERATOR = typeof location === 'undefined' || location.hostname !== 'shifat-surface-tension.sites.tab.bot' || /[?&]cam/.test(location.search)
/** critically damped follow (Shifat 15:30Z "mouse/touch move smoothly animates camera like real life"): w = 6.2 rad/s
 *  settles in ~0.75 s with no overshoot */
class Crit { x = 0; v = 0; constructor(public w = 6.2) {} step(t: number, dt: number) { const a = this.w * this.w * (t - this.x) - 2 * this.w * this.v; this.v += a * dt; this.x += this.v * dt; return this.x } }

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
    last: new THREE.Vector3(NaN, NaN, NaN),
    op: { yaw: new Crit(), pitch: new Crit(), roll: new Crit(4.2), k: 1, t: 0 },
    // DBLCREW: the frame the springs were cut to a pose (new block owner / pose jump), the offsets laid on top of the
    // springs that frame (parallax + drift, the look's parallax, the operator's turn) and a scratch pose/look for the re-read
    cutAt: -1, off: new THREE.Vector3(), lookOff: new THREE.Vector2(), opYaw: 0, opPitch: 0, opOn: false,
    fresh: { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 35 } as Pose, freshLook: makeLook(),
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
        st.cutAt = props.frame
      }
    }
    // a pose that JUMPS (a deep link / nav jump lands on a stage whose pose was stale the frame before, e.g. the
    // footer's wall 30 m from where the journey last left it) is a cut, never a spring flight across the scene
    if (st.last.distanceTo(st.pose.pos) > 12) {
      st.pos.x.reset(st.pose.pos.x); st.pos.y.reset(st.pose.pos.y); st.pos.z.reset(st.pose.pos.z)
      st.tgt.x.reset(st.pose.target.x); st.tgt.y.reset(st.pose.target.y); st.tgt.z.reset(st.pose.target.z)
      st.fov.reset(st.pose.fov)
      st.cutAt = props.frame
    }
    st.last.copy(st.pose.pos)
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
    st.off.set(par.x + d.x * 0.12 * strength, par.y + d.y * 0.08 * strength, d.z * 0.1 * strength); st.lookOff.set(par.x * 0.25, par.y * 0.2); st.opOn = false
    // the handheld operator (Shifat 15:30Z): small yaw/pitch toward the cursor (desktop) or the touch-drag point
    // (phones, only while the finger is down), a lagging roll, a 0.1–0.3° float and a breath of lens — layered on top
    // of the scroll camera as a rotation about the lens, so it never moves the subject off its mark. Reduced motion: off.
    if (!REDUCED && OPERATOR) {
      const O = st.op
      const touching = input.isTouch && input.isDown
      const tx = fine ? input.mouseXY.x : touching ? input.mouseXY.x : 0
      const ty = fine ? input.mouseXY.y : touching ? input.mouseXY.y : 0
      // stages with an exact composition (the journey's screen fills the viewport) take a smaller share
      O.k += ((props.overlayOpen ? 0 : props.stage === 'journey' ? 0.35 : 1) - O.k) * (1 - Math.exp(-3 * dt))
      // Shifat 16:33Z: one fixed front-facing camera; only a subtle eased pointer parallax (about ±1.5°)
      const yaw = O.yaw.step(-tx * 0.026 * O.k, dt)          // ±1.5°
      const pitch = O.pitch.step(ty * 0.018 * O.k, dt)       // ±1.0°
      camera.rotateY(yaw); camera.rotateX(pitch)
      st.opOn = true; st.opYaw = yaw; st.opPitch = pitch
      if (Math.abs(camera.fov - f) > 1e-3) { camera.fov = f; camera.updateProjectionMatrix() }
    } else if (Math.abs(camera.fov - f) > 1e-3) { camera.fov = f; camera.updateProjectionMatrix() }
  }, -1)
  // DBLCREW (Shifat 17:28Z: "one big crewmate & inside one regular size one ... first few frames in starry space"): a stage
  // writes its pose in its own frame callback (priority 0, e.g. journey.pose), AFTER this rig read it (-1). On the frame the
  // springs are cut to a new block's pose, that pose is the one the stage left behind the last time it ran (on the first
  // entry into the journey, its default: closer than the opening shot), so the incoming scene started magnified and the
  // springs then pulled it back over ~0.75 s, under the systems → journey crossfade: a big crewmate around the real one.
  // Worse, the incoming stage often does not run at all on the cut frame (Journey.tsx reads clip.allowed() in
  // sections.update, before clip.update() hands it the block), so its first real pose arrives a frame later, as a spring
  // target. On a cut frame and the two after it only: once the stages have written this frame's poses, re-read them (no
  // side effects) and, if they differ from the pose the springs were cut to, re-cut the springs and the lens to them before
  // the frame renders (priority 1). Every other frame is untouched.
  useFrame(() => {
    if (st.cutAt < 0 || props.frame - st.cutAt > 2 || props.frame < st.cutAt) return
    const P = st.fresh
    if (!visuals.resolvePure(P, st.freshLook)) return
    if (P.pos.distanceToSquared(st.pose.pos) < 1e-10 && P.target.distanceToSquared(st.pose.target) < 1e-10 && Math.abs(P.fov - st.pose.fov) < 1e-6) return
    st.pose.pos.copy(P.pos); st.pose.target.copy(P.target); st.pose.fov = P.fov
    st.pos.x.reset(P.pos.x); st.pos.y.reset(P.pos.y); st.pos.z.reset(P.pos.z)
    st.tgt.x.reset(P.target.x); st.tgt.y.reset(P.target.y); st.tgt.z.reset(P.target.z)
    st.fov.reset(P.fov)
    st.last.copy(P.pos)
    camera.position.copy(P.pos).add(st.off)
    camera.lookAt(P.target.x + st.lookOff.x, P.target.y + st.lookOff.y, P.target.z)
    if (st.opOn) { camera.rotateY(st.opYaw); camera.rotateX(st.opPitch) }
    if (Math.abs(camera.fov - P.fov) > 1e-3) { camera.fov = P.fov; camera.updateProjectionMatrix() }
    camera.updateMatrixWorld()
  }, 0.5)
  return null
}
