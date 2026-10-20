import * as THREE from 'three'
import { shared } from '../../state/props'
import { sky, SKY_PARS } from '../shaders/sky'
import { settings } from '../../services/settings'

/**
 * Lake water — real optics through cheap, honest approximations:
 *  - waves: a handful of Gerstner-style swells with deep-water dispersion (ω = √(g·k), big waves slower)
 *    + the interactive height-field sim + two drifting detail normals (fade with distance → no aliasing)
 *  - Schlick Fresnel with F0 = 0.02 (IOR 1.333)
 *  - reflection: the analytic sky + a planar reflection of the diamond (distorted by the normal)
 *  - refraction: the refracted ray is traced analytically to the lake bed (Snell, η = 1/1.333), the bed is
 *    shaded with sun light × caustics, and Beer–Lambert absorption over the path (red dies first) +
 *    in-scattering gives the depth tint
 *  - from below (dive): Snell's window, total internal reflection outside it
 * Units are metres; the camera floats ~1.4 m over a calm lake.
 */
export function createWaterMaterial() {
  const hi = settings.TIER === 'high' || settings.TIER === 'mid'
  const uniforms = {
    ...sky,
    u_time: shared.u_time,
    u_rippleTexture: shared.u_rippleTexture,
    u_rippleTexel: shared.u_rippleTexel,
    u_poolSize: { value: 22 },
    u_rippleAmp: { value: 0.45 },
    u_rippleShade: { value: 3.0 },
    u_rippleGate: { value: new THREE.Vector3(0.0, -28.0, 0.12) }, // y<0: shade by curvature × −y (rings read, broad swells stay clean: no grey patches); y>0: gradient gated to |grad| x..y; z: max shade
    u_swell: { value: 1 },
    u_reflTex: { value: null as THREE.Texture | null },
    u_reflMatrix: { value: new THREE.Matrix4() },
    u_reflOn: { value: 0 },
    u_gemReflK: { value: 0 },                                        // extra gem-reflection weight above Fresnel (tried 0.32/0.55 on 10-20: reads as a flat disc, off)
    u_bedDepth: { value: 1.6 },
    u_absorb: { value: new THREE.Vector3(0.9, 0.72, 0.6) },      // σ_a per metre (clear lake water, red first)
    u_scatter: { value: new THREE.Color('#dfe6ec') },                // in-scatter colour (deep teal)
    u_bedColor: { value: new THREE.Color('#e6e8ea') },               // pale sand
    u_gem: { value: new THREE.Vector4(0, 0.5, 0, 0) },               // xyz diamond centre, w = caustic strength
    u_gemTint: { value: new THREE.Color('#2f63ff') },
    u_fogNear: { value: 7 }, u_fogFar: { value: 26 },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: { HI: hi ? 1 : 0 },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform sampler2D u_rippleTexture; uniform vec2 u_rippleTexel; uniform float u_poolSize, u_rippleAmp, u_time, u_swell, u_rippleShade;
      uniform mat4 u_reflMatrix;
      varying vec3 v_world; varying vec2 v_ruv; varying float v_rmask; varying vec4 v_refl;
      float rh(vec2 uv){ return texture2D(u_rippleTexture, uv).r; }
      // low swell for the vertex (the fragment re-evaluates it with full detail)
      float swellH(vec2 p){
        float h = 0.0;
        h += 0.016 * sin(dot(p, vec2(0.83, 0.55)) * 0.92 - u_time * sqrt(9.81 * 0.92) * 0.55);
        h += 0.010 * sin(dot(p, vec2(-0.42, 0.91)) * 1.55 - u_time * sqrt(9.81 * 1.55) * 0.55 + 1.7);
        return h * u_swell;
      }
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec2 ruv = vec2(wp.x, -wp.z) / u_poolSize + 0.5;
        float m = smoothstep(0.0, 0.08, ruv.x) * smoothstep(0.0, 0.08, ruv.y) * smoothstep(1.0, 0.92, ruv.x) * smoothstep(1.0, 0.92, ruv.y);
        v_ruv = ruv; v_rmask = m;
        wp.y += swellH(wp.xz) + (m > 0.0 ? rh(ruv) * u_rippleAmp * m : 0.0);
        v_world = wp.xyz;
        v_refl = u_reflMatrix * wp;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${SKY_PARS}
      uniform sampler2D u_rippleTexture; uniform vec2 u_rippleTexel; uniform float u_poolSize, u_rippleAmp, u_time, u_swell, u_rippleShade;
      uniform vec3 u_rippleGate;
      uniform sampler2D u_reflTex; uniform float u_reflOn; uniform float u_gemReflK;
      uniform float u_bedDepth; uniform vec3 u_absorb; uniform vec3 u_scatter; uniform vec3 u_bedColor;
      uniform vec4 u_gem; uniform vec3 u_gemTint; uniform float u_fogNear, u_fogFar;
      varying vec3 v_world; varying vec2 v_ruv; varying float v_rmask; varying vec4 v_refl;

      // ---- height gradient: swells (analytic derivative) -------------------------------------
      // Each wave: amplitude a, direction d, wavenumber k; deep-water dispersion ω = √(g k), slowed a touch
      // for a calm-lake read. Gradient only (normals); heights are tiny.
      vec2 wave(vec2 p, vec2 d, float k, float a, float ph){
        float w = sqrt(9.81 * k) * 0.55;
        float c = cos(dot(p, d) * k - u_time * w + ph);
        return d * (a * k * c);
      }
      vec2 swellGrad(vec2 p){
        vec2 g = vec2(0.0);
        g += wave(p, vec2(0.83, 0.55), 0.92, 0.016, 0.0);
        g += wave(p, vec2(-0.42, 0.91), 1.55, 0.010, 1.7);
        g += wave(p, vec2(0.97, -0.24), 2.9, 0.0045, 4.1);
        g += wave(p, vec2(0.2, 0.98), 4.6, 0.0026, 2.3);
        g += wave(p, vec2(-0.88, 0.47), 7.4, 0.0013, 5.9);
        return g * u_swell;
      }
      // ---- micro detail: gradient noise with analytic derivatives (fresh implementation) ------
      vec2 hash2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return -1.0 + 2.0 * fract(sin(p) * 43758.5453); }
      vec3 gnoise(vec2 p){ // value, d/dx, d/dy
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0), du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
        vec2 ga = hash2(i), gb = hash2(i + vec2(1, 0)), gc = hash2(i + vec2(0, 1)), gd = hash2(i + vec2(1, 1));
        float va = dot(ga, f), vb = dot(gb, f - vec2(1, 0)), vc = dot(gc, f - vec2(0, 1)), vd = dot(gd, f - vec2(1, 1));
        return vec3(va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd),
          ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va));
      }
      // ---- caustics: two drifting ridged-cell layers multiplied (bright thin network, fresh) ---
      float cells(vec2 p, float t){
        vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          vec2 o = vec2(x, y); vec2 h = 0.5 + 0.5 * sin(t + 6.2831 * fract(sin(vec2(dot(i + o, vec2(41.3, 289.1)), dot(i + o, vec2(173.9, 61.7)))) * 7341.3));
          float d = length(o + h - f);
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
        }
        return d2 - d1;
      }
      float caustic(vec2 p, float t){
        float a = 1.0 - smoothstep(0.0, 0.16, cells(p * 1.15, t * 0.55));
        #if HI
          float b = 1.0 - smoothstep(0.0, 0.2, cells(p * 1.9 + 3.1, -t * 0.42));
          return a * 0.75 + a * b * 1.4 + 0.08;
        #else
          return a * 1.1 + 0.1;
        #endif
      }

      void main(){
        vec3 V = normalize(cameraPosition - v_world);
        float dist = length(cameraPosition - v_world);
        // ---- normal ----
        vec2 g = swellGrad(v_world.xz);
        vec2 rg = vec2(0.0); float rlap = 0.0;
        if (v_rmask > 0.0) {
          float hx = texture2D(u_rippleTexture, v_ruv + vec2(u_rippleTexel.x, 0.0)).r - texture2D(u_rippleTexture, v_ruv - vec2(u_rippleTexel.x, 0.0)).r;
          float hy = texture2D(u_rippleTexture, v_ruv + vec2(0.0, u_rippleTexel.y)).r - texture2D(u_rippleTexture, v_ruv - vec2(0.0, u_rippleTexel.y)).r;
          float cell = 2.0 * u_poolSize * u_rippleTexel.x;
          rg = vec2(hx, -hy) * u_rippleAmp * v_rmask / cell;
          float h0 = texture2D(u_rippleTexture, v_ruv).r;
          rlap = (texture2D(u_rippleTexture, v_ruv + vec2(u_rippleTexel.x, 0.0)).r + texture2D(u_rippleTexture, v_ruv - vec2(u_rippleTexel.x, 0.0)).r
                + texture2D(u_rippleTexture, v_ruv + vec2(0.0, u_rippleTexel.y)).r + texture2D(u_rippleTexture, v_ruv - vec2(0.0, u_rippleTexel.y)).r - 4.0 * h0) * u_rippleAmp * v_rmask;
          g += rg;
        }
        float detailFade = 1.0 - smoothstep(6.0, 26.0, dist);
        vec2 wind = vec2(0.32, 0.11) * u_time;
        vec3 n1 = gnoise(v_world.xz * 2.1 + wind);
        g += n1.yz * 0.05 * detailFade;
        #if HI
          vec3 n2 = gnoise(v_world.xz * 5.3 - wind * 1.7 + 9.0);
          g += n2.yz * 0.012 * detailFade * detailFade;
        #endif
        vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 col;
        vec4 gemR = vec4(0.0);
        if (gl_FrontFacing) {
          float NoV = max(dot(N, V), 0.0);
          float F = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);              // Schlick, IOR 1.333
          vec3 R = reflect(-V, N); R.y = abs(R.y);
          vec3 refl = skyColor(R, 0.0);
          // planar reflection of the diamond, wobbled by the surface normal
          if (u_reflOn > 0.5) {
            vec4 ruv = v_refl; ruv.xy += N.xz * 0.11 * ruv.w;
            vec4 pr = texture2DProj(u_reflTex, ruv) * 0.5;
            pr += texture2DProj(u_reflTex, ruv + vec4(0.0, 0.006, 0.0, 0.0) * ruv.w) * 0.25;
            pr += texture2DProj(u_reflTex, ruv - vec4(0.0, 0.006, 0.0, 0.0) * ruv.w) * 0.25;
            refl = mix(refl, pr.rgb / max(pr.a, 1e-3), pr.a * 0.6);
            gemR = vec4(pr.rgb / max(pr.a, 1e-3), pr.a);
          }
          // refraction to the bed (analytic ray-plane)
          vec3 T = refract(-V, N, 1.0 / 1.333);
          float depthHere = u_bedDepth + smoothstep(3.0, 20.0, length(v_world.xz - cameraPosition.xz)) * 2.0; // shelves away from the viewer
          float tb = (depthHere + v_world.y) / max(-T.y, 0.05);
          vec3 bed = v_world + T * tb;
          // sun into the water (refracted), down to the bed: light path for Beer–Lambert
          vec3 Ls = refract(-u_sunDir, vec3(0, 1, 0), 1.0 / 1.333);
          float ls = u_bedDepth / max(-Ls.y, 0.1);
          vec2 cp = bed.xz - Ls.xz * ls * 0.0 + N.xz * 0.6;              // the surface normal shimmers the pattern
          float cau = caustic(cp * 2.4, u_time * 0.7);
          float sand = 0.82 + 0.18 * gnoise(bed.xz * 0.7).x;
          float cauFade = (1.0 - smoothstep(3.0, 9.0, dist)) * 0.12;
          vec3 sunOnBed = u_sunColor * (0.55 + cauFade * (cau - 0.4)) * exp(-u_absorb * ls);
          vec3 amb = mix(u_skyMid, u_skyHorizon, 0.4) * 0.35;
          vec3 bedCol = u_bedColor * sand * (sunOnBed + amb);
          // the diamond focuses blue light into a soft, rippling caustic under itself
          vec2 gd = bed.xz - (u_gem.xz + Ls.xz * (u_gem.y + u_bedDepth) / max(-Ls.y, 0.1));
          float gemSpot = exp(-dot(gd, gd) * 5.0) * (0.6 + 0.8 * cau);
          bedCol += u_gemTint * gemSpot * u_gem.w * 0.0;
          float L = tb;                                                    // path length through water
          vec3 Tr = exp(-u_absorb * L);
          vec3 inscatter = u_scatter * (u_sunColor * 0.75 + amb) * (1.0 - exp(-(u_absorb + 0.06) * L));
          vec3 refr = bedCol * Tr + inscatter;
          col = mix(refr, refl, F);
          // sun glints: a tight lobe (sparkle) + a broad one (glitter path)
          vec3 H = normalize(u_sunDir + V);
          float NoH = max(dot(N, H), 0.0);
          // the glitter path belongs to grazing views; seen from above it breaks into white blotches on the detail
          // normals (the statement's top-down shot), so it fades out as the view turns steep
          float glitter = 1.0 - smoothstep(0.45, 0.85, NoV);
          col += u_sunColor * (pow(NoH, 1600.0) * 60.0 + pow(NoH, 180.0) * 1.6) * F * 4.0 * glitter;
          // ring read: on a near-uniform bright sky a ripple only shows where it bends something, so each ring gets a
          // faint shaded flank (away from the key) and a lit lip (toward it), the sky-gradient reflection exaggerated;
          // only the interactive sim drives it (swell and detail stay glassy)
          float rlen = length(rg);
          if (rlen > 1e-4) {
            vec2 kd = normalize(u_sunDir.xz + vec2(1e-4, 0.0));
            float rs;
            if (u_rippleGate.y < 0.0) rs = clamp(rlap * -u_rippleGate.y, -u_rippleGate.z, u_rippleGate.z * 0.3); // curvature: rings read by their lit crests; a fresh drop's bowl only dims a touch (no grey discs)
            else rs = clamp(dot(rg, kd) * u_rippleShade, -0.22, u_rippleGate.z) * (u_rippleGate.y > 0.0 ? smoothstep(u_rippleGate.x, u_rippleGate.y, rlen) : 1.0);
            col *= 1.0 - rs;
            col += u_sunColor * smoothstep(0.08, 0.5, rlen) * max(-rs, 0.0) * 0.6;
          }
          // blue light spilled by the gem onto the water around it (soft, wide) + a tighter core
          vec2 gq = v_world.xz - u_gem.xz;
          float spill = exp(-dot(gq, gq) * 1.3) * 0.3 + exp(-dot(gq, gq) * 6.0) * 0.34;
          col = mix(col, col * u_gemTint * 1.5 + u_gemTint * 0.2, clamp(spill * u_gem.w, 0.0, 1.0));
          col = mix(col, gemR.rgb, clamp(gemR.a * u_gemReflK, 0.0, 1.0));
          // aerial perspective toward the horizon
          float fog = smoothstep(u_fogNear, u_fogFar, dist);
          col = mix(col, u_skyHorizon, fog);
        } else {
          // underwater looking up: Snell's window (≈48.6° half-angle), TIR outside it
          vec3 Nu = -N;
          vec3 T = refract(-V, Nu, 1.333);
          vec3 deep = u_scatter * 0.55;
          if (dot(T, T) < 1e-4) {
            col = deep * 0.9;                                              // total internal reflection
          } else {
            float F = 0.02 + 0.98 * pow(1.0 - max(dot(Nu, V), 0.0), 5.0);
            col = mix(skyColor(T, 1.0) * 1.1, deep, F);
            col = mix(col, deep, smoothstep(0.62, 0.66, 1.0 - max(dot(V, vec3(0, -1, 0)), 0.0))); // soft window edge
          }
          col *= exp(-u_absorb * dist * 0.5);
          col += u_scatter * 0.4 * (1.0 - exp(-0.12 * dist));
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
  material.extensions = { derivatives: true } as any
  return { material, uniforms }
}
