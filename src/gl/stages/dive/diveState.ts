import * as THREE from 'three'
import { settings } from '../../../services/settings'
import { quality } from '../../quality' // PERF HOOK

/**
 * Dive — shared state and the camera path. The stage (GL) and the section (DOM) both read this.
 * World: the lake surface is y = 0 (the hero), the dive heads +z away from the diamond, sinks over a
 * sandy shelf, glides over its drop-off and keeps going until the water is black.
 */
export const DIVE_LAYER = 5
export const dive = {
  u: 0,            // 0..1 progress through the whole section (written by the DOM section)
  camY: 10,        // actual camera height this frame (written by the stage)
  camZ: 0,
  under: false,    // camera below the surface
  split: -1,       // -1 off, 0..1 screen y of the lens waterline while crossing
  under01: 0,      // W18-DIVE OVER-UNDER: 0 above the surface … 1 just after the line has passed the top of the frame
  deep: 0,         // 0..1 extra darkening (the last stretch)
  star: 0,         // 0..1 silt → stars
  active: false,   // the dive stage is showing anything this frame
  pose: new THREE.Vector3(), // the path's camera position this frame (QA: compare with the damped camera)
  // STRUCTURE v2 guide: the sapphire leaves the surface, sinks, and leads you past the work (written by the DOM section)
  gem: new THREE.Vector3(0, 0.45, 0), // where the guide gem should be (world), every frame of the water scene
  gemMix: 0,       // 0 = the hero's own physics place the gem; 1 = dive.gem places it (eases in as the dive starts)
  gemOn: false,    // the dive drives the gem this frame (keep the gem visible under water; the lake may hide)
  // v3 (Shifat 11:56Z): one continuous dive. The Systems section continues the same water, deeper (u 1 → U_MAX)
  gemScale: 1,     // the stone grows a little as it settles at the centre of the UI cylinder in the deep
  abyss: 0,        // 0..1 how deep into the systems water we are (fog density, deep ambient, marine snow)
  sys: 0,          // 0..1 progress through the Systems part of the dive (cylinder turn)
  push: 0,         // W17 Scene 3 entry: 0..1 the camera pushes into the stone (the ring opens, the tablet inside lights up)
}
;(window as any).__dive = dive

/**
 * What the screen-space god-ray pass (src/gl/post/DiveGodRays.ts) reads each frame. The stage owns the
 * occlusion scene (the light: Snell's window + lit water, with the vegetation drawn black over it).
 */
export const diveRays = {
  on: false,                       // the pass runs only while this is true (dive, under water)
  intensity: 0,                    // 0..1 overall gain (fades with depth and at the crossing)
  scene: null as THREE.Scene | null,
  invVP: new THREE.Matrix4(),      // inverse view-projection of the widened mask camera (the pass writes it)
  toSun: new THREE.Vector3(0, 1, 0), // direction toward the sun under water
  sun: new THREE.Vector4(0.5, 1, 0, 1), // the pass writes: sun vanishing point in mask uv (xy), behind camera (z), mask aspect (w)
  scale: settings.TIER === 'high' ? 0.5 : settings.TIER === 'mid' ? 0.4 : 0.3,   // mask/blur resolution vs the render target
  samples: settings.TIER === 'high' ? 40 : settings.TIER === 'mid' ? 28 : 16,    // radial taps in the long pass
  baseScale: settings.TIER === 'high' ? 0.5 : settings.TIER === 'mid' ? 0.4 : 0.3, // PERF HOOK: tier values; the governor scales them
  tint: new THREE.Color(0.42, 0.88, 1.0),
}
;(window as any).__diveRays = diveRays
// PERF HOOK: the god-ray mask/blur resolution follows the governor level (the tap count is compiled into the shader per tier)
quality.on(() => { diveRays.scale = quality.rt(diveRays.baseScale) })

/** Floor height — mirrored 1:1 in GLSL (shaders.ts FLOOR_H). A shelf at −11 that falls away past z ≈ 20. */
export function floorH(x: number, z: number) {
  const edge = 20 + 1.2 * Math.sin(x * 0.23 + 0.7)
  const t = Math.min(1, Math.max(0, (z - edge) / 18))
  const s = t * t * (3 - 2 * t)
  return -11 - 40 * s + 0.45 * Math.sin(x * 0.37 + z * 0.21) * Math.sin(z * 0.17 - x * 0.11)
}

