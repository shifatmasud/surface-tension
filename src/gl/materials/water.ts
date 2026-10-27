import * as THREE from 'three'
import { WL_EDGE } from '../water/waterline'
import { shared, props } from '../../state/props'
import { waterInput } from '../water/waterInput'
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
// R7.12 b8-surface-v1 (Shifat 5:03 "touch water surface", 5:04 "A bit transparent refractive water lake"): the fine
// ripples and the bed's caustic light now come from a real photo (files/r711/refs/surface/s00, Mallnitz Stappitzer See,
// Wikimedia Commons, CC BY-SA 4.0): its near rows de-foreshortened 2.1x, high-passed, made seamless; R,G = the ripple
// slope (luminance taken as height), B = the caustic filaments. 256 px JPEG, 27 KB. ?wsurf=old = the procedural b8 lake
// R7.12 b8-surface-v3 (Shifat 5:58 "Stone reflection, underwater refraction, ambience can be better on water surface"):
// a crisper, brighter, Fresnel-led stone mirror + a soft contact reflection; the bed and the submerged stone bend
// further with the ripples and the swell, a dancing caustic net, depth blur/darkening; a calm white-sky gradient,
// a soft sun path, crest sparkle and a longer haze; the mid-distance swell bands damped; finer near ripples.
// R7.12 b8-surface-v4 (Shifat 6:28 "We can go better water surface. No?", 7:20 "cleaner. Bigger ripples waves"): a real
// photo bed (s09 pebbles, one textureLod, replaces the procedural bed), ~3.6x longer and softer photo waves, soft broad
// highlights instead of crest twinkle/glints, a larger softer net, depth tint; CPU-built mips (the warm-up upload left
// black mips); v3 extras cut on the low tiers for cost (contact pool HI only, fog/horizon pow removed, 2nd net layer ≤4 m)
export const WSURF_OLD = typeof location !== 'undefined' && /[?&]wsurf=old\b/.test(location.search)
// R7.12 b8-surface-v4 (found in the M02s sim): a photo texture uploaded early in the page's life came out with every mip
// level above 0 black (generateMipmap during the warm-up): the bed read black under textureLod, and the ripple map's
// mid-distance mips too (v1–v3's sim frames read black ripple/net texels past ~1 texel per pixel). The mip chain is now
// built on the CPU at load (2x box halving on a canvas, ~1 ms) and uploaded explicitly, so no generateMipmap is involved
function withMips(tx: THREE.Texture, on: { value: number }) {
  const img = tx.image as HTMLImageElement | undefined
  try {
    if (img && img.width > 0 && typeof document !== 'undefined') {
      const mips: HTMLCanvasElement[] = []
      let w = img.width, h = img.height, src: CanvasImageSource = img
      for (;;) {
        const c = document.createElement('canvas'); c.width = w; c.height = h
        const g = c.getContext('2d'); if (!g) throw new Error('no 2d')
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, w, h)
        mips.push(c); src = c
        if (w === 1 && h === 1) break
        w = Math.max(1, w >> 1); h = Math.max(1, h >> 1)
      }
      tx.mipmaps = mips as any; tx.generateMipmaps = false
    }
  } catch { /* fall back to three's generated mips */ }
  tx.needsUpdate = true; on.value = 1
}
const RIPN_URL = (((import.meta as any).env?.BASE_URL as string | undefined) ?? '/') + 'textures/water-ripple-n.jpg'
let ripN: THREE.Texture | null = null
function ripTex(on: { value: number }) {
  if (!ripN) {
    ripN = new THREE.TextureLoader().load(RIPN_URL, (tx) => withMips(tx, on))
    ripN.wrapS = ripN.wrapT = THREE.RepeatWrapping
    ripN.colorSpace = THREE.NoColorSpace
    ripN.generateMipmaps = true; ripN.minFilter = THREE.LinearMipmapLinearFilter; ripN.anisotropy = settings.TIER === 'high' ? 4 : 2   // b8-surface-v3 (Tester: PC weakgpu ×1.06 in v2, the 4x reads): 2 on the phone/weak tier; b8-surface-v2: grazing ripples stay sharp along the view instead of smearing flat (three clamps to the GPU's max)
  } else if (ripN.image) on.value = 1
  return ripN
}
// R7.12 b8-surface-v4 (Shifat 6:28 "We can go better water surface. No?"; root: the bed read as a grey light net, the refs
// r03/r08 show a real bed): the lake bed's albedo is a real photo of pebbles under shallow water — files/r711/refs/surface/
// s09 "Stones through the shallow water" (Wikimedia Commons, panoramio, CC BY-SA 3.0; the ref folder's pebble shot, same
// shore type as r07/r08 Sand Harbor): rows 335–700 de-foreshortened, illumination flattened, made seamless, green
// neutralised to a warm/cool grey; 512x256 (the 2:1 tile is world-square at 5.6 x 2.8 m: rounded stones ~20–50 cm), 53 KB JPEG
const BED_URL = (((import.meta as any).env?.BASE_URL as string | undefined) ?? '/') + 'textures/water-bed.jpg'
let bedT: THREE.Texture | null = null
function bedTex(on: { value: number }) {
  if (!bedT) {
    bedT = new THREE.TextureLoader().load(BED_URL, (tx) => withMips(tx, on))
    bedT.wrapS = bedT.wrapT = THREE.RepeatWrapping
    bedT.colorSpace = THREE.NoColorSpace   // read as the albedo multiplier the old procedural bed used (linear-ish, palette-matched)
    bedT.generateMipmaps = true; bedT.minFilter = THREE.LinearMipmapLinearFilter
  } else if (bedT.image) on.value = 1
  return bedT
}
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
    u_gemReflK: { value: 0.8 },                                        // extra gem-reflection weight above Fresnel (tried 0.32/0.55 on 10-20: reads as a flat disc, off)
    u_bedDepth: { value: 1.6 },
    u_absorb: { value: new THREE.Vector3(0.11, 0.1, 0.1) },     // σ_a per metre (WATER LANE: clear water, red first, kept near-neutral for the B/W palette)
    u_sigS: { value: new THREE.Vector3(0.095, 0.1, 0.105) },      // σ_s per metre (single scattering; the veil greys/cools with thickness)
    u_cauRipple: { value: 1 },                                     // gain of the sim's lensing on the bed (ripple caustics)
    u_refrK: { value: 1 },                                         // screen-space refraction strength of the submerged stone
    u_scatter: { value: new THREE.Color('#d5e3ec') },                // in-scatter colour: a pastel teal (shallow) that deepens with path length
    u_bedColor: { value: new THREE.Color('#e8e9ea') },   // W19 (Tab 17:38Z): neutral pale bed (B/W/silver palette)               // pale warm sand (foreground warm, depth cool)
    u_cau: { value: 1 },
    u_gem: { value: new THREE.Vector4(0, 0.5, 0, 0) },               // xyz diamond centre, w = caustic strength
    u_gemTint: { value: new THREE.Color('#2f63ff') },
    u_touch: { value: 0 },                                           // 0..1 how deep the stone's tip is in the water (meniscus)
    u_lipSoft: { value: 1 },                                          // R7.10 PATCHER: the low tiers' soft meniscus lip (0 = build 7, QA)
    u_glint: { value: 1 },
    u_ripOn: { value: 0 },   // R7.12 b8-surface-v1: 1 once the photo ripple map has loaded
    u_ripN: { value: null as THREE.Texture | null },
    u_bedOn: { value: 0 },   // R7.12 b8-surface-v4: 1 once the photo bed has loaded
    u_bedTex: { value: null as THREE.Texture | null },
    u_dbg: { value: 0 },
    u_underTex: { value: null as THREE.Texture | null },          // the submerged stone (screen space), for refraction
    u_underOn: { value: 0 },
    u_resolution: hi ? shared.u_resolution : { value: new THREE.Vector2(1, 1) },   // LAKERES: phones set it per draw (HeroStage: the low-res target's size in the lake pass, the scene's otherwise)                                           // stochastic sun glints
    u_fogNear: { value: 7 }, u_fogFar: { value: 26 },
    u_rLow: { value: 0 },   // R7.11 b6 (Shifat, real M02s: crisp floor -> milky water on scroll): 0 at the hero lens .. 1 at the low, level lens (HeroStage, main camera only)
    u_wlClip: { value: -1 },   // W18-DIVE OVER-UNDER (set per draw by HeroStage: main camera only)
    // LAKERES (Shifat 16:02 PT 'water surface pixel resolution can be turned down a bit … feels slow in phone'): phones only.
    // HeroStage draws the full lake shader into a ~0.65x target first; the main camera's draw of the SAME mesh (same vertex
    // shader, so the depth is full-res and exact: the stone's edge and the meniscus line stay crisp) then only reads it back.
    ...(hi ? {} : { u_lakeTex: { value: null as THREE.Texture | null }, u_lakeComp: { value: 0 }, u_lakeHalf: { value: new THREE.Vector2(0, 0) } }),
  }
  if (!WSURF_OLD) uniforms.u_ripN.value = ripTex(uniforms.u_ripOn)
  if (!WSURF_OLD) uniforms.u_bedTex.value = bedTex(uniforms.u_bedOn)
  if (/[?&]qa\b/.test(location.search)) ((window as any).__wus ??= []).push(uniforms)   // R7.10 PATCHER QA: lip A/B
  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: { WSURF: WSURF_OLD ? 0 : 1, HI: hi ? 1 : 0, WSIN: /[?&]whash\b/.test(location.search) ? 0 : 1, WAB: parseInt(new URLSearchParams(location.search).get('wab') || '0') | 0, RX5: /[?&]rx3\b/.test(location.search) ? 0 : 1, RXW: (parseFloat(new URLSearchParams(location.search).get('rxw') || '') || 2.2).toFixed(3), RSV: (parseFloat(new URLSearchParams(location.search).get('rsv') || '') || 0.004).toFixed(5) },   // R7.10 b5: ?wsin = the sine hash
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
      uniform float u_bedDepth, u_cauRipple, u_refrK; uniform vec3 u_absorb, u_sigS; uniform vec3 u_scatter; uniform vec3 u_bedColor;
      uniform vec4 u_gem; uniform vec3 u_gemTint; uniform float u_touch, u_lipSoft, u_glint, u_dbg, u_underOn, u_cau;
      #if WSURF
      uniform sampler2D u_ripN; uniform float u_ripOn; uniform sampler2D u_bedTex; uniform float u_bedOn;
      uniform highp mat4 projectionMatrix;   // b8-surface-v3: the analytic pixel footprint
      #endif
      uniform sampler2D u_underTex; uniform vec2 u_resolution; uniform float u_fogNear, u_fogFar, u_rLow;
      uniform float u_wlClip;   // W18-DIVE OVER-UNDER: -1 off, else the lens waterline (screen y); the lake draws above it only
