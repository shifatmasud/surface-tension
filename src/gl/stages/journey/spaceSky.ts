import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { vfovFor } from '../../../core/frame'
import { inner, type Inner } from './timeline'
import { CREW_CENTER_Y } from './crewmate'
import { skyMaterial, starMaterial, glintStarMaterial } from './shaders'
import { clip } from '../../systems/clip'

/**
 * R6.87 SINGLE SKY (Shifat 4:06 PM Oct 22: "Crewmate tablet must show exactly the real starry sky we enter"; 5:46 PM
 * "single sky"; 5:48 PM "Keep rocks in sky too in tablet").
 *
 * ONE source for the journey's space. The journey's inner world (JourneyStage buildSteps) and the dive tablet's window
 * (tabletWindow.ts) both build, from here and nowhere else:
 *   - the sky dome (one shader),
 *   - the 6500 stars + Milky Way band and the 12 bright glint stars: ONE set of geometry buffers, built once and shared by
 *     both scenes (until R6.86 the window carried a hand-copied recipe: 2200 stars and 7 glints on phones, so the bright
 *     stars sat elsewhere),
 *   - the floating rocks and the layered dust (the window's own, now part of the sky: the same rocks at the same places,
 *     tumbling on the same clock, in the glass and after the dive, until the journey leaves space),
 *   - the space light rig and the crewmate's space look (one table; the journey lerps from it toward the forest).
 * Point sizes come from one function (starPrFor), so a star is the same size on screen through the glass and inside.
 */

/** The journey's visible lens at p = 0, as its screen covers the viewport (JourneyStage: sw × sh screen, OVERSCAN, the
 *  ultrawide widening): the vertical tan of what the viewer actually sees. */
/** R7.01 RICH (Shifat: "the rich purple tablet picture drops into a darker, less colourful opening of space"): the gain on
 * space's Milky Way, nebula and star dust (skyMaterial u_rich; 1 = the old grade). 1.75 = the glow the tablet's glass shows
 * its picture at, so the colour carries through the hand-off; the black between stays black. ?rich=<n> overrides (QA). */
export const SPACE_RICH = (() => { try { const v = parseFloat(new URLSearchParams(location.search).get('rich') || ''); return isFinite(v) && v > 0 ? v : 1.75 } catch { return 1.75 } })()
export const JOURNEY_LENS = { crop: 1.14 }
export function journeyVisibleTan(fovDeg: number, isPortrait: boolean, aspect: number) {
  const sw = isPortrait ? 8.8 : 12.8, sh = isPortrait ? 12.8 : 8.8
  const wideK = isPortrait ? 1 : Math.max(1, aspect / 1.6)
  const fillH = Math.min(sh / JOURNEY_LENS.crop, sw / (JOURNEY_LENS.crop * aspect))
  return Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * wideK * (fillH / sh)
}

let starGeo: { stars: THREE.BufferGeometry; glints: THREE.BufferGeometry } | null = null
/** the star field and the bright few: seed 3, the band on a diagonal, temperature colours, a steep brightness curve.
 *  Built once; both scenes draw these very buffers. */
export function starGeometry() {
  if (starGeo) return starGeo
  let seed = 3; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const MWN = new THREE.Vector3(0.55, 0.83, 0).normalize()
  const mwA = new THREE.Vector3(0, 0, -1), mwB = new THREE.Vector3().crossVectors(MWN, mwA).normalize()
  const N = 6500
  // b7-space-v3 (Shifat 10:48 AM Oct 26 "Reduce stars"): 60 % fewer. The same 6500-star sequence is generated (so the
  // glints below and every kept star stay exactly where they were) and 2 of every 5 are kept: 2600 stars, same sizes.
  const KEEP = (i: number) => i % 5 < 2
  const NK = Math.ceil(N * 2 / 5)
  const sp = new Float32Array(NK * 3), ss_ = new Float32Array(NK), sc = new Float32Array(NK * 3)
  let k = 0
  const temp = [new THREE.Color('#9fbfff'), new THREE.Color('#cadaff'), new THREE.Color('#f4f6ff'), new THREE.Color('#fff4e3'), new THREE.Color('#ffd9a8'), new THREE.Color('#ffb98a')]
  const tw = [0.08, 0.2, 0.36, 0.2, 0.11, 0.05]
  const pickT = () => { let x = r(), i = 0; while (i < tw.length - 1 && x > tw[i]) { x -= tw[i]; i++ } return temp[i] }
  const v = new THREE.Vector3()
  for (let i = 0; i < N; i++) {
    if (r() < 0.42) {
      const lon = r() * Math.PI * 2, g = (r() + r() + r() - 1.5) * 0.32
      v.copy(mwA).multiplyScalar(Math.cos(lon)).addScaledVector(mwB, Math.sin(lon)).multiplyScalar(Math.cos(g)).addScaledVector(MWN, Math.sin(g)).normalize()
    } else {
      const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u)
      v.set(Math.cos(th) * s, u, Math.sin(th) * s)
    }
    const m = Math.pow(r(), 5.5)
    const size = 0.9 + m * 2.1 + r() * 0.35
    const c = pickT(), b = 0.1 + m * 0.95
    if (!KEEP(i)) continue
    sp.set([v.x * 600, v.y * 600, v.z * 600], k * 3)
    ss_[k] = size
    sc.set([c.r * b, c.g * b, c.b * b], k * 3)
    k++
  }
  const stars = new THREE.BufferGeometry()
  stars.setAttribute('position', new THREE.BufferAttribute(sp.subarray(0, k * 3), 3)); stars.setAttribute('aSize', new THREE.BufferAttribute(ss_.subarray(0, k), 1)); stars.setAttribute('aColor', new THREE.BufferAttribute(sc.subarray(0, k * 3), 3))
  const GN = 12
  const gp = new Float32Array(GN * 3), gs = new Float32Array(GN), gc = new Float32Array(GN * 3), ga = new Float32Array(GN)
  for (let i = 0; i < GN; i++) {
    const az = -Math.PI / 2 + (r() - 0.5) * 2.6, el = (r() - 0.35) * 1.0
    v.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize()
    if (i === 0) v.set(-0.42, 0.3, -0.86).normalize()
    if (i === 1) v.set(0.5, 0.24, -0.83).normalize()
    gp.set([v.x * 580, v.y * 580, v.z * 580], i * 3)
    gs[i] = (i < 2 ? 34 : 22 + r() * 16)   // v2f: heroes 44 -> 34 px
    const c = temp[[0, 1, 2, 2, 3, 4][Math.floor(r() * 6)]], b = i < 2 ? 1.0 : 0.55 + r() * 0.35
    gc.set([c.r * b, c.g * b, c.b * b], i * 3)
    ga[i] = r() * Math.PI
  }
  // b7-space-v3b (root 11:31: "the star cut barely shows"): the 12 bright glints were never cut and they are what the eye
  // reads as "the stars". Keep the two hero glints + 3 of the other 10 = 5 of 12 (42 %), same places, sizes and colours
  const GK = [0, 1, 7]   // v2f (Tester: journey top band 38 vs live 51, v2c 21): 3 of 12, the two heroes a size smaller (below)
  const pick = (a: Float32Array, w: number) => { const o = new Float32Array(GK.length * w); GK.forEach((g, j) => o.set(a.subarray(g * w, g * w + w), j * w)); return o }
  const glints = new THREE.BufferGeometry()
  glints.setAttribute('position', new THREE.BufferAttribute(pick(gp, 3), 3)); glints.setAttribute('aSize', new THREE.BufferAttribute(pick(gs, 1), 1)); glints.setAttribute('aColor', new THREE.BufferAttribute(pick(gc, 3), 3)); glints.setAttribute('aAngle', new THREE.BufferAttribute(pick(ga, 1), 1))
  starGeo = { stars, glints }
  return starGeo
}

