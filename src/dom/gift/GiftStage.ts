/**
 * R6.83 GIFT stage (lazy chunk: fetched on the first logo click only).
 * Shifat Oct 22: 07:03 "A but card appears closed beautifully wrapped, then users clicks on box hitzone to click & open.
 * Everything must feel alive & premium quality worthy" · 07:04 "Card should feel to be in same scene but its background
 * must be blurred" · "No jump cut, pop. Smooth gentle anim in out" · 07:06 "Ribbon should be glowy sexy hot pink" ·
 * 07:06-07 "Comes in from bottom of viewport" + "Leaves as particle dust morph out leaving only spinning case study card".
 *
 * One small WebGL context (the page's own scene is held and its frozen frame is the blurred backdrop), procedural
 * geometry only, a PMREM environment built from that same blurred frame plus soft studio strips (so the lacquer and the
 * satin reflect the page they float over), physically lit materials, no shadow maps (a soft contact shadow), phone DPR
 * ≤ 1 with a 0.6 floor (steps down on slow frames), everything disposed and the context released on close.
 */
import * as THREE from 'three'
import { browser } from '../../services/settings'
import { viewport, onViewport } from '../../core/viewport'
import { blurFadeIn, blurFadeOut } from '../../services/blurFade'
import './gift.css'
import { giftSound } from './giftSound'
import { giftMark } from './gift'   // R7.09 QA timeline
import { LOW_END_GPU } from '../../gl/quality'   // R7.09: the gift's fixed phone density
const GIFT_OLD = /[?&]giftold\b/.test(location.search)
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js' // R6.88b CRISP TYPE

const CASE_URL = 'https://surface-tension-case-study.pages.dev/'
const PINK = new THREE.Color('#ff2e93')
const INK = '#121315'
const WARM = new THREE.Color('#ffe0c0'), COOL = new THREE.Color('#9cc6ff')
const TONE = /[?&]gifttone=a/.test(location.search) ? THREE.ACESFilmicToneMapping : THREE.NeutralToneMapping

// ---------- maths ----------
const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a))
const eInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const eOut = (t: number) => 1 - Math.pow(1 - t, 3)
const eOut4 = (t: number) => 1 - Math.pow(1 - t, 4)
const eSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt))

// ---------- dimensions (units) ----------
const B = 1.12, T = 0.034, R = 0.07, BASE_H = 0.58
const L = 1.152, SKIRT_LO = BASE_H - 0.13, PLATE_LO = BASE_H + 0.03, TOP = BASE_H + 0.066
const SK_IN = B + 0.008                       // R6.83b: the skirt's opening clears the walls (it used to cut 4 mm into them)
const PL_A = 0.013 * 0.85, PL_B = 0.013       // the plate's top bevel (ExtrudeGeometry's quarter ellipse: in, down)
const CW = 0.76, CH = 0.96, CR = 0.04
const BTN_W = 0.44, BTN_H = 0.104, PAD = 0.07
const BOX_Y = -0.36
/** R6.83b open timeline (seconds after the tap): ribbon dust R0 + uDR·RK, lid lift L1, tip L2, box dust D0 + uD·DK, card forms
 *  F0→F1, spin from S0, camera push C0→C1 */
const TL = { R0: 0.1, RK: 1.15, L1a: 1.55, L1b: 2.3, L2a: 2.0, L2b: 2.9, D0: 2.65, DK: 1.0, F0: 3.62, F1: 4.85, S0: 4.9, C0: 2.6, C1: 4.9 }

function rrPath(p: THREE.Path, w: number, h: number, r: number) {
  const x = -w / 2, y = -h / 2
  p.moveTo(x + r, y); p.lineTo(x + w - r, y); p.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false)
  p.lineTo(x + w, y + h - r); p.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false)
  p.lineTo(x + r, y + h); p.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false)
  p.lineTo(x, y + r); p.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false)
  return p
}
const rr = (w: number, h: number, r: number) => rrPath(new THREE.Shape(), w, h, r) as THREE.Shape

/** extrude a (rounded) plan upward from y0 by height h */
function up(shape: THREE.Shape, y0: number, h: number, bev: number, curve = 10) {
  const g = new THREE.ExtrudeGeometry(shape, bev > 0
    ? { depth: Math.max(0.001, h - 2 * bev), bevelEnabled: true, bevelThickness: bev, bevelSize: bev * 0.85, bevelOffset: -bev * 0.85, bevelSegments: 3, curveSegments: curve }
    : { depth: h, bevelEnabled: false, curveSegments: curve })
  g.rotateX(-Math.PI / 2); g.translate(0, y0 + (bev > 0 ? bev : 0), 0)
  return g
}

/** merge non-indexed geometries that carry position / normal / uv */
function merge(list: THREE.BufferGeometry[]) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g))
  const out = new THREE.BufferGeometry()
  for (const name of ['position', 'normal', 'uv'] as const) {
    const size = name === 'uv' ? 2 : 3
    let n = 0; for (const g of parts) n += g.getAttribute('position').count
    const arr = new Float32Array(n * size); let o = 0
    for (const g of parts) {
      const a = g.getAttribute(name) as THREE.BufferAttribute | undefined
      const c = g.getAttribute('position').count
      if (a) arr.set((a.array as Float32Array).subarray(0, c * size), o)
      o += c * size
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size))
  }
  list.forEach((g) => g.dispose()); parts.forEach((g) => g.dispose())
  return out
}

/** a flat satin strip along a polyline: width along side(i) (orthogonalised to the tangent), uv u along the length */
function strip(pts: THREE.Vector3[], side: (i: number, n: number) => THREE.Vector3, width: number) {
  const n = pts.length
  const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2)
  let len = 0; const tg = new THREE.Vector3(), s = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
    if (i > 0) len += pts[i].distanceTo(pts[i - 1])
    tg.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize()
    s.copy(side(i, n)); s.addScaledVector(tg, -s.dot(tg)).normalize().multiplyScalar(width / 2)
    const p = pts[i]
    pos.set([p.x - s.x, p.y - s.y, p.z - s.z, p.x + s.x, p.y + s.y, p.z + s.z], i * 6)
    uv.set([len * 4, 0, len * 4, 1], i * 4)
  }
  const idx: number[] = []
  for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx); g.computeVertexNormals()
  return g
}

function buildRibbon() {
  const e1 = 0.0035, e2 = 0.0052, W = 0.118
  const parts: THREE.BufferGeometry[] = []
  // the two bands wrap the LID only (a lid-wrapped gift box): over the top, down the skirt, tucked under its edge
  for (const [e, axis] of [[e1, 0], [e2, 1]] as const) {
    // R6.83b: the band rounds the lid's top edge on the bevel's own quarter ellipse, offset outward by e (a 45° chamfer let
    // the bevel poke through it), runs down the skirt and tucks under the skirt's lip only (it used to cut into the wall)
    const xl = L / 2 + e, yt = TOP + e, ys = SKIRT_LO - e, xi = SK_IN / 2 + 0.002
    const arc = (sg: number): [number, number][] => {
      const o: [number, number][] = []
      for (let i = 0; i <= 6; i++) { const f = (i / 6) * Math.PI / 2; o.push([sg * (L / 2 - PL_A + (PL_A + e) * Math.sin(f)), TOP - PL_B + (PL_B + e) * Math.cos(f)]) }
      return o
    }
    const ra = arc(1), la = arc(-1)
    const pieces: [number, number][][] = [
      [[la[0][0], yt], [ra[0][0], yt]],
      ra, [[xl, ra[6][1]], [xl, ys]], [[xl, ys], [xi, ys]],
      la, [[-xl, la[6][1]], [-xl, ys]], [[-xl, ys], [-xi, ys]],
    ]
    for (const pc of pieces) {
      const pts: THREE.Vector3[] = []
      const push = (x: number, y: number) => pts.push(axis === 0 ? new THREE.Vector3(x, y, 0) : new THREE.Vector3(0, y, x))
      if (pc.length > 2) pc.forEach(([x, y]) => push(x, y))
      else {
        const [a, b] = pc; const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.12))
        for (let i = 0; i <= steps; i++) push(lerp(a[0], b[0], i / steps), lerp(a[1], b[1], i / steps))
      }
      const sd = axis === 0 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)
      parts.push(strip(pts, () => sd, W))
    }
  }
  // the bow: two big loops, two small ones, a knot and two tails, all resting on the lid
  const base = new THREE.Vector3(0, TOP + e2 + 0.003, 0), upv = new THREE.Vector3(0, 1, 0)
  // R6.83b: a twisted strip's low edge dips by halfWidth·sin(twist); lift those points so no edge ever touches the lid or the bands
  const clear = (pts: THREE.Vector3[], half: number, k: (i: number, n: number) => number) => {
    pts.forEach((p, i) => { const dip = half * Math.abs(Math.sin(k(i, pts.length))), h = p.y - base.y; if (dip > h - 0.003) p.y += dip - h + 0.003 })
  }
  const loop = (ang: number, len: number, h: number, tw: number) => {
    const d = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang))
    const c2 = [[0, 0.006], [0.07, 0.05], [0.17, 0.105], [0.27, 0.118], [0.32, 0.078], [0.295, 0.032], [0.19, 0.014], [0.08, 0.009], [0, 0.006]]
    const ctrl = c2.map(([u, v]) => base.clone().addScaledVector(d, u * len / 0.32).addScaledVector(upv, v * h / 0.118))
    const pts = new THREE.CatmullRomCurve3(ctrl, false, 'catmullrom', 0.5).getPoints(44)
    clear(pts, 0.052, (i, n) => Math.sin(Math.PI * i / (n - 1)) * tw)
    const s0 = new THREE.Vector3().crossVectors(upv, d).normalize()
    parts.push(strip(pts, (i, n) => { const k = Math.sin(Math.PI * i / (n - 1)) * tw; return s0.clone().multiplyScalar(Math.cos(k)).addScaledVector(upv, Math.sin(k)) }, 0.104))
  }
  const nBands = parts.length
  loop(0.18, 0.31, 0.15, 0.45); loop(Math.PI + 0.18, 0.31, 0.15, -0.45)
  loop(Math.PI / 2 + 0.55, 0.22, 0.175, 0.35); loop(-Math.PI / 2 + 0.55, 0.22, 0.175, -0.35)
  for (const ang of [Math.PI * 0.75 + 0.1, -Math.PI * 0.25 + 0.25]) {
    const d = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)), pts: THREE.Vector3[] = []
    for (let i = 0; i <= 16; i++) { const u = (i / 16) * 0.4; pts.push(base.clone().addScaledVector(d, u).addScaledVector(upv, 0.004 + 0.012 * Math.sin(u * 7.5) * (u / 0.4) + 0.02 * (1 - u / 0.4) * (1 - u / 0.4))) }
    clear(pts, 0.05, (i, n) => 0.25 * i / n)
    const s0 = new THREE.Vector3().crossVectors(upv, d).normalize()
    parts.push(strip(pts, (i, n) => s0.clone().multiplyScalar(Math.cos(0.25 * i / n)).addScaledVector(upv, Math.sin(0.25 * i / n)), 0.1))
  }
  { // knot: a short band wrapped round the loops' roots
    const dk = new THREE.Vector3(Math.cos(0.18), 0, Math.sin(0.18)), c = base.clone().addScaledVector(upv, 0.036), pts: THREE.Vector3[] = []
    for (let i = 0; i <= 28; i++) { const a = (i / 28) * Math.PI * 2; pts.push(c.clone().addScaledVector(dk, Math.cos(a) * 0.04).addScaledVector(upv, Math.sin(a) * 0.036)) }
    const s0 = new THREE.Vector3().crossVectors(upv, dk).normalize()
    parts.push(strip(pts, () => s0, 0.086))
  }
  // R6.83b: the ribbon no longer slides off (it passed through the box); bands + bow stay put and turn to dust in place
  void nBands
  return { bands: merge(parts) }
}

