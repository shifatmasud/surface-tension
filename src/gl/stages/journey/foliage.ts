import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { groundHeight, buildShadows } from './forest'
import { grassVert, grassFrag, floorVert, floorFrag, treeVert, treeFrag } from './foliageShaders'
import { runToEnd } from '../../prewarm' // PERFGOV

/**
 * FOLIAGE — the fluffy, cinema-grade grass and trees of the journey clearing (Shifat 08:54Z: "crewmate is the hero.
 * Ensure better fluffy grass & trees in the scene").
 *
 *  - grass: dense instanced blades grown in tufts (one draw), each tuft a soft dome; wind gusts roll across the
 *    field, tips transmit the low sun, the turf is darker at the roots, and the blades part around the crewmate's
 *    feet. Same 100k blades on every tier, cut into 12 frustum-culled chunks with a 3-step distance LOD (PERF lane,
 *    eng #10); far blades widen and sink into the floor before the field ends.
 *  - meadow floor: the ground re-shaded to the turf's own colours, so there are no dark gaps between blades and the
 *    far meadow reads as grass seen from a grazing angle.
 *  - trees: fewer, better, composed to frame the crewmate (a clear sky gap behind it). Each crown is a cluster of
 *    lobes with a dark inner core plus camera-facing leaf-cluster cards, all sharing the crown's outward normal
 *    (the "cotton" shading), with gold translucency through the edges, a warm rim and a gentle sway.
 *  - depth: foreground warmer/lighter, background cooler, lower-contrast and hazier (foliageShaders FOLIAGE_DEPTH).
 * Everything is procedural: no textures. Two to five draw calls in all.
 */

type Tier = 'low' | 'mid' | 'high'
export type FoliageOptions = {
  low: boolean; tier: Tier; portrait: boolean; sunDir: THREE.Vector3
  /** the forest group from buildForest (its ground is re-shaded, its old tree meshes are replaced) */
  forest: THREE.Group
  /** the old long-shadow decals (replaced by decals under the new trees) */
  shadows?: THREE.Object3D
}

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) }
const C = (h: string) => new THREE.Color(h)

/** shared light + palette, one set of uniforms for every foliage material */
function makeUniforms(sunDir: THREE.Vector3) {
  return {
    u_time: { value: 0 }, u_light: { value: 1 },
    u_sun: { value: sunDir.clone().normalize() }, u_sunCol: { value: C('#ffd9a8') },
    u_sky: { value: C('#9fbad0') }, u_bounce: { value: C('#4f7a3c') },
    u_haze: { value: C('#7fa6a2') }, u_warm: { value: new THREE.Vector3(1.1, 1.04, 0.9) },
    // turf: deep warm root -> fresh mid -> sunlit yellow-green tips, dry straw patches
    u_base: { value: C('#2a5a2c') }, u_mid: { value: C('#4a9440') }, u_tip: { value: C('#94c457') }, u_dry: { value: C('#c9cc72') },
    u_trans: { value: C('#ffd27a') },
    // crowns: cool teal shadow -> lush mid -> sunlit lime
    u_leafDark: { value: C('#245443') }, u_leafMid: { value: C('#3f8f45') }, u_leafLight: { value: C('#a6d865') },
    u_rimCol: { value: C('#ffcf8f') },
    u_crew: { value: new THREE.Vector3(0, 10, 0) },
  }
}
type U = ReturnType<typeof makeUniforms>

// ================================================================================================ grass
/** PERFGOV: a generator so the build can be spread over frames behind the preloader (prewarm.ts); run to the end in one
 *  go it is the same function as before (same RNG order, same buffers) */