let domeGeo: THREE.SphereGeometry | null = null
/** the dome + the stars (the glints ride the stars' object), with their materials; geometry shared between scenes */
export function buildSpaceSky(starPr: number) {
  const skyMat = skyMaterial()
  const sky = new THREE.Mesh(domeGeo ??= new THREE.SphereGeometry(900, 48, 24), skyMat)
  sky.renderOrder = -10; sky.frustumCulled = false
  const g = starGeometry()
  const starMat = starMaterial(starPr)
  const stars = new THREE.Points(g.stars, starMat); stars.frustumCulled = false; stars.renderOrder = -9
  const glintMat = glintStarMaterial(starPr)
  const glintStars = new THREE.Points(g.glints, glintMat); glintStars.frustumCulled = false; glintStars.renderOrder = -8
  stars.add(glintStars)
  return { sky, skyMat, stars, starMat, glintStars, glintMat }
}
/** shared geometry is never disposed by a scene (the other one may still draw it) */
export function isSharedSkyGeometry(g: THREE.BufferGeometry) {
  return g === domeGeo || g === starGeo?.stars || g === starGeo?.glints || g === rockGeo || g === dustGeo || g === earthGeo || g === moonGeo
}

/** The journey's star point size for an inner target of this width. R6.87: the scene DPR is floored at 0.6 here (the
 *  R6.83 floor), so the background's lower budget-GPU floor never shrinks the stars: phones never change the sky's look. */
export function starPrFor(rtW: number, dpr: number) { return Math.min(Math.max(dpr || 1, 0.6), 2) * (rtW / 1024) }

/** the space light (the journey's rig at atmos 0) and the crewmate's environment strengths there */
export const SPACE_LIGHT = {
  hemiSky: '#7a5cff', hemiGround: '#071a22', hemi: 0.7,
  key: '#ffd2c4', keyI: 2.6, keyPos: [5, 6, 6] as const,
  rim: '#5fd8ff', rimI: 3.4, rimPos: [-6, 3, -7] as const,
  bodyEnv: 1.0, visorEnv: 3.0,
}

// ---------------------------------------------------------------- Earth + one tiny moon (b7-space-v3)
// Shifat 10:48 AM Oct 26: "Reduce stars & add earth & 1 tiny moon in this scene." Both live in the shared sky (children
// of each scene's star object, so they sit at sky distance, follow the camera's position and turn with its view): the
// tablet's glass and the journey's space show the same Earth at the same place, so they match across the glass.
// Earth: a 32 x 16 sphere, the day map lit from one side (the space key light's direction), the night side black, and a
// thin blue Fresnel atmosphere rim in the same shader (no extra pass). Moon: a 16 x 8 sphere, procedural grey noise, the
// same sun. Opaque-looking, drawn after the stars (transparent list, renderOrder -7/-6) so they cover the stars behind them.
// Day map: NASA Visible Earth, "Blue Marble: Land Surface, Ocean Color and Sea Ice" (public domain, NASA Goddard),
//   https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57730/land_ocean_ice_2048.jpg
//   resized to 1024 x 512, JPEG q85 = 85 KB -> public/textures/earth-day-1k.jpg
const EARTH_URL = (((import.meta as any).env?.BASE_URL as string | undefined) ?? '/') + 'textures/earth-day-1k.jpg'
let earthTex: THREE.Texture | null = null
let earthGeo: THREE.SphereGeometry | null = null, moonGeo: THREE.SphereGeometry | null = null
const earthGLs = new Set<THREE.WebGLRenderer>()
const earthReady = { v: false }
const earthMats = new Set<THREE.ShaderMaterial>()
function earthTexture() {
  if (earthTex) return earthTex
  const t = new THREE.TextureLoader().load(EARTH_URL, (tx) => {
    earthReady.v = true
    earthMats.forEach((m) => { m.uniforms.u_ready.value = 1 })
    earthGLs.forEach((g) => { try { g.initTexture(tx) } catch { /* the first draw uploads it */ } })   // off the scroll path
  })
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  t.anisotropy = 4   // v3b: crisper at its small size (mipmaps are three's default: LinearMipmapLinear)
  earthTex = t
  return t
}
// b7-tunnel-v2e (Shifat 12:38 "Real 3d model of moon, earth used right?"): the moon's surface is NASA's real colour map,
// NASA Scientific Visualization Studio "CGI Moon Kit" (LRO LROC WAC colour mosaic, public domain), equirect:
//   https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg
//   b7-tunnel-v2k: the full 1024 x 512 map (was resized to 512 x 256), JPEG q78 = 73 KB -> public/textures/moon-lroc-1k.jpg
//   (mipmaps: three's default LinearMipmapLinear; anisotropy 4, below)
const MOON_URL = (((import.meta as any).env?.BASE_URL as string | undefined) ?? '/') + 'textures/moon-lroc-1k.jpg'
let moonTex: THREE.Texture | null = null
const moonReady = { v: false }
const moonMats = new Set<THREE.ShaderMaterial>()
function moonTexture() {
  if (moonTex) return moonTex
  const t = new THREE.TextureLoader().load(MOON_URL, (tx) => {
    moonReady.v = true
    moonMats.forEach((m) => { m.uniforms.u_ready.value = 1 })
    earthGLs.forEach((g) => { try { g.initTexture(tx) } catch { /* the first draw uploads it */ } })
  })
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  t.anisotropy = 4
  moonTex = t
  return t
}
/** the sun on Earth and Moon: the space key light's direction (SPACE_LIGHT.keyPos), so they are lit like the crewmate */
const SUN = new THREE.Vector3(5, 6, 6).normalize()
const EM_VS = /* glsl */ `
varying vec3 vN; varying vec3 vWP; varying vec2 vUv; varying vec3 vP; varying vec3 vC; varying float vR;
void main(){
  vUv = uv; vP = position;
  // v3b: the mesh is drawn over the true sphere (9 %, the moon's 8 rings), so the analytic limb lies inside it.
  // v2j: Earth's halo shell goes out to 1.24 R, room for the glow just outside the disc. b7-tunnel-v2k: the moon has no glow
  // (no atmosphere; v2j's faint glow read as a grey sticker edge all round), so its mesh is back to 1.09 R
#if defined(HALO)
  vec4 wp = modelMatrix * vec4(position * 1.24, 1.0);
#else
  vec4 wp = modelMatrix * vec4(position * 1.09, 1.0);
#endif
  vN = normalize(mat3(modelMatrix) * normal); vWP = wp.xyz;
  vC = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz; vR = length(modelMatrix[0].xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`