function buildBox() {
  const ring = rr(B, B, R); ring.holes.push(rrPath(new THREE.Path(), B - 2 * T, B - 2 * T, R - T * 0.6))
  const walls = up(ring, 0, BASE_H - 0.004, 0.012)
  const plate = up(rr(L, L, R + 0.016), PLATE_LO, TOP - PLATE_LO, 0.013)
  const sk = rr(L, L, R + 0.016); sk.holes.push(rrPath(new THREE.Path(), SK_IN, SK_IN, R + 0.004))
  const skirt = up(sk, SKIRT_LO, PLATE_LO - SKIRT_LO + 0.011, 0.005)
  const floor = up(rr(B - 2 * T + 0.004, B - 2 * T + 0.004, R - T * 0.6), 0.004, 0.03, 0)
  return { base: walls, lid: merge([plate, skirt]), floor }
}

// ---------- shared dissolve (mesh discard + dust birth use the same threshold) ----------
const U = {
  uD: { value: 0 }, uDR: { value: 0 }, uHit: { value: new THREE.Vector3(0, TOP, 0) }, uSpan: { value: 1.7 },
  uHitR: { value: new THREE.Vector3(0, TOP + 0.06, 0) }, uSpanR: { value: 0.72 }, uForm: { value: 0 }, uCardM: { value: new THREE.Matrix4() }, uCardInv: { value: new THREE.Matrix4() }, uFoil: { value: 0 },
  uEdge: { value: PINK.clone().multiplyScalar(3.2) }, uGlow: { value: 0.0 }, uTime: { value: 0 }, uFocus: { value: 4 },
}
const NOISE = /* glsl */`
uniform float uD; uniform vec3 uHit; uniform float uSpan;
float gH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float gN(vec3 x) { vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gH(i), gH(i + vec3(1, 0, 0)), f.x), mix(gH(i + vec3(0, 1, 0)), gH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(gH(i + vec3(0, 0, 1)), gH(i + vec3(1, 0, 1)), f.x), mix(gH(i + vec3(0, 1, 1)), gH(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
float gTh(vec3 p) { return clamp(length(p - uHit) / uSpan * 0.64 + gN(p * 6.0) * 0.36, 0.0, 1.0); }
`
function dissolvable(m: THREE.MeshPhysicalMaterial, key: string, glow: boolean, d: { value: number } = U.uD, hit = U.uHit, span = U.uSpan) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uD: d, uHit: hit, uSpan: span, uEdge: U.uEdge, uGlow: U.uGlow })
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vBoxP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBoxP = position;')
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vBoxP;\nuniform vec3 uEdge;\nuniform float uGlow;\n${NOISE}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nfloat gT = gTh(vBoxP);\nif (uD > 0.0 && gT < uD) discard;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += uEdge * (1.0 - smoothstep(0.0, 0.055, gT - uD)) * step(0.0001, uD);
${glow ? 'float gF = 1.0 - abs(dot(normal, normalize(vViewPosition)));\ntotalEmissiveRadiance += emissive * uGlow * (0.35 + 1.6 * gF * gF);' : ''}`)
  }
  m.customProgramCacheKey = () => key
  return m
}

// ---------- R6.83b card: forms out of the dust (center out, a glowing seam), foil edge that catches the light as it spins ----------
const FOIL = /* glsl */`
uniform float uForm; uniform float uFoil; uniform float uTime; uniform vec3 uEdge;
varying vec3 vCP;
float cardSd(vec2 p) { vec2 b = vec2(${(CW / 2).toFixed(4)}, ${(CH / 2).toFixed(4)}) - ${CR.toFixed(4)}; vec2 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - ${CR.toFixed(4)}; }
float formTh() { return clamp(length(vCP.xy / vec2(${(CW / 2).toFixed(4)}, ${(CH / 2).toFixed(4)})) * 0.62 + gN(vCP * 7.0) * 0.16, 0.0, 1.0); }
vec3 foilCol(vec3 n, vec3 v) {
  float h = fract(vCP.x * 0.9 + vCP.y * 0.7 + dot(n, v) * 0.9 + uFoil * 0.22 + uTime * 0.04);
  vec3 c = 0.5 + 0.5 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67)));
  return mix(c, vec3(1.0, 0.5, 0.78), 0.22);
}
float foilGlint() { return pow(max(0.0, sin(uFoil * 1.3 + (vCP.x * 0.8 + vCP.y) * 4.0 - uTime * 0.6)), 8.0); }
`
function cardMat<M extends THREE.MeshStandardMaterial>(m: M, key: string, kind: 'face' | 'edge') {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uD: U.uD, uHit: U.uHit, uSpan: U.uSpan, uEdge: U.uEdge, uForm: U.uForm, uFoil: U.uFoil, uTime: U.uTime, uCardInv: U.uCardInv })
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform mat4 uCardInv;\nvarying vec3 vCP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCP = (uCardInv * modelMatrix * vec4(transformed, 1.0)).xyz;')
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${NOISE}\n${FOIL}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nfloat fTh = formTh();\nif (fTh > uForm * 1.001) discard;\nfloat fRim = ' + (kind === 'edge' ? '1.0' : '1.0 - smoothstep(0.004, 0.012, -cardSd(vCP.xy))') + ';')
      .replace('#include <map_fragment>', `#include <map_fragment>\n${kind === 'face' ? 'vec3 fCol0 = foilCol(vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, 1.0));\ndiffuseColor.rgb = mix(diffuseColor.rgb, fCol0 * 0.8, fRim * 0.85);' : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance *= 1.0 - fRim * ${kind === 'face' ? '0.85' : '0.0'};
{ vec3 fv = normalize(vViewPosition); float fr = 1.0 - abs(dot(normal, fv));
  totalEmissiveRadiance += foilCol(normal, fv) * fRim * (${kind === 'edge' ? '0.55' : '0.12'} + 1.5 * foilGlint() + 0.7 * fr * fr); }
