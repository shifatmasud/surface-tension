import * as THREE from 'three'

/**
 * A soft rounded slab: a rounded rectangle extruded with a rounded bevel, lying flat (height on +y),
 * centred on the origin. Used for the glass tiles and every UI part on them (pills, discs, chips).
 */
export function slab(w: number, d: number, h: number, r: number, bevel = Math.min(h * 0.32, 0.07), curve = 12) {
  const bs = Math.min(bevel, w / 2 - 0.001, d / 2 - 0.001)
  const iw = w - bs * 2, id = d - bs * 2
  const rr = Math.max(0.0005, Math.min(r - bs, iw / 2, id / 2))
  const s = new THREE.Shape()
  const x0 = -iw / 2, y0 = -id / 2
  s.moveTo(x0 + rr, y0)
  s.lineTo(x0 + iw - rr, y0); s.absarc(x0 + iw - rr, y0 + rr, rr, -Math.PI / 2, 0, false)
  s.lineTo(x0 + iw, y0 + id - rr); s.absarc(x0 + iw - rr, y0 + id - rr, rr, 0, Math.PI / 2, false)
  s.lineTo(x0 + rr, y0 + id); s.absarc(x0 + rr, y0 + id - rr, rr, Math.PI / 2, Math.PI, false)
  s.lineTo(x0, y0 + rr); s.absarc(x0 + rr, y0 + rr, rr, Math.PI, Math.PI * 1.5, false)
  const bt = Math.min(bs, h / 2 - 0.001)
  const depth = Math.max(0.001, h - bt * 2)
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bt, bevelSize: bs, bevelSegments: 4, curveSegments: curve })
  g.rotateX(-Math.PI / 2)
  g.translate(0, -depth / 2, 0)
  g.computeVertexNormals()
  g.computeBoundingBox(); g.computeBoundingSphere()
  return g
}
