import * as THREE from 'three'
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
  const sp = new Float32Array(N * 3), ss_ = new Float32Array(N), sc = new Float32Array(N * 3)
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
    sp.set([v.x * 600, v.y * 600, v.z * 600], i * 3)
    const m = Math.pow(r(), 5.5)
    ss_[i] = 0.9 + m * 2.1 + r() * 0.35
    const c = pickT(), b = 0.1 + m * 0.95
    sc.set([c.r * b, c.g * b, c.b * b], i * 3)
  }
  const stars = new THREE.BufferGeometry()
  stars.setAttribute('position', new THREE.BufferAttribute(sp, 3)); stars.setAttribute('aSize', new THREE.BufferAttribute(ss_, 1)); stars.setAttribute('aColor', new THREE.BufferAttribute(sc, 3))
  const GN = 12
  const gp = new Float32Array(GN * 3), gs = new Float32Array(GN), gc = new Float32Array(GN * 3), ga = new Float32Array(GN)
  for (let i = 0; i < GN; i++) {
    const az = -Math.PI / 2 + (r() - 0.5) * 2.6, el = (r() - 0.35) * 1.0
    v.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize()
    if (i === 0) v.set(-0.42, 0.3, -0.86).normalize()
    if (i === 1) v.set(0.5, 0.24, -0.83).normalize()
    gp.set([v.x * 580, v.y * 580, v.z * 580], i * 3)
    gs[i] = (i < 2 ? 44 : 22 + r() * 16)
    const c = temp[[0, 1, 2, 2, 3, 4][Math.floor(r() * 6)]], b = i < 2 ? 1.0 : 0.55 + r() * 0.35
    gc.set([c.r * b, c.g * b, c.b * b], i * 3)
    ga[i] = r() * Math.PI
  }
  const glints = new THREE.BufferGeometry()
  glints.setAttribute('position', new THREE.BufferAttribute(gp, 3)); glints.setAttribute('aSize', new THREE.BufferAttribute(gs, 1)); glints.setAttribute('aColor', new THREE.BufferAttribute(gc, 3)); glints.setAttribute('aAngle', new THREE.BufferAttribute(ga, 1))
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
  return g === domeGeo || g === starGeo?.stars || g === starGeo?.glints || g === rockGeo || g === dustGeo
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
function rockGeometry() {
  if (rockGeo) return rockGeo
  const g = new THREE.IcosahedronGeometry(1, 2)
  const p = g.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i)
    const n = Math.sin(v.x * 3.1 + 1.3) * Math.sin(v.y * 2.7 + 0.4) * Math.sin(v.z * 3.3 + 2.1)
    const n2 = Math.sin(v.x * 7.3) * Math.sin(v.y * 6.1 + 1.0) * Math.sin(v.z * 8.7)
    v.multiplyScalar(1 + 0.28 * n + 0.07 * n2).multiply(new THREE.Vector3(1, 0.78, 0.9))
    p.setXYZ(i, v.x, v.y, v.z)
  }
  const ng = g.toNonIndexed(); g.dispose()
  ng.computeVertexNormals()
  rockGeo = ng
  return ng
}
let dustGeo: THREE.BufferGeometry | null = null
function dustGeometry() {
  if (dustGeo) return dustGeo
  let seed2 = 7; const r2 = () => ((seed2 = (seed2 * 16807) % 2147483647) / 2147483647)
  const dp = new Float32Array(DUST * 3), ds = new Float32Array(DUST), dd = new Float32Array(DUST)
  for (let i = 0; i < DUST; i++) {
    const z = 2 + Math.pow(r2(), 1.6) * 70, spread = 0.25 + z * 0.62
    dp.set([(r2() * 2 - 1) * spread, (r2() * 2 - 1) * spread * 0.75, -z], i * 3)
    ds[i] = 0.02 + Math.pow(r2(), 3) * 0.06; dd[i] = r2()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(dp, 3)); g.setAttribute('aSize', new THREE.BufferAttribute(ds, 1)); g.setAttribute('aSeed', new THREE.BufferAttribute(dd, 1))
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

/** The rocks + dust of the sky, one instance per scene, laid out by skyFrame and moved by the same clock. */
export class SkyExtras {
  readonly rocks: THREE.InstancedMesh
  readonly rockMat = new THREE.MeshStandardMaterial({ color: '#6b6e76', roughness: 0.65, metalness: 0.08, flatShading: true, transparent: true, depthWrite: true, fog: false })
  readonly dust: THREE.Points
  readonly dustMat = new THREE.ShaderMaterial({
    uniforms: { u_time: { value: 0 }, u_pr: { value: 1 }, u_opacity: { value: 1 } }, vertexShader: DUST_VS, fragmentShader: DUST_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  })
  private data: { p: THREE.Vector3; s: number; ax: THREE.Vector3; w: number; ph: number }[] = []
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
    this.data = place.map(([x, y, z, sc]) => {
      const dz = F.dWin + z * F.dC * (F.tJ / F.tM)
      const p = new THREE.Vector3(x * 0.34 * dz, y * 0.22 * dz, -dz).applyMatrix4(F.basis).add(F.eye)
      return { p, s: sc * F.dC * 0.1, ax: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), w: 0.05 + r() * 0.12, ph: r() * 6.28 }
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
      this.dummy.quaternion.copy(this.q); this.dummy.scale.setScalar(R.s)
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
export const GLIDE = { frac: 0.2 }   // pull-back at the start of the glide, as a fraction of the crewmate's distance
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
  const g = glideT(), e = 1 - Math.pow(1 - g, 3)   // ease-out: it arrives gently at the journey's opening frame
  // R6.88 PORTAL (Shifat 10:08 PM: "0 jump cut … only smooth portal in"): the glide no longer starts from rest at the
  // hand-off. It begins inside the glass, during the push's last stretch (GLIDE_PRE: 0 → 1 as the display converges), at
  // a constant speed that equals the ease-out's speed at its start (3 × frac per boundary length), so the move into the
  // sky runs straight through the switch: no stop, no speed jump; the glass and the journey stand on the same point
  const pre = g > 0 ? 0 : GLIDE_PRE.span * 3 * GLIDE.frac * (1 - GLIDE_PRE.t)
  return out.copy(F.fwd).multiplyScalar(-F.dC * (GLIDE.frac * (1 - e) + pre))
}
/** R6.88 PORTAL: the dive writes these (Dive.tsx): t 0 → 1 over the push's convergence, span = its scroll / one viewport */
export const GLIDE_PRE = { t: 1, span: 0.2 }
/** R6.88b PORTAL: how far back (world units, along the opening view) the inner camera stands where the glass's picture
 *  starts converging on the journey (GLIDE_PRE.t = 0): the glide's own pull-back plus the pre-glide still to run. The
 *  tablet's portal is calibrated to end exactly there, so the crewmate only ever grows on the way in (no shrink-back). */
export function glideStartBack(isPortrait: boolean, W: number, H: number) {
  const F = frameFor(isPortrait, W, H)
  return F.dC * (GLIDE.frac + GLIDE_PRE.span * 3 * GLIDE.frac)
}
