import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { Suspense, useEffect, useMemo } from 'react'
import { props, shared } from '../state/props'
import { settings } from '../services/settings'
import { fboHelper } from './core/fbo'
import { ScreenPaint } from './systems/ScreenPaint'
import { RippleSim } from './systems/RippleSim'
import { PostChain } from './post/PostChain'
import { CameraRig } from './systems/CameraRig'
import { HeroStage } from './stages/hero/HeroStage'
import { pool } from './systems/pool'
import { ufx } from './ufx/ufx'
import { UfxLayer } from './ufx/UfxLayer'
import { DiveStage } from './stages/dive/DiveStage'
import { engine } from './engine'
import { taskManager } from '../services/loader'
import { BLUE_NOISE_URL } from '../content/bluenoise'

/** Owns the frame: paint → sim → (stages already updated) → post chain. Priority 1 = R3F stops auto-render. */
function Renderer() {
  const { gl, scene, camera, size } = useThree()
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
    const dpr = gl.getPixelRatio()
    props.dpr = dpr
    props.renderW = Math.floor(size.width * dpr); props.renderH = Math.floor(size.height * dpr)
    sys.paint.resize(props.renderW, props.renderH)
    sys.chain.setSize(size.width, size.height)
    shared.u_resolution.value.set(props.renderW, props.renderH)
    ufx.resize(size.width, size.height)
  }, [size, gl, sys])

  useEffect(() => {
    // blue noise (generated offline with void-and-cluster, CC0 by construction)
    new THREE.TextureLoader().load(BLUE_NOISE_URL, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false
      shared.u_blueNoise.value = t
    })
    // GPU warm-up as loading tasks: compile every tracked material + the scene
    taskManager.add(() => gl.compile(scene, camera))
    taskManager.add(() => gl.compile(ufx.under, ufx.camera))
    engine.ready = true
  }, [gl, scene, camera])

  useFrame(() => {
    const dt = props.dt
    shared.u_time.value = props.time
    shared.u_dt.value = dt
    shared.u_blueNoiseOffset.value.set(Math.random(), Math.random())
    pool.update(camera, dt)
    sys.paint.update(dt)       // paint renders before the scene: distortion and scene shaders see this frame
    sys.ripple.update(dt)
    const bg = props.look.bg
    ;(scene.background as THREE.Color).copy(bg)
    if (scene.fog) (scene.fog as THREE.Fog).color.copy(props.look.fogColor)
    ufx.update()
    sys.chain.render(dt)
  }, 1)
  return null
}

function Env() {
  // A procedural studio for the metal to reflect: soft white panels on a mid-grey room. No HDR download.
  return (
    <Environment resolution={256} frames={1} background={false}>
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
        <DiveStage />
        <UfxLayer />
      </Suspense>
    </Canvas>
  )
}
