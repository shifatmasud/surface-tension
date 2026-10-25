import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { lazy, startTransition, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { props, shared } from '../state/props'
import { markWeakGpu, settings, capDpr, WEAK_WHY } from '../services/settings'
import { fboHelper, FS_VERT } from './core/fbo'
import { sliced, counted, warmSteps, prewarm, type CompileJob } from './prewarm' // PERFGOV
import { ScreenPaint } from './systems/ScreenPaint'
import { RippleSim } from './systems/RippleSim'
import { PostChain } from './post/PostChain'
import { CameraRig } from './systems/CameraRig'
import { HeroStage, heroGeoSteps } from './stages/hero/HeroStage'
import { pool } from './systems/pool'
import { ufx } from './ufx/ufx'
import { UfxLayer } from './ufx/UfxLayer'
import { engine } from './engine'
import { taskManager } from '../services/loader'
import { BLUE_NOISE_URL } from '../content/bluenoise'
import { htmlRender } from './html/htmlRender'
import { preload, warmCompile, warmGate } from '../services/preload'
import { clip, BLOCKS } from './systems/clip'
import { sections } from '../app/sections' // R6.71b: stage distance from the scroll position
import { quality, paintState } from './quality' // PERF HOOK
import { diveRays } from './stages/dive/diveState' // PERF HOOK
import { input } from '../services/input' // PERF HOOK
import { wrapFade } from '../services/wrapFade'
import { nb } from './systems/neighbour' // NEIGHBOUR HOOK
import { visuals, type Pose } from './systems/visuals'
import { makeLook } from '../state/props'
import { dive } from './stages/dive/diveState'
import { sys as sysState } from './stages/systems/state'
import { journey } from './stages/journey/journeyState'
import { Spring, Spring3 } from '../core/spring'
import { GpuFrameTimer } from './systems/perfGovernor' // SHARP HOOK: the governor's GPU frame timer
import { installShaderGuard, ShaderGuard } from './systems/shaderGuard'
import { scrollHost } from '../services/scrollHost'
import { applyRenderScale } from './renderScale'

// PRELOAD: code-split per scene. The hero is in this chunk; each later stage is its own chunk, mounted and
// shader-warmed when its block enters the ±1 window around the current block (LaterStages below).
// Shifat 15:39Z sharper 3D: every texture samples with 8x anisotropic filtering (three clamps to the GPU's max)
THREE.Texture.DEFAULT_ANISOTROPY = 8

const LATER: { name: string; load: () => Promise<ComponentType> }[] = [
  { name: 'dive', load: () => import('./stages/dive/DiveStage').then((m) => m.DiveStage as ComponentType) },
  { name: 'journey', load: () => import('./stages/journey/JourneyStage').then((m) => m.JourneyStage as ComponentType) },
]
const LAZY = LATER.map((s) => lazy(() => s.load().then((C) => ({ default: C }))))

/**
 * Shifat 14:01Z ("every big text must be the sharpest thing on screen"): the canvas backing store runs at the text
 * density while the 3D scene and the post chain render at the governor's DPR into their own targets
 * (PostChain.setSize sizes them explicitly). The final pass upscales the scene once onto the canvas, and the text layer
 * is drawn after it at the canvas density (PostChain.drawText).
 * SHARP HOOK (eng review #3/#4/#25): both densities come from ONE place (quality.dprFor / quality.textDprFor: one
 * ceiling, scene ≤ text, the text density a governor rung on phones). R3F's own dpr IS the text density, so a governor
 * step or a rest in/out resizes the canvas at most once (it used to go scene DPR → text DPR: two re-allocations and a
 * clear per toggle), and only when the text rung really changes; the DOM-rect remeasure (ufx) only runs on a real
 * window resize. The whole apply is idempotent, so the size effect and the governor listener never double up.
 */
type Sizing = { gl: THREE.WebGLRenderer; w: number; h: number; setDpr: (d: number) => void; sys: { paint: ScreenPaint; chain: PostChain }; last: { key: string; wh: string } } // SHARP HOOK
function applySizing(z: Sizing): boolean { // SHARP HOOK: returns whether anything changed
  const { gl, w, h } = z
  const dpr = quality.dprFor(w, h), td = Math.max(dpr, quality.textDprFor(w, h)), pd = quality.dprFor(w, h, true)
  const hd = quality.heroDprFor(w, h) // R6.89: the hero pass's own density (phones 1.0, desktop native)
  const key = `${w}x${h}|${dpr.toFixed(4)}|${td.toFixed(4)}|${pd.toFixed(4)}|${hd.toFixed(4)}`
  if (key === z.last.key) return false
  z.last.key = key
  props.dpr = dpr; props.textDpr = td; props.heroDpr = Math.min(td, hd)
  if (Math.abs(gl.getPixelRatio() - td) > 1e-3) z.setDpr(td) // R3F's store resizes the canvas synchronously (once)
  if (Math.abs(gl.getPixelRatio() - td) > 1e-3) gl.setPixelRatio(td) // (a store that already held td: no-op above)
  props.renderW = Math.floor(w * dpr); props.renderH = Math.floor(h * dpr)
  props.paintDpr = settings.TIER === 'low' ? Math.min(1, pd) : pd;   // R6.89: the phone trail never above 1.0
  z.sys.paint.resize(Math.floor(w * pd), Math.floor(h * pd)) // the trail sim ignores rest (and no-ops on an unchanged size)
  z.sys.chain.setSize(w, h)
  shared.u_resolution.value.set(props.renderW, props.renderH)
  const wh = `${w}x${h}`
  if (wh !== z.last.wh) { z.last.wh = wh; ufx.resize(w, h) } // DOM rects re-measure on a real resize only
  return true
}

/** Owns the frame: paint → sim → (stages already updated) → post chain. Priority 1 = R3F stops auto-render. */
function Renderer() {
  const { gl, scene, camera, size, setDpr } = useThree()
  const storeDpr = useThree((s) => s.viewport.dpr)
  const sys = useMemo(() => {
    fboHelper.init(gl)
    const paint = new ScreenPaint()
    const ripple = new RippleSim()
    ripple.clear()
    const chain = new PostChain(gl, scene, camera, ufx.under, ufx.over, ufx.camera)
    engine.paint = paint; engine.ripple = ripple; engine.chain = chain; engine.gl = gl
    return { paint, ripple, chain }
  }, [gl, scene, camera])

  const sizing = useRef({ key: '', wh: '' }) // SHARP HOOK
  useEffect(() => {
    // keep the total-pixel cap as the window changes (ultrawide / 4K / external monitor)
    // SHARP HOOK: one idempotent apply (canvas = text density, chain/paint = the governor's DPR)
    applySizing({ gl, w: size.width, h: size.height, setDpr, sys, last: sizing.current })
  }, [size, gl, sys, setDpr, storeDpr])

  // PERF HOOK: a governor step changes the DPR; the same apply re-sizes the paint, the chain and the uniforms
  // NEIGHBOUR HOOK (flash fix): a canvas resize clears it, so a step that changed anything draws one frame at once.
  // SHARP HOOK: no second resize pass any more (the size effect above finds the same key and returns).
  useEffect(() => quality.on(() => {
    const changed = applySizing({ gl, w: size.width, h: size.height, setDpr, sys, last: sizing.current }) // SHARP HOOK
    if (changed && engine.warm && props.introDone) sys.chain.render(0)
  }), [size, setDpr, gl, sys])

  useEffect(() => {
    // blue noise (generated offline with void-and-cluster, CC0 by construction)
    new THREE.TextureLoader().load(BLUE_NOISE_URL, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false
      shared.u_blueNoise.value = t
    })
    // GPU warm-up as loading tasks (PRELOAD): the hero scene + GL text compile in parallel on the driver
    // (KHR_parallel_shader_compile), into the scene pass's own target so the program keys match the first real frame.
    // The frame loop holds until they are linked, so no frame blocks on a link and the counter never freezes.
    const rt = sys.chain.composer.inputBuffer
    let n = 0
    // PERF HOOK: once the hero is linked, one curtain-hidden frame runs every post pass this tier can use (clip
    // composite, god rays, trail, SMAA/FXAA), so none of them links at its first boundary mid-scroll
    // PRELOAD: then the warm gate (services/preload.ts) builds every program of the real frame a few per frame, counted
    const done = () => { if (++n === 2) { engine.warm = true; warmGate.open(gl) } }
    // PERFGOV-3: the hero, its environment and the UFX layer now mount in their own tasks after this one (BootStager);
    // the warm-up compiles the scenes once they are all in (same programs, same order as before)
    booted.then(() => {
      taskManager.addAsync((r) => warmCompile(gl, scene, camera, scene, rt, r).then(done))
      taskManager.addAsync((r) => warmCompile(gl, ufx.under, ufx.camera, ufx.under, rt, r).then(done))
      engine.ready = true
    })
    setTimeout(() => { engine.warm = true }, 8000) // never hold the loop forever (a driver that never reports)
    htmlRender.init(gl.domElement, ufx.camera, gl)
  }, [gl, scene, camera, sys])

  const paintIdle = useRef({ last: 0, asleep: false }) // PERF HOOK
  useFrame(() => {
    const dt = props.dt
    shared.u_time.value = props.time
    shared.u_dt.value = dt
    shared.u_blueNoiseOffset.value.set(Math.random(), Math.random())
    pool.update(camera, dt)
    // PERF HOOK: the trail sim sleeps when nothing paints. On phones it only paints while a finger moves (or the page
    // scrolls), so most frames ran the sim passes + a 9-tap full-screen pass on an empty texture. Every weight reaches
    // exactly 0 within ~70 frames of the last stroke (8-bit floor), so after 120 frames (~2 s) with no input the targets
    // are cleared to rest and both stop; the first move wakes them with no stray streak. __paintSleep: QA override.
    {
      const pi = paintIdle.current
      if (props.scrollDelta !== 0 || input.hadMoved || input.isDown) pi.last = props.frame
      const asleep = props.frame - pi.last > ((window as any).__paintSleep ?? 120)
      if (asleep !== pi.asleep) {
        pi.asleep = asleep; paintState.asleep = asleep
        if (asleep) sys.paint.clear(); else (sys.paint as any).started = false
      }
      paintState.empty = asleep || props.frame - pi.last > ((window as any).__paintEmpty ?? 80)   // R7.08
      sys.paint.displayOn = !paintState.empty
      if (!asleep) sys.paint.update(dt)       // paint renders before the scene: distortion and scene shaders see this frame
    }
    { const n = (window as any).__rippleSteps ?? 1; for (let i = 0; i < n; i++) sys.ripple.update(dt) }  // __rippleSteps: QA on slow remote GPUs
    const bg = props.look.bg
    ;(scene.background as THREE.Color).copy(bg)
    if (scene.fog) (scene.fog as THREE.Fog).color.copy(props.look.fogColor)
    ufx.update()
    htmlRender.update()
    // behind the opaque intro the full chain is wasted fill: draw every 3rd frame (still warms every program)
    // so the counter keeps moving on slow GPUs and huge windows; full rate from the drop on
    if (!props.introDrop && props.frame % 3 !== 0 && !warmGate.active) return
    if (warmGate.active) sys.chain.warmAll = true // PRELOAD: every gated frame runs every pass this tier can use
    // (W21 tried re-framing the picture inside the lifting curtain (a 0.6 k lag): it walked the crewmate into the pinned
    // 'Say hi on X' pill, which sits ~20 px under its feet. The curtain lifts rigidly again; the slab is no longer empty
    // because the CTA scene now keeps drawing through the runway, Contact.tsx)
    { const cam = camera as THREE.PerspectiveCamera; if (cam.view && cam.view.enabled) cam.clearViewOffset() }
    applyRenderScale(gl, size.width, size.height, wrapFade.want || !!engine.grab) // R7.07 #10: crisp at rest, zero re-allocation
    journey.preRender?.()   // R7.08: the CTA pill's headline guard, with this frame's final camera
    sys.chain.render(dt)
    if (wrapFade.want) wrapFade.grab(gl.domElement)
    if (engine.grab) { const g = engine.grab; engine.grab = null; g(gl.domElement) }   // R6.83 GIFT: the gift's blurred still   // W21: the loop wrap freezes this exact frame (services/wrapFade.ts)
    // PRELOAD: the gate closed: every program of the real frame (every post pass, the neighbour chain, the mirror/under
    // targets) has drawn once, so the old full-size warm frame has nothing left to build (measured: it was 3.1 s of pure
    // fill on a slow GPU with the counter parked). Reset the sims the gate starved; the warm-up is done (counter → 100)
    if (warmGate.endFrame()) { sys.ripple.clear(); sys.paint.clear(); sys.chain.warmDone = true }
  }, 1)
  return null
}