const EM_FS = /* glsl */ `
uniform sampler2D u_day; uniform vec3 u_sun, u_fill; uniform float u_opacity, u_spin, u_ready, u_gain;
varying vec3 vN; varying vec3 vWP; varying vec2 vUv; varying vec3 vP; varying vec3 vC; varying float vR;
// v2j glow (Shifat 2:24 "Use glow on earth & moon. Just like real light bounce"): a thin scattering halo just OUTSIDE the
// disc, brightest on the sun's side and fading round to faint on the night side (ISS-photo atmosphere); x = (d - R) / R
float halo(float x, float side){ return exp(-max(x, 0.0) * 18.0) * smoothstep(0.22, 0.0, x) * mix(0.1, 1.0, side); }
void main(){
  // v3b: the limb is the TRUE sphere's, anti-aliased analytically: the view ray's distance to the centre against the radius,
  // feathered over one pixel (fwidth). No MSAA, no extra pass; the low-poly mesh's polygon edge never shows
  vec3 rd = normalize(vWP - cameraPosition), oc = vC - cameraPosition;
  float tc = dot(oc, rd);
  float dr = length(oc - rd * tc);
  float cover = clamp((vR - dr) / max(fwidth(dr), 1e-5) + 0.5, 0.0, 1.0);
  // which side of the ball this pixel's limb faces: 1 toward the sun, 0 away
  float side = smoothstep(-0.55, 0.75, dot(normalize(cameraPosition + rd * tc - vC), u_sun));
  float hx = (dr - vR) / vR;
#ifdef HALO
  // Earth's atmosphere glow: its own additive shell (Earth's disc is opaque), outside the disc only; back faces, so the
  // part behind the disc fails the depth test and is never shaded
  if (cover >= 1.0 || hx > 0.22) discard;
  gl_FragColor = vec4(vec3(0.28, 0.55, 1.0) * 0.55 * halo(hx, side) * (1.0 - cover) * u_gain * u_opacity, 0.0);
  return;
#endif
  if (cover <= 0.0) discard;   // b7-tunnel-v2k: the moon's v2j glow is gone (Earth's is the HALO shell above)
  // b7-tunnel-v2d: the normal is the TRUE sphere's at the view ray's hit, so the terminator curves round the ball
  float th = tc - sqrt(max(vR * vR - dr * dr, 0.0));
  vec3 N = normalize(cameraPosition + rd * th - vC), V = -rd;
  float ndl = dot(N, u_sun), ndv = clamp(dot(N, V), 0.0, 1.0);
  // v2j: a SOFT terminator (wrap lighting: day -> night is a gentle gradient over ndl -0.3 .. 0.35, not a cut)
  float lit = smoothstep(-0.3, 0.35, ndl) * (0.35 + 0.65 * max(ndl, 0.0));
#ifdef MOON
  // v2e: NASA's LROC colour map; v2j: EARTHSHINE on the dark part, a soft bluish-grey fill (~13 %) lit from Earth's direction
  vec3 alb = texture2D(u_day, vUv).rgb;
  vec3 c = alb * lit * (0.8 + 0.2 * ndv) * 2.0;
  c += alb * vec3(0.78, 0.86, 1.0) * 0.26 * (0.3 + 0.7 * max(dot(N, u_fill), 0.0)) * (1.0 - lit);
  gl_FragColor = vec4(c * u_gain, cover * u_opacity);   // b7-tunnel-v2k: the 1 px analytic edge fades straight into space (no grey fringe)
#else
  vec3 alb = texture2D(u_day, vec2(vUv.x + u_spin, vUv.y)).rgb * u_ready;
  vec3 c = alb * lit * 1.45;
  // v2j: BOUNCE FILL on the night side, a faint cool blue (~10 % of the day side), so the map stays faintly readable
  c += (alb * vec3(0.6, 0.8, 1.15) * 0.15 + vec3(0.004, 0.009, 0.02)) * (1.0 - lit);
  // the atmosphere: a thin blue Fresnel rim, bright on the lit limb and faint round the night side (it scatters)
  float rim = pow(1.0 - ndv, 3.0);
  c += vec3(0.22, 0.5, 1.0) * rim * mix(0.12, 1.0, smoothstep(-0.3, 0.35, ndl)) * 1.1;
  c = mix(c, vec3(0.16, 0.3, 0.6) * lit, 0.08 * (1.0 - ndv) * u_ready);
  gl_FragColor = vec4(c * u_gain * cover, 1.0);   // v2i: opaque, the edge premultiplied over black (the halo shell adds on top)
#endif
}`
function emMaterial(moon: boolean, halo = false) {
  const m = new THREE.ShaderMaterial({
    vertexShader: EM_VS, fragmentShader: EM_FS, defines: halo ? { HALO: '' } : moon ? { MOON: '' } : {},
    uniforms: { u_day: { value: moon ? moonTexture() : earthTexture() }, u_sun: { value: SUN.clone() }, u_fill: { value: new THREE.Vector3(0, 1, 0) }, u_opacity: { value: 1 }, u_spin: { value: 0 }, u_ready: { value: (moon ? moonReady.v : earthReady.v) ? 1 : 0 }, u_gain: { value: 1 } },
    // v2i: Earth is OPAQUE and drawn before the dome (renderOrder -11 < -10), writing depth, so at 3x its size the dome's
    // fragments behind it are rejected by the depth test instead of shaded and then covered (the cost stays flat). Its
    // 1 px analytic edge is premultiplied over black (space is black there); it hides rather than fades (update).
    // v2j: Earth's glow is its own additive back-face shell (HALO); the moon draws its faint glow in its own pass-free draw
    ...(halo ? { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide }
             : { transparent: moon, depthWrite: !moon }),
    fog: false, toneMapped: false,
  })
  if (!moon && !halo) earthMats.add(m); else if (moon) moonMats.add(m)
  return m
}
const _EMI: Inner = { crew: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, walk: 0, phase: 0, float: 0, squash: 0, visible: true, cam: new THREE.Vector3(), look: new THREE.Vector3(), fov: 42, atmos: 0, stars: 1, shadow: 0 }
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _d = new THREE.Vector3(), _f2 = new THREE.Vector3()
/** Earth's and the Moon's place in the journey's opening frame (NDC of the visible lens): wide screens put Earth low on
 *  the left, under the crewmate's lead third; phones (crewmate centred) low on the left, partly off the frame. */
