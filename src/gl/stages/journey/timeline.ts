import * as THREE from 'three'
import { clamp, mix, smoothstep as ss } from '../../../core/math'
import { journey } from './journeyState'

/**
 * The whole passage as pure functions of scroll progress p (0..1): any fixed p gives the same still,
 * scrubbing backwards plays it in reverse. Springs downstream add the fluid lag.
 *
 *   0.00–0.24  SPACE    drift in a graded nebula
 *   0.22–0.50  DESCENT  atmosphere entry, dusk → morning, it rights itself and falls
 *   0.50       LAND     forest clearing, squash and settle
 *   0.58–0.74  REVEAL   the camera pulls back: it was all playing on a tablet
 *   0.715–0.765 WALK   it walks up to the glass
 *   0.772      HIT 1   it throws its weight at the glass: a dull knock, a white star cracks out from the impact
 *   0.788      HIT 2   harder: the cracks race to the bezel, concentric rings join them, the pane goes spider-web
 *   0.80       BREAK   the glass bursts: hundreds of pieces of the picture fly at us in a slow-motion beat
 *   0.86–1.00  OUT      time comes back, the shards clear the frame, it floats free into the page; the tablet steps back
 */
export const T = { LAND: 0.5, PULL0: 0.58, PULL1: 0.74, WALK0: 0.715, HIT1: 0.772, HIT2: 0.788, BREAK: 0.8, SNAP: 0.865 }

/** the windup and the slam of one hit: back, then a short hard lunge into the glass */
function knock(p: number, h: number) {
  const back = Math.exp(-Math.pow((p - (h - 0.0065)) / 0.0035, 2))
  const slam = Math.exp(-Math.pow((p - h) / 0.0016, 2))
  return { z: -0.3 * back + 0.05 * slam, lean: 0.32 * slam - 0.12 * back }
}
/** a decaying shake after an impact, a pure function of scroll (reversible, still when the scroll is still) */
function shake(p: number, h: number, amp: number, seed: number) {
  if (p < h) return 0
  const u = (p - h) * 600
  return amp * Math.exp(-u * 0.55) * Math.sin(u * 2.3 + seed)
}
/**
 * The slow-motion clock of the break, in pseudo-seconds after the burst: the first instant runs fast (the pane
 * explodes), then time all but stops while the pieces hang in the air around it, then it comes back.
 */
export function shatterClock(p: number) {
  if (p < T.BREAK) return -1
  const u = p - T.BREAK
  const rate = (x: number) => mix(mix(36, 4.5, ss(0.0015, 0.007, x)), 26, ss(0.042, 0.07, x))
  const n = 40, h = u / n
  let s = 0
  for (let i = 0; i < n; i++) s += rate((i + 0.5) * h) * h
  return s
}

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