/** NEIGHBOUR — the outgoing block stays live through a boundary (systems/neighbour.ts). Runs before the camera rig
 *  (priority -2): flip the clip to the still block, resolve that block's pose + look without side effects, run its
 *  stages' frame callbacks with its own dt (DOM/audio fenced inside them), draw it through the small neighbour chain,
 *  then put every shared value back exactly as it was, so the rig, the stages and the main chain see an untouched frame. */
function NeighbourPass() {
  const { camera, scene } = useThree()
  const get = useThree((s) => s.get)
  const st = useMemo(() => ({
    pose: { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 35 } as Pose,
    look: makeLook(),
    pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 35,
    bg: new THREE.Color(), fog: new THREE.Color(),
    vis: [] as (boolean | undefined)[],
    d: { camY: 0, camZ: 0, under: false, split: -1, active: false, deep: 0, star: 0, gemOn: false },
    r: { on: false, intensity: 0, scene: null as THREE.Scene | null },
    ms: 0,
    // the neighbour's own camera springs (the rig's constants): they start where the live camera was when this block
    // stopped being the live render, so the first neighbour frame continues the camera, never jumps to the pose
    cp: new Spring3({ x: 0, y: 0, z: 0 }, 0.9, 1, 0), ct: new Spring3({ x: 0, y: 0, z: 0 }, 0.9, 1, 0), cf: new Spring(35, 0.9, 1, 0),
    fwd: new THREE.Vector3(), camBlock: -1,
  }), [])
  useFrame(() => {
    const chain = engine.chain
    if (!nb.enabled || !chain || !clip.enabled || !clip.boundary || clip.cut || clip.still < 0 || !props.introDone || props.overlayOpen) { // R6.87: no outgoing render on the push hand-off
      if (nb.block >= 0) nb.reset()
      return
    }
    const [due, dt, scale] = nb.plan(clip.still, props.frame, props.dt)
    if (!due) return
    const t0 = performance.now()
    const c = camera as THREE.PerspectiveCamera
    // ---- save everything the pass may touch
    st.pos.copy(c.position); st.quat.copy(c.quaternion); st.fov = c.fov
    const stage0 = props.stage, look0 = props.look, dt0 = props.dt
    const bg = scene.background as THREE.Color | null, fog = scene.fog as THREE.Fog | null
    if (bg) st.bg.copy(bg); if (fog) st.fog.copy(fog.color)
    const D = st.d; D.camY = dive.camY; D.camZ = dive.camZ; D.under = dive.under; D.split = dive.split; D.active = dive.active; D.deep = dive.deep; D.star = dive.star; D.gemOn = dive.gemOn
    const R = st.r; R.on = diveRays.on; R.intensity = diveRays.intensity; R.scene = diveRays.scene
    const sysW = sysState.weight, jAct = journey.active
    if (!clip.flip()) return
    nb.active = true
    nb.scale = scale
    const regs = nb.stagesFor(clip.owner)
    st.vis.length = regs.length
    for (let i = 0; i < regs.length; i++) st.vis[i] = regs[i].root()?.visible
    try {
      // ---- the still block as if it were the live one
      props.stage = visuals.resolvePure(st.pose, st.look)
      // W17: the stone follows the dive in the deep: the DOM section that sets this runs in the main loop only, so the
      // neighbour pass would otherwise draw the deep with the stone hidden (Dive.tsx sets the same rule)
      dive.gemOn = props.stage === 'dive' && dive.gemMix > 0
      props.look = st.look
      props.dt = dt
      const P = st.pose
      if (st.camBlock !== clip.owner || nb.drawnAt < 0) {
        st.camBlock = clip.owner
        st.fwd.set(0, 0, -1).applyQuaternion(st.quat).multiplyScalar(P.pos.distanceTo(P.target)).add(st.pos)
        st.cp.x.reset(st.pos.x); st.cp.y.reset(st.pos.y); st.cp.z.reset(st.pos.z)
        st.ct.x.reset(st.fwd.x); st.ct.y.reset(st.fwd.y); st.ct.z.reset(st.fwd.z)
        st.cf.reset(st.fov)
      }
      const cp = st.cp.update(P.pos, dt), ct = st.ct.update(P.target, dt), cf = st.cf.update(P.fov, dt)
      c.position.set(cp.x, cp.y, cp.z); c.lookAt(ct.x, ct.y, ct.z)
      if (Math.abs(c.fov - cf) > 1e-3) { c.fov = cf; c.updateProjectionMatrix() }
      c.updateMatrixWorld()
      sysState.weight = sysState.weightRaw
      journey.active = journey.activeRaw
      const state = get()
      for (const r of regs) r.tick(state, dt)
      if (bg) bg.copy(st.look.bg); if (fog) fog.color.copy(st.look.fogColor)
      ufx.update()
      nb.texture = chain.renderNeighbour(st.look, scale, dt)
      nb.drawnAt = props.frame
      nb.renders++
    } finally {
      // ---- put it all back (the stage roots' visibility too: the main pass decides its own)
      for (let i = 0; i < regs.length; i++) { const o = regs[i].root(); if (o && st.vis[i] !== undefined) o.visible = st.vis[i]! }
      nb.active = false
      clip.unflip()
      props.stage = stage0; props.look = look0; props.dt = dt0
      c.position.copy(st.pos); c.quaternion.copy(st.quat)
      if (c.fov !== st.fov) { c.fov = st.fov; c.updateProjectionMatrix() }
      c.updateMatrixWorld()
      if (bg) bg.copy(st.bg); if (fog) fog.color.copy(st.fog)
      dive.camY = D.camY; dive.camZ = D.camZ; dive.under = D.under; dive.split = D.split; dive.active = D.active; dive.deep = D.deep; dive.star = D.star; dive.gemOn = D.gemOn
      diveRays.on = R.on; diveRays.intensity = R.intensity; diveRays.scene = R.scene
      sysState.weight = sysW; journey.active = jAct
      st.ms = st.ms * 0.9 + (performance.now() - t0) * 0.1
      nb.ms = st.ms
    }
  }, -2)
  return null
}

