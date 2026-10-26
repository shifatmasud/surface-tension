import * as THREE from 'three'
import { props } from '../../../state/props'
import { settings, browser } from '../../../services/settings'
import { vfovFor } from '../../../core/frame'
import { mix, smoothstep as ss } from '../../../core/math'
import { nb } from '../../systems/neighbour'
import { FIXED_LENS } from '../../world/handoff'
import { PORTAL0, dive, portalKe } from '../dive/diveState' // R6.88b
import { inner, type Inner } from './timeline'
import { Crewmate, crewMaterials, CREW_CENTER_Y } from './crewmate'
import { makeEnvs, makeEnvsSteps } from './env'
import { CrewLayer } from './crewLayer' // R6.87 SPLIT: the crewmate at the canvas density
import { heroPass } from '../../post/heroPass'
import { SPLIT } from '../../quality'
import { buildSpaceSky, SkyExtras, EarthMoon, EM_PLACE, SPACE_LIGHT, starPrFor, isSharedSkyGeometry, JOURNEY_LENS, journeyVisibleTan, glideOffset, glideT, GLIDE_PRE, glideStartBack, SPACE_RICH } from './spaceSky' // R6.87: ONE sky (the journey's), shared
import { warmSteps as prewarmSteps, prewarm, runToEnd } from '../../prewarm' // PERFGOV

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
export { JOURNEY_LENS, journeyVisibleTan } // R6.87: defined once in spaceSky.ts

