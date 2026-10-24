import * as THREE from 'three'
import { createElement, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { props } from '../../state/props'
import { browser } from '../../services/settings'
import { slotBox } from '../../dom/ui/TextLayer'
import { nb } from '../systems/neighbour'
import { DIVE_LAYER } from '../stages/dive/diveState'
import { CLIP } from '../stages/dive/shaders'

/**
 * CINEMATIC (Shifat 18:50Z: "Small realistic water bubbles needed when under water"): sparse, small, rising air
 * bubbles. One draw (points + a sprite shader), BUBBLES.count on EVERY tier (Shifat's same-count rule).
 *
 * Every bubble always exists in the water: the set lives in the lens's frustum (normalised: x/y as a share of the
 * frame at that depth, z between near and far) and is anchored to the WORLD (the lens's own motion is subtracted, so
 * diving down makes them stream past faster, like real parallax). A bubble that rises out of the frame re-enters
 * BELOW the frame, outside the visible margin (BUBBLES.margin), so nothing ever pops in. Visibility is spatial only:
 * depth fog, the lens's near blur, the surface (they live below y = surfaceY) and the type slot (they thin out into
 * the water before reaching the copy at the bottom of the frame). No spawn, fade-in or scale-in anywhere.
 *
 * Look: a real bubble under water is a tiny mirror ball: a thin silvery rim (total internal reflection), almost
 * clear inside, a hot specular point toward the surface light and a soft focused glint at the bottom. The hot point
 * is HDR (> 1), so the selective bloom (fx/hotBloom.ts) picks it up near the surface and lets it go in the deep.
 */

/** SCENE merge contract: the ONE volume constant. Camera-relative, so world placement never moves it; set surfaceY
 *  only if the lake's level ever changes (it is y = 0 today). */
export const BUBBLES = { count: 240, near: 0.55, far: 8, margin: 1.35, surfaceY: 0 }

const vert = /* glsl */ `
attribute vec4 aRand;          // x size, y speed jitter, z phase, w lateral drift
uniform vec3 u_cam, u_bR, u_bU, u_bF;
uniform vec2 u_tan;            // tan(half fov) of the bubble frustum (x, y), margin included
uniform float u_near, u_far, u_time, u_mo, u_pxScale, u_slotY, u_surf, u_amb, u_abyss;
varying float vA, vL, vWob, vPx;
void main(){
  float t = u_time * u_mo;
  float rad = mix(0.0016, 0.0068, aRand.x * aRand.x);                 // radius, m (1.6-7 mm)
  float vy = 0.11 + rad * 30.0;                                       // terminal rise speed, m/s
  float range = u_far - u_near;
  float fz = fract(position.z - dot(u_cam, u_bF) / range);
  float z = u_near + range * fz;
  float hy = z * u_tan.y, hx = z * u_tan.x;
  // small bubbles spiral / zig-zag as they rise; larger ones rock
  float ph = aRand.z * 6.2831;
  float sway = sin(t * (5.0 + 4.0 * aRand.y) + ph) * (0.004 + rad * 1.6);
  float drift = aRand.w * 0.05 * t + 0.25 * sin(t * 0.13 + ph);
  float fy = fract(position.y + (vy * (1.0 + 0.25 * aRand.y) * t - dot(u_cam, u_bU)) / (2.0 * hy));
  float fx = fract(position.x + (drift - dot(u_cam, u_bR)) / (2.0 * hx));
  vec3 wp = u_cam + u_bF * z + u_bU * ((fy * 2.0 - 1.0) * hy) + u_bR * ((fx * 2.0 - 1.0) * hx + sway);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 0.05);
  float px = 2.0 * rad * u_pxScale / dist;                            // true diameter in pixels
  gl_PointSize = clamp(px * 1.25, 5.0, 56.0);                         // the sprite holds the rim's soft edge
  vPx = gl_PointSize;                                                  // R6.95: the sprite's size in pixels (the fragment's AA)
  // spatial visibility only (never a timed fade): the wrap faces sit outside the frame, the near lens blur, the fog,
  // the surface, and the copy's slot at the bottom of the frame
  float e = min(min(fy, 1.0 - fy), min(fx, 1.0 - fx));
  float a = smoothstep(0.0, 0.05, e);
  a *= smoothstep(u_near, u_near + 0.7, dist);
  a *= 1.0 - smoothstep(0.8, 1.0, fz);                                 // W19 (review P2): far edge fades, no wrap pop
  a *= exp(-dist * mix(0.085, 0.13, u_abyss));
  a *= 1.0 - smoothstep(u_surf - 0.25, u_surf - 0.02, wp.y);
  vec2 ndc = gl_Position.xy / max(gl_Position.w, 1e-3);
  a *= smoothstep(u_slotY, u_slotY + 0.16, ndc.y);
  a *= min(1.0, 0.35 + px / 3.0);                                            // sub-pixel bubbles are faint, not fat
  vA = a;
  // light: the sunlit layer near the surface, dimming with depth into the deep's own faint glow
  float depth = max(u_surf - wp.y, 0.0);
  vL = (0.4 + 0.6 * exp(-0.06 * depth)) * mix(1.0, 0.7, u_amb) * (1.0 - 0.2 * u_abyss);
  vWob = 0.07 * sin(t * (9.0 + 6.0 * aRand.y) + ph * 3.0) * smoothstep(0.0025, 0.0052, rad);
}`

const frag = /* glsl */ `
uniform float u_time, u_split; uniform vec2 u_res;
${CLIP}
varying float vA, vL, vWob, vPx;
void main(){
  splitClip();
  if (vA < 0.002) discard;
  vec2 q = gl_PointCoord * 2.0 - 1.0; q.y = -q.y;
  q *= vec2(1.0 + vWob, 1.0 - vWob) * 1.25;                          // larger bubbles wobble (oblate ↔ prolate)
  float r = length(q);
  // R6.95 AA (Shifat's PC and phone, where the background renders at 0.5-0.75x): most bubbles sit at the 5 px sprite floor,
  // so the rim (a tenth of the radius) was a sub-pixel line that broke into flickering dashes. Each band is now at least
  // one pixel wide (w: a pixel in q units, beyond what the band already spans) with its brightness scaled by the same
  // factor, so a bubble keeps its light and reads as a clean ring; big sprites (over ~40 px) are unchanged.
  float w = max(0.0, 2.5 / max(vPx, 1.0) - 0.06);
  if (r > 1.0 + w) discard;
  float dark = smoothstep(0.62 - w, 0.84, r) * (1.0 - smoothstep(0.86, 0.95 + w, r)) * (0.175 / (0.175 + w));   // the refraction edge: darker than the water
  float rim = smoothstep(0.82 - w, 0.93, r) * (1.0 - smoothstep(0.95, 1.0 + w, r)) * (0.1 / (0.1 + w));      // the silvery line (internal reflection)
  float v2 = w * w * 0.0833;                                           // a pixel box's variance, added to the two highlights
  float ks = 1.0 / (0.0294 + 2.0 * v2), kg = 1.0 / (0.025 + 2.0 * v2);  // = 34 and 40 when w = 0
  float spec = exp(-dot(q - vec2(-0.34, 0.4), q - vec2(-0.34, 0.4)) * ks) * (ks / 34.0);
  float glint = exp(-dot(q - vec2(0.18, -0.52), q - vec2(0.18, -0.52)) * kg) * 0.35 * (kg / 40.0);
  float inner = (1.0 - smoothstep(0.0, 0.85, r)) * 0.05;
  vec3 lc = vec3(0.86, 0.96, 1.0) * vL;
  vec3 col = lc * (rim * 1.15 + inner + glint) + lc * spec * 2.4;     // spec core is HDR: the bloom's hot spot
  float alpha = dark * 0.5 + rim * 0.6 + inner;                                    // premultiplied: the rim darkens what is behind
  gl_FragColor = vec4(col * vA, clamp(alpha, 0.0, 1.0) * vA);
}`

type U = Record<string, { value: any }>
export function Bubbles({ u }: { u: U }) {
  const { camera } = useThree() as { camera: THREE.PerspectiveCamera }
  const geo = useMemo(() => {
    let s = 9137 >>> 0
    const R = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
    const n = BUBBLES.count, p = new Float32Array(n * 3), a = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      // most are lone bubbles; a quarter ride in loose short trains (same column, spaced up the frame)
      const train = i >= n * 0.75, k = i % 6, base = Math.floor(i / 6)
      const tx = train ? ((base * 0.618) % 1) : R(), tz = train ? ((base * 0.414 + 0.2) % 1) : Math.pow(R(), 1.35)
      p.set([tx + (train ? (R() - 0.5) * 0.004 : 0), train ? ((base * 0.29 + k * 0.035) % 1) : R(), tz], i * 3)
      a.set([train ? 0.25 + R() * 0.3 : R(), R(), R(), (R() - 0.5) * 2], i * 4)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('aRand', new THREE.BufferAttribute(a, 4))
    return g
  }, [])
  const st = useMemo(() => ({ q: new THREE.Quaternion(), m: new THREE.Matrix4(), init: false }), [])
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag,
    uniforms: {
      u_cam: u.u_cam, u_time: u.u_time, u_split: u.u_split, u_res: u.u_res, u_amb: u.u_amb, u_abyss: u.u_abyss,
      u_bR: { value: new THREE.Vector3(1, 0, 0) }, u_bU: { value: new THREE.Vector3(0, 1, 0) }, u_bF: { value: new THREE.Vector3(0, 0, -1) },
      u_tan: { value: new THREE.Vector2(1, 1) }, u_near: { value: BUBBLES.near }, u_far: { value: BUBBLES.far },
      u_mo: { value: browser.reducedMotion ? 0 : 1 }, u_pxScale: { value: 800 }, u_slotY: { value: -2 }, u_surf: { value: BUBBLES.surfaceY },
    },
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  }), [u])

  useFrame(() => {
    const U = mat.uniforms, cam = camera
    // the set's frame follows the lens's orientation with a short lag: the ±1.5° pointer parallax turns the lens
    // against the water (as it should), and the margin keeps the wrap faces outside the frame meanwhile
    if (!st.init) { st.q.copy(cam.quaternion); st.init = true }
    else st.q.slerp(cam.quaternion, 1 - Math.exp(-2.2 * Math.min(props.dt || 0.016, 0.1)))
    st.m.makeRotationFromQuaternion(st.q)
    st.m.extractBasis(U.u_bR.value, U.u_bU.value, U.u_bF.value); U.u_bF.value.negate()
    const ty = Math.tan((cam.fov * Math.PI) / 360) * BUBBLES.margin
    U.u_tan.value.set(ty * cam.aspect, ty)
    U.u_near.value = BUBBLES.near; U.u_far.value = BUBBLES.far; U.u_surf.value = BUBBLES.surfaceY
    U.u_pxScale.value = props.renderH * (nb.active ? nb.scale : 1) / (2 * Math.tan((cam.fov * Math.PI) / 360))
    // the copy's slot (W17 global text layer) in NDC; a soft band above it keeps every bubble off the type
    const H = props.height || 1
    U.u_slotY.value = slotBox.top > 1e4 ? -2 : 1 - 2 * (slotBox.top - 40) / H
  })

  return createElement('points', { geometry: geo, material: mat, renderOrder: 16, frustumCulled: false, onUpdate: (o: THREE.Object3D) => o.layers.set(DIVE_LAYER) })
}