const TUN_OLDEXIT_T = typeof location !== 'undefined' && /[?&]tunexit=old\b/.test(location.search)
export function inner(p: number, out: Inner, portrait = false) {
  // ---- crewmate
  const fall = easeIO(seg(p, 0.22, T.LAND))
  const alt = 70 * (1 - fall)
  const space = 1 - ss(0.24, 0.42, p)
  const k1 = knock(p, T.HIT1), k2 = knock(p, T.HIT2), k3 = knock(p, T.BREAK)
  const walkZ = mix(0, 2.0, easeIO(seg(p, 0.72, 0.766))) + k1.z + k2.z * 1.2 + (p < T.BREAK ? k3.z * 1.3 : 0)
  out.crew.set(Math.sin(p * 9) * 0.35 * space, alt, walkZ)
  const tumble = 1 - ss(0.28, 0.46, p)
  const spaceYaw = 0.55 + Math.sin(p * 5) * 0.35 // a three-quarter view: the visor reads
  const forestYaw = mix(mix(0.6, -0.4, ss(0.52, 0.6, p)), 0, ss(0.62, 0.7, p))
  out.yaw = mix(spaceYaw, forestYaw, ss(0.3, 0.48, p))
  out.pitch = tumble * (0.12 + Math.sin(p * 11) * 0.18) + (k1.lean + k2.lean * 1.2 + k3.lean * 1.3) * ss(0.7, 0.75, p)
  out.roll = tumble * (Math.sin(p * 7 + 1) * 0.3 - 0.15)
  out.float = 1 - ss(0.44, 0.5, p)
  out.squash = Math.exp(-Math.pow((p - 0.503) / 0.009, 2))
  out.walk = ss(0.715, 0.73, p) * (1 - ss(0.758, 0.768, p))
  out.phase = (p - 0.715) * 240
  out.visible = p < T.BREAK
  // ---- camera: an orbit in space, a chase from above while falling, eye level in the clearing
  const a = mix(-0.75, 0.45, seg(p, 0, 0.26))
  // R6.88 (Shifat 10:09 PM: "Make crewmate a bit farther away from camera to keep small scale. Too big hero looks bad"):
  // in space the orbit stands 1.5x farther off (the crewmate reads at ~2/3 of its old size, a small figure in a big sky),
  // easing back to the old orbit inside the tunnel. The glass's portal and the sky's frame read this same function, so
  // the crewmate is the same size through the glass, through the portal push and inside
  const far = mix(1.5, 1.0, ss(0.1, 0.3, p))
  const offSpace = _a.set(Math.sin(a) * 6.2 * far, 1.1 * far, Math.cos(a) * 6.2 * far)
  // b7-tunnel-v2d (root 12:25: "the treeline visible through the mouth across 66-70 %"): out of the tube the camera was
  // level with the crewmate at ~55 m, so the forest sat below the frame and the exit was a dark dusk gap. It now rises
  // (v2d 2.2 m; v2f 1.8 m, see below) above the crewmate as the mouth comes in (p 0.26 -> 0.32) and looks down ~15 deg onto it, so the treeline and
  // the land come up through the mouth; the landing orbit (offLand, p 0.38 -> 0.52) takes it back down exactly as before.
  // ?tunexit=old = the old level camera (A/B)
  // v2f (Tester cost: 70 % was x1.25, the foliage/ground pass 575 -> 844 because the raised camera saw land + trees all the
  // way down): a smaller rise (1.8 m, ~12 deg down) that holds through the mouth and settles back to the old level camera
  // by p 0.385 (~69 %), so from ~69.5 % on the frame (and its cost) is exactly live's
  const offFall = _b.set(2.6, 0.6 + (TUN_OLDEXIT_T ? 0 : 1.8 * ss(0.26, 0.32, p) * (1 - ss(0.33, 0.385, p))), 6.8)
  const offLand = _c.set(mix(0, -1.3, easeIO(seg(p, 0.52, 0.74))), mix(0.2, 0.3, seg(p, 0.52, 0.74)), mix(7.6, 7.0, easeIO(seg(p, 0.52, 0.74))))
  const off = offSpace.lerp(offFall, ss(0.22, 0.36, p)).lerp(offLand, ss(0.38, 0.52, p))
  const anchor = _b.set(out.crew.x, alt + 0.85, Math.min(walkZ, 0)) // camera does not follow the walk: it comes to us
  out.cam.copy(anchor).add(off)
  // each hit jolts the picture (the camera inside the device takes the blow)
  const jx = shake(p, T.HIT1, 0.05, 0) + shake(p, T.HIT2, 0.09, 1.3), jy = shake(p, T.HIT1, 0.04, 2.1) + shake(p, T.HIT2, 0.07, 0.4)
  out.cam.x += jx; out.cam.y += jy
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
  /** cracks: radial reach and concentric reach (local units from the impact), the crushed spot, the askew tilt */
  crackR: number; ringR: number; frost: number; tilt: number
  /** slow-motion seconds since the burst (-1 before it), the radius the hole tears out to, the screen behind */
  shatterT: number; hole: number; screenBright: number; shardsVisible: boolean
}