/** PRELOAD — sliding window (Shifat 10:51Z: "Preload before & after section of current section. No need freezing
 *  them."). The stages of the CURRENT block and the blocks right BEFORE and AFTER it are mounted, shader-warmed (parallel
 *  compile) and running; a stage that has been outside the ±1 window for 8 s is unmounted (its GPU resources are
 *  released by the stage's own cleanup) and its code stays cached, so coming back is a mount + async warm, no download.
 *  The hero stage is always mounted (it is block 0, and the lake is seen again from the dive and the contact bookend).
 *  Each later stage has its own Suspense, so one that is still arriving never hides the others.
 *  window.__stageWindow = { owner, mounted } is the live state (the perf governor's "current ±1 live" reads it). */
const BLOCK_OF = LATER.map((s) => BLOCKS.findIndex((b) => b.includes(s.name)))
function currentBlock() {
  if (clip.enabled) return clip.owner
  const i = BLOCKS.findIndex((b) => b.includes(props.stage as string))
  return i < 0 ? 0 : i
}
// PERFGOV: stages are mounted behind the odometer now; unmounting them when away (and re-mounting mid-scroll, a main-
// thread freeze) is kept only for devices reporting ≤ 1 GB. A 3 GB phone (Galaxy M02s reports 2) keeps them resident.
const LOW_MEM = ((navigator as any).deviceMemory ?? 8) < 2

