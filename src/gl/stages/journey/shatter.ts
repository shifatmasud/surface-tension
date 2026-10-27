import * as THREE from 'three'

/**
 * The tablet's cover glass, broken from the inside.
 *
 * The fracture is built the way tempered/laminated glass actually fails under a point impact: radial cracks run out
 * from the impact point, short concentric cracks join them (closer together near the impact, wider apart outwards),
 * some concentric segments never form (long slivers), some cells split again. Every cell becomes a thin extruded
 * shard that carries its own piece of the live screen image. Before the break the shards sit in place and render
 * exactly like the screen; the cracks are drawn on their edges as the fracture front propagates. At the break they
 * fly — slowed down by the timeline's slow-motion clock — tumbling, flashing the studio light on their faces and an
 * iridescent thin-film fringe on their edges. Everything is a pure function of the uniforms (scroll-scrubbed and
 * reversible). Original code.
 */

export type ShatterOpts = { sw: number; sh: number; impact: THREE.Vector2; k: number; tier: 'low' | 'mid' | 'high'; thickness?: number }

type V = { x: number; y: number; t: number } // t: type of the edge that starts at this vertex (0 radial, 1 concentric, 2 border)

function clipRect(poly: V[], hw: number, hh: number): V[] {
  const planes: [number, number, number][] = [[1, 0, hw], [-1, 0, hw], [0, 1, hh], [0, -1, hh]] // n·p <= d
  let out = poly
  for (const [nx, ny, d] of planes) {
    if (out.length < 3) return []
    const src = out; out = []
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length]
      const da = nx * a.x + ny * a.y - d, db = nx * b.x + ny * b.y - d
      const ia = da <= 0, ib = db <= 0
      if (ia && ib) out.push(a)
      else if (ia && !ib) { const s = da / (da - db); out.push(a); out.push({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s, t: 2 }) }
      else if (!ia && ib) { const s = da / (da - db); out.push({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s, t: a.t }) }
    }
  }
  return out.length >= 3 ? out : []
}

function area(p: V[]) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y } return s / 2 }

export function fractureCells(o: ShatterOpts) {
  let seed = 1771 + Math.round(o.impact.x * 13 + o.impact.y * 7)
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const hw = o.sw / 2, hh = o.sh / 2
  // PERF lane (eng #5, same object count on every tier): one crack pattern, so every tier breaks into the same shards
  const NR = 18
  const grow = 1.48
  const far = Math.max(...[[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]].map(([x, y]) => Math.hypot(x - o.impact.x, y - o.impact.y))) * 1.08
  const rings: number[] = [0]
  let r = 0.1 * Math.max(0.8, o.k)
  while (r < far) { rings.push(r); r *= grow * (0.92 + rnd() * 0.16) }
  rings.push(far * 1.3)
  const NJ = rings.length
  // radial lines: irregular spacing, each wobbles a little as it runs outwards
  const th: number[] = []
  for (let i = 0; i < NR; i++) th.push(((i + (rnd() - 0.5) * 0.5) / NR) * Math.PI * 2)
  const P: { x: number; y: number }[][] = []
  for (let i = 0; i < NR; i++) {
    P.push([])
    let wob = 0
    for (let j = 0; j < NJ; j++) {
      if (j === 0) { P[i].push({ x: o.impact.x, y: o.impact.y }); continue }
      wob = wob * 0.6 + (rnd() - 0.5) * (1.6 / NR) // mean-reverting: a crack wanders but never crosses its neighbour
      const a = th[i] + wob, rr = rings[j] * (j === NJ - 1 ? 1 : 1 + (rnd() - 0.5) * 0.22)
      P[i].push({ x: o.impact.x + Math.cos(a) * rr, y: o.impact.y + Math.sin(a) * rr })
    }
  }
  // concentric segment between radial i and i+1 at ring j: present or not, and its bowed midpoint
  const present: boolean[][] = [], mid: ({ x: number; y: number } | null)[][] = []
  for (let i = 0; i < NR; i++) {
    present.push([]); mid.push([])
    for (let j = 0; j < NJ; j++) {
      present[i].push(j <= 1 || j === NJ - 1 || rnd() > 0.24)
      const a = P[i][j], b = P[(i + 1) % NR][j]
      if (j >= 2 && Math.hypot(a.x - b.x, a.y - b.y) > 0.55) {
        const mx = (a.x + b.x) / 2 - o.impact.x, my = (a.y + b.y) / 2 - o.impact.y, ml = Math.hypot(mx, my) || 1
        const bow = (Math.hypot(a.x - b.x, a.y - b.y) * 0.5) ** 2 / (2 * ml) * (0.7 + rnd() * 0.6)
        mid[i].push({ x: (a.x + b.x) / 2 + (mx / ml) * bow, y: (a.y + b.y) / 2 + (my / ml) * bow })
      } else mid[i].push(null)
    }
  }
  const cells: V[][] = []
  for (let i = 0; i < NR; i++) {
    const i2 = (i + 1) % NR
    let j0 = 0
    for (let j = 1; j < NJ; j++) {
      if (!present[i][j] && j < NJ - 1) continue
      // cell: out along radial i (j0 → j), across ring j (i → i2), back in along radial i2, across ring j0 (i2 → i)
      const poly: V[] = []
      for (let q = j0; q < j; q++) poly.push({ ...P[i][q], t: 0 })
      poly.push({ ...P[i][j], t: 1 })
      if (mid[i][j]) poly.push({ ...mid[i][j]!, t: 1 })
      const qEnd = j0 === 0 ? 1 : j0 + 1 // the apex (j0 = 0) is shared by both radials: it appears once
      for (let q = j; q >= qEnd; q--) poly.push({ ...P[i2][q], t: 0 })
      if (j0 > 0) {
        poly.push({ ...P[i2][j0], t: 1 })
        if (mid[i][j0]) poly.push({ ...mid[i][j0]!, t: 1 })
      }
      const c = clipRect(poly, hw, hh)
      if (c.length >= 3 && Math.abs(area(c)) > 1e-4) {
        // some bigger cells crack once more across
        if (c.length >= 4 && Math.abs(area(c)) > 0.35 && rnd() < 0.45) {
          const n = c.length, k = Math.floor(n / 2)
          const A = c.slice(0, k + 1).map((v, idx) => ({ ...v, t: idx === k ? 1 : v.t }))
          const B = [...c.slice(k), c[0]].map((v, idx, arr) => ({ ...v, t: idx === arr.length - 1 ? 1 : v.t }))
          if (Math.abs(area(A)) > 1e-4) cells.push(A)
          if (Math.abs(area(B)) > 1e-4) cells.push(B)
        } else cells.push(c)
      }
      j0 = j
    }
  }
  return { cells, far, rnd }
}