type Key = { u: number; p: [number, number, number]; t: [number, number, number]; h: number }
// u: section progress · p: camera · t: look-at · h: horizontal fov (deg) kept across aspect ratios
const KEYS: Key[] = [
  // STRUCTURE v2: the dive opens on the statement's view of the stone
  { u: 0.00, p: [0, 5.6, 1.8],   t: [0, 0.0, 0.6],  h: 62 },  // the statement's frame: the stone on the lake from above
  // W18-DIVE OVER-UNDER (Shifat 15:29Z + 15:30Z): a crane-down with a slow half arc around the stone (yaw +z → +x → −z,
  // never through the zenith) that settles head-on at eye level, facing the dive (+z); then the lens sinks through the
  // surface (Dive: split = 1 − camY / PORT), the waterline rising across the frame, and we follow the stone down
  { u: 0.07, p: [2.31, 4.0, 2.76], t: [0, 0.1, 0.2], h: 60 },  // the arc begins, still looking down
  { u: 0.13, p: [3.94, 2.1, -0.69], t: [0, 0.15, 0], h: 56 },  // three-quarter, dropping
  { u: 0.19, p: [1.73, 0.95, -3.72], t: [0, 0.14, 0.1], h: 50 }, // almost head-on, low over the water
  { u: 0.235, p: [0.3, 0.6, -3.95], t: [0, 0.1, 0.2], h: 48 },   // head-on at eye level: the waterline enters at the bottom
  { u: 0.27, p: [0.1, 0.3, -3.85], t: [0, 0.05, 0.35], h: 48 },  // over-under: half air, half water, the stone straddling it
  { u: 0.305, p: [0, 0.0, -3.7], t: [0, -0.05, 0.6], h: 50 },    // the line reaches the top of the frame
  { u: 0.35, p: [0, -0.8, -3.2], t: [0, -0.75, 1.6], h: 56 },    // under: the stone hangs ahead in the light, starting to sink
  // (Shifat 09:11Z: the under-the-sea beat stays as it was — from here on the original glide)
  { u: 0.53, p: [0, -3.4, 9.2],  t: [0, 2.6, 16.4], h: 74 },  // hold on the light (title)
  { u: 0.66, p: [0, -5.2, 12.0], t: [0, -6.6, 21],  h: 70 },  // level out over the sand
  { u: 0.80, p: [0, -7.4, 18.0], t: [0, -15, 28],   h: 66 },  // the drop-off
  { u: 0.92, p: [0, -18, 27],    t: [0, -28, 36],   h: 62 },  // falling away (the work slides up over the stone here)
  { u: 1.00, p: [0, -27, 33],    t: [0, -36, 44],   h: 60 },  // deep (the work has passed)
  // v3: we keep sinking — the same water, deeper — and level out facing the stone in its cylinder of UI
  { u: 1.10, p: [0, -33.0, 36.4], t: [0, -39.4, 50], h: 56 },
  { u: 1.22, p: [0.3, -37.9, 38.9], t: [0, -41.5, 50], h: 52 },
  { u: 1.36, p: [0.5, -38.1, 39.0], t: [0, -41.6, 50], h: 52 },
  { u: 1.50, p: [-0.3, -38.3, 39.5], t: [0, -41.7, 50], h: 52 },
]
/** v3: the end of the dive (the systems water) and the centre of the UI cylinder, where the stone settles */
export const U_MAX = 1.5
/** W18-DIVE OVER-UNDER: the virtual dome port. The waterline sits at the bottom of the frame with the lens PORT above
 *  the water and reaches the top as the lens meets it (so the air half is always rendered from above the surface) */
export const PORT = 0.6
export const SYS_C = new THREE.Vector3(0, -40, 50)
/** W17 Scene 3 (13:24Z): where the floating tablet settles, relative to SYS_C (in front of the stone's old place) */
export const TAB_F = new THREE.Vector3(0, 0.05, -0.7)
const curP = new THREE.CatmullRomCurve3(KEYS.map((k) => new THREE.Vector3(...k.p)), false, 'centripetal')
const curT = new THREE.CatmullRomCurve3(KEYS.map((k) => new THREE.Vector3(...k.t)), false, 'centripetal')

function keyParam(u: number) {
  const n = KEYS.length
  if (u <= 0) return { t: 0, h: KEYS[0].h }
  if (u >= KEYS[n - 1].u) return { t: 1, h: KEYS[n - 1].h }
  let i = 0
  while (i < n - 2 && u > KEYS[i + 1].u) i++
  const a = KEYS[i], b = KEYS[i + 1]
  let f = (u - a.u) / (b.u - a.u)
  f = f * f * (3 - 2 * f) * 0.5 + f * 0.5    // soften the speed change at each key
  return { t: (i + f) / (n - 1), h: a.h + (b.h - a.h) * f }
}

