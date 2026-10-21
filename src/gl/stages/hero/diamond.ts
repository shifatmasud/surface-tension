import * as THREE from 'three'

/**
 * A round-brilliant-style cut, built procedurally (8-fold symmetry, 57 facets give or take):
 * table → star facets → kite (bezel) facets → upper-girdle → girdle band → pavilion mains → culet.
 * Flat-shaded (non-indexed) so every facet catches its own light.
 * Proportions follow a classic ideal cut: table 56 %, crown 15 %, pavilion 43 % of the diameter.
 */
export function brilliantGeometry(r = 1) {
  const N = 8
  const tableR = 0.56 * r, crownH = 0.16 * r, girdleH = 0 * r /* W23: knife-edge girdle; the 2.5 % band was 1–4 px at phone density and drew as a dark dotted rim */, pavH = 0.43 * r * 2 * 0.5 * 2 * 0.5
  const pav = 0.86 * r // pavilion depth (≈43 % of diameter)
  const ring = (n: number, rad: number, y: number, off = 0) =>
    Array.from({ length: n }, (_, i) => { const a = ((i + off) / n) * Math.PI * 2; return new THREE.Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad) })
  const table = ring(N, tableR, crownH)
  const star = ring(N, (tableR + r) * 0.5 * 1.04, crownH * 0.55, 0.5)     // star points
  const gTop = ring(N * 2, r, girdleH * 0.5, 0)                            // upper girdle (16)
  const gBot = ring(N * 2, r, -girdleH * 0.5, 0)
  const pavMid = ring(N, r * 0.5, -pav * 0.52, 0.5)
  const culet = new THREE.Vector3(0, -pav, 0)
  const top = new THREE.Vector3(0, crownH, 0)
  const tris: THREE.Vector3[] = []
  const T = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => tris.push(a, b, c)
  for (let i = 0; i < N; i++) {
    const t0 = table[i], t1 = table[(i + 1) % N], s = star[i]
    const g0 = gTop[i * 2], gm = gTop[i * 2 + 1], g1 = gTop[(i * 2 + 2) % (N * 2)]
    const sPrev = star[(i - 1 + N) % N]
    T(top, t1, t0)                       // table (fan)
    T(t0, t1, s)                         // star facet
    T(t0, s, g0); T(t0, g0, sPrev)        // kite (bezel) halves
    T(s, gm, g0); T(s, g1, gm)            // upper-girdle facets
  }
  for (let i = 0; i < N * 2; i++) {        // girdle band
    const a = gTop[i], b = gTop[(i + 1) % (N * 2)], c = gBot[i], d = gBot[(i + 1) % (N * 2)]
    T(a, b, d); T(a, d, c)
  }
  for (let i = 0; i < N; i++) {            // pavilion: lower-girdle facets + mains to the culet
    const g0 = gBot[i * 2], gm = gBot[i * 2 + 1], g1 = gBot[(i * 2 + 2) % (N * 2)]
    const p = pavMid[i], pPrev = pavMid[(i - 1 + N) % N]
    T(g0, gm, p); T(gm, g1, p)
    T(g0, p, pPrev)
    T(pPrev, p, culet)
  }
  void pavH
  const geo = new THREE.BufferGeometry().setFromPoints(tris)
  // orient every triangle outward (robust against winding slips above)
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), cen = new THREE.Vector3()
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2)
    n.subVectors(b, a).cross(c.clone().sub(a))
    cen.copy(a).add(b).add(c).divideScalar(3).sub(new THREE.Vector3(0, -0.2 * r, 0))
    if (n.dot(cen) < 0) { pos.setXYZ(i + 1, c.x, c.y, c.z); pos.setXYZ(i + 2, b.x, b.y, b.z) }
  }
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  addSilhouetteAttrs(geo)
  return geo
}

/**
 * W23 (390 stepped outline): per-triangle data for an analytic silhouette edge in the stone's shader. The stone is convex,
 * so an edge is on the silhouette exactly when the face across it turns away from the eye. Each triangle carries its
 * barycentric coordinates (aSilB: the distance to the edge opposite each vertex, which fwidth turns into pixels) and the
 * normals of the three faces across its edges (aSilN0..2, for the edge opposite vertex 0, 1, 2). Coplanar neighbours share
 * a normal, so the inner edges of a facet never count.
 */
function addSilhouetteAttrs(geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const n = pos.count, faces = n / 3
  const key = (i: number) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`
  const fn: THREE.Vector3[] = []
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let f = 0; f < faces; f++) {
    a.fromBufferAttribute(pos, f * 3); b.fromBufferAttribute(pos, f * 3 + 1); c.fromBufferAttribute(pos, f * 3 + 2)
    const nn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
    fn.push(nn.lengthSq() < 1e-12 ? new THREE.Vector3(NaN, NaN, NaN) : nn.normalize())   // a zero-area triangle (the knife-edge girdle) has no side
  }
  const edges = new Map<string, number[]>()
  const ek = (i: number, j: number) => { const p = key(i), q = key(j); return p < q ? p + '|' + q : q + '|' + p }
  for (let f = 0; f < faces; f++) for (let k = 0; k < 3; k++) {
    const e = ek(f * 3 + (k + 1) % 3, f * 3 + (k + 2) % 3)
    const l = edges.get(e); if (l) l.push(f); else edges.set(e, [f])
  }
  const bary = new Float32Array(n * 3), nb = [new Float32Array(n * 3), new Float32Array(n * 3), new Float32Array(n * 3)]
  for (let f = 0; f < faces; f++) {
    for (let k = 0; k < 3; k++) {
      bary[(f * 3 + k) * 3 + k] = 1
      const l = edges.get(ek(f * 3 + (k + 1) % 3, f * 3 + (k + 2) % 3)) || []
      const g = l.find((x) => x !== f && !Number.isNaN(fn[x].x))
      const m = g === undefined || Number.isNaN(fn[f].x) ? new THREE.Vector3(0, 0, 0) : fn[g]   // no real neighbour: never fades (dot 0 is not < 0)
      for (let v = 0; v < 3; v++) { nb[k][(f * 3 + v) * 3] = m.x; nb[k][(f * 3 + v) * 3 + 1] = m.y; nb[k][(f * 3 + v) * 3 + 2] = m.z }
    }
  }
  geo.setAttribute('aSilB', new THREE.BufferAttribute(bary, 3))
  geo.setAttribute('aSilN0', new THREE.BufferAttribute(nb[0], 3))
  geo.setAttribute('aSilN1', new THREE.BufferAttribute(nb[1], 3))
  geo.setAttribute('aSilN2', new THREE.BufferAttribute(nb[2], 3))
}
