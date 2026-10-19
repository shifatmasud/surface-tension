import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** Seeded random so the forest is the same composition on every load. */
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) }

function colorize(g: THREE.BufferGeometry, c: THREE.Color) {
  const n = g.attributes.position.count, a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g
}
const C = (h: string) => new THREE.Color(h)

/** A low-poly pine: trunk + three stacked cones, merged with vertex colours (one draw for all instances). */
function pineGeometry(low: boolean) {
  const s = low ? 6 : 7
  const parts = [
    colorize(new THREE.CylinderGeometry(0.12, 0.16, 1.2, 5).translate(0, 0.6, 0).toNonIndexed(), C('#4a3324')),
    colorize(new THREE.ConeGeometry(1.25, 2.0, s).translate(0, 1.9, 0).toNonIndexed(), C('#2f7d3a')),
    colorize(new THREE.ConeGeometry(0.98, 1.7, s).translate(0, 2.8, 0).toNonIndexed(), C('#3b9443')),
    colorize(new THREE.ConeGeometry(0.66, 1.4, s).translate(0, 3.6, 0).toNonIndexed(), C('#4caa4b')),
  ]
  parts.forEach((p) => { p.deleteAttribute('uv') })
  const g = mergeGeometries(parts)!; g.computeVertexNormals(); return g
}
/** A rounded broadleaf: trunk + two faceted blobs. */
function roundGeometry(low: boolean) {
  const d = low ? 0 : 1
  const parts = [
    colorize(new THREE.CylinderGeometry(0.13, 0.18, 1.4, 5).translate(0, 0.7, 0).toNonIndexed(), C('#4d3526')),
    colorize(new THREE.IcosahedronGeometry(1.25, d).translate(0, 2.2, 0).toNonIndexed(), C('#5fb04d')),
    colorize(new THREE.IcosahedronGeometry(0.85, d).translate(0.55, 2.9, 0.2).toNonIndexed(), C('#77c257')),
  ]
  parts.forEach((p) => { p.deleteAttribute('uv') })
  const g = mergeGeometries(parts)!; g.computeVertexNormals(); return g
}

export function groundHeight(x: number, z: number) {
  const r = Math.hypot(x, z)
  const hills = Math.sin(x * 0.07) * Math.cos(z * 0.05) * 2.2 + Math.sin(x * 0.021 + 1.3) * Math.sin(z * 0.018) * 6
  // the clearing is flat; the land rolls up into hills far away
  return hills * THREE.MathUtils.smoothstep(r, 14, 46) + THREE.MathUtils.smoothstep(r, 60, 160) * 14
}

