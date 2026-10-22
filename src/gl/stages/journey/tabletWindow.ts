import * as THREE from 'three'
import { props } from '../../../state/props'
import { settings, browser } from '../../../services/settings'
import { vfovFor } from '../../../core/frame'
import { mix, smoothstep as ss } from '../../../core/math'
import { nb } from '../../systems/neighbour'
import { FIXED_LENS } from '../../world/handoff'
import { inner, type Inner } from './timeline'
import { Crewmate, crewMaterials, CREW_CENTER_Y } from './crewmate'
import { makeEnvs } from './env'
import { skyMaterial, starMaterial, glintStarMaterial } from './shaders'
import { warmSteps as prewarmSteps, prewarm } from '../../prewarm' // PERFGOV

/**
 * TABLET WINDOW (Shifat 16:19Z: "Tablet must not show 2d thumbnail but actual 3d").
 *
 * The dive's floating tablet is a real window into the journey's space: a small 3D world (the journey's own sky dome and
 * star field, the real crewmate model at its first-frame pose, a few tumbling rocks and a layered dust field at many
 * depths) is rendered from a PORTAL camera into a render target that the glass shows.
 *
 * The portal: the display rectangle on the glass is mapped onto a rectangle in the inner world (basis = the journey's
 * opening camera). The main camera's position, taken in the glass's local frame, becomes the inner camera's position
 * (scaled by S_IN), and an off-axis frustum through the window's edges (generalised perspective projection) makes the
 * picture exactly what a hole in the glass would show: true parallax as the tablet bobs, turns and the camera moves.
 *
 * At the end of the push the camera sits at the fill distance, square to the glass: the inner camera is then at the
 * journey's opening viewpoint (pulled back along its view so the main camera's narrower lens frames the crewmate at the
 * same size), so the hand-off into the journey is the camera flying INTO the screen.
 *
 * Only the part of the window that is actually on screen is rendered (its sub-rectangle), so the resolution stays
 * constant as the screen fills the frame: a fixed allocation (cap × cap) drawn through its viewport at ~0.6 × DPR of the
 * window's projected size, capped (640 phones, 1024 otherwise). Rendered only while the tablet is visible and on screen.
 * Same objects on every tier: only the target's resolution scales.
 */

/** the display rectangle on the glass (screen-plane local units; the plane is 1.5 × 1.0, the display inset inside it) */
export const WIN_HW = 0.69, WIN_HH = 0.44
const PLANE_W = 1.5, PLANE_H = 1.0
/** iPad Pro 13" (Shifat 12:10Z, Oct 21): the cover glass outline inside that UV frame — a uniform 0.045 bezel around the
 *  display (8.7 mm on 281.6 mm, to scale) with corners concentric to the display's (0.03 + 0.045) — and the slab's depth
 *  (5.1 mm on the same scale). The display rectangle above is unchanged. */
export const IPAD_GLASS = { hw: WIN_HW + 0.045, hh: WIN_HH + 0.045, r: 0.075 }
export const IPAD_T = 0.0266
const ROCKS = 7
/** The journey's visible lens at p = 0, as its screen covers the viewport (JourneyStage: sw × sh screen, OVERSCAN, the
 *  ultrawide widening): the vertical tan of what the viewer actually sees. SCENE may change the crop (journey glass
 *  fitted at dFillJ); set JOURNEY_LENS.crop to match and the hand-off follows. */
export const JOURNEY_LENS = { crop: 1.14 }
export function journeyVisibleTan(fovDeg: number, isPortrait: boolean, aspect: number) {
  const sw = isPortrait ? 8.8 : 12.8, sh = isPortrait ? 12.8 : 8.8
  const wideK = isPortrait ? 1 : Math.max(1, aspect / 1.6)
  const fillH = Math.min(sh / JOURNEY_LENS.crop, sw / (JOURNEY_LENS.crop * aspect))
  return Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * wideK * (fillH / sh)
}
const DUST = 420


