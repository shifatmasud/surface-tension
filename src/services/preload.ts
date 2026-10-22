import type * as THREE from 'three'
import { props } from '../state/props'

/**
 * PRELOAD (Shifat 10:06Z: "best preloading strategy … without sacrificing performance").
 *
 * The counter tracks only what the FIRST SCREEN needs: the JS for the shell + hero (byte-weighted, measured by the
 * inline boot loader from the very first frame), the brand font, and the hero's GPU warm-up (its shaders compile in
 * parallel through KHR_parallel_shader_compile, so the counter keeps moving instead of freezing on a link).
 * Everything else — the systems / dive / journey stages, their shaders, the lab posters and reels — is pulled in
 * after the curtain lifts, one piece per idle slot, nearest section first, and always before you can scroll to it.
 * A repeat visit (same browser) gets a short counter, and the hashed files come from the service-worker cache.
 */
type BootInfo = { files(): number; shown: number; t0: number }
const W = window as unknown as { __stboot?: BootInfo; __stodo?: { v: number; adopted: boolean }; requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }

const VISIT_KEY = 'st-visit'
let repeat = false
try { repeat = !!localStorage.getItem(VISIT_KEY); localStorage.setItem(VISIT_KEY, String(Date.now())) } catch { /* private mode */ }

let expected = 0, arrived = 0
let sExpected = 0, sArrived = 0 // PERFGOV: the later stages warmed behind the curtain (gl/Scene.tsx LaterStages)
export const preload = {
  /** same browser has been here before: shorter counter */
  repeat,
  /** Shifat 10:51Z: the counter waits for the hero AND the next section (the lab: its card posters) */
  expect(n = 1) { expected += n },
  arrived(n = 1) { arrived += n },
  /** next-section progress 0..1 (1 when nothing was registered by the time the scene is up) */
  next(sceneUp: boolean): number {
    const lab = expected ? Math.min(1, arrived / expected) : (sceneUp ? 1 : 0)
    // PERFGOV: the stages are half of this share whatever the poster count (counted with the posters, a dozen posters
    // diluted them below the counter's 97 % "parked" rule, which then lifted the curtain on half-warmed stages)
    return sExpected ? 0.5 * lab + 0.5 * Math.min(1, sArrived / sExpected) : lab
  },
  /** PERFGOV: the later stages' warm-up (gl/Scene.tsx), 0..n */
  expectStages(n: number) { sExpected += n },
  arrivedStages(n: number) { sArrived += n },
  /** byte-weighted progress of the boot JS (entry + vendor chunks + Scene), 0..1; 1 when the inline loader is absent (dev) */
  files(): number { try { return W.__stboot ? W.__stboot.files() : 1 } catch { return 1 } },
  /** the number the static shell counter already shows (the React counter never goes backwards from it) */
  shown(): number { return W.__stodo?.v ?? W.__stboot?.shown ?? 0 },
  /** run when the browser is idle (or after `timeout` ms at the latest) */
  idle(fn: () => void, timeout = 600) {
    if (W.requestIdleCallback) W.requestIdleCallback(fn, { timeout }); else setTimeout(fn, 32)
  },
  /** run once the curtain has fully lifted (html.is-lifted, so nothing heavy lands mid-curtain) plus `delay` ms,
   *  in an idle slot; 4 s after the drop at the latest (reduced motion / a curtain that never reports) */
  afterIntro(fn: () => void, delay = 0) {
    let fired = false
    const go = () => { if (fired) return; fired = true; setTimeout(() => preload.idle(fn), delay) }
    const h = document.documentElement
    if (h.classList.contains('is-lifted')) { go(); return }
    const mo = new MutationObserver(() => { if (h.classList.contains('is-lifted')) { mo.disconnect(); go() } })
    mo.observe(h, { attributes: true, attributeFilter: ['class'] })
    const late = () => setTimeout(() => { mo.disconnect(); go() }, 4000)
    if (props.introDone) late(); else window.addEventListener('st:drop', late, { once: true })
  },
}

