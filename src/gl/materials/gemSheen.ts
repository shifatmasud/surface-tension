import * as THREE from 'three'
import { shared } from '../../state/props'
import { causticUniforms, causticsChunk } from '../water/caustics'

/**
 * Thin-film interference, shared GLSL: the colour of light reflected by a film of thickness d (nm) and index nf
 * over a substrate, at view cosine c. Two-beam approximation per wavelength (R 650 / G 532 / B 450 nm):
 * I(λ) = 0.5 + 0.5·cos(4π·nf·d·cosθt / λ + π). Tasteful use = weighted by Fresnel, so the fringe lives only on
 * grazing facets and edges, like oil on glass or anodised metal; never a rainbow wash over the whole object.
 */
export const THIN_FILM = /* glsl */ `
vec3 thinFilm(float c, float d, float nf) {
  float s = sqrt(max(1.0 - (1.0 - c * c) / (nf * nf), 0.0));   // cos of the refracted angle inside the film
  vec3 lam = vec3(650.0, 532.0, 450.0);
  vec3 ph = 12.5663706 * nf * d * s / lam + 3.14159265;
  return 0.5 + 0.5 * cos(ph);
}`

/**
 * The stone's skin: a second pass over the brilliant (same geometry, a hair larger, additive) that adds what the
 * ray-traced body cannot: (1) a thin-film iridescent fringe on grazing facets (cool violet→teal→gold), and (2) the
 * warm key: small, hot, slightly gold specular glints from a softbox up-left (foreground warmer, per the
 * colour-depth rule). Self-contained: no scene lights, no env, so it reads the same over a light or a dark field.
 */
export function createGemSheen(opts: { strength?: number; warm?: number } = {}) {
  const uniforms = {
    u_time: shared.u_time,
    u_strength: { value: opts.strength ?? 1 },
    u_warm: { value: opts.warm ?? 1 },
    u_key: { value: new THREE.Vector3(-0.45, 0.8, 0.55).normalize() },
    u_rim: { value: new THREE.Vector3(0.6, 0.35, -0.7).normalize() },
    u_surfaceY: { value: 0 },        // the lake's level: below it the stone is underwater
    u_under: { value: 1 },           // 0 disables the underwater look (caustics, absorption, waterline)
    ...causticUniforms,
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW; varying vec3 vO; varying vec3 vON;
      void main() {
        vO = position;
        vON = normal;   // DIAG: object-space facet normal (the facet's id must not change as the stone spins)
        vec4 w = modelMatrix * vec4(position * 1.004, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float u_time, u_strength, u_warm, u_surfaceY, u_under; uniform vec3 u_key, u_rim;
      varying vec3 vN; varying vec3 vW; varying vec3 vO; varying vec3 vON;
      ${THIN_FILM}
      float h31(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      ${causticsChunk()}
      void main() {
        vec3 n = normalize(vN);
        vec3 v = normalize(cameraPosition - vW);
        if (dot(n, v) < 0.0) n = -n;
        float c = clamp(dot(n, v), 0.0, 1.0);
        float F = pow(1.0 - c, 4.0);
        // film thickness drifts slowly over the stone (flat per facet + a soft gradient across it)
        // DIAG: hashed on the OBJECT-space normal: the world normal turns with the spin and the tilt springs, so each
        // facet's film thickness jumped to a new random value whenever its normal crossed a 1/6 cell (sheen popping)
        float facet = h31(floor(normalize(vON) * 6.0 + 0.5));
        float d = 260.0 + 220.0 * (0.5 + 0.5 * sin(vO.y * 3.1 + vO.x * 1.7 + u_time * 0.22)) + 90.0 * facet;
        vec3 film = thinFilm(c, d, 1.38);
        film = film * film * (3.0 - 2.0 * film);               // a touch more saturated, still soft
        vec3 iri = film * F * 0.55;
        // warm key glints (small, hot) and a cool rim from behind
        vec3 r = reflect(-v, n);
        float k = pow(max(dot(r, u_key), 0.0), 90.0);
        float k2 = pow(max(dot(r, u_key), 0.0), 14.0) * 0.12;
        float rim = pow(max(dot(r, u_rim), 0.0), 24.0) * F;
        vec3 warm = vec3(1.0, 0.82, 0.58);
        vec3 col = iri * u_strength + warm * (k * 2.4 + k2) * u_warm + vec3(0.55, 0.75, 1.0) * rim * 0.5;
        // underwater (as the stone sinks): the warm key is gone (the surface scatters it), and the surface's caustic
        // network plays over every facet that faces up, slightly split in colour, fading with depth; a bright
        // meniscus line rides the facets right at the waterline
        float dz = u_surfaceY - vW.y;
        float sub = smoothstep(-0.004, 0.012, dz) * u_under;
        if (sub > 0.0) {
          col = mix(col, iri * u_strength * 0.6, sub);
          col += causticLight(vW, n) * sub * 1.0;           // the shared glowing caustic web (water/caustics.ts)
        }
        // DIAG: (dz/w)² as a product: pow() of a negative base is undefined in GLSL (NaN on D3D/Metal fast-math), and dz
        // is negative on every facet above the waterline
        float wl = dz / 0.006;
        col += vec3(0.9, 0.97, 1.0) * exp(-wl * wl) * 0.9 * u_under;
        gl_FragColor = vec4(col, 1.0);
      }`,
  })
  return { material, uniforms }
}