export function buildShatterGeometry(o: ShatterOpts) {
  const { cells, rnd } = fractureCells(o)
  const th = o.thickness ?? 0.03
  const pos: number[] = [], nor: number[] = [], cen: number[] = [], uv: number[] = [], edge: number[] = [], kind: number[] = [], rand: number[] = [], rest: number[] = []
  const push = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, C: number[], u: number, v: number, e: number, k: number, R: number[], rx: number, ry: number) => {
    pos.push(px, py, pz); nor.push(nx, ny, nz); cen.push(...C); uv.push(u, v); edge.push(e); kind.push(k); rand.push(...R); rest.push(rx, ry)
  }
  for (const c of cells) {
    if (area(c) < 0) { // keep CCW; an edge's type rides its start vertex, so re-tag while reversing
      const n0 = c.length, src = c.map((v) => ({ ...v }))
      for (let m = 0; m < n0; m++) c[m] = { x: src[n0 - 1 - m].x, y: src[n0 - 1 - m].y, t: src[(2 * n0 - 2 - m) % n0].t }
    }
    let cx = 0, cy = 0
    for (const v of c) { cx += v.x; cy += v.y }
    cx /= c.length; cy /= c.length
    const A = Math.abs(area(c))
    const size = Math.sqrt(A)
    const dist = Math.hypot(cx - o.impact.x, cy - o.impact.y)
    const C = [cx, cy, size]
    const R = [rnd(), rnd(), rnd(), dist]
    const U = (x: number) => x / o.sw + 0.5, Vv = (y: number) => y / o.sh + 0.5
    const n = c.length
    for (let i = 0; i < n; i++) {
      const a = c[i], b = c[(i + 1) % n]
      const t = a.t
      // front cap (+z) — the shard's face, the crack drawn along its edges
      push(0, 0, th, 0, 0, 1, C, U(cx), Vv(cy), 1, t, R, cx, cy)
      push(a.x - cx, a.y - cy, th, 0, 0, 1, C, U(a.x), Vv(a.y), 0, t, R, a.x, a.y)
      push(b.x - cx, b.y - cy, th, 0, 0, 1, C, U(b.x), Vv(b.y), 0, t, R, b.x, b.y)
      // back cap (-z)
      push(0, 0, 0, 0, 0, -1, C, U(cx), Vv(cy), 1, 3, R, cx, cy)
      push(b.x - cx, b.y - cy, 0, 0, 0, -1, C, U(b.x), Vv(b.y), 0, 3, R, b.x, b.y)
      push(a.x - cx, a.y - cy, 0, 0, 0, -1, C, U(a.x), Vv(a.y), 0, 3, R, a.x, a.y)
      // side wall: the thin bright edge of the glass
      const ex = b.x - a.x, ey = b.y - a.y, el = Math.hypot(ex, ey) || 1
      const nx = ey / el, ny = -ex / el
      const quad = [[a, th], [a, 0], [b, 0], [a, th], [b, 0], [b, th]] as const
      for (const [v, z] of quad) push(v.x - cx, v.y - cy, z, nx, ny, 0, C, U(v.x), Vv(v.y), 0, 4, R, v.x, v.y)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('aCenter', new THREE.Float32BufferAttribute(cen, 3))
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1))
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1))
  g.setAttribute('aRand', new THREE.Float32BufferAttribute(rand, 4))
  g.setAttribute('aRest', new THREE.Float32BufferAttribute(rest, 2))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  return { geometry: g, count: cells.length }
}