// v3b (root 11:31: in the tablet at 51 % Earth was a clipped, washed-out sliver in the corner). Placement is in fractions of
// the frame's half extents (x, y) and the radius in fractions of its half HEIGHT: the journey's opening frame, and, in the
// tablet, the glass's display (TabletWindow aims them there through its own portal camera, then hands over to these exact
// journey places as the picture converges, so nothing jumps at the switch). Low-left with margin, clear of the crewmate.
// b7-tunnel-v2i ART DIRECTION (Shifat 2:13 PM "3x bigger earth & bigger moon would make it lusion.co like no? Art direct"):
// Earth is the hero planet, 3x its v2h radius, anchored in the LOWER-LEFT corner with about a third of its disc beyond
// the frame (the curvature reads big); the moon 2x, UPPER-RIGHT on the opposite diagonal (0.40 x Earth's diameter, under
// Shifat's 80 % cap). Same fractions in the journey's opening frame and in the tablet's display (TabletWindow.aim).
export const EM_PLACE = {
  // b7-tunnel-v2k: the moon nudged in from the top-right corner, clear of the menu icon (PC 1366x768: centre (1175,146) ->
  // ~(1115,196), i.e. 60 px left, 50 px down; M02s 412x915: (309,165) -> ~(290,215)). Sizes unchanged
  wide: { e: [-0.88, -0.78], er: 0.45, m: [0.633, 0.49], mr: 0.18 },
  tall: { e: [-0.6, -0.74], er: 0.33, m: [0.41, 0.53], mr: 0.13 },
}
const EARTH_D = 420, MOON_D = 400
export class EarthMoon {
  readonly group = new THREE.Group()
  readonly earth: THREE.Mesh; readonly moon: THREE.Mesh
  readonly earthMat: THREE.ShaderMaterial; readonly moonMat: THREE.ShaderMaterial
  readonly halo: THREE.Mesh; readonly haloMat: THREE.ShaderMaterial
  private key = ''
  constructor(gl?: THREE.WebGLRenderer) {
    if (gl) earthGLs.add(gl)
    this.earthMat = emMaterial(false); this.moonMat = emMaterial(true); this.haloMat = emMaterial(false, true)
    this.earth = new THREE.Mesh(earthGeo ??= new THREE.SphereGeometry(1, 32, 16), this.earthMat)
    this.moon = new THREE.Mesh(moonGeo ??= new THREE.SphereGeometry(1, 16, 8), this.moonMat)
    this.earth.renderOrder = -11; this.moon.renderOrder = -6   // v2i: Earth before the dome (opaque list)
    this.halo = new THREE.Mesh(moonGeo, this.haloMat); this.halo.renderOrder = -5   // v2j: Earth's glow shell (16 x 8, back faces, additive)
    this.group.add(this.earth, this.moon, this.halo); this.group.name = 'earthMoon'
  }
  /** lay out once per orientation (aspect: the viewport's, for the visible lens) */
  place(isPortrait: boolean, aspect: number) {
    const key = `${isPortrait}|${aspect.toFixed(2)}`
    if (key === this.key) return
    this.key = key
    const I = inner(0, _EMI, isPortrait)
    _f.subVectors(I.look, I.cam).normalize()
    _r.crossVectors(_f, _u.set(0, 1, 0)).normalize(); _u.crossVectors(_r, _f).normalize()
    const tJ = journeyVisibleTan(I.fov, isPortrait, aspect), tX = tJ * aspect
    const P = isPortrait ? EM_PLACE.tall : EM_PLACE.wide
    const at = (nx: number, ny: number, d: number, out: THREE.Vector3) => out.copy(_f).addScaledVector(_r, nx * tX).addScaledVector(_u, ny * tJ).normalize().multiplyScalar(d)
    at(P.e[0], P.e[1], EARTH_D, this.e0); this.es0 = EARTH_D * P.er * tJ
    at(P.m[0], P.m[1], MOON_D, this.m0); this.ms0 = MOON_D * P.mr * tJ
    // b7-tunnel-v2c (Tester 11:46: "night side still lit across the whole disc"): the sun was the world key light, which sits
    // behind the opening camera, so it lit the face we see. Now it comes from the key's SIDE of the picture (its in-frame
    // direction), square to the sight line to Earth, a touch toward us: ~55 % of each disc lit, the rest black
    // v2i: the sun from the UPPER-RIGHT of the frame (art direction), square to each body's sight line: Earth 0.08 away
    // from us (crisp terminator, ~half its disc black), the moon 0.25 toward us (gibbous)
    _f2.copy(_r).multiplyScalar(0.8).addScaledVector(_u, 0.6)
    _d.copy(this.e0).negate().normalize()                                            // Earth -> camera
    this.earthMat.uniforms.u_sun.value.copy(_f2).addScaledVector(_d, -_f2.dot(_d)).normalize().addScaledVector(_d, -0.08).normalize()
    _d.copy(this.m0).negate().normalize()                                            // Moon -> camera
    this.moonMat.uniforms.u_sun.value.copy(_f2).addScaledVector(_d, -_f2.dot(_d)).normalize().addScaledVector(_d, 0.25).normalize()
    this.haloMat.uniforms.u_sun.value.copy(this.earthMat.uniforms.u_sun.value)
    // v2j: the moon's earthshine comes from Earth's direction
    this.moonMat.uniforms.u_fill.value.subVectors(this.e0, this.m0).normalize()
    this.set(this.e0, this.es0, this.m0, this.ms0)
  }
  /** the journey's places (place()), kept for the tablet's hand-over */
  private e0 = new THREE.Vector3(); private m0 = new THREE.Vector3(); private es0 = 1; private ms0 = 1
  private set(e: THREE.Vector3, es: number, m: THREE.Vector3, ms: number) {
    this.earth.position.copy(e); this.earth.scale.setScalar(es)
    this.halo.position.copy(e); this.halo.scale.setScalar(es)
    // the day side shown to the lens: the map's longitude 0 (Africa / Europe) faces the camera, the axis tilted 23° in the picture
    _d.copy(e).negate().normalize()
    this.earth.rotation.set(0.4, Math.atan2(-_d.z, _d.x), 0, 'YXZ')
    this.moon.position.copy(m); this.moon.scale.setScalar(ms)
    // v2e: the near side (the map's longitude 0) faces the lens, as it does from Earth
    _d.copy(m).negate().normalize()
    this.moon.rotation.set(0, Math.atan2(-_d.z, _d.x), 0, 'YXZ')
  }
  /** v3b, the tablet: Earth and Moon at fixed spots of the glass's display (ndc of the drawn picture, through the portal
   *  camera `cam`; radius as an angle), handed over to the journey's places by h (the portal's convergence, 0..1) */
  aim(cam: THREE.Camera, eN: number[], eA: number, mN: number[], mA: number, h: number) {
    const k = h * h * (3 - 2 * h)
    _d.set(eN[0], eN[1], 0.5).unproject(cam).sub(cam.position).normalize().multiplyScalar(EARTH_D).lerp(this.e0, k).setLength(EARTH_D)
    _f.set(mN[0], mN[1], 0.5).unproject(cam).sub(cam.position).normalize().multiplyScalar(MOON_D).lerp(this.m0, k).setLength(MOON_D)
    _r.copy(_d); _u.copy(_f)
    this.set(_r, EARTH_D * eA + (this.es0 - EARTH_D * eA) * k, _u, MOON_D * mA + (this.ms0 - MOON_D * mA) * k)
  }
  setGain(g: number) { this.earthMat.uniforms.u_gain.value = g; this.moonMat.uniforms.u_gain.value = g; this.haloMat.uniforms.u_gain.value = g }
  update(time: number, opacity: number) {
    this.earthMat.uniforms.u_spin.value = (time * 0.0025) % 1
    this.earthMat.uniforms.u_opacity.value = opacity; this.moonMat.uniforms.u_opacity.value = opacity
    this.group.visible = opacity > 0.001
    this.moon.visible = moonReady.v   // v2e: no blank disc before its map arrives (26 KB, loads at stage build)
    this.earth.visible = earthReady.v && opacity > 0.999
    this.halo.visible = this.earth.visible; this.haloMat.uniforms.u_opacity.value = opacity   // v2i: opaque, so it hides (it is behind the closed tube by the time the stars fade)   // no black disc before the day map arrives (it loads at stage build, long before 47 %)
  }
  dispose() { earthMats.delete(this.earthMat); moonMats.delete(this.moonMat); this.earthMat.dispose(); this.moonMat.dispose(); this.haloMat.dispose() }
}