/** PERFGOV (Shifat 18:48Z GO, m:191c3896: "mount the later stages behind the odometer"; 18:22Z: "0 freeze & framedrop").
 *  Every later stage is fetched, BUILT (in short steps: the journey's forest and grass were one 0.7–1.1 s task on a
 *  phone), mounted, compiled, linked and uploaded BEFORE the curtain lifts, a few ms per frame so the odometer keeps
 *  rolling, and the odometer's "next" share counts it (preload.expect / arrived). After the lift nothing is left to do:
 *  no stage mount, no program compile, no first upload anywhere down the page (prewarm.ts). Only the hold before the
 *  lift grows; the curtain itself is untouched. A stage that cannot finish (a driver that never reports) is let go
 *  after CAP_MS so the odometer never hangs. */
const behindCurtain = { expected: false, finished: false, warmed: new Set<string>(), got: new Map<string, number>(), roots: new Map<string, THREE.Group>(), t0: 0, ms: {} as Record<string, number>,
  /** R6.71b: stages the visitor reached (in view or within about one viewport) before their warm-up finished, and when */
  urgent: new Map<string, number>(), log: [] as [string, string, number][] }
;(window as any).__warmup = behindCurtain
/** R6.71b (W29 void check, 1440: a fast scroll in the first seconds after the lift showed an empty void with only the
 *  gem, the dive not mounted yet). The DOM sections each later stage draws, to measure how far it is from the viewport */
const SPAN: Record<string, string[]> = { dive: ['dive', 'lab', 'systems'], journey: ['journey', 'contact'] }
/** px between the viewport and a later stage's sections (0 = some of it on screen; 1e5 = not measured yet) */
function stageGap(name: string) {
  let top = Infinity, bot = -Infinity
  for (const s of sections.list) {
    if (!s.range || !SPAN[name]?.includes(s.name)) continue
    top = Math.min(top, s.range.docTop); bot = Math.max(bot, s.range.docTop + s.range.height)
  }
  if (top === Infinity) return 1e5
  const y0 = props.scroll, y1 = y0 + props.height
  return Math.max(0, top - y1, y0 - bot)
}
/** a reached stage that is mounted but not warm yet is drawn anyway this long after it was reached (whatever programs
 *  its rushed warm-up has not linked yet compile on the draw: a hitch, never a void). 0: at once */