function* buildFluffyGrass(o: FoliageOptions, U: U): Generator<void, { mesh: THREE.Group; material: THREE.ShaderMaterial; count: number }> {
  const tier: Tier = o.low ? 'low' : o.tier
  // PERF HOOK (Shifat 10:21Z: same object count on every tier): every tier plants the same 100k blades over the same
  // field with the same blade width; only the blade's geometry gets cheaper (5 / 3 / 2 segments = 27 / 15 / 9 verts)
  const count = 100000
  const segs = tier === 'high' ? 5 : tier === 'mid' ? 3 : 2
  const range = 30
  // the blade: a tapered strip with a rounded tip (x across -0.5..0.5, y 0..1)
  const wAt = (y: number) => Math.pow(1 - y, 0.75) * (0.9 + 0.1 * Math.sin(y * 3))
  const blade = (n: number) => {
    const v: number[] = []
    for (let i = 0; i < n; i++) {
      const y0 = i / n, y1 = (i + 1) / n, w0 = wAt(y0) * 0.5, w1 = wAt(y1) * 0.5
      if (i < n - 1) v.push(-w0, y0, 0, w0, y0, 0, w1, y1, 0, -w0, y0, 0, w1, y1, 0, -w1, y1, 0)
      else v.push(-w0, y0, 0, w0, y0, 0, 0, 1, 0)
    }
    return v
  }
  // ENG #10 (PERF lane): distance LOD without changing the count. One vertex buffer holds the blade at three
  // resolutions back to back (tier segs | about half | a single triangle); each chunk draws the sub-range its
  // distance asks for (drawRange start/count on an instanced draw), so far blades cost 3 verts instead of 9–27
  const lodSegs = [segs, Math.max(1, Math.ceil(segs / 2)), 1]
  const lodV = lodSegs.map(blade)
  const lodRange: [number, number][] = []
  { let st = 0; for (const lv of lodV) { lodRange.push([st, lv.length / 3]); st += lv.length / 3 } }
  const posAttr = new THREE.Float32BufferAttribute(lodV.flat(), 3)
  const off = new Float32Array(count * 4), prm = new Float32Array(count * 4), clump = new Float32Array(count * 4)
  const band = new Uint8Array(count)
  const r = rng(1311)
  // the landing camera sits around (-0.6, 1, 7.4) looking down -z at the clearing: fill that wedge, denser near
  const camX = -0.6, camZ = 7.6, spread = o.portrait ? 0.36 : 0.72
  const widthScale = 1.15 // PERF HOOK: one blade width for every tier (the count no longer differs)
  // ENG #10: spatial chunks (by tuft, so a tuft never splits): 4 depth bands x 3 columns of the wedge. Each chunk is
  // its own draw with a real bounding sphere, so three's frustum test drops the ones off screen (phones' narrow
  // portrait frame, the descent shot, the close crewmate shots), and the band edges line up with the LOD steps
  const BANDS = [5, 10, 17, Infinity], COLS = 3
  let i = 0, nextYield = 4096 // PERFGOV
  while (i < count) {
    if (i >= nextYield) { nextYield += 4096; yield } // PERFGOV
    // one tuft (clump) of blades
    const d = 0.6 + Math.pow(r(), 1.9) * range
    const half = 1.0 + d * spread
    const u = r() * 2 - 1
    const cx = camX + u * half, cz = camZ - d
    const cr = (0.1 + r() * 0.14) * (1 + d * 0.02) * Math.sqrt(widthScale)
    const n = 10 + Math.floor(r() * 14)
    const tint = r()
    const nearCrew = THREE.MathUtils.smoothstep(Math.hypot(cx, cz - 0.6), 0.5, 3.2) // shorter turf at the feet
    const edge = 1 - THREE.MathUtils.smoothstep(-cz, 16, 24) * 0.35
    const hTuft = (0.27 + r() * 0.2) * (0.55 + 0.45 * nearCrew) * edge * (0.85 + 0.3 * THREE.MathUtils.smoothstep(d, 2, 18))
    let bi = 0; while (d >= BANDS[bi]) bi++
    const chunk = bi * COLS + Math.min(COLS - 1, Math.floor((u + 1) * 0.5 * COLS))
    for (let k = 0; k < n && i < count; k++, i++) {
      const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * cr
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr
      off.set([x, groundHeight(x, z) - 0.02, z, r()], i * 4)
      prm.set([hTuft * (0.65 + r() * 0.55), (0.024 + r() * 0.02) * widthScale, r() * Math.PI, 0.45 + r() * 0.45], i * 4)
      clump.set([cx, cz, cr, tint], i * 4)
      band[i] = chunk
    }
  }
  // sort the blades by chunk (counting sort, stable) into one buffer per attribute; each chunk views its slice
  const NC = BANDS.length * COLS, cnt = new Int32Array(NC), start = new Int32Array(NC + 1)
  for (let b = 0; b < count; b++) cnt[band[b]]++
  for (let c = 0; c < NC; c++) start[c + 1] = start[c] + cnt[c]
  const fill = start.slice(0, NC)
  const sOff = new Float32Array(count * 4), sPrm = new Float32Array(count * 4), sClump = new Float32Array(count * 4)
  yield // PERFGOV
  for (let b = 0; b < count; b++) {
    if ((b & 16383) === 16383) yield // PERFGOV
    const t = fill[band[b]]++
    sOff.set(off.subarray(b * 4, b * 4 + 4), t * 4); sPrm.set(prm.subarray(b * 4, b * 4 + 4), t * 4); sClump.set(clump.subarray(b * 4, b * 4 + 4), t * 4)
  }
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, fog: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...U, u_fadeFar: { value: range }, u_widen: { value: 0.05 }, u_fieldO: { value: new THREE.Vector2(camX, camZ) } },
    vertexShader: grassVert, fragmentShader: grassFrag,
  })
  // LOD by the camera's distance to the chunk's nearest point: full blade within ~10 m (a blade there is still tens of
  // px tall), the half blade to ~17 m, one triangle beyond (a few px tall, and the shader sinks it by 15–30 m anyway)
  const LOD1 = 9, LOD2 = 16 // a hair inside the band edges (5 / 10 / 17 m), so the landing view steps exactly by band
  const mesh = new THREE.Group()
  mesh.name = 'foliage-grass'
  const lodStats = [0, 0, 0]
  const box = new THREE.Box3(), cv = new THREE.Vector3(), cam = new THREE.Vector3(), inv = new THREE.Matrix4()
  for (let c = 0; c < NC; c++) {
    const a0 = start[c], a1 = start[c + 1]
    if (a1 <= a0) continue
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', posAttr)
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(sOff.subarray(a0 * 4, a1 * 4), 4))
    g.setAttribute('aPrm', new THREE.InstancedBufferAttribute(sPrm.subarray(a0 * 4, a1 * 4), 4))
    g.setAttribute('aClump', new THREE.InstancedBufferAttribute(sClump.subarray(a0 * 4, a1 * 4), 4))
    g.instanceCount = a1 - a0
    // a real bounding sphere from the roots, grown by the tallest blade plus its bend (the shader only ever shortens)
    box.makeEmpty()
    let hMax = 0
    for (let b = a0; b < a1; b++) { box.expandByPoint(cv.set(sOff[b * 4], sOff[b * 4 + 1], sOff[b * 4 + 2])); hMax = Math.max(hMax, sPrm[b * 4]) }
    const roots = box.clone()
    box.expandByVector(cv.set(hMax * 1.3 + 0.2, hMax * 1.3 + 0.2, hMax * 1.3 + 0.2))
    g.boundingBox = box.clone()
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere())
    g.setDrawRange(lodRange[0][0], lodRange[0][1])
    const m = new THREE.Mesh(g, mat)
    m.frustumCulled = true
    m.name = 'foliage-grass-' + c
    m.onBeforeRender = (_r, _s, camera) => {
      // the camera in the field's own space, against the box of the chunk's roots (a sphere around a wide far chunk
      // reaches far too close to the lens and kept the whole field at full detail)
      cam.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv.copy(m.matrixWorld).invert())
      const dn = roots.distanceToPoint(cam)
      const L = dn < LOD1 ? 0 : dn < LOD2 ? 1 : 2
      g.drawRange.start = lodRange[L][0]; g.drawRange.count = lodRange[L][1]
      lodStats[L] += a1 - a0
    }
    mesh.add(m)
    yield // PERFGOV
  }
  ;(window as any).__grassLod = { segs: lodSegs, chunks: mesh.children.length, stats: lodStats, reset() { lodStats.fill(0) } } // QA
  return { mesh, material: mat, count }
}

