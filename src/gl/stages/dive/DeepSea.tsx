import * as THREE from 'three'
import { runToEnd } from '../../prewarm' // PERFGOV
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { props } from '../../../state/props'
import { DIVE_LAYER, SYS_C, dive } from './diveState'
import { DIVE_COMMON, CLIP } from './shaders'

/**
 * v3 deep sea (Shifat 11:56Z: "We need water bubbles & interesting deep underwater scene. Exp fog needed too").
 * Everything here lives in the dive's water and fades into the same deep-water colour with the same FogExp2
 * (shaders.ts deepWater / deepFog), so the deep reads as one volume:
 *  - BUBBLES: instanced, refractive-looking (Fresnel rim, a sharp highlight from the light above, the deep seen
 *    through them), rising in columns from vents in the dark below and a loose drift around the camera, wobbling
 *    and growing as they rise. Some pass close to the lens.
 *  - DISTANT FORMS: basalt spires rising out of the black around the systems, lit faintly from above, mostly
 *    silhouettes in the fog.
 *  - PLANKTON: a few slow bioluminescent specks that pulse in the deep.
 * Same counts on every tier (the perf rule); one draw call each.
 */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

const bubbleVert = /* glsl */ `
${DIVE_COMMON}
attribute vec4 aSeed;   // x: 0 column / 1 free drift, y: phase, z: size, w: rise speed
attribute vec3 aBase;   // column vent (world) or free-drift offset (0..1)
uniform float u_box, u_colH, u_warp;
varying vec3 vN;
varying vec3 vW;
varying float vFade;
varying float vWarp;
void main(){
  float t = u_time;
  vec3 c;
  float grow = 1.0;
  if (aSeed.x < 0.5){
    float y = mod(aSeed.y * u_colH + t * aSeed.w, u_colH);
    float k = y / u_colH;
    c = aBase + vec3(0.0, y, 0.0);
    c.x += 0.18 * sin(t * 1.7 + aSeed.y * 40.0) * (0.4 + k);
    c.z += 0.18 * cos(t * 1.3 + aSeed.y * 31.0) * (0.4 + k);
    grow = 0.55 + 0.75 * k;
    vFade = smoothstep(0.0, 0.06, k) * (1.0 - smoothstep(0.85, 1.0, k));
  } else {
    vec3 base = aBase * u_box;
    base.y += t * aSeed.w;
    base.x += 0.25 * sin(t * 1.1 + aSeed.y * 23.0);
    base.z += 0.25 * cos(t * 0.9 + aSeed.y * 17.0);
    vec3 rel = mod(base - u_cam + u_box * 0.5, vec3(u_box)) - u_box * 0.5;
    // POLISH-2 (Shifat 19:30Z "Camera mustn't go through"): a lateral keep-out around the lens axis, so no bubble ever
    // swells across the near plane as a blurred blob; sqrt(lr² + r²) slides it aside smoothly (no pop)
    vec3 kF = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    float kz = dot(rel, kF); vec3 kl = rel - kz * kF; float klr = length(kl);
    float kr = 0.9 * smoothstep(-0.8, -0.1, kz) * (1.0 - smoothstep(3.0, 5.0, kz));
    if (kr > 0.0 && klr > 1e-4) rel = kz * kF + kl / klr * sqrt(klr * klr + kr * kr);
    c = u_cam + rel;
    vFade = 1.0 - smoothstep(u_box * 0.3, u_box * 0.5, length(rel));
  }
  vFade *= u_amb * step(c.y, -0.6);
  float r = aSeed.z * grow;
  // a rising bubble is a wobbling, slightly flattened sphere
  float wob = sin(t * 9.0 + aSeed.y * 50.0) * 0.08;
  vec3 p = position * r * vec3(1.0 + wob, 0.82 - wob, 1.0 + wob);
  vN = normalize(normal * vec3(1.0 - wob, 1.18 + wob, 1.0 - wob));
  // W18 (13:24Z "the bubbles stretch into stars"): as the camera pushes into the tablet the drifting bubbles near the
  // lens stretch along the view axis into thin streaks of light (warp lines radiating from the screen)
  vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float wk = u_warp * aSeed.x;
  p = p * (1.0 - 0.55 * wk) + fwd * dot(position, fwd) * r * wk * 26.0;
  vWarp = wk;
  vW = c + p;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`
