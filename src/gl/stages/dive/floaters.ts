import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { createElement, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { props } from '../../../state/props'
import { settings, browser } from '../../../services/settings'
import { DIVE_LAYER } from './diveState'
import { CLIP } from './shaders'

/**
 * W18-DIVE FLOATERS (Shifat 15:29Z: "never forget to add floating underwater objects to enhance experience").
 * Always present through the whole underwater world, at several depths with real parallax: every class lives in its own
 * box that wraps around the camera (an object leaving one side of the box comes back on the other, faded out at the
 * box faces), so wherever the dive goes the water around the lens is populated, near and far, at the same density.
 *  - JELLIES: translucent bells with an iridescent thin-film rim, pulsing, trailing filaments and oral arms
 *  - KELP RIBBONS: torn fronds drifting and turning, backlit at the edges
 *  - ROCKS + DEBRIS: small dark stones and flat flakes tumbling slowly as they sink
 *  - BUBBLES: thin streams of tiny rising beads (ring + highlight)
 *  - MOTES: drifting particles, soft discs; the near ones become out-of-focus bokeh
 * THE SAME OBJECT COUNTS ON EVERY TIER (Shifat's rule): only geometry density (bell/strip segments) scales.
 * Five draw calls in total, all instanced / points. Kept subtle and out of the type slot (faded behind the copy).
 */
const COUNTS = { jelly: 14, kelp: 18, rock: 40, bubbleStreams: 16, bubblesPerStream: 6, motes: 160 }
export const FLOATER_COUNTS = COUNTS

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

const COMMON = /* glsl */ `
uniform vec3 u_cam;
uniform float u_time, u_split, u_amb, u_abyss, u_mo;
uniform vec2 u_res;
uniform vec3 u_box;
/** camera-wrapped position: the object's cell in a box of size u_box around the lens; edge = distance to the box faces (0..0.5) */
vec3 wrapBox(vec3 s01, vec3 drift, out float edge){
  vec3 f = fract(s01 + (drift - u_cam) / u_box);
  vec3 e = 0.5 - abs(f - 0.5);
  edge = min(e.x, min(e.y, e.z));
  return u_cam + (f - 0.5) * u_box;
}
/** how visible an object is: box faces, the surface above, distance, too close to the lens, and the type slot */
float floatFade(vec3 w, float edge, vec4 clip, float nearA, float nearB){
  float dist = length(w - u_cam);
  float a = smoothstep(0.0, 0.1, edge);
  a *= 1.0 - smoothstep(-0.6, -0.08, w.y);               // only in the water
  a *= exp(-dist * 0.075);
  a *= smoothstep(nearA, nearB, dist);                   // never a blur filling the lens
  vec2 ndc = clip.xy / max(clip.w, 1e-3);
  float slot = (1.0 - smoothstep(-0.3, -0.05, ndc.y)) * (1.0 - smoothstep(0.5, 0.85, abs(ndc.x)));
  a *= 1.0 - 0.85 * slot;                                // stay quiet behind the copy (bottom of the frame)
  return a;
}
/** light by depth: the sunlit layer, dimming into the deep */
float depthLight(){ return mix(1.0, 0.5, u_amb) * (1.0 - 0.35 * u_abyss); }
mat3 rotAxis(vec3 k, float a){
  k = normalize(k); float c = cos(a), s = sin(a), o = 1.0 - c;
  return mat3(c + k.x*k.x*o, k.y*k.x*o + k.z*s, k.z*k.x*o - k.y*s,
              k.x*k.y*o - k.z*s, c + k.y*k.y*o, k.z*k.y*o + k.x*s,
              k.x*k.z*o + k.y*s, k.y*k.z*o - k.x*s, c + k.z*k.z*o);
}
`

// ---------------------------------------------------------------- jellies
const jellyVert = /* glsl */ `
${COMMON}
attribute vec3 aF;      // x: 0 bell / 1 filament / 2 oral arm, y: 0 apex … 1 rim (bell) or 0 root … 1 tip, z: strip side ±1
attribute vec4 aSeed;   // xyz cell (0..1), w random
attribute vec4 aSeed2;  // x size, y/z tilt, w film hue
varying float vA, vKind, vT, vHue;
varying vec3 vN, vV;
void main(){
  float t = u_time * u_mo;
  float ph = aSeed.w * 37.0;
  float cyc = t * (0.42 + aSeed.w * 0.3) + ph;
  float pulse = pow(0.5 + 0.5 * sin(cyc * 6.2832), 3.0);                 // a quick contraction, a slow release
  // a slow rise that surges on each stroke, and a lazy sideways wander
  vec3 drift = vec3(0.25 * sin(t * 0.05 + ph), 0.045 * t + 0.06 * sin(cyc * 6.2832 - 1.2), 0.2 * cos(t * 0.04 + ph));
  float edge;
  vec3 c = wrapBox(aSeed.xyz, drift, edge);
  vec3 p = position, n;
  if (aF.x < 0.5){
    float r = aF.y;
    p.xz *= 1.0 - 0.24 * pulse * r * r;
    p.y *= 0.7 + 0.18 * pulse;
    n = normalize(vec3(p.x, p.y * 1.5, p.z));
  } else {
    float v = aF.y, len = aF.x < 1.5 ? 3.2 : 1.1;
    p.xz *= 1.0 - 0.24 * pulse;
    p.y -= v * len * (1.0 - 0.12 * pulse);
    p.x += 0.24 * v * sin(v * 3.4 - t * 1.1 + ph + position.z * 4.0);
    p.z += 0.24 * v * cos(v * 2.9 - t * 0.9 + ph + position.x * 4.0);
    n = vec3(0.0, 0.0, 1.0);
  }
  mat3 R = rotAxis(vec3(aSeed2.y, 0.0, aSeed2.z) + vec3(1e-4), length(aSeed2.yz));
  p = R * p; n = R * n;
  float sz = aSeed2.x;
  vec3 w = c + p * sz;
  vec4 mv = viewMatrix * vec4(w, 1.0);
  if (aF.x > 0.5) mv.x += aF.z * sz * (aF.x < 1.5 ? 0.012 : 0.05) * (1.0 - 0.7 * aF.y);
  gl_Position = projectionMatrix * mv;
  vA = floatFade(c, edge, gl_Position, 0.45, 1.3) * depthLight();
  vN = normalize(mat3(viewMatrix) * n); vV = normalize(-mv.xyz);
  vKind = aF.x; vT = aF.y; vHue = aSeed2.w;
}`
const jellyFrag = /* glsl */ `
uniform float u_time, u_split; uniform vec2 u_res;
${CLIP}
varying float vA, vKind, vT, vHue;
varying vec3 vN, vV;
void main(){
  splitClip();
  vec3 col;
  if (vKind < 0.5){
    float fr = 1.0 - abs(dot(normalize(vN), vV));
    vec3 film = 0.5 + 0.5 * cos(6.2832 * (fr * 1.4 + vHue + vec3(0.0, 0.33, 0.67)));     // thin-film iridescence
    col = mix(vec3(0.55, 0.84, 0.92), film, 0.42) * (0.06 + 0.8 * pow(fr, 2.4));
    col += vec3(0.78, 0.95, 1.0) * smoothstep(0.84, 0.99, vT) * 0.32;                        // the bright bell margin
    col += vec3(0.45, 0.75, 1.0) * 0.05 * (1.0 - vT);                                       // a faint inner glow
  } else {
    col = vec3(0.6, 0.86, 0.95) * (1.0 - vT) * (vKind < 1.5 ? 0.45 : 0.28);
  }
  gl_FragColor = vec4(col * vA * 0.85, 1.0);
}`

// ---------------------------------------------------------------- rocks + debris
const rockVert = /* glsl */ `
${COMMON}
attribute vec4 aSeed;   // xyz cell, w random
attribute vec4 aShape;  // xyz scale, w spin rate
varying float vA; varying vec3 vN, vW;
void main(){
  float t = u_time * u_mo;
  float ph = aSeed.w * 51.0;
  vec3 drift = vec3(0.05 * sin(t * 0.06 + ph), -0.03 * t, 0.04 * cos(t * 0.05 + ph));
  float edge;
  vec3 c = wrapBox(aSeed.xyz, drift, edge);
  mat3 R = rotAxis(vec3(sin(ph), cos(ph * 1.3), sin(ph * 0.7)), t * aShape.w + ph);
  vec3 w = c + R * (position * aShape.xyz);
  vN = R * normalize(normal / aShape.xyz);
  vW = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  vA = floatFade(c, edge, gl_Position, 0.45, 1.3);
}`
const rockFrag = /* glsl */ `
uniform float u_time, u_split, u_amb, u_abyss; uniform vec2 u_res; uniform vec3 u_cam;
${CLIP}
varying float vA; varying vec3 vN, vW;
void main(){
  splitClip();
  vec3 n = normalize(vN), v = normalize(u_cam - vW);
  float L = mix(1.0, 0.5, u_amb) * (1.0 - 0.35 * u_abyss);
  float top = 0.25 + 0.75 * max(n.y, 0.0);
  vec3 col = vec3(0.018, 0.034, 0.04) + vec3(0.05, 0.19, 0.21) * top * top * L;
  col += vec3(0.55, 0.75, 0.8) * pow(1.0 - abs(dot(n, v)), 3.0) * 0.22 * L;               // a silver rim against the water
  gl_FragColor = vec4(col, vA * 0.9);
}`

// ---------------------------------------------------------------- kelp ribbons
const kelpVert = /* glsl */ `
${COMMON}
attribute vec4 aSeed;   // xyz cell, w random
attribute vec4 aShape;  // x length, y width, z spin, w phase
varying float vA, vEdge; varying vec3 vN;
void main(){
  float t = u_time * u_mo;
  float ph = aShape.w;
  vec3 drift = vec3(0.12 * sin(t * 0.04 + ph), -0.012 * t + 0.08 * sin(t * 0.11 + ph), 0.1 * cos(t * 0.035 + ph));
  float edge;
  vec3 c = wrapBox(aSeed.xyz, drift, edge);
  float v = position.y + 0.5;
  float L = aShape.x, W = aShape.y * (0.45 + 0.55 * sin(v * 3.1416));
  float tw = v * 2.6 + 0.5 * sin(t * 0.3 + ph);
  vec3 p = vec3(position.x * W * cos(tw), (v - 0.5) * L, position.x * W * sin(tw));
  p.z += 0.12 * L * sin(v * 4.6 - t * 1.2 + ph);
  p.x += 0.07 * L * sin(v * 3.0 - t * 0.8 + ph);
  vec3 n = vec3(-sin(tw), 0.0, cos(tw));
  mat3 R = rotAxis(vec3(sin(ph * 2.1), 0.35, cos(ph * 1.7)), t * aShape.z + ph);
  vec3 w = c + R * p;
  vN = R * n;
  vEdge = abs(position.x) * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  vA = floatFade(c, edge, gl_Position, 0.45, 1.3) * depthLight();
}`
const kelpFrag = /* glsl */ `
uniform float u_time, u_split; uniform vec2 u_res;
${CLIP}
varying float vA, vEdge; varying vec3 vN;
void main(){
  splitClip();
  vec3 n = normalize(vN);
  vec3 col = vec3(0.022, 0.085, 0.075);
  col += vec3(0.12, 0.42, 0.32) * abs(n.y) * 0.35;                                         // light through the frond
  col += vec3(0.5, 0.8, 0.72) * smoothstep(0.75, 1.0, vEdge) * 0.12;                       // backlit edges
  gl_FragColor = vec4(col * (0.6 + 0.4 * vA), vA * 0.78);
}`

// ---------------------------------------------------------------- bubbles + motes (points)
const bubbleVert = /* glsl */ `
${COMMON}
attribute vec4 aRand;   // x: index along the stream (0..1), y size, z rise speed, w phase
uniform float u_pxScale;
varying float vA;
void main(){
  float t = u_time * u_mo;
  float ph = aRand.w * 40.0;
  float rise = aRand.x * u_box.y * 0.35 + t * aRand.z;
  vec3 drift = vec3(0.05 * sin(t * 2.3 + ph + aRand.x * 9.0), rise, 0.05 * cos(t * 1.9 + ph + aRand.x * 7.0));
  float edge;
  vec3 c = wrapBox(position, drift, edge);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 0.05);
  gl_PointSize = clamp(aRand.y * u_pxScale / dist, 1.5, 40.0);
  vA = floatFade(c, edge, gl_Position, 0.45, 1.3) * depthLight();
}`
const bubbleFrag = /* glsl */ `
uniform float u_time, u_split; uniform vec2 u_res;
${CLIP}
varying float vA;
void main(){
  splitClip();
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = length(q);
  if (r > 1.0) discard;
  float ring = smoothstep(0.6, 0.86, r) * (1.0 - smoothstep(0.9, 1.0, r));
  float spec = smoothstep(0.32, 0.0, length(q - vec2(-0.35, -0.38)));
  vec3 col = vec3(0.7, 0.92, 1.0) * (ring * 0.6 + 0.05 + spec * 0.9);
  gl_FragColor = vec4(col * vA, 1.0);
}`
const moteVert = /* glsl */ `
${COMMON}
attribute vec4 aRand;   // x size, yzw phases
uniform float u_pxScale;
varying float vA;
void main(){
  float t = u_time * u_mo;
  vec3 drift = vec3(0.08 * sin(t * 0.13 + aRand.y * 30.0), 0.05 * sin(t * 0.1 + aRand.z * 30.0) - 0.01 * t, 0.07 * cos(t * 0.11 + aRand.w * 30.0));
  float edge;
  vec3 c = wrapBox(position, drift, edge);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 0.05);
  float ps = aRand.x * u_pxScale / dist;
  // near the lens a mote is out of focus: it grows into a soft disc and its light spreads (energy kept roughly constant)
  float coc = 1.0 + 26.0 * (1.0 - smoothstep(0.3, 2.2, dist));
  gl_PointSize = clamp(ps * coc, 1.2, 46.0);
  vA = floatFade(c, edge, gl_Position, 0.12, 0.5) / (0.6 + 0.4 * coc) * depthLight();   // motes may come right up to the lens
}`
const moteFrag = /* glsl */ `
uniform float u_time, u_split; uniform vec2 u_res;
${CLIP}
varying float vA;
void main(){
  splitClip();
  float r = length(gl_PointCoord * 2.0 - 1.0);
  if (r > 1.0) discard;
  float disc = 1.0 - smoothstep(0.45, 1.0, r);
  gl_FragColor = vec4(vec3(0.62, 0.86, 0.92) * disc * vA * 0.42, 1.0);
}`

/** one geometry: the bell (a flared hemisphere) + filaments + oral arms (strips), drawn instanced */
function jellyGeometry(segW: number, segH: number, filSeg: number) {
  const pos: number[] = [], f: number[] = [], idx: number[] = []
  // bell
  for (let iy = 0; iy <= segH; iy++) {
    const th = (iy / segH) * (Math.PI / 2) * 1.12
    for (let ix = 0; ix <= segW; ix++) {
      const ph = (ix / segW) * Math.PI * 2
      pos.push(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)); f.push(0, iy / segH, 0)
    }
  }
  for (let iy = 0; iy < segH; iy++) for (let ix = 0; ix < segW; ix++) {
    const a = iy * (segW + 1) + ix, b = a + segW + 1
    idx.push(a, b, a + 1, b, b + 1, a + 1)
  }
  const strip = (x: number, y: number, z: number, kind: number) => {
    const base = pos.length / 3
    for (let j = 0; j <= filSeg; j++) for (const sd of [-1, 1]) { pos.push(x, y, z); f.push(kind, j / filSeg, sd) }
    for (let j = 0; j < filSeg; j++) { const a = base + j * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
  }
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + 0.2; strip(Math.cos(a) * 0.9, -0.02, Math.sin(a) * 0.9, 1) }
  for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + 0.6; strip(Math.cos(a) * 0.16, 0.1, Math.sin(a) * 0.16, 2) }
  const g = new THREE.InstancedBufferGeometry()
  g.setIndex(idx)
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aF', new THREE.Float32BufferAttribute(f, 3))
  return g
}

