import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { slotBox } from '../../../dom/ui/TextLayer'
import { nb, useStageFrame } from '../../systems/neighbour' // NEIGHBOUR HOOK
import { props, shared } from '../../../state/props'
import { settings } from '../../../services/settings'
import { portrait } from '../../../core/frame'
import { engine } from '../../engine'
import { GEM_LAYER } from '../hero/HeroStage'
import { brilliantGeometry } from '../hero/diamond'
import { dive, diveRays, diveLo, DIVE_LAYER, TOOL_POS, floorH, PORT, SINK_M } from './diveState'
import { Floaters } from './floaters' // FLOATERS HOOK
import { Bubbles } from '../../fx/bubbles' // FX HOOK (CINEMATIC)
import { browser } from '../../../services/settings'
import { vegVert, vegFrag, rayMaskVert, rayMaskFrag } from './vegetation'
import { applyCaustics, causticUniforms, causticsFrame } from '../../water/caustics'
import { DeepSea } from './DeepSea'
import { UiCylinder } from './UiCylinder'
import { prewarm, runToEnd } from '../../prewarm' // PERFGOV
import { backdropVert, backdropFrag, BACKDROP_AMB, DIVE_COMMON as DC_LO, CLIP as BD_CLIP, floorVert, floorFrag, siltVert, siltFrag, starVert, starFrag } from './shaders'

const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const Q = typeof location !== 'undefined' ? location.search : ''
const RM = browser.reducedMotion && !/[?&]rmoff/.test(Q)   // W18-DIVE OVER-UNDER: reduced motion → no ripple/drops/wobble
const QA = { noRays: /[?&]norays/.test(Q), noVeg: /[?&]noveg/.test(Q), noCaus: /[?&]nocaus/.test(Q), gemDbg: /[?&]gemdbg/.test(Q) }

/** Seeded random so the forest is the same on every visit (and in every QA frame). */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

/**
 * The forest: kelp ribbons frame the glide on both sides (clear lane down the middle so the light and his tools
 * stay the one focal point), a few near the camera's path for parallax; seagrass in patches on the shelf.
 */
function plantForest(nKelp: number, nGrass: number): Planted {
  if (plantPre && plantPre.k === nKelp && plantPre.g === nGrass) return plantPre.f
  return runToEnd(plantForestSteps(nKelp, nGrass))
}
/** PERFGOV: the forest layout (seeded: the same every visit) built behind the preloader in steps, kept for the mounts */
type Planted = { kelp: number[]; kShape: number[]; grass: number[]; gShape: number[]; fore: number[]; fShape: number[] }
let plantPre: { k: number; g: number; f: Planted } | null = null
export function* prebuildDiveForest() { if (!plantPre) plantPre = { k: 320, g: 6400, f: yield* plantForestSteps(320, 6400) } }
function* plantForestSteps(nKelp: number, nGrass: number): Generator<unknown, Planted, unknown> {
  const R = rng(7)
  const kelp: number[] = [], kShape: number[] = []
  const nearTool = (x: number, z: number) => TOOL_POS.some((p) => Math.hypot(p[0] - x, p[2] - z) < 1.5)
  let guard = 0
  while (kelp.length / 4 < nKelp && guard++ < nKelp * 40) {
    if ((guard & 63) === 0) yield // PERFGOV
    const fore = false
    const side = R() < 0.5 ? -1 : 1
    const x = side * (fore ? 2.0 + R() * 1.2 : 3.0 + Math.pow(R(), 1.5) * 19)
    const z = fore ? 9.5 + R() * 2 : 10 + R() * 22
    if (nearTool(x, z)) continue
    const fy = floorH(x, z)
    const depth = -fy
    const maxH = Math.min(depth - 0.5, 16)
    const H = maxH * (0.62 + R() * 0.38)
    if (H < 2) continue
    const clump = 1 + Math.floor(R() * 3)
    for (let c = 0; c < clump && kelp.length / 4 < nKelp; c++) {
      const ox = (R() - 0.5) * 0.4, oz = (R() - 0.5) * 0.4
      const hh = H * (0.8 + R() * 0.25), wd = 0.8 + R() * 0.25, ph = R() * 6.283, tw = R() * 6.283
      // two crossed strips per plant so it never goes edge-on
      kelp.push(x + ox, floorH(x + ox, z + oz) - 0.05, z + oz, hh, x + ox, floorH(x + ox, z + oz) - 0.05, z + oz, hh)
      kShape.push(wd, ph, tw, 0, wd, ph, tw + 1.5708, 0)
    }
  }
  const grass: number[] = [], gShape: number[] = []
  const clumps: [number, number, number][] = []
  for (let i = 0; i < 70; i++) {
    const x = (R() - 0.5) * 34, z = 6 + R() * 18
    if (Math.abs(x) < 1.2 && R() < 0.7) continue
    clumps.push([x, z, 0.5 + R() * 1.1])
  }
  for (let i = 0; i < nGrass && clumps.length; i++) {
    if ((i & 1023) === 1023) yield // PERFGOV
    const c = clumps[i % clumps.length]
    const a = R() * 6.283, r = Math.sqrt(-2 * Math.log(1 - R() * 0.98)) * c[2] * 0.6
    const x = c[0] + Math.cos(a) * r, z = c[1] + Math.sin(a) * r
    grass.push(x, floorH(x, z) - 0.04, z, 0.35 + R() * R() * 0.9)
    gShape.push(0.045 + R() * 0.04, R() * 6.283 * 0.3 + c[0] * 0.2, R() * 6.283, 1)
  }
  // a few big fronds right beside the camera's path: soft, dark, out-of-focus parallax (clear of his tools)
  const fore: number[] = [], fShape: number[] = []
  for (const [x, z] of [[2.1, 10.6], [-2.4, 11.4], [3.0, 12.6], [1.35, 13.6], [-3.4, 17.6]] as [number, number][]) {
    const y = floorH(x, z) - 0.05, H = -y - 0.4 - R() * 1.5, wd = 1.15 + R() * 0.25, ph = R() * 6.283, tw = R() * 6.283
    fore.push(x, y, z, H, x, y, z, H)
    fShape.push(wd, ph, tw, 0, wd, ph, tw + 1.5708, 0)
  }
  return { kelp, kShape, grass, gShape, fore, fShape }
}

