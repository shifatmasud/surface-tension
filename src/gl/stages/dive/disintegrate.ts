import * as THREE from 'three'
import { settings } from '../../../services/settings'
import { LOW_END_GPU } from '../../quality'

/**
 * R6.88 SINK (Shifat 10:04–10:05 PM Oct 22: "The tablet alone should way down deep the ocean after shade ds scene. The
 * diamond must particle morphed disintegrated when goes center center behind the tablet." / "Ui fall as particle morphed
 * disintegration"). ONE particle-morph style for the Shade DS parts and the diamond:
 *  - the solid surface is eaten by a slow noise front (DIS_GLSL disRaw/disF*), a thin lime ember line running ahead of it;
 *  - exactly where the surface goes, glowing points are born at that very surface sample and drift out, fall and fade.
 * The mesh and its points evaluate the SAME function of the SAME position, so nothing pops between the two.
 * GPU only: one Points draw per effect, every position is computed in the vertex shader from a static sample buffer
 * (surface samples, area-weighted, built once behind the preloader) and a scroll uniform. No per-frame CPU work beyond a
 * few uniforms, no allocation while scrolling. Scroll-driven and reversible (a pure function of the uniforms).
 */
export const DIS_COUNTS = (() => {
  const low = settings.TIER === 'low' || LOW_END_GPU
  return low ? { ui: 3600, gem: 1800 } : settings.TIER === 'mid' ? { ui: 6000, gem: 2600 } : { ui: 9000, gem: 3600 }
})()
;(window as any).__disCounts = DIS_COUNTS

/** the shared GLSL: the front's shape. k = scroll progress 0..1, f = 0..1 the sample's place in the order */
export const DIS_GLSL = /* glsl */ `
float disH(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
float disN(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(disH(i), disH(i + vec3(1,0,0)), f.x), mix(disH(i + vec3(0,1,0)), disH(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(disH(i + vec3(0,0,1)), disH(i + vec3(1,0,1)), f.x), mix(disH(i + vec3(0,1,1)), disH(i + vec3(1,1,1)), f.x), f.y), f.z); }
/** < 0: still solid (-0.07..0 = the ember line), >= 0: gone, its points are out (0..1 their life) */
float disRaw(float k, float f){ return (k * 1.06 - 0.06 - 0.6 * f) / 0.4; }
/** the Shade DS drum: a noise front sweeping top → bottom (drum space: y up, rows at +1.3 / 0 / -1.3) */
float disFUi(vec3 q){ return clamp(0.62 * disN(q * 1.7 + 3.1) + 0.38 * clamp(0.5 - q.y / 3.4, 0.0, 1.0), 0.0, 1.0); }
/** the diamond (object space, radius 1): noise, crown first */
// R6.88b (root: "mid-dissolve the diamond almost vanishes too quickly"): the raw order bunches around 0.5 (value noise), so
// most of the stone went in a narrow stretch of scroll; it is stretched to spread evenly over the whole range
float disFGem(vec3 o){ float r = 0.66 * disN(o * 2.3 + 7.7) + 0.34 * clamp(0.6 - o.y * 0.7, 0.0, 1.0); return clamp((r - 0.2) / 0.62, 0.0, 1.0); }
/** the ember line's colour just before a fragment goes */
vec3 disEmber(float raw){ float e = smoothstep(-0.07, 0.0, raw); return vec3(0.64, 1.0, 0.07) * e * e * 1.5; }
`

const VERT = /* glsl */ `
${DIS_GLSL}
uniform mat4 u_M[13];
uniform mat4 u_toF;
uniform float u_k, u_px, u_time, u_grav, u_spread, u_size;
attribute vec3 aN; attribute vec4 aR; attribute float aI; attribute vec3 aC;
varying vec3 vC; varying float vA;
void main(){
  int i = int(aI + 0.5);
  mat4 M = u_M[0];
  for (int j = 1; j < 13; j++) if (j == i) M = u_M[j];
  vec3 p0 = (M * vec4(position, 1.0)).xyz;                 // the sample on the surface now (this object's space)
  vec3 n = normalize(mat3(M) * aN + vec3(1e-4));
#ifdef GEM
  float f = disFGem(position);
#else
  float f = disFUi((u_toF * vec4(p0, 1.0)).xyz);
#endif
  float raw = disRaw(u_k, f);
  float e = clamp(raw, 0.0, 1.0);
  // drift: out off the surface, a random turn, a slow underwater swirl, then the fall (world down)
  vec3 rd = normalize(aR.xyz * 2.0 - 1.0 + vec3(1e-3));
  float out1 = (1.0 - exp(-3.2 * e)) * u_spread * (0.35 + 0.9 * aR.w);
  vec3 p = p0 + (n * 0.55 + rd * 0.75) * out1;
  p += vec3(sin(u_time * 0.7 + aR.x * 40.0), cos(u_time * 0.6 + aR.y * 40.0), sin(u_time * 0.5 + aR.z * 40.0)) * 0.12 * e;
  p.y -= u_grav * e * e * (0.55 + 0.9 * aR.y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float born = smoothstep(0.0, 0.05, raw);
  vA = born * (1.0 - smoothstep(0.45, 1.0, e)) * step(raw, 1.0);
  // the colour cools from the ember lime to the part's own light as it drifts
  vC = mix(vec3(0.64, 1.0, 0.07) * 1.8, aC, smoothstep(0.0, 0.3, e)) * (1.0 + 0.6 * smoothstep(0.93, 1.0, aR.w) * sin(u_time * 9.0 + aR.x * 60.0));
  gl_PointSize = vA > 0.002 ? max(1.0, u_px * u_size * (0.55 + 0.9 * aR.z) * (1.0 - 0.35 * e) / max(0.3, -mv.z)) : 0.0;
  gl_Position = vA > 0.002 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
}`
const FRAG = /* glsl */ `
uniform float u_amb;
varying vec3 vC; varying float vA;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0; float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float a = vA * (exp(-r2 * 3.2) * 0.85 + 0.15 * (1.0 - r2));
  // only the bright core is kept (and writes depth): a point in front of the sharp stone then hides the stone where it
  // shows (the hero pass depth-tests against this pass's depth), so the cloud reads as AROUND the stone, never under it
  if (a < 0.2) discard;
  gl_FragColor = vec4(vC * a, 0.0);
}`

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

