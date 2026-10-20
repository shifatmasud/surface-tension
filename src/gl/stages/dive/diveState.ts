import * as THREE from 'three'

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
  deep: 0,         // 0..1 extra darkening (the last stretch)
  star: 0,         // 0..1 silt → stars
  active: false,   // the dive stage is showing anything this frame
  pose: new THREE.Vector3(), // the path's camera position this frame (QA: compare with the damped camera)
}
;(window as any).__dive = dive

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
  { u: 0.00, p: [0, 4.6, 3.2],   t: [0, -0.2, 11],  h: 66 },  // over the lake, looking down the water
  { u: 0.26, p: [0, 0.55, 6.6],  t: [0, -0.15, 16], h: 68 },  // skimming the surface
  { u: 0.34, p: [0, -0.9, 7.6],  t: [0, -1.25, 17], h: 70 },  // through
  { u: 0.42, p: [0, -2.6, 8.4],  t: [0, 1.9, 15.6], h: 74 },  // tilt up: the window opens overhead
  { u: 0.53, p: [0, -3.4, 9.2],  t: [0, 2.6, 16.4], h: 74 },  // hold on the light (title)
  { u: 0.66, p: [0, -5.2, 12.0], t: [0, -6.6, 21],  h: 70 },  // level out over the sand
  { u: 0.80, p: [0, -7.4, 18.0], t: [0, -15, 28],   h: 66 },  // the drop-off
  { u: 0.92, p: [0, -18, 27],    t: [0, -28, 36],   h: 62 },  // falling away
  { u: 1.00, p: [0, -27, 33],    t: [0, -36, 44],   h: 60 },  // black
]
const curP = new THREE.CatmullRomCurve3(KEYS.map((k) => new THREE.Vector3(...k.p)), false, 'centripetal')
const curT = new THREE.CatmullRomCurve3(KEYS.map((k) => new THREE.Vector3(...k.t)), false, 'centripetal')

function keyParam(u: number) {
  const n = KEYS.length
  if (u <= 0) return { t: 0, h: KEYS[0].h }
  if (u >= 1) return { t: 1, h: KEYS[n - 1].h }
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
