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
import { preload, warmCompile } from '../services/preload'
import { clip, BLOCKS } from './systems/clip'
import { quality, paintState } from './quality' // PERF HOOK
import { diveRays } from './stages/dive/diveState' // PERF HOOK
import { input } from '../services/input' // PERF HOOK

// PRELOAD: code-split per scene. The hero is in this chunk; each later stage is its own chunk, mounted and
// shader-warmed when its block enters the ±1 window around the current block (LaterStages below).
const LATER: { name: string; load: () => Promise<ComponentType> }[] = [
  { name: 'systems', load: () => import('./stages/systems/SystemsStage').then((m) => m.SystemsStage as ComponentType) },
  { name: 'dive', load: () => import('./stages/dive/DiveStage').then((m) => m.DiveStage as ComponentType) },
  { name: 'journey', load: () => import('./stages/journey/JourneyStage').then((m) => m.JourneyStage as ComponentType) },
]
const LAZY = LATER.map((s) => lazy(() => s.load().then((C) => ({ default: C }))))

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

  useEffect(() => {
    // keep the total-pixel cap as the window changes (ultrawide / 4K / external monitor)
    // PERF HOOK: the governor's DPR step (≤ the tier cap and the total-pixel cap)
    const want = quality.dprFor(size.width, size.height)
    if (Math.abs(want - gl.getPixelRatio()) > 0.01) { setDpr(want); return }
    const dpr = gl.getPixelRatio()
    props.dpr = dpr
    props.renderW = Math.floor(size.width * dpr); props.renderH = Math.floor(size.height * dpr)
    sys.paint.resize(props.renderW, props.renderH)
    sys.chain.setSize(size.width, size.height)
    shared.u_resolution.value.set(props.renderW, props.renderH)
    ufx.resize(size.width, size.height)
  }, [size, gl, sys, setDpr, storeDpr])

  // PERF HOOK: a governor step changes the DPR; the effect above re-sizes the paint, the chain and the uniforms
  useEffect(() => quality.on(() => setDpr(quality.dprFor(size.width, size.height))), [size, setDpr])

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
    const done = () => { if (++n === 2) { engine.warm = true; sys.chain.warmAll = true } }
    taskManager.addAsync(() => warmCompile(gl, scene, camera, scene, rt).then(done))
    taskManager.addAsync(() => warmCompile(gl, ufx.under, ufx.camera, ufx.under, rt).then(done))
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
    if (!props.introDrop && props.frame % 3 !== 0) return
    sys.chain.render(dt)
  }, 1)
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
function LaterStages() {
  const [mounted, setMounted] = useState<boolean[]>(() => LATER.map(() => false))
  const cur = useRef(mounted)
  const away = useRef<number[]>(LATER.map(() => 0))
  useEffect(() => {
    // fetch (not build) every later stage's code once the curtain is up, so a window move never waits on the network
    preload.afterIntro(() => LATER.forEach((s) => { s.load().catch(() => {}) }), 300)
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
      else if (next[i]) { if (!away.current[i]) away.current[i] = now; else if (now - away.current[i] > 8000) { next[i] = false; away.current[i] = 0; changed = true } }
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
        // a lost context (GPU reset, memory pressure, background tab) gets one clean restore: reload once on restore,
        // and fall back to the DOM-only page if it never comes back
        gl.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault(); console.warn('[surface-tension] WebGL context lost')
          document.documentElement.classList.add('gl-lost')
        }, false)
        gl.domElement.addEventListener('webglcontextrestored', () => {
          if (!sessionStorage.getItem('st-gl-restored')) { sessionStorage.setItem('st-gl-restored', '1'); location.reload() }
        }, false)
      }}
      style={{ position: 'fixed', inset: 0 }}
    >
      <Renderer />
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