${hi ? '' : '      uniform sampler2D u_lakeTex; uniform float u_lakeComp; uniform vec2 u_lakeHalf;   // LAKERES (phones); W29: half a low-res texel, the read-back UV inset\n'}      ${WL_EDGE}
      varying vec3 v_world; varying vec2 v_ruv; varying float v_rmask; varying vec4 v_refl;

      // ---- height gradient: swells (analytic derivative) -------------------------------------
      // Each wave: amplitude a, direction d, wavenumber k; deep-water dispersion ω = √(g k), slowed a touch
      // for a calm-lake read. Gradient only (normals); heights are tiny.
      vec2 wave(vec2 p, vec2 d, float k, float a, float ph){
        float w = sqrt(9.81 * k) * 0.55;
        float c = cos(dot(p, d) * k - u_time * w + ph);
        return d * (a * k * c);
      }
      vec2 swellGrad(vec2 p, float far){
        vec2 g = vec2(0.0);
        g += wave(p, vec2(0.83, 0.55), 0.92, 0.016, 0.0);
        g += wave(p, vec2(-0.42, 0.91), 1.55, 0.010, 1.7);
        #if WSURF
        // R7.12 b8-surface-v3 (4–6 %: faint horizontal swell bands mid-distance): seen at grazing angles the long-crested
        // 2.9–7.4 /m swells tilt whole rows of the reflected horizon band at once, which prints as stripes across the lake;
        // they ease off with distance (the photo ripples carry the texture there) and the longest two calm a little
        g *= (1.0 - 0.35 * far) * 1.15;   // b8-surface-v4 (Shifat 7:20 "bigger waves"): the long swells a touch taller
        float hiK = (1.0 - 0.8 * far) * 0.5;   // b8-surface-v4: the short 2.9–7.4 /m swells halved (cleaner)
        #else
        const float hiK = 1.0;
        #endif
        g += wave(p, vec2(0.97, -0.24), 2.9, 0.0045, 4.1) * hiK;
        g += wave(p, vec2(0.2, 0.98), 4.6, 0.0026, 2.3) * hiK;
        g += wave(p, vec2(-0.88, 0.47), 7.4, 0.0013, 5.9) * hiK;
        return g * u_swell;
      }
      // ---- micro detail: gradient noise with analytic derivatives (fresh implementation) ------
      // R7.10 b5 (Shifat: "possible fastest performance"): a sine-free lattice hash (Hoskins' hash22: three fracts and two
      // dots, no transcendental) in place of fract(sin(x) * 43758): same statistics (uniform, decorrelated), a different
      // random instance of the same chop / sand / caustic network. Measured ~3 % of the lake (sim, noise-level): OFF by default,
      // ?whash = on. ?wab=<bits> = QA ablation (1 caustics, 2 sand, 4 stone mirror, 8 glints, 16 chop, 32 sky)
      #if WSIN
      vec2 hash22(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
      #else
      vec2 hash22(vec2 p){ vec3 p3 = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
      #endif
      vec2 hash2(vec2 p){ return -1.0 + 2.0 * hash22(p); }
      vec3 gnoise(vec2 p){ // value, d/dx, d/dy
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0), du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
        vec2 ga = hash2(i), gb = hash2(i + vec2(1, 0)), gc = hash2(i + vec2(0, 1)), gd = hash2(i + vec2(1, 1));
        float va = dot(ga, f), vb = dot(gb, f - vec2(1, 0)), vc = dot(gc, f - vec2(0, 1)), vd = dot(gd, f - vec2(1, 1));
        return vec3(va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd),
          ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va));
      }
      // ---- WATER LANE helpers ---------------------------------------------------------------------
      #if HI
        const float GWCAP = 0.62;
      #else
        const float GWCAP = 0.5;   // phones: the stone's mirror image stays a hint (review P2)
      #endif
      // octave anti-aliasing: 1 while the octave's lattice is well above the pixel footprint, 0 near Nyquist
      float octAA(float fp, float freq){ return 1.0 - smoothstep(0.12, 0.42, fp * freq); }
      // the sim's Laplacian (texel units) at uv, s texels apart
      float rLap(vec2 uv, float s){
        vec2 tx = u_rippleTexel * s;
        return texture2D(u_rippleTexture, uv + vec2(tx.x, 0.0)).r + texture2D(u_rippleTexture, uv - vec2(tx.x, 0.0)).r
             + texture2D(u_rippleTexture, uv + vec2(0.0, tx.y)).r + texture2D(u_rippleTexture, uv - vec2(0.0, tx.y)).r
             - 4.0 * texture2D(u_rippleTexture, uv).r;
      }
      // the lake bed, so refraction has something to bend: long-crested sand ripples (warped), a fine grain, and
      // scattered rounded pebbles in soft silver greys with a contact shadow. One cell lookup per pebble layer: each
      // pebble sits inside its own 0.42 m cell (centre jitter 0.3–0.7, radius ≤ 0.26), so no neighbour search.
      // w = footprint on the bed (m), for edge softening.
      vec3 bedAlbedo(vec2 p, float w, float pf){
        // PERF (water-perf): an octave whose weight is exactly 0 at this footprint is not evaluated (x * 0 adds nothing,
        // so the pixel is bit-identical); far bed pixels skip 3–4 of the 5 noise calls
        float kRip = 1.0 - smoothstep(0.1, 0.3, w * 1.6), kGrain = 1.0 - smoothstep(0.03, 0.1, w);
        float rip = 0.0;
        if (kRip > 0.0) {
          vec2 q = p + 0.4 * vec2(gnoise(p * 0.45).x, gnoise(p * 0.45 + 7.3).x);
          rip = sin(dot(q, vec2(0.55, -0.83)) * 10.0 + 1.6 * gnoise(q * 0.9).x);
        }
        float s = 0.91 + 0.05 * rip * kRip + 0.05 * gnoise(p * 2.7).x
                + (kGrain > 0.0 ? 0.03 * gnoise(p * 9.0).x * kGrain : 0.0);
        vec3 c = u_bedColor * s;
        if (pf <= 0.0) return c;
        // stones, not droplets (review P1): darker than or equal to the sand, matte (a faint top light only), a soft
        // shadow on the side away from the sun, sparse and varied in size, fading out with distance (pf)
        vec2 cs = p / 0.42, ci = floor(cs);
        vec2 hh = fract(sin(vec2(dot(ci, vec2(12.9898, 78.233)), dot(ci, vec2(39.35, 11.13)))) * 43758.5453);
        float h3 = fract(sin(dot(ci, vec2(93.9, 67.3))) * 15731.7);
        vec2 dc = fract(cs) - (0.3 + 0.4 * hh);
        float an = h3 * 6.2831; mat2 rot = mat2(cos(an), -sin(an), sin(an), cos(an));
        vec2 d = rot * dc; d.x *= 0.8 + 0.45 * hh.x;
        float rad = 0.06 + 0.2 * hh.y * hh.y;
        float dl = length(d) - rad;
        float present = step(0.84, h3) * pf;
        float ew = max(w / 0.42, 0.012);
        float m = (1.0 - smoothstep(-ew, ew, dl)) * present;
        vec2 so = (rot * (dc + normalize(u_sunDir.xz + 1e-4) * rad * 0.35)); so.x *= 0.8 + 0.45 * hh.x;
        float sh = (1.0 - smoothstep(-0.02, 0.07, length(so) - rad)) * present;
        vec3 pc = u_bedColor * mix(0.74, 0.93, fract(h3 * 7.13)) * (0.94 + 0.06 * sqrt(max(0.0, 1.0 - pow(length(d) / rad, 2.0))))
                #if WSURF
                * (0.95 + 0.05 * gnoise(p * 31.0 + h3 * 9.0).x * (1.0 - smoothstep(0.15, 0.4, w * 31.0)));   // R7.12 b8-surface-v2: AA'd (aliased to grain on the phone's reduced lake target)
                #else
                * (0.95 + 0.05 * gnoise(p * 31.0 + h3 * 9.0).x);
                #endif   // close to the sand's value, mottled: stones, not holes
        c *= 1.0 - sh * (1.0 - m) * 0.08;
        return mix(c, pc, m);
      }
      // ---- caustics: two drifting ridged-cell layers multiplied (bright thin network, fresh) ---
      float cells(vec2 p, float t){
        vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          vec2 o = vec2(x, y);
          #if WSIN
          vec2 h = 0.5 + 0.5 * sin(t + 6.2831 * fract(sin(vec2(dot(i + o, vec2(41.3, 289.1)), dot(i + o, vec2(173.9, 61.7)))) * 7341.3));
          #else
          vec2 h = 0.5 + 0.5 * sin(t + 6.2831 * hash22(i + o + 17.0));
          #endif
          float d = length(o + h - f);
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
        }
        return d2 - d1;
      }
      float caustic(vec2 p, float t){
        // WATER LANE: domain-warped so the network reads as focused light, not Voronoi tiles; softer filaments
        p += 0.4 * vec2(gnoise(p * 0.35 + t * 0.06).x, gnoise(p * 0.35 + 5.2 - t * 0.05).x);
        #if HI
          float a = 1.0 - smoothstep(0.0, 0.26, cells(p * 1.15, t * 0.55));
          float b = 1.0 - smoothstep(0.0, 0.3, cells(p * 1.9 + 3.1, -t * 0.42));
          return a * a * 0.6 + a * b * 1.1 + 0.12;
        #else
          // phones: one layer, but soft-edged and modulated so it reads as focused light, not cracked tiles
          float s = 1.0 - smoothstep(0.0, 0.3, cells(p * 1.15, t * 0.55));
          return s * s * (0.5 + 0.4 * sin(p.x * 0.7 + p.y * 0.5 + t)) + 0.2;   // WATER LANE: softer on phones
        #endif
      }

      void main(){
        if (u_wlClip > -0.5 && gl_FragCoord.y < (u_wlClip + wlEdge(gl_FragCoord.x / u_resolution.y, u_time)) * u_resolution.y) discard;   // W18-DIVE OVER-UNDER
${hi ? '' : `        if (u_lakeComp > 0.5) {   // LAKERES: main-camera draw on phones = read back the low-res lake (alpha-normalised, so the lake's own edge never pulls in the cleared texels)
          vec4 lk = texture2D(u_lakeTex, clamp(gl_FragCoord.xy / u_resolution, u_lakeHalf, 1.0 - u_lakeHalf));
          // W29 R6.72 (Shifat: 'black lines at the end of the water surface'): the far lake is sub-texel slivers under the
          // horizon that the 0.65x pass can miss; where the low-res coverage is under half this pixel shades in full instead
          if (lk.a > 0.5) {
            gl_FragColor = vec4(lk.rgb / lk.a, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            return;
          }
        }
`}        vec3 V = normalize(cameraPosition - v_world);
        float dist = length(cameraPosition - v_world);
        // ---- normal ----
        // WATER LANE: derivative-aware detail. fp = the pixel's footprint on the water in metres; each octave fades as
        // its wavelength approaches two pixels (no shimmer at grazing angles), and the sim's ripples fade once a pixel
        // spans its texels. The old fixed distance fade stays only as a far backstop.
        #if WSURF
        // R7.12 b8-surface-v3 (Tester, v2 3x crop: stair-stepped square edges in the light net): fwidth() is one value per
        // 2x2 quad, so every footprint-driven fade (ripple octaves, net contrast, bed blur) stepped in quads, which the
        // 0.65x lake target upscaled into ~3 px blocks. The footprint of a level water plane is analytic and smooth per
        // pixel: across = dist·θ, along the view = dist·θ/|V.y| (θ = one pixel's angle). Cheaper than fwidth, too
        float pxA = 2.0 / (projectionMatrix[1][1] * u_resolution.y);
        float fp = max(dist * pxA * sqrt(1.0 + 1.0 / max(V.y * V.y, 0.0025)), 1e-4);
        #else
        float fp = max(length(fwidth(v_world.xz)), 1e-4);
        #endif
        // PERF (water-perf, Shifat "heavy & wide for phone"): past u_fogFar the aerial-perspective fog is exactly 1, so the
        // lake's final colour there is exactly u_skyHorizon whatever the optics computed. Most of the 500 m plane's
        // triangles sit out there as thin slivers under the horizon; they now cost one colour instead of the full shader
        if (gl_FrontFacing && dist >= u_fogFar) {
          gl_FragColor = vec4(u_skyHorizon, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          return;
        }
        vec2 g = swellGrad(v_world.xz, smoothstep(3.5, 12.0, dist));
        vec2 gSw = g;   // R7.12 b8-surface-v3: the smooth swell alone (sun path, slow bed wobble)
        vec2 rg = vec2(0.0); float rlap = 0.0;
        float cellM = 2.0 * u_poolSize * u_rippleTexel.x;                  // central-difference span of the sim (m)
        // R7.11 b6 (Shifat's real M02s: "crisp floor ... then it changes to lighter water" on scroll; emulation never showed it):
        // on a phone the finger that scrolls the page also paints the lake (waterInput). Seen from the hero's high lens those
        // rings bend the floor a little; as the scroll lowers and levels the lens, the same rings tilt the surface toward
        // grazing, where Fresnel and the glints are steep, so the agitated lake mirrored the pale sky and sparkled: the milky
        // veil, the cells gone. The rings' optical weight now eases down with the lens (x1 at the hero = b5, bit-identical;
        // x0.25 at the low lens), so the descent keeps the hero's crisp cell floor. Free: one multiply.
        float rAA = (1.0 - smoothstep(0.6, 1.8, fp / cellM)) * (1.0 - 0.75 * u_rLow);
        if (v_rmask > 0.0 && rAA > 0.0) {
          float hx = texture2D(u_rippleTexture, v_ruv + vec2(u_rippleTexel.x, 0.0)).r - texture2D(u_rippleTexture, v_ruv - vec2(u_rippleTexel.x, 0.0)).r;
          float hy = texture2D(u_rippleTexture, v_ruv + vec2(0.0, u_rippleTexel.y)).r - texture2D(u_rippleTexture, v_ruv - vec2(0.0, u_rippleTexel.y)).r;
          rg = vec2(hx, -hy) * u_rippleAmp * v_rmask * rAA / cellM;
          rlap = rLap(v_ruv, 1.0) * u_rippleAmp * v_rmask * rAA;
          g += rg;
        }
        float detailFade = 1.0 - smoothstep(14.0, 40.0, dist);
        vec2 gTex = vec2(0.0);   // R7.12 b8-surface-v2: the photo ripple's own slope (the stone mirror takes less of it)
        #if WSURF
        vec2 wind = vec2(0.32, 0.11) * u_time * (u_ripOn > 0.5 ? 0.75 : 1.0);   // b8-surface-v3: softer, slower drift
        #else
        vec2 wind = vec2(0.32, 0.11) * u_time;
        #endif
        // cat's paws: wind gusts drift across the lake, so the fine chop comes and goes in soft patches (calm glassy
        // lanes beside rougher ones) instead of one uniform texture: the cue that sells real water at a glance
        // PERF (water-perf): the chop's weight (detailFade × octAA, and the finer octaves fade before the coarse one) is
        // exactly 0 where a pixel spans its wavelength: skip the noise there (adding x * 0 changes nothing)
        #if WSURF
        const float CHOPF = 1.9;   // b8-surface-v4: the gate follows the bigger photo waves' own fade (no step where k1 > 0)
        #else
        const float CHOPF = 2.1;
        #endif
        if (detailFade * octAA(fp, CHOPF) > 0.0 && (WAB & 16) == 0) {
        float gust = 0.5 + 0.5 * gnoise(v_world.xz * 0.16 + vec2(u_time * 0.05, -u_time * 0.02)).x;
        float gustK = mix(0.45, 1.5, smoothstep(0.25, 0.8, gust));
        #if WSURF
        if (u_ripOn > 0.5) {
          // R7.12 b8-surface-v1: two scales of the photo's own ripple slope (s00), the second turned 90° and drifting
          // the other way so the tile never repeats visibly; mipmapped, so far ripples blur instead of shimmering
          // b8-surface-v3: ~1.35x finer near the lens (refs r03/r08), drifting ~25 % slower (calm), faded at the new scale
          // R7.12 b8-surface-v4 (Shifat 7:20 "The water surface need to be cleaner. Bigger ripples waves"): the photo ripples
          // ~3.6x longer (0.325 → 0.09 /m, 0.74 → 0.2 /m), read one mip softer (bias 1.2: the photo's fine crinkle is gone,
          // the waves are broad and rounded), drifting slowly; the second layer is weaker (fewer, larger waves). Faded at
          // their new, larger scale (they hold further out: big waves are visible further)
          float k1 = detailFade * gustK * octAA(fp, 1.9), k2 = detailFade * gustK * octAA(fp, 4.0);
          // PERF (b8-surface-v3): a read whose weight is exactly 0 is skipped (bit-identical): the fine one past ~14 px/m
          if (k1 > 0.0) { const mat2 R1 = mat2(0.9703, -0.2419, 0.2419, 0.9703); gTex = ((texture2D(u_ripN, R1 * v_world.xz * 0.09 + wind * 0.055, 1.2).rg * 2.0 - 1.0) * R1) * 0.125 * k1; }   // 14°: off the world grid
          // b8-surface-v3 (Tester: a square grid at 4 %): the second layer turned 61° (v2: exactly 90°, which kept both layers
          // on the tile's axes and printed its repeat as a grid); its slope is turned back into world axes (v·R = Rᵀv)
          if (k2 > 0.0) { const mat2 R2 = mat2(0.4848, -0.8746, 0.8746, 0.4848); vec2 t2 = texture2D(u_ripN, R2 * v_world.xz * 0.2 - wind * 0.1 + 0.37, 1.2).rg * 2.0 - 1.0; gTex += (t2 * R2) * 0.035 * k2; }
          g += gTex;
        }
        #else
        // b8-surface-v4 (cost): the procedural chop is the ?wsurf=old lake only; the photo lake compiles without it (on the
        // low tiers the sim pays for every instruction in the program, taken branch or not)
        vec3 n1 = gnoise(v_world.xz * 2.1 + wind);
        g += n1.yz * 0.05 * detailFade * gustK * octAA(fp, 2.1);
        #if HI
          vec3 n2 = gnoise(v_world.xz * 5.3 - wind * 1.7 + 9.0);
          g += n2.yz * 0.012 * detailFade * gustK * octAA(fp, 5.3);
          vec3 n3 = gnoise(v_world.xz * 13.0 + wind * 2.6 - 4.0);
          g += n3.yz * 0.005 * detailFade * gustK * octAA(fp, 13.0);
        #endif
        #endif
        }
        vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 col;
        vec4 gemR = vec4(0.0);
        if (gl_FrontFacing) {
          float NoV = max(dot(N, V), 0.0);
          float F = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);              // Schlick, IOR 1.333
          vec3 R = reflect(-V, N); R.y = abs(R.y);
          vec3 refl = (WAB & 32) != 0 ? u_skyMid : skyColor(R, 0.0);
          // two long dark flags overhead (a product studio's ceiling): steep views reflect the ceiling, where the
          // analytic sky is a flat zenith; the swell and the gusting chop bend their soft edges into moving light
          // lines, which is what lets a high-key lake read as water. Low contrast, so the field stays airy
          {
            vec2 cp = v_world.xz + R.xz / max(R.y, 0.08) * 6.0;
            vec2 q = vec2(cp.x * 0.83 + cp.y * 0.55, -cp.x * 0.55 + cp.y * 0.83);
            float s1 = smoothstep(0.9, 0.35, abs(q.x - 3.4)), s2 = smoothstep(0.7, 0.25, abs(q.x + 4.6));
            float strip = max(s1, s2 * 0.8) * smoothstep(9.0, 3.0, abs(q.y));
            refl = mix(refl, refl * vec3(0.8, 0.85, 0.93), strip * 0.7);   // cool dark flags (background darker & cooler)
          }
          #if WSURF
          if (u_ripOn > 0.5) {
            // R7.12 b8-surface-v2 (refs s02/s05/s07: at grazing angles a lake mirrors a darker far shore under a brighter
            // sky, so every ripple's tilt swaps the two and the ripple shape reads far away): a soft cool-grey horizon band
            // in the reflected sky (low R.y), and a gentle brighter step above it; neutral white-grey, ≤ −7 %
            // b8-surface-v3 (ambience): a wider, gentler band (−4.5 %, σ 0.09: its slope in R.y is ~half v2's, so the swell no
            // longer prints it as stripes at 4–6 %) and a long soft white gradient up to the zenith — calm, still pure white
            float hbx = (R.y - 0.05) / 0.09; float hb = exp(-hbx * hbx);   // b8-surface-v4: x·x, not pow (cost)
            refl *= mix(1.0, 0.955, hb) * (0.965 + 0.05 * smoothstep(0.03, 0.55, R.y));   // neutral (Shifat 5:38: "our sky is pure white peaceful color. Water reflects it")
          }
          #endif
          // planar reflection of the diamond, wobbled by the surface normal
          if (u_reflOn > 0.5 && (WAB & 4) == 0) {
            // ripples wobble it (more across than along: water breaks a reflection into horizontal bands), and a short
            // vertical smear of taps stretches it the way a slightly moving surface does
            #if WSURF
            // R7.12 b8-surface-v3 (Shifat 5:58 "Stone reflection"): the mirror takes the slow swell in full (a gentle waver)
            // but only a fifth of the fine photo chop (v2: 70 %), so the stone stays readable, distorted, not shredded
            vec2 Nm = normalize(vec3(-(g.x - 0.8 * gTex.x), 1.0, -(g.y - 0.8 * gTex.y))).xz;
            vec4 ruv = v_refl; ruv.xy += Nm * vec2(0.1, 0.26) * ruv.w;
            #else
            vec4 ruv = v_refl; ruv.xy += N.xz * vec2(0.1, 0.26) * ruv.w;
            #endif
            // water breaks a near reflection into horizontal bands that slide sideways: a band-limited wobble across
            // (x) that varies along the view depth (z), growing away from the waterline
            if (octAA(fp, 6.0) > 0.0) {   // PERF (water-perf): the band wobble's weight is exactly 0 past ~2 px bands: skip its 2 noises + 1 tap
            #if HI || !RX5
            float band = gnoise(vec2(v_world.x * 2.0, v_world.z * 22.0 - u_time * 1.1)).x + 0.5 * gnoise(vec2(v_world.x * 4.0 + 7.0, v_world.z * 41.0 + u_time * 1.6)).x;
            #else
            // R7.10 b6: the 41/m octave shifted rows only a few pixels tall, which the sharp mirror turned into a ragged staircase
            // along the reflection's edge; the low tiers keep the slow 22/m bands (one noise instead of two)
            float band = 0.8 * gnoise(vec2(v_world.x * 2.0, v_world.z * 22.0 - u_time * 1.1)).x;
            #endif
            float away = clamp(length(v_world.xz - u_gem.xz) * 1.6, 0.25, 1.0);
            // W25 R6.48 (scorer-r642 #3: a spike at each tip of the dive's mirror lobe): the band wobble shifts whole rows sideways,
            // so at the mirror's outline a row could pull the stone's colour out past its edge as a thin horizontal spike. The wobble
            // now follows the mirror's own (unwobbled) coverage: full inside the reflected stone, a quarter at and outside its edge
            float rcov = texture2DProj(u_reflTex, ruv).a;
            ruv.x += band * 0.0035 * away * ruv.w * octAA(fp, 6.0) * mix(0.25, 1.0, smoothstep(0.2, 0.8, rcov));   // WATER LANE: gentler bands (0.0075 read as a jagged mosaic)
            }
            // R7.10 b6 (QA on M02s: the now-sharp mirror read as stair-stepped edges / detached shards): water smears a reflection
            // along the view, more the farther the reflected point is from where the stone meets the water; the smear now grows
            // from the contact out (riptide v2 got its softness from a 20x45 mirror instead). ?rsv=<base> (b5: 0.0008, flat)
            vec2 sv = vec2(0.0, RSV) * (1.0 + 4.0 * length(rg)) * mix(0.5, 1.5, smoothstep(0.1, 1.2, length(v_world.xz - u_gem.xz)));
            #if WSURF
            sv *= 0.72;   // b8-surface-v3: a crisper mirror (the 5-tap X keeps its edges soft, no steps)
            #endif
            #if HI
            vec4 pr = texture2DProj(u_reflTex, ruv) * 0.28;
            pr += (texture2DProj(u_reflTex, ruv + vec4(sv, 0.0, 0.0) * ruv.w) + texture2DProj(u_reflTex, ruv - vec4(sv, 0.0, 0.0) * ruv.w)) * 0.22;
            pr += (texture2DProj(u_reflTex, ruv + vec4(sv * 2.6, 0.0, 0.0) * ruv.w) + texture2DProj(u_reflTex, ruv - vec4(sv * 2.6, 0.0, 0.0) * ruv.w)) * 0.14;
            #else
            // WATERRES (Shifat 23:06Z 'just use reduced quality reflection'): phones smear with 3 taps (was 5), same span
            #if RX5
            // R7.10 b6 (QA: "ragged stair-stepped shards", v2 = one soft blob): five taps, the centre and an X of four, the X's
            // arms as wide across as along (in pixels), so the mirror's 2x-magnified edges read as a soft shape, never as steps
            vec2 sx = vec2(sv.y * RXW * u_resolution.y / max(u_resolution.x, 1.0), sv.y * 1.6);
            vec4 pr = texture2DProj(u_reflTex, ruv) * 0.32;
            pr += (texture2DProj(u_reflTex, ruv + vec4(sx, 0.0, 0.0) * ruv.w) + texture2DProj(u_reflTex, ruv - vec4(sx, 0.0, 0.0) * ruv.w)) * 0.17;
            pr += (texture2DProj(u_reflTex, ruv + vec4(sx.x, -sx.y, 0.0, 0.0) * ruv.w) + texture2DProj(u_reflTex, ruv + vec4(-sx.x, sx.y, 0.0, 0.0) * ruv.w)) * 0.17;
            #else
            vec4 pr = texture2DProj(u_reflTex, ruv) * 0.4;
            pr += (texture2DProj(u_reflTex, ruv + vec4(sv * 1.6, 0.0, 0.0) * ruv.w) + texture2DProj(u_reflTex, ruv - vec4(sv * 1.6, 0.0, 0.0) * ruv.w)) * 0.3;
            #endif
            #endif
            gemR = vec4(pr.rgb / max(pr.a, 1e-3), pr.a);
          }
          // ---- REFRACTION (WATER LANE; Shifat 16:22Z "Refraction too") ------------------------------------
          // Snell through the full wave + ripple normal (η = 1/1.333) down to a textured bed (sand ripples, pebbles),
          // so every swell and every trail visibly bends what lies beneath, in a still frame. Sunlight reaches the
          // bed through the same surface: a caustic network plus true focusing by the live ripple sim (a trail is
          // drawn on the bed in light), with red/blue focusing apart (dispersion). Beer–Lambert over the path tints
          // by thickness; single scattering adds the veil (σs/σt·(1−e^(−σt·L)), so it greys/cools, never milks).
          float underA = 0.0;   // how much of this pixel is the submerged stone (its reflection yields there)
          vec3 T = refract(-V, N, 1.0 / 1.333);
          T.y = min(T.y, -0.05);   // grazing views (fixed near-horizontal lens): a back-tilted facet never refracts upward
          float depthHere = u_bedDepth + smoothstep(3.0, 20.0, length(v_world.xz - cameraPosition.xz)) * 2.0; // shelves away from the viewer
          float tb = (depthHere + v_world.y) / max(-T.y, 0.05);
          vec3 bed = v_world + T * tb;
          #if WSURF
          // R7.12 b8-surface-v2 (refs s07/s09: the bed visibly wobbles under the ripples): the true Snell shift at this
          // depth is a few mm, too small to read on a phone; the photo ripple's slope bends the bed ~2.5x further
          // b8-surface-v3 (Shifat 5:58 "underwater refraction"; r03/r08: the floor visibly bends, offsets and wobbles): the
          // photo ripple bends it ~1.6x further, and the slow swell slides it as a whole (a gentle wobble; low frequency, so
          // it never aliases); both fade with distance where the bed is under the Fresnel sheen anyway
          bed.xz += (gTex * 1.15 * (1.0 - smoothstep(0.02, 0.06, fp)) + (gSw + rg) * 2.2) * depthHere * (1.0 - smoothstep(3.0, 9.0, dist));
          #endif
          vec3 Ls = refract(-u_sunDir, vec3(0, 1, 0), 1.0 / 1.333);       // sunlight inside the water
          float ls = depthHere / max(-Ls.y, 0.1);
          vec2 cp = bed.xz + N.xz * depthHere * 0.35;                      // the local normal shears the network
          #if WSURF
          cp += gSw * depthHere * 3.0;   // b8-surface-v3: the swell overhead focuses and slides the net (it dances, not drifts)
          #endif
          // PERF (water-perf): the caustic network's only visible use is cauFade × (cau − 0.32); past 8 m cauFade is exactly 0,
          // so the 9-cell search + domain warp is skipped there (the pixel is bit-identical)
          #if WSURF
          // PERF (b8-surface-v3): the photo net fades out nearer (1.5–6 m, smooth: no seam) so its 2 reads stop sooner
          float cauFade = (1.0 - (u_ripOn > 0.5 ? smoothstep(1.5, 6.0, dist) : smoothstep(2.0, 8.0, dist))) * u_cau;
          #else
          float cauFade = (1.0 - smoothstep(2.0, 8.0, dist)) * u_cau;    // shallow-bed caustics through clear water
          #endif
          float cau = 0.32;
          #if WSURF
          // R7.12 b8-surface-v1: the bed's light network is the photo's own caustic filaments (s00, B channel), two drifting
          // layers combined like real overlapping lenses: 2 texture reads instead of the 9-cell search + warp
          if (cauFade > 0.0 && (WAB & 1) == 0 && u_ripOn > 0.5) {
            // b8-surface-v3 (Tester: the net formed a regular square grid at 4 %, "paving"): the two layers sat at 0° and 90°
            // on the same tile axes, so their repeats lined up into squares. Now 23° and −41°, scales 0.30 / 0.47 (an
            // irrational-ish ratio): the repeats never align; livelier drift (v2 0.015/0.009)
            const mat2 C1 = mat2(0.9205, -0.3907, 0.3907, 0.9205), C2 = mat2(0.7547, 0.6561, -0.6561, 0.7547);
            float c1 = texture2D(u_ripN, C1 * cp * 0.14 + vec2(0.011, 0.0065) * u_time, 1.0).b;   // b8-surface-v4 (Shifat 7:20 cleaner): a larger, softer, slower net
            // b8-surface-v4 (cost, root 6:36): the second layer only near the lens (≤4 m); beyond, the net is one layer
            // (c2 → c1 makes sqrt(c1·c2) = c1: the same brightness, a smooth hand-over, no seam)
            float k2c = 1.0 - smoothstep(2.5, 4.0, dist);
            float c2 = c1;
            if (k2c > 0.0) c2 = mix(c1, texture2D(u_ripN, C2 * cp * 0.22 - vec2(0.009, 0.0125) * u_time + 0.5, 1.0).b, k2c);
            cau = 0.16 + 2.0 * sqrt(c1 * c2) + 0.4 * max(c1, c2);
          }
          #else
          if (cauFade > 0.0 && (WAB & 1) == 0) cau = caustic(cp * 2.0, u_time * 0.7);   // ?wsurf=old only (b8-surface-v4: the photo lake compiles without the 9-cell search)
          #endif
          float focus = 1.0; vec3 focusC = vec3(1.0);
          {
            // where the sun ray that lands here crossed the surface, the sim's curvature acts as a lens: a crest
            // converges, a trough spreads (thin-lens: I ≈ 1 / (1 + d·κ·(1 − 1/n)))
            vec2 entry = bed.xz - Ls.xz * ls;
            vec2 euv = vec2(entry.x, -entry.y) / u_poolSize + 0.5;
            float em = smoothstep(0.0, 0.08, euv.x) * smoothstep(0.0, 0.08, euv.y) * smoothstep(1.0, 0.92, euv.x) * smoothstep(1.0, 0.92, euv.y);
            if (em > 0.0 && rAA > 0.0) {
              float kf = depthHere * 0.25 * u_rippleAmp * em * rAA * u_cauRipple * 4.0 / (cellM * cellM);
              float lc = rLap(euv, 1.0);
              focus = 1.0 / max(1.0 + lc * kf, 0.35);
              #if HI
                vec2 dd = (Ls.xz / max(-Ls.y, 0.1)) * depthHere * 0.02 / u_poolSize * vec2(1.0, -1.0);
                focusC = vec3(1.0 / max(1.0 + rLap(euv - dd, 1.0) * kf * 0.96, 0.35), focus, 1.0 / max(1.0 + rLap(euv + dd, 1.0) * kf * 1.06, 0.35)) / max(focus, 1e-3);
              #endif
            }
          }
          #if WSURF
          // b8-surface-v3 (depth): the bed softens with distance and depth (a wider footprint blurs pebbles and grain away)
          vec3 alb;
          float bedFar = smoothstep(2.0, 6.0, dist);   // b8-surface-v4: 0 near (the photo bed, sharp) .. 1 far (a soft mean bed under the sky mirror)
          if (u_bedOn > 0.5 && (WAB & 2) == 0) {
            // R7.12 b8-surface-v4: a REAL bed (photo pebbles + sand, s09), read where the refracted ray lands, so it bends
            // with the ripples and the swell like r03/r08, and the caustic light (sunOnBed) rides on top of it. ONE texture
            // read (root 6:36: v3 cost x1.13–1.15, v4 pays for the bed by cutting extras): it replaces the procedural
            // sand/pebble bed (3–4 noises with sine hashes + a pebble cell), so it is cheaper than v2/v3's bed. Anti-repeat
            // without a second read: the tile (31°, off the world grid) is domain-warped by two slow sines, and the same
            // sines open pale-sand patches between the stone fields like Sand Harbor. The mip level comes from the analytic
            // footprint (smooth per pixel: no 2x2-quad steps, no anisotropic reads), widened with distance and depth, so
            // the bed is crisp under the lens and goes soft farther out (v3's wider-blur footprint, as a LOD bias)
            float fb = fp * (1.0 + tb / max(dist, 0.1)) * (1.0 + 0.12 * dist + 0.2 * depthHere);
            vec3 bm = u_bedColor * 0.9;
            vec3 pb = bm;
            if (bedFar < 1.0) {
              const mat2 B1 = mat2(0.8572, -0.5150, 0.5150, 0.8572);
              vec2 bp = B1 * bed.xz;
              vec2 sw = sin(bp.yx * vec2(0.37, 0.29) + vec2(1.3, 4.1));
              vec3 tx = textureLod(u_bedTex, (bp + sw * 0.8) * vec2(1.0 / 5.6, 1.0 / 2.8), log2(max(fb * 91.0, 1e-3)) + 1.6).rgb;
              float sand = smoothstep(0.35, 0.95, sw.x * sw.y + 0.25 * sw.x);   // open sand between the stone fields
              tx = mix(tx, vec3(0.86, 0.855, 0.84) + 0.08 * (tx - 0.76), sand * 0.7);
              pb = u_bedColor * (0.78 + 0.22 * tx);   // Shifat 7:20 "cleaner": big soft stones at ~25 % of the photo's contrast, two mips softer: a quiet presence under clear water, never texture
            }
            alb = mix(pb, bm, bedFar);
          } else {
            alb = u_bedColor * 0.9;   // b8-surface-v4 (cost): until the photo bed loads (a few frames), the mean bed; the procedural bed is ?wsurf=old only
          }
          #else
          vec3 alb = (WAB & 2) != 0 ? u_bedColor : bedAlbedo(bed.xz, fp * (1.0 + tb / max(dist, 0.1)), 1.0 - smoothstep(3.0, 10.0, dist));
          #endif
          #if WSURF
          // R7.12 b8-surface-v1: the ref's bed reads by its bright filaments over a darker floor (s00 near rows: p5 ≈ 0.45x,
          // p95 ≈ 1.8x the mean), so the network carries more contrast; the floor itself is a touch darker and takes a
          // quarter of the ref's olive-grey hue (#5b673f) — the site's pale palette kept, the water no longer milk
          float cauL = u_ripOn > 0.5 ? 0.9 + cauFade * (1.0 - smoothstep(0.03, 0.09, fp)) * (cau - 0.32) * mix(0.5, 0.3, smoothstep(1.5, 6.0, dist)) : 0.84 + cauFade * (cau - 0.32) * 0.32;   // b8-surface-v3: crisper net near, softer with distance   // R7.12 b8-surface-v2: bright filaments over a darker floor (v1: 0.84, 0.72)
          #else
          float cauL = 0.9 + cauFade * (cau - 0.32) * 0.32;              // a soft network, not a pool-tile cliché
          #endif
          vec3 sunOnBed = u_sunColor * max(-Ls.y, 0.0) * cauL * focus * focusC * exp(-u_absorb * ls);
          vec3 amb = mix(u_skyMid, u_skyHorizon, 0.4) * 0.42 * exp(-u_absorb * depthHere);
          #if WSURF
          alb *= u_ripOn > 0.5 ? vec3(0.93, 0.96, 0.98) : vec3(0.93, 0.955, 0.89);   // R7.12 b8-surface-v2: blue-grey see-through floor (v1's olive quarter dropped)
          #endif
          vec3 bedCol = alb * (sunOnBed * 1.15 + amb);
          // the diamond focuses blue light into a soft, rippling caustic under itself
          // (its weight is 0.0: switched off; PERF water-perf removed the dead exp() it still cost per pixel)
          float L = tb;                                                    // path length through water
          vec3 Tr = exp(-u_absorb * L);
          vec3 sigT = u_absorb + u_sigS;
          vec3 inscatter = u_scatter * (u_sunColor * 0.7 + amb) * (u_sigS / sigT) * (1.0 - exp(-sigT * L));
          #if WSURF
          inscatter *= u_bedOn > 0.5 ? mix(0.5, 0.88, smoothstep(1.5, 9.0, dist)) : mix(0.66, 0.8, smoothstep(2.0, 9.0, dist));   // b8-surface-v4: clearer near, hazier with depth   // R7.12 b8-surface-v1/v2 (Shifat 5:04 "a bit transparent"): a thinner veil near the lens, the bed shows through (v1: 0.7 flat)
          #endif
          vec3 refr = bedCol * Tr + inscatter;
          #if WSURF
          // R7.12 b8-surface-v2 (Shifat 5:38: refs r03 Plitvice + r08 Tahoe; "our sky is pure white"): only the water over the
          // bed takes the refs' clear-water hue (r03 mid (102,173,179), r08 mid (58,147,176)) at ~25 %, near the lens; the
          // reflection stays our white sky, so with distance (Fresnel) the lake goes calm white
          // b8-surface-v3 (depth): the floor darkens a little with distance as the path through the water grows (Beer's
          // cool blue-grey, no milk), before Fresnel turns the far lake white
          if (u_bedOn > 0.5) {
            // b8-surface-v4 (depth & clarity, refs clear → reflective): glass-clear and true under the lens, then a gentle
            // blue-grey deepening with the path through the water (no milk), before Fresnel turns the far lake white
            refr *= mix(vec3(0.975, 0.99, 1.0), vec3(0.875, 0.92, 0.955), smoothstep(1.5, 8.5, dist));
          } else
          if (u_ripOn > 0.5) refr *= mix(vec3(0.94, 0.985, 1.0), vec3(1.0), smoothstep(3.0, 10.0, dist)) * mix(vec3(1.0), vec3(0.93, 0.955, 0.975), smoothstep(1.2, 6.5, dist));
          #endif
          // the stone where it is under the surface, seen THROUGH the water (screen-space refraction): the offset is
          // the refracted ray's lateral shift over the stone's depth, so a deeper stone and a steeper ripple bend it
          // more; the three channels refract apart (a fine fringe that widens on ripple crests); sunlight through the
          // waves plays over the submerged facets (caustics); absorption cools it with depth
          if (u_underOn > 0.5) {
            float gdp = max(0.0, -(u_gem.y - 0.25)) + 0.08;
            vec2 suv = gl_FragCoord.xy / u_resolution;
            // the ripple slope drives the bend (review P1: the swell alone barely moved it), clamped so it never tears
            #if WSURF
            vec2 off = (N.xz * vec2(0.035, 0.05) + gTex * 0.3 + gSw * 0.6 + rg * 0.25) * (0.7 + 2.2 * gdp) * u_refrK;   // b8-surface-v3: bends further along the ripples + wobbles with the swell (v2: 0.18)   // R7.12 b8-surface-v2: the submerged stone bends along the photo ripples
            #else
            vec2 off = (N.xz * vec2(0.035, 0.05) + rg * 0.25) * (0.7 + 2.2 * gdp) * u_refrK;
            #endif
            off *= min(1.0, 0.06 / max(length(off), 1e-4));
            // W24 R6.38 (scorer-r636 #3: spikes on the ghost's edge are the offset pushing samples past the outline): the bend
            // is scaled by the stone's own coverage at this pixel, so outside the true silhouette it nearly vanishes
            off *= mix(0.2, 1.0, smoothstep(0.0, 0.9, texture2D(u_underTex, suv).a));
            float disp = 0.15 + 1.2 * min(length(rg), 0.4);
            // W24 R6.36 (scorer-r633 #3: at the 1440 dive the submerged ghost read as a jagged lilac silhouette): the stone's
            // under-pass is drawn at 0.4–0.6× and upscaled, so its edge stair-stepped; a 4-tap box of ~1.5 under-texels softens
            // the mask, and its coverage is eased (no hard 0→1 step at the outline) and capped a little lower
            vec2 utx = 1.5 / vec2(textureSize(u_underTex, 0));
            vec4 ug = 0.25 * (texture2D(u_underTex, suv + off + vec2(utx.x, utx.y)) + texture2D(u_underTex, suv + off + vec2(-utx.x, utx.y))
                            + texture2D(u_underTex, suv + off + vec2(utx.x, -utx.y)) + texture2D(u_underTex, suv + off - utx));
            vec4 ugR = texture2D(u_underTex, suv + off * (1.0 - disp));
            vec4 ugB = texture2D(u_underTex, suv + off * (1.0 + disp));
            vec3 sc = vec3(ugR.r / max(ugR.a, 1e-3), ug.g / max(ug.a, 1e-3), ugB.b / max(ugB.a, 1e-3));
            sc = mix(ug.rgb / max(ug.a, 1e-3), sc, step(0.02, min(ugR.a, ugB.a)));
          #if HI == 0
            // R6.92b WATERLINE (Shifat 9:59 AM, phone + weak PC): on the low path the under-pass is ~0.14x the screen, so
            // its rim is several screen pixels wide and the per-channel un-premultiply above (a red or blue tap barely
            // inside the rim divided by its own tiny alpha) blew up into pink and white specks along the stone's cut. The
            // split channels now only take over well inside the silhouette, and never brighter than the plain sample.
            { vec3 sb = ug.rgb / max(ug.a, 1e-3);
              sc = mix(sb, sc, smoothstep(0.2, 0.55, min(ugR.a, ugB.a)));
              sc = min(sc, sb * 1.35 + 0.03); }
          #endif
            sc *= mix(1.0, (0.78 + 0.4 * cauL) * focus, 0.65 * clamp(gdp * 3.0, 0.3, 1.0));
            vec3 Tg = exp(-u_absorb * gdp * 0.9);
            refr = mix(refr, sc * Tg + inscatter * (1.0 - Tg.g) * 0.45, smoothstep(0.05, 0.85, ug.a) * 0.88);
            underA = clamp(ug.a, 0.0, 1.0);
          }
          col = mix(refr, refl, F);
          // sun glints: a tight lobe (sparkle) + a broad one (glitter path)
          vec3 H = normalize(u_sunDir + V);
          float NoH = max(dot(N, H), 0.0);
          // the glitter path belongs to grazing views; seen from above it breaks into white blotches on the detail
          // normals (the statement's top-down shot), so it fades out as the view turns steep
          float glitter = 1.0 - smoothstep(0.45, 0.85, NoV);
          // sun glint (WATER LANE): an anisotropic Ward lobe in the wave's own frame, stretched toward the viewer the
          // way a sun path streaks on water, plus the tight specular core
          #if WSURF
          // PERF (b8-surface-v3): both glint lobes are × glitter, exactly 0 on steep views (the near lake): skipped there
          if ((WAB & 8) == 0 && glitter > 0.0) {
          #else
          if ((WAB & 8) == 0) {
          #endif
            vec3 tv = normalize(vec3(-V.x, 0.0, -V.z) + vec3(1e-4, 0.0, 0.0));
            vec3 t1 = normalize(tv - N * dot(tv, N)), b1 = cross(N, t1);
            float ht = dot(H, t1), hb = dot(H, b1), hn = max(dot(H, N), 1e-3);
            float NoL = max(dot(N, u_sunDir), 0.0);
            #if WSURF
            // R7.12 b8-surface-v2 (Tester, v1 at 4–6 %: rows of blocky bright dashes mid-distance): specular anti-aliasing —
            // where the ripples get sub-pixel the lobes widen (energy kept), so a sub-pixel facet never flashes a texel. Driven
            // by the pixel footprint (smooth), not fwidth(N): a derivative of the normal is constant per 2x2 quad and printed
            // the quads as blocks
            float nv = min(fp * 4.0, 0.5);
            float ax = sqrt(0.0025 + nv * nv * 0.5), ay = sqrt(0.000256 + nv * nv * 0.5);
            float ce = 1600.0 / (1.0 + 1600.0 * nv * nv * 2.0);
            float core = pow(NoH, ce) * (ce / 1600.0);
            #else
            const float ax = 0.05, ay = 0.016;
            float core = pow(NoH, 1600.0);
            #endif
            float ward = exp(-((ht * ht) / (ax * ax) + (hb * hb) / (ay * ay)) / (hn * hn)) / (12.566 * ax * ay * sqrt(max(NoL * NoV, 1e-3)));
            float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
            col += u_sunColor * (min(ward, 400.0) * NoL * Fh * 0.8 + core * 60.0 * F * 4.0) * glitter;
          }
          #if WSURF
          if (u_ripOn > 0.5 && (WAB & 8) == 0) {
            // R7.12 b8-surface-v4 (Shifat 7:20 "The water surface need to be cleaner. Bigger ripples waves"): soft, broad
            // highlights riding the big rounded waves — the sun's lobe off the clean wave normal, by repeated squaring (no
            // pow, cheap on every tier). v3's crest twinkle and sun-path pow are gone (the twinkle read as speckle)
            float hx = max(dot(N, H), 0.0); hx *= hx; hx *= hx; hx *= hx; hx *= hx; hx *= hx;   // ^32: broad sheen
            float hx2 = hx * hx; hx2 *= hx2;                                                     // ^128: a soft core
            col += u_sunColor * (hx * 0.03 + hx2 * 0.08) * mix(0.6, 1.0, min(F * 4.0, 1.0));
          }
          #endif
          // stochastic glints: sparse micro-facets that catch the sun for a moment and go (twinkle, not a static
          // sparkle texture). One random cell per 6 cm, each with its own phase; only cells whose facet points near
          // the half vector light up, so they gather along the glitter path and get sparser away from it
          #if HI && !WSURF   // b8-surface-v4 (Shifat 7:20 "cleaner"): no sparkle speckle on the photo lake (?wsurf=old keeps it)
          if (dist < 14.0) {   // PERF (water-perf): (1 − smoothstep(4, 14, dist)) is exactly 0 beyond 14 m
            vec2 gc = floor(v_world.xz * 16.0);
            float hr = fract(sin(dot(gc, vec2(127.1, 311.7))) * 43758.5453);
            float hp = fract(sin(dot(gc, vec2(269.5, 183.3))) * 43758.5453);
            vec2 fc = fract(v_world.xz * 16.0) - 0.5;
            float tw = max(sin(u_time * (2.0 + 4.0 * hr) + hp * 6.2831), 0.0);
            float lobe = pow(NoH, 90.0 + 400.0 * hr);
            float spot = smoothstep(0.24, 0.0, length(fc));
            col += u_sunColor * step(0.82, hr) * tw * tw * spot * lobe * 18.0 * u_glint * (1.0 - smoothstep(4.0, 14.0, dist)) * glitter;
          }
          #endif
          // ring read: on a near-uniform bright sky a ripple only shows where it bends something, so each ring gets a
          // faint shaded flank (away from the key) and a lit lip (toward it), the sky-gradient reflection exaggerated;
          // only the interactive sim drives it (swell and detail stay glassy)
          float rlen = length(rg);
          if (rlen > 1e-4) {
            vec2 kd = normalize(u_sunDir.xz + vec2(1e-4, 0.0));
            float rs;
            if (u_rippleGate.y < 0.0) rs = clamp(rlap * -u_rippleGate.y, -u_rippleGate.z, u_rippleGate.z * 0.3); // curvature: rings read by their lit crests; a fresh drop's bowl only dims a touch (no grey discs)
            else rs = clamp(dot(rg, kd) * u_rippleShade, -0.22, u_rippleGate.z) * (u_rippleGate.y > 0.0 ? smoothstep(u_rippleGate.x, u_rippleGate.y, rlen) : 1.0);
            col *= 1.0 - max(rs, -0.6) * (rs > 0.0 ? 0.35 : 1.0);   // WATER LANE: troughs dim only a touch (refraction and caustics carry the ring now; a dark smear read as dirt)
            col += u_sunColor * smoothstep(0.08, 0.5, rlen) * max(-rs, 0.0) * 0.6;
          }
          // blue light spilled by the gem onto the water around it (soft, wide) + a tighter core
          vec2 gq = v_world.xz - u_gem.xz;
          // meniscus where the tip meets the water: water climbs the stone (a thin bright lip catching the sky) with a
          // darker trough just outside it; only while the tip is in
          {
            // u_touch = radius of the stone's cross-section at the waterline (0 when it does not cross the surface)
            float rr = length(gq);
            float on = step(0.003, u_touch);
            float r0 = u_touch + 0.006;
            #if HI
            float lip = exp(-pow((rr - r0) / 0.007, 2.0));
            float trough = exp(-pow((rr - r0 - 0.02) / 0.014, 2.0));
            col = col * (1.0 - trough * 0.12 * on) + vec3(1.0) * lip * 0.5 * on;
            #else
            // R7.10 PATCHER (Reviewer, M02s 9-10%: "thin bright white rim" where the tip meets the lake): riptide v2 shaded this
            // lip in the half-density lake target, so it reached the screen as a soft, dim band; the one-pass lake drew it as a
            // crisp pure-white line. Same lip, as v2 read it: twice as wide, about half as bright, tinted by the gem's light.
            // (u_lipSoft: 1 = this, 0 = build 7's lip; QA A/B only)
            float lw = mix(0.007, 0.014, u_lipSoft);
            float lip = exp(-pow((rr - r0 - 0.003 * u_lipSoft) / lw, 2.0));
            float trough = exp(-pow((rr - r0 - mix(0.02, 0.024, u_lipSoft)) / mix(0.014, 0.018, u_lipSoft), 2.0));
            col = col * (1.0 - trough * mix(0.12, 0.1, u_lipSoft) * on) + mix(vec3(1.0), mix(vec3(1.0), u_gemTint, 0.35), u_lipSoft) * lip * mix(0.5, 0.24, u_lipSoft) * on;
            #endif
          }
          float spill = exp(-dot(gq, gq) * 1.3) * 0.3 + exp(-dot(gq, gq) * 6.0) * 0.34;
          col = mix(col, col * u_gemTint * 1.5 + u_gemTint * 0.2, clamp(spill * 0.45 * u_gem.w * exp(-max(0.2 - u_gem.y, 0.0) * 4.0), 0.0, 1.0));   // WATER LANE: halved (violet halo, review #13)
          // the stone mirrored in the lake: Fresnel-weighted (stronger toward grazing, so it fades toward the viewer like
          // a real reflection), lifted above physical by u_gemReflK so a near-white field still shows it; the facets'
          // own dark/bright pattern keeps it a gem, not a disc
          // fade with distance from the waterline: trace the mirrored ray to the stone's axis and read the height it
          // passes at; the tip (touching the water) mirrors strong, the crown far above it fades out
          vec3 Rr = reflect(-V, N);
          vec2 toG = u_gem.xz - v_world.xz;
          float tAx = max(dot(toG, Rr.xz) / max(dot(Rr.xz, Rr.xz), 1e-4), 0.0);
          float hAx = v_world.y + Rr.y * tAx;
          // W25 R6.42 (scorer-r636..r639: the 1440 dive's 'ghost lobe' — diagnosed on staging as THIS mirror, not the refraction:
          // u_reflOn = 0 removes the wide lilac lobe and its spikes): the mirror fades sooner with its height above the waterline
          // (0.7 -> 0.5) once the stone has sunk to the waterline (the dive); the floating hero stone keeps 0.7. The lobe recedes. (A higher coverage-ramp start, 0.18, was tried: it cut the
          // spikes' tips but left a harder, more jagged outline; not kept)
          float hFade = 1.0 - smoothstep(0.02, mix(0.5, 0.7, smoothstep(0.15, 0.35, u_gem.y)), hAx);   // hero (stone floating, y≈0.45): unchanged 0.7
          #if WSURF
          // R7.12 b8-surface-v3 (Shifat 5:58 "Stone reflection"): stronger and clearer than live — Fresnel-led (rises
          // toward grazing), a higher cap, a sharper coverage ramp, and a brighter, truer mirror colour (water reflects
          // ~all of a grazing image: the stone reads as a bright gem in the lake, its dark facets still dark)
          hFade = 1.0 - smoothstep(0.02, mix(0.5, 1.05, smoothstep(0.15, 0.35, u_gem.y)), hAx);   // more of the floating stone mirrors (v2: 0.7, the crown faded out)
          float gw = smoothstep(0.04, 0.6, gemR.a) * hFade * clamp(u_gemReflK * (0.45 + F * 7.5), 0.0, GWCAP + 0.22) * (1.0 - 0.75 * underA);
          vec3 rc = mix(gemR.rgb, gemR.rgb * gemR.rgb * 1.2, 0.22) * vec3(0.84, 0.91, 1.0);
          float rl = dot(rc, vec3(0.2126, 0.7152, 0.0722)); rc = max(mix(vec3(rl), rc, 1.2), 0.0);
          // a slow shimmer along the mirror (the swell's light rolling through it), never a flicker
          rc *= 1.0 + 0.07 * clamp(dot(gSw, normalize(u_sunDir.xz + vec2(1e-4, 0.0))) * 30.0, -1.0, 1.0);
          col = mix(col, rc, gw);
          // soft contact reflection right under the stone: the water there mirrors the stone's underside (darker, tinted)
          // instead of the white sky — a soft cool pool that ties the floating stone to the lake. Fades as the stone rises
          #if HI   // b8-surface-v4 (cost, root 6:36): the contact pool only on the high tiers
          {
            float cr = exp(-dot(gq, gq) * 9.0) * exp(-max(u_gem.y - 0.15, 0.0) * 1.6) * u_reflOn * (1.0 - 0.75 * underA);
            col = mix(col, col * mix(vec3(0.86, 0.9, 0.97), u_gemTint * 0.9 + 0.35, 0.25), clamp(cr * (0.35 + 1.5 * F), 0.0, 0.42));
          }
          #endif
          #else
          float gw = smoothstep(0.05, 0.85, gemR.a) * hFade * clamp(u_gemReflK * (0.2 + F * 6.0), 0.0, GWCAP) * (1.0 - 0.75 * underA);   // WATER LANE: Fresnel-led, capped lower (muddy blob in review #13)
          // colour-depth: the mirrored stone sits deeper and cooler than the warm-lit stone above it
          vec3 rc = mix(gemR.rgb, gemR.rgb * gemR.rgb * 1.2, 0.5) * vec3(0.7, 0.8, 1.0);
          float rl = dot(rc, vec3(0.2126, 0.7152, 0.0722)); rc = max(mix(vec3(rl), rc, 1.3), 0.0);
          col = mix(col, rc, gw);
          #endif
          if (u_dbg > 2.5) col = vec3(0.5 + texture2D(u_rippleTexture, v_ruv).r * 12.0); else if (u_dbg > 1.5) col = gemR.rgb; else if (u_dbg > 0.5) col = vec3(hAx, hFade, gemR.a);   // 3 = sim height (WATER LANE QA)
          // aerial perspective toward the horizon
          #if WSURF
          // R7.12 b8-surface-v3 (ambience): a longer, gentler haze — the far lake dissolves into the white sky (starts nearer,
          // eases in, same end at u_fogFar so the far-plane shortcut above stays exact)
          float fog = smoothstep(u_ripOn > 0.5 ? u_fogNear * 0.55 : u_fogNear, u_fogFar, dist);
          if (u_ripOn > 0.5) fog *= 0.65 + 0.35 * fog;   // b8-surface-v4 (cost): ≈ v3's pow(x, 1.35) eased haze, without the pow
          #else
          float fog = smoothstep(u_fogNear, u_fogFar, dist);
          #endif
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
  // WATER LANE: the ripple sim runs only while the lake is actually drawn
  material.onBeforeRender = () => { waterInput.seenFrame = props.frame }
  if (/[?&]qa\b/.test(location.search)) (window as any).__waterU = uniforms   // QA only
  return { material, uniforms }
}
