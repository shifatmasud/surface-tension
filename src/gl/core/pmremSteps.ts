import * as THREE from 'three'
import { GPU_FRAME } from '../prewarm'

/**
 * R6.77 BOOT FREEZES (M02 rig, CPU 6x: a stage's reflection environment was ~0.8 s of GPU work queued in ONE task behind
 * the curtain, and the next frame waited for all of it). three's PMREMGenerator (r170) fromScene / fromEquirectangular,
 * step by step: the same private calls with the same arguments in the same order (scene or texture → cube UV, the sigma
 * blur, then every LOD's two half blurs), one GPU pass per step, a frame after each big one (GPU_FRAME, prewarm.ts; a rushed stage runs straight on), and
 * the renderer's target, xr flag and autoClear put back after every step. Run to its end in one go (runToEnd) it is the
 * same call sequence as fromScene / fromEquirectangular. Falls back to three's own call if the internals are missing.
 */
const PHI = (1 + Math.sqrt(5)) / 2, INV_PHI = 1 / PHI
// three's _axisDirections (src/extras/PMREMGenerator.js), same order
const AXES = [new THREE.Vector3(-PHI, INV_PHI, 0), new THREE.Vector3(PHI, INV_PHI, 0), new THREE.Vector3(-INV_PHI, 0, PHI), new THREE.Vector3(INV_PHI, 0, PHI),
  new THREE.Vector3(0, PHI, -INV_PHI), new THREE.Vector3(0, PHI, INV_PHI), new THREE.Vector3(-1, 1, -1), new THREE.Vector3(1, 1, -1), new THREE.Vector3(-1, 1, 1), new THREE.Vector3(1, 1, 1)]

const ok = (p: any) => typeof p._setSize === 'function' && typeof p._allocateTargets === 'function' && typeof p._halfBlur === 'function' &&
  typeof p._sceneToCubeUV === 'function' && typeof p._textureToCubeUV === 'function'

function stepper(gl: THREE.WebGLRenderer) {
  /** one GPU pass with xr off (and autoClear as given), the renderer's target, xr flag and autoClear put back after it */
  return (autoClear: boolean | null, f: () => void) => {
    const prev = gl.getRenderTarget(), face = gl.getActiveCubeFace(), mip = gl.getActiveMipmapLevel(), xr = gl.xr.enabled, ac = gl.autoClear
    gl.xr.enabled = false
    if (autoClear !== null) gl.autoClear = autoClear
    try { f() } finally { gl.autoClear = ac; gl.setRenderTarget(prev, face, mip); gl.xr.enabled = xr }
  }
}

/** the blurs after the first pass: an optional sigma blur (fromScene), then _applyPMREM (autoClear off), then _cleanup */
function* blurs(gl: THREE.WebGLRenderer, p: any, out: THREE.WebGLRenderTarget, sigma: number) {
  const step = stepper(gl)
  // the big LODs (the 256 and 128 faces) get a frame each; the small ones are a few thousand pixels and only yield
  const blur = function* (lodIn: number, lodOut: number, sg: number, ac: boolean | null, axis?: THREE.Vector3) {
    const wait = lodOut <= 1 ? GPU_FRAME : undefined
    step(ac, () => p._halfBlur(out, p._pingPongRenderTarget, lodIn, lodOut, sg, 'latitudinal', axis)); yield wait
    step(ac, () => p._halfBlur(p._pingPongRenderTarget, out, lodOut, lodOut, sg, 'longitudinal', axis)); yield wait
  }
  if (sigma > 0) yield* blur(0, 0, sigma, null)
  const n = p._lodPlanes.length
  for (let i = 1; i < n; i++) {
    const sg = Math.sqrt(p._sigmas[i] * p._sigmas[i] - p._sigmas[i - 1] * p._sigmas[i - 1])
    yield* blur(i - 1, i, sg, false, AXES[(n - i - 1) % AXES.length])
  }
  out.scissorTest = false
  out.viewport.set(0, 0, out.width, out.height); out.scissor.set(0, 0, out.width, out.height)
  return out
}

/** = pm.fromScene(scene, sigma, near, far), in steps */
export function* pmremFromSceneSteps(gl: THREE.WebGLRenderer, pm: THREE.PMREMGenerator, scene: THREE.Scene, sigma = 0, near = 0.1, far = 100): Generator<unknown, THREE.WebGLRenderTarget, unknown> {
  const p = pm as any
  if (!ok(p)) return pm.fromScene(scene, sigma, near, far)
  let out!: THREE.WebGLRenderTarget
  stepper(gl)(null, () => {
    p._setSize(256)
    out = p._allocateTargets()
    out.depthBuffer = true
    p._sceneToCubeUV(scene, near, far, out)
  })
  yield GPU_FRAME
  return yield* blurs(gl, p, out, sigma)
}

/** = pm.fromEquirectangular(texture), in steps */
export function* pmremFromEquirectSteps(gl: THREE.WebGLRenderer, pm: THREE.PMREMGenerator, texture: THREE.Texture): Generator<unknown, THREE.WebGLRenderTarget, unknown> {
  const p = pm as any
  if (!ok(p) || texture.mapping === THREE.CubeReflectionMapping || texture.mapping === THREE.CubeRefractionMapping) return pm.fromEquirectangular(texture)
  let out!: THREE.WebGLRenderTarget
  stepper(gl)(null, () => {
    p._setSize((texture.image as { width: number }).width / 4)
    out = p._allocateTargets()
    p._textureToCubeUV(texture, out)
  })
  yield GPU_FRAME
  return yield* blurs(gl, p, out, 0)
}