export type DisSource = { geo: THREE.BufferGeometry; matrix: THREE.Matrix4; part: number; color: THREE.Color; weight?: number }

/**
 * Area-weighted surface samples of the given meshes (each in its part's frame via `matrix`), N points in all.
 * Built once (behind the preloader); returns a Points whose every frame is a uniform update.
 */
export class Disintegrate {
  points: THREE.Points
  mat: THREE.ShaderMaterial
  M: THREE.Matrix4[]
  constructor(sources: DisSource[], N: number, opts: { gem?: boolean; seed?: number; size: number; grav: number; spread: number }) {
    const R = rng(opts.seed ?? 7)
    // triangle table: cumulative area
    const tris: { s: DisSource; a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; n: THREE.Vector3; area: number }[] = []
    let total = 0
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3()
    for (const s of sources) {
      const pos = s.geo.getAttribute('position') as THREE.BufferAttribute, idx = s.geo.index
      const nt = idx ? idx.count / 3 : pos.count / 3
      for (let t = 0; t < nt; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
        A.fromBufferAttribute(pos, i0).applyMatrix4(s.matrix); B.fromBufferAttribute(pos, i1).applyMatrix4(s.matrix); C.fromBufferAttribute(pos, i2).applyMatrix4(s.matrix)
        const n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A))
        const area = n.length() * 0.5 * (s.weight ?? 1)
        if (area < 1e-7) continue
        n.normalize(); total += area
        tris.push({ s, a: A.clone(), b: B.clone(), c: C.clone(), n, area: total })
      }
    }
    const P = new Float32Array(N * 3), Nn = new Float32Array(N * 3), Rr = new Float32Array(N * 4), I = new Float32Array(N), Cc = new Float32Array(N * 3)
    const lime = new THREE.Color(0.64, 1.0, 0.07)
    for (let i = 0; i < N; i++) {
      const x = R() * total
      let lo = 0, hi = tris.length - 1
      while (lo < hi) { const m = (lo + hi) >> 1; if (tris[m].area < x) lo = m + 1; else hi = m }
      const T = tris[lo]
      let u = R(), v = R(); if (u + v > 1) { u = 1 - u; v = 1 - v }
      A.copy(T.a).multiplyScalar(1 - u - v).addScaledVector(T.b, u).addScaledVector(T.c, v)
      P.set([A.x, A.y, A.z], i * 3); Nn.set([T.n.x, T.n.y, T.n.z], i * 3)
      Rr.set([R(), R(), R(), R()], i * 4); I[i] = T.s.part
      // the part's own light, a few lime embers among them (the Shade DS accent)
      const c = R() < 0.18 ? lime : T.s.color
      Cc.set([c.r, c.g, c.b], i * 3)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('aN', new THREE.BufferAttribute(Nn, 3))
    g.setAttribute('aR', new THREE.BufferAttribute(Rr, 4)); g.setAttribute('aI', new THREE.BufferAttribute(I, 1)); g.setAttribute('aC', new THREE.BufferAttribute(Cc, 3))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    this.M = Array.from({ length: 13 }, () => new THREE.Matrix4())
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, defines: opts.gem ? { GEM: '' } : {},
      uniforms: { u_M: { value: this.M }, u_toF: { value: new THREE.Matrix4() }, u_k: { value: 0 }, u_px: { value: 800 }, u_time: { value: 0 }, u_grav: { value: opts.grav }, u_spread: { value: opts.spread }, u_size: { value: opts.size }, u_amb: { value: 0 } },
      transparent: true, depthWrite: true, depthTest: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    })
    this.points = new THREE.Points(g, this.mat)
    this.points.frustumCulled = false
    this.points.visible = false
    this.points.renderOrder = 14
  }
  /** k: 0..1 progress; px: device px per metre at 1 m of the pass it draws in */
  set(k: number, px: number, time: number) {
    const u = this.mat.uniforms
    u.u_k.value = k; u.u_px.value = px; u.u_time.value = time
    this.points.visible = k > 0.0005 && k < 0.9995
  }
  dispose() { this.points.geometry.dispose(); this.mat.dispose() }
}