const SHOW_ANYWAY_MS = 0
/** how near (in viewport heights) the viewport's edge may come to a stage that is not warm before it is rushed */
const NEAR_VIEWPORTS = 1
/** Shifat 20:07Z ("longer"): the odometer holds until every later stage is warm, in the order trail/text, dive, journey.
 *  The Intro's own 12 s cap still lets the curtain go on a device that cannot finish (this backstop only matters if
 *  that cap ever moves); what is left then finishes in short tasks after the lift, the stage in view first */
const CAP_MS = 12000
/** a stage's share of the odometer's "next" part: 0..1, never backwards */
function stageProgress(name: string, f: number) {
  const was = behindCurtain.got.get(name) ?? 0
  if (f <= was) return
  behindCurtain.got.set(name, f); preload.arrivedStages(f - was)
}
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
async function until(ok: () => boolean, maxMs = 20000) { const t0 = performance.now(); while (!ok() && performance.now() - t0 < maxMs) await nextFrame() }
/** the trail's blur pass (systems/ScreenPaint.ts, locked: its material isn't exported). A material with the same
 *  shaders gets the same program from three's cache, so compiling this twin warms the trail's own blur */
const BLUR9_TWIN = new THREE.ShaderMaterial({
  uniforms: { u_texture: { value: null }, u_delta: { value: new THREE.Vector2() } },
  vertexShader: FS_VERT, fragmentShader: "\nprecision highp float;\nuniform sampler2D u_texture; uniform vec2 u_delta; varying vec2 v_uv;\nvoid main(){\n  vec4 c = texture2D(u_texture, v_uv) * 0.1633;\n  vec2 d = u_delta;\n  c += (texture2D(u_texture, v_uv - d) + texture2D(u_texture, v_uv + d)) * 0.1531;  d += u_delta;\n  c += (texture2D(u_texture, v_uv - d) + texture2D(u_texture, v_uv + d)) * 0.12245; d += u_delta;\n  c += (texture2D(u_texture, v_uv - d) + texture2D(u_texture, v_uv + d)) * 0.0918;  d += u_delta;\n  c += (texture2D(u_texture, v_uv - d) + texture2D(u_texture, v_uv + d)) * 0.051;\n  gl_FragColor = c;\n}", depthTest: false, depthWrite: false,
})

