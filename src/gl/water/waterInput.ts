import * as THREE from 'three'
import { props } from '../../state/props'
import { pool } from '../systems/pool'

/**
 * WATER INPUT (water lane): the pointer as the lake sees it, for the ripple sim.
 *  - Touch: passive touchstart/touchmove/touchend on window. A finger that pans the page fires pointercancel and the
 *    pointer stream stops, so the old path drew nothing while you scrolled; touch events keep arriving during a
 *    native pan and, being passive, never block or delay it. The drag that scrolls is the drag that draws.
 *  - Visibility: the lake stamps the frame it was last drawn in (water.ts → material.onBeforeRender), and the HeroStage
 *    WATER HOOK calls frame() with the camera; the sim sleeps when the surface has not been drawn for a few frames.
 *  - QA (?qa only): window.__waterTrail([[x,y],...], ticks?) queues a stroke in CSS px (one sim tick per point), so a 1–3 fps
 *    remote GPU can still show a continuous trail.
 * Mouse input keeps its existing path (pool.ts → props.waterPointer); this module only adds what that path lacks.
 */
const ray = new THREE.Raycaster()
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const hit = new THREE.Vector3()
const ndc = new THREE.Vector2()

export const waterInput = {
  /** last frame the lake was actually drawn (set by the material) */
  seenFrame: -1e9,
  /** touch-derived pointer on the pool for this frame (uv), and whether it is painting */
  uv: new THREE.Vector2(0.5, 0.5),
  active: false,
  /** finger state in CSS px; t = performance.now() of the last move */
  touch: { x: 0, y: 0, t: -1e9, down: false, moved: false },
  /** QA queue of pool uvs (one per sim tick) */
  qa: [] as THREE.Vector2[],
  qaPx: [] as number[][],
  qaSettle: 0,
  installed: false,
  camera: null as THREE.Camera | null,

  install() {
    if (this.installed || typeof window === 'undefined') return
    this.installed = true
    const o = { passive: true } as AddEventListenerOptions
    const set = (e: TouchEvent) => {
      const t = e.touches[0]; if (!t) return
      this.touch.x = t.clientX; this.touch.y = t.clientY; this.touch.t = performance.now(); this.touch.down = true; this.touch.moved = true
    }
    window.addEventListener('touchstart', set, o)
    window.addEventListener('touchmove', set, o)
    const up = (e: TouchEvent) => { if (e.touches.length === 0) this.touch.down = false }
    window.addEventListener('touchend', up, o)
    window.addEventListener('touchcancel', up, o)
    if (/[?&]qa\b/.test(location.search)) (window as any).__waterTrail = (pts: number[][], settle = 0) => { this.qaPx.push(...pts); this.qaSettle = settle; return pts.length }
  },

  /** project a CSS-px point onto the pool; false when it misses the pool or the lake is not usable */
  project(x: number, y: number, camera: THREE.Camera, out: THREE.Vector2) {
    ndc.set((x / props.width) * 2 - 1, 1 - (y / props.height) * 2)
    ray.setFromCamera(ndc, camera)
    if (!ray.ray.intersectPlane(plane, hit)) return false
    const h = pool.size / 2
    if (Math.abs(hit.x) > h || Math.abs(hit.z) > h) return false
    out.set(hit.x / pool.size + 0.5, -hit.z / pool.size + 0.5)
    return true
  },

  /** WATER HOOK: called by HeroStage every frame it runs, with whether the lake is on */
  frame(camera: THREE.Camera, lakeOn: boolean) {
    this.install()
    this.camera = camera
    this.active = false
    const usable = lakeOn && camera.position.y > 0.2 && props.look.dive < 0.5 && !props.overlayOpen
    if (!usable) { this.qaPx.length = 0; return }
    while (this.qaPx.length) { const p = this.qaPx.shift()!; const v = new THREE.Vector2(); if (this.project(p[0], p[1], camera, v)) this.qa.push(v) }
    const t = this.touch
    // a move since the last frame always paints (a janky >140 ms frame never drops a stroke); a still finger keeps
    // painting for 140 ms so a page that is still gliding under it leaves its trail
    if (t.down && (t.moved || performance.now() - t.t < 140)) this.active = this.project(t.x, t.y, camera, this.uv)
    t.moved = false
  },

  /** true while the surface has been drawn within the last few frames */
  visible() { return props.frame - this.seenFrame <= 3 },
}