// ================================================================================================ trees
type Lobe = [number, number, number, number] // x y z r (tree-local, before instance scale)
type Parts = { pos: number[]; corner: number[]; nrm: number[]; info: number[]; col: number[]; extra: number[]; index: number[] }
const newParts = (): Parts => ({ pos: [], corner: [], nrm: [], info: [], col: [], extra: [], index: [] })

/** append a non-indexed/indexed geometry as solid triangles (bark or canopy core) */
function addSolid(P: Parts, geo: THREE.BufferGeometry, kind: 0 | 1, colFn: (p: THREE.Vector3) => THREE.Color, nrmFn: (p: THREE.Vector3, n: THREE.Vector3) => THREE.Vector3, aoFn: (p: THREE.Vector3) => number, swayFn: (p: THREE.Vector3) => number) {
  const g = geo.index ? geo.toNonIndexed() : geo
  g.computeVertexNormals()
  const pa = g.attributes.position as THREE.BufferAttribute, na = g.attributes.normal as THREE.BufferAttribute
  const base = P.pos.length / 3, p = new THREE.Vector3(), n = new THREE.Vector3()
  for (let i = 0; i < pa.count; i++) {
    p.fromBufferAttribute(pa, i); n.fromBufferAttribute(na, i)
    const nn = nrmFn(p, n), c = colFn(p)
    P.pos.push(p.x, p.y, p.z); P.corner.push(0, 0); P.nrm.push(nn.x, nn.y, nn.z)
    P.info.push(0, 0, aoFn(p), kind); P.col.push(c.r, c.g, c.b); P.extra.push(0, swayFn(p))
    P.index.push(base + i)
  }
}
function addCard(P: Parts, p: THREE.Vector3, n: THREE.Vector3, size: number, ao: number, col: THREE.Color, seed: number, sway: number, rot: number) {
  const base = P.pos.length / 3
  for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    P.pos.push(p.x, p.y, p.z); P.corner.push(cx, cy); P.nrm.push(n.x, n.y, n.z)
    P.info.push(size, rot, ao, 2); P.col.push(col.r, col.g, col.b); P.extra.push(seed, sway)
  }
  P.index.push(base, base + 1, base + 2, base, base + 2, base + 3)
}
function partsToGeometry(P: Parts) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(P.pos, 3))
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(P.corner, 2))
  g.setAttribute('aNrm', new THREE.Float32BufferAttribute(P.nrm, 3))
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(P.info, 4))
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(P.col, 3))
  g.setAttribute('aExtra', new THREE.Float32BufferAttribute(P.extra, 2))
  g.setIndex(P.index)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2.5, 0), 4)
  return g
}

