import * as THREE from 'three'

/**
 * PERFGOV PREWARM (Shifat 18:22Z "0 freeze & framedrop is success criteria now"; 18:46Z GO: "mount the later stages
 * behind the preloader odometer"). Everything a later section needs the first time it is seen is done behind the
 * curtain, in short slices, so the odometer keeps rolling and nothing is paid on the way down the page:
 *  - the stage's CPU build (geometry, buffers) as generator steps (JourneyStage buildSteps, foliage);
 *  - every program it will draw with, compiled per object against the scene it is drawn in (same lights, fog and
 *    target kind as the real frame, so three's program keys match and nothing compiles again on first view), once
 *    with the stage as it is and once with its whole subtree visible (its own lights on: the dive tools add three);
 *  - every link finished (KHR_parallel_shader_compile polled without blocking; without it one blocking link per step);
 *  - every texture uploaded and every render target allocated.
 * Nothing here draws: the picture is untouched (level-0 pixels identical).
 */

/** run a step generator to its end in one go (the old synchronous build) */
export function runToEnd<T>(g: Generator<unknown, T, unknown>): T { for (;;) { const r = g.next(); if (r.done) return r.value } }

/** yielded by a step that must wait for the next frame (a link still running on the driver) */
export const NEXT_FRAME = Symbol('next-frame')
/** R6.77: yielded after a heavy GPU pass (core/pmremSteps.ts): wait for the next frame like NEXT_FRAME, unless the job is
 *  rushed (a stage the visitor is in or about to reach), which runs on in the same task: a hitch, never a void */
export const GPU_FRAME = Symbol('gpu-frame')
/** prewarm work per task (ms). The steps run as short tasks back to back between frames (a message-channel loop,
 *  not inside the frame), so the throughput is the main thread's spare time while every task stays far under the
 *  ~50 ms a slow phone can absorb without a visible stall; the odometer's frames run between them */
export const SLICE_MS = 10

/** R6.71b (W29: no later stage warm 44 s after load on the M02 rig; at 1440 on a software GPU the dive was still not
 *  prebuilt 23 s after its warm-up began). The browser puts a frame between two of these tasks, so the slicer's
 *  throughput is SLICE_MS per FRAME: where a frame takes 300 ms that is ~3% of the main thread, and the stages finish
 *  long after the visitor got there. A task now takes a share of the measured frame time instead: SLICE_MS at 60 fps
 *  (unchanged on a fast device), up to SLICE_MAX_MS where frames are slow (still under the 50 ms long-task line) */
export const SLICE_MAX_MS = 40
let frameMs = 16, lastRaf = 0, rafOn = false
const tick = (t: number) => {
  if (lastRaf) frameMs += (Math.min(t - lastRaf, 1000) - frameMs) * 0.25
  lastRaf = t
  if (jobs.length) requestAnimationFrame(tick); else { rafOn = false; lastRaf = 0 }
}
const sliceMs = () => Math.min(SLICE_MAX_MS, Math.max(SLICE_MS, frameMs * 0.3))
const chan = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null
let posted = false
const post = () => { if (posted) return; posted = true; if (chan) chan.port2.postMessage(0); else setTimeout(run, 0) }

type Job = { g: Generator<unknown, unknown, unknown>; pri: () => number; rush?: () => boolean; order: number; waiting: boolean; done: (v: unknown) => void; fail: (e: unknown) => void }
const jobs: Job[] = []
let order = 0
/** one task: the most urgent ready job's steps for about SLICE_MS (re-picked after every step, so a stage the visitor
 *  just scrolled to takes over at once); a job whose step yielded NEXT_FRAME sits out until the next frame */
function run() {
  posted = false
  const t0 = performance.now(), budget = sliceMs()
  for (;;) {
    let best: Job | null = null, bp = -Infinity
    for (const j of jobs) { if (j.waiting) continue; const p = j.pri(); if (p > bp || (p === bp && best && j.order < best.order)) { best = j; bp = p } }
    if (!best) return
    let r: IteratorResult<unknown, unknown>
    try { r = best.g.next() } catch (e) { jobs.splice(jobs.indexOf(best), 1); best.fail(e); continue }
    if (r.done) { jobs.splice(jobs.indexOf(best), 1); best.done(r.value) }
    else if (r.value === NEXT_FRAME || (r.value === GPU_FRAME && !best.rush?.())) { const j = best; j.waiting = true; requestAnimationFrame(() => { j.waiting = false; post() }) }
    // R6.71b: a rushed job (a stage the visitor is in or within about a viewport of) runs to its end in this task: a short
    // hitch on the way in instead of an empty scene; everything else keeps its SLICE_MS share
    else if (best.rush?.()) continue
    if (performance.now() - t0 >= budget) break
  }
  if (jobs.some((j) => !j.waiting)) post()
}
if (chan) chan.port1.onmessage = run

