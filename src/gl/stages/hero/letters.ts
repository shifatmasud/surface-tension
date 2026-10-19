import * as THREE from 'three'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import data from '../../../content/letters.json'

/**
 * SVGParser equivalent: glyph outlines (Inter 800, exported at build time as SVG path data) are parsed
 * with SVGLoader and extruded into chunky bevelled letter geometry at load time.
 */
const cache = new Map<string, THREE.BufferGeometry>()
export function letterGeometry(ch: string, size = 1.05, depth = 0.22) {
  const key = ch + size + depth
  if (cache.has(key)) return cache.get(key)!
  const L = (data as any).letters[ch]
  const upm = (data as any).upm as number
  // Split the glyph into contours ourselves: solids share the outer winding, holes have the opposite one
  // and are assigned to the solid that contains them (keeps the dot of the "i" and the counters of "a").
  const subs = (L.d as string).split(/(?=M)/).filter((x) => x.trim())
  const contours = subs.map((d) => {
    const sp = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`).paths[0]
    const pts = sp.subPaths[0].getPoints(12)
    return { path: sp.subPaths[0], pts, area: THREE.ShapeUtils.area(pts) }
  })
  const outerSign = Math.sign(contours.reduce((m, c) => (Math.abs(c.area) > Math.abs(m.area) ? c : m)).area)
  const inside = (p: THREE.Vector2, poly: THREE.Vector2[]) => {
    let c = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j]
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c
    }
    return c
  }
  const solids = contours.filter((c) => Math.sign(c.area) === outerSign).map((c) => ({ c, shape: new THREE.Shape(c.pts) }))
  contours.filter((c) => Math.sign(c.area) !== outerSign).forEach((h) => {
    const host = solids.find((s) => inside(h.pts[0], s.c.pts))
    if (host) host.shape.holes.push(new THREE.Path(h.pts))
  })
  const shapes = solids.map((s) => s.shape)
  const s = size / upm
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: depth / s, bevelEnabled: true, bevelThickness: (0.03) / s, bevelSize: (0.022) / s,
    bevelSegments: 4, curveSegments: 10,
  })
  geo.scale(s, s, s)
  // center on glyph bounds (font units are y-up already)
  const [x0, y0, x1, y1] = L.bounds as number[]
  geo.translate(-((x0 + x1) / 2) * s, -((y0 + y1) / 2) * s, 0)
  geo.computeVertexNormals()
  cache.set(key, geo)
  return geo
}
export function tileGeometry(w = 1.5, h = 0.42) {
  return new RoundedBoxGeometry(w, h, w, 4, 0.18)
}
