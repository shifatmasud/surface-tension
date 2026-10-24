import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { nb, useStageFrame } from '../../systems/neighbour' // NEIGHBOUR HOOK
import { MeshRefractionMaterial } from '@react-three/drei'
import { createWaterMaterial } from '../../materials/water'
import { createSkyDome, sky } from '../../shaders/sky'
import { brilliantGeometry } from './diamond'
import { DIS_GLSL } from '../dive/disintegrate' // R6.88 SINK: the diamond's dissolve front
import { createGemSheen } from '../../materials/gemSheen'
import { props, shared } from '../../../state/props'
import { settings } from '../../../services/settings'
import { fboHelper } from '../../core/fbo'
import { pool } from '../../systems/pool'
import { input } from '../../../services/input'
import { Spring } from '../../../core/spring'
import { engine } from '../../engine'
import { dive, DIVE_LAYER } from '../dive/diveState'
import { quality, PHONE_SHARP } from '../../quality' // PERF HOOK
import { waterInput } from '../../water/waterInput' // WATER HOOK
import { gemMask } from '../../systems/stickerMask'
import { heroPass } from '../../post/heroPass' // R6.87 SPLIT
/** PERFGOV: the water plane's normal, shared (the reflection pass rebuilt it every frame) */
const WATER_UP = new THREE.Vector3(0, 1, 0)

export const GEM_LAYER = 2
export const gem = { pos: new THREE.Vector3(0, 0.45, 0), radius: 0.5, touch: 0 }
/** env-capture-only layer: the studio cards the gem "sees" but the camera never does */
export const STUDIO_LAYER = 6
/** v3: the 3D Shade DS parts in the deep (seen by the camera AND by the stone's env capture, so the stone refracts them) */
export const SYSUI_LAYER = 7
/** LAKERES: the phone lake pass draws the water alone into its low-res target (main camera, this layer only) */
const LAKE_LAYER = 9
/** how far the stone has sunk below its resting hover, metres (the Scene-1 path sets it as it dives) */
export const sink = { depth: 0 }

/**
 * S1 — the lake. One star: a blue brilliant-cut glass diamond hovering over calm water, its tip kissing
 * the surface every few seconds (soft rings). Water: real optics, cheap tricks (see materials/water.ts).
 */
/**
 * W22 stone finish (scorer-r614 #3), patched into drei's refraction shader:
 * (1) FILL: a ray that leaves the stone into a dark studio card gave a near-black chip (the dark specks in the dive).
 *     Where the traced sample is much darker than the environment's soft average in the same direction (a high mip of
 *     the same cube), it takes that average instead: the chip fills with the surrounding blue, big dark facets keep
 *     most of their depth.
 * (2) CAP: a soft knee on the brightest channel, so no refracted facet blows out; the hue is kept (scaled, not clipped).
 *     (The blown white facet itself was the sheen's warm key lighting a whole flat facet: fixed in gemSheen.ts.)
 * (The stepped 390 outline is the anti-aliasing's: post/PostChain.ts now runs SMAA at its HIGH preset.)
 */