const BARK = C('#5a3e2b'), BARK_DARK = C('#2e1f17')
function barkPart(P: Parts, from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number, top: number, radial = 7) {
  const len = from.distanceTo(to)
  const geo = new THREE.CylinderGeometry(r1, r0, len, radial, 3, true)
  geo.translate(0, len / 2, 0)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize())
  geo.applyQuaternion(q); geo.translate(from.x, from.y, from.z)
  const c = new THREE.Color()
  addSolid(P, geo, 0, (p) => c.copy(BARK_DARK).lerp(BARK, THREE.MathUtils.smoothstep(p.y, 0, 1.2)), (_p, n) => n,
    (p) => THREE.MathUtils.clamp(p.y / top, 0, 1) * 0.7 + 0.3 * (1 - THREE.MathUtils.smoothstep(p.y, top * 0.7, top)), (p) => THREE.MathUtils.clamp(p.y / top, 0, 1) * 0.6)
}

/** a crown of lobes: dark displaced core spheres + leaf cards on the lobe shells, one shared outward normal field */
function* crown(P: Parts, lobes: Lobe[], centre: THREE.Vector3, sy: number, cards: number, size: [number, number], seed: number, y0: number, y1: number, coreDetail: number) {
  const r = rng(seed)
  const tmp = new THREE.Vector3(), out = new THREE.Vector3(), nrm = new THREE.Vector3(), col = new THREE.Color()
  const canopyN = (p: THREE.Vector3, lobeC: THREE.Vector3 | null) => {
    out.set(p.x - centre.x, (p.y - centre.y) / sy, p.z - centre.z).normalize()
    if (lobeC) { tmp.copy(p).sub(lobeC).normalize(); out.lerp(tmp, 0.35).normalize() }
    return out
  }
  const swayOf = (p: THREE.Vector3) => THREE.MathUtils.clamp((p.y - y0 * 0.6) / (y1 - y0 * 0.6), 0, 1)
  const exposure = (p: THREE.Vector3, n: THREE.Vector3) => THREE.MathUtils.clamp(((p.y - y0) / (y1 - y0)) * 0.55 + Math.max(0, n.y) * 0.3 + 0.15, 0, 1)
  // core: slightly shrunken, noise-bumped lobes in the crown's shade
  for (const [x, y, z, rad] of lobes) {
    const lc = new THREE.Vector3(x, y, z)
    const geo = new THREE.IcosahedronGeometry(rad * 0.86, coreDetail).translate(x, y, z)
    const pa = geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pa.count; i++) {
      tmp.fromBufferAttribute(pa, i)
      const k = 1 + 0.08 * Math.sin(tmp.x * 5.1 + seed) * Math.sin(tmp.y * 4.3) * Math.sin(tmp.z * 4.7 + seed)
      tmp.sub(lc).multiplyScalar(k).add(lc); pa.setXYZ(i, tmp.x, tmp.y, tmp.z)
    }
    addSolid(P, geo, 1, () => col.setRGB(1, 1, 1), (p) => canopyN(p, lc).clone(), (p) => exposure(p, canopyN(p, lc)) * 0.75, swayOf)
    yield // PERFGOV: one lobe per step
  }
  // cards: rejection-sample the visible shell (skip points buried inside another lobe)
  const totalW = lobes.reduce((s, l) => s + l[3] * l[3], 0)
  let placed = 0, guard = 0
  while (placed < cards && guard++ < cards * 8) {
    let pick = r() * totalW, li = 0
    while (li < lobes.length - 1 && pick > lobes[li][3] * lobes[li][3]) { pick -= lobes[li][3] * lobes[li][3]; li++ }
    const [x, y, z, rad] = lobes[li]
    const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u)
    const dir = new THREE.Vector3(Math.cos(th) * s, u, Math.sin(th) * s)
    if (dir.y < -0.55 && r() < 0.7) continue // few cards on the crown's underside
    const depth = 0.8 + r() * 0.28
    const p = new THREE.Vector3(x, y, z).addScaledVector(dir, rad * depth)
    let buried = false
    for (let j = 0; j < lobes.length; j++) {
      if (j === li) continue
      const [ox, oy, oz, orad] = lobes[j]
      if (p.distanceTo(tmp.set(ox, oy, oz)) < orad * 0.82) { buried = true; break }
    }
    if (buried) continue
    nrm.copy(canopyN(p, new THREE.Vector3(x, y, z)))
    const ao = exposure(p, nrm) * (0.75 + 0.25 * (depth - 0.8) / 0.28)
    col.setHSL(0, 0, 1).multiplyScalar(0.96 + r() * 0.08)
    col.r *= 0.98 + r() * 0.04; col.b *= 0.96 + r() * 0.06
    addCard(P, p, nrm.clone(), THREE.MathUtils.lerp(size[0], size[1], r()), ao, col, r(), swayOf(p), r() * Math.PI * 2)
    placed++
    if ((placed & 127) === 0) yield // PERFGOV
  }
}