totalEmissiveRadiance += mix(uEdge, vec3(2.4), 0.35) * (1.0 - smoothstep(0.0, 0.03, uForm - fTh)) * step(uForm, 0.999);`)
  }
  m.customProgramCacheKey = () => key
  return m
}

// ---------- procedural textures ----------
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}
/** fine embossed pinstripe (the wrap's foil grain): a height field turned into a normal map */
function pinstripe() {
  const N = 128, hgt = new Float32Array(N * N)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) hgt[y * N + x] = 0.5 + 0.5 * Math.sin(((x + y) / N) * Math.PI * 2 * 8) + (Math.random() - 0.5) * 0.18
  return canvasTex(N, N, (g) => {
    const im = g.createImageData(N, N)
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = hgt[y * N + ((x + 1) % N)] - hgt[y * N + ((x + N - 1) % N)], dy = hgt[((y + 1) % N) * N + x] - hgt[((y + N - 1) % N) * N + x]
      const nx = -dx * 0.8, ny = -dy * 0.8, nz = 1, l = Math.hypot(nx, ny, nz), i = (y * N + x) * 4
      im.data[i] = (nx / l * 0.5 + 0.5) * 255; im.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; im.data[i + 2] = (nz / l * 0.5 + 0.5) * 255; im.data[i + 3] = 255
    }
    g.putImageData(im, 0, 0)
  }, false)
}
const radial = (inner: string, outer: string) => canvasTex(128, 128, (g) => {
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, inner); gr.addColorStop(1, outer)
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128)
})
const MARK = new Path2D('M100 0H200L100 100H0Z M100 100H200L100 200H0Z')
const FONT = `'Inter Variable', 'Inter', system-ui, sans-serif`
function setTrack(g: CanvasRenderingContext2D, px: number) { if ('letterSpacing' in g) (g as any).letterSpacing = `${px}px` }

function cardFront(pw: number) {
  // R6.88b CRISP TYPE (Shifat 11:01 PM: "Gift cards on both sites should have hi res crisp texts"): the words, the mark and
  // the button are real vector type now (cardType, laid on the card face in 3D by the CSS3D layer, at the device's full
  // pixel density whatever the GL canvas's density); the texture is the bare card stock
  const ph = Math.round(pw * CH / CW)
  return canvasTex(pw, ph, (g) => { g.fillStyle = '#f7f7f4'; g.fillRect(0, 0, pw, ph) })
}
const MARK_D = 'M100 0H200L100 100H0Z M100 100H200L100 200H0Z'
/** R6.88b: the card's front type as SVG (K css px per card unit), the SAME layout the canvas used to draw: Surface /
 *  Tension, "The case study", the mark, and the "View case study" button (with its hover state as a separate layer) */
function cardType(K: number) {
  const pw = CW * K, ph = CH * K, pad = PAD * K, fs = 0.118 * K, fs2 = 0.048 * K, m = 0.07 * K
  const bw = BTN_W * K, bh = BTN_H * K, bl = PAD * K, bt = ph - (PAD + BTN_H) * K, r = bh / 2, bfs = 0.034 * K
  const cr = bh * 0.38, cx = bw - bh / 2, cy = bh / 2, a = cr * 0.36, lw = Math.max(2, bh * 0.045)
  const arrow = `M${cx - a} ${cy + a}L${cx + a} ${cy - a}M${cx - a * 0.55} ${cy - a}L${cx + a} ${cy - a}L${cx + a} ${cy + a * 0.55}`
  const btn = (hover: boolean) => `<g class="gift__btn${hover ? ' gift__btn--h' : ''}" transform="translate(${bl} ${bt})"${hover ? ' opacity="0"' : ''}>
  <rect width="${bw}" height="${bh}" rx="${r}" fill="${INK}"/>
  <text x="${r * 0.95}" y="${bh / 2 + bfs * 0.04}" font-size="${bfs}" letter-spacing="${(-0.02 * bfs).toFixed(3)}" fill="#ffffff" dominant-baseline="middle">View case study</text>
  <circle cx="${cx}" cy="${cy}" r="${cr}" fill="${hover ? '#ff2e93' : '#fafafa'}"/>
  <path d="${arrow}" fill="none" stroke="${hover ? '#ffffff' : INK}" stroke-width="${lw}" stroke-linecap="round" stroke-linejoin="round"/></g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${pw} ${ph}" aria-hidden="true" style="display:block;font-family:${FONT.replace(/"/g, "'")};font-weight:400;text-rendering:geometricPrecision">
  <text x="${pad - fs * 0.04}" y="${pad + fs * 0.78}" font-size="${fs}" letter-spacing="${(-0.035 * fs).toFixed(3)}" fill="${INK}">Surface</text>
  <text x="${pad - fs * 0.04}" y="${pad + fs * 1.8}" font-size="${fs}" letter-spacing="${(-0.035 * fs).toFixed(3)}" fill="${INK}">Tension</text>
  <text x="${pad}" y="${pad + fs * 1.8 + fs2 * 1.9}" font-size="${fs2}" letter-spacing="${(-0.01 * fs2).toFixed(3)}" fill="#54585e">The case study</text>
  <path d="${MARK_D}" fill="${INK}" transform="translate(${pw - pad - m} ${pad}) scale(${m / 200})"/>
  <g class="gift__btns" opacity="0">${btn(false)}${btn(true)}</g></svg>`
}
function cardBack(pw: number) {
  const ph = Math.round(pw * CH / CW), s = pw / CW
  return canvasTex(pw, ph, (g) => {
    g.fillStyle = INK; g.fillRect(0, 0, pw, ph)
    const m = 0.16 * s
    g.save(); g.translate(pw / 2 - m / 2, ph / 2 - m / 2); g.scale(m / 200, m / 200); g.fillStyle = '#ffffff'; g.fill(MARK); g.restore()   // Shifat 11:38: back texture flipped horizontally (was mirrored)
  })
}
function buttonTex(pw: number, hover: boolean) {
  const ph = Math.round(pw * BTN_H / BTN_W), s = pw / BTN_W
  return canvasTex(pw, ph, (g) => {
    g.clearRect(0, 0, pw, ph)
    const r = ph / 2
    g.fillStyle = INK; g.beginPath(); g.roundRect(0, 0, pw, ph, r); g.fill()
    const fs = 0.034 * s; g.font = `400 ${fs}px ${FONT}`; setTrack(g, -0.02 * fs); g.fillStyle = '#ffffff'; g.textBaseline = 'middle'
    g.fillText('View case study', r * 0.95, ph / 2 + fs * 0.04)
    const cr = ph * 0.38, cx = pw - ph / 2, cy = ph / 2
    g.fillStyle = hover ? '#ff2e93' : '#fafafa'; g.beginPath(); g.arc(cx, cy, cr, 0, Math.PI * 2); g.fill()
    g.strokeStyle = hover ? '#ffffff' : INK; g.lineWidth = Math.max(2, ph * 0.045); g.lineCap = 'round'; g.lineJoin = 'round'
    const a = cr * 0.36; g.beginPath(); g.moveTo(cx - a, cy + a); g.lineTo(cx + a, cy - a); g.moveTo(cx - a * 0.55, cy - a); g.lineTo(cx + a, cy - a); g.lineTo(cx + a, cy + a * 0.55); g.stroke()
  })
}
function faceGeo(w: number, h: number, r: number) {
  const g = new THREE.ShapeGeometry(rr(w, h, r), 10)
  const p = g.getAttribute('position'), uv = g.getAttribute('uv')
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + w / 2) / w, (p.getY(i) + h / 2) / h)
  return g
}

/** area-weighted surface samples of a box-space geometry */
function sample(g: THREE.BufferGeometry, n: number, pink: number, out: { p: number[]; nn: number[]; k: number[] }) {
  const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), idx = g.index
  const tri = idx ? idx.count / 3 : pos.count / 3
  const at = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k)
  const cum = new Float32Array(tri); let acc = 0
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let t = 0; t < tri; t++) { a.fromBufferAttribute(pos, at(t, 0)); b.fromBufferAttribute(pos, at(t, 1)); c.fromBufferAttribute(pos, at(t, 2)); acc += b.sub(a).cross(c.sub(a)).length() / 2; cum[t] = acc }
  for (let i = 0; i < n; i++) {
    const r = Math.random() * acc; let lo = 0, hi = tri - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m }
    let u = Math.random(), v = Math.random(); if (u + v > 1) { u = 1 - u; v = 1 - v }
    const i0 = at(lo, 0), i1 = at(lo, 1), i2 = at(lo, 2), w = 1 - u - v
    for (let k = 0; k < 3; k++) {
      out.p.push(pos.getComponent(i0, k) * w + pos.getComponent(i1, k) * u + pos.getComponent(i2, k) * v)
      out.nn.push(nor.getComponent(i0, k) * w + nor.getComponent(i1, k) * u + nor.getComponent(i2, k) * v)
    }
    out.k.push(pink)
  }
}

type DustMode = 'rise' | 'form'
/**
 * R6.83b dust. 'rise' (the ribbon + bow, Shifat 07:49): each grain is born where the ribbon burns away and floats UP and
 * out through the top of the frame, eased in like a lifting ember, glowing hot pink. 'form' (the box + lid, 07:57 A): each
 * grain puffs off the surface, then spirals in and lands on the card (uCardM: the live card's world matrix), so the dust
 * turns into the card in one motion. Positions are driven entirely in the vertex shader; nothing per grain on the CPU.
 */
function dust(srcs: [THREE.BufferGeometry, number][], pink: number, d: { value: number }, mode: DustMode, hit: { value: THREE.Vector3 }, span: { value: number }, cardM?: { value: THREE.Matrix4 }) {
  const o = { p: [] as number[], nn: [] as number[], k: [] as number[] }
  for (const [g, n] of srcs) sample(g, n, pink, o)
  const geo = new THREE.BufferGeometry()
  const cnt = o.k.length
  geo.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3))
  geo.setAttribute('aN', new THREE.Float32BufferAttribute(o.nn, 3))
  const rnd = new Float32Array(cnt * 3); for (let i = 0; i < rnd.length; i++) rnd[i] = Math.random()
  geo.setAttribute('aR', new THREE.BufferAttribute(rnd, 3))
  if (mode === 'form') {
    // landing spots on the card's face: 70 % spread over the face, 30 % tracing its rounded outline (crisp edges as it forms)
    const t = new Float32Array(cnt * 2)
    for (let i = 0; i < cnt; i++) {
      let x: number, y: number
      if (Math.random() < 0.3) {
        const u = Math.random() * 2 * (CW + CH), inset = 0.006
        if (u < CW) { x = -CW / 2 + u; y = CH / 2 - inset } else if (u < CW + CH) { x = CW / 2 - inset; y = CH / 2 - (u - CW) }
        else if (u < 2 * CW + CH) { x = CW / 2 - (u - CW - CH); y = -CH / 2 + inset } else { x = -CW / 2 + inset; y = -CH / 2 + (u - 2 * CW - CH) }
      } else { x = (Math.random() - 0.5) * (CW - 0.02); y = (Math.random() - 0.5) * (CH - 0.02) }
      t[i * 2] = x; t[i * 2 + 1] = y
    }
    geo.setAttribute('aT', new THREE.BufferAttribute(t, 2))
  }
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 4.5)
  const rise = mode === 'rise'
  const mat = new THREE.ShaderMaterial({
    uniforms: { uD: d, uHit: hit, uSpan: span, uTime: U.uTime, uFocus: U.uFocus, uSize: { value: rise ? 30 : 24 }, uCardM: cardM ?? { value: new THREE.Matrix4() } },
    vertexShader: /* glsl */`
      attribute vec3 aN; attribute vec3 aR; ${rise ? '' : 'attribute vec2 aT;'}
      uniform float uTime; uniform float uSize; uniform float uFocus; uniform mat4 uCardM;
      varying float vA; varying float vK; varying float vC;
      ${NOISE}
      vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
      void main() {
        float th = gTh(position);
        vec3 wp; float on; float size;
        ${rise ? `
        // born at the burning edge, then lifts: slow at first, gathering speed, drifting apart, swaying like warm air
        float lp = clamp((uD - th) / 0.9, 0.0, 1.0);
        float e = 1.0 - (1.0 - lp) * (1.0 - lp);
        vec3 p = position + aN * e * 0.05;
        p.y += 3.6 * pow(lp, 1.65) + e * 0.06;
        p.xz += (aR.xz - 0.5) * vec2(0.8, 0.6) * lp + (aR.xz - 0.5) * 0.08 * e;
        float sw = uTime * 1.4 + aR.x * 6.2831;
        p.x += sin(sw + p.y * 2.2) * 0.07 * e; p.z += cos(sw * 0.8 + p.y * 1.8) * 0.07 * e;
        wp = (modelMatrix * vec4(p, 1.0)).xyz;
        on = step(0.0001, lp);
        vA = on * smoothstep(0.0, 0.05, lp) * (1.0 - smoothstep(0.82, 1.0, lp)) * (0.75 + 0.25 * sin(uTime * 9.0 + aR.y * 40.0));
        vC = 0.0;
        size = (0.6 + aR.y * 0.9) * (1.0 - lp * 0.35);
        ` : `
        // puff off the surface, then drain into the card like a vortex: the spiral tightens and speeds up as it lands
        float lp = clamp((uD - th) / 0.25, 0.0, 1.0);
        float e = 1.0 - (1.0 - lp) * (1.0 - lp);
        vec3 p = position + aN * e * 0.07 + (aR - 0.5) * vec3(0.3, 0.18, 0.3) * e;
        p.y += e * 0.08;
        float sw = uTime * 1.2 + aR.x * 6.2831;
        p.x += sin(sw + p.y * 3.0) * 0.03 * e; p.z += cos(sw * 0.9 + p.y * 2.5) * 0.03 * e;
        vec3 sp = (modelMatrix * vec4(p, 1.0)).xyz;
        float c = clamp((uD - th - 0.15 - aR.z * 0.2) / 0.8, 0.0, 1.0);
        float k = c * c;
        vec3 C = (uCardM * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 T = (uCardM * vec4(aT, 0.009, 1.0)).xyz;
        wp = C + rotY(sp - C, (3.4 + aR.y * 1.6) * c) * (1.0 - k) + (T - C) * k;
        wp.y += sin(3.14159 * c) * 0.08;
        on = step(0.0001, lp);
        vA = on * smoothstep(0.0, 0.08, lp) * (0.8 + 0.8 * c) * (1.0 - smoothstep(0.9, 1.0, c));
        vC = c;
        size = (0.55 + aR.y * 0.9) * (1.0 - lp * 0.3) * (1.0 - 0.5 * c);
        `}
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mv;
        vK = ${rise ? '1.0' : 'aR.x'};
        float coc = clamp(abs(-mv.z - uFocus) * 1.8, 0.0, 2.5);   // shallow depth of field: off-focus dust grows soft
        vA /= 1.0 + coc * 1.4;
        gl_PointSize = on * uSize * size * (1.0 + coc) / max(0.1, -mv.z);
      }`,
    fragmentShader: /* glsl */`
      varying float vA; varying float vK; varying float vC;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA;
        ${rise
          ? 'vec3 c = mix(vec3(1.0, 0.18, 0.58), vec3(1.0, 0.86, 0.94), smoothstep(0.22, 0.0, d) * 0.7) * 1.25;'
          : 'vec3 c = mix(vec3(0.86, 0.89, 0.94), mix(vec3(1.0, 0.95, 0.88), vec3(1.0, 0.36, 0.7), step(0.72, vK)), vC * 0.85) * (1.0 + 0.6 * vC);'}
        gl_FragColor = vec4(c, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  })
  const pts = new THREE.Points(geo, mat)
  pts.frustumCulled = false
  return pts
}

