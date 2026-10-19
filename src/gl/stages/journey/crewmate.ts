import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { Spring } from '../../../core/spring'

/**
 * The crewmate, modelled in code: a bean body with a backpack, two stubby legs hinged at the hip,
 * a wide glossy visor. Origin = between the feet; height ≈ 1.55 units.
 */
export const CREW_HEIGHT = 1.55
export const CREW_CENTER_Y = 0.85

let shared: { body: THREE.BufferGeometry; leg: THREE.BufferGeometry; visor: THREE.BufferGeometry } | null = null
export function crewGeometry(lowPoly = false) {
  if (shared) return shared
  const seg = lowPoly ? 14 : 28
  const body = new THREE.CapsuleGeometry(0.44, 0.42, lowPoly ? 6 : 10, seg)
  body.scale(1, 1, 0.92); body.translate(0, 0.9, 0)
  const pack = new RoundedBoxGeometry(0.58, 0.68, 0.34, lowPoly ? 2 : 4, 0.12)
  pack.translate(0, 0.9, -0.38)
  const bodyGeo = mergeGeometries([body.toNonIndexed(), pack.toNonIndexed()])!
  bodyGeo.computeBoundingSphere()
  // leg pivots at the hip (y = 0.42): geometry hangs below its origin
  const leg = new THREE.CapsuleGeometry(0.175, 0.2, lowPoly ? 4 : 6, lowPoly ? 10 : 18)
  leg.translate(0, -0.2, 0)
  const visor = new THREE.CapsuleGeometry(0.165, 0.32, lowPoly ? 6 : 10, lowPoly ? 14 : 28)
  visor.rotateZ(Math.PI / 2); visor.scale(1, 1, 0.5)
  shared = { body: bodyGeo, leg, visor }
  return shared
}

export function crewMaterials(env: THREE.Texture | null) {
  const body = new THREE.MeshPhysicalMaterial({
    color: '#d61f26', roughness: 0.4, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.22,
    envMap: env, envMapIntensity: 0.9, fog: false,
  })
  const visor = new THREE.MeshPhysicalMaterial({
    color: '#c3d0d9', roughness: 0.05, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.03,
    envMap: env, envMapIntensity: 1.4, fog: false,
  })
  return { body, visor }
}

export type CrewTarget = {
  pos: THREE.Vector3
  yaw: number; pitch: number; roll: number
  walk: number      // 0..1 how much it is walking
  phase: number     // walk cycle phase (radians)
  float: number     // 0..1 weightless (legs drift apart)
  squash: number    // 0..1 impact squash
  scale: number
}

/** A crewmate rig: springs give every input second-order lag — bob, lean, leg dangle — so it never snaps. */
export class Crewmate {
  root = new THREE.Group()
  body: THREE.Mesh
  visor: THREE.Mesh
  legL = new THREE.Group()
  legR = new THREE.Group()
  private yaw = new Spring(0, 0.9, 0.85, 0)
  private pitch = new Spring(0, 0.9, 0.8, 0)
  private roll = new Spring(0, 0.9, 0.8, 0)
  private lean = new Spring(0, 1.2, 0.45, 0)
  private sq = new Spring(1, 2.4, 0.32, 0)
  private lL = new Spring(0, 1.5, 0.38, 0)
  private lR = new Spring(0, 1.5, 0.38, 0)
  private lastY = 0

  constructor(mats: { body: THREE.Material; visor: THREE.Material }, lowPoly = false) {
    const g = crewGeometry(lowPoly)
    this.body = new THREE.Mesh(g.body, mats.body)
    this.visor = new THREE.Mesh(g.visor, mats.visor)
    this.visor.position.set(0, 1.16, 0.355)
    this.visor.rotation.x = -0.12
    const lm = new THREE.Mesh(g.leg, mats.body), rm = new THREE.Mesh(g.leg, mats.body)
    this.legL.add(lm); this.legR.add(rm)
    this.legL.position.set(-0.21, 0.42, 0.02); this.legR.position.set(0.21, 0.42, 0.02)
    // pivot group so squash happens from the feet and rotation from the belly
    const inner = new THREE.Group()
    inner.add(this.body, this.visor, this.legL, this.legR)
    inner.position.y = -CREW_CENTER_Y
    const spin = new THREE.Group(); spin.position.y = CREW_CENTER_Y; spin.add(inner)
    this.root.add(spin)
    ;(this as any)._spin = spin
  }

  update(t: CrewTarget, dt: number, time: number, snap: boolean) {
    const spin = (this as any)._spin as THREE.Group
    if (snap) {
      this.yaw.reset(t.yaw); this.pitch.reset(t.pitch); this.roll.reset(t.roll)
      this.lean.reset(0); this.sq.reset(1 - t.squash * 0.16); this.lastY = t.pos.y
    }
    const vy = dt > 0 ? (t.pos.y - this.lastY) / dt : 0
    this.lastY = t.pos.y
    const yaw = this.yaw.update(t.yaw, dt), pitch = this.pitch.update(t.pitch, dt), roll = this.roll.update(t.roll, dt)
    // falling makes it lean back slightly; the spring makes it sway when it stops
    const lean = this.lean.update(THREE.MathUtils.clamp(vy * 0.012, -0.25, 0.25), dt)
    const sq = this.sq.update(1 - t.squash * 0.16, dt)
    const bob = Math.sin(time * 1.1) * 0.06 * t.float + Math.abs(Math.sin(t.phase)) * 0.05 * t.walk
    this.root.position.copy(t.pos)
    this.root.position.y += bob * t.scale
    this.root.scale.setScalar(t.scale)
    spin.rotation.set(pitch + lean, yaw, roll + Math.sin(t.phase) * 0.05 * t.walk + Math.sin(time * 0.7) * 0.05 * t.float, 'YXZ')
    spin.scale.set(1 + (1 - sq) * 0.5, sq, 1 + (1 - sq) * 0.5)
    // legs: walk swing + weightless drift, all through springs
    const swing = Math.sin(t.phase) * 0.55 * t.walk
    const drift = t.float * (0.28 + Math.sin(time * 0.9) * 0.12)
    const tl = swing + drift * 0.6 - vy * 0.004, tr = -swing - drift * 0.4 - vy * 0.004
    if (snap) { this.lL.reset(tl); this.lR.reset(tr) }
    this.legL.rotation.set(this.lL.update(tl, dt), 0, -drift * 0.35)
    this.legR.rotation.set(this.lR.update(tr, dt), 0, drift * 0.3)
  }
}
