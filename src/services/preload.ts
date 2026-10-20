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
const W = window as unknown as { __stboot?: BootInfo; requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }

const VISIT_KEY = 'st-visit'
let repeat = false
try { repeat = !!localStorage.getItem(VISIT_KEY); localStorage.setItem(VISIT_KEY, String(Date.now())) } catch { /* private mode */ }

let expected = 0, arrived = 0
export const preload = {
  /** same browser has been here before: shorter counter */
  repeat,
  /** Shifat 10:51Z: the counter waits for the hero AND the next section (the lab: its card posters) */
  expect(n = 1) { expected += n },
  arrived(n = 1) { arrived += n },
  /** next-section progress 0..1 (1 when nothing was registered by the time the scene is up) */
  next(sceneUp: boolean): number { return expected ? Math.min(1, arrived / expected) : (sceneUp ? 1 : 0) },
  /** byte-weighted progress of the boot JS (entry + vendor chunks + Scene), 0..1; 1 when the inline loader is absent (dev) */
  files(): number { try { return W.__stboot ? W.__stboot.files() : 1 } catch { return 1 } },
  /** the number the static shell counter already shows (the React counter never goes backwards from it) */
  shown(): number { return W.__stboot?.shown ?? 0 },
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
export function warmCompile(gl: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene, target: THREE.WebGLRenderTarget | null): Promise<void> {
  const prev = gl.getRenderTarget()
  let p: Promise<unknown>
  try {
    gl.setRenderTarget(target)
    p = (gl as any).compileAsync ? (gl as any).compileAsync(root, camera, scene) : Promise.resolve(gl.compile(root, camera, scene))
  } catch (e) { p = Promise.resolve(); console.warn('[preload] warm', e) }
  finally { gl.setRenderTarget(prev) }
  return Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, 6000))])
}
;(window as any).__preload = preload

// repeat visits: the service worker keeps the hashed boot files (and posters) so the next visit starts from cache.
// Registered after the curtain, in an idle slot, so it never competes with the first load. ?nosw removes it (QA).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  if (/[?&]nosw/.test(location.search)) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {})
  else preload.afterIntro(() => { navigator.serviceWorker.register('./sw.js').catch(() => {}) }, 1500)
}
