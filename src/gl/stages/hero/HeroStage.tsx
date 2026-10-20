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
  fboHelper.track(water)

  // env capture for the gem (sky + lake, gem hidden), and the planar reflection of the gem for the lake
  const env = useMemo(() => {
    const rt = new THREE.WebGLCubeRenderTarget(hi ? 256 : 128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter })
    const cam = new THREE.CubeCamera(0.05, 200, rt)
    cam.children.forEach((c) => { c.layers.enable(STUDIO_LAYER); c.layers.enable(SYSUI_LAYER) })
    return { rt, cam, frame: 0, deep: false, lake: true }
  }, [hi])
  // product-photography trick: a near-white world gives a pastel stone, so the env capture alone sees a ring of
  // dark flags with bright gaps around the gem (plus a deep floor card). The facets then tile into crisp
  // dark/bright blues — a vivid stone with real sparkle — while the visible frame stays airy and white.
  const studio = useMemo(() => {
    const g = new THREE.Group()
    const dark = new THREE.MeshBasicMaterial({ color: '#05070f', side: THREE.DoubleSide, fog: false, toneMapped: false })
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
  }, [])
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
    under.rt.setSize(Math.max(2, Math.floor(size.width * props.dpr * under.scale)), Math.max(2, Math.floor(size.height * props.dpr * under.scale)))
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
    if (!vis) return
    waterMesh.current.visible = lakeOn; dome.visible = lakeOn
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
    const lift = st.lift.update(props.heroPin * 0.9 * (1 - Math.min(1, (props.resurface || 0) * 2.5)), dt)
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
    // env capture: first frames, then every 24 frames on capable tiers (every 8 while the stone is under)
    if (env.frame < 3 || (camUnder && env.frame % (dive.abyss > 0.5 ? (hi ? 3 : 8) : 30) === 0) || (hi && env.frame % (deep ? 8 : 24) === 0 && props.stage !== 'contact')) {  // contact keeps the hero's studio env: a re-capture of the bright contact field washed the pavilion out
      m.visible = false; sheenMesh.current.visible = false
      env.cam.position.copy(gem.pos)
      // camera under with the lake hidden: the env keeps the product flags only (QA __envDive=true adds the dive's water)
      const envDive = !lakeOn && ((window as any).__envDive ?? false)   // off: the dive backdrop (no depth test) wipes the flags → a pastel stone
      env.cam.children.forEach((cm) => { if (envDive) cm.layers.enable(DIVE_LAYER); else cm.layers.disable(DIVE_LAYER) })
      studio.position.copy(gem.pos); uStudio.g.position.copy(gem.pos)
      env.cam.update(gl, scene)
      m.visible = true; sheenMesh.current.visible = true
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
      <mesh ref={gemMesh} geometry={gemGeo} onUpdate={(o) => o.layers.enable(GEM_LAYER)}>
        <MeshRefractionMaterial envMap={env.rt.texture as any} bounces={hi ? 3 : 2} ior={2.2} fresnel={0.85} aberrationStrength={hi ? 0.03 : 0.02} fastChroma={!hi} color={new THREE.Color(0.1, 0.34, 2.1)} toneMapped />
      </mesh>
      <mesh ref={sheenMesh} geometry={gemGeo} material={sheen.material} renderOrder={2} onUpdate={(o) => o.layers.enable(GEM_LAYER)} />
    </group>
  )
}
void sky; void engine