// the tablet's pose (rise, bob, and with the fixed lens its travel to the camera) lives in world/handoff.ts (SCENE lane)

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
  // near motes are big soft discs (out of focus), far ones crisp pinpoints
  float px = aSize * u_pr * 42.0 / d;
  vBokeh = smoothstep(2.5, 9.0, px);
  gl_PointSize = clamp(px, 1.0, 26.0 * u_pr);
  vA = u_opacity * mix(0.95, 0.22, vBokeh) * smoothstep(1.0, 4.0, d);
  vSeed = aSeed;
}`
const DUST_FS = /* glsl */ `
varying float vA; varying float vSeed; varying float vBokeh;
void main(){
  vec2 c = gl_PointCoord - 0.5; float r = length(c) * 2.0;
  float core = exp(-r * r * 7.0);
  float disc = smoothstep(1.0, 0.82, r) * (0.55 + 0.45 * smoothstep(0.5, 0.95, r)); // bokeh: a disc with a brighter rim
  float a = mix(core, disc, vBokeh) * vA;
  vec3 col = mix(vec3(0.75, 0.84, 1.0), vec3(1.0, 0.9, 0.82), step(0.7, fract(vSeed * 7.13)));
  gl_FragColor = vec4(col * a, 1.0);
}`

/** the glass: the portal image recessed under a thin-film coated cover glass, a bezel, the stone's caustic sweeping across */
const GLASS_VS = /* glsl */ `
varying vec2 vUv; varying vec3 vWP; varying vec3 vWN;
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz; vWN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`
const GLASS_FS = /* glsl */ `
uniform sampler2D u_rt;
uniform vec4 u_rect;      // the rendered sub-rectangle of the window (local units: x0, y0, x1, y1)
uniform vec2 u_rtScale;   // used fraction of the allocation
uniform vec2 u_texel;
uniform vec2 u_win;       // window half extents
uniform float u_time, u_on, u_sweep, u_fill, u_live, u_sheen;
varying vec2 vUv; varying vec3 vWP; varying vec3 vWN;
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main(){
  vec2 lp = (vUv - 0.5) * vec2(${PLANE_W.toFixed(2)}, ${PLANE_H.toFixed(2)});
  vec3 V = normalize(cameraPosition - vWP);
  vec3 N = normalize(vWN);
  float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
  // ---- the live 3D image (only the on-screen sub-rectangle exists in the target)
  vec2 wu = (lp - u_rect.xy) / max(u_rect.zw - u_rect.xy, vec2(1e-4));
  wu = clamp(wu, u_texel * 0.5, 1.0 - u_texel * 0.5);
  vec3 img = texture2D(u_rt, wu * u_rtScale).rgb * u_live;
  float scr = sdBox(lp, u_win, 0.03);
  float inS = smoothstep(0.003, -0.003, scr);
  // the image sits a hair under the glass: a soft inner shadow along the display edge (fades as it fills the frame)
  float edge = smoothstep(0.0, 0.035, -scr);
  img *= mix(1.0, mix(0.45, 1.0, edge), 1.0 - u_fill);
  img *= mix(0.35 + 1.4 * u_on, 1.0, u_fill);
  // ---- bezel: gloss black glass
  vec3 c = mix(vec3(0.010, 0.011, 0.013), img, inS);
  // ---- the cover glass: fresnel reflection of the water above (teal light from the surface, dark below),
  // a softbox streak, a faint thin-film shimmer at grazing angles. All of it clears as the screen fills the frame.
  vec3 R = reflect(-V, N);
  float up = R.y * 0.5 + 0.5;
  vec3 envc = mix(vec3(0.004, 0.012, 0.016), vec3(0.10, 0.26, 0.30), smoothstep(0.35, 0.95, up));
  envc += vec3(0.6, 0.85, 0.95) * pow(max(dot(R, normalize(vec3(-0.35, 0.92, -0.18))), 0.0), 60.0) * 0.8;
  float F = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  vec3 film = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + 1.8 / max(ndv, 0.2) + vUv.x * 0.4));
  float glass = 1.0 - u_fill;
  c += envc * F * 1.4 * glass;
  c += film * 0.022 * pow(1.0 - ndv, 1.5) * glass * u_sheen;
  // a thin specular streak that slides with the viewing angle (so it reads as ON the glass, over the depth behind it);
  // additive on the dark of space only, so it never greys the subject; gone before the picture fills the frame
  float lum = dot(img, vec3(0.299, 0.587, 0.114));
  float sh = exp(-pow((lp.x + lp.y * 0.8 - 0.25 + (V.x - V.y) * 0.9) / 0.06, 2.0));
  c += vec3(0.07) * sh * u_sheen * (1.0 - smoothstep(0.02, 0.25, lum)) * mix(0.3, 1.0, inS);
  // the display edge: a soft inner vignette where the cover glass meets the bezel (no stroke)
  c *= mix(1.0, mix(0.6, 1.0, smoothstep(0.0, 0.012, -scr)), inS * glass);
  // the stone's caustic light passes across the glass (the light hand-off): a narrow glint, on the dark of space only
  float sw = exp(-pow((vUv.x + vUv.y * 0.35 - u_sweep) * 26.0, 2.0));
  c += vec3(0.55, 0.75, 1.0) * sw * 0.07 * glass * u_sheen * (1.0 - smoothstep(0.02, 0.25, lum));
  // CINEMATIC three-point (Shifat 18:50Z), no new lights: the key is the surface softbox in the glass above; the RIM is the
  // glass's bevelled edge catching the surface light from behind/above (strongest along the top, so the black slab
  // separates from the dark water); the FILL is a faint teal lift of the black bezel from the lens side
  vec2 hp = vec2(${IPAD_GLASS.hw.toFixed(3)}, ${IPAD_GLASS.hh.toFixed(3)});
  float dOut = sdBox(lp, hp - 0.004, ${(IPAD_GLASS.r - 0.004).toFixed(3)});
  float bevel = exp(-pow((dOut + 0.007) / 0.006, 2.0));
  float topk = 0.35 + 0.65 * smoothstep(-0.4, 0.9, lp.y / hp.y);
  c += vec3(0.55, 0.86, 0.95) * bevel * topk * (0.3 + 0.7 * (1.0 - ndv)) * 0.5 * glass;
  c += vec3(0.010, 0.030, 0.034) * 0.35 * (1.0 - inS) * (0.5 + 0.5 * pow(1.0 - ndv, 2.0)) * glass; // iPad: the bezel stays near-black (a faint fill only)
  gl_FragColor = vec4(c, 1.0);
}`

function rockGeometry() {
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
  return ng
}

let current: TabletWindow | null = null
/** for the integrator (W18's ClipComposite, SCENE's swap): how converged the glass is on the journey's p = 0 frame (0..1);
 *  1 = the glass shows exactly the journey's opening frame, so the hand-off needs no zoom or blend of its own */
export function tabletHandoff() { return current ? current.handoff.h : 0 }

export class TabletWindow {
  readonly material: THREE.ShaderMaterial
  private scene = new THREE.Scene()
  private cam = new THREE.PerspectiveCamera(40, 1, 0.05, 2000)
  private rt: THREE.WebGLRenderTarget
  private cap: number
  private envs: ReturnType<typeof makeEnvs> | null = null
  private crew: Crewmate
  private crewMats: ReturnType<typeof crewMaterials>
  private sky: THREE.Mesh; private skyMat: THREE.ShaderMaterial
  private stars: THREE.Points; private starMat: THREE.ShaderMaterial; private glintMat: THREE.ShaderMaterial
  private dust: THREE.Points; private dustMat: THREE.ShaderMaterial
  private rocks: THREE.InstancedMesh; private rockMat: THREE.MeshStandardMaterial
  private rockData: { p: THREE.Vector3; s: number; ax: THREE.Vector3; w: number; ph: number }[] = []
  private I: Inner = { crew: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, walk: 0, phase: 0, float: 0, squash: 0, visible: true, cam: new THREE.Vector3(), look: new THREE.Vector3(), fov: 42, atmos: 0, stars: 1, shadow: 0 }
  /** the window's frame in the inner world (rebuilt on resize) */
  private basis = new THREE.Matrix4()
  private winC = new THREE.Vector3()
  private sIn = 6
  private qJ = new THREE.Quaternion(); private qC = new THREE.Quaternion(); private qB = new THREE.Quaternion()
  private eye0 = new THREE.Vector3(); private dWin = 1
  private sig = new Float64Array(40); private sigOk = false
  private key = ''
  private reduced = browser.reducedMotion
  // scratch
  private m = new THREE.Matrix4(); private e = new THREE.Vector3(); private v = new THREE.Vector3(); private q = new THREE.Quaternion()
  private dummy = new THREE.Object3D()
  private compiled = false
  /** QA: the last frame's numbers */
  stats = { w: 0, h: 0, ms: 0, renders: 0, skipped: 0, rect: [0, 0, 0, 0] as number[], drawn: false }

  private screen: THREE.Mesh
  /** the tablet's own (painted) screen material: still owned and disposed by its maker; we read its scroll uniforms */
  private src: THREE.ShaderMaterial

  /**
   * Attach to the dive's tablet (UiCylinder makeTablet: children[1] is the glass plane, userData.mat its painted
   * material). The glass is switched to the portal material; the painted one keeps receiving its uniforms from the dive
   * (u_on, u_sweep, u_fill, u_time), which this reads, and its disposal disposes this too: a 3-line hook, nothing else moves.
   */
  /** PERFGOV: the newest window (UiCylinder keeps no handle; the preloader's warm-up reaches it here) */
  static last: TabletWindow | null = null
  constructor(private gl: THREE.WebGLRenderer, tablet: THREE.Group) {
    TabletWindow.last = this // PERFGOV
    this.screen = tablet.children[1] as THREE.Mesh
    this.src = tablet.userData.mat as THREE.ShaderMaterial
    tablet.userData.tw = this
    current = this
    ;(window as any).__tw = this // QA: stats (RT size, ms, renders)
    this.cap = settings.TIER === 'low' ? 640 : 1024
    this.rt = new THREE.WebGLRenderTarget(this.cap, this.cap, { type: THREE.HalfFloatType, samples: 0, depthBuffer: true, generateMipmaps: false })
    this.rt.texture.minFilter = THREE.LinearFilter; this.rt.texture.magFilter = THREE.LinearFilter
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        u_rt: { value: this.rt.texture }, u_rect: { value: new THREE.Vector4(-WIN_HW, -WIN_HH, WIN_HW, WIN_HH) },
        u_rtScale: { value: new THREE.Vector2(1, 1) }, u_texel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        u_win: { value: new THREE.Vector2(WIN_HW, WIN_HH) },
        u_time: { value: 0 }, u_on: { value: 0 }, u_sweep: { value: -1 }, u_fill: { value: 0 }, u_live: { value: 0 }, u_sheen: { value: 1 },
      },
      vertexShader: GLASS_VS, fragmentShader: GLASS_FS, toneMapped: false,
    })

    // ---- the inner world: the journey's own space
    const sc = this.scene
    this.skyMat = skyMaterial()
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), this.skyMat)
    this.sky.renderOrder = -10; this.sky.frustumCulled = false
    // far stars: the journey's recipe byte for byte (JourneyStage build(): seed 3, its per-tier counts, temperature weights,
    // brightness curve, the bright few at the same directions) so the hand-off shows the very same sky
    const low = settings.TIER === 'low'
    let seed = 3; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const MWN = new THREE.Vector3(0.55, 0.83, 0).normalize(), mwA = new THREE.Vector3(0, 0, -1), mwB = new THREE.Vector3().crossVectors(MWN, mwA).normalize()
    const N = low ? 2200 : 6500
    const sp = new Float32Array(N * 3), ssz = new Float32Array(N), scol = new Float32Array(N * 3)
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
      ssz[i] = 0.9 + m * 2.1 + r() * 0.35
      const c = pickT(), b = 0.1 + m * 0.95
      scol.set([c.r * b, c.g * b, c.b * b], i * 3)
    }
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setAttribute('aSize', new THREE.BufferAttribute(ssz, 1)); sg.setAttribute('aColor', new THREE.BufferAttribute(scol, 3))
    this.starMat = starMaterial(1)
    this.stars = new THREE.Points(sg, this.starMat); this.stars.frustumCulled = false; this.stars.renderOrder = -9
    const GN = low ? 7 : 12
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
    const gg = new THREE.BufferGeometry()
    gg.setAttribute('position', new THREE.BufferAttribute(gp, 3)); gg.setAttribute('aSize', new THREE.BufferAttribute(gs, 1)); gg.setAttribute('aColor', new THREE.BufferAttribute(gc, 3)); gg.setAttribute('aAngle', new THREE.BufferAttribute(ga, 1))
    this.glintMat = glintStarMaterial(1)
    const glints = new THREE.Points(gg, this.glintMat); glints.frustumCulled = false; glints.renderOrder = -8
    this.stars.add(glints)

    // ---- the crewmate (the real model) + the journey's space light: violet hemi, warm key from the camera side, cyan rim
    this.crewMats = crewMaterials(null)
    this.crew = new Crewmate(this.crewMats)
    const hemi = new THREE.HemisphereLight('#7a5cff', '#071a22', 0.7)
    const keyL = new THREE.DirectionalLight('#ffd2c4', 2.6); keyL.position.set(5, 6, 6)
    const rimL = new THREE.DirectionalLight('#5fd8ff', 3.4); rimL.position.set(-6, 3, -7)
    const rig = new THREE.Group(); rig.add(keyL, rimL, keyL.target, rimL.target); rig.name = 'rig'
    this.crewMats.body.userData.rim.u_crewRimCol.value = rimL.color // CINEMATIC: the Fresnel rim takes the rig's rim colour

    // ---- rocks: a few tumbling chunks at different depths (one draw)
    this.rockMat = new THREE.MeshStandardMaterial({ color: '#6b6e76', roughness: 0.65, metalness: 0.08, flatShading: true, transparent: true, depthWrite: true, fog: false })
    this.rocks = new THREE.InstancedMesh(rockGeometry(), this.rockMat, ROCKS)
    this.rocks.frustumCulled = false

    let seed2 = 7; const r2 = () => ((seed2 = (seed2 * 16807) % 2147483647) / 2147483647)
    // ---- dust: motes from just behind the glass out to the far field (one draw); the near ones go soft (bokeh)
    const dp = new Float32Array(DUST * 3), ds = new Float32Array(DUST), dd = new Float32Array(DUST)
    for (let i = 0; i < DUST; i++) {
      // a cone along -z of the window frame (built in the frame, moved into the world in layout())
      const z = 2 + Math.pow(r2(), 1.6) * 70, spread = 0.25 + z * 0.62
      dp.set([(r2() * 2 - 1) * spread, (r2() * 2 - 1) * spread * 0.75, -z], i * 3)
      ds[i] = 0.02 + Math.pow(r2(), 3) * 0.06; dd[i] = r2()
    }
    const dg = new THREE.BufferGeometry()
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3)); dg.setAttribute('aSize', new THREE.BufferAttribute(ds, 1)); dg.setAttribute('aSeed', new THREE.BufferAttribute(dd, 1))
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { u_time: { value: 0 }, u_pr: { value: 1 }, u_opacity: { value: 1 } }, vertexShader: DUST_VS, fragmentShader: DUST_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    })
    this.dust = new THREE.Points(dg, this.dustMat); this.dust.frustumCulled = false

    sc.add(this.sky, this.stars, this.rocks, this.crew.root, this.dust, hemi, rig)

    this.screen.material = this.material
    this.src.addEventListener('dispose', this.onSrcDispose)
    // env maps, programs and buffers are built in idle time 1 s after mount (well before systems progress 0.3 on any real scroll), off the scroll path (update() keeps a fallback)
    // PERFGOV: while the page's warm-up (prewarm.ts) runs, it does this in short steps (warmSteps) and this waits
    const idle = () => {
      if (prewarm.active) { this.idleT = window.setTimeout(idle, 1000); return }
      const ric = (window as any).requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => number) | undefined
      if (ric) ric(() => this.warm(), { timeout: 3000 }); else this.warm()
    }
    this.idleT = window.setTimeout(idle, 1000)
  }
  private disposed = false
  private idleT = 0
  private onSrcDispose = () => this.dispose()

  /** the inner frame: the journey's opening view, pulled back so the main camera's lens frames it the same */
  private layout(isPortrait: boolean, fillD: number) {
    const W = props.width, H = props.height
    const key = `${W}x${H}|${isPortrait}|${fillD.toFixed(3)}`
    if (key === this.key) return
    this.key = key
    const I = inner(0, this.I, isPortrait)
    // the journey's visible lens at its first frame: its inner fov (widened on ultrawide), cropped by its 1.14 overscan
    const tJ = journeyVisibleTan(I.fov, isPortrait, W / H)
    const tM = Math.tan(THREE.MathUtils.degToRad(vfovFor(46, 30, 74)) / 2)
    const fwd = this.v.subVectors(I.look, I.cam).normalize()
    const crewC = new THREE.Vector3(I.crew.x, I.crew.y + CREW_CENTER_Y, I.crew.z)
    const dC = crewC.clone().sub(I.cam).dot(fwd)
    // eye: along the opening view, at the distance where the main lens sees the crewmate at the journey's size
    const eye = I.cam.clone().addScaledVector(fwd, dC * (1 - tJ / tM))
    this.m.lookAt(eye, I.look, new THREE.Vector3(0, 1, 0))
    this.basis.copy(this.m).setPosition(0, 0, 0)
    this.qJ.setFromRotationMatrix(this.basis)
    // the mid-push framing: centred on the crewmate (it drifts to its opening spot as the tablet comes in)
    this.m.lookAt(eye, crewC, new THREE.Vector3(0, 1, 0)); this.qC.setFromRotationMatrix(this.m)
    this.eye0.copy(eye)
    // the window sits a little under halfway to the crewmate: the crewmate floats well behind the glass
    const dWin = dC * (tJ / tM) * 0.46
    this.dWin = dWin
    this.sIn = dWin / Math.max(0.05, fillD)
    this.winC.copy(eye).addScaledVector(fwd, dWin)
    // dust: the cone, in the window frame, placed at the window
    this.dust.position.copy(this.winC); this.dust.quaternion.setFromRotationMatrix(this.basis)
    // rocks: two big far ones behind the crewmate, three mid, two near the glass at the edges (they leave the frame as we fly in)
    const place: [number, number, number, number][] = [
      [-0.9, 0.55, 2.6, 1.3], [1.15, -0.35, 3.1, 1.7], [0.55, 0.62, 1.15, 0.42], [-0.62, -0.5, 1.35, 0.5],
      [1.05, 0.2, 0.8, 0.3], [-1.25, -0.05, 0.35, 0.16], [0.95, -0.72, 0.28, 0.12],
    ]
    let s2 = 11; const r = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647)
    this.rockData = place.map(([x, y, z, sc]) => {
      // x, y: fractions of a calm cone around the view (about the main lens's own reach); z: depth behind the window,
      // in units of the crewmate's distance
      const dz = dWin + z * dC * (tJ / tM)
      const p = new THREE.Vector3(x * 0.34 * dz, y * 0.22 * dz, -dz).applyMatrix4(this.basis).add(eye)
      return { p, s: sc * dC * 0.1, ax: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), w: 0.05 + r() * 0.12, ph: r() * 6.28 }
    })
    // light rig follows the crewmate
    this.scene.getObjectByName('rig')!.position.copy(I.crew)
    this.cam.quaternion.setFromRotationMatrix(this.basis)
    this.sky.position.copy(eye); this.stars.position.copy(eye)
  }

  private ensureEnvs() {
    if (this.envs) return
    this.envs = makeEnvs(this.gl)
    this.crewMats.body.envMap = this.envs.space; this.crewMats.body.envMapIntensity = 1.0
    this.crewMats.visor.envMap = this.envs.page; this.crewMats.visor.envMapIntensity = 3.0
    this.crewMats.body.needsUpdate = true; this.crewMats.visor.needsUpdate = true
    this.envs.forest.dispose()
  }

  /** PERFGOV: warm() as short steps behind the preloader (prewarm.ts); the idle-time warm() then finds it done */
  *warmSteps(): Generator<unknown, void, unknown> {
    if (this.compiled || this.disposed) return
    this.compiled = true
    this.ensureEnvs()
    yield
    this.layout(props.height > props.width * 1.05, 1.0)
    yield* prewarmSteps(this.gl, [{ roots: [this.scene], scene: this.scene, camera: this.cam, target: this.rt }], [this.rt])
    this.tinyDraw()
  }
  /** build the expensive bits ahead of the first view (env maps + program warm-up), once */
  warm() {
    if (this.compiled || this.disposed) return
    this.compiled = true
    this.ensureEnvs()
    this.layout(props.height > props.width * 1.05, 1.0)
    const gl = this.gl, prev = gl.getRenderTarget(), prevAuto = gl.autoClear
    try {
      gl.setRenderTarget(this.rt)
      const ca = (gl as any).compileAsync as ((s: THREE.Object3D, c: THREE.Camera) => Promise<unknown>) | undefined
      if (ca) {
        // parallel shader compile where the driver has it; a tiny draw afterwards uploads the buffers
        ca.call(gl, this.scene, this.cam).then(() => this.tinyDraw()).catch(() => { /* warm-up only */ })
      } else { gl.compile(this.scene, this.cam); this.tinyDraw() }
    } catch { /* warm-up only */ } finally { gl.autoClear = prevAuto; gl.setRenderTarget(prev) }
  }
  /** one 16 × 16 draw into the target: geometry and texture uploads happen here, not on the first visible frame */
  private tinyDraw() {
    if (this.disposed) return
    const gl = this.gl, prev = gl.getRenderTarget(), prevAuto = gl.autoClear
    this.cam.position.copy(this.eye0); this.cam.quaternion.copy(this.qJ)
    this.cam.projectionMatrix.makePerspective(-0.02, 0.02, 0.02, -0.02, 0.05, 2000)
    this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert(); this.cam.updateMatrixWorld(true)
    this.rt.viewport.set(0, 0, 16, 16); this.rt.scissor.set(0, 0, 16, 16); this.rt.scissorTest = true
    try { gl.setRenderTarget(this.rt); gl.autoClear = false; gl.clear(true, true, false); gl.render(this.scene, this.cam) } finally { gl.autoClear = prevAuto; gl.setRenderTarget(prev) }
  }


  /**
   * Fly-in (Shifat 16:33Z: one fixed camera, no push-ins): over push FLY0 → 1 the TABLET flies to the camera, square to
   * it, until the display covers the frame; then the picture hands off to the journey's opening camera. The progress is
   * an input, so the camera path can be anything (a moving camera still works: the portal reads the camera every frame).
   */
  static FLY0 = 0.25 // POLISH-2: the fly starts earlier (more scroll), so the tablet is seen coming to the lens
  /** read-only hand-off state for the integrator: h (0..1, 1 = the glass shows exactly the journey's p = 0 frame) */
  handoff = { k: 0, h: 0, cam: this.cam as THREE.PerspectiveCamera }
  private restP = new THREE.Vector3(); private restQ = new THREE.Quaternion(); private pq = new THREE.Quaternion()
  private jq = new THREE.Quaternion(); private jEye = new THREE.Vector3(); private jLook = new THREE.Vector3()
  private fwd = new THREE.Vector3()

  /** the journey's own star size on screen (its starPr over its target's pixels per CSS px), so the hand-off matches */
  private journeyDensity(isPortrait: boolean) {
    const sw = isPortrait ? 8.8 : 12.8, sh = isPortrait ? 12.8 : 8.8
    const long = settings.TIER === 'low' ? 512 : 1024
    const rtW = isPortrait ? Math.round(long * sw / sh) : long, rtH = isPortrait ? long : Math.round(long * sh / sw)
    const aspect = props.width / Math.max(1, props.height)
    const fillH = Math.min(sh / JOURNEY_LENS.crop, sw / (JOURNEY_LENS.crop * aspect))
    const rtPerCss = rtH * (fillH / sh) / Math.max(1, props.height)
    const starPr = Math.min(props.dpr || 1, 2) * (rtW / 1024)
    return { rtPerCss, starCss: starPr / rtPerCss }
  }

  update(camera: THREE.Camera, push: number) {
    if (this.disposed) return
    const t0 = performance.now()
    const screen = this.screen, tablet = screen.parent as THREE.Object3D
    const camP = camera as THREE.PerspectiveCamera
    const isPortrait = props.height > props.width * 1.05
    const aspect = props.width / Math.max(1, props.height)
    const tM = Math.tan(THREE.MathUtils.degToRad(camP.fov) / 2)
    // the distance at which the display just over-covers the frame (2 % bleed), square to the camera
    const fillD = 0.92 * Math.min(WIN_HH / tM, WIN_HW / (tM * aspect)) // the display over-covers the frame (8 % bleed)
    this.warm()
    this.layout(isPortrait, Math.round(fillD * 20) / 20) // (the portal's scale: steady while the lens breathes)
    // ---- the fly: the tablet's own pose (UiCylinder's rise + bob) → square in front of the camera at fillD
    // POLISH-2 (Shifat 19:30Z "Tablet never came in front of camera"): the old fly went from small-in-the-distance to
    // over-covering in ~240 px of scroll, so the tablet itself was never seen in front of the lens. Now it travels to a
    // PRESENT distance where the whole slab (bezel included) fills ~72 % of the frame (k 0 → 0.5), lingers there,
    // easing a little closer (k 0.5 → 0.74), then moves the last stretch until the display covers the frame (k → 1).
    // One continuous path: no cut, no fade, no pop.
    const k = ss(TabletWindow.FLY0, 1, push)
    const kk = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
    if (k > 0 && tablet.parent && !FIXED_LENS.on) {
      tablet.updateWorldMatrix(true, false)
      tablet.matrixWorld.decompose(this.restP, this.restQ, this.v)
      camP.getWorldDirection(this.fwd)
      const a = ss(0, 0.5, k), aa = a < 0.5 ? 4 * a * a * a : 1 - Math.pow(-2 * a + 2, 3) / 2
      const presentD = Math.max(0.5 / (0.72 * tM), 0.75 / (0.72 * tM * aspect), fillD * 1.3)
      const fz = ss(0.74, 1, k)
      const dist = mix(mix(presentD, presentD * 0.9, ss(0.5, 0.74, k)), fillD, fz * fz * (3 - 2 * fz))
      // the glass sits 0.032 in front of the slab's origin (local +z faces the viewer)
      const fillP = this.e.copy(camP.position).addScaledVector(this.fwd, dist + 0.032)
      this.restP.lerp(fillP, aa)
      this.restQ.slerp(camP.quaternion, aa)
      // into the slab's parent space
      tablet.parent.updateWorldMatrix(true, false)
      this.m.copy(tablet.parent.matrixWorld).invert()
      tablet.position.copy(this.restP).applyMatrix4(this.m)
      tablet.parent.matrixWorld.decompose(this.v, this.pq, this.jEye)
      tablet.quaternion.copy(this.pq.invert().multiply(this.restQ))
      tablet.updateMatrixWorld(true)
    }
    // the hand-off: once the display covers the frame, the picture converges on the journey's opening frame
    const h = ss(0.8, 1.0, k) // POLISH-2: converges during the last stretch, once the display nears the frame
    this.handoff.k = k; this.handoff.h = h
    // the inner framing: centred on the crewmate mid-push, converging on the journey's opening aim
    this.qB.copy(this.qC).slerp(this.qJ, ss(0.15, 0.95, k))
    this.basis.makeRotationFromQuaternion(this.qB)
    this.winC.set(0, 0, -this.dWin).applyMatrix4(this.basis).add(this.eye0)
    this.dust.position.copy(this.winC); this.dust.quaternion.copy(this.qB)
    // the glass owns the frame at the hand-off: drawn last, over anything floating in the water in front of it
    const top = h > 0.9
    if (top !== (screen.renderOrder === 1000)) {
      screen.renderOrder = top ? 1000 : 11
      this.material.depthTest = !top; this.material.transparent = top
    }
    const u = this.material.uniforms, su = this.src.uniforms
    u.u_sheen.value = (1 - ss(0.55, 0.7, push)) * (isPortrait ? 0.7 : 1) // portrait: 30 % less glass sheen
    u.u_on.value = su.u_on.value; u.u_sweep.value = su.u_sweep.value; u.u_time.value = su.u_time.value
    u.u_fill.value = ss(0.55, 0.95, k) // the glass (sheen, reflections, inner shadow) clears as it fills the frame
    // ---- the eye in the glass's frame
    screen.updateWorldMatrix(true, false)
    this.m.copy(screen.matrixWorld).invert()
    const e = this.e.copy(camP.position).applyMatrix4(this.m)
    if (e.z < 0.02) { this.stats.drawn = false; return }
    // ---- the viewport's footprint on the glass (V) and the part of the window that is on screen (R)
    let vx0 = 1e9, vy0 = 1e9, vx1 = -1e9, vy1 = -1e9, ok = true
    for (let i = 0; i < 4; i++) {
      const d = this.v.set(i & 1 ? 1 : -1, i & 2 ? 1 : -1, 0.5).unproject(camP).applyMatrix4(this.m).sub(e)
      if (d.z > -1e-4) { ok = false; break }
      const t = -e.z / d.z
      const px = e.x + d.x * t, py = e.y + d.y * t
      vx0 = Math.min(vx0, px); vx1 = Math.max(vx1, px); vy0 = Math.min(vy0, py); vy1 = Math.max(vy1, py)
    }
    if (!ok) { vx0 = -WIN_HW; vy0 = -WIN_HH; vx1 = WIN_HW; vy1 = WIN_HH }
    const m = 0.02 * (1 - h) // a margin for the springs between this frame and the drawn one (none once it is the frame)
    const x0 = Math.max(-WIN_HW, vx0 - m), y0 = Math.max(-WIN_HH, vy0 - m), x1 = Math.min(WIN_HW, vx1 + m), y1 = Math.min(WIN_HH, vy1 + m)
    if (x1 <= x0 || y1 <= y0) { this.stats.drawn = false; return } // the window is off screen: nothing to draw
    // ---- resolution: ~0.62 × DPR of R's size on screen (→ the journey's own density at the hand-off), in the allocation
    const dpr = Math.min(props.dpr || 1, 2)
    const J = this.journeyDensity(isPortrait)
    const pxPerUnit = props.height / Math.max(1e-4, vy1 - vy0)
    // mid-push ~0.62 × DPR (the neighbour pass scales it down); at the hand-off at least the journey's own density, full scale
    const dens = mix(0.75 * dpr * (nb.active ? nb.scale : 1), Math.max(J.rtPerCss, 0.75 * dpr) * 1.1, h)
    let w = (x1 - x0) * pxPerUnit * dens, hh = (y1 - y0) * pxPerUnit * dens
    const big = Math.max(w, hh), lim = this.cap
    if (big > lim) { w *= lim / big; hh *= lim / big }
    w = Math.max(32, Math.round(w)); hh = Math.max(32, Math.round(hh))
    // ---- the portal camera: from the eye, square to the window, off-axis through R ...
    const s = this.sIn
    const I = this.I
    this.cam.position.set(e.x * s, e.y * s, e.z * s).applyMatrix4(this.basis).add(this.winC)
    this.cam.quaternion.setFromRotationMatrix(this.basis)
    let l = (x0 - e.x) / e.z, r = (x1 - e.x) / e.z, b = (y0 - e.y) / e.z, tp = (y1 - e.y) / e.z
    // ... converging on the journey's opening camera: its eye, its aim, its visible lens laid over the viewport footprint
    if (h > 0) {
      const tJ = journeyVisibleTan(I.fov, isPortrait, aspect), tJx = tJ * aspect
      const map = (x: number, a0: number, a1: number, lo: number, hi: number) => lo + (x - a0) / Math.max(1e-6, a1 - a0) * (hi - lo)
      l = mix(l, map(x0, vx0, vx1, -tJx, tJx), h); r = mix(r, map(x1, vx0, vx1, -tJx, tJx), h)
      b = mix(b, map(y0, vy0, vy1, -tJ, tJ), h); tp = mix(tp, map(y1, vy0, vy1, -tJ, tJ), h)
      this.jEye.copy(I.cam); this.jLook.copy(I.look)
      this.m.lookAt(this.jEye, this.jLook, this.v.set(0, 1, 0)); this.jq.setFromRotationMatrix(this.m)
      this.cam.position.lerp(this.jEye, h); this.cam.quaternion.slerp(this.jq, h)
    }
    const n = 0.05, f = 2000
    this.cam.projectionMatrix.makePerspective(l * n, r * n, tp * n, b * n, n, f)
    this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert()
    this.cam.updateMatrixWorld(true)
    this.sky.position.copy(this.cam.position); this.stars.position.copy(this.cam.position)
    // ---- animate the world (time-driven drift; frozen under reduced motion, still 3D by the parallax; settles at the hand-off)
    const time = this.reduced ? 0 : props.time
    const drift = (this.reduced ? 0 : 1) * (1 - h)
    this.v.copy(I.crew); this.v.y += 0.08 * Math.sin(time * 0.5) * drift; this.v.x += 0.05 * Math.sin(time * 0.31) * drift
    this.crew.update({ pos: this.v, yaw: I.yaw + 0.16 * Math.sin(time * 0.27) * drift, pitch: I.pitch + 0.06 * Math.sin(time * 0.41) * drift, roll: I.roll + 0.1 * Math.sin(time * 0.33 + 1) * drift, walk: 0, phase: 0, float: I.float, squash: 0, scale: 1 }, 1 / 60, time, true)
    for (let i = 0; i < this.rockData.length; i++) {
      const R = this.rockData[i]
      this.dummy.position.copy(R.p)
      this.dummy.position.y += Math.sin(time * 0.2 + R.ph) * R.s * 0.15
      this.q.setFromAxisAngle(R.ax, R.ph + time * R.w)
      this.dummy.quaternion.copy(this.q); this.dummy.scale.setScalar(R.s)
      this.dummy.updateMatrix(); this.rocks.setMatrixAt(i, this.dummy.matrix)
    }
    this.rocks.instanceMatrix.needsUpdate = true
    // the extras step aside as the picture becomes the journey's opening (which has none)
    const extras = 1 - h
    this.rockMat.opacity = extras; this.rocks.visible = extras > 0.002
    this.dustMat.uniforms.u_opacity.value = extras; this.dust.visible = extras > 0.002
    this.dustMat.uniforms.u_time.value = time
    // point sizes: the target's pixels per CSS px × the journey's own on-screen star size
    const rtPerCss = hh / Math.max(1, (y1 - y0) * pxPerUnit)
    const pr = Math.max(0.5, rtPerCss * J.starCss)
    this.dustMat.uniforms.u_pr.value = rtPerCss * dpr
    this.skyMat.uniforms.u_time.value = time
    this.starMat.uniforms.u_time.value = time; this.starMat.uniforms.u_pr.value = pr
    this.glintMat.uniforms.u_time.value = time; this.glintMat.uniforms.u_pr.value = pr
    // ---- nothing moved (reduced motion, a still scroll and pointer): the target already holds this picture
    const S = this.sig, cm = camP.matrixWorld.elements, smw = screen.matrixWorld.elements
    let same = this.sigOk && !nb.active
    const put = (i: number, x: number) => { if (S[i] !== x) { same = false; S[i] = x } }
    for (let i = 0; i < 16; i++) { put(i, cm[i]); put(16 + i, smw[i]) }
    put(32, time); put(33, h); put(34, w); put(35, hh); put(36, camP.fov); put(37, k)
    this.sigOk = !nb.active
    if (same) { this.stats.drawn = true; this.stats.skipped++; return }
    // ---- draw into the sub-area of the allocation
    const gl = this.gl, prev = gl.getRenderTarget(), prevAuto = gl.autoClear
    this.rt.viewport.set(0, 0, w, hh); this.rt.scissor.set(0, 0, w, hh); this.rt.scissorTest = true
    gl.setRenderTarget(this.rt)
    gl.autoClear = false
    gl.clear(true, true, false)
    gl.render(this.scene, this.cam)
    gl.autoClear = prevAuto
    gl.setRenderTarget(prev)
    u.u_rect.value.set(x0, y0, x1, y1)
    u.u_rtScale.value.set(w / this.cap, hh / this.cap)
    u.u_texel.value.set(1 / w, 1 / hh)
    u.u_live.value = 1
    const st = this.stats
    st.w = w; st.h = hh; st.rect = [x0, y0, x1, y1]; st.renders++; st.drawn = true
    st.ms = st.ms * 0.9 + (performance.now() - t0) * 0.1
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (current === this) current = null
    clearTimeout(this.idleT)
    this.src.removeEventListener('dispose', this.onSrcDispose)
    this.rt.dispose(); this.material.dispose()
    this.scene.traverse((o: any) => { if (o.geometry) o.geometry.dispose() })
    this.skyMat.dispose(); this.starMat.dispose(); this.glintMat.dispose(); this.dustMat.dispose(); this.rockMat.dispose()
    this.crewMats.body.dispose(); this.crewMats.visor.dispose()
    if (this.envs) { this.envs.space.dispose(); this.envs.page.dispose() }
  }
}