// ---------------------------------------------------------------- rocks + dust (part of the sky since R6.87)
const ROCKS = 7
const DUST = 420
const DUST_VS = /* glsl */ `
attribute float aSize; attribute float aSeed;
uniform float u_time, u_pr, u_opacity;
varying float vA; varying float vSeed; varying float vBokeh;
void main(){
  vec3 p = position;
  p += vec3(sin(u_time * 0.11 + aSeed * 6.0), cos(u_time * 0.09 + aSeed * 4.0), sin(u_time * 0.07 + aSeed * 9.0)) * 0.35;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 0.1);
  float px = aSize * u_pr * 42.0 / d;
  vBokeh = smoothstep(2.5, 9.0, px);
  // R6.87 (Shifat: "no ring-shaped stars"): near motes stay small soft discs (cap 14 px, was 26) and fade as they pass
  gl_PointSize = clamp(px, 1.0, 14.0 * u_pr);
  vA = u_opacity * mix(0.95, 0.18, vBokeh) * smoothstep(1.0, 4.0, d);
  vSeed = aSeed;
}`
const DUST_FS = /* glsl */ `
varying float vA; varying float vSeed; varying float vBokeh;
void main(){
  vec2 c = gl_PointCoord - 0.5; float r = length(c) * 2.0;
  float core = exp(-r * r * 7.0);
  // R6.87: the out-of-focus mote is a soft gaussian disc (the bright-rimmed bokeh read as ring-shaped stars on the push)
  float disc = exp(-r * r * 2.6) * smoothstep(1.0, 0.7, r);
  float a = mix(core, disc, vBokeh) * vA;
  vec3 col = mix(vec3(0.75, 0.84, 1.0), vec3(1.0, 0.9, 0.82), step(0.7, fract(vSeed * 7.13)));
  gl_FragColor = vec4(col * a, 1.0);
}`
let rockGeo: THREE.BufferGeometry | null = null
// R7.10 PATCHER (Shifat 8:32 AM "Need better realistic models" / "Asteroids... not diamonds" / 8:56 "Reference a real one"):
// the rocks were one flat-shaded, lightly-dented icosphere (320 facets) - under the rim light every facet flashed its own
// colour and they read as cut gems. Now two real families, after NASA's own pictures:
//   EROS (NEAR, even variants): elongated, bent peanut with a saddle, beige-grey, big soft craters (+ small ones per pixel)
//   BENNU (OSIRIS-REx, odd variants): spinning-top / diamond silhouette, dark charcoal rubble pile, boulders + gravel grain
// Smooth normals, matte low albedo. All variants live in one geometry; each instance keeps one (iVar) and the vertex shader
// collapses the others to a point (no fragments): one draw, the extra work is vertex-only.
const ROCK_VARIANTS = 2
function rockRand(seed: number) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647) }
function rockNoise(seed: number) {
  // 3D value noise on a hashed lattice (smoothstep-interpolated), deterministic per seed
  const h = (x: number, y: number, z: number) => { const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453; return n - Math.floor(n) }
  const sm = (t: number) => t * t * (3 - 2 * t)
  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = sm(x - xi), yf = sm(y - yi), zf = sm(z - zi)
    const l = (a: number, b: number, t: number) => a + (b - a) * t
    return l(l(l(h(xi, yi, zi), h(xi + 1, yi, zi), xf), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), xf), yf),
      l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), xf), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), xf), yf), zf) * 2 - 1
  }
}
function rockVariant(k: number) {
  const eros = k % 2 === 0
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, 3))   // indexed: smooth normals across the body
  const r = rockRand(101 + k * 7919), nz = rockNoise(k + 1)
  // big craters (Eros) / big boulders (Bennu) in the mesh; the small ones are per pixel (rockMaterial)
  const feats = Array.from({ length: eros ? 4 + Math.floor(r() * 3) : 6 + Math.floor(r() * 4) }, () => ({
    d: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(),
    rad: eros ? 0.28 + r() * 0.3 : 0.14 + r() * 0.14, dep: eros ? 0.07 + r() * 0.08 : 0.035 + r() * 0.035,
  }))
  const bend = eros ? 0.18 + r() * 0.12 : 0, sq = eros ? 0.4 + r() * 0.1 : 0.88 + r() * 0.1
  const p = g.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3(), n = p.count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(p, i).normalize()
    const lump = nz(v.x * 1.5, v.y * 1.5, v.z * 1.5) * (eros ? 0.1 : 0.07) + nz(v.x * 3.4 + 5, v.y * 3.4, v.z * 3.4) * (eros ? 0.04 : 0.05)
    let f = 0, floor = 0
    for (const c of feats) {
      const t = Math.acos(Math.min(1, Math.max(-1, v.dot(c.d)))) / c.rad
      if (eros) {
        if (t < 1) { f -= c.dep * (1 - t * t); floor = Math.max(floor, 1 - t) }
        f += c.dep * 0.3 * Math.exp(-(((t - 1) / 0.2) ** 2))
      } else if (t < 1) f += c.dep * (1 - t * t) * (1 - t * t)
    }
    let x: number, y: number, z: number
    if (eros) {
      // elongated (x), bent like a banana, pinched into a saddle on its upper side
      const rad = 1 + lump + f
      x = v.x * rad * 1.25; y = v.y * rad * sq; z = v.z * rad * (sq + 0.08)
      const pinch = 1 - 0.32 * Math.exp(-(((x - 0.12) / 0.38) ** 2)) * Math.min(1, Math.max(0, (v.y + 0.25) / 0.8))
      y *= pinch; z *= 1 - (1 - pinch) * 0.45
      y += bend * (x * x - 0.5)
    } else {
      // spinning top: an equatorial ridge, the poles pulled in (the diamond silhouette)
      const rad = (1.08 - 0.34 * Math.pow(Math.abs(v.y), 1.15)) * (1 + lump + f)
      x = v.x * rad; y = v.y * rad * sq; z = v.z * rad
    }
    p.setXYZ(i, x, y, z)
    const mot = 0.9 + nz(v.x * 4 + 3, v.y * 4, v.z * 4) * 0.12
    const shade = mot * (1 - floor * 0.35)
    if (eros) col.set([shade * 1.02, shade, shade * 0.95], i * 3)
    else col.set([shade * 0.6, shade * 0.6, shade * 0.6], i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setAttribute('aVar', new THREE.BufferAttribute(new Float32Array(n).fill(k), 1))
  g.computeVertexNormals()
  return g
}
function rockGeometry() {
  if (rockGeo) return rockGeo
  const parts = Array.from({ length: ROCK_VARIANTS }, (_, k) => rockVariant(k))
  const ng = mergeGeometries(parts)!
  parts.forEach((g) => g.dispose())
  // which body each of the ROCKS instances keeps (instance attribute; the same 7 instances in both scenes)
  ng.setAttribute('iVar', new THREE.InstancedBufferAttribute(new Float32Array([0, 1, 0, 1, 1, 0, 1]), 1))
  ng.computeBoundingSphere()
  rockGeo = ng
  return ng
}
let dustGeo: THREE.BufferGeometry | null = null
function dustGeometry() {
  if (dustGeo) return dustGeo
  let seed2 = 7; const r2 = () => ((seed2 = (seed2 * 16807) % 2147483647) / 2147483647)
  const dp = new Float32Array(DUST * 3), ds = new Float32Array(DUST), dd = new Float32Array(DUST)
  // b7-tunnel-v2c (Tester 11:46: journey stars ~unchanged vs live): these 420 near motes are the brightest "stars" in the
  // journey frame and were never cut. Same sequence, 2 of every 5 kept (168), so the kept ones stay where they were
  let k = 0
  for (let i = 0; i < DUST; i++) {
    const z = 2 + Math.pow(r2(), 1.6) * 70, spread = 0.25 + z * 0.62
    const x = (r2() * 2 - 1) * spread, y = (r2() * 2 - 1) * spread * 0.75
    const sz = 0.02 + Math.pow(r2(), 3) * 0.06, sd = r2()
    if (i % 5 >= 2) continue
    dp.set([x, y, -z], k * 3); ds[k] = sz; dd[k] = sd; k++
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(dp.subarray(0, k * 3), 3)); g.setAttribute('aSize', new THREE.BufferAttribute(ds.subarray(0, k), 1)); g.setAttribute('aSeed', new THREE.BufferAttribute(dd.subarray(0, k), 1))
  dustGeo = g
  return g
}

