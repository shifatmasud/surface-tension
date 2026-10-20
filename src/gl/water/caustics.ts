import * as THREE from 'three'
import { shared } from '../../state/props'
import { settings } from '../../services/settings'

/**
 * Caustics, as GLOWING light (Shifat 08:56Z: "ensure the caustic pattern is glowing light underwater").
 *
 * Physics, cheaply: the lake surface is a sum of directional gravity waves h(x). Sunlight refracted at x lands
 * displaced by D·∇h (D grows with depth), so the energy reaching a point below is the inverse area change of that
 * map, I = 1 / |det(I + D·H)| with H the Hessian of h. Where det → 0 the light folds into the sharp filaments
 * real caustics are made of. From the same det we read two things for free:
 *   - the FILAMENT (small epsilon: thin, hot lines) and
 *   - the HALO (large epsilon: the soft glow around each line, the "bloom" that makes it read as light),
 * and three slightly different D per channel give the dispersion fringe. Two layers (different wave sets and
 * scales) interfere: where filaments cross, knots flare.
 *
 * It is ADDITIVE light: causticLight() returns radiance to add (tinted cool aqua, faded with depth and with the
 * distance to the surface, weighted by how much the surface faces up). It never darkens.
 * The waves share the lake's time base and its two swell directions, so the web moves with the waves above.
 *
 * Phones (tier low) use a baked tileable texture of the same web (periodic wave set), two layers scrolling against
 * each other: the same look for two texture reads.
 *
 * API
 *   causticUniforms                      uniform bundle (shared by every material that uses it)
 *   CAUSTICS_GLSL                        the chunk: causticLight(worldPos, worldNormal), causticShafts(worldPos, viewDir)
 *   applyCaustics(material, opts?)       built-in materials (Standard/Physical/Basic/Lambert): onBeforeCompile hook that
 *                                        adds causticLight × albedo to the outgoing light below the surface.
 *                                        ShaderMaterial: merges the uniforms and prepends the chunk (call it yourself).
 *   causticsFrame(renderer)              once per frame (bakes the phone texture on first call)
 */

const LOW = settings.TIER === 'low'

export const causticUniforms = {
  u_czTime: shared.u_time,
  u_czSurfaceY: { value: 0 },                                   // world y of the lake surface
  u_czSun: { value: new THREE.Vector3(0.18, -1, 0.1).normalize() }, // direction sunlight travels underwater
  u_czIntensity: { value: /[?&]oldcaus/.test(location.search) ? 0 : 2.2 },   // QA ?oldcaus: 0 = the dive's previous caustics (before/after)
  u_czTint: { value: new THREE.Color(0.5, 0.95, 1.0) },         // cool aqua (warm highlights elsewhere still read)
  u_czScale: { value: 1.0 },                                    // >1 = smaller cells
  u_czFade: { value: new THREE.Vector2(0.05, 0.015) },           // x: falloff per metre of depth, y: per metre from camera
  u_czTex: { value: null as THREE.Texture | null },
}

