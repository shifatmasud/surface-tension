import * as THREE from 'three'
import { props } from '../../state/props'
import { input } from '../../services/input'
import type { HeroPhysics } from '../stages/hero/HeroPhysics'

/** Projects the pointer onto the pool plane (y = 0) and feeds both the GPU sim and the CPU ring field. */
const ray = new THREE.Raycaster()
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const hit = new THREE.Vector3()
export const pool = {
  size: 22,
  physics: null as HeroPhysics | null,
  pointer: { x: 0, z: 0, vx: 0, vz: 0, active: false },
  ringClock: 0,
  update(camera: THREE.Camera, dt: number) {
    const p = this.pointer
    const usable = input.everMoved && camera.position.y > 0.2 && props.look.dive < 0.5 && !props.overlayOpen
    ray.setFromCamera(new THREE.Vector2(input.mouseXY.x, input.mouseXY.y), camera)
    const ok = usable && ray.ray.intersectPlane(plane, hit)
    if (ok) {
      const nx = hit.x, nz = hit.z
      if (p.active) { p.vx = (nx - p.x) / Math.max(dt, 1e-3); p.vz = (nz - p.z) / Math.max(dt, 1e-3) }
      p.x = nx; p.z = nz
    } else { p.vx *= 0.9; p.vz *= 0.9 }
    const moving = !!ok && (input.hadMoved || Math.abs(props.scrollDelta) > 0)
    p.active = !!ok
    props.waterPointerActive = moving && Math.abs(p.x) < this.size / 2 && Math.abs(p.z) < this.size / 2
    props.waterPointer.set(p.x / this.size + 0.5, -p.z / this.size + 0.5)
    // CPU ring mirror: emit rings along a fast stroke so tiles bob with what you see
    this.ringClock -= dt
    const sp = Math.hypot(p.vx, p.vz)
    if (props.waterPointerActive && sp > 2 && this.ringClock <= 0) { this.physics?.addRing(p.x, p.z, Math.min(0.05 + sp * 0.006, 0.18)); this.ringClock = 0.09 }
  },
  drop(x: number, z: number, strength = 0.08, radius = 0.04) {
    props.drops.push({ x: x / this.size + 0.5, y: -z / this.size + 0.5, r: radius, s: strength })
    this.physics?.addRing(x, z, strength * 3.2)
  },
}