/** a soft broadleaf: a curved trunk with two limbs into a cumulus crown of lobes */
function* broadleaf(quality: number, seed: number) {
  const P = newParts(), r = rng(seed)
  const lean = (r() - 0.5) * 0.3
  const top = new THREE.Vector3(lean, 2.0, (r() - 0.5) * 0.2)
  barkPart(P, new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(lean * 0.4, 1.1, 0), 0.22, 0.15, 3)
  barkPart(P, new THREE.Vector3(lean * 0.4, 1.05, 0), top, 0.15, 0.09, 3)
  barkPart(P, new THREE.Vector3(lean * 0.4, 1.25, 0), new THREE.Vector3(0.7, 2.1, 0.25), 0.08, 0.04, 3, 5)
  barkPart(P, new THREE.Vector3(lean * 0.4, 1.4, 0), new THREE.Vector3(-0.6, 2.2, -0.2), 0.07, 0.04, 3, 5)
  const lobes: Lobe[] = [
    [lean, 2.95, 0, 0.95], [0.78, 2.5, 0.22, 0.72], [-0.72, 2.55, -0.18, 0.76], [0.2, 2.4, 0.78, 0.7], [-0.25, 2.45, -0.75, 0.7],
    [0.45, 3.4, -0.28, 0.6], [-0.42, 3.3, 0.36, 0.6], [0.05, 2.05, 0.05, 0.62], [-0.55, 2.2, 0.55, 0.52], [0.62, 2.15, -0.5, 0.5],
  ]
  for (const l of lobes) { l[0] += (r() - 0.5) * 0.2; l[1] += (r() - 0.5) * 0.15; l[2] += (r() - 0.5) * 0.2; l[3] *= 0.92 + r() * 0.16 }
  yield // PERFGOV
  yield* crown(P, quality > 0.6 ? lobes : lobes.slice(0, 7), new THREE.Vector3(0, 2.7, 0), 0.82, Math.round(700 * quality), quality > 0.6 ? [0.28, 0.45] : [0.38, 0.58], seed * 7 + 1, 1.5, 4.0, quality > 0.6 ? 2 : 1)
  return partsToGeometry(P)
}