export const CAUSTICS_GLSL = /* glsl */ `
uniform float u_czTime, u_czSurfaceY, u_czIntensity, u_czScale;
uniform vec3 u_czSun, u_czTint;
uniform vec2 u_czFade;
uniform sampler2D u_czTex;
#ifndef CZ_TEXTURE
// wave set: lengths (m) and directions fanned around the lake's two swell headings
const int CZ_N = 9;
const float CZ_L[9] = float[9](0.58, 0.77, 0.94, 1.21, 1.52, 1.97, 0.66, 1.08, 2.6);
const float CZ_A[9] = float[9](0.58, 2.03, 0.31, 1.84, 0.83, 2.42, 1.27, 0.12, 2.21);
void czField(vec2 q, float t, float seed, out vec2 g, out vec3 h){
  g = vec2(0.0); h = vec3(0.0);
  for (int i = 0; i < CZ_N; i++){
    float fi = float(i);
    float a = CZ_A[i] + seed;
    vec2 k = vec2(cos(a), sin(a)) * (6.2831853 / CZ_L[i]);
    float A = 0.0082 * pow(CZ_L[i], 1.55) * (0.8 + 0.4 * fract(fi * 0.618 + seed));
    float th = dot(q, k) - sqrt(9.81 * length(k)) * t + fi * 2.1 + seed * 3.0;
    float s = sin(th), c = cos(th);
    g += A * c * k;
    h -= A * s * vec3(k.x * k.x, k.y * k.y, k.x * k.y);
  }
}
// one layer: returns (filament rgb) and halo in .w via out
vec3 czLayer(vec2 q, float D, float t, float seed, float soft, out float halo){
  vec2 g; vec3 h;
  czField(q, t, seed, g, h);
  q -= D * g;                                   // one fixed-point step: back to the surface point that feeds q
  czField(q, t, seed, g, h);
  float tr = h.x + h.y, dt = h.x * h.y - h.z * h.z;
  vec3 Dc = D * vec3(1.06, 1.0, 0.94);          // dispersion: red focuses a touch deeper than blue
  vec3 det = abs(1.0 + Dc * tr + Dc * Dc * dt);
  float e = 0.03 + soft;
  vec3 I = e / (det + e);                        // 0..1, 1 on the fold
  float dg = det.g;
  halo = 0.28 / (dg + 0.28);                     // the same fold, seen wide: the glow around it
  return I * I;                                  // squared: hot thin core
}
#endif
/** the glowing web at surface-plane point q (rgb, mean ~0.25, peaks ~2) for light that travelled depth d */
vec3 causticWeb(vec2 q, float d, float soft){
  q *= u_czScale;
#ifdef CZ_TEXTURE
  vec2 w = vec2(0.32, 0.11) * u_czTime;          // the lake's wind
  vec4 a = texture2D(u_czTex, q * 0.36 + w * 0.06);
  vec4 b = texture2D(u_czTex, vec2(-q.y, q.x) * 0.53 - w * 0.05 + 0.37);
  vec3 fil = a.rgb * (0.7 + 0.9 * b.g) + b.rgb * 0.5;
  float halo = a.a * 0.6 + b.a * 0.4;
  return fil * 1.7 + halo * halo * 0.7;
#else
  float t = u_czTime * 0.55;
  float D = 1.0 + 0.04 * d;
  float h1, h2;
  vec3 l1 = czLayer(q * 1.9, D, t, 0.0, soft, h1);
  vec3 l2 = czLayer(q * 3.1 + 7.3, D * 0.8, t * 1.13, 1.7, soft * 1.2, h2);
  vec3 fil = l1 * 0.85 + l2 * 0.45 + l1 * l2 * 1.6;         // interference: knots flare where the two webs cross
  float halo = h1 * 0.6 + h2 * 0.4;
  return fil * 1.25 + halo * halo * 0.55;
#endif
}
/** additive caustic light on a surface at p with normal n (both world space). Multiply by albedo and add. */
vec3 causticLight(vec3 p, vec3 n){
  float d = u_czSurfaceY - p.y;
  if (d <= 0.0) return vec3(0.0);
  vec2 q = p.xz - u_czSun.xz * (d / max(-u_czSun.y, 0.2));   // where its light entered the surface
  float dist = length(p - cameraPosition);
  float soft = smoothstep(4.0, 22.0, d) * 0.25 + smoothstep(6.0, 30.0, dist) * 0.2;   // far and deep go soft, not noisy
  vec3 web = causticWeb(q, d, soft);
  float face = clamp(dot(n, -u_czSun) * 0.75 + 0.25, 0.0, 1.0);
  float fade = exp(-d * u_czFade.x) * exp(-max(dist - 4.0, 0.0) * u_czFade.y) * smoothstep(0.0, 0.08, d);
  return web * u_czTint * face * fade * u_czIntensity;
}
/** faint streaks in the water volume (god-ray texture): add along a view ray, or on a backdrop */
vec3 causticShafts(vec3 p, vec3 viewDir){
  float d = max(u_czSurfaceY - p.y, 0.0);
  vec2 q = p.xz - u_czSun.xz * (d / max(-u_czSun.y, 0.2));
  vec3 web = causticWeb(q * 0.35, d, 0.45);
  float look = pow(max(dot(viewDir, -u_czSun), 0.0), 3.0) * 0.7 + 0.3;
  return web.ggg * u_czTint * 0.06 * look * exp(-d * 0.12) * u_czIntensity;
}
`

