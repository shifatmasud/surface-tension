import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { nb, useStageFrame } from '../../systems/neighbour' // NEIGHBOUR HOOK
import { MeshRefractionMaterial } from '@react-three/drei'
import { createWaterMaterial } from '../../materials/water'
import { createSkyDome, sky } from '../../shaders/sky'
import { brilliantGeometry } from './diamond'
import { createGemSheen } from '../../materials/gemSheen'
import { props } from '../../../state/props'
import { settings } from '../../../services/settings'
import { fboHelper } from '../../core/fbo'
import { pool } from '../../systems/pool'
import { input } from '../../../services/input'
import { Spring } from '../../../core/spring'
import { engine } from '../../engine'
import { dive, DIVE_LAYER } from '../dive/diveState'
import { quality } from '../../quality' // PERF HOOK
import { waterInput } from '../../water/waterInput' // WATER HOOK
import { gemMask } from '../../systems/stickerMask'

export const GEM_LAYER = 2
export const gem = { pos: new THREE.Vector3(0, 0.45, 0), radius: 0.5, touch: 0 }
/** env-capture-only layer: the studio cards the gem "sees" but the camera never does */
export const STUDIO_LAYER = 6
/** v3: the 3D Shade DS parts in the deep (seen by the camera AND by the stone's env capture, so the stone refracts them) */
export const SYSUI_LAYER = 7
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
const gemFill = { value: 0.7 }   // W23: 0.7 in the hero (the darkest navy chips lift toward the env blue), 0.85 in the dive (set per frame)
function gemPatch(fresPow: string, lod: string) {
  return (sh: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> }) => {
    sh.uniforms.w22Fill = gemFill
    sh.uniforms.w23Lift = gemLift
    sh.uniforms.w23Sil = gemSil
    // W23 (390 stepped outline): the stone's silhouette edges get analytic coverage (diamond.ts addSilhouetteAttrs): on a
    // triangle whose neighbour across an edge faces away, alpha ramps from 0 at that edge to 1 over ~1.75 scene pixels,
    // so the outline stops stepping when the phone's scene (≈1.3–1.5× density) is scaled up. No MSAA (SMAA-only rule).
    sh.vertexShader = sh.vertexShader
      .replace('varying vec3 vNormal;', 'varying vec3 vNormal;\n  attribute vec3 aSilB; attribute vec3 aSilN0; attribute vec3 aSilN1; attribute vec3 aSilN2;\n  varying vec3 vSilB; varying vec3 vSilN0; varying vec3 vSilN1; varying vec3 vSilN2;')
      .replace('gl_Position = projectionMatrix * viewMatrix * modelMatrix * transformedPosition;', 'vSilB = aSilB; mat3 w23M = mat3(modelMatrix); vSilN0 = w23M * aSilN0; vSilN1 = w23M * aSilN1; vSilN2 = w23M * aSilN2;\n    gl_Position = projectionMatrix * viewMatrix * modelMatrix * transformedPosition;')
    sh.fragmentShader = sh.fragmentShader
      .replace('uniform float bounces;', 'uniform float bounces;\n  uniform float w22Fill;\n  uniform float w23Sil;\n  uniform float w23Lift;\n  varying vec3 vSilB; varying vec3 vSilN0; varying vec3 vSilN1; varying vec3 vSilN2;')
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
      diffuseColor.rgb = max(diffuseColor.rgb, vec3(0.035, 0.075, 0.45) * (w23Lift / 0.35));
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
      float w23A = clamp(w23C / 1.75, 0.0, 1.0);
      if (w23Sil > 1.5) gl_FragColor = vec4(1.0 - w23A, w23A, 0.0, 1.0);   // QA: __gemSil = 2 shows the coverage (red = edge)
      else gl_FragColor.a *= mix(1.0, w23A, w23Sil);`)
  }
}
const gemPatchHi = gemPatch('10.0', '4.0')
const gemPatchLo = gemPatch('10.0', '3.0')

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
  const gemGeo = useMemo(() => brilliantGeometry(1), [])
  const sheen = useMemo(() => createGemSheen({ strength: 0.75 }), [])
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
    return { rt, cam, frame: 0, deep: false, lake: true, dropped: false }
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
    const s = hi ? 0.75 : 0.35  // the mirror RT holds only the stone (gem layer): crisp facets in the lake cost little
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
  const under = useMemo(() => ({ rt: new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType }), scale: hi ? 0.6 : 0.4 }), [hi])
  useEffect(() => {
    // DIAG: follows the governor too (it was sized once from props.dpr, so a DPR step left it at the old size)
    // W19: follow the governor's MOVING rung only (noRest): the rest refinement toggles on every pointer stop/start, and
    // re-allocating this target on each toggle cost the hero ~2x CPU in R5's perf tour
    const fit = () => { const d = quality.dprFor(size.width, size.height, true); const w = Math.max(2, Math.floor(size.width * d * under.scale)), h = Math.max(2, Math.floor(size.height * d * under.scale)); if (w !== under.rt.width || h !== under.rt.height) under.rt.setSize(w, h) }
    fit()
    return quality.on(fit)
  }, [size, under])
  useEffect(() => { wu.u_underTex.value = under.rt.texture }, [under, wu])

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
    gemFill.value = (window as any).__gemFill ?? (0.7 + 0.15 * Math.min(1, Math.max(0, dive.gemMix)))   // W23 (scorer-r621 #1, root 02:55Z): the hero lifts its darkest chips too (0.7; 0.85 in the dive)
    { const W = window as any; if (W.__gemFres !== undefined) (gemMesh.current.material as any).fresnel = W.__gemFres; if (W.__sheenTp !== undefined) sheen.uniforms.u_tp.value = W.__sheenTp; if (W.__sheenWarm !== undefined) sheen.uniforms.u_warm.value = W.__sheenWarm; if (W.__sheenStr !== undefined) sheen.uniforms.u_strength.value = W.__sheenStr; if (W.__gemHide !== undefined) sheenMesh.current.visible = !W.__gemHide }   // QA hooks (W22 stone A/B)
    waterMesh.current.visible = lakeOn; dome.visible = lakeOn
    waterInput.frame(camera, lakeOn)   // WATER HOOK: touch trails (even mid-scroll) + the sim's visibility
    // W18-DIVE OVER-UNDER: the lake is cut at the lens waterline for the main camera only (never in the env/mirror captures)
    if (!waterMesh.current.userData.wl) {
      waterMesh.current.userData.wl = true
      waterMesh.current.onBeforeRender = (_r, _s, cam) => { wu.u_wlClip.value = cam === camera ? dive.split : -1 }
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
      const pl = refl.plane.set(new THREE.Vector3(0, 1, 0), 0).applyMatrix4(rc.matrixWorldInverse)
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
      gl.setRenderTarget(under.rt); gl.setClearColor(0x000000, 0); gl.clear(true, true, false)
      gl.render(scene, c)
      c.layers.mask = ml
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
    env.frame++
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
        <MeshRefractionMaterial envMap={env.rt.texture as any} bounces={hi ? 3 : 2} ior={2.2} fresnel={0.85} aberrationStrength={hi ? 0.006 : 0.008} fastChroma color={new THREE.Color(0.1, 0.34, 2.1)} toneMapped onBeforeCompile={hi ? gemPatchHi : gemPatchLo} />
      </mesh>
      <mesh ref={sheenMesh} geometry={gemGeo} material={sheen.material} renderOrder={2} onUpdate={(o) => o.layers.enable(GEM_LAYER)} />
    </group>
  )
}
void sky; void engine
