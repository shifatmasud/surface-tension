import * as THREE from 'three'
import { clamp, mix, smoothstep as ss } from '../../../core/math'

/**
 * The whole passage as pure functions of scroll progress p (0..1): any fixed p gives the same still,
 * scrubbing backwards plays it in reverse. Springs downstream add the fluid lag.
 *
 *   0.00–0.24  SPACE    drift in a graded nebula
 *   0.22–0.50  DESCENT  atmosphere entry, dusk → morning, it rights itself and falls
 *   0.50       LAND     forest clearing, squash and settle
 *   0.58–0.74  REVEAL   the camera pulls back: it was all playing on a tablet
 *   0.72–0.80  PRESS    it walks to the glass, the surface bulges under the pressure
 *   0.80–0.86  BREAK    the surface gives like water: it pierces, the membrane snaps into rings, droplets
 *   0.86–1.00  OUT      it floats free into the page; the tablet steps back
 */
export const T = { LAND: 0.5, PULL0: 0.58, PULL1: 0.74, WALK0: 0.715, BREAK: 0.8, SNAP: 0.865 }

const easeIO = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeO = (t: number) => 1 - Math.pow(1 - t, 3)
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a))

export type Inner = {
  crew: THREE.Vector3; yaw: number; pitch: number; roll: number
  walk: number; phase: number; float: number; squash: number; visible: boolean
  cam: THREE.Vector3; look: THREE.Vector3; fov: number
  atmos: number; stars: number; shadow: number
}
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3()

export function inner(p: number, out: Inner, portrait = false) {
  // ---- crewmate
  const fall = easeIO(seg(p, 0.22, T.LAND))
  const alt = 70 * (1 - fall)
  const space = 1 - ss(0.24, 0.42, p)
  const walkZ = mix(0, 2.0, easeIO(seg(p, 0.72, T.BREAK)))
  out.crew.set(Math.sin(p * 9) * 0.35 * space, alt, walkZ)
  const tumble = 1 - ss(0.28, 0.46, p)
  const spaceYaw = 0.55 + Math.sin(p * 5) * 0.35 // a three-quarter view: the visor reads
  const forestYaw = mix(mix(0.6, -0.4, ss(0.52, 0.6, p)), 0, ss(0.62, 0.7, p))
  out.yaw = mix(spaceYaw, forestYaw, ss(0.3, 0.48, p))
  out.pitch = tumble * (0.12 + Math.sin(p * 11) * 0.18)
  out.roll = tumble * (Math.sin(p * 7 + 1) * 0.3 - 0.15)
  out.float = 1 - ss(0.44, 0.5, p)
  out.squash = Math.exp(-Math.pow((p - 0.503) / 0.009, 2))
  out.walk = ss(0.715, 0.73, p) * (1 - ss(0.785, 0.8, p))
  out.phase = (p - 0.715) * 240
  out.visible = p < T.BREAK
  // ---- camera: an orbit in space, a chase from above while falling, eye level in the clearing
  const a = mix(-0.75, 0.45, seg(p, 0, 0.26))
  const offSpace = _a.set(Math.sin(a) * 6.2, 1.1, Math.cos(a) * 6.2)
  const offFall = _b.set(2.6, 0.6, 6.8)
  const offLand = _c.set(mix(0, -1.3, easeIO(seg(p, 0.52, 0.74))), mix(0.2, 0.3, seg(p, 0.52, 0.74)), mix(7.6, 7.0, easeIO(seg(p, 0.52, 0.74))))
  const off = offSpace.lerp(offFall, ss(0.22, 0.36, p)).lerp(offLand, ss(0.38, 0.52, p))
  const anchor = _b.set(out.crew.x, alt + 0.85, Math.min(walkZ, 0)) // camera does not follow the walk: it comes to us
  out.cam.copy(anchor).add(off)
  out.look.set(out.crew.x, alt + 0.85 + 0.75 * ss(0.4, 0.55, p), walkZ * 0.6) // eye level, looking a touch up: more sky, the star against it
  // thirds: in space and the fall the crewmate sits on the left third with lead room ahead of it
  const thirds = portrait ? 0 : (1 - ss(0.4, 0.52, p)) * 1.25 // phones: the frame is narrow, the star stays centred
  const fx = out.look.x - out.cam.x, fz = out.look.z - out.cam.z, fl = Math.hypot(fx, fz) || 1
  out.look.x += (-fz / fl) * thirds; out.look.z += (fx / fl) * thirds
  out.fov = mix(42, 38, ss(0.4, 0.55, p))
  out.atmos = ss(0.24, 0.48, p)
  out.stars = 1 - ss(0.26, 0.4, p)
  out.shadow = ss(0.42, 0.5, p)
  return out
}