const gemSil = { value: 1 }    // W23: silhouette coverage on (QA: window.__gemSil = 0 turns it off)
const gemLift = { value: 0.35 }   // W23: the facet floor (QA: window.__gemLift)
const gemBoost = { value: 1 }   // W24 R6.36: facet range above the floor (phones/portrait 1.15; scorer-r633 #1)
const gemFeather = { value: 1.75 }   // W24 R6.36: silhouette coverage ramp in scene px (portrait 2.75: 1 px more feather)
const gemDep = { value: new THREE.Vector2(0, 2) }   // W25 R6.42: under-surface pass only: x = on, y = 1 / stone radius (depth fade of the lake's refracted ghost)
const gemPre = { value: 0 }   // W25 R6.42: 1 when the stone is drawn opaque (its alpha is not applied by blending)
/** R6.88 SINK: the diamond's particle dissolve (dive/disintegrate.ts), 0 = whole; and the mesh, for its points' frame */
export const gemDisU = { value: 0 }
export const gemRef = { m: null as THREE.Mesh | null }
const gemFill = { value: 0.7 }   // W23: 0.7 in the hero (the darkest navy chips lift toward the env blue), 0.85 in the dive (set per frame)
function gemPatch(fresPow: string, lod: string) {
  return (sh: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> }) => {
    sh.uniforms.w22Fill = gemFill
    sh.uniforms.w23Lift = gemLift
    sh.uniforms.w23Sil = gemSil
    sh.uniforms.w24Boost = gemBoost
    sh.uniforms.w24Feather = gemFeather
    sh.uniforms.w25Dep = gemDep
    sh.uniforms.w25Pre = gemPre
    sh.uniforms.w26Dis = gemDisU
    // W23 (390 stepped outline): the stone's silhouette edges get analytic coverage (diamond.ts addSilhouetteAttrs): on a
    // triangle whose neighbour across an edge faces away, alpha ramps from 0 at that edge to 1 over ~1.75 scene pixels,
    // so the outline stops stepping when the phone's scene (≈1.3–1.5× density) is scaled up. No MSAA (SMAA-only rule).
    sh.vertexShader = sh.vertexShader
      .replace('varying vec3 vNormal;', 'varying vec3 vNormal;\n  attribute vec3 aSilB; attribute vec3 aSilN0; attribute vec3 aSilN1; attribute vec3 aSilN2;\n  varying vec3 vSilB; varying vec3 vSilN0; varying vec3 vSilN1; varying vec3 vSilN2; varying vec3 w26O;')
      .replace('gl_Position = projectionMatrix * viewMatrix * modelMatrix * transformedPosition;', 'w26O = position.xyz; vSilB = aSilB; mat3 w23M = mat3(modelMatrix); vSilN0 = w23M * aSilN0; vSilN1 = w23M * aSilN1; vSilN2 = w23M * aSilN2;\n    gl_Position = projectionMatrix * viewMatrix * modelMatrix * transformedPosition;')
    sh.fragmentShader = sh.fragmentShader
      .replace('uniform float bounces;', 'uniform float bounces;\n  uniform float w22Fill;\n  uniform float w23Sil;\n  uniform float w23Lift;\n  uniform float w24Boost;\n  uniform float w24Feather;\n  uniform vec2 w25Dep;\n  uniform float w25Pre;\n  varying vec3 vSilB; varying vec3 vSilN0; varying vec3 vSilN1; varying vec3 vSilN2;\n  uniform float w26Dis; varying vec3 w26O;\n' + DIS_GLSL)
      .replace('void main() {', 'void main() {\n    if (w26Dis > 0.0 && disRaw(w26Dis, disFGem(w26O)) >= 0.0) discard;   // R6.88: gone before the trace')
      .replace('pow( 1.0 + dot( viewDirection, worldNormal), 10.0 )', `pow( clamp(1.0 + dot( viewDirection, worldNormal), 0.0, 1.0), ${fresPow} )`)
      .replace('gl_FragColor = vec4(mix(diffuseColor.rgb, vec3(1.0), nFresnel), diffuseColor.a);', `
    #ifdef ENVMAP_TYPE_CUBEM
      #ifdef CHROMATIC_ABERRATIONS
        vec3 w22Dir = rayDirectionG;
      #else
        vec3 w22Dir = rayDirection;
      #endif
      vec3 w22Soft = color * textureLod(envMap, w22Dir, ${lod}).rgb;
      float w22L = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      float w22E = dot(w22Soft, vec3(0.2126, 0.7152, 0.0722));
      float w22K = w22Fill * (1.0 - smoothstep(0.12 * w22E, 0.55 * w22E, w22L));
      diffuseColor.rgb = mix(diffuseColor.rgb, w22Soft * 0.8, w22K);
      // W23 (scorer-r6261/r630 #1: navy facets in the 1440 dive): a facet-level floor in the stone's own blue, so an exit ray
      // into a dark patch of the env (where the soft env is dark too and the fill above has nothing to lift toward) reads
      // as deep blue glass rather than a navy hole
      vec3 w24F = vec3(0.035, 0.075, 0.45) * (w23Lift / 0.35);
      diffuseColor.rgb = max(diffuseColor.rgb, w24F);
      // W24 R6.36 (scorer-r633 #1: the 390 stone read flatter after the floor): stretch the range ABOVE the floor so the
      // floor removes the holes without flattening the facets (portrait only; 1440 unchanged)
      diffuseColor.rgb = w24F + (diffuseColor.rgb - w24F) * w24Boost;
    #endif
      float w22M = max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b);
      if (w22M > 2.1) diffuseColor.rgb *= (2.1 + 0.7 * (1.0 - exp(-(w22M - 2.1) / 0.7))) / w22M;
      gl_FragColor = vec4(mix(diffuseColor.rgb, vec3(1.0), nFresnel), diffuseColor.a);
      vec3 w23V = cameraPosition - vWorldPosition;
      vec3 w23D = vSilB / max(fwidth(vSilB), vec3(1e-6));
      float w23C = 1e3;
      if (dot(vSilN0, w23V) < 0.0) w23C = min(w23C, w23D.x);
      if (dot(vSilN1, w23V) < 0.0) w23C = min(w23C, w23D.y);
      if (dot(vSilN2, w23V) < 0.0) w23C = min(w23C, w23D.z);
      float w23A = clamp(w23C / w24Feather, 0.0, 1.0);
      if (w23Sil > 1.5) gl_FragColor = vec4(1.0 - w23A, w23A, 0.0, 1.0);   // QA: __gemSil = 2 shows the coverage (red = edge)
      else gl_FragColor.a *= mix(1.0, w23A, w23Sil);
      // W25 R6.42 (scorer-r636..r639: the 1440 dive's refracted ghost lobe reads as solid as the stone above the surface): in
      // the under-surface pass only, the stone's coverage fades with its depth below the lake (full at the waterline, ~30 %
      // a stone-radius down), so the lake's refraction of the pavilion recedes into the water instead of a hard lilac lobe
      if (w26Dis > 0.0) { float w26R = disRaw(w26Dis, disFGem(w26O)); if (w26R >= 0.0) discard; gl_FragColor.rgb += disEmber(w26R); }   // R6.88 SINK
      // R6.92b WATERLINE (Shifat 10:46 AM: "intersection line must not be visible when in water or on air"): the under-surface
      // pass is the lake's view of the stone BELOW the surface; the part above it was drawn there too, so wherever the lake
      // lies behind the stone's upper half its blurred copy (0.14x on phones, 0.7x on high) leaked past the real silhouette
      // as a pale rim or pink fringe. Only the submerged part goes into it now.
      if (w25Dep.x > 0.5 && vWorldPosition.y > 0.0) discard;
      if (w25Dep.x > 0.5) { float w25f = mix(1.0, 0.3, smoothstep(0.05, 0.9, max(0.0, -vWorldPosition.y) * w25Dep.y)); gl_FragColor.a *= w25f; if (w25Pre > 0.5) gl_FragColor.rgb *= w25f; }`)
    // R6.92 LITE GEM (weak GPUs only: Shifat's Intel UHD 600 on Windows reset its GPU on the full stone). The full stone
    // traces every pixel's ray through a BVH of its facets (three-mesh-bvh: nested dynamic loops, a uint stack array, up to
    // 3 bounces) — on ANGLE-D3D11 that program is the multi-second compile at boot and by far the heaviest per-pixel work.
    // Here the inside of the stone is the same cut in closed form: the ray's exit is the nearest of three planes (pavilion
    // main, crown bezel, table) of the 16-sector brilliant around the exit azimuth (diamond.ts proportions: girdle r 1,
    // crown 0.16 over a 0.56 table, pavilion 0.86 deep), so every facet still throws its own env direction (the sparkle)
    // and the refraction / total internal reflection / chroma / grade below are untouched. The BVH functions become
    // unreferenced and the compiler drops them. Phones and strong GPUs keep the traced stone.
    if (settings.WEAK_GPU) sh.fragmentShader = sh.fragmentShader.replace(
      /bvhIntersectFirstHit\(\s*bvh,\s*rayOrigin,\s*rayDirection,\s*faceIndices,\s*faceNormal,\s*barycoord,\s*side,\s*dist\s*\);/,
      `{
        vec3 lgO = rayOrigin, lgD = rayDirection;
        float lgB = dot(lgO, lgD), lgC = dot(lgO, lgO) - 1.0;
        vec3 lgP = lgO + lgD * (-lgB + sqrt(max(lgB * lgB - lgC, 0.0)));
        vec3 lgN = vec3(0.0, 1.0, 0.0); float lgT = 0.0;
        for (int lgI = 0; lgI < 2; lgI++) {
          float lgA = atan(lgP.z, lgP.x);
          float lgPh = (floor(lgA * 2.5464791) + 0.5) * 0.39269908;            // pavilion: 16 lower-girdle sectors
          float lgPc = floor(lgA * 2.5464791 + 0.5) * 0.39269908;              // crown: the same 16, offset half a sector (star/kite)
          vec2 lgS = vec2(cos(lgPh), sin(lgPh)), lgSc = vec2(cos(lgPc), sin(lgPc));
          vec3 lgNP = normalize(vec3(lgS.x, -1.1628, lgS.y)); float lgHP = -0.86 * lgNP.y;
          vec3 lgNC = normalize(vec3(lgSc.x, 2.75, lgSc.y)); float lgHC = lgNC.x * lgSc.x + lgNC.z * lgSc.y;
          lgT = 1e3; lgN = vec3(0.0, 1.0, 0.0);
          float lgDn = dot(lgD, lgNP); if (lgDn > 1e-4) { float lgTT = (lgHP - dot(lgO, lgNP)) / lgDn; if (lgTT < lgT) { lgT = lgTT; lgN = lgNP; } }
          lgDn = dot(lgD, lgNC); if (lgDn > 1e-4) { float lgTT = (lgHC - dot(lgO, lgNC)) / lgDn; if (lgTT < lgT) { lgT = lgTT; lgN = lgNC; } }
          if (lgD.y > 1e-4) { float lgTT = (0.16 - lgO.y) / lgD.y; if (lgTT < lgT) { lgT = lgTT; lgN = vec3(0.0, 1.0, 0.0); } }
          lgT = clamp(lgT, 0.0, 4.0); lgP = lgO + lgD * lgT;
        }
        faceNormal = -lgN; dist = lgT; side = 1.0;
        if (length(refract(lgD, -lgN, ior)) == 0.0) lgTir += 1.0;   // light trapped at this facet
      }`)
      // the traced stone's dark navy pockets (light trapped by total internal reflection) and its few cyan glints (an exit
      // ray lined up with the key light): restored from the same closed-form facets
      .replace('vec3 totalInternalReflection(', 'float lgTir = 0.0;\n  vec3 totalInternalReflection(')
      .replace('float w22M = max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b);', `{
        #ifdef CHROMATIC_ABERRATIONS
          vec3 lgX = rayDirectionG;
        #else
          vec3 lgX = rayDirection;
        #endif
        diffuseColor.rgb *= mix(1.0, 0.42, clamp(lgTir - 1.0, 0.0, 1.0));
        float lgG = pow(max(dot(lgX, normalize(vec3(0.35, 0.8, 0.5))), 0.0), 90.0) + 0.6 * pow(max(dot(lgX, normalize(vec3(-0.6, 0.55, -0.3))), 0.0), 140.0);
        diffuseColor.rgb += vec3(0.45, 1.1, 1.35) * lgG;
      }
      float w22M = max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b);`)
  }
}
const gemPatchHi = gemPatch('10.0', '4.0')
const gemPatchLo = gemPatch('10.0', '3.0')

