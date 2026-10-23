import * as THREE from 'three'
import { shared } from '../../state/props'
import { causticUniforms, causticsChunk } from '../water/caustics'
import { DIS_GLSL } from '../stages/dive/disintegrate' // R6.88 SINK

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
    u_tp: { value: 1 },
    u_feather: { value: 1.75 },
    u_dis: { value: 0 },   // R6.88 SINK: the stone's particle dissolve (HeroStage shares its gemDisU here)
    u_dep: { value: new THREE.Vector2(0, 2) },   // W25 R6.42: shared with the stone's under-pass depth fade (HeroStage gemDep)     // W25 R6.41: silhouette coverage ramp (scene px), shared with the stone's (HeroStage gemFeather)              // CINEMATIC: three-point strength (key from the surface underwater, fill, rim)
    ...causticUniforms,
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // W25 R6.41: additive in colour, but the destination ALPHA is left alone. With three's AdditiveBlending the shell wrote
    // alpha 1 over its whole (0.4 % larger, hard-edged) footprint in the lake's mirror and under-surface targets, whose
    // alpha the water reads as the stone's coverage: a dark, un-antialiased ring 1-2 px outside the stone's own soft edge
    // (the 390 grey-brown fringe; scorer-r636..r639). Colour is unchanged (src x1 + dst x1, as SRC_ALPHA with a = 1 was).
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW; varying vec3 vO; varying vec3 vON; varying vec3 vOW;
      attribute vec3 aSilB; attribute vec3 aSilN0; attribute vec3 aSilN1; attribute vec3 aSilN2;
      varying vec3 vSilB; varying vec3 vSilN0; varying vec3 vSilN1; varying vec3 vSilN2;
      void main() {
        vSilB = aSilB; mat3 w25M = mat3(modelMatrix); vSilN0 = w25M * aSilN0; vSilN1 = w25M * aSilN1; vSilN2 = w25M * aSilN2;
        vO = position;
        vOW = mat3(modelMatrix) * position;   // W22: the stone's round direction (world), for the warm key's soft spot
        vON = normal;   // DIAG: object-space facet normal (the facet's id must not change as the stone spins)
        vec4 w = modelMatrix * vec4(position * 1.004, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float u_time, u_strength, u_warm, u_surfaceY, u_under, u_tp, u_feather; uniform vec2 u_dep; uniform vec3 u_key, u_rim;
      uniform float u_dis;
      ${DIS_GLSL}
      varying vec3 vN; varying vec3 vW; varying vec3 vO; varying vec3 vON; varying vec3 vOW;
      varying vec3 vSilB; varying vec3 vSilN0; varying vec3 vSilN1; varying vec3 vSilN2;
      ${THIN_FILM}
      float h31(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      ${causticsChunk()}
      void main() {
        if (u_dis > 0.0 && disRaw(u_dis, disFGem(vO)) >= 0.0) discard;   // R6.88 SINK
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
        // W22 (scorer-r614 #3: a blown white facet with a hard straight edge on the stone's right): the key's tight lobe
        // on a FLAT facet lit the whole facet at once (r is constant across it) at 2.4x: a white slab with cut edges. The
        // glint now reflects off a normal bent halfway toward the stone's round shape, so it is a small spot that slides
        // across the facet (graded, never the facet's full outline), and its peak is capped below white.
        vec3 nG = normalize(mix(n, normalize(vOW), 0.55));
        vec3 rG = reflect(-v, nG);
        float k = min(pow(max(dot(rG, u_key), 0.0), 60.0) * 1.5, 0.9) * (0.6 + 0.4 * pow(max(dot(r, u_key), 0.0), 8.0));
        float k2 = pow(max(dot(r, u_key), 0.0), 14.0) * 0.12;
        float rim = pow(max(dot(r, u_rim), 0.0), 24.0) * F;
        vec3 warm = vec3(1.0, 0.82, 0.58);
        vec3 col = iri * u_strength + warm * (k + k2) * u_warm + vec3(0.55, 0.75, 1.0) * rim * 0.5;
        // underwater (as the stone sinks): the warm key is gone (the surface scatters it), and the surface's caustic
        // network plays over every facet that faces up, slightly split in colour, fading with depth; a bright
        // meniscus line rides the facets right at the waterline
        float dz = u_surfaceY - vW.y;
        float sub = smoothstep(-0.004, 0.012, dz) * u_under;
        if (sub > 0.0) {
          col = mix(col, iri * u_strength * 0.6, sub);
          col += causticLight(vW, n) * sub * 1.0;           // the shared glowing caustic web (water/caustics.ts)
        }
        // CINEMATIC three-point (Shifat 18:50Z), no scene lights (the light budget is unchanged): the rim and the fill are
        // tied to the LENS (view space), so they separate the stone from the dark water from any camera; the key stays
        // the warm softbox above (u_key) and becomes the surface light under water. All Fresnel-weighted: the facets'
        // edges catch it, the faces stay clear, so the refracted body is never veiled.
        vec3 lR = normalize((vec4(0.35, 0.55, -1.0, 0.0) * viewMatrix).xyz);    // rim: behind the stone, up-right
        vec3 lF = normalize((vec4(0.7, -0.25, 0.65, 0.0) * viewMatrix).xyz);    // fill: the lens side, low right
        float Fr = pow(1.0 - c, 2.5);
        float rimL = Fr * smoothstep(0.0, 0.75, dot(n, lR));
        float fillL = pow(max(dot(r, lF), 0.0), 5.0) * (0.25 + 0.75 * Fr);
        float keyU = pow(max(dot(r, normalize(vec3(-0.2, 1.0, 0.25))), 0.0), 48.0) * (0.35 + 0.65 * F) * exp(-max(dz, 0.0) * 0.12);
        vec3 tp = mix(vec3(0.55, 0.75, 1.0), vec3(0.6, 0.92, 1.0), sub) * rimL * mix(0.32, 0.6, sub)
                + mix(vec3(0.58, 0.6, 0.66), vec3(0.3, 0.58, 0.64), sub) * fillL * 0.06
                + vec3(0.85, 0.97, 1.0) * keyU * 1.8 * sub;
        col += tp * u_tp;
        // W19 (Shifat 19:50Z "blue with subtle glow"): a faint sapphire body glow, strongest face-on, low enough to feed the
        // hot-spot bloom only where the facets already flare (no haze)
        col += vec3(0.08, 0.26, 0.9) * 0.07 * (0.35 + 0.65 * c) * (1.0 - 0.6 * sub);
        // DIAG: (dz/w)² as a product: pow() of a negative base is undefined in GLSL (NaN on D3D/Metal fast-math), and dz
        // is negative on every facet above the waterline
        float wl = dz / 0.006;
        col += vec3(0.9, 0.97, 1.0) * exp(-wl * wl) * 0.9 * u_under;
        // W25 R6.41 (scorer-r636..r639: a 1-2 px grey-brown fringe OUTSIDE the 390 stone's blue outline): diagnosed on staging
        // (coverage off, SMAA off, CAS off: fringe stays; this shell hidden: fringe gone). The shell is drawn 0.4 % larger than
        // the stone with a hard, un-antialiased outline, so its grazing-angle rim/key light lands on the lake just past the
        // stone's soft edge. It now takes the stone's own analytic silhouette coverage: zero at the outline, full ~1.75 px in.
        vec3 w25V = cameraPosition - vW;
        vec3 w25D = vSilB / max(fwidth(vSilB), vec3(1e-6));
        float w25C = 1e3;
        if (dot(vSilN0, w25V) < 0.0) w25C = min(w25C, w25D.x);
        if (dot(vSilN1, w25V) < 0.0) w25C = min(w25C, w25D.y);
        if (dot(vSilN2, w25V) < 0.0) w25C = min(w25C, w25D.z);
        col *= clamp(w25C / u_feather, 0.0, 1.0);
        if (u_dep.x > 0.5) col *= mix(1.0, 0.3, smoothstep(0.05, 0.9, max(0.0, -vW.y) * u_dep.y));   // W25 R6.42: same fade as the stone's coverage
        gl_FragColor = vec4(col, 1.0);
      }`,
  })
  return { material, uniforms }
}