/** Camera pose along the dive for progress u; x offsets are tightened on portrait screens by the caller. */
export function divePath(u: number, pos: THREE.Vector3, target: THREE.Vector3) {
  const k = keyParam(u)
  curP.getPoint(k.t, pos); curT.getPoint(k.t, target)
  const fl = floorH(pos.x, pos.z) + 1.6
  if (pos.y < fl) pos.y = fl
  return k.h
}

/** His tools, placed at depths along the glide (x is scaled toward the axis on portrait screens). */
export const TOOL_POS: [number, number, number][] = [
  [-2.1, -4.3, 15.5],
  [2.4, -5.4, 17.2],
  [-1.7, -6.6, 19.6],
  [2.0, -7.7, 22.0],
  [-2.5, -9.6, 24.3],
  [1.9, -12.4, 27.4],
  [-2.0, -15.6, 30.4],
  [2.3, -19.5, 33.6],
]

/** The guide gem's path while it sinks (world). After U_LEAD it rides ahead of the camera, high in the frame. */
const GEM_KEYS: { u: number; p: [number, number, number] }[] = [
  { u: 0.06, p: [0, 0.45, 0] },
  // W18-DIVE OVER-UNDER: the stone settles into the surface (girdle on the waterline: crown in air, pavilion under) for
  // the split shot, then sinks ahead of the lens and leads us into the light
  { u: 0.17, p: [0, 0.12, 0] },
  { u: 0.26, p: [0, 0.03, 0.05] },
  { u: 0.31, p: [0, -0.05, 0.2] },
  { u: 0.37, p: [0, -1.0, 1.9] },
  { u: 0.43, p: [0, -2.4, 8.0] },
  { u: 0.53, p: [0, -1.4, 13.2] },
  { u: 0.64, p: [0, -4.4, 17.0] },
]
const gemCur = new THREE.CatmullRomCurve3(GEM_KEYS.map((k) => new THREE.Vector3(...k.p)), false, 'centripetal')
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _up = new THREE.Vector3()
/**
 * Where the guide gem sits for progress u, given the camera's path pose (pos/target) and vertical fov. While the work
 * is on screen the stone floats in the upper part of the frame, so the cards slide up in FRONT of it and it stays the
 * anchor above them (Shifat 08:54Z).
 */
export function gemPath(u: number, pos: THREE.Vector3, target: THREE.Vector3, vfov: number, time: number, out: THREE.Vector3) {
  const n = GEM_KEYS.length
  if (u <= GEM_KEYS[0].u) out.set(...GEM_KEYS[0].p)
  else {
    let i = 0
    while (i < n - 2 && u > GEM_KEYS[i + 1].u) i++
    const a = GEM_KEYS[i], b = GEM_KEYS[i + 1]
    let f = Math.min(1, (u - a.u) / (b.u - a.u)); f = f * f * (3 - 2 * f) * 0.6 + f * 0.4
    gemCur.getPoint((i + f) / (n - 1), out)
  }
  // ahead of the camera, upper part of the frame (camera space: D in front, k of the half-height above the centre)
  const D = 6.2, k = 0.6
  _f.subVectors(target, pos).normalize()
  _r.crossVectors(_f, _up.set(0, 1, 0)).normalize()
  _up.crossVectors(_r, _f).normalize()
  _a.copy(pos).addScaledVector(_f, D).addScaledVector(_up, D * Math.tan((vfov * Math.PI) / 360) * k)
  _a.y += Math.sin(time * 0.7) * 0.08; _a.x += Math.sin(time * 0.43) * 0.06   // a slow underwater sway
  const t = Math.min(1, Math.max(0, (u - 0.58) / 0.1)), w = t * t * (3 - 2 * t)
  _b.copy(out)
  out.lerpVectors(_b, _a, w)
  // v3: past the work the stone sinks ahead of us and settles at the axis of the UI cylinder
  const t2 = Math.min(1, Math.max(0, (u - 1.0) / 0.2)), w2 = t2 * t2 * (3 - 2 * t2)
  if (w2 > 0) {
    _b.copy(SYS_C); _b.y += Math.sin(time * 0.55) * 0.06; _b.x += Math.sin(time * 0.37) * 0.03
    out.lerp(_b, w2)
  }
  // Scene 3 hand-off (13:24Z): the stone drifts aside and down, back into the fog, as the tablet takes the focus
  if (dive.push > 0) { const p = Math.min(1, dive.push / 0.5), w = p * p * (3 - 2 * p); out.x += 1.6 * w; out.y -= 1.0 * w; out.z += 1.6 * w }
  return out
}