/** PERFGOV-3 (M02s census: the hero's boot was one ~0.9 s task at 6x CPU, after the shell counter's first frame): the
 *  lake mesh (the 141² / 261² plane remapped toward the stone) and the stone's facets are built in short steps before
 *  the hero mounts (gl/Scene.tsx BootStager), and the mount takes them as they are. Same vertices in the same order,
 *  same bounding sphere: the picture is unchanged. A mount without them (a second instance) builds them as before. */
const pre: { water?: THREE.PlaneGeometry; gem?: THREE.BufferGeometry } = {}
export function* heroGeoSteps(): Generator<unknown, void, unknown> {
  const hi = settings.TIER === 'high' || settings.TIER === 'mid'
  if (!pre.gem) { pre.gem = brilliantGeometry(1); yield }
  if (pre.water) return
  const g = new THREE.PlaneGeometry(500, 500, hi ? 260 : 140, hi ? 260 : 140)
  yield
  const p = g.getAttribute('position') as THREE.BufferAttribute
  for (let i0 = 0; i0 < p.count; i0 += 2048) {
    for (let i = i0, e = Math.min(p.count, i0 + 2048); i < e; i++) {
      const x = p.getX(i) / 250, y = p.getY(i) / 250, r = Math.hypot(x, y)
      if (r > 0) { const k = Math.pow(r, 2.4) / r; p.setXY(i, x * k * 250, y * k * 250) }
    }
    yield
  }
  g.computeBoundingSphere()
  pre.water = g
}