/** R7.10 b8: the plants far to near (from the dive's view, looking +z), so their soft edges blend over what is behind them */
const KELP_SOFT = !/[?&]kelphard\b/.test(Q)
function farFirst(root: number[], shape: number[]): [number[], number[]] {
  const n = root.length / 4, ix = Array.from({ length: n }, (_, i) => i)
  const dd = (i: number) => Math.hypot(root[i * 4], root[i * 4 + 1] + 4, root[i * 4 + 2] - 2)
  const key = ix.map(dd)
  ix.sort((a, b) => key[b] - key[a])
  const r: number[] = [], s: number[] = []
  for (const i of ix) { for (let k = 0; k < 4; k++) { r.push(root[i * 4 + k]); s.push(shape[i * 4 + k]) } }
  return [r, s]
}

function strip(segs: number, n: number, root: number[], shape: number[]) {
  const p = new THREE.PlaneGeometry(1, 1, 1, segs)
  p.translate(0, 0.5, 0)
  const g = new THREE.InstancedBufferGeometry()
  g.index = p.index
  g.setAttribute('position', p.getAttribute('position'))
  g.setAttribute('aRoot', new THREE.InstancedBufferAttribute(new Float32Array(root), 4))
  g.setAttribute('aShape', new THREE.InstancedBufferAttribute(new Float32Array(shape), 4))
  g.instanceCount = n
  return g
}

/** The sun: 58° up in air, a little left of the dive axis; refracted into the water by Snell's law. */
function sunDirs() {
  const el = (58 * Math.PI) / 180, az = -0.32
  const air = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize()
  const tx = air.x / 1.333, tz = air.z / 1.333
  const toSunWater = new THREE.Vector3(tx, Math.sqrt(1 - tx * tx - tz * tz), tz)
  return { air, travel: toSunWater.clone().negate() }
}

/** PERFGOV: the dive's uniforms, one set for the page (the cylinder is built against them before the stage mounts) */
let diveU: ReturnType<typeof makeDiveUniforms> | null = null
function makeDiveUniforms() {
  const { air, travel } = sunDirs()
  return {
    u_cam: { value: new THREE.Vector3() },
    u_sun: { value: travel },
    u_sunAir: { value: air },
    u_time: shared.u_time,
    u_deep: { value: 0 },
    u_split: { value: -1 },
    u_star: { value: 0 },
    u_amb: { value: 0 },
    u_abyss: { value: 0 },
    u_sinkK: { value: 0 }, // R6.88 SINK
    u_res: shared.u_resolution,
    u_bn: shared.u_blueNoise,
    u_caus: { value: QA.noCaus ? 0 : 1 },
    u_xk: { value: 1 },
  }
}
export const diveUniforms = () => (diveU ??= makeDiveUniforms())