/** drive a step generator in short tasks (about SLICE_MS each, shared by every job: the highest pri() goes first, ties
 *  in the order they were started); a step yielding NEXT_FRAME waits for the next frame */
export function sliced<T>(g: Generator<unknown, T, unknown>, pri: () => number = () => 0, rush?: () => boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    jobs.push({ g, pri, rush, order: order++, waiting: false, done: resolve as (v: unknown) => void, fail: reject })
    if (!rafOn && typeof requestAnimationFrame !== 'undefined') { rafOn = true; requestAnimationFrame(tick) }
    post()
  })
}

/** a step generator that reports how far it got: 1 - e^(-steps/k), rising with every step, 1 only when it ends */
export function* counted<T>(g: Generator<unknown, T, unknown>, report: (f: number) => void, k = 40): Generator<unknown, T, unknown> {
  let n = 0
  for (;;) {
    const r = g.next()
    if (r.done) { report(1); return r.value }
    report(1 - Math.exp(-++n / k))
    yield r.value
  }
}

type Drawable = THREE.Mesh | THREE.Points | THREE.Line | THREE.Sprite
const isDrawable = (o: THREE.Object3D): o is Drawable => !!((o as any).isMesh || (o as any).isPoints || (o as any).isLine || (o as any).isSprite)

/** what changes a program for the same material (three's object-dependent parameters) */
function variantKey(o: Drawable, m: THREE.Material) {
  const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
  const a = g?.attributes ?? {}
  return m.uuid + (o as any).isInstancedMesh + !!(o as any).instanceColor + (o as any).isSkinnedMesh + (o as any).isPoints + (o as any).isLine +
    !!g?.morphAttributes?.position + !!a.uv1 + !!a.tangent + ((a.color as THREE.BufferAttribute | undefined)?.itemSize ?? 0)
}

export type CompileJob = {
  /** objects to compile (their whole subtrees) */
  roots: THREE.Object3D[]
  /** the scene they are drawn in (its visible lights, fog and environment are part of the program) */
  scene: THREE.Scene
  camera: THREE.Camera
  /** the target they are drawn into (null = the screen: tone mapping / colour space are part of the program) */
  target: THREE.WebGLRenderTarget | null
  /** also compile with every object under `force` visible (the stage's own lights on) */
  force?: THREE.Object3D | null
  /** a material drawn over these objects (scene.overrideMaterial) */
  override?: THREE.Material | null
}

/** compile the programs of a job, one object (one material variant) per step */
export function* compileSteps(gl: THREE.WebGLRenderer, job: CompileJob): Generator<unknown, void, unknown> {
  const list: Drawable[] = []
  for (const r of job.roots) r.traverse((o) => { if (isDrawable(o)) list.push(o) })
  const passes = job.force ? [false, true] : [false]
  for (const forced of passes) {
    const seen = new Set<string>()
    for (const o of list) {
      const mats = job.override ? [job.override] : (Array.isArray(o.material) ? o.material : [o.material]).filter(Boolean) as THREE.Material[]
      const fresh = mats.filter((m) => { const k = variantKey(o, m); if (seen.has(k)) return false; seen.add(k); return true })
      if (!fresh.length) continue
      compileOne(gl, o, fresh, job, forced)
      yield
    }
  }
}

/** three's compile() for one object, without walking its children (a duck "scene" that lists just this object) */
function compileOne(gl: THREE.WebGLRenderer, o: Drawable, mats: THREE.Material[], job: CompileJob, forced: boolean) {
  const vis: [THREE.Object3D, boolean][] = []
  if (forced && job.force) job.force.traverse((x) => { vis.push([x, x.visible]); x.visible = true })
  const keep = o.material
  const prev = gl.getRenderTarget()
  try {
    gl.setRenderTarget(job.target)
    const one = { traverse: (fn: (x: THREE.Object3D) => void) => fn(o), traverseVisible: () => {} }
    for (const m of mats) { (o as THREE.Mesh).material = m; gl.compile(one as unknown as THREE.Object3D, job.camera, job.scene) }
  } catch (e) { console.warn('[prewarm] compile', e) }
  finally {
    ;(o as THREE.Mesh).material = keep
    gl.setRenderTarget(prev)
    for (const [x, v] of vis) x.visible = v
  }
}

