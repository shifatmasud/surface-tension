import * as THREE from 'three'
import { props } from '../../state/props'
import { browser } from '../../services/settings'
import { vfovFor } from '../../core/frame'
import { smoothstep as ss } from '../../core/math'
import { TAB_F } from '../stages/dive/diveState'

/**
 * world/handoff.ts — OWNED BY THE SCENE LANE from here on (WORLD-MAP v3 §1/§5/§9). Created by the tablet lane (16:55Z,
 * an approved cross-lane exception) with ONLY tabletPose and its constants, so UiCylinder's tablet line can read its pose
 * from here before SCENE lands. SCENE flips FIXED_LENS.on when the fixed lens is in; until then P's moving camera is
 * served by the camera-relative fly in journey/tabletWindow.ts and this keeps the tablet's current rise + bob exactly.
 *
 * The lens (§1): a fixed pedestal at x 0, z 39, looking +z, a static PITCH down-tilt (Tab 16:55Z: −6°), vertical fov
 * F = vfovFor(52, 30, 74), ±1.5° pointer parallax on top. Its height y follows scroll; at the hand-off it is at −40.
 * The tablet (§5): push 0 → 0.5 it rises out of the deep to SYS_C + TAB_F, bobbing; push 0.5 → 1 the TABLET travels
 * (ease in-out) until its glass is square to the lens at the fill distance, its wobble × (1 − push) → none at 1.
 */
export const FIXED_LENS = {
  on: false,
  /** the lens at the hand-off (world) */
  eye: new THREE.Vector3(0, -40, 39),
  /** static down-tilt, degrees (negative = looking down) */
  pitchDeg: -6,
  /** the lens's horizontal fov (F = vfovFor(hfov, 30, 74)) */
  hfov: 52,
}

/** the tablet's display rectangle on its 1.5 × 1.0 glass (half extents; the bezel is outside it) */
export const GLASS_HW = 0.69, GLASS_HH = 0.44
/** the slab's origin sits this far behind its glass (the glass is its local +z) */
export const GLASS_Z = 0.032

/** the glass distance at which the DISPLAY over-covers a frame of this fov/aspect, with an 8 % bleed for the parallax */
export function tabletFillDistance(fovDeg: number, aspect: number) {
  const t = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2)
  return 0.92 * Math.min(GLASS_HH / t, GLASS_HW / (t * aspect))
}

const easeIO3 = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)
const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _s = new THREE.Vector3()
const _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0)

/**
 * The tablet's pose for a push (0..1), written into `out`'s position/quaternion in its parent's space (parent = the
 * cylinder root at SYS_C). With FIXED_LENS.on it ends with its glass centred on the lens axis at the fill distance,
 * normal pointing back up the (tilted) lens axis, no roll or tilt of its own.
 */
export function tabletPose(push: number, out: THREE.Object3D, time = props.time) {
  if (browser.reducedMotion) time = 0 // reduced motion: no bob or wobble (the pose is a pure function of scroll)
  const k1 = ss(0.0, 0.5, push)
  const W = FIXED_LENS.on ? 1 - push : 1
  const bob = 1 - ss(0.6, 1, push)
  out.position.set(TAB_F.x, TAB_F.y - 3.4 * (1 - k1) + Math.sin(time * 0.9) * 0.05 * bob, TAB_F.z)
  out.rotation.set(-0.18 * (1 - k1) + Math.sin(time * 0.7) * 0.02 * W, Math.PI + 0.1 * (1 - k1) + Math.sin(time * 0.5) * 0.025 * W, Math.sin(time * 0.6) * 0.015 * W)
  if (!FIXED_LENS.on || push <= 0.5 || !out.parent) return
  const kk = easeIO3(ss(0.5, 1, push))
  const aspect = props.width / Math.max(1, props.height)
  const d = tabletFillDistance(vfovFor(FIXED_LENS.hfov, 30, 74), aspect)
  const pitch = THREE.MathUtils.degToRad(FIXED_LENS.pitchDeg)
  _f.set(0, Math.sin(pitch), Math.cos(pitch))                       // the lens axis (+z, tilted)
  _m.lookAt(FIXED_LENS.eye, _p.copy(FIXED_LENS.eye).add(_f), _up)   // the lens's own orientation (a camera looks down its −z)
  _q.setFromRotationMatrix(_m)                                      // = the glass facing back at it (the glass normal is local +z)
  _p.copy(FIXED_LENS.eye).addScaledVector(_f, d + GLASS_Z)
  const par = out.parent
  par.updateWorldMatrix(true, false)
  par.worldToLocal(_p)
  par.matrixWorld.decompose(_s, _pq, _s)
  out.position.lerp(_p, kk)
  out.quaternion.slerp(_pq.invert().multiply(_q), kk)
}