/**
 * S5 — the dive. One star: the light coming through the surface (Snell's window + the shafts under it).
 * Everything lives on its own layer so the hero's cube/planar captures never see it.
 */
export function DiveStage() {
  const { camera, scene, gl } = useThree() as { camera: THREE.PerspectiveCamera; scene: THREE.Scene; gl: THREE.WebGLRenderer }
  const group = useRef<THREE.Group>(null!)
  const backdrop = useRef<THREE.Mesh>(null!)
  const tier = settings.TIER
  const hi = tier === 'high', low = tier === 'low'

  const u = useMemo(() => diveUniforms(), [])   // PERFGOV: shared with the cylinder built behind the preloader

  const mats = useMemo(() => {
    const defines = low ? { LOW: 1 } : {}
    const backdrop = new THREE.ShaderMaterial({
      vertexShader: backdropVert, fragmentShader: backdropFrag,
      uniforms: { ...u, u_raySteps: { value: hi ? 14 : low ? 1 : 10 }, u_rayGain: { value: QA.noRays ? 1 : low ? 0 : 0.85 }, u_loK: { value: new THREE.Vector2(2, 2) } },   // u_loK: R7.12 b8-water-v1 (the half-density pass's clip)   // phones: the screen-space pass carries the shafts alone
      side: THREE.BackSide, depthTest: false, depthWrite: false, defines,
    })
    const floor = new THREE.ShaderMaterial({ vertexShader: floorVert, fragmentShader: floorFrag, uniforms: { ...u }, defines, transparent: true })
    const silt = new THREE.ShaderMaterial({
      vertexShader: siltVert, fragmentShader: siltFrag,
      uniforms: { ...u, u_box: { value: 11 }   /* PERF HOOK: same silt volume + count on every tier */, u_pxScale: { value: 800 }, u_size: { value: 0.016 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    const stars = new THREE.ShaderMaterial({
      vertexShader: starVert, fragmentShader: starFrag,
      uniforms: { ...u, u_dpr: { value: 1 } },
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    })
    const veg = new THREE.ShaderMaterial({ vertexShader: vegVert, fragmentShader: vegFrag, uniforms: { ...u, u_part: { value: 2.6 } }, defines: KELP_SOFT ? { ...defines, SOFT: 1 } : defines, side: THREE.DoubleSide, transparent: KELP_SOFT })   // R7.10 b8: soft edges (blended, depth still written)
    const vegFore = new THREE.ShaderMaterial({ vertexShader: vegVert, fragmentShader: vegFrag, uniforms: { ...u, u_part: { value: 2.6 } }, defines: { ...defines, FORE: 1 }, side: THREE.DoubleSide, transparent: true, depthWrite: false })
    const vegMask = new THREE.ShaderMaterial({ vertexShader: vegVert, fragmentShader: vegFrag, uniforms: { ...u, u_part: { value: 2.6 } }, defines: { ...defines, MASK: 1 }, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
    ;[floor, veg, vegFore].forEach((m) => applyCaustics(m))
    causticUniforms.u_czSun.value = u.u_sun.value
    const rayMask = new THREE.ShaderMaterial({ vertexShader: rayMaskVert, fragmentShader: rayMaskFrag, uniforms: { ...u, u_invVP: { value: diveRays.invVP }, u_sunInfo: { value: diveRays.sun } }, defines, depthTest: false, depthWrite: false })
    // R7.10 SPLIT DENSITY: the same sphere drawn from the half-density shading (diveState.diveLo)
    const backdropLo = new THREE.ShaderMaterial({
      vertexShader: backdropVert, fragmentShader: /* glsl */ `
${DC_LO}
${BD_CLIP}
uniform sampler2D tLo; uniform vec2 u_full, u_loSize;
varying vec3 vDir;
void main(){
  splitClip();   // R7.12 b8-water-v1: the crossing's crisp lens cut, at the full density (the half-density pass stops just above it)
  // Catmull-Rom from 5 bilinear taps: as crisp as the smooth volume ever is, no bilinear blur, no ringing worth a pixel
  vec2 sp = gl_FragCoord.xy / u_full * u_loSize, tp = floor(sp - 0.5) + 0.5, f = sp - tp;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f), w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, t0 = (tp - 1.0) / u_loSize, t3 = (tp + 2.0) / u_loSize, t12 = (tp + w2 / w12) / u_loSize;
  vec3 c = texture2D(tLo, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y) + texture2D(tLo, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
         + texture2D(tLo, t12).rgb * (w12.x * w12.y) + texture2D(tLo, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
         + texture2D(tLo, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  vec3 col = max(c / ws, 0.0);
  vec3 dir = normalize(vDir);
  float jit = texture2D(u_bn, gl_FragCoord.xy / 64.0).r;   // the same static blue noise, at the full density
  ${BACKDROP_AMB}
  gl_FragColor = vec4(col, 1.0);
}`,
      uniforms: { ...u, tLo: { value: null }, u_full: { value: new THREE.Vector2(1, 1) }, u_loSize: { value: new THREE.Vector2(1, 1) } },
      side: THREE.BackSide, depthTest: false, depthWrite: false,
    })
    const backdropLoPass = new THREE.ShaderMaterial({ vertexShader: backdropVert, fragmentShader: backdropFrag, uniforms: backdrop.uniforms, side: THREE.BackSide, depthTest: false, depthWrite: false, defines: { ...defines, BD_LO_PASS: 1 } })
    diveLo.full = backdrop; diveLo.lo = backdropLoPass; diveLo.blit = backdropLo; diveLo.split = () => u.u_split.value as number
    return { backdrop, floor, silt, stars, veg, vegFore, vegMask, rayMask }
  }, [u, hi, low])

  const geos = useMemo(() => {
    const sphere = new THREE.SphereGeometry(60, 48, 24)
    const floor = new THREE.PlaneGeometry(90, 100, low ? 70 : 150, low ? 80 : 170)
    floor.rotateX(-Math.PI / 2)
    const rnd = (n: number) => { const a = new Float32Array(n * 3); for (let i = 0; i < a.length; i++) a[i] = Math.random(); return a }
    // PERF HOOK (Shifat 10:21Z: same object count on every tier): silt, stars, kelp and grass counts are equal;
    // phones keep cheaper geometry (fewer strip segments, a coarser floor)
    const siltN = 1100
    const silt = new THREE.BufferGeometry()
    silt.setAttribute('position', new THREE.BufferAttribute(rnd(siltN), 3))
    silt.setAttribute('aRand', new THREE.BufferAttribute(rnd(siltN), 3))
    const starN = 220
    const sp = new Float32Array(starN * 3)
    for (let i = 0; i < starN; i++) {
      const v = new THREE.Vector3().randomDirection()
      sp.set([v.x, v.y, v.z], i * 3)
    }
    const stars = new THREE.BufferGeometry()
    stars.setAttribute('position', new THREE.BufferAttribute(sp, 3))
    stars.setAttribute('aRand', new THREE.BufferAttribute(rnd(starN), 3))
    const f = plantForest(320, 6400)
    const kelp = strip(low ? 18 : 30, f.kelp.length / 4, ...(KELP_SOFT ? farFirst(f.kelp, f.kShape) : [f.kelp, f.kShape] as [number[], number[]]))
    const grass = strip(low ? 4 : 6, f.grass.length / 4, ...(KELP_SOFT ? farFirst(f.grass, f.gShape) : [f.grass, f.gShape] as [number[], number[]]))
    const fore = strip(low ? 18 : 30, f.fore.length / 4, f.fore, f.fShape)
    const quad = new THREE.PlaneGeometry(2, 2)
    return { sphere, floor, silt, stars, kelp, grass, fore, quad }
  }, [hi, low])

  // the god-ray occlusion scene: the light, with the kelp silhouettes drawn black over it
  const maskScene = useMemo(() => {
    const s = new THREE.Scene()
    const bg = new THREE.Mesh(geos.quad, mats.rayMask); bg.frustumCulled = false; bg.renderOrder = 0
    const k = new THREE.Mesh(geos.kelp, mats.vegMask); k.frustumCulled = false; k.renderOrder = 1
    const kf = new THREE.Mesh(geos.fore, mats.vegMask); kf.frustumCulled = false; kf.renderOrder = 1
    if (!QA.noVeg) { s.add(k); s.add(kf) }
    s.add(bg)
    return s
  }, [geos, mats])
  // PERFGOV: the god-ray mask pass (drawn into its own target by post/DiveGodRays), warmed behind the preloader
  useEffect(() => prewarm.add('dive', () => ({ jobs: [{ roots: [maskScene], scene: maskScene, camera, target: engine.chain?.composer.inputBuffer ?? null }] })), [maskScene, camera])

  useEffect(() => {
    camera.layers.enable(DIVE_LAYER)
    return () => {
      Object.values(mats).forEach((m) => m.dispose()); Object.values(geos).forEach((g) => g.dispose())
      const g = engine.chain?.grade; if (g) g.u('u_waterline').value = -1
      diveRays.on = false; diveRays.scene = null
    }
  }, [camera, mats, geos])

  const st = useMemo(() => ({
    hero: null as THREE.Object3D | null, searched: 0, lineWas: false, dbg: null as THREE.Mesh | null,
    labels: [] as HTMLElement[], labelsAt: 0, v: new THREE.Vector3(), w: new THREE.Vector3(),
  }), [])

  useStageFrame('dive', () => {
    causticsFrame(gl)
    const camY = camera.position.y
    dive.camY = camY
    dive.camZ = camera.position.z
    const on = props.stage === 'dive'
    // W18-DIVE OVER-UNDER (Shifat 15:29Z + 15:30Z): the water world shows from the moment the waterline enters the frame
    const showGL = on && camY < PORT
    dive.active = showGL
    dive.under = on && camY < 0
    group.current.visible = showGL

    // the split-level shot: a dome port PORT tall. With the lens PORT above the water the line sits at the bottom of the
    // frame; it rises as the camera cranes down and reaches the top as the lens meets the surface (so everything above
    // the line is always the air render, from above the water). Then a brief wobble as it passes, and we are under.
    // A pure function of the camera height, i.e. of the dive's scroll progress (through the camera's spring).
    const split = showGL && camY > 0 && camY < PORT ? 1 - camY / PORT : -1
    const past = on && camY <= 0 && camY > -0.6 ? -camY / 0.6 : -1      // 0..1 just after the line left the top
    dive.split = split
    dive.under01 = split >= 0 ? split : past >= 0 ? 1 : camY <= 0 && on ? 1 : 0
    u.u_split.value = split
    const grade = engine.chain?.gradeFor(nb.active) // NEIGHBOUR HOOK: the neighbour pass has its own grade
    if (grade) {
      if (split >= 0 || past >= 0) {
        grade.u('u_waterline').value = split >= 0 ? split : 1.03 + past
        grade.u('u_wlK').value = split >= 0 ? 1 : 1 - ss(0, 1, past)
        grade.u('u_wlWob').value = split >= 0 ? 0.3 * ss(0.86, 1, split) : ss(0, 0.1, past) * (1 - ss(0.12, 0.75, past))
        grade.u('u_wlMo').value = RM ? 0 : 1
        st.lineWas = true
      } else if (st.lineWas) { grade.u('u_waterline').value = -1; grade.u('u_wlK').value = 0; grade.u('u_wlWob').value = 0; st.lineWas = false }
    }

    // fully under: the lake above (and its diamond) is replaced by the view from below
    if (!st.hero && st.searched < 120) {
      st.searched++
      for (const c of scene.children) {
        let hit = false
        c.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.layers.isEnabled(GEM_LAYER) && !o.layers.isEnabled(DIVE_LAYER)) hit = true })
        if (hit && c !== group.current) { st.hero = c; break }
      }
    }
    // (v2: while the dive drives the guide gem, the hero stage keeps the gem itself and hides only the lake)
    if (st.hero && on && camY < -0.3 && !dive.gemOn) st.hero.visible = false
    // QA (?gemdbg): a plain stand-in at the guide position, to check the path before the hero gem rides it
    if (QA.gemDbg) {
      if (!st.dbg) { st.dbg = new THREE.Mesh(brilliantGeometry(0.5), new THREE.MeshBasicMaterial({ color: '#3d7bff', fog: false })); scene.add(st.dbg) }
      st.dbg.visible = dive.gemOn; st.dbg.position.copy(dive.gem); st.dbg.rotation.y = props.time * 0.4
    }

    if (!showGL) { diveRays.on = false; if (!nb.active) hideLabels(st.labels); return }
    // screen-space god rays: on once fully under, fading out into the deep
    diveRays.scene = maskScene
    diveRays.toSun.copy(u.u_sun.value).negate()
    diveRays.intensity = QA.noRays ? 0 : ss(-0.3, -1.2, camY) * (1 - ss(-9, -20, camY)) * 0.9
    diveRays.on = diveRays.intensity > 0.002

    u.u_cam.value.copy(camera.position)
    backdrop.current.position.copy(camera.position)
    dive.deep = ss(-11, -25, camY) * 0.97
    // v3 (Shifat 11:56Z): the deep never turns to space any more — the systems are the same water, deeper. Below the
    // sunlit layer the deep's own blue glow takes over (u_amb) and the fog thickens toward the systems (u_abyss)
    dive.star = 0
    u.u_deep.value = dive.deep
    u.u_star.value = dive.star
    u.u_amb.value = ss(-9, -22, camY)
    u.u_abyss.value = dive.abyss
    u.u_sinkK.value = Math.min(1, dive.camSink / SINK_M) // R6.88 SINK: the water darkens as the tablet takes us down
    const rs = nb.active ? nb.scale : 1 // NEIGHBOUR HOOK: point sizes follow the neighbour's smaller target
    mats.silt.uniforms.u_pxScale.value = props.renderH * rs / (2 * Math.tan((camera.fov * Math.PI) / 360))
    mats.stars.uniforms.u_dpr.value = props.dpr * rs

    // NEIGHBOUR HOOK: the DOM labels belong to the main pass (the outgoing section's DOM rides the clip's transform)
    if (nb.active) return
    // his tools: crisp DOM labels pinned to points in the water
    if (!st.labels.length && props.time - st.labelsAt > 1) {
      st.labelsAt = props.time
      st.labels = Array.from(document.querySelectorAll<HTMLElement>('#dive .dive__tool'))
    }
    const xk = 1 - 0.58 * portrait()
    u.u_xk.value = 1 - 0.12 * portrait()
    const gate = ss(0.54, 0.62, dive.u)
    st.labels.forEach((el, i) => {
      const p = TOOL_POS[i % TOOL_POS.length]
      st.v.set(p[0] * xk, p[1] + 0.08 * Math.sin(props.time * 0.35 + i * 1.7), p[2])
      const dist = st.v.distanceTo(camera.position)
      st.w.copy(st.v).project(camera)
      const inFront = st.w.z < 1 && st.w.z > -1
      const sx = (st.w.x * 0.5 + 0.5) * props.width, sy = (-st.w.y * 0.5 + 0.5) * props.height
      const fx = st.w.x * 0.5 + 0.5, fy = 0.5 - st.w.y * 0.5             // 0..1 from left / top
      const edge = ss(0.03, 0.1, Math.min(fx, 1 - fx)) * ss(0.11, 0.2, fy) * ss(0.04, 0.12, 1 - fy)   // clear of the nav at the top
      // W17: never under the global text slot (the copy owns the bottom of the frame)
      const keep = ss(0, 48, slotBox.top - 28 - sy)
      const a = inFront ? gate * Math.exp(-0.075 * dist) * ss(1.4, 3.2, dist) * edge * keep * (1 - dive.deep) * 1.6 : 0
      el.style.opacity = Math.min(1, a).toFixed(3)
      if (a > 0.002) el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`
    })
  }, group)

  return (
    <group ref={group} visible={false}>
      <mesh ref={(m) => { backdrop.current = m!; diveLo.mesh = m }} geometry={geos.sphere} material={mats.backdrop} renderOrder={10} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />
      <mesh geometry={geos.floor} material={mats.floor} position={[0, 0, 28]} renderOrder={11} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />
      {!QA.noVeg && <mesh geometry={geos.kelp} material={mats.veg} renderOrder={11.5} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />}
      {!QA.noVeg && <mesh geometry={geos.grass} material={mats.veg} renderOrder={11.4} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />}
      {!QA.noVeg && <mesh geometry={geos.fore} material={mats.vegFore} renderOrder={14} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />}
      <points geometry={geos.silt} material={mats.silt} renderOrder={12} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />
      <points geometry={geos.stars} material={mats.stars} renderOrder={13} frustumCulled={false} onUpdate={(o) => o.layers.set(DIVE_LAYER)} />
      <DeepSea u={u} />
      <Floaters u={u} /> {/* FLOATERS HOOK */}
      <Bubbles u={u} /> {/* FX HOOK (CINEMATIC) */}
      <UiCylinder u={u} />
    </group>
  )
}

function hideLabels(els: HTMLElement[]) { for (const el of els) if (el.style.opacity !== '0') el.style.opacity = '0' }