export function HeroStage() {
  const { gl, scene, camera, size } = useThree()
  const group = useRef<THREE.Group>(null!)
  const gemMesh = useRef<THREE.Mesh>(null!)
  const waterMesh = useRef<THREE.Mesh>(null!)
  const hi = settings.TIER === 'high' || settings.TIER === 'mid'
  const { material: water, uniforms: wu } = useMemo(createWaterMaterial, [])
  ;(window as any).__wu = wu // QA: water uniforms
  ;(window as any).__gem = { gem, gemMesh } // QA
  const dome = useMemo(createSkyDome, [])
  const waterGeo = useMemo(() => {
    if (pre.water) { const g = pre.water; pre.water = undefined; return g }   // PERFGOV-3: built in steps before the mount
    const g = new THREE.PlaneGeometry(500, 500, hi ? 260 : 140, hi ? 260 : 140)
    // concentrate vertices near the gem (where the sim and the camera are): r' = r^1.8 remap
    const p = g.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) / 250, y = p.getY(i) / 250, r = Math.hypot(x, y)
      if (r > 0) { const k = Math.pow(r, 2.4) / r; p.setXY(i, x * k * 250, y * k * 250) }
    }
    g.computeBoundingSphere()
    return g
  }, [hi])
  const gemGeo = useMemo(() => { const g = pre.gem; pre.gem = undefined; return g ?? brilliantGeometry(1) }, [])   // PERFGOV-3
  const sheen = useMemo(() => { const s = createGemSheen({ strength: 0.75 }); s.uniforms.u_feather = gemFeather; s.uniforms.u_dep = gemDep; return s }, [])   // W25 R6.41: the shell's silhouette ramp = the stone's
  const sheenMesh = useRef<THREE.Mesh>(null!)
  // DIAG: the refraction shader maps gl_FragCoord / resolution to the camera ray it takes its mip gradients from, and
  // drei feeds it the CSS size. gl_FragCoord is in target pixels, so at DPR 2 (phones, retina) uv ran 0..2 (one mip
  // too blurry, skewed across the stone) and in the 0.35–0.75× mirror / through-the-surface targets it ran 0..0.5
  // (too sharp: crawling sparkle in the lake). Set it to the size of whatever target this draw lands in.
  const gemRes = useMemo(() => {
    const v = new THREE.Vector2()
    return (r: THREE.WebGLRenderer) => {
      const m = gemMesh.current; if (!m) return
      const t = r.getRenderTarget()
      if (t) v.set(t.width, t.height); else r.getDrawingBufferSize(v)
      const u = (m.material as THREE.ShaderMaterial).uniforms?.resolution
      if (u) u.value = v
    }
  }, [])
  fboHelper.track(water)

  // env capture for the gem (sky + lake, gem hidden), and the planar reflection of the gem for the lake
  const env = useMemo(() => {
    const rt = new THREE.WebGLCubeRenderTarget(hi ? 256 : 128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter })
    const cam = new THREE.CubeCamera(0.05, 200, rt)
    cam.children.forEach((c) => { c.layers.enable(STUDIO_LAYER); c.layers.enable(SYSUI_LAYER) })
    return { rt, cam, frame: 0, deep: false, lake: true, dropped: false, lifted: false }
  }, [hi])
  // product-photography trick: a near-white world gives a pastel stone, so the env capture alone sees a ring of
  // dark flags with bright gaps around the gem (plus a deep floor card). The facets then tile into crisp
  // dark/bright blues — a vivid stone with real sparkle — while the visible frame stays airy and white.
  const studio = useMemo(() => {
    const g = new THREE.Group()
    // W20 (scorer-r610 #1: at 1440 the near-black cards read as black void facets on the star of every frame): wide
    // screens give the dark cards a deep sapphire instead of near-black, so the dark facets stay dark-blue glass and keep
    // the sparkle contrast; phones keep the look Shifat called beautiful.
    const dark = new THREE.MeshBasicMaterial({ color: hi ? '#0c2266' : '#05070f', side: THREE.DoubleSide, fog: false, toneMapped: false })
    const deep = new THREE.MeshBasicMaterial({ color: '#0a1a4a', side: THREE.DoubleSide, fog: false, toneMapped: false })
    const soft = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.2, 2.25), side: THREE.DoubleSide, fog: false, toneMapped: false })
    const add = (m: THREE.Mesh) => { m.layers.set(STUDIO_LAYER); g.add(m) }
    const n = 7
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3, w = 2 * Math.PI * 3 / n * 0.5
      const card = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.9), dark)
      card.position.set(Math.cos(a) * 3, 0.35, Math.sin(a) * 3); card.lookAt(0, 0.35, 0); add(card)
    }
    const floor = new THREE.Mesh(new THREE.CircleGeometry(2.2, 32), deep)
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.9; add(floor)
    const box = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.4), soft)
    box.position.set(-0.6, 3.2, -0.8); box.lookAt(0, 0, 0); add(box)
    // PERF HOOK (same objects on every tier): the env-capture-only studio cards exist on phones too.
    g.visible = true
    return g
  }, [hi])
  // v3 underwater lighting fix (from the cube work, applied to the stone): under water the light comes from above. The
  // env sees a full surround graded from the bright surface window overhead through luminous teal to the deep below,
  // with a few dark kelp flags for contrast, so the stone reads as a lit sapphire (it went near-black under water).
  // In the systems deep the window dims and the flags go: the stone then refracts the UI cylinder around it.
  const uStudio = useMemo(() => {
    const g = new THREE.Group()
    const uDeep = { value: 0 }
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(4.5, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, toneMapped: false, fog: false, uniforms: { u_deepK: uDeep },
      vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float u_deepK; varying vec3 vP; void main(){
        float y = vP.y;
        vec3 deep = vec3(0.01, 0.05, 0.09), mid = mix(vec3(0.12, 0.62, 0.78), vec3(0.03, 0.20, 0.32), u_deepK);
        vec3 top = mix(vec3(1.6, 2.2, 2.4), vec3(1.0, 1.6, 2.0), u_deepK);
        vec3 c = mix(deep, mid, smoothstep(-0.7, 0.05, y));
        c = mix(c, top, smoothstep(0.35, 0.85, y));
        c += vec3(0.5, 0.7, 0.75) * pow(max(y, 0.0), 16.0) * 2.0 * (1.0 - u_deepK * 0.4);
        float a = atan(vP.z, vP.x);
        c *= 0.75 + 0.5 * pow(0.5 + 0.5 * sin(a * 7.0 + 0.6), 3.0) * smoothstep(-0.3, 0.4, y);
        gl_FragColor = vec4(c, 1.0); }`,
    }))
    sphere.renderOrder = -10
    const add = (m: THREE.Object3D, to: THREE.Object3D = g) => { m.layers.set(STUDIO_LAYER); to.add(m) }
    add(sphere)
    const flags = new THREE.Group(); g.add(flags)
    const dark = new THREE.MeshBasicMaterial({ color: '#02101a', side: THREE.DoubleSide, fog: false, toneMapped: false })
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.5
      const card = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 3.2), dark)
      card.position.set(Math.cos(a) * 3, -0.3, Math.sin(a) * 3); card.lookAt(0, -0.3, 0); add(card, flags)
    }
    g.visible = false
    return { g, flags, uDeep }
  }, [])
  const refl = useMemo(() => {
    const s = hi ? 0.75 : 0.2  // WATERRES (Shifat 23:06Z 'just use reduced quality reflection'): phones 0.2 (was 0.35, ≈1/3 the pixels); the mirror RT holds only the stone (gem layer): crisp facets in the lake cost little
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType })
    const cam = new THREE.PerspectiveCamera()
    cam.layers.set(GEM_LAYER)
    return { rt, cam, scale: s, plane: new THREE.Plane(), cp: new THREE.Vector4(), q: new THREE.Vector4(), bias: new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1) }
  }, [hi])
  useEffect(() => {
    // PERF HOOK: the reflection target follows the governor (DPR step × its render-target scale)
    const fit = () => { const s = quality.rt(refl.scale), d = quality.dprFor(size.width, size.height); refl.rt.setSize(Math.max(2, Math.floor(size.width * d * s)), Math.max(2, Math.floor(size.height * d * s))) }
    fit()
    return quality.on(fit)
  }, [size, refl])
  useEffect(() => { wu.u_reflTex.value = refl.rt.texture; wu.u_reflOn.value = 1 }, [refl, wu])
  // the submerged part of the stone, seen from above THROUGH the water (screen-space refraction): the stone alone,
  // main camera, every frame its tip is in the water (the bob's dip, or the dive's sink); the lake samples it
  const under = useMemo(() => ({ rt: new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType }), scale: settings.WEAK_GPU ? 1.0 : hi ? 0.6 : 0.28 }), [hi])   // WATERRES: phones 0.28 (was 0.4, ≈half the pixels). R6.92: a weak desktop 1.0 (its stone is the cheap closed-form one; at 0.28 × the 0.5 background the lake's refracted copy of the stone was a blurred ghost that read as a soft halo around the stone's edge)
  useEffect(() => {
    // DIAG: follows the governor too (it was sized once from props.dpr, so a DPR step left it at the old size)
    // W19: follow the governor's MOVING rung only (noRest): the rest refinement toggles on every pointer stop/start, and
    // re-allocating this target on each toggle cost the hero ~2x CPU in R5's perf tour
    const fit = () => { const d = quality.dprFor(size.width, size.height, true); const w = Math.max(2, Math.floor(size.width * d * under.scale)), h = Math.max(2, Math.floor(size.height * d * under.scale)); if (w !== under.rt.width || h !== under.rt.height) under.rt.setSize(w, h) }
    fit()
    return quality.on(fit)
  }, [size, under])
  useEffect(() => { wu.u_underTex.value = under.rt.texture }, [under, wu])
  // LAKERES (Shifat 16:02 PT: "water surface pixel resolution can be turned down a bit for faster hero section … feels slow
  // in phone"): on phones the lake's own full-screen shader (the hero's biggest cost) runs into a 0.65x target; the main
  // camera's draw of the same mesh then only reads it back (water.ts u_lakeComp). Same vertex shader → full-res, exact depth:
  // the stone's silhouette, its submerged cut and the meniscus line are still drawn at scene resolution, and the stone is
  // never in this target, so nothing of it can bleed (no halo). Desktop/mid: nothing here exists (hi).
  const lake = useMemo(() => hi ? null : { rt: new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType }), scale: PHONE_SHARP ? 0.5 : 0.65,   /* R7.00 (Shifat 4:20 AM 'hero … just performance boost'): the lake's own pass 0.65 → 0.5 on budget phones (≈40 % fewer pixels) */ low: false, frame: -1, mw: new THREE.Matrix4(), pm: new THREE.Matrix4(), comps: 0 }, [hi])
  useEffect(() => {
    if (!lake) return
    // the governor's MOVING rung only (noRest), as `under`: no re-allocation on every pointer stop/start
    const fit = () => { const d = quality.dprFor(size.width, size.height, true); const w = Math.max(2, Math.floor(size.width * d * lake.scale)), h = Math.max(2, Math.floor(size.height * d * lake.scale)); if (w !== lake.rt.width || h !== lake.rt.height) lake.rt.setSize(w, h); (wu as any).u_lakeHalf.value.set(0.5 / lake.rt.width, 0.5 / lake.rt.height) }
    fit()
    return quality.on(fit)
  }, [size, lake])
  // R6.92b WATERLINE: where the background runs below the canvas density (the low path's split resolution) the hero pass
  // tests the stone against the background's upsampled depth, so its cut along the lake came out as a 2x2 sawtooth that
  // crawled as the stone moved. While the stone touches the surface and the camera is above it, the lake's own depth is
  // re-drawn into the hero target at the canvas density (its vertex shader, shared uniforms, no colour): a per-pixel cut.
  // Above the water nothing stands between the camera and the lake but the heroes, so the overwrite cannot un-hide them.
  useEffect(() => {
    if (!heroPass.enabled) return
    const mat = new THREE.ShaderMaterial({
      uniforms: water.uniforms, defines: { ...(water.defines || {}) }, vertexShader: water.vertexShader,
      fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); }', side: THREE.DoubleSide,
      colorWrite: false, depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth,
    })
    const proxy = new THREE.Mesh(waterGeo, mat); proxy.matrixAutoUpdate = false; proxy.frustumCulled = false; proxy.layers.mask = 0xffffffff
    const sc = new THREE.Scene(); sc.add(proxy)
    heroPass.depthFix = (r, cam) => {
      const wm = waterMesh.current
      if (!wm || !wm.visible) return
      if ((props.dpr || 1) >= (props.heroDpr || 1)) return                        // same density: the scene's depth is already exact
      if (cam.position.y < 0.02 || dive.under || dive.split >= 0 || Math.abs(gem.pos.y) > gem.radius * 1.25) return   // not while the lens waterline crosses (the lake is cut there; this depth would hide the stone below the line)
      proxy.matrix.copy(wm.matrixWorld)
      const mask = cam.layers.mask; cam.layers.mask = 0xffffffff
      try { r.render(sc, cam) } finally { cam.layers.mask = mask }
    }
    // R7.06 PERF: the same lake depth, handed to the hero pass as an object drawn inside its single render (right after the
    // background-depth copy), so the multisampled hero target is resolved once a frame instead of three times
    proxy.renderOrder = -1e9 + 1
    heroPass.depthFixMesh = (cam) => {
      const wm = waterMesh.current
      if (!wm || !wm.visible) return null
      if ((props.dpr || 1) >= (props.heroDpr || 1)) return null
      if (cam.position.y < 0.02 || dive.under || dive.split >= 0 || Math.abs(gem.pos.y) > gem.radius * 1.25) return null
      proxy.matrix.copy(wm.matrixWorld); proxy.matrixWorld.copy(wm.matrixWorld)
      return proxy
    }
    return () => { heroPass.depthFix = null; heroPass.depthFixMesh = null; mat.dispose() }
  }, [water, waterGeo])
  // R6.87 SPLIT RESOLUTION: the stone (and its sheen shell) is a hero subject — drawn at the canvas density in its own
  // pass over the low-res scene (post/heroPass.ts); its reflection in the lake keeps coming from the mirror pass
  useEffect(() => {
    ;(sheenMesh.current.material as THREE.ShaderMaterial).uniforms.u_dis = gemDisU // R6.88 SINK: the sheen dissolves with the stone
    const a = heroPass.add(gemMesh.current), b = heroPass.add(sheenMesh.current)
    return () => { a(); b() }
  }, [])
  useEffect(() => {
    if (!lake) return
    wu.u_lakeTex!.value = lake.rt.texture
    waterMesh.current.layers.enable(LAKE_LAYER)
    if (/[?&]qa\b/.test(location.search)) (window as any).__lake = lake   // QA only (comps = main draws served from the low-res lake)
  }, [lake, wu])

  const st = useMemo(() => ({
    tiltX: new Spring(0, 1.1, 0.55, 0), tiltZ: new Spring(0, 1.1, 0.55, 0), lift: new Spring(0, 0.9, 0.45, 0),
    spin: 0, lastTouch: 0, phase: 0,
    // PERF HOOK: scratch objects (no per-frame allocation → no GC pauses mid-scroll)
    look: new THREE.Vector3(), cc: new THREE.Color(),
  }), [])

  useStageFrame('hero', (_, dt) => {
    const t = props.time
    // underwater, the gem's reflection/env capture are wasted work: stop once the dive camera is below the surface
    // v2: while the dive drives the guide gem (dive.gemOn) the stone stays; only the lake (water, sky, studio) hides once
    // the camera is under, along with its mirror / through-the-surface passes
    // W17: in v3 the systems section IS the deep dive; a pass that resolves to 'systems' (the neighbour pass, as the
    // journey card slides over) must still draw the stone there, never the lake
    const deepSys = props.stage === 'systems' && dive.gemOn
    const lakeOn = !((props.stage === 'dive' || deepSys) && dive.camY < -0.3)
    const vis = (props.look.dive < 0.999 || props.stage === 'dive' || deepSys) && props.stage !== 'journey' && (props.stage !== 'systems' || deepSys)
      && (lakeOn || dive.gemOn)
      && !(props.stage === 'lab' && props.look.fade > 0.965)  // the lab fades the lake to 97 %: skip its 138k-tri water + reflection/env passes there
    group.current.visible = vis
    // POLISH (rv-visual #15): the loop wrap jumps from the CTA (dive path holding the stone deep) straight to the top,
    // where the dive no longer drives it; the last sink depth used to stay and hold the stone under the lake (an empty
    // hero). Off the dive path the stone floats at its own hover, and it is re-surfaced while the footer is in view so
    // the first frame after the wrap (under the veil) already has it up and its env re-captured.
    if ((dive.gemMix <= 0 || props.overscroll > 0) && sink.depth !== 0) sink.depth = 0
    // POLISH (Shifat 18:47Z "after footer to header warp loops back the stone disappear & appear jumps"): the wrap is a
    // jump (more than half a screen in one frame); on that frame the stone's springs land ON their hero targets, so the
    // first frame after the wrap is a normal hero frame (no tilt swing from the CTA pose, no lift settling)
    const jumped = Math.abs(props.scrollDelta) > props.height * 0.5
    if (!vis) return
    // W22: the stone's dark-chip fill: off in the hero, full once the dive guides the stone (QA: window.__gemFill)
    gemLift.value = (window as any).__gemLift ?? 0.35
    { const portrait = innerWidth < innerHeight; gemBoost.value = portrait ? 1.15 : 1; gemFeather.value = 1.75   /* W24 R6.37: the 2.75 px portrait feather read as a grey halo on the white lake (scorer-r636 #1); back to 1.75 */ }
    gemFill.value = (window as any).__gemFill ?? (0.7 + 0.15 * Math.min(1, Math.max(0, dive.gemMix)))   // W23 (scorer-r621 #1, root 02:55Z): the hero lifts its darkest chips too (0.7; 0.85 in the dive)
    { const W = window as any; if (W.__gemFres !== undefined) (gemMesh.current.material as any).fresnel = W.__gemFres; if (W.__sheenTp !== undefined) sheen.uniforms.u_tp.value = W.__sheenTp; if (W.__sheenWarm !== undefined) sheen.uniforms.u_warm.value = W.__sheenWarm; if (W.__sheenStr !== undefined) sheen.uniforms.u_strength.value = W.__sheenStr; if (W.__gemHide !== undefined) sheenMesh.current.visible = !W.__gemHide }   // QA hooks (W22 stone A/B)
    waterMesh.current.visible = lakeOn; dome.visible = lakeOn
    // R7.02 STONE CUT (Shifat 6:55 AM "Stone shapes get cutoff when diving from air to water"): just under the surface
    // (camY 0 → −0.3) the lake still draws, seen from below, and its depth stood between the camera and the crown above the
    // plane, so the hero pass sliced the stone flat at the waterline for a few frames. From below, nothing under the plane
    // can be behind the lake, so the lake stops writing depth while the camera is under it: same pixels, the crown stays.
    { const wm = water as THREE.Material, noDepth = lakeOn && camera.position.y < 0; if (wm.depthWrite === noDepth) wm.depthWrite = !noDepth }
    waterInput.frame(camera, lakeOn)   // WATER HOOK: touch trails (even mid-scroll) + the sim's visibility
    // W18-DIVE OVER-UNDER: the lake is cut at the lens waterline for the main camera only (never in the env/mirror captures)
    if (!waterMesh.current.userData.wl) {
      waterMesh.current.userData.wl = true
      waterMesh.current.onBeforeRender = lake ? (_r, _s, cam) => {
        // LAKERES (phones): the lake pass shades the whole lake (no lens cut) at the target's size; the main camera's draw reads
        // it back only when it is THIS frame's lake from THIS pose (the neighbour pass and any other camera shade in full)
        const main = cam === camera && !lake.low
        const comp = main && lake.frame === props.frame && !nb.active && lake.mw.equals(cam.matrixWorld) && lake.pm.equals((cam as THREE.PerspectiveCamera).projectionMatrix)
        wu.u_lakeComp!.value = comp ? 1 : 0
        wu.u_lakeTex!.value = lake.low ? null : lake.rt.texture   // never bound while drawing INTO it (a WebGL feedback loop drops the draw)
        if (comp) lake.comps++
        if (!lake.low) wu.u_resolution.value.copy(shared.u_resolution.value)
        wu.u_wlClip.value = main ? dive.split : -1
      } : (_r, _s, cam) => { wu.u_wlClip.value = cam === camera ? dive.split : -1 }
    }
    // R6.93 WATERLINE: the sheen's meniscus line is seen only from the air (gemSheen.ts): the main camera's draw gets the
    // lens waterline and whether the lens is above the lake; the env/mirror/neighbour captures keep the line as before
    if (!sheenMesh.current.userData.wl) {
      sheenMesh.current.userData.wl = true
      const su = sheen.uniforms
      sheenMesh.current.onBeforeRender = (_r, _s, cam) => {
        const main = cam === camera
        su.u_split.value = main ? dive.split : -1
        su.u_air.value = main ? (cam.position.y > 0 ? 1 : 0) : 1
      }
    }
    // gem: slow breathing hover; the tip dips into the water once per ~3.4 s
    st.phase += dt * (Math.PI * 2 / 3.4)
    const bob = Math.cos(st.phase)                     // -1 = lowest (touching)
    const pointer = input.everMoved ? input.mouseXY : { x: 0, y: 0 }
    // lifted while the hero cranes up; settles back onto the water for the contact bookend
    const liftT = props.heroPin * 0.9 * (1 - Math.min(1, (props.resurface || 0) * 2.5))
    if (jumped) st.lift.reset(liftT)   // POLISH: a jump lands on the pose
    const lift = st.lift.update(liftT, dt)
    const tipY = 0.86 * gem.radius
    gem.pos.set(0, tipY - 0.07 + (bob * 0.5 + 0.5) * 0.045 + lift, 0)
    const ownY = gem.pos.y
    gem.pos.y -= (dive.gemMix > 0 ? 0 : sink.depth) + ((window as any).__gemSink ?? 0)   // external sink + QA hook
    // the dive's guide path (diveState.ts, builder-owned) takes the stone over as the dive starts: surface → sink → lead
    if (dive.gemMix > 0) {
      gem.pos.lerp(dive.gem, Math.min(1, dive.gemMix))
      sink.depth = Math.max(0, ownY - gem.pos.y)
    }
    st.spin += dt * 0.16
    const m = gemMesh.current
    ;(window as any).__heroGem = { m, sheen: sheenMesh.current }
    gemRef.m = m; gemDisU.value = dive.gemMix > 0 ? dive.gemDis : 0 // R6.88 SINK
    m.position.copy(gem.pos)
    m.scale.setScalar(gem.radius * (dive.gemMix > 0 ? dive.gemScale : 1))
    // contact bookend: the low camera saw the hero's forward tilt edge-on (a flat sliver); tip the table toward the lens
    // hero: the classic three-quarter jewel view: crown, table and pavilion point all read (at -0.42 the camera
    // saw the stone side-on: a thin crown over a dark pavilion window; at 0 and above it reads as a flat oval). The statement's top-down shot was framed for -0.42
    const baseTilt = props.stage === 'contact' ? 0.2 : props.stage === 'statement' ? -0.42 : ((window as any).__heroTilt ?? -0.25)
    if (jumped) { st.tiltX.reset(baseTilt - pointer.y * 0.1); st.tiltZ.reset(pointer.x * -0.12) }   // POLISH: a jump lands on the pose
    m.rotation.set(st.tiltX.update(baseTilt - pointer.y * 0.1, dt), st.spin, st.tiltZ.update(pointer.x * -0.12, dt), 'XYZ')
    sheenMesh.current.position.copy(m.position); sheenMesh.current.rotation.copy(m.rotation); sheenMesh.current.scale.copy(m.scale)
    if (bob < -0.985 && t - st.lastTouch > 2.5 && lift < 0.05) {
      pool.drop(0, 0, 0.035, 0.014); st.lastTouch = t
    }
    gem.touch = Math.max(0, -bob)
    wu.u_gem.value.set(gem.pos.x, gem.pos.y, gem.pos.z, 0.85)
    {
      // waterline cross-section of the brilliant (pavilion cone below the girdle, crown above): drives the meniscus
      const r = gem.radius, tipD = Math.max(0, -(gem.pos.y - r * 0.86))
      wu.u_touch.value = tipD <= 0 ? 0 : tipD < r * 0.86 ? tipD * (r / (r * 0.86)) : Math.max(0, r - (tipD - r * 0.86) * 2.6)
    }

    const c = camera as THREE.PerspectiveCamera
    const prevRT = gl.getRenderTarget(), prevClear = gl.getClearAlpha(), cc = st.cc; gl.getClearColor(cc)
    const bg = scene.background
    if (lakeOn) {
    // planar reflection of the gem (mirror camera, gem layer only)
    const rc = refl.cam
    rc.copy(c, false); rc.layers.set(GEM_LAYER)
    const p = c.position, look = st.look.set(0, 0, -1).applyQuaternion(c.quaternion).add(p)
    rc.position.set(p.x, -p.y, p.z)
    rc.up.set(0, -1, 0)
    rc.lookAt(look.x, -look.y, look.z)
    rc.updateMatrixWorld(); rc.projectionMatrix.copy(c.projectionMatrix)
    wu.u_reflMatrix.value.copy(refl.bias).multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse)
    // oblique near plane = the water plane (Lengyel): the mirror only sees what is ABOVE the surface, so a dipping
    // tip or a sinking stone never shows up as a ghost in its own reflection. Only the z row changes, so the
    // reflection's screen mapping above stays valid
    {
      const pl = refl.plane.set(WATER_UP, 0).applyMatrix4(rc.matrixWorldInverse)  // PERFGOV: no per-frame Vector3
      const cp = refl.cp.set(pl.normal.x, pl.normal.y, pl.normal.z, pl.constant)
      const e = rc.projectionMatrix.elements
      const q = refl.q.set((Math.sign(cp.x) + e[8]) / e[0], (Math.sign(cp.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14])
      cp.multiplyScalar(2 / cp.dot(q))
      e[2] = cp.x; e[6] = cp.y; e[10] = cp.z + 1; e[14] = cp.w
      rc.projectionMatrixInverse.copy(rc.projectionMatrix).invert()
    }
    // the mirror sees the REAL stone (its facets, fire and dark pavilion), not a flat proxy: the refraction material
    // ray-traces in world space from cameraPosition, so it only needs the mirror camera's inverse matrices
    const rm = m.material as any
    const vmi = rm.viewMatrixInverse, pmi = rm.projectionMatrixInverse
    rm.viewMatrixInverse = rc.matrixWorld; rm.projectionMatrixInverse = rc.projectionMatrixInverse
    gl.setRenderTarget(refl.rt); gl.setClearColor(0x000000, 0); gl.clear(true, true, false)
    scene.background = null
    gl.render(scene, rc)
    rm.viewMatrixInverse = vmi; rm.projectionMatrixInverse = pmi

    // the stone below the surface, for the lake's refraction (only while some of it is under)
    const submerged = gem.pos.y - gem.radius * 0.86 < 0.004
    wu.u_underOn.value = submerged ? 1 : 0
    if (submerged) {
      const ml = c.layers.mask; c.layers.set(GEM_LAYER)
      gemDep.value.set(1, 1 / Math.max(1e-3, m.scale.x)); gemPre.value = (m.material as THREE.Material).transparent ? 0 : 1   // W25 R6.42
      gl.setRenderTarget(under.rt); gl.setClearColor(0x000000, 0); gl.clear(true, true, false)
      gl.render(scene, c)
      gemDep.value.x = 0
      c.layers.mask = ml
    }
    // LAKERES (phones): the lake alone, main camera, into its 0.65x target (cleared transparent: the read-back divides by alpha)
    if (lake && !nb.active) {
      const ml = c.layers.mask; c.layers.set(LAKE_LAYER)
      lake.low = true; wu.u_resolution.value.set(lake.rt.width, lake.rt.height)
      gl.setRenderTarget(lake.rt); gl.setClearColor(0x000000, 0); gl.clear(true, true, false)
      gl.render(scene, c)
      lake.low = false; c.layers.mask = ml
      lake.frame = props.frame; lake.mw.copy(c.matrixWorld); lake.pm.copy(c.projectionMatrix)
    }
    }
    // underwater the stone sees the water, not the studio: the cards go and the env re-captures as it sinks
    const deep = gem.pos.y < -0.05
    // W18-DIVE OVER-UNDER: once the lens is under (the line has left the top of the frame) the stone sees the water
    // already, before the lake hides (it went pale between the crossing and camY −0.3); a change re-captures the env
    const camUnder = !lakeOn || (props.stage === 'dive' && dive.under && dive.split < -0.5)
    if (deep !== env.deep || !camUnder !== env.lake) { env.deep = deep; env.lake = !camUnder; env.frame = 0 }
    // sinking seen from above: the stone sees the water. Camera under with it: the dark product flags come back for the
    // env capture only (STUDIO_LAYER, never seen by the camera) so the facets tile dark/bright and it stays a vivid sapphire
    studio.visible = !camUnder && !deep
    // v3: camera under with the stone: the graded 'under' surround (see `under` above); in the systems deep it dims and
    // the flags go so the stone refracts the cylinder of parts
    uStudio.g.visible = camUnder && ((window as any).__studioUnder ?? true)
    uStudio.flags.visible = dive.abyss < 0.5
    uStudio.uDeep.value = Math.min(1, dive.abyss * 1.2)
    // the dive's backdrop sphere draws at renderOrder 10 with no depth test: under water the stone must draw after it
    // (11 = with the sand/kelp, depth-sorted against them); the additive sheen shell is in the transparent list anyway
    // W18-DIVE OVER-UNDER: while the lens crosses (dive.split ≥ 0) the water world draws below the line too, so the stone
    // must draw after the dive backdrop there as well (the lake is cut at the line, so it never hides the pavilion)
    const crossing = dive.split > -0.5
    m.renderOrder = camUnder || crossing ? 11 : 0; sheenMesh.current.renderOrder = camUnder || crossing ? 15 : 2
    // PERF (water-perf, Shifat "heavy & wide for phone"): above the surface the opaque lake draws just BEFORE the sky dome
    // (-11 vs the dome's -10). The dome writes no depth and sits at the far plane, so where the lake already covers the
    // screen the depth test rejects the dome's sky shader early (it used to shade the whole screen and then be painted over).
    // Same pixels, same order for everything else; under water (the graded surround at -10 writes no depth) it keeps 0.
    waterMesh.current.renderOrder = camUnder ? 0 : -11
    // W23: the silhouette coverage needs blending, so the stone draws in the transparent list in the lake (after the
    // water, sky and studio it sits on); under water and while the lens crosses it keeps its opaque place (renderOrder 11)
    { const W = window as any; gemSil.value = W.__gemSil ?? 1; const gm = m.material as THREE.Material; const tr = !(camUnder || crossing) && gemSil.value > 0; if (gm.transparent !== tr) gm.transparent = tr
      // in the transparent list the stone draws after everything else there (the lake's own transparent layers), so its edge
      // blends over the finished background; the sheen shell stays on top of it
      if (tr) { m.renderOrder = 20; sheenMesh.current.renderOrder = 21 } }
    // env capture: first frames, then every 24 frames on capable tiers (every 8 while the stone is under)
    // W19 (Shifat 19:50Z "diamond comes black"): the first 3 frames now run behind the preloader's warm gate, where the
    // studio/sky can still be unready, and a low tier never re-captured, so the stone kept a black env. Re-capture through
    // the first seconds and then every 90 frames in the hero on every tier (one cube pass, cheap at this rate)
    // and once the intro drops (the curtain lifts, the real hero frame starts) the env starts over: 3 captures, then every 20 frames
    if (props.introDrop && !env.dropped) { env.dropped = true; env.frame = 0 }
    // W20 (phone hero 'feels heavy'): phones re-capture at 30, 90 and 180 frames after the drop (3 cube passes, still
    // inside the first seconds where the studio can be unready) instead of every 20 frames (12 cube passes = 72 extra
    // face renders while the hero is first on screen); other tiers unchanged
    const reEnv = settings.TIER === 'low' ? (env.frame === 30 || env.frame === 90 || env.frame === 180) : (env.frame < 240 && env.frame % 20 === 0)   // (the warm gate no-ops clear/viewport/mipmaps on its frames)
    if (env.frame < 3 || reEnv || (camUnder && env.frame % (dive.abyss > 0.5 ? (hi ? 3 : 8) : 30) === 0) || (hi && env.frame % (deep ? 8 : 24) === 0 && props.stage !== 'contact')) {  // contact keeps the hero's studio env: a re-capture of the bright contact field washed the pavilion out
      m.visible = false; sheenMesh.current.visible = false
      env.cam.position.copy(gem.pos)
      // camera under with the lake hidden: the env keeps the product flags only (QA __envDive=true adds the dive's water)
      const envDive = !lakeOn && ((window as any).__envDive ?? false)   // off: the dive backdrop (no depth test) wipes the flags → a pastel stone
      env.cam.children.forEach((cm) => { if (envDive) cm.layers.enable(DIVE_LAYER); else cm.layers.disable(DIVE_LAYER) })
      // W19 (Shifat 19:50Z "diamond comes black", measured: __morph=1 turns it blue again): the UI drum and its particle atom
      // (SYSUI_LAYER) sit around the stone before they form; seen by the hero's env capture they wrapped it in dark parts.
      // The env sees them only in the systems deep, where the stone is meant to refract the cylinder
      env.cam.children.forEach((cm) => { if (deep) cm.layers.enable(SYSUI_LAYER); else cm.layers.disable(SYSUI_LAYER) })
      studio.position.copy(gem.pos); uStudio.g.position.copy(gem.pos)
      env.cam.update(gl, scene)
      m.visible = true; sheenMesh.current.visible = true
    }
    // R6.88 SINK: the diamond is all points once its dissolve has run (its trace and its sheen stop drawing)
    { const gone = gemDisU.value > 0.999; if (m.visible === gone) { m.visible = !gone; sheenMesh.current.visible = !gone } }
    {
      // W23: where the stone sits on screen (viewport px), so the trail's smear leaves its edge alone (post/effects.ts)
      if (lakeOn && m.visible) {
        const R = gem.radius * (dive.gemMix > 0 ? dive.gemScale : 1) * 1.1
        const v = st.look.copy(gem.pos).applyMatrix4(c.matrixWorldInverse)
        const dz = Math.max(0.05, -v.z), f = 1 / Math.tan((c.fov * Math.PI) / 360)
        gemMask.r = (R / dz) * f * innerHeight * 0.5
        v.applyMatrix4(c.projectionMatrix)
        gemMask.x = (v.x * 0.5 + 0.5) * innerWidth; gemMask.y = (0.5 - v.y * 0.5) * innerHeight; gemMask.on = 1
      } else gemMask.on = 0
    }
    // CURTAIN (Shifat 13:04Z): while the preloader curtain is lifting, the periodic re-captures wait (the 3 captures of the
    // drop run before the lift starts, Intro.tsx); counting resumes once it has lifted, so a cube pass never lands on the
    // ~300 ms in which the curtain crosses the screen
    if (!(env.frame >= 3 && props.introDrop && !env.lifted && !(env.lifted = document.documentElement.classList.contains('is-lifted')))) env.frame++
    scene.background = bg
    gl.setRenderTarget(prevRT); gl.setClearColor(cc, prevClear)
  }, group)

  return (
    <group ref={group}>
      <primitive object={dome} />
      <primitive object={studio} />
      <primitive object={uStudio.g} />
      <mesh ref={waterMesh} geometry={waterGeo} material={water} rotation-x={-Math.PI / 2} frustumCulled={false} />
      {/* DIAG: chroma was ±3 % IOR per channel on the high tier: R, G and B took different total-internal-reflection
          paths, so whole facets came out pure green, dark red or black (A/B on live: 0 removes them). Now a thin
          fast-chroma fringe (direction offset, one traced path) on every tier: the fire stays, the chips go */}
      <mesh ref={gemMesh} geometry={gemGeo} onUpdate={(o) => o.layers.enable(GEM_LAYER)} onBeforeRender={gemRes}>
        <MeshRefractionMaterial envMap={env.rt.texture as any} bounces={hi || settings.WEAK_GPU ? 3 : 2} ior={2.2} fresnel={0.85} aberrationStrength={hi || settings.WEAK_GPU ? 0.006 : 0.008} fastChroma color={new THREE.Color(0.1, 0.34, 2.1)} toneMapped onBeforeCompile={hi || settings.WEAK_GPU ? gemPatchHi : gemPatchLo} />
      </mesh>
      <mesh ref={sheenMesh} geometry={gemGeo} material={sheen.material} renderOrder={2} onUpdate={(o) => o.layers.enable(GEM_LAYER)} />
    </group>
  )
}
void sky; void engine