/**
 * Compile every program under `root` (hidden objects included) without drawing and without blocking the main thread
 * on the driver. The render target is the one the scene pass draws into, so the program keys match the real frame
 * (linear output, no tone-mapping) and nothing recompiles on first use. Resolves when the driver reports every
 * program linked (at once without KHR_parallel_shader_compile), or after 6 s at the latest.
 */
export function warmCompile(gl: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene, target: THREE.WebGLRenderTarget | null, report?: (f: number) => void): Promise<void> {
  const prev = gl.getRenderTarget()
  const before = new Set(gl.info.programs ?? [])
  let p: Promise<unknown>
  try {
    gl.setRenderTarget(target)
    p = (gl as any).compileAsync ? (gl as any).compileAsync(root, camera, scene) : Promise.resolve(gl.compile(root, camera, scene))
  } catch (e) { p = Promise.resolve(); console.warn('[preload] warm', e) }
  finally { gl.setRenderTarget(prev) }
  // DIAG: without KHR_parallel_shader_compile (Chrome on Windows/ANGLE-D3D11, many Androids) compileAsync resolves at
  // once and every link is paid by the FIRST real frame instead: measured on live at 1440 the counter read 100 % of
  // the GPU work at 1.3 s, then frames of 1.5 s and 4.8 s froze it at 28 and it jumped to 98. Here each new program's
  // link status is read one per frame (the call that blocks), counted as progress, so the stall is spread and shown.
  const linkEach = () => new Promise<void>((resolve) => {
    if (gl.extensions.has('KHR_parallel_shader_compile')) { resolve(); return }
    const todo = (gl.info.programs ?? []).filter((q) => !before.has(q))
    let i = 0
    const linkOne = () => {
      try { (todo[i] as any).getUniforms() } catch (e) { console.warn('[preload] link', e) }
      i++; report?.(i / todo.length)
    }
    // W20 PERF: the blocking link reads run in the browser's idle time after a frame, never inside one (they were
    // landing in the hero's rAF at one link per frame: 5–6 ms frames on the 390 rig against 2 ms once linked). As
    // many links as the idle slice holds run per callback, so the queue also drains sooner and a cold jump finds the
    // stage linked. Without requestIdleCallback (Safari) it stays one link per frame, as before.
    const ric = (window as any).requestIdleCallback as undefined | ((cb: (d: { timeRemaining(): number; didTimeout: boolean }) => void, o?: { timeout: number }) => number)
    const idle = (d: { timeRemaining(): number; didTimeout: boolean }) => {
      do { if (i >= todo.length) break; linkOne() } while (d.timeRemaining() > 4)
      if (i >= todo.length) { resolve(); return }
      ric!(idle, { timeout: 500 })
    }
    const step = () => {
      if (i >= todo.length) { resolve(); return }
      linkOne()
      requestAnimationFrame(step)
    }
    if (ric) ric(idle, { timeout: 500 })
    else requestAnimationFrame(step)
  })
  return Promise.race([p.then(linkEach, linkEach), new Promise<void>((r) => setTimeout(r, 10000))])
}
;(window as any).__preload = preload

/**
 * WARM GATE (PRELOAD, the desktop "sits at 32" stall). A program's link is cheap (≤ 27 ms each, measured); the expensive
 * step is the driver building the real shader the first time a program DRAWS (measured: the one curtain-hidden frame that
 * switched every post pass on, plus the gem/caustic variants of the real frame, took 4.6–5.2 s at 1440 on a GPU without
 * KHR_parallel_shader_compile; the counter sat still for all of it). While the gate is open, the real frame code runs as
 * usual behind the curtain, but each frame lets only `budget` programs that have never drawn make their first draw; every
 * other draw of a not-yet-built program is skipped, and every draw goes into a 1×1 viewport (no clears, no mip builds),
 * so a frame costs the shader builds it carries and almost nothing else. The counter advances with built/seen programs.
 * The gate closes after a frame that skipped nothing: every program of the real frame has drawn, which is what the old
 * full-size warm frame was for, so the warm-up ends there (counter → 100). Nothing is visible: the curtain is opaque.
 */