// ---------- film: light shaft, motes, grain / vignette / letterbox feel ----------
function shaftTex() {
  return canvasTex(128, 256, (g) => {
    const im = g.createImageData(128, 256)
    for (let y = 0; y < 256; y++) for (let x = 0; x < 128; x++) {
      const u = (x - 63.5) / 64, v = y / 255
      const w = 0.35 + 0.65 * v                                     // the beam widens as it falls
      const a = Math.exp(-(u * u) / (w * w * 0.18)) * Math.pow(Math.sin(Math.PI * Math.min(1, v * 1.1)), 1.2) * (1 - 0.35 * v)
      const i = (y * 128 + x) * 4; im.data[i] = im.data[i + 1] = im.data[i + 2] = 255; im.data[i + 3] = Math.round(255 * a)
    }
    g.putImageData(im, 0, 0)
  })
}
function motes(n: number) {
  const p = new Float32Array(n * 3), r = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { p.set([(Math.random() - 0.5) * 3.2, -0.7 + Math.random() * 2.2, (Math.random() - 0.5) * 2.0], i * 3); r.set([Math.random(), Math.random(), Math.random()], i * 3) }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3)); geo.setAttribute('aR', new THREE.BufferAttribute(r, 3))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.4, 0), 4)
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uFocus: U.uFocus, uSize: { value: 9 }, uA: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec3 aR; uniform float uTime; uniform float uFocus; uniform float uSize; uniform float uA; varying float vA;
      void main() {
        vec3 p = position;
        p.y = mod(p.y + 0.7 + uTime * (0.03 + aR.x * 0.05), 2.2) - 0.7;
        p.x += sin(uTime * (0.2 + aR.y * 0.3) + aR.z * 6.28) * 0.12;
        p.z += cos(uTime * (0.17 + aR.x * 0.2) + aR.y * 6.28) * 0.08;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float coc = clamp(abs(-mv.z - uFocus) * 1.5, 0.0, 3.0);
        float edge = smoothstep(-0.7, -0.4, p.y) * (1.0 - smoothstep(1.2, 1.5, p.y));
        vA = uA * edge * (0.25 + 0.75 * aR.z) / (1.0 + coc * 1.6) * (0.6 + 0.4 * sin(uTime * (1.0 + aR.y) + aR.x * 9.0));
        gl_PointSize = uSize * (0.5 + aR.z) * (1.0 + coc * 1.3) / max(0.1, -mv.z);
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(1.0, 0.9, 0.78, smoothstep(0.5, 0.05, d) * vA); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  })
  return new THREE.Points(geo, mat)
}
function filmPass() {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uAspect: { value: 1 }, uK: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime; uniform float uAspect; uniform float uK; varying vec2 vUv;
      void main() {
        vec2 c = (vUv - 0.5) * vec2(min(uAspect, 1.6), 1.0);
        float vig = smoothstep(0.32, 1.0, length(c) * 1.05);
        float lb = smoothstep(0.11, 0.0, vUv.y) + smoothstep(0.89, 1.0, vUv.y);   // a soft letterbox feel, no hard bars
        float dark = (vig * 0.4 + lb * 0.16) * uK;
        vec2 q = floor(gl_FragCoord.xy) + floor(fract(uTime * 11.0) * 61.0) * vec2(17.0, 29.0);
        float n = fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        float ga = abs(n) * 0.075 * uK;
        float a = dark + ga;
        gl_FragColor = vec4(vec3(n > 0.0 ? 1.0 : 0.0) * ga / max(a, 1e-4), a);
      }`,
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  })
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 9999
  return m
}

/** the page's mood, read from the blurred frame (unchanged from R6.83; a function since R7.09 so a parked stage re-reads it) */
function readMood(snap: HTMLCanvasElement | null, mood: THREE.Color) {
  const pre = snap?.dataset.mood?.split(',').map(Number)   // R7.09: read once by gift.ts at the grab (no read-back here)
  if (pre && pre.length === 3 && pre.every((v) => Number.isFinite(v))) { mood.setRGB(pre[0] / 255, pre[1] / 255, pre[2] / 255, THREE.SRGBColorSpace); return }
  if (snap && snap.width > 2) try {
    const d = snap.getContext('2d')!.getImageData(0, 0, snap.width, snap.height).data; let r = 0, g = 0, b = 0, n = 0
    for (let i = 0; i < d.length; i += 16) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++ }
    mood.setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace)
  } catch { /* tainted or empty: neutral */ }
}

// ---------- environment: the page's own blurred frame + soft studio strips ----------
function makeEnv(renderer: THREE.WebGLRenderer, snap: HTMLCanvasElement | null) {
  const b = envBuilder(renderer); const rt = b.build(snap); b.dispose(); return rt
}
/** R7.09: the same environment, with its PMREM generator and its scene kept alive between builds. A parked stage builds it
 *  once while warming (programs linked then) and again from the real frozen frame on show(); disposing the generator in
 *  between released its blur programs, so the rebuild re-linked them on the tap (measured: 6.6 s sim). Same scene, same
 *  numbers as makeEnv always used. */
function envBuilder(renderer: THREE.WebGLRenderer) {
  const env = new THREE.Scene()
  const disposables: { dispose(): void }[] = []
  const sg = new THREE.SphereGeometry(20, 32, 16); disposables.push(sg)
  const tx = new THREE.CanvasTexture(document.createElement('canvas')); tx.colorSpace = THREE.SRGBColorSpace; disposables.push(tx)
  const sm = new THREE.MeshBasicMaterial({ map: tx, side: THREE.BackSide, color: new THREE.Color(0.75, 0.75, 0.75) })
  disposables.push(sm); env.add(new THREE.Mesh(sg, sm))
  const pg = new THREE.PlaneGeometry(1, 1); disposables.push(pg)
  const strip = (x: number, y: number, z: number, w: number, h: number, k: number, tint?: THREE.Color) => {
    const m = new THREE.MeshBasicMaterial({ color: (tint ?? new THREE.Color(1, 1, 1)).clone().multiplyScalar(k), side: THREE.DoubleSide }); disposables.push(m)
    const me = new THREE.Mesh(pg, m); me.position.set(x, y, z); me.scale.set(w, h, 1); me.lookAt(0, 0, 0); env.add(me)
  }
  strip(0, 9, 0, 9, 9, 2.2)              // top softbox
  strip(-8, 2.5, 3, 2.2, 10, 5.2, WARM)  // key strip (left front, warm)
  strip(8, 1.5, -2, 1.6, 9, 3.4, COOL)   // right strip (cool)
  strip(0, 3, -9, 12, 1.4, 3.2, COOL)    // back rim bar (cool)
  strip(1, -1.5, 9, 6, 2.5, 0.9)         // low front fill
  strip(-5, -2, -6, 2.5, 2.5, 1.6, PINK) // a warm pink bounce from the ribbon's side
  const pm = new THREE.PMREMGenerator(renderer)
  return {
    build(snap: HTMLCanvasElement | null) {
      if (snap && snap.width > 2) { if (tx.image !== snap) { tx.image = snap } tx.needsUpdate = true; sm.map = tx; sm.color.setRGB(0.75, 0.75, 0.75) }
      else { sm.map = null; sm.color.setRGB(0.32, 0.34, 0.38) }
      sm.needsUpdate = true
      return pm.fromScene(env, 0.03, 0.1, 40)
    },
    dispose() { pm.dispose(); disposables.forEach((d) => d.dispose()) },
  }
}

export type GiftHandle = { close(): Promise<void>; show?: () => void }

export type GiftOpts = { reduced: boolean; close: () => void; parked?: boolean }
/** the tap path: the whole stage built in one go (as 7.08) */
export function mountGift(root: HTMLElement, opts: GiftOpts): GiftHandle {
  const g = mountSteps(root, opts)
  let r = g.next()
  while (!r.done) r = g.next()
  return r.value
}
/** R7.09 PARKED (Shifat 10:00 PM "too slow to trigger"): the stage built ahead of the tap, one slice per frame (no long
 *  task), its programs submitted one object per frame and drawn once off screen, then held until show(): the tap only
 *  reveals it. */
export function mountGiftParked(root: HTMLElement, opts: GiftOpts): Promise<GiftHandle> {
  ;(window as any).__giftT = { tap: performance.now(), parkedWarm: true }   // QA: the warm's own timeline (replaced by the tap's)
  return new Promise((res) => {
    const g = mountSteps(root, { ...opts, parked: true })
    const step = () => { const r = g.next(); if (r.done) res(r.value); else requestAnimationFrame(step) }
    requestAnimationFrame(step)
  })
}
function* mountSteps(root: HTMLElement, opts: GiftOpts): Generator<void, GiftHandle, void> {
  const reduced = opts.reduced
  giftMark('mount')
  // the shared uniforms outlive a close: a second open starts wrapped again
  U.uD.value = 0; U.uDR.value = 0; U.uForm.value = 0; U.uGlow.value = 0; U.uHit.value.set(0, TOP, 0)
  const phone = browser.isMobile || (viewport.w <= 812 && matchMedia('(pointer: coarse)').matches)
  // R7.09 (Shifat 10:00 PM "jittery. Frame drops"): phones pick ONE density before the first frame and never resize the
  // (antialiased, MSAA) canvas again: the 7.08 governor stepped 1.0 -> 0.6 in 0.1 steps on slow frames, each step a canvas +
  // MSAA reallocation (his GPU report: multisample_renderbuffer_resize_emulation) = a hitch and a visible resolution pop,
  // up to 4 of them while the box rose and opened. Budget GPUs (LOW_END_GPU: his Adreno 506) take 0.8, other phones 1.0.
  // ?giftold = the 7.08 governor.
  const phoneFixed = phone && !GIFT_OLD
  const dprMax = phone ? Math.min(devicePixelRatio || 1, phoneFixed && LOW_END_GPU ? 0.8 : 1) : Math.min(devicePixelRatio || 1, 1.2)
  const dprMin = phone ? 0.6 : 0.8
  let dpr = dprMax

  // ---------- DOM ----------
  const canvas = document.createElement('canvas'); canvas.className = 'gift__gl'; canvas.setAttribute('aria-hidden', 'true')
  const sr = document.createElement('div'); sr.className = 'sr-only'
  sr.innerHTML = '<h2>Surface Tension</h2><p>The case study</p>'
  const hit = document.createElement('button'); hit.type = 'button'; hit.className = 'gift__hit'; hit.setAttribute('aria-label', 'Surface Tension')
  const cta = document.createElement('a'); cta.className = 'gift__cta'; cta.href = CASE_URL; cta.target = '_blank'; cta.rel = 'noopener'
  cta.textContent = 'View case study'; cta.tabIndex = -1
  const closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'gift__close'; closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 256 256" aria-hidden="true"><path d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66a8 8 0 0 1 11.32-11.32L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128Z" fill="currentColor" stroke="currentColor" stroke-width="10"/></svg>'
  closeBtn.style.opacity = '0'
  root.append(canvas, sr, hit, cta, closeBtn)

  // ---------- GL ----------
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, stencil: false, powerPreference: 'high-performance' })
  } catch {
    root.classList.add('gift--flat'); cta.tabIndex = 0; cta.classList.add('is-on'); blurFadeIn(closeBtn); closeBtn.focus({ preventScroll: true })
    closeBtn.onclick = () => opts.close()
    return { close: async () => { canvas.remove(); sr.remove(); hit.remove(); cta.remove(); closeBtn.remove() } }
  }
  renderer.setClearColor(0x000000, 0)
  giftMark('context')
  yield
  const css = new CSS3DRenderer(); css.domElement.className = 'gift__type'; css.domElement.setAttribute('aria-hidden', 'true') // R6.88b CRISP TYPE
  css.setSize(viewport.w, viewport.h); root.insertBefore(css.domElement, sr)
  renderer.toneMapping = TONE; renderer.toneMappingExposure = TONE === THREE.ACESFilmicToneMapping ? 1.12 : 1.0
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setPixelRatio(dpr); renderer.setSize(viewport.w, viewport.h, false)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30, viewport.w / viewport.h, 0.1, 40)
  const PITCH = 0.3
  let dist = 4
  // film: a slow push-in while the box arrives (and a breath of drift after), always aimed at the gift
  let close = 0   // 0 = framed for the box, 1 = dollied in on the card
  const aim = (push: number, drift = 0) => {
    const d = dist * (1 + 0.14 * (1 - push)) * (1 - 0.24 * close * Math.min(1, 1.35 / (camera.aspect + 0.35))), p = PITCH + 0.05 * (1 - push) - 0.08 * close
    camera.position.set(drift * 0.06, Math.sin(p) * d, Math.cos(p) * d)
    camera.lookAt(0, -0.02, 0)
  }
  const frame = () => {
    const a = viewport.w / viewport.h, tf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    dist = Math.max(1.02 / tf, 0.86 / (tf * a))
    camera.aspect = a; camera.updateProjectionMatrix()
    aim(1)
  }
  frame()

  const snap = root.querySelector('canvas.gift__bg') as HTMLCanvasElement | null
  // the page's mood, read once from the blurred frame: tints the fill so the box sits in the same light
  const mood = new THREE.Color(0.55, 0.58, 0.62)
  readMood(snap, mood)

  const stage = new THREE.Group(); scene.add(stage)
  const floater = new THREE.Group(); stage.add(floater)
  const boxYaw = new THREE.Group(); boxYaw.position.y = BOX_Y; floater.add(boxYaw)

  const geo = buildBox(), rib = buildRibbon()
  giftMark('b_geo')
  yield
  const stripeTex = pinstripe(); stripeTex.wrapS = stripeTex.wrapT = THREE.RepeatWrapping; stripeTex.repeat.set(9, 9)
  const shellMat = dissolvable(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#636a74'), metalness: 0.82, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.06,
    normalMap: stripeTex, normalScale: new THREE.Vector2(0.16, 0.16), envMapIntensity: 1.25,
  }), 'gift-shell', false)
  const floorMat = dissolvable(new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#141518'), roughness: 0.8, metalness: 0 }), 'gift-floor', false)
  const ribbonMat = dissolvable(new THREE.MeshPhysicalMaterial({
    color: PINK, roughness: 0.4, metalness: 0.0, sheen: 1, sheenColor: new THREE.Color('#ff5aa8'), sheenRoughness: 0.3,
    clearcoat: 0.25, clearcoatRoughness: 0.25, emissive: PINK, emissiveIntensity: 1, side: THREE.DoubleSide, envMapIntensity: 0.8,
  }), 'gift-ribbon', true, U.uDR, U.uHitR, U.uSpanR)
  // every part's geometry is in box space; a part moves by its group's transform (rest = identity), so the dissolve
  // pattern and the dust stay glued to its surface
  const lidG = new THREE.Group(), ribG = new THREE.Group()
  const base = new THREE.Mesh(geo.base, shellMat), floorM = new THREE.Mesh(geo.floor, floorMat)
  const lid = new THREE.Mesh(geo.lid, shellMat)
  const bands = new THREE.Mesh(rib.bands, ribbonMat)
  // the ribbon rides the lid's group (it is wrapped round the lid), but it is gone before the lid moves
  boxYaw.add(base, floorM, lidG); lidG.add(lid, ribG); ribG.add(bands)
  const haloTex = radial('rgba(255,255,255,1)', 'rgba(255,255,255,0)')
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: PINK, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false, opacity: 0.32 }))
  halo.position.set(0, TOP + 0.08, 0); halo.scale.setScalar(0.72); ribG.add(halo)
  const N = phone ? 3000 : 6000
  const dBase = dust([[geo.base, Math.round(N * 0.4)]], 0, U.uD, 'form', U.uHit, U.uSpan, U.uCardM)
  const dLid = dust([[geo.lid, Math.round(N * 0.28)]], 0, U.uD, 'form', U.uHit, U.uSpan, U.uCardM)
  const dRib = dust([[rib.bands, Math.round(N * 0.34)]], 1, U.uDR, 'rise', U.uHitR, U.uSpanR)
  boxYaw.add(dBase); lidG.add(dLid); ribG.add(dRib)
  const dustAll = [dBase, dLid, dRib]
  giftMark('b_dust')
  yield
  dustAll.forEach((d) => { d.visible = false })
  const boxParts = [base, floorM, lid, bands, halo]
  const shadowTex = radial('rgba(0,0,0,0.62)', 'rgba(0,0,0,0)')
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 2.1), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }))
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = BOX_Y - 0.075; stage.add(shadow)

  // card: tilt (x) → spin (y) → roll (z, only while it lies in the box) → meshes
  const cardTilt = new THREE.Group(), cardSpin = new THREE.Group(), cardRoll = new THREE.Group()
  floater.add(cardTilt); cardTilt.add(cardSpin); cardSpin.add(cardRoll)
  const tw = phone ? 768 : 1024
  const frontTex = cardFront(tw), backTex = cardBack(phone ? 512 : 768)
  const btnTex = buttonTex(phone ? 512 : 640, false), btnTexH = buttonTex(phone ? 512 : 640, true)
  giftMark('b_tex')
  yield
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(rr(CW, CH, CR), { depth: 0.012, bevelEnabled: false, curveSegments: 10 }), cardMat(new THREE.MeshStandardMaterial({ color: '#9aa0aa', roughness: 0.28, metalness: 0.7 }), 'gift-card-edge', 'edge'))
  body.position.z = -0.006
  const fg = faceGeo(CW, CH, CR)
  const front = new THREE.Mesh(fg, cardMat(new THREE.MeshPhysicalMaterial({ map: frontTex, color: new THREE.Color('#eef2fb'), emissiveMap: frontTex, emissive: new THREE.Color('#f4f7ff'), emissiveIntensity: 0.55, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.22, envMapIntensity: 0.45 }), 'gift-card-front', 'face'))
  front.position.z = 0.0065
  const back = new THREE.Mesh(fg, cardMat(new THREE.MeshPhysicalMaterial({ map: backTex, roughness: 0.3, metalness: 0.25, clearcoat: 0.6, clearcoatRoughness: 0.12 }), 'gift-card-back', 'face'))
  back.position.z = -0.0065; back.rotation.y = Math.PI
  const bg2 = faceGeo(BTN_W, BTN_H, BTN_H / 2)
  const btnMat = new THREE.MeshBasicMaterial({ map: btnTex, transparent: true, toneMapped: false })
  const btnMatH = new THREE.MeshBasicMaterial({ map: btnTexH, transparent: true, toneMapped: false, opacity: 0, depthWrite: false })
  const btn = new THREE.Mesh(bg2, btnMat), btnH = new THREE.Mesh(bg2, btnMatH)
  const bx = -CW / 2 + PAD + BTN_W / 2, by = -CH / 2 + PAD + BTN_H / 2
  btn.position.set(bx, by, 0.0072); btnH.position.set(bx, by, 0.0076)
  cardRoll.add(body, front, back, btn, btnH)
  // R6.88b CRISP TYPE: the card's words + button as real vector type on the card face (CSS3D: the same camera, the same
  // card matrix, rasterised by the browser at the device's full density, so it stays crisp even when the GL canvas runs at
  // DPR 0.6–1 on a budget phone). Its back face is hidden (backface-visibility), it fades in as the card forms.
  btn.visible = false; btnH.visible = false
  const TYPE_K = 400
  const typeEl = document.createElement('div'); typeEl.className = 'gift__face'
  typeEl.style.cssText = `width:${CW * TYPE_K}px;height:${CH * TYPE_K}px;backface-visibility:hidden;-webkit-backface-visibility:hidden;pointer-events:none;opacity:0`
  typeEl.innerHTML = cardType(TYPE_K)
  const typeBtns = typeEl.querySelector('.gift__btns') as SVGGElement, typeHover = typeEl.querySelector('.gift__btn--h') as SVGGElement
  const typeObj = new CSS3DObject(typeEl); typeObj.scale.setScalar(1 / TYPE_K); typeObj.position.z = 0.0074
  cardRoll.add(typeObj)
  let typeO = -1, typeB = -1, typeH = -1
  const tN = new THREE.Vector3(), tP = new THREE.Vector3(), tV = new THREE.Vector3()
  const draw = () => {
    renderer.render(scene, camera)
    // the type follows the card's own reveal (it forms centre-out; the words sit in its outer part) and the button's fade;
    // it shows on the FRONT face only, easing out as the card turns edge-on (the browser's backface rule is not relied on)
    cardRoll.updateWorldMatrix(true, false)
    const facing = tN.set(0, 0, 1).transformDirection(cardRoll.matrixWorld).dot(tV.copy(camera.position).sub(tP.setFromMatrixPosition(cardRoll.matrixWorld)).normalize())
    typeObj.visible = facing > 0.06
    const o = Math.round(clamp01((U.uForm.value - 0.62) / 0.34) * clamp01((facing - 0.06) / 0.14) * 100) / 100, b = Math.round(btnMat.opacity * 100) / 100, h = Math.round(btnMatH.opacity / Math.max(1e-3, btnMat.opacity) * 100) / 100
    if (o !== typeO) { typeO = o; typeEl.style.opacity = String(o) }
    if (b !== typeB) { typeB = b; typeBtns.setAttribute('opacity', String(b)) }
    if (h !== typeH) { typeH = h; typeHover.setAttribute('opacity', String(Math.min(1, h))) }
    css.render(scene, camera)
  }

  // lights: the env does most of it; a key, a cool rim and a fill tinted by the page
  // film lighting: a warm key from high left, a cool rim from behind right, a low fill in the page's own colour
  const hemi = new THREE.HemisphereLight(COOL.clone().lerp(new THREE.Color(1, 1, 1), 0.5), mood, 0.3); scene.add(hemi)
  const key = new THREE.DirectionalLight(WARM, 2.0); key.position.set(-2.6, 3.6, 2.6); scene.add(key)
  const rim = new THREE.DirectionalLight(COOL, 2.2); rim.position.set(2.8, 1.8, -3.4); scene.add(rim)
  // haze: a warm shaft falling from the key's side behind the gift, motes drifting through it, then the film layer
  const sTex = shaftTex()
  const shaft = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 4.4), new THREE.MeshBasicMaterial({ map: sTex, color: WARM, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, toneMapped: false }))
  shaft.position.set(-0.55, 0.9, -1.1); shaft.rotation.z = 0.42; scene.add(shaft)
  const mote = motes(phone ? 90 : 160); scene.add(mote)
  const film = filmPass(); scene.add(film)

  giftMark('b_scene')
  yield
  let envRT: THREE.WebGLRenderTarget | null = null
  const envB = envBuilder(renderer)   // R7.09: kept for show() (parked)
  try { envRT = envB.build(snap); scene.environment = envRT.texture } catch { /* lights alone */ }
  giftMark('b_env')
  yield

  // ---------- state ----------
  let t0 = performance.now(), last = t0, raf = 0, alive = true, ready = false
  let enterK = reduced ? 1 : 0
  let opened = reduced, openAt = reduced ? -100 : -1
  let hover = 0, hoverWant = 0, press = 0
  const ptr = new THREE.Vector2(0, 0), ptrS = new THREE.Vector2(0, 0)
  let spin = 0, spinV = 0, settleUntil = 0, ctaHover = false, ctaFocus = false, hOp = 0
  let yaw = -0.62
  let frames = 0, ema = 16.7
  let sfx: { stop(): void } | null = null
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), inv = new THREE.Matrix4(), lray = new THREE.Ray()
  const boxBounds = new THREE.Box3(new THREE.Vector3(-L / 2, 0, -L / 2), new THREE.Vector3(L / 2, TOP + 0.2, L / 2))
  const cardBounds = new THREE.Box3(new THREE.Vector3(-CW / 2, -CH / 2, -0.02), new THREE.Vector3(CW / 2, CH / 2, 0.02))
  const v3 = new THREE.Vector3(), fA = new THREE.Vector3(), fB = new THREE.Vector3()

  if (reduced) { boxParts.forEach((o) => { o.visible = false }); shadow.visible = false }

  const hitTest = (cx: number, cy: number): 'box' | 'card' | null => {
    ndc.set((cx / viewport.w) * 2 - 1, -(cy / viewport.h) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    const test = (o: THREE.Object3D, b: THREE.Box3) => { inv.copy(o.matrixWorld).invert(); lray.copy(ray.ray).applyMatrix4(inv); return lray.intersectsBox(b) }
    if (!opened) return test(boxYaw, boxBounds) ? 'box' : null
    return test(cardRoll, cardBounds) ? 'card' : null
  }

  const open = (cx?: number, cy?: number) => {
    if (opened || !ready) return
    opened = true; openAt = QA ? qaT : (performance.now() - t0) / 1000
    // the dissolve spreads from where the box was touched (its top centre from the keyboard)
    if (cx !== undefined && cy !== undefined) {
      ndc.set((cx / viewport.w) * 2 - 1, -(cy / viewport.h) * 2 + 1); ray.setFromCamera(ndc, camera)
      inv.copy(boxYaw.matrixWorld).invert(); lray.copy(ray.ray).applyMatrix4(inv)
      if (lray.intersectBox(boxBounds, v3)) U.uHit.value.copy(v3)
    }
    dustAll.forEach((d) => { d.visible = true })
    if (!QA) sfx = giftSound(TL)
    hit.blur(); hit.tabIndex = -1; hit.style.display = 'none'
    canvas.removeAttribute('data-cursor'); canvas.style.cursor = ''
  }

  // ---------- input ----------
  const onMove = (e: PointerEvent) => {
    ptr.set((e.clientX / viewport.w) * 2 - 1, -(e.clientY / viewport.h) * 2 + 1)
    if (!ready) return
    const h = hitTest(e.clientX, e.clientY)
    hoverWant = !opened && h === 'box' ? 1 : 0
    if (opened && h === 'card' && e.pointerType === 'mouse') settleUntil = performance.now() + 600
    const pointer = (!opened && h === 'box')
    canvas.style.cursor = pointer ? 'pointer' : ''
    if (pointer) canvas.setAttribute('data-cursor', ''); else canvas.removeAttribute('data-cursor')
  }
  const onDown = (e: PointerEvent) => { if (ready && !opened && hitTest(e.clientX, e.clientY) === 'box') press = 1 }
  const onClick = (e: MouseEvent) => {
    if (!ready) return
    const h = hitTest(e.clientX, e.clientY)
    if (!opened && h === 'box') { open(e.clientX, e.clientY); return }
    if (opened && h === 'card') { settleUntil = performance.now() + 5000; return }   // a tap on the card turns it to face you
    opts.close()
  }
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', () => { press = 0 })
  canvas.addEventListener('pointerleave', () => { press = 0; hoverWant = 0 })
  canvas.addEventListener('click', onClick)
  let viaKey = false
  hit.addEventListener('click', (e) => { viaKey = e.detail === 0; open() })
  hit.addEventListener('focus', () => { hoverWant = 1 }); hit.addEventListener('blur', () => { if (!opened) hoverWant = 0 })
  cta.addEventListener('pointerenter', () => { ctaHover = true }); cta.addEventListener('pointerleave', () => { ctaHover = false })
  cta.addEventListener('focus', () => { ctaFocus = cta.matches(':focus-visible') }); cta.addEventListener('blur', () => { ctaFocus = false })
  closeBtn.addEventListener('click', () => opts.close())
  // focus stays inside the dialog
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const list = [hit, cta, closeBtn].filter((el) => el.tabIndex >= 0 && el.style.display !== 'none' && el.isConnected)
    if (!list.length) return
    const i = list.indexOf(document.activeElement as any)
    e.preventDefault()
    list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus()
  }
  root.addEventListener('keydown', onKey)
  const onResize = () => { renderer.setSize(viewport.w, viewport.h, false); css.setSize(viewport.w, viewport.h); frame() }
  const offVp = onViewport(onResize) // R7.07: real resizes only (not the address bar)

  // ---------- frame ----------
  const pj = [0, 0]   // R7.09: one reused pair (was a new array per call, 10+ a frame)
  const proj = (o: THREE.Object3D, x: number, y: number, z: number) => { v3.set(x, y, z).applyMatrix4(o.matrixWorld).project(camera); pj[0] = (v3.x * 0.5 + 0.5) * viewport.w; pj[1] = (-v3.y * 0.5 + 0.5) * viewport.h; return pj }
  let ctaOn = false, hitShown = false
  const place = (el: HTMLElement, l: number, t: number, w: number, h: number) => {
    el.style.transform = `translate3d(${l.toFixed(1)}px, ${t.toFixed(1)}px, 0)`
    const W = Math.round(w) + 'px', H = Math.round(h) + 'px'
    if (el.style.width !== W) el.style.width = W
    if (el.style.height !== H) el.style.height = H
  }

  const update = (time: number, dt: number) => {
    U.uTime.value = time
    const ot = openAt < 0 ? -1 : time - openAt   // seconds since the box was opened
    // entry: rises from below the bottom edge of the viewport, eased, no overshoot
    if (!reduced) enterK = clamp01((time - 0.05) / 1.6)
    const ek = eOut4(enterK)
    const below = -(dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) + 1.1)
    stage.position.y = lerp(below, 0, ek)
    aim(1, 0)   // Shifat 8:53 "B": camera fully locked (no push-in, no sway)
    U.uFocus.value = camera.position.length()
    const fk = reduced ? 1 : eSine(clamp01(time / 1.2))
    ;(film.material as THREE.ShaderMaterial).uniforms.uK.value = fk
    ;(film.material as THREE.ShaderMaterial).uniforms.uAspect.value = camera.aspect
    ;(mote.material as THREE.ShaderMaterial).uniforms.uA.value = fk * (reduced ? 0 : 1)
    ;(shaft.material as THREE.MeshBasicMaterial).opacity = fk * (0.16 + (reduced ? 0 : 0.035 * Math.sin(time * 0.6) + 0.02 * Math.sin(time * 1.7)))
    // alive: breathing float, a slow sway, a lean toward the pointer, a lift on hover, a soft press
    const live = reduced ? 0 : 1
    hover = damp(hover, hoverWant, 7, dt)
    ptrS.x = damp(ptrS.x, ptr.x, 3, dt); ptrS.y = damp(ptrS.y, ptr.y, 3, dt)
    const pk = press
    floater.position.y = live * (0.022 * Math.sin(time * 1.15) + 0.04 * hover)
    floater.rotation.x = live * (-ptrS.y * 0.07 + 0.012 * Math.sin(time * 0.7))
    floater.rotation.z = live * (-ptrS.x * 0.05)
    const breath = 1 + live * 0.0055 * Math.sin(time * 1.7)
    const sq = opened ? Math.sin(Math.PI * seg(ot, 0, 0.42)) : pk * 0.6
    boxYaw.scale.set(breath * (1 + 0.012 * sq), breath * (1 - 0.024 * sq), breath * (1 + 0.012 * sq))
    yaw = lerp(-0.95, -0.62, ek) + live * 0.06 * Math.sin(time * 0.38) + ptrS.x * 0.12 * live
    boxYaw.rotation.y = yaw
    // the light sweeps slowly over the lacquer and the satin
    scene.environmentRotation.y = live * (0.55 * Math.sin(time * 0.33) + 0.25)
    key.position.x = -2.5 + live * 1.2 * Math.sin(time * 0.33)
    // the ribbon glows; brighter on hover, a surge on the press
    const surge = opened ? Math.sin(Math.PI * seg(ot, 0, 0.5)) : 0
    U.uGlow.value = 0.22 + live * 0.05 * Math.sin(time * 2.1) + 0.22 * hover + 0.5 * surge
    ;(halo.material as THREE.SpriteMaterial).opacity = (0.2 + 0.12 * hover + 0.3 * surge) * (1 - clamp01(U.uDR.value * 1.4)) * (1 - seg(ot < 0 ? 0 : ot, 0.5, 1.2))
    // open, R6.83b (Shifat 07:49 + 07:57): the ribbon and bow burn into hot pink dust that floats UP out of the frame; only
    // once it has cleared does the lid lift straight off the walls and tip back; then box + lid dissolve from where they were
    // touched and that dust spirals in and BECOMES the card (center out, a glowing seam). No part ever passes through another:
    // the ribbon never moves (it is gone before the lid stirs), the lid clears the walls before it tips, the card only exists
    // once the box and lid are fully gone
    if (opened && !reduced) {
      U.uDR.value = Math.max(0, (ot - TL.R0) / TL.RK)
      const l1 = eInOut(seg(ot, TL.L1a, TL.L1b)), l2 = eInOut(seg(ot, TL.L2a, TL.L2b))
      // hinge at the lid's back top edge: lift (clear of the walls), then tip back
      const ang = -1.0 * l2
      lidG.rotation.x = ang
      const pz = -L / 2, py = TOP
      // keep the hinge point fixed: p' = R(p - h) + h, plus the lift
      lidG.position.set(0, py - (py * Math.cos(ang) - pz * Math.sin(ang)) + 0.32 * l1 + 0.06 * l2, pz - (py * Math.sin(ang) + pz * Math.cos(ang)) - 0.08 * l2)
      U.uD.value = Math.max(0, (ot - TL.D0) / TL.DK)
      if (U.uDR.value > 1.02) { bands.visible = false; halo.visible = false }
      if (U.uDR.value > 1.9) dRib.visible = false
      if (U.uD.value > 1.05) { base.visible = false; floorM.visible = false; lid.visible = false }
      if (U.uD.value > 2.6) { dBase.visible = false; dLid.visible = false }
    }
    const ck = reduced ? 1 : opened ? eInOut(seg(ot, TL.D0, TL.F1)) : 0
    const form = reduced ? 1 : opened ? eSine(seg(ot, TL.F0, TL.F1)) : 0
    U.uForm.value = form
    close = 0   // Shifat 1:41 PM: camera fully locked, no card dolly-in either
    const sh = shadow.material as THREE.MeshBasicMaterial
    sh.opacity = (1 - 0.6 * hover - (reduced ? 1 : 0)) * lerp(1, 0.32, ck) * ek
    shadow.scale.setScalar(lerp(1, 0.62, ck) * (1 - 0.08 * hover))
    // card: waits at its final pose, invisible, and is built by the dust; then it slowly spins
    cardTilt.position.set(0, 0.04 + (reduced ? 0 : 0.016 * Math.sin(time * 1.2) * ck), 0.16)
    cardTilt.rotation.x = -PITCH * 0.75 + (reduced ? 0 : -ptrS.y * 0.06 * ck)
    cardRoll.rotation.z = 0
    cardTilt.visible = reduced || (opened && ot > TL.F0 - 0.05)
    const bv = clamp01((form - 0.7) / 0.3); btnMat.opacity = bv * bv * (3 - 2 * bv)
    // spin: starts once the card has arrived facing you; settles to face you on hover / focus / tap
    if (!reduced && opened && ot > TL.S0) {
      const settle = ctaHover || ctaFocus || performance.now() < settleUntil
      if (settle) {
        const target = Math.round(spin / (Math.PI * 2)) * Math.PI * 2
        const k = 14, c = 2 * Math.sqrt(k)
        spinV += ((target - spin) * k - spinV * c) * dt
      } else spinV = damp(spinV, 0.55 * clamp01((ot - TL.S0) / 1.6), 1.6, dt)
      spin += spinV * dt
    }
    cardSpin.rotation.y = spin + (reduced ? 0 : ptrS.x * 0.1 * ck)
    // the hover state of the drawn button (a crossfade, no swap)
    hOp = damp(hOp, ctaHover || ctaFocus ? 1 : 0, 10, dt); btnMatH.opacity = hOp * btnMat.opacity
    U.uFoil.value = spin + time * 0.12
    // DOM proxies over the GL: the box's hit button (keyboard) and the card's link (front-facing only)
    scene.updateMatrixWorld()
    U.uCardM.value.copy(cardRoll.matrixWorld); U.uCardInv.value.copy(cardRoll.matrixWorld).invert()
    if (!opened && ready) {
      let l = 1e9, tp = 1e9, r = -1e9, b = -1e9
      for (const x of [-L / 2, L / 2]) for (const y of [0, TOP + 0.18]) for (const z of [-L / 2, L / 2]) { const [sx, sy] = proj(boxYaw, x, y, z); l = Math.min(l, sx); r = Math.max(r, sx); tp = Math.min(tp, sy); b = Math.max(b, sy) }
      place(hit, l, tp, r - l, b - tp)
      if (!hitShown) { hitShown = true; hit.style.visibility = 'visible' }
    }
    if (opened) {
      const facing = fA.set(0, 0, 1).transformDirection(cardRoll.matrixWorld).dot(v3.copy(camera.position).sub(cardRoll.getWorldPosition(fB)).normalize())   // R7.09: reused vectors
      const want = (reduced || ot > TL.F1 - 0.15) && facing > 0.55
      if (want) {
        const [x0, y0] = proj(cardRoll, bx - BTN_W / 2, by + BTN_H / 2, 0.008), [x1, y1] = proj(cardRoll, bx + BTN_W / 2, by - BTN_H / 2, 0.008)
        place(cta, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
      }
      if (want !== ctaOn) {
        ctaOn = want; cta.classList.toggle('is-on', want)
        if (want && cta.tabIndex < 0) { cta.tabIndex = 0; if (viaKey) cta.focus({ preventScroll: true }); else root.focus({ preventScroll: true }) }
      }
    }
  }

  const QA = /[?&]giftqa/.test(location.search)
  let qaT = 0
  const step = (n: number) => { for (let i = 0; i < n; i++) { qaT += 1 / 30; update(qaT, 1 / 30) } draw(); return qaT }
  const tick = (now: number) => {
    raf = 0
    if (!alive || QA) return
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now
    if (!document.hidden) {
      update((now - t0) / 1000, dt)
      draw()
      // phones: step the density down on slow frames (never below 0.6), never up
      if (++frames > 40) {
        ema = ema * 0.93 + dt * 1000 * 0.07
        if (!phoneFixed && ema > 21 && dpr > dprMin + 0.01) { dpr = Math.max(dprMin, dpr - 0.1); renderer.setPixelRatio(dpr); renderer.setSize(viewport.w, viewport.h, false); frames = 20; ema = 16.7 }
      }
    }
    if (!reduced || !ready) raf = requestAnimationFrame(tick)
  }

  // ---------- prepare off-screen, then reveal (programs linked in parallel, textures uploaded, nothing compiles on show) ----------
  const prep = async () => {
    giftMark('built')
    try { await document.fonts.load(`400 64px ${FONT}`) } catch { /* system face */ }
    giftMark('font')
    frontTex.needsUpdate = true
    for (const t of [frontTex, backTex, btnTex, btnTexH, stripeTex, haloTex, shadowTex, sTex]) renderer.initTexture(t)
    dustAll.forEach((d) => { d.visible = true }); cardTilt.visible = true
    if (opts.parked) {
      // R7.09: no parallel shader compile on his phone, so each link stalls the GPU process: one object's programs a frame,
      // then a few idle frames for the last links to finish before the first (off-screen) draw asks for them
      const objs: THREE.Object3D[] = []
      scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) objs.push(o) })
      for (const o of objs) { if (!alive) return; try { renderer.compile(o, camera, scene) } catch { /* linked at the first draw */ } await new Promise((r) => requestAnimationFrame(r)) }
      for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r))
    } else try { await renderer.compileAsync(scene, camera) } catch { /* sync compile on first render */ }
    giftMark('compiled')
    if (!alive) return
    update(0, 0); cardTilt.visible = true; draw()
    giftMark('firstDraw')
    dustAll.forEach((d) => { d.visible = false }); cardTilt.visible = reduced
    await new Promise((r) => requestAnimationFrame(r))
    if (!alive) return
    if (opts.parked) {   // R7.09: held here until the tap (show), then the first visible frame is the box below the edge
      giftMark('parked')
      await shown
      if (!alive) return
      giftMark('released')
      update(0, 0); draw()
      giftMark('shownDraw')
    }
    t0 = performance.now(); last = t0; ready = true
    giftMark('ready')
    root.classList.add('gift--ready')
    blurFadeIn(closeBtn, reduced ? 0 : 500)
    if (reduced) { cta.tabIndex = 0; update(10, 0); draw(); update(10, 0); cta.focus({ preventScroll: true }) }
    else { hit.style.visibility = 'visible'; hitShown = true; hit.focus({ preventScroll: true }); raf = requestAnimationFrame(tick) }
  }
  // R7.09 PARKED: show() takes the page's frozen frame (the dialog's blurred still, drawn after the tap) for the fill's mood
  // and the reflections, exactly as a stage built on the tap reads it, then releases prep()
  let release: () => void = () => {}
  const shown = new Promise<void>((r) => { release = r })
  // The box is released at once (it rises from below the bottom edge, so its first frames are off screen); the page's
  // mood and reflections are read from the still two frames later, before the box is in view (the read-back of the still
  // is a GPU sync: ~5.7-6.0 s on the simulator whether read here or at the grab, so it must not sit between the tap and
  // the first frame; the rise clock is shifted by whatever it cost)
  const applyPage = () => {
    if (!alive) return
    const a0 = performance.now()
    const s = root.querySelector('canvas.gift__bg') as HTMLCanvasElement | null
    readMood(s, mood); hemi.groundColor.copy(mood)
    giftMark('mood')
    try { const e = envB.build(s); envRT?.dispose(); envRT = e; scene.environment = e.texture } catch { /* keeps the warm env */ }
    giftMark('envShown')
    // the rise is timed from t0: whatever that read cost is taken off the clock, so the box never jumps ahead
    const spent = performance.now() - a0; t0 += spent; last += spent
  }
  const show = () => {
    giftMark('show')
    release()
    requestAnimationFrame(() => requestAnimationFrame(applyPage))
  }
  prep()
  // reduced motion: one still frame, redrawn on resize only
  const onResizeStill = () => { if (reduced && ready) { update(10, 0); draw() } }
  addEventListener('resize', onResizeStill)

  // test hooks for the QA rig
  ;(window as any).__giftStage = { open: (x?: number, y?: number) => open(x, y), step, state: () => ({ ready, opened, spin, dpr, ctaOn }), wav: QA ? () => import('./giftSound').then((m) => m.giftSoundWav(TL)) : undefined }

  return {
    show,
    async close() {
      release()
      // the GL stops drawing at once (the page's scene takes the GPU back); the frozen frame sinks and fades in CSS
      alive = false; if (raf) cancelAnimationFrame(raf)
      sfx?.stop(); sfx = null
      root.classList.add('gift--leaving')
      cta.classList.remove('is-on'); hit.style.display = 'none'
      await Promise.all([blurFadeOut(closeBtn), new Promise((r) => setTimeout(r, reduced ? 160 : 700))])
      offVp(); removeEventListener('resize', onResizeStill)
      root.removeEventListener('keydown', onKey)
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
        const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []
        mats.forEach((mt) => mt.dispose())
      })
      for (const t of [frontTex, backTex, btnTex, btnTexH, stripeTex, haloTex, shadowTex, sTex]) t.dispose()
      envRT?.dispose(); envB.dispose()
      renderer.dispose(); renderer.forceContextLoss()
      delete (window as any).__giftStage
      canvas.remove(); css.domElement.remove(); sr.remove(); hit.remove(); cta.remove(); closeBtn.remove()
    },
  }
}
