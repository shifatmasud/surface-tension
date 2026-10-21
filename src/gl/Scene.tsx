import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { props, shared } from '../state/props'
import { settings, capDpr } from '../services/settings'
import { fboHelper } from './core/fbo'
import { ScreenPaint } from './systems/ScreenPaint'
import { RippleSim } from './systems/RippleSim'
import { PostChain } from './post/PostChain'
import { CameraRig } from './systems/CameraRig'
import { HeroStage } from './stages/hero/HeroStage'
import { pool } from './systems/pool'
import { ufx } from './ufx/ufx'
import { UfxLayer } from './ufx/UfxLayer'
import { engine } from './engine'
import { taskManager } from '../services/loader'
import { BLUE_NOISE_URL } from '../content/bluenoise'
import { htmlRender } from './html/htmlRender'
import { preload, warmCompile, warmGate } from '../services/preload'
import { clip, BLOCKS } from './systems/clip'
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
  const key = `${w}x${h}|${dpr.toFixed(4)}|${td.toFixed(4)}|${pd.toFixed(4)}`
  if (key === z.last.key) return false
  z.last.key = key
  props.dpr = dpr; props.textDpr = td
  if (Math.abs(gl.getPixelRatio() - td) > 1e-3) z.setDpr(td) // R3F's store resizes the canvas synchronously (once)
  if (Math.abs(gl.getPixelRatio() - td) > 1e-3) gl.setPixelRatio(td) // (a store that already held td: no-op above)
  props.renderW = Math.floor(w * dpr); props.renderH = Math.floor(h * dpr)
  props.paintDpr = pd; z.sys.paint.resize(Math.floor(w * pd), Math.floor(h * pd)) // the trail sim ignores rest (and no-ops on an unchanged size)
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
    taskManager.addAsync((r) => warmCompile(gl, scene, camera, scene, rt, r).then(done))
    taskManager.addAsync((r) => warmCompile(gl, ufx.under, ufx.camera, ufx.under, rt, r).then(done))
    setTimeout(() => { engine.warm = true }, 8000) // never hold the loop forever (a driver that never reports)
    htmlRender.init(gl.domElement, ufx.camera, gl)
    engine.ready = true
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
    sys.chain.render(dt)
    if (wrapFade.want) wrapFade.grab(gl.domElement)   // W21: the loop wrap freezes this exact frame (services/wrapFade.ts)
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
    if (!nb.enabled || !chain || !clip.enabled || !clip.boundary || clip.still < 0 || !props.introDone || props.overlayOpen) {
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
const LOW_MEM = ((navigator as any).deviceMemory ?? 8) < 4

function LaterStages() {
  const [mounted, setMounted] = useState<boolean[]>(() => LATER.map(() => false))
  const cur = useRef(mounted)
  const away = useRef<number[]>(LATER.map(() => 0))
  useEffect(() => {
    // fetch (not build) every later stage's code once the curtain is up, so a window move never waits on the network
    preload.afterIntro(() => LATER.forEach((s) => { s.load().catch(() => {}) }), 300)
    // W18 PREWARM: once the hero has settled, mount every later stage in idle time, one at a time, so its programs
    // compile and its textures upload (Warm) before anyone gets there; a deep jump to the footer then lands on the
    // wall, not on a cold stage. They stay mounted (an inactive stage's frame returns at once) unless the device
    // reports little memory.
    let cancel = false
    const ric: (cb: () => void) => void = (window as any).requestIdleCallback ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 2500 }) : (cb) => setTimeout(cb, 400)
    preload.afterIntro(() => {
      let i = 0
      const step = () => {
        if (cancel || i >= LATER.length) return
        const k = i++
        ric(() => {
          if (cancel) return
          if (!cur.current[k]) { const next = cur.current.slice(); next[k] = true; cur.current = next; setMounted(next) }
          setTimeout(step, 1200)
        })
      }
      step()
    }, 2500)
    return () => { cancel = true }
  }, [])
  useFrame(() => {
    if (!props.introDone) return
    const owner = currentBlock(), now = performance.now()
    const next = cur.current.slice()
    let changed = false
    for (let i = 0; i < LATER.length; i++) {
      const inWin = Math.abs(BLOCK_OF[i] - owner) <= 1
      // wall-clock hysteresis (props.dt is capped per frame, so a slow device would hold stages far longer)
      if (inWin) { away.current[i] = 0; if (!next[i]) { next[i] = true; changed = true } }
      else if (next[i] && LOW_MEM) { if (!away.current[i]) away.current[i] = now; else if (now - away.current[i] > 8000) { next[i] = false; away.current[i] = 0; changed = true } }
    }
    if (changed) { cur.current = next; setMounted(next) }
    ;(window as any).__stageWindow = { owner, mounted: LATER.filter((_, i) => cur.current[i]).map((s) => s.name) }
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
    const t0 = performance.now()
    // PERF HOOK: the dive's god-ray mask is its own scene (not under this group); warm it with the stage
    if (name === 'dive' && diveRays.scene) void warmCompile(gl, diveRays.scene, camera, diveRays.scene, rt)
    warmCompile(gl, g, camera, scene, rt).then(() => {
      ;(window as any).__stages = { ...((window as any).__stages || {}), [name]: Math.round(performance.now() - t0) }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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
        console.info(`[surface-tension] renderer: ${isGL2 ? 'WebGL2' : 'WebGL1'} · tier ${settings.TIER} · dpr ${gl.getPixelRatio()} · ${settings.GPU}`)
        engine.canvas = gl.domElement
        // W25 R6.52 (a11y): the canvas is the picture of what the DOM already says (every section's words live in the DOM
        // slot and its sr-only live region), so assistive tech skips it rather than announcing an unlabeled canvas
        gl.domElement.setAttribute('aria-hidden', 'true'); gl.domElement.setAttribute('tabindex', '-1')
        // W19 (eng P0-2 + visual P0-1): a lost context gets a restore on EVERY loss, not just the first one per session.
        // lost → ask the driver for it back after 3 s (WEBGL_lose_context.restoreContext; most browsers restore on their
        // own first); restored → reload once per 60 s window at the same scroll position (the stages' GPU objects are
        // gone with the old context, a reload rebuilds every one of them); never restored in 12 s, or a second loss
        // inside the window → the DOM-only page (html.no-gl), never a black canvas.
        const el = gl.domElement
        // back at the place the reader was when the context came back (one-shot)
        const back = Number(sessionStorage.getItem('st-gl-scroll') || 0); sessionStorage.removeItem('st-gl-scroll')
        if (back > 0) setTimeout(() => (window as any).__scroll?.scrollTo(back, { immediate: true }), 1800)
        let lostT: ReturnType<typeof setTimeout> | undefined, deadT: ReturnType<typeof setTimeout> | undefined
        const recent = () => Date.now() - Number(sessionStorage.getItem('st-gl-restored-at') || 0) < 60000
        const giveUp = () => { document.documentElement.classList.remove('gl-lost'); document.documentElement.classList.add('no-gl') }
        el.addEventListener('webglcontextlost', (e) => {
          e.preventDefault(); console.warn('[surface-tension] WebGL context lost')
          document.documentElement.classList.add('gl-lost')
          if (recent()) { giveUp(); return }
          lostT = setTimeout(() => { try { gl.getContext().getExtension('WEBGL_lose_context')?.restoreContext() } catch { /* not ours to restore */ } }, 3000)
          deadT = setTimeout(giveUp, 12000)
        }, false)
        el.addEventListener('webglcontextrestored', () => {
          clearTimeout(lostT); clearTimeout(deadT)
          if (recent()) { giveUp(); return }
          sessionStorage.setItem('st-gl-restored-at', String(Date.now()))
          sessionStorage.setItem('st-gl-scroll', String(Math.round(((window as any).__props?.scroll as number) || window.scrollY || 0)))
          location.reload()
        }, false)
      }}
      style={{ position: 'fixed', inset: 0 }}
    >
      <GpuFrameTimer />{/* SHARP HOOK: times each frame's GPU work for the governor (systems/perfGovernor.ts) */}
      <Renderer />
      <NeighbourPass />
      <CameraRig />
      <ambientLight intensity={0.25} />
      <directionalLight position={[4, 10, 6]} intensity={1.2} />
      <Suspense fallback={null}>
        <Env />
        <HeroStage />
        <UfxLayer />
      </Suspense>
      <LaterStages />
    </Canvas>
  )
}