export type Outer = {
  camPos: THREE.Vector3; camTarget: THREE.Vector3; fov: number
  crewVisible: boolean; crew: THREE.Vector3; crewScale: number; yaw: number; pitch: number; roll: number; float: number
  bulge: number; width: number; center: THREE.Vector2; ringT: number; ringAmp: number
  dropT: number; bright: number; gloss: number
}

/** Outer world, local to the tablet (screen plane at z = SCREEN_Z, facing +z). */
export function outer(p: number, o: Outer, fit: { dFill: number; dFar: number; lateral: number }, start: { x: number; y: number; k: number }, screenZ: number) {
  // ---- camera
  const pull = easeIO(seg(p, T.PULL0, T.PULL1))
  const lean = easeIO(seg(p, 0.74, T.BREAK))
  const outT = easeIO(seg(p, T.BREAK, 1))
  let d = mix(fit.dFill, fit.dFar, pull) * mix(1, 0.9, lean)
  let az = mix(0, -0.34, pull) + lean * 0.08 + outT * 0.42
  let el = mix(0, 0.13, pull) - outT * 0.05
  d *= mix(1, fit.lateral > 0 ? 0.86 : 1, outT)
  // thirds: the device settles left of centre, leaving the right third for what comes out of it
  o.camTarget.set(fit.lateral * pull, -fit.lateral * 0.25 * pull, 0)
  // ---- crewmate out of the glass
  const k = start.k
  const wrap = seg(p, T.BREAK, T.SNAP)
  const free = easeO(seg(p, T.SNAP, 0.97))
  o.crewVisible = p >= T.BREAK
  // it pushes out slowly while the surface holds on to it, then the surface lets go and it floats free
  const zc = k * (mix(0.06, 0.9, easeIO(wrap)) + free * 1.9)
  const wide = fit.lateral > 0 // landscape: it floats out to the right third; phones: it rises above the device
  o.crew.set(
    start.x + outT * k * (wide ? 2.4 : 0.5),
    start.y + outT * k * (wide ? 0.8 : 2.2),
    screenZ + zc + outT * k * 0.8,
  )
  o.crewScale = k * mix(1, 0.8, outT)
  o.yaw = mix(0, -0.35, ss(0.86, 1, p))
  o.pitch = mix(-0.22, 0.06, ss(T.BREAK, 0.92, p))
  o.roll = mix(0, 0.18, ss(0.86, 1, p))
  o.float = ss(0.84, 0.94, p)
  // camera drifts to keep the star and the tablet in one composed frame
  o.camTarget.lerp(_a.set(o.crew.x * 0.75, o.crew.y * 0.6, o.crew.z * 0.55), outT)
  o.camPos.set(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d).add(_b.set(o.camTarget.x, o.camTarget.y * 0.6, 0))
  o.fov = mix(35, 32, pull)
  // ---- membrane: press → wrap → snap → rings
  const press = ss(0.745, T.BREAK, p)
  o.center.set(start.x, start.y)
  o.width = k * mix(0.45, 0.75, wrap)
  // the meniscus: the surface clings to the body (apex near its waist) and stretches with it
  const cling = k * (press * 0.24 * (1 - wrap) + easeIO(wrap) * 0.82)
  if (p < T.SNAP) {
    o.bulge = cling
    o.ringT = -1; o.ringAmp = 0
  } else {
    const t = (p - T.SNAP) * 16 // pseudo-seconds after the snap
    o.bulge = k * 0.82 * Math.exp(-t * 2.2) * (0.5 + 0.5 * Math.cos(t * 5.2))
    o.ringT = t; o.ringAmp = 0.16 + k * 0.03
  }
  o.dropT = p >= T.SNAP - 0.004 ? (p - (T.SNAP - 0.004)) * 16 : -1
  o.bright = mix(1, 0.62, ss(0.88, 1, p))
  o.gloss = pull
  return o
}