export function buildForest(low: boolean, material: THREE.Material) {
  const group = new THREE.Group()
  // ground
  const seg = low ? 48 : 80
  const ground = new THREE.PlaneGeometry(360, 360, seg, seg).rotateX(-Math.PI / 2).toNonIndexed()
  const pos = ground.attributes.position as THREE.BufferAttribute
  const col = new Float32Array(pos.count * 3), r = rng(7)
  const g0 = C('#1f7a3a'), g1 = C('#3c9c4a'), g2 = C('#175236'), tmp = new THREE.Color()
  for (let i = 0; i < pos.count; i += 3) {
    // per-face colour for the faceted look
    let cx = 0, cz = 0
    for (let k = 0; k < 3; k++) { const x = pos.getX(i + k), z = pos.getZ(i + k); pos.setY(i + k, groundHeight(x, z)); cx += x / 3; cz += z / 3 }
    const rr = Math.hypot(cx, cz)
    tmp.copy(g0).lerp(g1, THREE.MathUtils.smoothstep(rr, 16, 2) * 0.7 + r() * 0.2).lerp(g2, THREE.MathUtils.smoothstep(rr, 30, 120) * 0.6)
    for (let k = 0; k < 3; k++) { col[(i + k) * 3] = tmp.r; col[(i + k) * 3 + 1] = tmp.g; col[(i + k) * 3 + 2] = tmp.b }
  }
  ground.setAttribute('color', new THREE.BufferAttribute(col, 3))
  ground.deleteAttribute('uv'); ground.computeVertexNormals()
  group.add(new THREE.Mesh(ground, material))

  // trees: composed in depth layers, not scattered — clusters framing an open clearing, a backlit sky gap behind
  const rand = rng(42)
  type Cl = [number, number, number, number, number, number] // cx, cz, radius, count, minScale, maxScale
  const clusters: Cl[] = low ? [
    [-8.5, 2.5, 1.6, 2, 1.9, 2.3], [9.5, 0.5, 1.2, 1, 1.6, 1.8],
    [-13, -12, 3.5, 4, 1.3, 1.7], [11, -9, 3, 3, 1.2, 1.6], [5, -24, 3, 3, 1.1, 1.4],
    [-30, -40, 7, 6, 1.4, 1.9], [26, -44, 8, 6, 1.4, 1.9], [-4, -62, 9, 5, 1.6, 2.0],
  ] : [
    [-8.5, 2.5, 1.8, 3, 1.8, 2.4], [9.5, 0.5, 1.4, 2, 1.5, 1.9],
    [-13, -12, 4, 6, 1.2, 1.7], [11, -9, 3.5, 5, 1.1, 1.6], [5, -24, 3.5, 4, 1.0, 1.4], [-6, -30, 3, 3, 1.0, 1.3],
    [-30, -40, 8, 10, 1.3, 1.9], [26, -44, 9, 10, 1.3, 1.9], [-4, -62, 10, 9, 1.5, 2.0], [50, -70, 12, 8, 1.6, 2.2], [-55, -66, 12, 8, 1.6, 2.2],
  ]
  const spots: { x: number; z: number; s: number; round: boolean }[] = []
  for (const [cx, cz, cr, n, s0, s1] of clusters) {
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * cr
      spots.push({ x: cx + Math.cos(a) * rr, z: cz + Math.sin(a) * rr, s: s0 + rand() * (s1 - s0), round: rand() < 0.3 })
    }
  }
  const make = (geo: THREE.BufferGeometry, list: typeof spots) => {
    const m = new THREE.InstancedMesh(geo, material, Math.max(1, list.length))
    const o = new THREE.Object3D(), c = new THREE.Color()
    list.forEach((t, n) => {
      o.position.set(t.x, groundHeight(t.x, t.z) - 0.15, t.z)
      o.rotation.set((rand() - 0.5) * 0.05, rand() * Math.PI * 2, (rand() - 0.5) * 0.05)
      o.scale.set(t.s, t.s * (0.92 + rand() * 0.22), t.s)
      o.updateMatrix(); m.setMatrixAt(n, o.matrix)
      c.setHSL(0.26 + rand() * 0.07, 0.45 + rand() * 0.2, 0.34 + rand() * 0.12)
      m.setColorAt(n, c.multiplyScalar(1.7))
    })
    m.count = list.length
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.frustumCulled = false
    return m
  }
  group.add(make(pineGeometry(low), spots.filter((t) => !t.round)))
  group.add(make(roundGeometry(low), spots.filter((t) => t.round)))
  return { group, spots }
}

/**
 * Long golden-hour shadows without a shadow map: one soft elongated decal per tree, cast away from the
 * low sun (towards the camera), in a single instanced draw.
 */
export function buildShadows(spots: { x: number; z: number; s: number }[], sunDir: THREE.Vector3) {
  const geo = longShadowGeometry()
  const mat = longShadowMaterial(true)
  const m = new THREE.InstancedMesh(geo, mat, spots.length + 1)
  const o = new THREE.Object3D()
  const away = Math.atan2(-sunDir.x, -sunDir.z)
  spots.forEach((t, i) => {
    o.position.set(t.x, groundHeight(t.x, t.z) + 0.03, t.z)
    o.rotation.set(0, away, 0)
    o.scale.set(2.2 * t.s, 1, 7.5 * t.s)
    o.updateMatrix(); m.setMatrixAt(i, o.matrix)
  })
  m.count = spots.length
  m.frustumCulled = false
  return { mesh: m, material: mat, away }
}

export const longShadowGeometry = () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5)
export function longShadowMaterial(instanced: boolean) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2,
    uniforms: { u_opacity: { value: 1 } },
    vertexShader: instanced
      ? `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`
      : `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float u_opacity; varying vec2 vUv;
      void main(){ float x = (vUv.x - 0.5) * 2.0; float y = 1.0 - vUv.y; // y: 0 at the trunk → 1 at the tip
        float w = 1.0 - smoothstep(0.25, 1.0, abs(x) / (0.55 + 0.45 * smoothstep(0.0, 0.25, y)));
        float a = w * smoothstep(0.0, 0.06, y) * (1.0 - smoothstep(0.35, 1.0, y));
        gl_FragColor = vec4(0.0, 0.012, 0.008, a * 0.5 * u_opacity); }`,
  })
}