const bubbleFrag = /* glsl */ `
${DIVE_COMMON}
${CLIP}
varying vec3 vN;
varying vec3 vW;
varying float vFade;
varying float vWarp;
void main(){
  splitClip();
  if (vFade < 0.002) discard;
  vec3 v = normalize(u_cam - vW);
  vec3 n = normalize(vN);
  float nv = abs(dot(n, v));
  float fr = pow(1.0 - nv, 2.6);
  vec3 r = reflect(-v, n);
  // total internal reflection makes the rim of an air bubble in water a bright mirror of the light above
  float spec = pow(max(dot(r, vec3(0.12, 0.98, 0.1)), 0.0), 70.0) * 2.4 + pow(max(dot(r, vec3(0.0, 1.0, 0.0)), 0.0), 8.0) * 0.25;
  vec3 above = mix(vec3(0.05, 0.22, 0.30), vec3(0.45, 0.80, 0.95), clamp(r.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 col = above * fr * 0.9 + vec3(0.85, 0.95, 1.0) * spec;
  col += deepWater(-v) * 0.6 * (1.0 - fr);   // the deep behind, bent through the bubble
  float dist = length(u_cam - vW);
  float fog = deepFog(dist);
  float a = (0.18 + 0.82 * fr + spec) * vFade * (1.0 - fog);
  // streaking: the bubble's light becomes a cool white star line
  col = mix(col, vec3(0.85, 0.92, 1.0) * 1.6, vWarp);
  a = mix(a, vFade * 0.9, vWarp);
  gl_FragColor = vec4(col * a, a * mix(0.55, 0.2, vWarp));
}`

