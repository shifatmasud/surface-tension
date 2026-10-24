import * as THREE from 'three'
import { quality } from './quality'

/**
 * R7.07 #10, zero re-allocation (see quality.renderScale). The phone canvas keeps one size; a moving frame's final pass
 * draws into the bottom-left sub-rectangle (renderer viewport, scissors scaled to match) and the canvas element is scaled
 * up by CSS from its bottom-left corner so that sub-rectangle exactly covers the screen (the overflow is clipped by the
 * canvas's own container). A still frame draws the whole buffer with no transform. A frame that grabs the canvas as an
 * image (the loop wrap, the gift's still) is always drawn whole.
 */
let applied = 1, sx = 1, sy = 1, wrapped = false, lastBw = 0, lastBh = 0
;(window as any).__rscale = () => applied
export function applyRenderScale(gl: THREE.WebGLRenderer, w: number, h: number, forceWhole = false) {
  if (!wrapped) {
    wrapped = true
    const orig = gl.setScissor.bind(gl) as (x: any, y?: any, ww?: any, hh?: any) => void
    ;(gl as any).setScissor = (x: any, y?: number, ww?: number, hh?: number) => {
      if (applied < 1 && typeof x === 'number' && gl.getRenderTarget() === null) orig(x * sx, (y as number) * sy, (ww as number) * sx, (hh as number) * sy)
      else orig(x, y, ww, hh)
    }
  }
  const el = gl.domElement
  if (el.width !== lastBw || el.height !== lastBh) { lastBw = el.width; lastBh = el.height; applied = -1 }   // a real resize reset the viewport
  const s = forceWhole ? 1 : quality.renderScale()
  if (s === applied) return
  if (s >= 1) {
    applied = 1; sx = sy = 1
    gl.setViewport(0, 0, w, h)
    el.style.transform = ''
    return
  }
  const pr = gl.getPixelRatio(), bw = el.width, bh = el.height
  const vw = Math.max(1, Math.floor(bw * s)), vh = Math.max(1, Math.floor(bh * s))
  applied = s; sx = vw / bw; sy = vh / bh
  gl.setViewport(0, 0, vw / pr, vh / pr)
  el.style.transformOrigin = '0 100%'
  el.style.transform = `scale(${bw / vw}, ${bh / vh})`
}
