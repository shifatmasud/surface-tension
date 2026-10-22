import * as THREE from 'three'
import { runToEnd } from '../../prewarm'
import { pmremFromEquirectSteps } from '../../core/pmremSteps'

/**
 * Procedural reflection environments (no HDR download): a small equirect painted with canvas gradients,
 * prefiltered by PMREM. All three share one size, so swapping material.envMap never recompiles.
 */
type Blob = { u: number; v: number; r: number; color: string; a: number }
function paint(top: string, mid: string, bottom: string, blobs: Blob[]) {
  const W = 512, H = 256
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const g = c.getContext('2d')!
  const grd = g.createLinearGradient(0, 0, 0, H)
  grd.addColorStop(0, top); grd.addColorStop(0.5, mid); grd.addColorStop(1, bottom)
  g.fillStyle = grd; g.fillRect(0, 0, W, H)
  g.globalCompositeOperation = 'lighter'
  for (const b of blobs) {
    for (const off of [-W, 0, W]) { // wrap horizontally
      const x = b.u * W + off, y = b.v * H, r = b.r * H
      const rg = g.createRadialGradient(x, y, 0, x, y, r)
      rg.addColorStop(0, b.color); rg.addColorStop(1, 'rgba(0,0,0,0)')
      g.globalAlpha = b.a; g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2)
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.mapping = THREE.EquirectangularReflectionMapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export function makeEnvs(gl: THREE.WebGLRenderer) { return runToEnd(makeEnvsSteps(gl)) }
/** R6.77: the same three environments, each PMREM one GPU pass per step (core/pmremSteps.ts) */
export function* makeEnvsSteps(gl: THREE.WebGLRenderer) {
  const pm = new THREE.PMREMGenerator(gl)
  const build = function* (t: THREE.Texture) { const r = (yield* pmremFromEquirectSteps(gl, pm, t)).texture; t.dispose(); return r }
  // deep space: violet/teal nebula glow + a warm star
  const space = yield* build(paint('#0a0620', '#140a2a', '#03040a', [
    { u: 0.15, v: 0.35, r: 0.5, color: '#c02a8a', a: 0.9 },
    { u: 0.62, v: 0.45, r: 0.45, color: '#1aa6b0', a: 0.75 },
    { u: 0.4, v: 0.25, r: 0.12, color: '#fff2d8', a: 1 },
  ]))
  // forest morning: blue zenith, golden horizon, green ground bounce
  const forest = yield* build(paint('#3d78d8', '#ffd8a6', '#2a5a2c', [
    { u: 0.3, v: 0.42, r: 0.18, color: '#fff6e0', a: 1 },
    { u: 0.8, v: 0.6, r: 0.4, color: '#3f9a46', a: 0.5 },
  ]))
  // the page: black room, soft white softboxes, a green spill from below (the screen)
  const page = yield* build(paint('#2a2d33', '#07080a', '#020203', [
    { u: 0.22, v: 0.3, r: 0.16, color: '#ffffff', a: 1 },
    { u: 0.97, v: 0.36, r: 0.1, color: '#ffffff', a: 0.9 },
    { u: 0.72, v: 0.32, r: 0.14, color: '#e8eef8', a: 0.7 },
    { u: 0.47, v: 0.34, r: 0.11, color: '#ffffff', a: 0.85 },
    { u: 0.03, v: 0.4, r: 0.12, color: '#dfe8f5', a: 0.7 },
    { u: 0.5, v: 0.8, r: 0.4, color: '#2f9a54', a: 0.35 },
  ]))
  pm.dispose()
  return { space, forest, page }
}