const rockVert = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
void main(){
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`
const rockFrag = /* glsl */ `
${DIVE_COMMON}
${CLIP}
varying vec3 vW;
varying vec3 vN;
void main(){
  splitClip();
  vec3 n = normalize(vN);
  vec3 v = u_cam - vW;
  float dist = length(v);
  vec3 dir = -v / dist;
  float top = max(n.y, 0.0);
  float grain = 0.75 + 0.25 * vnoise(vW.xz * 2.3 + vW.y * 1.7);
  vec3 alb = vec3(0.10, 0.12, 0.13) * grain;
  // the last light from above and a cold rim from the open water behind
  vec3 light = vec3(0.10, 0.30, 0.42) * (0.18 + 0.82 * top * top) * (0.6 + 0.4 * shaft(vW.xz * 0.2 + vec2(u_time * 0.01, 0.0)));
  float rim = pow(1.0 - abs(dot(n, -dir)), 3.0);
  vec3 col = alb * light + vec3(0.02, 0.09, 0.13) * rim;
  col = mix(col, deepWater(dir), deepFog(dist));
  gl_FragColor = vec4(col, 1.0);
}`

const plankVert = /* glsl */ `
${DIVE_COMMON}
attribute vec3 aRand;
uniform vec3 u_c;
uniform float u_px;
varying float vA;
void main(){
  float t = u_time;
  vec3 p = u_c + (position - 0.5) * vec3(30.0, 18.0, 30.0);
  p += vec3(sin(t * 0.07 + aRand.x * 6.28), sin(t * 0.05 + aRand.y * 6.28) * 0.6, cos(t * 0.06 + aRand.z * 6.28)) * 0.8;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(u_px * (0.02 + 0.03 * aRand.x) / max(d, 0.1), 1.0, 6.0);
  float pulse = pow(0.5 + 0.5 * sin(t * (0.5 + aRand.y) + aRand.z * 30.0), 6.0);
  vA = u_abyss * (0.25 + 0.75 * pulse) * (1.0 - deepFog(d)) * smoothstep(0.5, 2.0, d);
}`
const plankFrag = /* glsl */ `
${DIVE_COMMON}
${CLIP}
varying float vA;
void main(){
  splitClip();
  float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(vec3(0.35, 0.95, 1.0) * a * vA * 0.9, 1.0);
}`

function hashN(x: number, y: number, z: number) { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s) }
function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf)
  const l = (a: number, b: number, t: number) => a + (b - a) * t
  const c = (i: number, j: number, k: number) => hashN(xi + i, yi + j, zi + k)
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v), l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w)
}

/** PERFGOV: the spires built behind the preloader (prebuildSpires), taken by the first mount; else built at mount as before */
let spiresPre: THREE.BufferGeometry | null = null
export function* prebuildSpires() { if (!spiresPre) spiresPre = yield* spires() }
const takeSpires = () => { const g = spiresPre; spiresPre = null; return g }
/** basalt spires around the systems, merged into one static geometry */
function* spires() {
  const R = rng(41)
  const parts: THREE.BufferGeometry[] = []
  const spots: [number, number, number, number][] = [
    // angle (rad, 0 = +z behind the cylinder), distance, height, base radius
    [0.15, 17, 22, 2.6], [-0.55, 21, 27, 3.2], [0.75, 24, 18, 2.4], [-1.25, 15, 14, 2.0], [1.35, 19, 25, 2.8],
    [2.0, 26, 20, 2.6], [-2.1, 23, 16, 2.2], [0.4, 33, 30, 3.8], [-0.2, 30, 12, 2.0], [-0.95, 34, 24, 3.4],
  ]
  for (const [a, d, h, r0] of spots) {
    const g = new THREE.CylinderGeometry(r0 * 0.18, r0, h, 10, 16, false)
    g.translate(0, h / 2, 0)
    const p = g.getAttribute('position') as THREE.BufferAttribute
    const seed = R() * 100
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      const k = 1 + 0.45 * (noise3(x * 0.6 + seed, y * 0.35, z * 0.6) - 0.5) + 0.2 * (noise3(x * 2.1, y * 1.4 + seed, z * 2.1) - 0.5)
      const lean = (y / h) * (y / h) * (R() * 0.002 + 0.9) * 1.6
      p.setXYZ(i, x * k + lean * Math.sin(seed), y, z * k + lean * Math.cos(seed))
    }
    g.computeVertexNormals()
    g.translate(SYS_C.x + Math.sin(a) * d, SYS_C.y - 18, SYS_C.z + Math.cos(a) * d)
    parts.push(g.index ? g.toNonIndexed() : g)
    yield // PERFGOV: one spire per step
  }
  // merge
  let n = 0; for (const g of parts) n += g.getAttribute('position').count
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3)
  let o = 0
  for (const g of parts) {
    pos.set(g.getAttribute('position').array as Float32Array, o * 3); nor.set(g.getAttribute('normal').array as Float32Array, o * 3)
    o += g.getAttribute('position').count; g.dispose()
  }
  const m = new THREE.BufferGeometry()
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  return m
}

export function DeepSea({ u }: { u: Record<string, THREE.IUniform> }) {
  const group = useRef<THREE.Group>(null!)
  const { geos, mats } = useMemo(() => {
    const R = rng(19)
    // bubbles: 6 vents round the systems + 2 under the descent past the work, 26 each; 90 drifting round the camera
    const vents: [number, number, number][] = [
      [SYS_C.x - 6.5, SYS_C.y - 12, SYS_C.z + 4], [SYS_C.x + 7.5, SYS_C.y - 12, SYS_C.z + 2], [SYS_C.x + 3.2, SYS_C.y - 12, SYS_C.z + 9],
      [SYS_C.x - 3.8, SYS_C.y - 12, SYS_C.z + 11], [SYS_C.x - 9, SYS_C.y - 12, SYS_C.z - 3], [SYS_C.x + 10, SYS_C.y - 12, SYS_C.z - 4],
      [-3.4, -34, 37], [4.2, -36, 40],
    ]
    const perVent = 26, nFree = 90, N = vents.length * perVent + nFree
    const seed = new Float32Array(N * 4), base = new Float32Array(N * 3)
    let k = 0
    for (const v of vents) for (let i = 0; i < perVent; i++, k++) {
      seed.set([0, R(), 0.035 + R() * R() * 0.11, 1.1 + R() * 0.9], k * 4)
      base.set([v[0] + (R() - 0.5) * 0.5, v[1], v[2] + (R() - 0.5) * 0.5], k * 3)
    }
    for (let i = 0; i < nFree; i++, k++) {
      seed.set([1, R(), 0.02 + R() * R() * 0.09, 0.5 + R() * 0.8], k * 4)
      base.set([R(), R(), R()], k * 3)
    }
    const sph = new THREE.IcosahedronGeometry(1, 2)
    const bubbles = new THREE.InstancedBufferGeometry()
    bubbles.index = sph.index
    bubbles.setAttribute('position', sph.getAttribute('position'))
    bubbles.setAttribute('normal', sph.getAttribute('normal'))
    bubbles.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4))
    bubbles.setAttribute('aBase', new THREE.InstancedBufferAttribute(base, 3))
    bubbles.instanceCount = N
    const plN = 160
    const pl = new THREE.BufferGeometry()
    const pp = new Float32Array(plN * 3), pr = new Float32Array(plN * 3)
    for (let i = 0; i < plN * 3; i++) { pp[i] = R(); pr[i] = R() }
    pl.setAttribute('position', new THREE.BufferAttribute(pp, 3)); pl.setAttribute('aRand', new THREE.BufferAttribute(pr, 3))
    const geos = { bubbles, rocks: takeSpires() ?? runToEnd(spires()), plankton: pl }
    const mats = {
      bubbles: new THREE.ShaderMaterial({ vertexShader: bubbleVert, fragmentShader: bubbleFrag, uniforms: { ...u, u_box: { value: 9 }, u_colH: { value: 26 }, u_warp: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor }),
      rocks: new THREE.ShaderMaterial({ vertexShader: rockVert, fragmentShader: rockFrag, uniforms: { ...u } }),
      plankton: new THREE.ShaderMaterial({ vertexShader: plankVert, fragmentShader: plankFrag, uniforms: { ...u, u_c: { value: SYS_C.clone() }, u_px: { value: 800 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    }
    return { geos, mats }
  }, [u])
  useFrame(() => {
    const g = group.current; if (!g) return
    g.visible = (u.u_amb.value as number) > 0.01
    mats.plankton.uniforms.u_px.value = props.renderH
    mats.bubbles.uniforms.u_warp.value = Math.pow(Math.max(0, (dive.push - 0.55) / 0.45), 1.5)
  })
  return (
    <group ref={group}>
      <mesh geometry={geos.rocks} material={mats.rocks} renderOrder={11} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />
      <mesh geometry={geos.bubbles} material={mats.bubbles} renderOrder={16} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />
      <points geometry={geos.plankton} material={mats.plankton} renderOrder={13} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />
    </group>
  )
}