/** a fluffy conifer: drooping tiers of leaf cards around a tall trunk */
function* conifer(quality: number, seed: number) {
  const P = newParts(), r = rng(seed)
  barkPart(P, new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(0, 4.4, 0), 0.18, 0.04, 4.6)
  const tiers = quality > 0.6 ? 6 : 4
  const tmp = new THREE.Vector3(), col = new THREE.Color()
  const cardsPer = Math.round((430 * quality) / tiers)
  const coreGeos: THREE.BufferGeometry[] = []
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1), R = THREE.MathUtils.lerp(1.25, 0.38, f), h = THREE.MathUtils.lerp(1.2, 0.8, f), yb = 0.9 + t * (3.3 / tiers)
    coreGeos.push(new THREE.ConeGeometry(R * 0.82, h, 10, 1, true).translate(0, yb + h / 2, 0))
    for (let k = 0; k < cardsPer; k++) {
      const a = r() * Math.PI * 2, v = Math.pow(r(), 0.7) // more cards toward the skirt
      const rad = R * v * (0.9 + r() * 0.18), y = yb + h * (1 - v) - 0.12 * v * v + (r() - 0.5) * 0.08
      const p = new THREE.Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad)
      const n = tmp.set(Math.cos(a), 0.55 + 0.4 * (1 - v), Math.sin(a)).normalize().clone()
      const ao = THREE.MathUtils.clamp(0.25 + 0.5 * f + 0.3 * v, 0, 1)
      col.setRGB(0.86 + r() * 0.1, 0.92 + r() * 0.1, 0.95 + r() * 0.1)
      addCard(P, p, n, THREE.MathUtils.lerp(0.22, 0.34, r()) * (quality > 0.6 ? 1 : 1.35), ao, col, r(), THREE.MathUtils.clamp(y / 4.6, 0, 1), r() * Math.PI * 2)
    }
    yield // PERFGOV: one tier per step
  }
  const core = mergeGeometries(coreGeos)!
  addSolid(P, core, 1, () => col.setRGB(0.9, 0.95, 1), (p, n) => tmp.set(p.x, 0.5, p.z).normalize().lerp(n, 0.3).normalize().clone(), (p) => THREE.MathUtils.clamp(p.y / 4.6, 0, 1) * 0.6, (p) => THREE.MathUtils.clamp(p.y / 4.6, 0, 1))
  return partsToGeometry(P)
}