function LaterStages() {
  const { scene: mainScene, camera: mainCam } = useThree() // PERFGOV
  const [mounted, setMounted] = useState<boolean[]>(() => {
    if (!behindCurtain.expected) { behindCurtain.expected = true; preload.expectStages(LATER.length) } // PERFGOV
    return LATER.map(() => false)
  })
  const cur = useRef(mounted)
  const away = useRef<number[]>(LATER.map(() => 0))
  const stageWin = useRef<{ owner: number; src: boolean[] | null }>({ owner: -1, src: null })   // R6.95
  useEffect(() => {
    // PERFGOV: fetch every later stage's code now, behind the odometer (it used to wait for the curtain)
    LATER.forEach((s) => { s.load().catch(() => {}) })
    let cancel = false
    const mount = (i: number) => { if (!cur.current[i]) { const n = cur.current.slice(); n[i] = true; cur.current = n; setMounted(n) } }
    const run = async () => {
      // the hero's own programs first, so the first screen keeps its head start
      await until(() => engine.warm || cancel)
      // R6.71b: later stages by distance from the scroll position (nearest first, ties in scroll order); a stage the visitor
      // has reached (in view or within about a viewport, see useFrame below) jumps to the front and RUSHES: its remaining
      // steps run to the end in one task (prewarm.ts sliced), so it mounts and draws at once
      const pri = (i: number) => () => (behindCurtain.urgent.has(LATER[i].name) ? 1e6 : 0) - stageGap(LATER[i].name) + (LATER.length - i) * 1e-3
      // R6.71b: the dive's pure-JS prebuilds (kelp/grass forest, basalt spires: geometry only, no GL call) can't be spoilt by
      // the warm gate's patched context, so they run while it is still open instead of after it (M02 rig, 6x: the gate
      // closed ~1.5 s before the lift, so everything queued behind it landed after the lift)
      const iDive = LATER.findIndex((s) => s.name === 'dive')
      const diveRush = () => behindCurtain.urgent.has('dive')
      const diveJs = iDive < 0 || cancel ? Promise.resolve() : (async () => {
        const [d, s] = await Promise.all([import('./stages/dive/DiveStage'), import('./stages/dive/DeepSea')])
        await sliced(counted(d.prebuildDiveForest(), (f) => stageProgress('dive', 0.1 * f), 10), pri(iDive), diveRush)
        await sliced(counted(s.prebuildSpires(), (f) => stageProgress('dive', 0.1 + 0.05 * f), 5), pri(iDive), diveRush)
      })().catch((e) => console.warn('[prewarm] dive js', e))
      // R6.70b: the warm gate (services/preload.ts) opens on the same frame as engine.warm and, while open, patches the GL
      // context (1x1 viewport, no clears, no mipmaps, a not-yet-built program's draw skipped). Anything a stage renders or
      // uploads once (the cylinder's and the journey's PMREM env captures, canvas labels' mipmaps, the mounts' bakes) done
      // under it comes out black for good (the silver parts' black squares at the systems). So the later stages start once it
      // has closed, still behind the curtain (the curtain's cap counts from the same moment: chain.warmDone)
      const gateShut = () => until(() => !warmGate.active || cancel)
      await gateShut()
      const gl = engine.gl
      behindCurtain.t0 = performance.now()
      // first the trail's passes (they compiled on the first touch / mouse move) and the GL text's (at the lift): few, and
      // needed on the hero itself
      if (engine.gl && engine.paint && !cancel) {
        const p = engine.paint as unknown as { material?: THREE.Material }
        const job = fboHelper.warmJob([BLUR9_TWIN, ...(p.material ? [p.material] : [])], engine.chain?.composer.inputBuffer ?? null)
        // the GL text layer's two passes (its lines into its own target, then over the canvas): first drawn at the lift
        const tx = (engine.chain as unknown as { text?: { rt: THREE.WebGLRenderTarget; scene: THREE.Scene; cam: THREE.Camera } }).text
        const jobs: CompileJob[] = [job]
        if (tx) jobs.push({ roots: [ufx.slot], scene: ufx.slot as unknown as THREE.Scene, camera: ufx.slotCamera, target: tx.rt }, { roots: [tx.scene], scene: tx.scene, camera: tx.cam, target: null })
        await sliced(warmSteps(engine.gl, jobs), () => 0, () => behindCurtain.urgent.size > 0) // a reached stage waits on this
      }
      // then every later stage, each its own pipeline sharing the one slicer: the stage the visitor is in goes first
      // (after the lift, a fast scroll into a stage that is not warm yet takes over the slices at once), then scroll order
      const stage = async (i: number) => {
        const name = LATER[i].name, t0 = performance.now(), P0 = pri(i), R = () => behindCurtain.urgent.has(name)
        const L = (phase: string) => { behindCurtain.log.push([name, phase, Math.round(performance.now())]) }
        const sl = <T,>(g: Generator<unknown, T, unknown>) => sliced(g, P0, R)
        L('start')
        try {
          await LATER[i].load()
          if (name === 'journey' && gl) { const m = await import('./stages/journey/JourneyStage'); await sl(counted(m.prebuildJourney(gl), (f) => stageProgress(name, 0.4 * f), 30)) }
          if (name === 'dive' && gl) {
            const [d, c] = await Promise.all([import('./stages/dive/DiveStage'), import('./stages/dive/UiCylinder')])
            await diveJs   // forest + spires, started under the gate (above)
            await sl(counted(c.prebuildCylinder(gl, d.diveUniforms()), (f) => stageProgress(name, 0.15 + 0.25 * f), 12))
          }
          stageProgress(name, 0.4)
          if (cancel) return
          L('mount')
          mount(i)
          await until(() => behindCurtain.roots.has(name) || cancel, 10000)
          await nextFrame()   // its effects (the extra jobs below) have run
          const g = behindCurtain.roots.get(name)
          if (g && gl && !cancel) {
            const rt = engine.chain?.composer.inputBuffer ?? null
            const ex = prewarm.extras(name)
            const jobs: CompileJob[] = [{ roots: [g], scene: mainScene, camera: mainCam, target: rt, force: g }, ...ex.flatMap((e) => e.jobs ?? [])]
            await sl(counted(warmSteps(gl, jobs, ex.flatMap((e) => e.targets ?? [])), (f) => stageProgress(name, 0.4 + 0.5 * f), 60))
            for (const e of ex) if (e.steps) await sl(counted(e.steps, (f) => stageProgress(name, 0.9 + 0.09 * f), 20))
            ;(window as any).__stages = { ...((window as any).__stages || {}), [name]: Math.round(performance.now() - t0) }
          }
          L('warm')
        } catch (e) { console.warn('[prewarm]', name, e) }
        behindCurtain.warmed.add(name)
        behindCurtain.ms[name] = Math.round(performance.now() - t0)
        stageProgress(name, 1)
      }
      if (!cancel) await Promise.all(LATER.map((_, i) => stage(i)))
      ;(window as any).__prewarmMs = { ...behindCurtain.ms, total: Math.round(performance.now() - behindCurtain.t0), lifted: props.introDone }
    }
    run().finally(() => { behindCurtain.finished = true; prewarm.active = false })
    // bounded: CAP_MS after the hero itself is ready (its warm gate closed) the odometer is let go whatever the stages'
    // state; they keep warming after the lift (as before) instead of holding the curtain on a driver that never reports
    let readyAt = 0
    const bound = () => {
      if (cancel) return
      if (!readyAt && engine.chain?.warmDone) readyAt = performance.now()
      if (readyAt && performance.now() - readyAt > CAP_MS) { LATER.forEach((s) => stageProgress(s.name, 1)); return }
      requestAnimationFrame(bound)
    }
    bound()
    return () => { cancel = true }
  }, [])
  useFrame(() => {
    if (!props.introDone) return
    const owner = currentBlock(), now = performance.now()
    // R6.71b: a stage the visitor is in, or within about one viewport of, while its warm-up has not finished: rush it
    if (!behindCurtain.finished) for (const s of LATER) {
      if (behindCurtain.warmed.has(s.name) || behindCurtain.urgent.has(s.name) || stageGap(s.name) > props.height * NEAR_VIEWPORTS) continue
      behindCurtain.urgent.set(s.name, now); behindCurtain.log.push([s.name, 'reached', Math.round(now)])
    }
    let next = cur.current   // R6.95: copied only when something changes (was a fresh array + window object every frame)
    let changed = false
    for (let i = 0; i < LATER.length; i++) {
      const inWin = Math.abs(BLOCK_OF[i] - owner) <= 1
      // wall-clock hysteresis (props.dt is capped per frame, so a slow device would hold stages far longer)
      // PERFGOV: while the warm-up behind the curtain is still running it mounts the stages itself (built in steps, the
      // stage in view first) and nothing here mounts or unmounts one
      if (!behindCurtain.finished) continue
      if (inWin) { away.current[i] = 0; if (!next[i]) { if (!changed) next = next.slice(); next[i] = true; changed = true } }
      else if (next[i] && LOW_MEM) { if (!away.current[i]) away.current[i] = now; else if (now - away.current[i] > 8000) { if (!changed) next = next.slice(); next[i] = false; away.current[i] = 0; changed = true } }
    }
    if (changed) { cur.current = next; setMounted(next) }
    const sw = stageWin.current
    if (changed || sw.owner !== owner || sw.src !== cur.current) { sw.owner = owner; sw.src = cur.current; (window as any).__stageWindow = { owner, mounted: LATER.filter((_, i) => cur.current[i]).map((s) => s.name) } }
  })
  return (
    <>
      {LAZY.map((C, i) => mounted[i] ? (
        <Suspense key={LATER[i].name} fallback={null}>
          <Warm name={LATER[i].name}><C /></Warm>
        </Suspense>
      ) : null)}
    </>
  )
}