const NOFLOAT = typeof location !== 'undefined' && /[?&]nofloat/.test(location.search)
type U = Record<string, { value: any }>

export function Floaters({ u }: { u: U }) {
  if (NOFLOAT) return null   // QA: ?nofloat (A/B the draw cost)
  const { camera } = useThree() as { camera: THREE.PerspectiveCamera }
  const low = settings.TIER === 'low', hi = settings.TIER === 'high'
  const mo = { value: browser.reducedMotion ? 0 : 1 }   // reduced motion: everything holds still (still present)
  const pxScale = useMemo(() => ({ value: 800 }), [])

  const geos = useMemo(() => {
    const R = rng(1520)
    // jellies
    const jelly = jellyGeometry(low ? 14 : hi ? 24 : 18, low ? 6 : hi ? 10 : 8, low ? 8 : 14)
    const js: number[] = [], js2: number[] = []
    for (let i = 0; i < COUNTS.jelly; i++) {
      js.push(R(), R(), R(), R())
      js2.push(0.16 + Math.pow(R(), 1.6) * 0.32, (R() - 0.5) * 0.5, (R() - 0.5) * 0.5, R())
    }
    jelly.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(js), 4))
    jelly.setAttribute('aSeed2', new THREE.InstancedBufferAttribute(new Float32Array(js2), 4))
    jelly.instanceCount = COUNTS.jelly
    // rocks + debris
    // smooth-shaded pebbles (W18: flat facets read as grey hexagons up close): welded subdivided icosahedron
    const ico = mergeVertices(new THREE.IcosahedronGeometry(1, 2)); ico.computeVertexNormals()
    const rock = new THREE.InstancedBufferGeometry()
    rock.index = ico.index; rock.setAttribute('position', ico.getAttribute('position')); rock.setAttribute('normal', ico.getAttribute('normal'))
    const rs: number[] = [], rsh: number[] = []
    for (let i = 0; i < COUNTS.rock; i++) {
      rs.push(R(), R(), R(), R())
      const flake = R() < 0.45, s = 0.035 + Math.pow(R(), 2.0) * (flake ? 0.09 : 0.14)
      if (flake) rsh.push(s * 1.6, s * 0.18, s * 1.1, 0.25 + R() * 0.5)
      else rsh.push(s * (0.8 + R() * 0.5), s * (0.6 + R() * 0.4), s * (0.8 + R() * 0.4), 0.05 + R() * 0.15)
    }
    rock.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(rs), 4))
    rock.setAttribute('aShape', new THREE.InstancedBufferAttribute(new Float32Array(rsh), 4))
    rock.instanceCount = COUNTS.rock
    ico.dispose()
    // kelp ribbons
    const pl = new THREE.PlaneGeometry(1, 1, 1, low ? 10 : 18)
    const kelp = new THREE.InstancedBufferGeometry()
    kelp.index = pl.index; kelp.setAttribute('position', pl.getAttribute('position'))
    const ks: number[] = [], ksh: number[] = []
    for (let i = 0; i < COUNTS.kelp; i++) { ks.push(R(), R(), R(), R()); ksh.push(0.9 + R() * 1.6, 0.07 + R() * 0.09, 0.04 + R() * 0.08, R() * 6.283) }
    kelp.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(ks), 4))
    kelp.setAttribute('aShape', new THREE.InstancedBufferAttribute(new Float32Array(ksh), 4))
    kelp.instanceCount = COUNTS.kelp
    // bubbles: thin streams (shared cell, staggered along the rise)
    const nb = COUNTS.bubbleStreams * COUNTS.bubblesPerStream
    const bp = new Float32Array(nb * 3), br = new Float32Array(nb * 4)
    for (let s = 0; s < COUNTS.bubbleStreams; s++) {
      const x = R(), y = R(), z = R(), sp = 0.32 + R() * 0.3, ph = R()
      for (let k = 0; k < COUNTS.bubblesPerStream; k++) {
        const i = s * COUNTS.bubblesPerStream + k
        bp.set([x, y, z], i * 3); br.set([k / COUNTS.bubblesPerStream + R() * 0.04, 0.012 + R() * 0.018, sp * (0.9 + R() * 0.2), ph], i * 4)
      }
    }
    const bubbles = new THREE.BufferGeometry()
    bubbles.setAttribute('position', new THREE.BufferAttribute(bp, 3)); bubbles.setAttribute('aRand', new THREE.BufferAttribute(br, 4))
    // motes
    const mp = new Float32Array(COUNTS.motes * 3), mr = new Float32Array(COUNTS.motes * 4)
    for (let i = 0; i < COUNTS.motes; i++) { mp.set([R(), R(), R()], i * 3); mr.set([0.006 + R() * 0.012, R(), R(), R()], i * 4) }
    const motes = new THREE.BufferGeometry()
    motes.setAttribute('position', new THREE.BufferAttribute(mp, 3)); motes.setAttribute('aRand', new THREE.BufferAttribute(mr, 4))
    return { jelly, rock, kelp, bubbles, motes }
  }, [low, hi])

  const mats = useMemo(() => {
    const base = { u_cam: u.u_cam, u_time: u.u_time, u_split: u.u_split, u_amb: u.u_amb, u_abyss: u.u_abyss, u_res: u.u_res, u_mo: mo }
    const box = (x: number, y: number, z: number) => ({ value: new THREE.Vector3(x, y, z) })
    const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }
    return {
      jelly: new THREE.ShaderMaterial({ vertexShader: jellyVert, fragmentShader: jellyFrag, uniforms: { ...base, u_box: box(12, 8, 15) }, side: THREE.DoubleSide, ...add }),
      rock: new THREE.ShaderMaterial({ vertexShader: rockVert, fragmentShader: rockFrag, uniforms: { ...base, u_box: box(8, 6, 10) }, transparent: true, depthWrite: false }),
      kelp: new THREE.ShaderMaterial({ vertexShader: kelpVert, fragmentShader: kelpFrag, uniforms: { ...base, u_box: box(12, 8, 15) }, side: THREE.DoubleSide, transparent: true, depthWrite: false }),
      bubbles: new THREE.ShaderMaterial({ vertexShader: bubbleVert, fragmentShader: bubbleFrag, uniforms: { ...base, u_box: box(8, 9, 10), u_pxScale: pxScale }, ...add }),
      motes: new THREE.ShaderMaterial({ vertexShader: moteVert, fragmentShader: moteFrag, uniforms: { ...base, u_box: box(6, 4.5, 7), u_pxScale: pxScale }, ...add }),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [u, pxScale])

  useFrame(() => {
    pxScale.value = props.renderH / (2 * Math.tan((camera.fov * Math.PI) / 360))
  })

  const layer = (o: THREE.Object3D) => o.layers.set(DIVE_LAYER)
  // (createElement: this file stays .ts so it sits beside the other dive shader modules)
  return createElement('group', null,
    createElement('mesh', { geometry: geos.kelp, material: mats.kelp, renderOrder: 12, frustumCulled: false, onUpdate: layer }),
    createElement('mesh', { geometry: geos.rock, material: mats.rock, renderOrder: 12, frustumCulled: false, onUpdate: layer }),
    createElement('mesh', { geometry: geos.jelly, material: mats.jelly, renderOrder: 16, frustumCulled: false, onUpdate: layer }),
    createElement('points', { geometry: geos.bubbles, material: mats.bubbles, renderOrder: 16, frustumCulled: false, onUpdate: layer }),
    createElement('points', { geometry: geos.motes, material: mats.motes, renderOrder: 17, frustumCulled: false, onUpdate: layer }),
  )
}
