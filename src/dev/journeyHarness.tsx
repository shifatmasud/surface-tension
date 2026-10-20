import * as THREE from 'three'
import { createRoot } from 'react-dom/client'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { props } from '../state/props'
import { settings } from '../services/settings'
import { journey } from '../gl/stages/journey/journeyState'
import { JourneyStage } from '../gl/stages/journey/JourneyStage'

/**
 * Dev harness for the Journey stage only (never part of the site build).
 *   ?p=0.62   fixed progress   ·   ?anim   auto-scrub 0→1 over 24 s   ·   ?parallax  fake the rig's pointer sway
 * window.__journeySet(p) jumps (springs snap); window.__journeyFrames counts rendered frames.
 */
const q = new URLSearchParams(location.search)
const fixed = q.has('p') ? parseFloat(q.get('p')!) : 0.05
const anim = q.has('anim')
if (!q.has('hud')) document.getElementById('hud')?.remove()
const W = window as any
W.__journeyFrames = 0
W.__journeySet = (p: number) => { props.journey = p; journey.snap = true; W.__journeyFrames = 0 }
props.journey = fixed
W.__props_set = (p: number) => { props.journey = p }
journey.active = true
journey.snap = true

function Driver() {
  const t0 = performance.now()
  let last = performance.now(), acc = 0, n = 0
  const gl = useThree((s) => s.gl)
  gl.info.autoReset = false
  useFrame(() => {
    // draw calls of the previous whole frame: the stage's offscreen render + the main render
    W.__frameCalls = gl.info.render.calls; W.__frameTris = gl.info.render.triangles; gl.info.reset()
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now
    props.dt = W.__fixedDt ?? dt
    props.time += props.dt
    props.frame++
    if (anim) props.journey = ((now - t0) / 24000) % 1
    acc += dt; n++
    if (!anim) props.dt = W.__fixedDt ?? 1 / 30
    if (acc > 1) { const hud = document.getElementById('hud'); if (hud) hud.textContent = `p ${props.journey.toFixed(3)} · ${(n / acc).toFixed(0)} fps · tier ${settings.TIER}`; acc = 0; n = 0 }
  }, -2)
  return null
}
/** Stills: no rAF loop at all; the capture script advances N frames by hand (software GL is slow). */
function Stepper() {
  const advance = useThree((s) => s.advance)
  W.__advance = (n: number) => { for (let i = 0; i < n; i++) advance(performance.now()) }
  return null
}
function CamFollow() {
  const { camera, gl } = useThree() as { camera: THREE.PerspectiveCamera; gl: THREE.WebGLRenderer }
  const par = q.has('parallax')
  useFrame(() => {
    const p = journey.pose
    const sway = par ? Math.sin(props.time * 0.8) * 0.55 : 0
    camera.position.copy(p.pos).x += sway
    camera.lookAt(p.target.x + sway * 0.25, p.target.y, p.target.z)
    if (camera.fov !== p.fov) { camera.fov = p.fov; camera.updateProjectionMatrix() }
    W.__journeyFrames++
    W.__drawCalls = gl.info.render.calls
  })
  return null
}

createRoot(document.getElementById('root')!).render(
  <Canvas
    dpr={1}
    frameloop={anim ? 'always' : 'never'}
    gl={{ antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: true }}
    camera={{ fov: 35, near: 0.1, far: 200, position: [200, 0, 12] }}
    onCreated={({ gl, scene }) => {
      gl.toneMapping = THREE.ACESFilmicToneMapping
      gl.outputColorSpace = THREE.SRGBColorSpace
      scene.background = new THREE.Color('#020203')
      scene.fog = new THREE.Fog('#020203', 14, 42) // the main scene's fog: the stage must ignore it
      W.__gl = gl
    }}
    style={{ position: 'fixed', inset: 0 }}
  >
    <Driver />
    {/* the main scene's lights, mirrored */}
    <ambientLight intensity={0.25} />
    <directionalLight position={[4, 10, 6]} intensity={1.2} />
    <JourneyStage />
    <CamFollow />
    <Stepper />
  </Canvas>,
)