function Warm({ name, children }: { name: string; children: ReactNode }) {
  const { gl, scene, camera } = useThree()
  const ref = useRef<THREE.Group>(null)
  useEffect(() => {
    const g = ref.current, rt = engine.chain?.composer.inputBuffer ?? null
    if (!g) return
    // PERFGOV: while the warm-up runs (behind the curtain, or its leftover after a capped lift) it warms the stage in
    // short steps; only a later re-mount (a low-memory device that let it go) warms the old way
    if (!behindCurtain.finished) { behindCurtain.roots.set(name, g); return () => { behindCurtain.roots.delete(name) } }
    const t0 = performance.now()
    // PERF HOOK: the dive's god-ray mask is its own scene (not under this group); warm it with the stage
    if (name === 'dive' && diveRays.scene) void warmCompile(gl, diveRays.scene, camera, diveRays.scene, rt)
    warmCompile(gl, g, camera, scene, rt).then(() => {
      ;(window as any).__stages = { ...((window as any).__stages || {}), [name]: Math.round(performance.now() - t0) }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // PERFGOV: a stage reached before its warm-up finished (a capped lift on a slow GPU, then a fast scroll) waits for it
  // instead of compiling on the scroll path: its own scene stays undrawn until then (the stage in view is warmed first)
  // R6.71b: ...but a stage the visitor reached (in view or about a viewport away) is never left empty: once mounted it
  // draws (SHOW_ANYWAY_MS), its rushed warm-up finishing beside it
  useFrame(() => {
    const g = ref.current; if (!g) return
    const at = behindCurtain.urgent.get(name)
    g.visible = behindCurtain.finished || behindCurtain.warmed.has(name) || (at !== undefined && performance.now() - at >= SHOW_ANYWAY_MS)
  })
  return <group ref={ref} name={`stage:${name}`}>{children}</group>
}

function Env() {
  // A procedural studio for the metal to reflect: soft white panels on a mid-grey room. No HDR download.
  return (
    // PRELOAD / perf skill: 128 px env on phones (a soft studio reads the same; a quarter of the capture + PMREM cost)
    <Environment resolution={typeof window !== 'undefined' && window.innerWidth <= settings.MOBILE_WIDTH ? 128 : 256} frames={1} background={false}>
      <color attach="background" args={['#9a9ea5']} />
      {/* soft sky with a gentle falloff: tone without lines competing with the keys */}
      <Lightformer form="rect" intensity={1.15} color="#ffffff" position={[0, 10, -10]} rotation-x={Math.PI / 2} scale={[60, 70, 1]} />
      <Lightformer form="rect" intensity={0.6} color="#ffffff" position={[0, 7, -24]} scale={[80, 10, 1]} />
      <Lightformer form="rect" intensity={2.6} color="#ffffff" position={[-10, 3, 0]} rotation-y={Math.PI / 2} scale={[20, 3, 1]} />
      <Lightformer form="rect" intensity={1.8} color="#ffffff" position={[10, 2.5, 0]} rotation-y={-Math.PI / 2} scale={[20, 1.6, 1]} />
      {/* dark cards: the mercury needs black to read as metal */}
      <Lightformer form="rect" intensity={1} color="#2c2e33" position={[0, 2.2, -14]} scale={[50, 2.4, 1]} />
      <Lightformer form="rect" intensity={1} color="#000000" position={[0, 3, 12]} rotation-y={Math.PI} scale={[40, 3.5, 1]} />
      <Lightformer form="ring" intensity={3} color="#ffffff" position={[4, 7, 7]} scale={2.5} />
    </Environment>
  )
}

/** PERFGOV-3 (M02s census, 6x CPU: the whole scene used to mount in ONE React commit, a ~0.9 s task after the shell
 *  counter's first frame, the counter frozen for all of it). The scene now mounts in steps behind the opaque curtain,
 *  one commit per task with a frame between them, so the counter keeps rolling: the renderer + post chain, then the
 *  studio environment, then the hero (its lake mesh and stone prebuilt in short slices first), then the UFX layer,
 *  then the later-stage orchestrator. Nothing draws before the warm-up (app/clock.ts holds the frame loop until
 *  engine.warm), and the warm-up waits for the last step, so the first frame and every program are the same as before. */
let bootDone = () => {}
const booted = new Promise<void>((r) => { bootDone = r })
const BOOT_STEPS = 4
let heroGeo: Promise<void> | null = null
function BootStager() {
  const [k, setK] = useState(0)
  useEffect(() => {
    if (k >= BOOT_STEPS) { bootDone(); return }
    if (!heroGeo) heroGeo = sliced(heroGeoSteps(), () => 200).catch(() => {})   // the hero's geometry, in short slices
    let gone = false, t: ReturnType<typeof setTimeout> | undefined
    // R6.76 LOAD PATH: each step renders as a transition (React builds the step's objects in ~5 ms slices, the counter
    // keeps rolling); the commit and everything the step mounts are the same
    const next = () => { if (gone) return; gone = true; startTransition(() => setK(k + 1)) }
    // a frame between steps (the counter paints), then a fresh task; a hidden tab (no frames) still boots on the timer
    const step = () => { t = setTimeout(next, 120); requestAnimationFrame(() => setTimeout(next, 0)) }
    if (k === 1) heroGeo.then(() => { if (!gone) step() })   // the hero mounts once its lake and stone are built
    else step()
    return () => { gone = true; clearTimeout(t) }
  }, [k])
  return (
    <>
      <Suspense fallback={null}>
        {k >= 1 && <Env />}
        {k >= 2 && <HeroStage />}
        {k >= 3 && <UfxLayer />}
        <BootMark k={k} />
      </Suspense>
      {k >= 4 && <LaterStages />}
    </>
  )
}
/** commits with its Suspense siblings: the step counter only moves once the step's content is really mounted */
function BootMark({ k }: { k: number }) { useEffect(() => { (window as any).__bootStep = k }, [k]); return null }

export function Scene() {
  return (
    <Canvas
      frameloop="never"
      dpr={settings.DPR}
      gl={{ antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false, depth: true }}
      camera={{ fov: 35, near: 0.05, far: 700, position: [0, 1.2, 6.4] }}
      onCreated={({ gl, scene }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 1.0
        gl.outputColorSpace = THREE.SRGBColorSpace
        scene.background = new THREE.Color('#e7e8ea')
        scene.fog = new THREE.Fog('#e7e8ea', 14, 42)
        const ctx = gl.getContext()
        const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext
        ;(window as any).__webgl2 = isGL2
        console.info(`[surface-tension] renderer: ${isGL2 ? 'WebGL2' : 'WebGL1'} · tier ${settings.TIER}${settings.WEAK_GPU ? ` (light path: ${WEAK_WHY})` : ''} · dpr ${gl.getPixelRatio()} · parallel compile ${gl.extensions.has('KHR_parallel_shader_compile') ? 'yes' : 'no'} · ${settings.GPU}`)
        engine.canvas = gl.domElement
        installShaderGuard(gl)   // R6.92
        // W25 R6.52 (a11y): the canvas is the picture of what the DOM already says (every section's words live in the DOM
        // slot and its sr-only live region), so assistive tech skips it rather than announcing an unlabeled canvas
        gl.domElement.setAttribute('aria-hidden', 'true'); gl.domElement.setAttribute('tabindex', '-1')
        // R6.92 CONTEXT LOSS (Shifat's Windows desktop, Intel UHD 600 / Edge: lost → restored → reload → lost again inside
        // 60 s → static page; after a few of those Chrome/Edge blocked WebGL for the whole browser). Both of his devices run
        // the driver workaround exit_on_context_lost (Intel D3D11 and Adreno 506): every loss kills the GPU process, so a
        // restore in place never comes back sound there and each loss counts toward the browser's 3D blocklist. The ladder
        // therefore spends as few losses as possible and never restores in place:
        //  1. a loss at tier mid/high → reload ONCE into the low tier (st-gpu-weak, 7 days: the phone render path, layout
        //     stays desktop), at the same scroll position;
        //  2. a loss at tier low (phones, weak desktops; often just a background tab reclaimed) → reload once, same tier;
        //  3. a second loss within 10 minutes this session, at any tier → the designed DOM-only page (html.no-gl), never a
        //     black canvas. Nothing in this code ever calls loseContext on the scene's canvas.
        const el = gl.domElement
        const H = document.documentElement
        // back at the place the reader was when the context came back (one-shot)
        const back = Number(sessionStorage.getItem('st-gl-scroll') || 0); sessionStorage.removeItem('st-gl-scroll')
        if (back > 0) setTimeout(() => (window as any).__scroll?.scrollTo(back, { immediate: true }), 1800)
        const rec = ((window as any).__glRecovery = { losses: 0, action: '', lastLossAt: Number(sessionStorage.getItem('st-gl-loss-at') || 0) })
        const saveScroll = () => sessionStorage.setItem('st-gl-scroll', String(Math.round(((window as any).__props?.scroll as number) || scrollHost.y() || 0)))
        el.addEventListener('webglcontextlost', (e) => {
          e.preventDefault(); rec.losses++
          H.classList.add('gl-lost')
          if (rec.action) return   // already on its way (a reload or the static page)
          const now = Date.now(), recent = now - rec.lastLossAt < 600000
          sessionStorage.setItem('st-gl-loss-at', String(now))
          if (recent) {
            rec.action = 'static'
            H.classList.remove('gl-lost'); H.classList.add('no-gl')
            console.warn(`[surface-tension] WebGL context lost again (tier ${settings.TIER}): static page`)
            return
          }
          if (settings.TIER !== 'low') { rec.action = 'reload-low'; markWeakGpu() } else rec.action = 'reload'
          console.warn(`[surface-tension] WebGL context lost (tier ${settings.TIER}): reloading${rec.action === 'reload-low' ? ' on the light render path' : ''}`)
          saveScroll()
          setTimeout(() => location.reload(), 600)   // a beat for a crashed GPU process to come back
        }, false)
      }}
      style={{ position: 'fixed', inset: 0 }}
    >
      <ShaderGuard />{/* R6.92: a program the driver refuses → named in the console, its objects drawn plain */}
      <GpuFrameTimer />{/* SHARP HOOK: times each frame's GPU work for the governor (systems/perfGovernor.ts) */}
      <Renderer />
      <NeighbourPass />
      <CameraRig />
      <ambientLight intensity={0.25} />
      <directionalLight position={[4, 10, 6]} intensity={1.2} />
      <BootStager />
    </Canvas>
  )
}