const COMMON = /* glsl */ `
  uniform float u_t, u_crackR, u_ringR, u_tilt, u_hole, u_k, u_time, u_out;
  uniform vec2 u_impact;
  mat3 rotAxis(vec3 a, float ang){ float s = sin(ang), c = cos(ang), oc = 1.0 - c;
    return mat3(oc*a.x*a.x + c, oc*a.x*a.y + a.z*s, oc*a.z*a.x - a.y*s,
                oc*a.x*a.y - a.z*s, oc*a.y*a.y + c, oc*a.y*a.z + a.x*s,
                oc*a.z*a.x + a.y*s, oc*a.y*a.z - a.x*s, oc*a.z*a.z + c); }
`

export function shatterMaterial(tex: THREE.Texture) {
  return new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      u_map: { value: tex }, u_t: { value: -1 }, u_crackR: { value: 0 }, u_ringR: { value: 0 }, u_tilt: { value: 0 },
      u_hole: { value: 4 }, u_k: { value: 1 }, u_time: { value: 0 }, u_impact: { value: new THREE.Vector2() },
      u_bright: { value: 1 }, u_gloss: { value: 0 }, u_frost: { value: 0 }, u_out: { value: 0 },
      u_crackW: { value: 1.05 },
    },
    vertexShader: /* glsl */ `
      ${COMMON}
      attribute vec3 aCenter; attribute vec2 aUv; attribute float aEdge; attribute float aKind; attribute vec4 aRand; attribute vec2 aRest;
      varying vec2 vUv; varying float vEdge; varying float vKind; varying vec3 vN; varying vec3 vV; varying vec2 vRest; varying float vMove; varying vec4 vRand;
      void main(){
        vec2 c = aCenter.xy; float size = aCenter.z; float dist = aRand.w;
        vec2 dir = dist > 1e-3 ? (c - u_impact) / dist : vec2(0.0, 1.0);
        vec3 p = position; vec3 n = normal;
        // after the second hit every piece sits a hair askew in the frame: the spider-web catches the light piece by piece
        vec3 ax0 = normalize(vec3(aRand.x - 0.5, aRand.y - 0.5, 0.15));
        mat3 R = rotAxis(ax0, u_tilt * (0.006 + 0.022 * aRand.z) * (0.4 + 0.6 * smoothstep(u_hole * 1.4, 0.0, dist)));
        vec3 off = vec3(0.0);
        float move = 0.0;
        if (u_t > 0.0) {
          // the fracture front reaches the far pieces a little later; the hole tears out, the rim pieces stay in the frame
          float fly = 1.0 - smoothstep(u_hole * 0.75, u_hole * 1.25, dist + (aRand.x - 0.5) * u_hole * 0.5);
          float tt = max(0.0, u_t - dist * 0.03);
          float late = step(0.86, aRand.y) * (1.0 - fly); // a few rim pieces lose their grip and tumble out a beat later
          float tl = max(0.0, u_t - 0.9 - aRand.z * 1.4) * late;
          float sp = (0.5 + 2.6 / (0.45 + dist / u_k)) * (0.55 + 0.9 * aRand.y);
          float vz = (1.4 + 3.4 / (0.6 + dist / u_k)) * (0.45 + 1.1 * aRand.z) * u_k;
          vec3 vel = vec3(dir * sp * u_k, vz) * fly;
          off = vel * tt + vec3(0.0, -1.6, 0.0) * tt * tt * fly + vec3(0.0, -2.2 * tl * tl, 0.4 * tl);
          vec3 ax = normalize(vec3(aRand.y - 0.5, aRand.z - 0.5, aRand.x - 0.5) + vec3(-dir.y, dir.x, 0.0) * 0.6);
          float spin = (2.0 + 7.0 * aRand.x) / (0.6 + size * 1.6);
          R = rotAxis(ax, spin * tt * fly + tl * 3.0) * R;
          move = clamp(tt * fly * 3.0 + tl * 2.0, 0.0, 1.0);
        }
        // R6.98: as the camera glides to the CTA the pieces shrink to glass dust instead of all vanishing in one frame
        // (pieces still at rest in the frame mirror the screen exactly, so they are not shrunk: their crack lines and frost
        // fade instead, and they leave without a visible change; their thin edge walls tuck in behind the face)
        p *= 1.0 - u_out * max(smoothstep(0.0, 0.25, move), step(3.5, aKind));
        p = R * p; n = R * n;
        vec3 lp = vec3(c, 0.0) + p + off;
        vec4 mv = modelViewMatrix * vec4(lp, 1.0);
        vN = normalize(normalMatrix * n);
        vV = normalize(-mv.xyz);
        vUv = aUv; vEdge = aEdge; vKind = aKind; vRest = aRest; vMove = move; vRand = aRand;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform sampler2D u_map; uniform float u_bright, u_gloss, u_frost, u_crackW;
      varying vec2 vUv; varying float vEdge; varying float vKind; varying vec3 vN; varying vec3 vV; varying vec2 vRest; varying float vMove; varying vec4 vRand;
      vec3 thinFilm(float cosT, float d){ return 0.5 + 0.5 * cos(6.2831853 * (vec3(0.0, 0.33, 0.67) + d * (1.0 + 1.6 * (1.0 - cosT)))); }
      // a studio in view space: a big softbox up-left, a warm rim behind-right, a dim graphite room
      vec3 studio(vec3 r){
        float box = smoothstep(0.55, 0.92, dot(r, normalize(vec3(-0.55, 0.62, 0.55))));
        float strip = smoothstep(0.86, 0.97, dot(r, normalize(vec3(0.85, 0.15, -0.5))));
        float sky = smoothstep(-0.2, 1.0, r.y);
        return vec3(0.03, 0.035, 0.05) + vec3(0.08, 0.09, 0.12) * sky + vec3(1.8, 1.62, 1.4) * box + vec3(1.4, 0.95, 0.6) * strip;
      }
      void main(){
        vec3 N = normalize(vN); vec3 V = normalize(vV);
        if (!gl_FrontFacing) N = -N;
        float cosT = clamp(abs(dot(N, V)), 0.0, 1.0);
        float fres = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);
        vec3 Rr = reflect(-V, N);
        vec3 env = studio(Rr);
        vec3 col;
        if (vKind > 3.5) {
          // the edge wall: glass seen through its own thickness glows green-cyan, broken into thin-film colour
          vec3 tf = thinFilm(cosT, 0.6 + vRand.x * 1.4);
          col = mix(vec3(0.35, 0.75, 0.68), tf, 0.55) * (0.35 + 1.4 * env.r * 0.5) + env * 0.5;
        } else {
          float dist = length(vRest - u_impact);
          // refraction: a tumbling piece bends its picture; at rest it lines up with the screen exactly
          vec2 bend = N.xy * 0.035 * vMove;
          vec3 img;
          img.r = texture2D(u_map, vUv - bend * 1.12).r;
          img.g = texture2D(u_map, vUv - bend).g;
          img.b = texture2D(u_map, vUv - bend * 0.88).b;
          img *= u_bright;
          if (vKind > 2.5) img *= 0.32; // seen through the back of the piece
          float sheen = smoothstep(0.55, 1.25, vUv.y * 0.8 + (1.0 - vUv.x) * 0.6);
          col = img * (1.0 - 0.12 * sheen * u_gloss) + vec3(0.75, 0.8, 0.9) * sheen * 0.05 * u_gloss;
          // the crushed spot at the impact: a white frosted star
          float fr = u_frost * (1.0 - u_out) * smoothstep(0.42 * u_k, 0.0, dist) * (0.55 + 0.45 * vRand.x);
          col = mix(col, vec3(0.92, 0.95, 1.0), fr * 0.85);
          // cracks: drawn along the piece's own outline (constant pixel width), once the fracture front has passed
          float w = fwidth(vEdge);
          float line = (1.0 - smoothstep(0.0, w * u_crackW, vEdge)) * (0.55 + 0.45 * fract(sin(dot(floor(vRest * 9.0), vec2(12.9898, 78.233))) * 43758.5453));
          float halo = 1.0 - smoothstep(0.0, w * 5.0, vEdge);
          float reach = vKind < 0.5 ? step(dist, u_crackR) : vKind < 1.5 ? step(dist, u_ringR) : 0.0;
          float lineA = line * reach * (1.0 - vMove) * (1.0 - u_out);
          vec3 tf = thinFilm(cosT, 0.4 + dist * 0.35);
          col = mix(col, col * 0.7, halo * reach * 0.3 * (1.0 - vMove) * (1.0 - u_out));
          col += (vec3(0.85, 0.9, 1.0) * 0.5 + tf * 0.28) * lineA;
          // in flight: the face trades its picture for the studio as it turns away, with a thin-film fringe on the grazing angle
          float flight = vMove;
          vec3 face = mix(col, env * 0.9, fres * flight);
          face += tf * fres * 0.6 * flight;
          face += env * 0.06 * flight;
          col = face;
        }
        // highlights: a crisp key + a warm rim catch, the sparkle of a tumbling piece
        vec3 L1 = normalize(vec3(-0.45, 0.62, 0.65)), L2 = normalize(vec3(0.8, 0.2, -0.45));
        float s1 = pow(max(dot(Rr, L1), 0.0), 120.0), s2 = pow(max(dot(Rr, L2), 0.0), 60.0);
        float catchK = vKind > 3.5 ? 1.0 : vMove;
        col += (vec3(1.0) * s1 * 3.0 + vec3(1.0, 0.75, 0.45) * s2 * 2.2) * catchK;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    extensions: { derivatives: true } as any,
  })
}

/** glints: fine glass dust that bursts out with the break and twinkles as it turns */
export function buildGlints(n: number, pr: number) {
  let seed = 911
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const vel = new Float32Array(n * 3), rr = new Float32Array(n * 4), p0 = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, c = Math.pow(rnd(), 0.6)
    const sp = 0.6 + rnd() * 3.4
    vel.set([Math.cos(a) * c * sp, Math.sin(a) * c * sp + 0.4, (1.0 + rnd() * 4.5) * (1 - c * 0.5)], i * 3)
    rr.set([rnd(), rnd(), rnd(), rnd()], i * 4)
    p0.set([0, 0, 0], i * 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(p0, 3))
  g.setAttribute('aVel', new THREE.BufferAttribute(vel, 3))
  g.setAttribute('aRand', new THREE.BufferAttribute(rr, 4))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { u_t: { value: -1 }, u_impact: { value: new THREE.Vector3() }, u_k: { value: 1 }, u_time: { value: 0 }, u_pr: { value: pr }, u_scale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec3 aVel; attribute vec4 aRand;
      uniform float u_t, u_k, u_time, u_pr, u_scale; uniform vec3 u_impact;
      varying float vA; varying vec3 vC;
      void main(){
        float tt = max(0.0, u_t - aRand.w * 0.05);
        vec3 o = vec3((aRand.x - 0.5), (aRand.y - 0.5), 0.0) * 0.6 * u_k;
        vec3 lp = u_impact + o + aVel * u_k * tt * (0.6 + 0.4 * aRand.z) + vec3(0.0, -1.2, 0.0) * tt * tt;
        vec4 mv = modelViewMatrix * vec4(lp, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = pow(0.5 + 0.5 * sin(u_time * (9.0 + 23.0 * aRand.x) + aRand.y * 40.0 + tt * 30.0), 6.0);
        vA = (u_t > 0.0 ? 1.0 : 0.0) * smoothstep(0.0, 0.04, tt) * (1.0 - smoothstep(0.7 + aRand.z * 0.8, 1.9 + aRand.z, tt)) * (0.25 + 1.6 * tw);
        vC = mix(vec3(0.85, 0.95, 1.0), 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + aRand.y)), 0.35);
        gl_PointSize = clamp((1.0 + 2.6 * aRand.z) * u_pr * u_scale * 70.0 / max(0.5, -mv.z), 0.0, 18.0 * u_pr);
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; varying vec3 vC;
      void main(){ vec2 c = gl_PointCoord - 0.5; float r = length(c);
        float core = smoothstep(0.5, 0.0, r); core *= core;
        float cross = max(smoothstep(0.08, 0.0, abs(c.x)) , smoothstep(0.08, 0.0, abs(c.y))) * smoothstep(0.5, 0.1, r);
        float a = (core + cross * 0.6) * vA;
        if (a < 0.002) discard;
        gl_FragColor = vec4(vC * a, 1.0); }`,
  })
  const points = new THREE.Points(g, m)
  points.frustumCulled = false
  return { points, material: m }
}