type Spot = { x: number; z: number; s: number; kind: 'round' | 'pine' }
/** composed, not scattered: hero trees frame the crewmate, a mid layer gives depth, a hazy back line closes it; the
 *  sky gap behind the crewmate (toward the sun) stays open so the hero's silhouette reads against the light */
function layout(o: FoliageOptions): Spot[] {
  const r = rng(77)
  const S: Spot[] = []
  const add = (x: number, z: number, s: number, kind: Spot['kind']) => S.push({ x, z, s, kind })
  const cluster = (cx: number, cz: number, cr: number, n: number, s0: number, s1: number, pine = 0.4) => {
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * cr
      add(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, s0 + r() * (s1 - s0), r() < pine ? 'pine' : 'round')
    }
  }
  if (o.portrait) {
    // phones: the frame is narrow, so the framing trees stand closer to the axis and further back
    // W22: the right framing broadleaf stands further back so its crown clears the menu icon (header row, top ~120 px)
    add(-3.1, -3.2, 1.5, 'round'); add(4.5, -9.5, 1.7, 'round'); add(-4.6, -8.5, 2.1, 'pine'); add(5.8, -12, 2.2, 'pine')
    add(-6.5, -14, 1.8, 'round')
  } else {
    // W22 (scorer-r614/r618: the header sat over the two nearest crowns at the top corners): the near broadleaves stand a
    // little further back and out, and a touch smaller, so their crowns stay below the header row (top ~120 px)
    add(-13.5, -14.0, 1.6, 'round'); add(-9.9, -1.8, 2.2, 'pine'); add(-9.0, -14.5, 1.3, 'round')
    add(9.6, -4.4, 1.75, 'round'); add(10.6, -3.6, 2.3, 'pine'); add(8.0, -11.0, 1.35, 'round')
  }
  // PERF HOOK (same object count on every tier): phones plant the full tree set too; their crowns are cheaper (q below)
  cluster(-17.5, -17, 4, 5, 1.3, 1.8);   // W22: back and out, crowns under the header row
  cluster(12.5, -11, 3.5, 4, 1.2, 1.7); cluster(-8.5, -24, 3, 3, 1.1, 1.5)
  cluster(-30, -40, 8, 8, 1.4, 2.0, 0.5); cluster(27, -44, 9, 8, 1.4, 2.0, 0.5); cluster(-3, -64, 10, 6, 1.6, 2.1, 0.6)
  cluster(50, -70, 12, 6, 1.7, 2.3, 0.6); cluster(-55, -66, 12, 6, 1.7, 2.3, 0.6)
  // keep the sky gap behind the crewmate clear
  return S.filter((t) => !(t.z < -2 && t.z > -90 && Math.abs(t.x - t.z * 0.05) < 3.4 + Math.max(0, -t.z - 20) * 0.1))
}