/** The sky's frame for this viewport: the journey's opening view (basis), the eye the glass's portal is pulled back to,
 *  the window distance and the crewmate's distance. Pure function of the viewport, so both scenes agree. */
const _I: Inner = { crew: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, walk: 0, phase: 0, float: 0, squash: 0, visible: true, cam: new THREE.Vector3(), look: new THREE.Vector3(), fov: 42, atmos: 0, stars: 1, shadow: 0 }
export function skyFrame(isPortrait: boolean, W: number, H: number) {
  const I = inner(0, _I, isPortrait)
  const tJ = journeyVisibleTan(I.fov, isPortrait, W / H)
  const tM = Math.tan(THREE.MathUtils.degToRad(vfovFor(46, 30, 74)) / 2)
  const fwd = new THREE.Vector3().subVectors(I.look, I.cam).normalize()
  const crewC = new THREE.Vector3(I.crew.x, I.crew.y + CREW_CENTER_Y, I.crew.z)
  const dC = crewC.clone().sub(I.cam).dot(fwd)
  const eye = I.cam.clone().addScaledVector(fwd, dC * (1 - tJ / tM))
  const m = new THREE.Matrix4().lookAt(eye, I.look, new THREE.Vector3(0, 1, 0))
  const basis = new THREE.Matrix4().copy(m).setPosition(0, 0, 0)
  const dWin = dC * (tJ / tM) * 0.46
  const winC = eye.clone().addScaledVector(fwd, dWin)
  return { I, tJ, tM, fwd, crewC, dC, eye, basis, dWin, winC }
}