type GL2 = WebGL2RenderingContext
export const warmGate = {
  active: false,
  seen: 0,
  built: 0,
  budget: 3,
  /** 0..1 while open; 1 once closed (or never needed) */
  get progress() { return this.active ? (this.seen ? this.built / this.seen : 0) : (this.closedAt ? 1 : 0) },
  closedAt: 0,
  openedAt: 0,
  frames: 0,
  _skipped: 0,
  _allow: 0,
  _last: 0,
  _restore: null as null | (() => void),
  open(renderer: THREE.WebGLRenderer) {
    if (this.active || this.closedAt) return
    const c = renderer.getContext() as GL2
    const built = new WeakSet<WebGLProgram>(), seen = new WeakSet<WebGLProgram>()
    let cur = c.getParameter(c.CURRENT_PROGRAM) as WebGLProgram | null
    const g = this
    const pass = () => {
      if (!cur || built.has(cur)) return true
      if (!seen.has(cur)) { seen.add(cur); g.seen++ }
      if (g._allow > 0) { g._allow--; built.add(cur); g.built++; return true }
      g._skipped++
      return false
    }
    const o = { useProgram: c.useProgram, viewport: c.viewport, clear: c.clear, generateMipmap: c.generateMipmap, drawArrays: c.drawArrays, drawElements: c.drawElements, drawArraysInstanced: c.drawArraysInstanced, drawElementsInstanced: c.drawElementsInstanced, drawRangeElements: c.drawRangeElements }
    const k = c as any
    k.useProgram = function (p: WebGLProgram | null) { cur = p; return o.useProgram.call(c, p) }
    k.viewport = function () { return o.viewport.call(c, 0, 0, 1, 1) }
    k.clear = function () { /* gate: no fill work */ }
    k.generateMipmap = function () { /* gate: no fill work */ }
    for (const n of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'] as const) {
      const f = o[n] as (...a: unknown[]) => void
      k[n] = function (...a: unknown[]) { if (pass()) return f.apply(c, a) }
    }
    this._restore = () => { for (const n of Object.keys(o)) delete k[n]; renderer.resetState() }
    this.active = true; this.openedAt = this._last = performance.now(); this._allow = this.budget
  },
  /** after the frame's last draw: true when the gate just closed (the next frame is the full-size warm frame) */
  endFrame(): boolean {
    if (!this.active) return false
    const now = performance.now(), dt = now - this._last; this._last = now; this.frames++
    const done = this._skipped === 0
    if (done || now - this.openedAt > 15000) { this.close(); return true }
    // adapt to the GPU: fast frames take more first draws, slow ones fewer (each frame stays well under ~0.5 s)
    // PERFGOV (Shifat 18:21Z "preloader & hero freeze"): the budget used to grow until a gate frame took ~160 ms and only
    // shrank past 420 ms, so the odometer could sit still for 0.2–0.4 s per frame on a phone. Now it aims at ~50 ms frames
    // (halve above 60 ms, grow only below 30 ms): the same programs are built, spread over more, shorter frames.
    if (this.frames > 1) this.budget = dt < 30 ? Math.min(this.budget * 2, 32) : dt < 45 ? this.budget + 1 : dt > 60 ? Math.max(1, this.budget >> 1) : this.budget
    this._skipped = 0; this._allow = this.budget
    return false
  },
  close() { if (!this.active) return; this.active = false; this.closedAt = performance.now(); this._restore?.(); this._restore = null },
}
;(window as any).__warmGate = warmGate

// repeat visits: the service worker keeps the hashed boot files (and posters) so the next visit starts from cache.
// Registered after the curtain, in an idle slot, so it never competes with the first load. ?nosw removes it (QA).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  if (/[?&]nosw/.test(location.search)) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {})
  else preload.afterIntro(() => { navigator.serviceWorker.register('./sw.js').catch(() => {}) }, 1500)
}