function* buildFluffyTrees(o: FoliageOptions, U: U): Generator<void, { meshes: THREE.InstancedMesh[]; material: THREE.ShaderMaterial; spots: Spot[] }> { // PERFGOV: generator (see buildFluffyGrass)
  const spots = layout(o)
  const q = o.low ? 0.62 : o.tier === 'mid' ? 0.78 : 1
  const mat = new THREE.ShaderMaterial({
    fog: true, side: THREE.DoubleSide,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...U },
    vertexShader: treeVert, fragmentShader: treeFrag,
  })
  const near = (t: Spot) => Math.hypot(t.x + 0.6, t.z - 7.6) < 26
  const r = rng(5)
  const meshes: THREE.InstancedMesh[] = []
  const make = (geo: THREE.BufferGeometry, list: Spot[], name: string) => {
    if (!list.length) { geo.dispose(); return }
    const m = new THREE.InstancedMesh(geo, mat, list.length)
    const ob = new THREE.Object3D(), c = new THREE.Color()
    list.forEach((t, n) => {
      ob.position.set(t.x, groundHeight(t.x, t.z) - 0.12, t.z)
      ob.rotation.set((r() - 0.5) * 0.04, r() * Math.PI * 2, (r() - 0.5) * 0.04)
      ob.scale.set(t.s, t.s * (0.94 + r() * 0.16), t.s)
      ob.updateMatrix(); m.setMatrixAt(n, ob.matrix)
      // per-tree hue: some warmer olive, some cooler blue-green
      const h = r()
      c.setRGB(0.92 + h * 0.14, 0.97 + r() * 0.06, 1.04 - h * 0.14)
      m.setColorAt(n, c)
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.frustumCulled = false
    m.name = name
    meshes.push(m)
  }
  const round = spots.filter((t) => t.kind === 'round'), pine = spots.filter((t) => t.kind === 'pine')
  make(yield* broadleaf(q, 11), round.filter(near), 'foliage-round-near'); yield // PERFGOV
  make(yield* broadleaf(q * 0.45, 12), round.filter((t) => !near(t)), 'foliage-round-far'); yield // PERFGOV
  make(yield* conifer(q, 13), pine.filter(near), 'foliage-pine-near'); yield // PERFGOV
  make(yield* conifer(q * 0.45, 14), pine.filter((t) => !near(t)), 'foliage-pine-far')
  return { meshes, material: mat, spots }
}

// ================================================================================================ floor
function reshadeFloor(o: FoliageOptions, U: U) {
  const ground = o.forest.children.find((c) => (c as THREE.Mesh).isMesh && !(c as THREE.InstancedMesh).isInstancedMesh) as THREE.Mesh | undefined
  if (!ground) return null
  const mat = new THREE.ShaderMaterial({
    fog: true, uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...U }, vertexShader: floorVert, fragmentShader: floorFrag,
  })
  const old = ground.material as THREE.Material
  ground.material = mat
  old.dispose()
  return mat
}

// ================================================================================================ entry
export function buildFoliage(o: FoliageOptions) { return runToEnd(buildFoliageSteps(o)) }
/** PERFGOV: the same build as steps (prewarm.ts spreads them over frames behind the preloader) */
export function* buildFoliageSteps(o: FoliageOptions) {
  const U = makeUniforms(o.sunDir)
  // replace the old faceted trees (and their shadows) with the fluffy ones
  for (const c of [...o.forest.children]) {
    if ((c as THREE.InstancedMesh).isInstancedMesh && c !== o.shadows) { o.forest.remove(c); (c as THREE.InstancedMesh).geometry.dispose() }
  }
  const trees = yield* buildFluffyTrees(o, U)
  yield // PERFGOV
  if (o.shadows) { o.forest.remove(o.shadows); (o.shadows as THREE.Mesh).geometry?.dispose() }
  const shadows = buildShadows(trees.spots, o.sunDir)
  o.forest.add(shadows.mesh, ...trees.meshes)
  const floor = reshadeFloor(o, U)
  yield // PERFGOV
  const grass = yield* buildFluffyGrass(o, U)
  ;(window as any).__foliage = { U, grassCount: grass.count, trees: trees.spots.length } // QA
  return {
    /** add this to the forest group (JourneyStage keeps driving grass.material.uniforms.u_time as before) */
    grass: { mesh: grass.mesh, material: grass.material },
    trees, floor, uniforms: U,
    /** per frame: time, the forest light (JourneyStage's treeRim, 0..0.3), the inner crewmate's feet position */
    update(time: number, rim: number, crew: THREE.Vector3) {
      U.u_time.value = time
      U.u_light.value = THREE.MathUtils.clamp(rim / 0.3, 0, 1)
      U.u_crew.value.copy(crew)
    },
  }
}
export type Foliage = ReturnType<typeof buildFoliage>
