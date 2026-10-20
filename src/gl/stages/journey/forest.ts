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

/** cheap 3D value noise (deterministic) for organic canopy displacement */
function vnoise(x: number, y: number, z: number) {
  const h = (i: number, j: number, k: number) => { const s = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453; return s - Math.floor(s) }
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf)
  const l = (a: number, b: number, t: number) => a + (b - a) * t
  return l(l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v), w) * 2 - 1
}

/** Bend a part's normals toward a shared "canopy" normal (outward from a centre, squashed by `sy`): the stylised-
 *  foliage trick — many blobs light as one soft mass instead of a pile of facets. Colours by height/exposure. */
function softPart(g: THREE.BufferGeometry, centre: THREE.Vector3, sy: number, k: number, dark: THREE.Color, light: THREE.Color, y0: number, y1: number, disp = 0, seed = 0) {
  g.deleteAttribute('uv')
  const p = g.attributes.position as THREE.BufferAttribute
  if (disp > 0) {
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      const d = new THREE.Vector3(x - centre.x, (y - centre.y) / sy, z - centre.z).normalize()
      const n = vnoise(x * 2.1 + seed, y * 2.1, z * 2.1) * 0.65 + vnoise(x * 5.3, y * 5.3 + seed, z * 5.3) * 0.35
      p.setXYZ(i, x + d.x * n * disp, y + d.y * n * disp * sy, z + d.z * n * disp)
    }
  }
  g.computeVertexNormals()
  const nrm = g.attributes.normal as THREE.BufferAttribute
  const col = new Float32Array(p.count * 3), v = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color()
  for (let i = 0; i < p.count; i++) {
    v.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i))
    s.set(p.getX(i) - centre.x, (p.getY(i) - centre.y) / sy, p.getZ(i) - centre.z).normalize()
    v.lerp(s, k).normalize(); nrm.setXYZ(i, v.x, v.y, v.z)
    const t = THREE.MathUtils.clamp((p.getY(i) - y0) / (y1 - y0), 0, 1) * 0.7 + Math.max(0, s.y) * 0.3
    c.copy(dark).lerp(light, t)
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}
function trunk(h: number, r0: number, r1: number) {
  const g = new THREE.CylinderGeometry(r1, r0, h, 7, 1, true).translate(0, h / 2, 0).toNonIndexed()
  g.deleteAttribute('uv'); g.computeVertexNormals()
  return colorize(g, C('#4a3324'))
}

/** A soft stylised conifer: five drooping, wavy-edged tiers (lathe skirts), smooth-lit as one mass. */
function pineGeometry(low: boolean) {
  const seg = low ? 14 : 22, parts: THREE.BufferGeometry[] = [trunk(1.3, 0.17, 0.11)]
  const tiers = low ? 4 : 5
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1), R = THREE.MathUtils.lerp(1.3, 0.42, f), h = THREE.MathUtils.lerp(1.75, 1.2, f), y = 0.95 + t * 0.6
    const prof = [new THREE.Vector2(0.001, h), new THREE.Vector2(R * 0.35, h * 0.72), new THREE.Vector2(R * 0.7, h * 0.36), new THREE.Vector2(R, 0.02),
      new THREE.Vector2(R * 0.92, -0.06), new THREE.Vector2(R * 0.45, 0.12), new THREE.Vector2(0.001, 0.2)]
    const g = new THREE.LatheGeometry(prof, seg).toNonIndexed()
    const p = g.attributes.position as THREE.BufferAttribute, ph = t * 1.7
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z), a = Math.atan2(z, x)
      const wav = 1 + (0.1 * Math.sin(a * 7 + ph) + 0.05 * Math.sin(a * 13 - ph * 2)) * (r / R)
      const droop = -0.12 * (r / R) * (r / R) * (1 + 0.5 * Math.sin(a * 7 + ph))
      p.setXYZ(i, x * wav, p.getY(i) + y + droop, z * wav)
    }
    parts.push(softPart(g, new THREE.Vector3(0, 2.4, 0), 1.9, 0.72, C('#2c6534'), C('#5aa646'), 0.6, 4.6, 0.09, t * 2.3))
  }
  const g = mergeGeometries(parts)!; return g
}
/** A soft broadleaf: a cauliflower canopy of noise-displaced blobs sharing one spherical normal field. */
function roundGeometry(low: boolean) {
  const d = low ? 1 : 2, parts: THREE.BufferGeometry[] = [trunk(1.7, 0.2, 0.12)]
  const cen = new THREE.Vector3(0, 2.55, 0)
  const blobs: [number, number, number, number][] = [
    [0, 2.9, 0, 0.95], [0.75, 2.45, 0.25, 0.75], [-0.7, 2.5, -0.2, 0.78], [0.2, 2.35, 0.75, 0.7], [-0.25, 2.4, -0.75, 0.72],
    [0.45, 3.35, -0.3, 0.62], [-0.45, 3.25, 0.35, 0.6], [0, 1.95, 0, 0.7],
  ]
  ;(low ? blobs.slice(0, 5) : blobs).forEach(([x, y, z, r], i) => {
    const g = new THREE.IcosahedronGeometry(r, d).translate(x, y, z).toNonIndexed()
    parts.push(softPart(g, cen, 0.85, 0.68, C('#2a6a2e'), C('#79c25a'), 1.7, 3.9, 0.16, i * 3.1))
  })
  const g = mergeGeometries(parts)!; return g
}

export function groundHeight(x: number, z: number) {
  const r = Math.hypot(x, z)
  const hills = Math.sin(x * 0.07) * Math.cos(z * 0.05) * 2.2 + Math.sin(x * 0.021 + 1.3) * Math.sin(z * 0.018) * 6
  // the clearing is flat; the land rolls up into hills far away
  return hills * THREE.MathUtils.smoothstep(r, 14, 46) + THREE.MathUtils.smoothstep(r, 60, 160) * 14
}

export function buildForest(low: boolean, material: THREE.Material, groundMaterial: THREE.Material = material) {
  const group = new THREE.Group()
  // ground
  const seg = low ? 48 : 80
  const ground = new THREE.PlaneGeometry(360, 360, seg, seg).rotateX(-Math.PI / 2).toNonIndexed()
  const pos = ground.attributes.position as THREE.BufferAttribute
  const col = new Float32Array(pos.count * 3), r = rng(7)
  const g0 = C('#2a8040'), g1 = C('#4aa34e'), g2 = C('#1d5a38'), tmp = new THREE.Color()
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
  group.add(new THREE.Mesh(ground, groundMaterial))

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
      spots.push({ x: cx + Math.cos(a) * rr, z: cz + Math.sin(a) * rr, s: s0 + rand() * (s1 - s0), round: rand() < 0.5 })
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