/** Bake the tileable phone texture: rgb = filament (dispersed), a = halo. Periodic wave set (integer k) → seamless. */
const BAKE_FRAG = /* glsl */ `
varying vec2 vUv;
vec2 kk(int i){
  // integer wave numbers on a 1-unit tile, fanned around the lake's swell headings
  if (i == 0) return vec2(3.0, 2.0); if (i == 1) return vec2(-1.0, 4.0); if (i == 2) return vec2(5.0, 1.0);
  if (i == 3) return vec2(-3.0, 3.0); if (i == 4) return vec2(2.0, -5.0); if (i == 5) return vec2(6.0, 4.0);
  if (i == 6) return vec2(-5.0, 2.0); if (i == 7) return vec2(1.0, 7.0); return vec2(4.0, -3.0);
}
void field(vec2 q, out vec2 g, out vec3 h){
  g = vec2(0.0); h = vec3(0.0);
  for (int i = 0; i < 9; i++){
    vec2 k = kk(i) * 6.2831853;
    float A = 0.034 / pow(length(kk(i)), 1.45);
    float th = dot(q, k) + float(i) * 2.1;
    g += A * cos(th) * k;
    h -= A * sin(th) * vec3(k.x * k.x, k.y * k.y, k.x * k.y);
  }
}
void main(){
  vec2 q = vUv; vec2 g; vec3 h;
  field(q, g, h); q -= 0.2 * g; field(q, g, h);
  float tr = h.x + h.y, dt = h.x * h.y - h.z * h.z;
  vec3 D = 0.2 * vec3(1.06, 1.0, 0.94);
  vec3 det = abs(1.0 + D * tr + D * D * dt);
  vec3 I = 0.06 / (det + 0.06);
  float halo = 0.35 / (det.g + 0.35);
  gl_FragColor = vec4(I * I, halo);
}`

let baked: THREE.WebGLRenderTarget | null = null
function bake(renderer: THREE.WebGLRenderer) {
  const rt = new THREE.WebGLRenderTarget(512, 512, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter })
  const mat = new THREE.ShaderMaterial({ vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }', fragmentShader: BAKE_FRAG, depthTest: false, depthWrite: false })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat); mesh.frustumCulled = false
  const scene = new THREE.Scene(); scene.add(mesh)
  const prev = renderer.getRenderTarget()
  renderer.setRenderTarget(rt); renderer.render(scene, new THREE.Camera()); renderer.setRenderTarget(prev)
  rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping
  mat.dispose(); mesh.geometry.dispose()
  return rt
}

/** call once per frame from any stage that shows caustics (bakes the phone texture on first use) */
export function causticsFrame(renderer: THREE.WebGLRenderer) {
  if (LOW && !baked) { baked = bake(renderer); causticUniforms.u_czTex.value = baked.texture }
}

const DEFINES = LOW ? '#define CZ_TEXTURE\n' : ''
export const causticsChunk = () => DEFINES + CAUSTICS_GLSL

/**
 * Hook caustics into a material.
 *  - Built-in lit/unlit materials: adds causticLight(world pos, world normal) × diffuse colour to the outgoing light.
 *  - ShaderMaterial: merges the uniforms and prepends the chunk to the fragment shader; call causticLight() yourself.
 */
export function applyCaustics(material: THREE.Material, opts: { strength?: number } = {}) {
  const k = (opts.strength ?? 1).toFixed(3)
  if ((material as THREE.ShaderMaterial).isShaderMaterial) {
    const m = material as THREE.ShaderMaterial
    Object.assign(m.uniforms, causticUniforms)
    if (!m.fragmentShader.includes('causticLight(vec3 p')) m.fragmentShader = causticsChunk() + m.fragmentShader
    m.needsUpdate = true
    return material
  }
  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader, r) => {
    prev?.call(material, shader, r)
    Object.assign(shader.uniforms, causticUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCzW;\nvarying vec3 vCzN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec4 czw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            czw = instanceMatrix * czw;
          #endif
          vCzW = (modelMatrix * czw).xyz;
          vCzN = normalize(mat3(modelMatrix) * normal);
        }`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCzW;\nvarying vec3 vCzN;\n' + causticsChunk())
      .replace('#include <opaque_fragment>', `outgoingLight += causticLight(vCzW, normalize(vCzN)) * diffuseColor.rgb * ${k};\n#include <opaque_fragment>`)
  }
  material.customProgramCacheKey = () => 'caustics' + k + (LOW ? 'L' : 'H')
  material.needsUpdate = true
  return material
}