/** Outer world, local to the tablet (screen plane at z = SCREEN_Z, facing +z). `far` = impact → farthest screen corner. */
export function outer(p: number, o: Outer, fit: { dFill: number; dFar: number; lateral: number }, start: { x: number; y: number; k: number }, screenZ: number, far = 9) {
  // ---- camera
  const pull = easeIO(seg(p, T.PULL0, T.PULL1))
  const lean = easeIO(seg(p, 0.74, T.BREAK))
  const outT = easeIO(seg(p, T.BREAK, 1))
  // the slow-motion beat: the camera eases in on the burst while time hangs, then lets go
  const beat = ss(T.BREAK, T.BREAK + 0.008, p) * (1 - ss(0.84, 0.875, p))
  let d = mix(fit.dFill, fit.dFar, pull) * mix(1, 0.9, lean) * (1 - 0.085 * beat)
  let az = mix(0, -0.34, pull) + lean * 0.08 + outT * 0.42
  let el = mix(0, 0.13, pull) - outT * 0.05
  d *= mix(1, fit.lateral > 0 ? 0.86 : 1, outT)
  // thirds: the device settles left of centre, leaving the right third for what comes out of it
  o.camTarget.set(fit.lateral * pull, -fit.lateral * 0.25 * pull, 0)
  // ---- crewmate out of the glass: it bursts through on the slow-motion clock, then floats free
  const k = start.k
  const ts = shatterClock(p)
  const burst = ts > 0 ? 1 - Math.exp(-ts * 2.4) : 0
  const free = easeO(seg(p, T.SNAP, 0.97))
  o.crewVisible = p >= T.BREAK
  const zc = k * (0.06 + 1.05 * burst + free * 1.75)
  const wide = fit.lateral > 0 // landscape: it floats out to the right third; phones: it rises above the device
  o.crew.set(
    start.x + outT * k * (wide ? 2.4 : 0.5),
    start.y + outT * k * (wide ? 0.8 : 2.2),
    screenZ + zc + outT * k * 0.8,
  )
  o.crewScale = k * mix(1, 0.8, outT)
  o.yaw = mix(0, -0.35, ss(0.86, 1, p))
  o.pitch = mix(-0.3, 0.06, ss(T.BREAK, 0.92, p))
  o.roll = mix(0, 0.18, ss(0.86, 1, p))
  o.float = ss(0.84, 0.94, p)
  // camera drifts to keep the star and the tablet in one composed frame
  o.camTarget.lerp(_a.set(o.crew.x * 0.75, o.crew.y * 0.6, o.crew.z * 0.55), outT)
  o.camPos.set(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d).add(_b.set(o.camTarget.x, o.camTarget.y * 0.6, 0))
  // the blows reach us too: a small jolt per hit, a real shake on the burst
  const sx = shake(p, T.HIT1, 0.035, 0.3) + shake(p, T.HIT2, 0.07, 1.1) + shake(p, T.BREAK, 0.2, 2.0)
  const sy = shake(p, T.HIT1, 0.03, 1.7) + shake(p, T.HIT2, 0.06, 0.2) + shake(p, T.BREAK, 0.16, 0.9)
  o.camPos.x += sx; o.camPos.y += sy; o.camTarget.x += sx * 0.5; o.camTarget.y += sy * 0.5
  o.fov = mix(35, 32, pull)
  // ---- the glass: two hits crack it, the third bursts it (no water any more: bulge, rings and droplets stay off)
  o.center.set(start.x, start.y)
  o.width = k; o.bulge = 0; o.ringT = -1; o.ringAmp = 0; o.dropT = -1
  const c1 = easeO(seg(p, T.HIT1, T.HIT1 + 0.004)), c2 = easeO(seg(p, T.HIT2, T.HIT2 + 0.009))
  o.crackR = Math.max(c1 * 1.15 * k, c2 * far * 1.05)
  o.ringR = Math.max(c1 * 0.38 * k, c2 * far * 0.55)
  o.frost = 0.55 * ss(T.HIT1, T.HIT1 + 0.002, p) + 0.45 * ss(T.HIT2, T.HIT2 + 0.002, p)
  o.tilt = ss(T.HIT2, T.HIT2 + 0.006, p)
  o.shardsVisible = p >= T.HIT1 - 0.0015
  o.shatterT = ts
  o.hole = far * 0.52
  o.bright = mix(1, 0.62, ss(0.88, 1, p))
  o.screenBright = o.bright * mix(1, 0.4, ss(T.BREAK, T.BREAK + 0.005, p))
  o.gloss = pull
  // (W18) the CTA glide/alignment now lives in JourneyStage (ctaScene.ts layout): the wall, the type and the stickers
  journey.crew.set(o.crew.x + 200, o.crew.y, o.crew.z)
  journey.crewScale = o.crewScale
  return o
}