/** every program created since `before`, linked: polled each frame where the driver links in parallel, else one
 *  blocking link per step; then its uniforms are read once (three's first use), so the first real draw finds it ready */
export function* linkSteps(gl: THREE.WebGLRenderer, before: Set<unknown>): Generator<unknown, void, unknown> {
  const pending = ((gl.info as any).programs as any[] ?? []).filter((p) => !before.has(p))
  const par = gl.extensions.has('KHR_parallel_shader_compile')
  while (pending.length) {
    if (par) {
      let got = false
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].isReady()) { try { pending[i].getUniforms() } catch (e) { console.warn('[prewarm] link', e) } pending.splice(i, 1); got = true; yield }
      }
      if (pending.length && !got) yield NEXT_FRAME
    } else {
      const p = pending.shift()
      try { p.getUniforms() } catch (e) { console.warn('[prewarm] link', e) }
      yield
    }
  }
}

const TEX_KEYS = ['map', 'envMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'aoMap', 'emissiveMap', 'bumpMap', 'lightMap', 'clearcoatNormalMap', 'matcap', 'gradientMap', 'specularMap', 'displacementMap']

/** every texture the job's materials sample uploaded, and every render target they read allocated */
export function* uploadSteps(gl: THREE.WebGLRenderer, roots: THREE.Object3D[], targets: (THREE.WebGLRenderTarget | null | undefined)[] = []): Generator<unknown, void, unknown> {
  const tex = new Set<THREE.Texture>(), rts = new Set<THREE.WebGLRenderTarget>()
  const take = (v: unknown) => {
    const t = v as THREE.Texture
    if (!t || !(t as any).isTexture) return
    if ((t as any).isRenderTargetTexture) return // its target is listed by the stage (three r170 textures don't point back)
    tex.add(t)
  }
  const mats = new Set<THREE.Material>()
  for (const r of roots) r.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) (Array.isArray(m) ? m : [m]).forEach((x) => mats.add(x)) })
  for (const m of mats) {
    for (const k of TEX_KEYS) take((m as any)[k])
    const u = (m as THREE.ShaderMaterial).uniforms
    if (u) for (const k in u) { const v = u[k]?.value; if (Array.isArray(v)) v.forEach(take); else take(v) }
  }
  for (const t of targets) if (t) rts.add(t)
  for (const rt of rts) { try { gl.initRenderTarget(rt) } catch (e) { console.warn('[prewarm] rt', e) } yield }
  for (const t of tex) {
    const img = (t as any).image
    if ((t as any).isVideoTexture || (img && 'complete' in img && !img.complete)) continue
    try { gl.initTexture(t) } catch (e) { console.warn('[prewarm] tex', e) }
    yield
  }
}

/** the full warm-up of a list of jobs: compile, link, upload */
export function* warmSteps(gl: THREE.WebGLRenderer, jobs: CompileJob[], targets: (THREE.WebGLRenderTarget | null | undefined)[] = []): Generator<unknown, void, unknown> {
  const before = new Set((gl.info as any).programs ?? [])
  for (const j of jobs) yield* compileSteps(gl, j)
  yield* linkSteps(gl, before)
  yield* uploadSteps(gl, jobs.flatMap((j) => j.roots), targets)
}

/** extra warm-up jobs a mounted stage registers (scenes it draws on its own: the tablet's inner world, the tunnel
 *  blur, the CTA type, the dive's particle sim and god-ray mask) */
type Extra = () => { jobs?: CompileJob[]; targets?: (THREE.WebGLRenderTarget | null | undefined)[]; steps?: Generator<unknown, void, unknown> }
const extras = new Map<string, Extra[]>()
export const prewarm = {
  /** a stage's own scenes; returns the unregister */
  add(stage: string, fn: Extra) {
    const l = extras.get(stage) ?? []; l.push(fn); extras.set(stage, l)
    return () => { const a = extras.get(stage); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) } }
  },
  extras(stage: string) { return (extras.get(stage) ?? []).map((f) => f()) },
  /** set by a stage whose own mount-time warm-up (a synchronous compile) was already done here */
  done: new Set<string>(),
  /** the warm-up (gl/Scene.tsx) is still running and owns the stages' warm-up: no synchronous compile at mount */
  active: true,
}
;(window as any).__prewarm = prewarm