/** R7.10 PATCHER: the rock surface, per pixel (object space, so it sticks to the tumbling body): Eros' small craters and
 *  Bennu's boulders from one 8-cell crater/boulder field with an analytic slope, regolith bumps, gravel grain in the albedo;
 *  the sky's fill light is cut to a third and the colour pulled toward grey, so a single hard terminator reads as in NASA's
 *  pictures; the variant collapse; a one-pixel analytic silhouette fade (coverage AA: the low-density layer the rocks are
 *  drawn into upsamples a soft edge instead of a stair). Same single draw, same fragment count. */
function rockMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: '#8e8e8e', roughness: 0.97, metalness: 0.0, vertexColors: true, transparent: true, depthWrite: true, fog: false })
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aVar;\nattribute float iVar;\nvarying vec3 vRkP; varying vec3 vRkM0; varying vec3 vRkM1; varying vec3 vRkM2; varying float vRkK;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRkP = position; vRkK = mod(iVar, 2.0);
        { mat3 rkM = normalMatrix * mat3(instanceMatrix); vRkM0 = normalize(rkM[0]); vRkM1 = normalize(rkM[1]); vRkM2 = normalize(rkM[2]); }
        transformed *= 1.0 - step(0.5, abs(aVar - iVar));`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRkP; varying vec3 vRkM0; varying vec3 vRkM1; varying vec3 vRkM2; varying float vRkK;
        float rkH(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        vec3 rkH3(vec3 p) { return fract(sin(vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)))) * 43758.5453); }
        float rkN(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(rkH(i), rkH(i + vec3(1, 0, 0)), f.x), mix(rkH(i + vec3(0, 1, 0)), rkH(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(rkH(i + vec3(0, 0, 1)), rkH(i + vec3(1, 0, 1)), f.x), mix(rkH(i + vec3(0, 1, 1)), rkH(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
        // 8-cell crater (eros) / boulder field: xyz = slope in object space, w = cavity (0..1, for the albedo)
        vec4 rkField(vec3 p, float fq, bool eros) {
          p *= fq; vec3 b = floor(p - 0.5); vec4 acc = vec4(0.0);
          for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) for (int k = 0; k < 2; k++) {
            vec3 c = b + vec3(float(i), float(j), float(k)); vec3 rr = rkH3(c);
            vec3 dv = p - (c + 0.25 + 0.5 * rr); float R = 0.14 + 0.28 * fract(rr.x * 7.31 + rr.y * 3.17);
            float L = max(length(dv), 1e-4), d = L / R;
            if (d < 1.5) {
              float dh;
              if (eros) { float e = exp(-((d - 1.0) * (d - 1.0)) / 0.04); dh = (d < 1.0 ? 2.6 * d * (1.0 - d * d) : 0.0) - 0.1 * e * (d - 1.0) / 0.02; acc.w = max(acc.w, 1.0 - d); }
              else { float q = max(1.0 - d * d, 0.0); dh = -4.0 * d * q; acc.w = max(acc.w, -q * 0.6); }
              acc.xyz += dh * dv / L;
            }
          }
          return acc;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        bool rkE = vRkK < 0.5;
        vec4 rkC = rkField(vRkP, rkE ? 3.6 : 10.0, rkE);
        float rkGf = rkE ? 9.0 : 26.0; float rkG = rkN(vRkP * rkGf);
        // grain finer than ~2 px aliases into speckle (the PC's half-density rock layer): swap in a coarser octave there
        rkG = mix(rkN(vRkP * rkGf * 0.38 + 3.0), rkG, clamp(1.6 - 2.2 * length(fwidth(vRkP)) * rkGf, 0.0, 1.0));   // coarser gravel there instead
        diffuseColor.rgb *= (rkE ? 0.86 + 0.24 * rkG : 0.5 + 0.95 * rkG * rkG) * (1.0 - 0.3 * max(rkC.w, 0.0)) * (1.0 + 0.35 * max(-rkC.w, 0.0));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { vec3 gO = rkC.xyz * (rkE ? 0.55 : 0.32);
          vec3 gV = mat3(vRkM0, vRkM1, vRkM2) * gO; gV -= dot(gV, normal) * normal;
          normal = normalize(normal - gV); }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.indirectDiffuse *= 0.35;`)
      .replace('#include <opaque_fragment>', `outgoingLight = mix(outgoingLight, vec3(dot(outgoingLight, vec3(0.299, 0.587, 0.114))), 0.8) * (rkE ? vec3(1.04, 1.0, 0.94) : vec3(1.0));
      #include <opaque_fragment>
      { float rkNv = dot(normalize(vNormal), normalize(vViewPosition)) - 0.12;
        gl_FragColor.a *= smoothstep(0.0, 1.0, clamp(rkNv / max(fwidth(rkNv) * 2.2, 1e-4), 0.0, 1.0)); }`)
  }
  m.customProgramCacheKey = () => 'rock710b'
  return m
}

