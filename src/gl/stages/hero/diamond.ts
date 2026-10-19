import * as THREE from 'three'

/**
 * A round-brilliant-style cut, built procedurally (8-fold symmetry, 57 facets give or take):
 * table → star facets → kite (bezel) facets → upper-girdle → girdle band → pavilion mains → culet.
 * Flat-shaded (non-indexed) so every facet catches its own light.
 * Proportions follow a classic ideal cut: table 56 %, crown 15 %, pavilion 43 % of the diameter.
 */
export function brilliantGeometry(r = 1) {
  const N = 8
  const tableR = 0.56 * r, crownH = 0.16 * r, girdleH = 0.025 * r, pavH = 0.43 * r * 2 * 0.5 * 2 * 0.5
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
  return geo
}