// the tablet's pose (rise, bob, and with the fixed lens its travel to the camera) lives in world/handoff.ts (SCENE lane)

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
uniform float u_time, u_on, u_sweep, u_fill, u_live, u_sheen, u_rot;
uniform float u_heroA;
uniform sampler2D u_crew; uniform vec2 u_crewScale; uniform vec4 u_crewBox; // R6.87: the crewmate at the canvas density (crewLayer.ts)
varying vec2 vUv; varying vec3 vWP; varying vec3 vWN;
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main(){
  vec2 lp = (vUv - 0.5) * vec2(${PLANE_W.toFixed(2)}, ${PLANE_H.toFixed(2)});
  vec3 V = normalize(cameraPosition - vWP);
  vec3 N = normalize(vWN);
  float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
  // ---- the live 3D image (only the on-screen sub-rectangle exists in the target)
  vec2 vp = u_rot > 0.5 ? vec2(-lp.y, lp.x) : lp; // R6.88b: the view frame (an upright tablet's picture stays upright)
  vec2 wu = (vp - u_rect.xy) / max(u_rect.zw - u_rect.xy, vec2(1e-4));
  wu = clamp(wu, u_texel * 0.5, 1.0 - u_texel * 0.5);
#ifdef CREW_ONLY
  // R6.87 SPLIT: the overlay (hero pass) — the crewmate alone, same mapping, same glass on top; alpha = its coverage
  // b7-space-v3: only this frame's crewmate box can show (u_crewBox: crewLayer uvBox, the drawn part's uv). Texels of the
  // crewmate target outside it (a part this frame did not draw, or an earlier, larger draw past the drawn part) never
  // reach the glass: those were the clipped partial crewmate copies on black rectangles in Shifat's tablet shot
  if (wu.x < u_crewBox.x || wu.y < u_crewBox.y || wu.x > u_crewBox.z || wu.y > u_crewBox.w) discard;
  vec4 cr = texture2D(u_crew, wu * u_crewScale);
  if (cr.a < 0.003) discard;
  vec3 img = cr.rgb / cr.a * u_live;
#else
  vec3 img = texture2D(u_rt, wu * u_rtScale).rgb * u_live;
#endif
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
  // b7-space-v3 (Shifat 10:48 AM Oct 26, his tablet screenshot): the diagonal specular streak that was here read as a
  // grey stripe across black space. Removed, and so is the caustic sweep glint below; the space stays pure black.
  // the display edge: a soft inner vignette where the cover glass meets the bezel (no stroke)
  c *= mix(1.0, mix(0.6, 1.0, smoothstep(0.0, 0.012, -scr)), inS * glass);
  // CINEMATIC three-point (Shifat 18:50Z), no new lights: the key is the surface softbox in the glass above; the RIM is the
  // glass's bevelled edge catching the surface light from behind/above (strongest along the top, so the black slab
  // separates from the dark water); the FILL is a faint teal lift of the black bezel from the lens side
  vec2 hp = vec2(${IPAD_GLASS.hw.toFixed(3)}, ${IPAD_GLASS.hh.toFixed(3)});
  float dOut = sdBox(lp, hp - 0.004, ${(IPAD_GLASS.r - 0.004).toFixed(3)});
  float bevel = exp(-pow((dOut + 0.007) / 0.006, 2.0));
  float topk = 0.35 + 0.65 * smoothstep(-0.4, 0.9, lp.y / hp.y);
  c += vec3(0.55, 0.86, 0.95) * bevel * topk * (0.3 + 0.7 * (1.0 - ndv)) * 0.5 * glass;
  c += vec3(0.010, 0.030, 0.034) * 0.35 * (1.0 - inS) * (0.5 + 0.5 * pow(1.0 - ndv, 2.0)) * glass; // iPad: the bezel stays near-black (a faint fill only)
#ifdef CREW_ONLY
  gl_FragColor = vec4(c, cr.a * inS);
#elif defined(HERO_TWIN)
  gl_FragColor = vec4(c * u_heroA, u_heroA);   // R6.89: the glass at hero density, premultiplied, fading to the low-res glass
#else
  gl_FragColor = vec4(c, 1.0);
#endif
}`

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
  private extras: SkyExtras
  /** R6.87 SPLIT: the crewmate's own target + the glass's crew-only twin */
  private crewL: CrewLayer | null = null
  private em!: EarthMoon   // b7-space-v3
  private crewMat: THREE.ShaderMaterial | null = null
  private overlay: THREE.Mesh | null = null
  private offHero = () => {}
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
  private m = new THREE.Matrix4(); private e = new THREE.Vector3(); private v = new THREE.Vector3(); private q = new THREE.Quaternion(); private v2 = new THREE.Vector2()
  private dummy = new THREE.Object3D()
  private compiled = false
  /** QA: the last frame's numbers */
  stats = { w: 0, h: 0, ms: 0, renders: 0, skipped: 0, rect: [0, 0, 0, 0] as number[], drawn: false }

  private screen: THREE.Mesh
  /** R6.89: the glass's hero-density twin (see the constructor) */
  twin: THREE.Mesh | null = null
  private twinMat: THREE.ShaderMaterial | null = null
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
        u_time: { value: 0 }, u_on: { value: 0 }, u_sweep: { value: -1 }, u_fill: { value: 0 }, u_live: { value: 0 }, u_sheen: { value: 1 }, u_rot: { value: 0 },
        u_heroA: { value: 1 },
      },
      vertexShader: GLASS_VS, fragmentShader: GLASS_FS, toneMapped: false,
    })
    // R6.87 SPLIT: the crewmate is drawn out of the background target into its own, at the canvas density, and the glass's
    // twin (same geometry, same uniforms, CREW_ONLY) draws it in the hero pass over the low-res glass
    this.material.uniforms.u_crew = { value: null }; this.material.uniforms.u_crewScale = { value: new THREE.Vector2(1, 1) }; this.material.uniforms.u_crewBox = { value: new THREE.Vector4(0, 0, 0, 0) }
    if (SPLIT) {
      this.crewL = new CrewLayer(); CrewLayer.depthFor(this.rt)
      this.material.uniforms.u_crew.value = this.crewL.rt.texture
      this.crewMat = new THREE.ShaderMaterial({ uniforms: this.material.uniforms, vertexShader: GLASS_VS, fragmentShader: GLASS_FS, toneMapped: false, defines: { CREW_ONLY: '' },
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })
      this.overlay = new THREE.Mesh(this.screen.geometry, this.crewMat); this.overlay.frustumCulled = false; this.overlay.visible = false
      this.overlay.layers.mask = this.screen.layers.mask; this.overlay.renderOrder = this.screen.renderOrder
      this.screen.add(this.overlay)
      // the hero pass touches only the crewmate's part of the glass (its uv in the drawn rectangle → the glass's plane)
      const ov = this.overlay, cl = this.crewL, R = this.material.uniforms.u_rect.value as THREE.Vector4
      // b7-space-v3: R is in the glass's VIEW frame; an upright (phone) tablet's view point (x, y) is the glass point
      // (y, -x) (the inverse of update()'s (gx, gy) -> (-gy, gx)), so the hero rect is now taken on the rotated glass
      const U = this.material.uniforms.u_rot
      ov.userData.heroRect = (cam: THREE.Camera) => cl.rectOn(ov, cam, (u, v, o) => {
        const x = R.x + u * (R.z - R.x), y = R.y + v * (R.w - R.y)
        return U.value > 0.5 ? o.set(y, -x, 0) : o.set(x, y, 0)
      })
      this.offHero = heroPass.add(this.overlay)
      // R6.89 (Shifat Oct 23 3:56 AM "treat tab dpr same as hero too"): the glass itself (its thin black bezel and the
      // display's edge, which read jagged at the background's 0.5–0.75) has a twin in the hero pass: same geometry, same
      // uniforms, drawn at the hero density over the low-res glass, just under the crewmate's twin. Once the display
      // covers the whole frame (no bezel left on screen) the twin fades out over a few % of the push, so the frame that
      // reaches the stage switch is the low-res glass exactly as in R6.88d: the zero-cut hand-off is untouched.
      this.twinMat = new THREE.ShaderMaterial({ uniforms: this.material.uniforms, vertexShader: GLASS_VS, fragmentShader: GLASS_FS, toneMapped: false, defines: { HERO_TWIN: '' },
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor })
      this.twin = new THREE.Mesh(this.screen.geometry, this.twinMat); this.twin.frustumCulled = false; this.twin.visible = false
      this.twin.layers.mask = this.screen.layers.mask; this.twin.renderOrder = this.screen.renderOrder - 0.5
      this.screen.add(this.twin)
      const offTwin = heroPass.add(this.twin), offOv = this.offHero
      this.offHero = () => { offOv?.(); offTwin() }
    }

    // ---- the inner world: the journey's own space — R6.87 SINGLE SKY: the dome, the stars, the glints, the rocks and the
    // dust come from spaceSky.ts (the very buffers the journey draws), so the glass shows the sky the camera then enters
    const sc = this.scene
    const SK = buildSpaceSky(1)
    this.sky = SK.sky; this.skyMat = SK.skyMat; this.stars = SK.stars; this.starMat = SK.starMat; this.glintMat = SK.glintMat

    // ---- the crewmate (the real model) + the journey's space light (one table: SPACE_LIGHT)
    this.crewMats = crewMaterials(null)
    this.crew = new Crewmate(this.crewMats)
    const L = SPACE_LIGHT
    const hemi = new THREE.HemisphereLight(L.hemiSky, L.hemiGround, L.hemi)
    const keyL = new THREE.DirectionalLight(L.key, L.keyI); keyL.position.set(...L.keyPos)
    const rimL = new THREE.DirectionalLight(L.rim, L.rimI); rimL.position.set(...L.rimPos)
    const rig = new THREE.Group(); rig.add(keyL, rimL, keyL.target, rimL.target); rig.name = 'rig'
    // (R6.87: the crewmate's Fresnel rim keeps the journey's own colour, so it is the same crewmate on both sides of the glass)

    // ---- the sky's rocks + dust (shared with the journey's space)
    this.extras = new SkyExtras()

    sc.add(this.sky, this.stars, this.extras.rocks, this.crew.root, this.extras.dust, hemi, rig)
    // b7-space-v3: Earth + one tiny moon, in the sky (spaceSky.ts EarthMoon), the same as the journey's
    this.em = new EarthMoon(gl); this.stars.add(this.em.group)

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
    const key = `${W}x${H}|${isPortrait}|${fillD.toFixed(3)}|${GLIDE_PRE.span.toFixed(3)}`
    if (key === this.key) return
    this.key = key
    const I = inner(0, this.I, isPortrait)
    // the journey's visible lens at its first frame: its inner fov (widened on ultrawide), cropped by its 1.14 overscan
    const tJ = journeyVisibleTan(I.fov, isPortrait, W / H)
    const tM = Math.tan(THREE.MathUtils.degToRad(vfovFor(46, 30, 74)) / 2)
    const fwd = this.v.subVectors(I.look, I.cam).normalize()
    const crewC = new THREE.Vector3(I.crew.x, I.crew.y + CREW_CENTER_Y, I.crew.z)
    const dC = crewC.clone().sub(I.cam).dot(fwd)
    // eye: along the opening view, at the distance where the main lens sees the crewmate at the size the journey shows it
    // where the glass starts converging on it (R6.88b: the glide's start, pulled back by glideStartBack — so through the
    // whole push the crewmate only grows, and the convergence lands on the same size, no shrink-back)
    const back = glideStartBack(isPortrait, W, H)
    const eye = I.cam.clone().addScaledVector(fwd, dC - (dC + back) * (tJ / tM))
    this.m.lookAt(eye, I.look, new THREE.Vector3(0, 1, 0))
    this.basis.copy(this.m).setPosition(0, 0, 0)
    this.qJ.setFromRotationMatrix(this.basis)
    // the mid-push framing: centred on the crewmate (it drifts to its opening spot as the tablet comes in)
    this.m.lookAt(eye, crewC, new THREE.Vector3(0, 1, 0)); this.qC.setFromRotationMatrix(this.m)
    this.eye0.copy(eye)
    // the window sits a little under halfway to the crewmate: the crewmate floats well behind the glass
    const dWin = (dC + back) * (tJ / tM) * 0.46
    this.dWin = dWin
    this.sIn = dWin / Math.max(0.05, fillD)
    this.winC.copy(eye).addScaledVector(fwd, dWin)
    // the sky's rocks + dust: laid out once per viewport by the shared sky (the journey's space places them identically)
    this.extras.layout(isPortrait, W, H)
    this.em.place(isPortrait, W / Math.max(1, H))   // b7-space-v3
    // light rig follows the crewmate
    this.scene.getObjectByName('rig')!.position.copy(I.crew)
    this.cam.quaternion.setFromRotationMatrix(this.basis)
    this.sky.position.copy(eye); this.stars.position.copy(eye)
  }

  private ensureEnvs() { runToEnd(this.ensureEnvsSteps()) }
  /** R6.77: the environments' PMREMs one GPU pass per step (env.ts makeEnvsSteps); run to the end it is ensureEnvs() */
  private *ensureEnvsSteps(): Generator<unknown, void, unknown> {
    if (this.envs) return
    const envs = yield* makeEnvsSteps(this.gl)
    if (this.envs || this.disposed) { envs.space.dispose(); envs.forest.dispose(); envs.page.dispose(); return }
    this.envs = envs
    this.crewMats.body.envMap = this.envs.space; this.crewMats.body.envMapIntensity = 1.0
    this.crewMats.visor.envMap = this.envs.page; this.crewMats.visor.envMapIntensity = 3.0
    this.crewMats.body.needsUpdate = true; this.crewMats.visor.needsUpdate = true
    this.envs.forest.dispose()
  }

  /** PERFGOV: warm() as short steps behind the preloader (prewarm.ts); the idle-time warm() then finds it done */
  *warmSteps(): Generator<unknown, void, unknown> {
    if (this.compiled || this.disposed) return
    this.compiled = true
    yield* this.ensureEnvsSteps()
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
  static FLY0 = PORTAL0 // R6.88b: k runs over the portal push (the camera's, Dive.tsx); the tablet itself no longer flies
  /** R6.88b: the CAMERA pushes through the glass (the tablet waits, world-fixed); the tablet-to-camera fly is off */
  static CAM_PUSH = true
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
    const starPr = starPrFor(rtW, props.dpr) // R6.87: one star size rule (spaceSky.ts)
    return { rtPerCss, starCss: starPr / rtPerCss }
  }

  update(camera: THREE.Camera, push: number) {
    if (this.disposed) return
    // R6.95: once the dive hands off to the journey, the dive's stage group is hidden (DiveStage: shown only while the dive
    // is the stage), so the slab is never on screen there; but the push stays at 1 and the glass kept drawing its inner
    // world and the crewmate layer into its targets every frame through the journey, CTA and footer (the rig: ~0.65 Mpx of
    // offscreen work per frame on the phone path, at the page's heaviest section). Off the dive nothing is drawn now; the
    // first dive frame (scrolling back up) redraws in full before the slab is shown (the stage is set before the frame runs).
    if (!nb.active && props.stage !== 'dive') {
      this.stats.drawn = false; this.sigOk = false
      if (this.overlay) this.overlay.visible = false   // b7-space-v3: never leave a neighbour pass's crewmate overlay up
      return
    }
    // b7-space-v3: a neighbour pass that ticked the tablet (its own camera, its own scale) leaves the targets and the
    // shared uniforms with its picture, whichever way it returned; the main pass that follows always redraws in full
    if (nb.active) this.sigOk = false
    const t0 = performance.now()
    const screen = this.screen, tablet = screen.parent as THREE.Object3D
    const camP = camera as THREE.PerspectiveCamera
    const isPortrait = props.height > props.width * 1.05
    const aspect = props.width / Math.max(1, props.height)
    const tM = Math.tan(THREE.MathUtils.degToRad(camP.fov) / 2)
    // the distance at which the display just over-covers the frame (2 % bleed), square to the camera
    // R6.88b UPRIGHT: phones hold the tablet upright (rolled 90° about its glass normal, UiCylinder). Everything below runs in
    // the VIEW frame of the glass — x = screen right, y = screen up — so the portal's picture stays upright: a glass point
    // (gx, gy) is (−gy, gx) in it, and the display's half extents swap
    const rot = !!tablet.userData.upright, WX = rot ? WIN_HH : WIN_HW, WY = rot ? WIN_HW : WIN_HH
    const fillD = 0.92 * Math.min(WY / tM, WX / (tM * aspect)) // the display over-covers the frame (8 % bleed) — = diveState.tabletFillDist
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
    if (k > 0 && tablet.parent && !FIXED_LENS.on && !TabletWindow.CAM_PUSH) {
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
    // the glass owns the frame at the hand-off: drawn last, over anything floating in the water in front of it
    const top = h > 0.9
    if (top !== (screen.renderOrder === 1000)) {
      screen.renderOrder = top ? 1000 : 11
      this.material.depthTest = !top; this.material.transparent = top
      if (this.overlay && this.crewMat) { this.overlay.renderOrder = screen.renderOrder; this.crewMat.depthTest = !top }
    }
    const u = this.material.uniforms, su = this.src.uniforms
    u.u_sheen.value = (1 - ss(0.2, 0.6, k)) * (isPortrait ? 0.7 : 1) // portrait: 30 % less glass sheen (R6.88b: gone early in the portal push)
    u.u_rot.value = rot ? 1 : 0
    u.u_on.value = su.u_on.value; u.u_sweep.value = su.u_sweep.value; u.u_time.value = su.u_time.value
    // the glass (sheen, reflections, inner shadow) and the screen's glow clear as it fills the frame — R6.99: at the pace of the
    // zoom (portalKe, 0.12 → 0.97), not over a short stretch of the push, so the glowing picture settles to the journey's own
    // exposure over the whole push instead of dimming in ~2 frames
    u.u_fill.value = ss(0.12, 0.97, portalKe(dive.sys))
    // ---- the eye in the glass's frame
    screen.updateWorldMatrix(true, false)
    this.m.copy(screen.matrixWorld).invert()
    const e = this.e.copy(camP.position).applyMatrix4(this.m)
    if (rot) e.set(-e.y, e.x, e.z)
    // (the corners below are rotated the same way BEFORE the eye is taken off: a rotation about the glass normal)
    if (e.z < 0.02) { this.stats.drawn = false; if (this.overlay) this.overlay.visible = false; if (this.twin) this.twin.visible = false; return }
    // ---- the viewport's footprint on the glass (V) and the part of the window that is on screen (R)
    let vx0 = 1e9, vy0 = 1e9, vx1 = -1e9, vy1 = -1e9, ok = true
    for (let i = 0; i < 4; i++) {
      const d = this.v.set(i & 1 ? 1 : -1, i & 2 ? 1 : -1, 0.5).unproject(camP).applyMatrix4(this.m)
      if (rot) d.set(-d.y, d.x, d.z)
      d.sub(e)
      if (d.z > -1e-4) { ok = false; break }
      const t = -e.z / d.z
      const px = e.x + d.x * t, py = e.y + d.y * t
      vx0 = Math.min(vx0, px); vx1 = Math.max(vx1, px); vy0 = Math.min(vy0, py); vy1 = Math.max(vy1, py)
    }
    // R6.89: the hero twin of the glass shows while any of the bezel is on screen, fading out once the display covers
    // the frame by 0 → 4 % of its height (a pure function of the pose, so scrolling back brings it back the same way)
    if (this.twin) {
      const cover = ok ? Math.min(WX - Math.max(Math.abs(vx0), Math.abs(vx1)), WY - Math.max(Math.abs(vy0), Math.abs(vy1))) / WY : -1
      // R6.99 (1366 weak PC: the twin dropped out in one frame as the bezel left, a bright → dark pop with the bezel's lit edge
      // as thin lines at both sides): the twin now dissolves over the cover 0 → 7 % (the lens reaches 12 % before the
      // switch, Dive.tsx), so it is gone before the stage switch
      const a = 1 - ss(0.0, 0.07, cover)
      this.material.uniforms.u_heroA.value = a
      this.twin.visible = a > 0.002
    }
    // R6.99: the glass's lit edge, reflections and inner shadow also clear as the last of the bezel nears the frame's edges
    // (cover -5 % → +2 %), so no thin lit line rides the frame's sides at the hand-off; a pure function of the pose
    { const cv = ok ? Math.min(WX - Math.max(Math.abs(vx0), Math.abs(vx1)), WY - Math.max(Math.abs(vy0), Math.abs(vy1))) / WY : -1
      u.u_fill.value = Math.max(u.u_fill.value, ss(-0.05, 0.02, cv)) }
    if (!ok) { vx0 = -WX; vy0 = -WY; vx1 = WX; vy1 = WY }
    const m = 0.02 * (1 - h) // a margin for the springs between this frame and the drawn one (none once it is the frame)
    const x0 = Math.max(-WX, vx0 - m), y0 = Math.max(-WY, vy0 - m), x1 = Math.min(WX, vx1 + m), y1 = Math.min(WY, vy1 + m)
    if (x1 <= x0 || y1 <= y0) { this.stats.drawn = false; if (this.overlay) this.overlay.visible = false; return } // the window is off screen: nothing to draw
    // ---- resolution: ~0.62 × DPR of R's size on screen (→ the journey's own density at the hand-off), in the allocation
    const dpr = Math.min(props.dpr || 1, 2)
    const J = this.journeyDensity(isPortrait)
    const pxPerUnit = props.height / Math.max(1e-4, vy1 - vy0)
    // mid-push ~0.62 × DPR (the neighbour pass scales it down); at the hand-off at least the journey's own density, full scale
    // R6.88 ZERO-CUT: at full cover the glass's target has exactly the journey target's pixels per CSS px (no 1.1 over-sample,
    // no DPR floor), so the stars' size and softness are the same pixels on both sides of the stage switch
    const dens = mix(0.75 * dpr * (nb.active ? nb.scale : 1), J.rtPerCss, h * h * (3 - 2 * h))
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
      this.jEye.copy(I.cam).add(glideOffset(isPortrait, props.width, props.height, this.v)); this.jLook.copy(I.look) // R6.87 GENTLE DIVE: the start of the glide
      this.m.lookAt(this.jEye, this.jLook, this.v.set(0, 1, 0)); this.jq.setFromRotationMatrix(this.m)
      this.cam.position.lerp(this.jEye, h); this.cam.quaternion.slerp(this.jq, h)
    }
    const n = 0.05, f = 2000
    this.cam.projectionMatrix.makePerspective(l * n, r * n, tp * n, b * n, n, f)
    this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert()
    this.cam.updateMatrixWorld(true)
    this.sky.position.copy(this.cam.position); this.stars.position.copy(this.cam.position)
    // b7-space-v3b: Earth + Moon sit at fixed spots of the glass's display (low-left, with margin: EM_PLACE in fractions of
    // the display's half extents), seen through this portal camera, then hand over to the journey's places as h -> 1
    { const P = isPortrait ? EM_PLACE.tall : EM_PLACE.wide
      const nx = (fx: number) => ((fx * WX - x0) / Math.max(1e-6, x1 - x0)) * 2 - 1, ny = (fy: number) => ((fy * WY - y0) / Math.max(1e-6, y1 - y0)) * 2 - 1
      const tanPerUnit = (tp - b) / Math.max(1e-6, y1 - y0)   // the picture's vertical tan per glass unit
      this.em.aim(this.cam, [nx(P.e[0]), ny(P.e[1])], P.er * WY * tanPerUnit, [nx(P.m[0]), ny(P.m[1])], P.mr * WY * tanPerUnit, h) }
    // ---- animate the world (time-driven drift; frozen under reduced motion, still 3D by the parallax; settles at the hand-off)
    const time = this.reduced ? 0 : props.time
    const drift = (this.reduced ? 0 : 1) * (1 - h)
    this.v.copy(I.crew); this.v.y += 0.08 * Math.sin(time * 0.5) * drift; this.v.x += 0.05 * Math.sin(time * 0.31) * drift
    this.crew.update({ pos: this.v, yaw: I.yaw + 0.16 * Math.sin(time * 0.27) * drift, pitch: I.pitch + 0.06 * Math.sin(time * 0.41) * drift, roll: I.roll + 0.1 * Math.sin(time * 0.33 + 1) * drift, walk: 0, phase: 0, float: I.float, squash: 0, scale: 1 }, 1 / 60, time, true)
    // point sizes: the target's pixels per CSS px × the journey's own on-screen star size
    const rtPerCss = hh / Math.max(1, (y1 - y0) * pxPerUnit)
    const pr = Math.max(0.5, rtPerCss * J.starCss)
    // R6.87 SINGLE SKY: the rocks and dust stay (Shifat 5:48 PM "Keep rocks in sky too in tablet"); they are part of the
    // journey's space now, so nothing steps aside at the hand-off. Same clock, same sizes on screen as inside.
    this.extras.update(time, 1, rtPerCss * Math.min(Math.max(props.dpr || 1, 0.6), 2))
    this.skyMat.uniforms.u_time.value = time
    this.starMat.uniforms.u_time.value = time; this.starMat.uniforms.u_pr.value = pr
    this.glintMat.uniforms.u_time.value = time; this.glintMat.uniforms.u_pr.value = pr
    this.em.update(time, 1)   // b7-space-v3
    // ---- nothing moved (reduced motion, a still scroll and pointer): the target already holds this picture
    const S = this.sig, cm = camP.matrixWorld.elements, smw = screen.matrixWorld.elements
    let same = this.sigOk && !nb.active
    const put = (i: number, x: number) => { if (S[i] !== x) { same = false; S[i] = x } }
    for (let i = 0; i < 16; i++) { put(i, cm[i]); put(16 + i, smw[i]) }
    put(32, time); put(38, glideT()); put(39, GLIDE_PRE.t); put(33, h); put(34, w); put(35, hh); put(36, camP.fov); put(37, k)
    this.sigOk = !nb.active
    if (same) { this.stats.drawn = true; this.stats.skipped++; return }
    // ---- draw into the sub-area of the allocation
    const gl = this.gl, prev = gl.getRenderTarget(), prevAuto = gl.autoClear
    this.rt.viewport.set(0, 0, w, hh); this.rt.scissor.set(0, 0, w, hh); this.rt.scissorTest = true
    gl.setRenderTarget(this.rt)
    gl.autoClear = false
    gl.clear(true, true, false)
    // R6.87 SPLIT: the background target holds the sky only; the crewmate goes into its own target at the canvas density
    const split = !!this.crewL && this.crew.root.visible
    if (split) this.crew.root.visible = false
    // R7.01 RICH: the glass shows its picture at a gain (g0 → 1 as it fills the frame); the sky in that picture is drawn at
    // mix(g0, SPACE_RICH, fill) / gain, so on screen the sky's colour goes from the tablet's rich picture straight to the
    // journey's opening (SPACE_RICH) with no dim in between; the crewmate and rocks keep the old gain exactly
    { const mu = this.material.uniforms, g0 = 0.35 + 1.4 * mu.u_on.value, f = mu.u_fill.value
      const gain = g0 + (1 - g0) * f
      this.skyMat.uniforms.u_rich.value = gain > 1e-3 ? (g0 + (SPACE_RICH - g0) * f) / gain : 1
      this.em.setGain(gain > 1e-3 ? 1 / gain : 1) }   // b7-space-v3b: Earth + Moon on screen = the journey's (the glass's glow no longer washes them out)
    gl.render(this.scene, this.cam)
    if (split) this.crew.root.visible = true
    gl.autoClear = prevAuto
    gl.setRenderTarget(prev)
    if (split && this.crewL) {
      // the window's on-screen rectangle at the canvas density (aspect = the background target's), capped at the canvas
      const hd = props.heroDpr || props.textDpr || dpr   // R6.89: the crewmate is a hero (phones 1.0)
      let cw = (x1 - x0) * pxPerUnit * hd * (nb.active ? nb.scale : 1), ch = (y1 - y0) * pxPerUnit * hd * (nb.active ? nb.scale : 1)
      const lim = Math.max(props.width, props.height) * hd * 1.05, big = Math.max(cw, ch)
      if (big > lim) { cw *= lim / big; ch *= lim / big }
      this.crewL.render(gl, this.scene, this.cam, this.crew.root, this.rt, this.v2.set(w / this.cap, hh / this.cap), cw, ch)
      ;(u.u_crewScale.value as THREE.Vector2).copy(this.crewL.scale)
      ;(u.u_crewBox.value as THREE.Vector4).copy(this.crewL.uvBox)   // b7-space-v3: the overlay shows this box only
    }
    if (this.overlay) this.overlay.visible = split
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
    if (this.overlay) { this.offHero(); this.overlay.parent?.remove(this.overlay); this.crewMat?.dispose(); this.crewL?.dispose() }
    if (this.twin) { this.twin.parent?.remove(this.twin); this.twinMat?.dispose(); this.twin = null }
    this.scene.traverse((o: any) => { if (o.geometry && !isSharedSkyGeometry(o.geometry)) o.geometry.dispose() }) // R6.87: the sky's buffers are shared with the journey
    this.skyMat.dispose(); this.starMat.dispose(); this.glintMat.dispose(); this.extras.dispose(); this.em.dispose()
    this.crewMats.body.dispose(); this.crewMats.visor.dispose()
    if (this.envs) { this.envs.space.dispose(); this.envs.page.dispose() }
  }
}