/** The rocks + dust of the sky, one instance per scene, laid out by skyFrame and moved by the same clock. */
export class SkyExtras {
  readonly rocks: THREE.InstancedMesh
  readonly rockMat = rockMaterial()
  readonly dust: THREE.Points
  readonly dustMat = new THREE.ShaderMaterial({
    uniforms: { u_time: { value: 0 }, u_pr: { value: 1 }, u_opacity: { value: 1 } }, vertexShader: DUST_VS, fragmentShader: DUST_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  })
  private data: { p: THREE.Vector3; s: number; ax: THREE.Vector3; w: number; ph: number; st: THREE.Vector3 }[] = []
  private key = ''
  private dummy = new THREE.Object3D(); private q = new THREE.Quaternion()
  constructor() {
    this.rocks = new THREE.InstancedMesh(rockGeometry(), this.rockMat, ROCKS); this.rocks.frustumCulled = false
    this.dust = new THREE.Points(dustGeometry(), this.dustMat); this.dust.frustumCulled = false
  }
  /** rock positions for this viewport (world = the inner world's own coordinates; the same in both scenes) */
  layout(isPortrait: boolean, W: number, H: number) {
    const key = `${W}x${H}|${isPortrait}`
    if (key === this.key) return
    this.key = key
    const F = skyFrame(isPortrait, W, H)
    // two big far ones behind the crewmate, three mid, two near the glass at the edges (they leave the frame as we fly in)
    const place: [number, number, number, number][] = [
      [-0.9, 0.55, 2.6, 1.3], [1.15, -0.35, 3.1, 1.7], [0.55, 0.62, 1.15, 0.42], [-0.62, -0.5, 1.35, 0.5],
      [1.05, 0.2, 0.8, 0.3], [-1.25, -0.05, 0.35, 0.16], [0.95, -0.72, 0.28, 0.12],
    ]
    let s2 = 11; const r = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647)
    let s3 = 29; const r2 = () => ((s3 = (s3 * 16807) % 2147483647) / 2147483647)
    this.data = place.map(([x, y, z, sc]) => {
      const dz = F.dWin + z * F.dC * (F.tJ / F.tM)
      const p = new THREE.Vector3(x * 0.34 * dz, y * 0.22 * dz, -dz).applyMatrix4(F.basis).add(F.eye)
      const o = { p, s: sc * F.dC * 0.1, ax: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), w: 0.05 + r() * 0.12, ph: r() * 6.28 }
      // R7.10 PATCHER: each rock its own proportions (a fixed second stream, so the layout above is unchanged)
      return { ...o, st: new THREE.Vector3(0.8 + r2() * 0.4, 0.75 + r2() * 0.4, 0.8 + r2() * 0.35) }
    })
    // the dust's resting frame: at the window, square to the journey's opening view
    this.dust.position.copy(F.winC); this.dust.quaternion.setFromRotationMatrix(F.basis)
  }
  /** the same clock in both scenes: the rocks drift and tumble with the page time */
  update(time: number, opacity: number, dustPr: number) {
    for (let i = 0; i < this.data.length; i++) {
      const R = this.data[i]
      this.dummy.position.copy(R.p)
      this.dummy.position.y += Math.sin(time * 0.2 + R.ph) * R.s * 0.15
      this.q.setFromAxisAngle(R.ax, R.ph + time * R.w)
      this.dummy.quaternion.copy(this.q); this.dummy.scale.copy(R.st).multiplyScalar(R.s)
      this.dummy.updateMatrix(); this.rocks.setMatrixAt(i, this.dummy.matrix)
    }
    this.rocks.instanceMatrix.needsUpdate = true
    this.rockMat.opacity = opacity; this.rocks.visible = opacity > 0.002
    this.dustMat.uniforms.u_opacity.value = opacity; this.dust.visible = opacity > 0.002
    this.dustMat.uniforms.u_time.value = time; this.dustMat.uniforms.u_pr.value = dustPr
  }
  dispose() { this.rockMat.dispose(); this.dustMat.dispose() }
}

// ---------------------------------------------------------------- the dive's glide (R6.87, "gentle immersive full dive")
/** The push into the screen does not stop at the hand-off: while the journey's card crosses the viewport (the one
 *  scroll stretch where nothing moved before), the inner camera keeps gliding into the sky, from a little behind the
 *  journey's opening viewpoint to it, easing out. The glass converges on the START of that glide and the journey draws
 *  the same glide, so the two pictures are the same at every point of that scroll, in both directions. */
export const GLIDE = { frac: 0.2 }
/** R7.04 TRANSITIONS: the cubic ease-out came to a full stop over the last third of the card's crossing (≈ 1/3 viewport of
 *  scroll with a still picture), then the journey's orbit started from rest: a stop-and-go. Part linear now, so the glide
 *  still eases in but arrives still moving (end speed ~15% of its start, was 0); the pre-glide speed matches its start. ?oldtrans = 7.03 */
const OLDG = typeof location !== 'undefined' && /[?&]oldtrans/.test(location.search)
const GLIDE_LIN = 0 // R7.04 tried 0.35 (arrive moving): no visible gain headless, kept 7.03's ease
void OLDG
export const GLIDE_V0 = 3 * (1 - GLIDE_LIN) + GLIDE_LIN
function glideEase(g: number) { return (1 - GLIDE_LIN) * (1 - Math.pow(1 - g, 3)) + GLIDE_LIN * g }   // pull-back at the start of the glide, as a fraction of the crewmate's distance
let frameKey = '', frameCache: ReturnType<typeof skyFrame> | null = null
function frameFor(isPortrait: boolean, W: number, H: number) {
  const k = `${W}x${H}|${isPortrait}`
  if (k !== frameKey || !frameCache) { frameKey = k; frameCache = skyFrame(isPortrait, W, H) }
  return frameCache
}
/** 0 → 1 through the push boundary into the journey (0 before it, 1 once the journey owns the frame) */
export function glideT() {
  if (!clip.enabled) return 1
  if (clip.boundary && clip.lower === 1) return clip.t
  return clip.owner >= 1 && !clip.boundary ? 1 : 0
}
/** the inner camera's offset now (inner-world units, along the opening view): add it to the journey's opening eye */
export function glideOffset(isPortrait: boolean, W: number, H: number, out: THREE.Vector3) {
  const F = frameFor(isPortrait, W, H)
  const g = glideT(), e = glideEase(g)   // ease-out: it arrives gently at the journey's opening frame
  // R6.88 PORTAL (Shifat 10:08 PM: "0 jump cut … only smooth portal in"): the glide no longer starts from rest at the
  // hand-off. It begins inside the glass, during the push's last stretch (GLIDE_PRE: 0 → 1 as the display converges), at
  // a constant speed that equals the ease-out's speed at its start (3 × frac per boundary length), so the move into the
  // sky runs straight through the switch: no stop, no speed jump; the glass and the journey stand on the same point
  const pre = g > 0 ? 0 : GLIDE_PRE.span * GLIDE_V0 * GLIDE.frac * (1 - GLIDE_PRE.t)
  return out.copy(F.fwd).multiplyScalar(-F.dC * (GLIDE.frac * (1 - e) + pre))
}
/** R6.88 PORTAL: the dive writes these (Dive.tsx): t 0 → 1 over the push's convergence, span = its scroll / one viewport */
export const GLIDE_PRE = { t: 1, span: 0.2 }
/** R6.88b PORTAL: how far back (world units, along the opening view) the inner camera stands where the glass's picture
 *  starts converging on the journey (GLIDE_PRE.t = 0): the glide's own pull-back plus the pre-glide still to run. The
 *  tablet's portal is calibrated to end exactly there, so the crewmate only ever grows on the way in (no shrink-back). */
export function glideStartBack(isPortrait: boolean, W: number, H: number) {
  const F = frameFor(isPortrait, W, H)
  return F.dC * (GLIDE.frac + GLIDE_PRE.span * GLIDE_V0 * GLIDE.frac)
}
