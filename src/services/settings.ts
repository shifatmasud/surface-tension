// Layer 0 — platform. Read-only after boot. URL-overridable flags (handbook ch.2).
const q = new URLSearchParams(location.search)
const ua = navigator.userAgent
export const MOBILE_WIDTH = 812

export const browser = {
  isMobile: /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)),
  isSafari: /^((?!chrome|android).)*safari/i.test(ua),
  isFirefox: /firefox/i.test(ua),
  canHover: matchMedia('(hover: hover)').matches,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  dpr: Math.min(window.devicePixelRatio || 1, 3),
}

function detectWebGL2() {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2')
    if (!gl) return { ok: false, renderer: 'none' }
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown'
    const floatRT = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float')
    ;(gl.getExtension('WEBGL_lose_context') as any)?.loseContext()
    return { ok: floatRT, renderer }
  } catch { return { ok: false, renderer: 'error' } }
}
// R6.76 LOAD PATH: index.html's first-paint probe already made a WebGL2 context and read the same two facts; reuse them
// (one context creation fewer in the boot task). Without the probe's record (?nogl, reduced motion skip it) detect here.
const probed = (window as any).__stgl as { ok: boolean; renderer: string } | undefined
const gl2 = probed && typeof probed.renderer === 'string' ? { ok: !!probed.ok, renderer: probed.renderer } : detectWebGL2()

const lowPower = /Mali-4|Adreno \(TM\) [2-4]/i.test(gl2.renderer)
/** R6.92 WEAK GPU (Shifat Oct 23 8:08–8:18 AM, Windows desktop, "ANGLE (Intel, Intel(R) UHD Graphics 600 … Direct3D11)":
 *  tier mid crashed the GPU — boot stall, GPU reset, context lost, static page). Integrated GPUs well under the site's mid
 *  load take the PHONE RENDER STRATEGY on desktop: tier 'low' (split resolution: background 0.5–0.75, heroes 1.0, GPU text
 *  1.5, trail 1.0) while the layout, hover and cursor stay desktop (layout reads the viewport + pointer, never the tier).
 *  Weak = Intel UHD 6xx, Intel HD Graphics (numbered 2000–6000 / 4xx–6xx, or bare) without Iris, AMD R2–R5 APUs; or any
 *  integrated GPU (Intel, AMD APU) on a ≤ 4-thread CPU or a ≤ 4 GB device (Shifat's PC: 2 threads, 3 GB). Strong GPUs (Iris Xe, Arc, UHD 7xx with a real CPU,
 *  discrete) are unchanged. Also forced by ?weakgpu / ?intel (QA), and by a GPU loss this browser had on the site in the
 *  last 7 days (st-gpu-weak, written by gl/Scene.tsx before it reloads into this tier). ?noweak ignores and clears both. */
const WEAK_KEY = 'st-gpu-weak'
const WEAK_TTL = 7 * 864e5
function readWeakFlag() {
  try {
    if (q.has('noweak')) { localStorage.removeItem(WEAK_KEY); return false }
    const t = Number(localStorage.getItem(WEAK_KEY) || 0)
    if (t && Date.now() - t < WEAK_TTL) return true
    if (t) localStorage.removeItem(WEAK_KEY)
  } catch { /* private mode */ }
  return false
}
const r = gl2.renderer
const intel = /Intel/i.test(r) && !/Iris|Arc\b/i.test(r)
const weakIntel = intel && (/UHD Graphics 6\d\d\b/i.test(r) || /HD Graphics(\s?\d{3,4}\b|\s*\(|\s+Direct3D|\s+OpenGL|\s+Metal|\s*,|\s*\)|\s*$)/i.test(r) && !/UHD Graphics [7-9]\d\d/i.test(r))
const weakApu = /Radeon(\(TM\))? R[2-5] Graphics|Radeon(\(TM\))? HD [5-8]\d{3}[DG]?\b/i.test(r)
const fewCores = (navigator.hardwareConcurrency || 8) <= 4
const lowMem = ((navigator as any).deviceMemory || 8) <= 4
const integrated = intel || /Radeon(\(TM\))? (Vega \d+ |)Graphics\b/i.test(r)   // Intel iGPUs (not Iris/Arc), AMD APUs
// phones are already on tier low with their own locked densities: the weak rule never touches them (it never RAISES a tier)
const phoneLike = browser.isMobile || (window.innerWidth <= MOBILE_WIDTH && matchMedia('(pointer: coarse)').matches)
export const WEAK_GPU_FORCED = q.has('weakgpu') || q.has('intel')
export const WEAK_GPU_STORED = !q.has('noweak') && !phoneLike && readWeakFlag()
export const WEAK_GPU = !q.has('noweak') && (WEAK_GPU_FORCED || (!phoneLike && (WEAK_GPU_STORED || weakIntel || weakApu || (integrated && (fewCores || lowMem)))))
export const WEAK_WHY = !WEAK_GPU ? '' : WEAK_GPU_FORCED ? 'forced' : WEAK_GPU_STORED ? 'stored (a GPU loss here in the last 7 days)' : weakIntel ? 'weak Intel iGPU' : weakApu ? 'weak AMD APU' : 'integrated GPU on a <=4-thread CPU or <=4 GB device'
export function markWeakGpu() { try { localStorage.setItem(WEAK_KEY, String(Date.now())) } catch { /* private mode */ } }
/** No GPU at all (a software rasteriser: VMs, disabled hardware acceleration, headless test browsers): the live scenes
 * would run at 1–2 fps and block the main thread, so these visitors get the designed static (no-WebGL) page.
 * ?forcegl keeps the WebGL path for QA. */
export const softwareGL = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gl2.renderer)
/** R6.92: Chrome's refusal after GPU resets reports its renderer as "Disabled" — no WebGL page, ?forcegl or not */
const disabledGL = /Disabled/i.test(gl2.renderer)

export type Tier = 'high' | 'mid' | 'low' | 'none'
function pickTier(): Tier {
  if (q.has('nogl') || !gl2.ok || disabledGL) return 'none'
  try { if (sessionStorage.getItem('st-gl-dead') && !q.has('forcegl')) return 'none' } catch { /* private mode */ }   // R6.92: the browser refused WebGL this session (App.tsx SceneGuard)
  if (softwareGL && !q.has('forcegl')) return 'none'
  if (browser.reducedMotion && !q.has('motion')) return 'none'
  if (q.has('hd')) return 'high'
  if (q.has('lowq')) return 'low'
  // a narrow window alone is not a phone: a desktop GPU loaded in a small window (or a remote browser that
  // sizes its viewport after load) must not drop to the phone tier — require a coarse pointer too
  if (browser.isMobile || (window.innerWidth <= MOBILE_WIDTH && matchMedia('(pointer: coarse)').matches)) return 'low'
  if (lowPower) return 'low'
  if (WEAK_GPU) return 'low'   // R6.92: weak desktop GPUs render like a phone (layout stays desktop)
  return (navigator.hardwareConcurrency || 4) >= 8 ? 'high' : 'mid'
}
const tier = pickTier()

/** Total render pixels are capped, not just the ratio: an ultrawide or 4K window at dpr 1.5 is 2–4x the fill of a
 * laptop for the same picture. Keep w*h*dpr^2 under ~3.7M px (the post chain sharpens when below native). */
export const MAX_RENDER_PIXELS = 3.7e6
export function capDpr(w: number, h: number) {
  const tierCap = tier === 'low' ? 1.25 : 1.2 // R6.79: desktop max 1.2 (Shifat Oct 22)
  const byPixels = Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, w * h))
  return Math.max(0.6, Math.min(browser.dpr, tierCap, byPixels))
}

export const settings = {
  GRID: q.has('grid'),
  DEBUG: q.has('debug'),
  TIER: tier as Tier,
  WEBGL2: gl2.ok,
  GPU: gl2.renderer,
  /** R6.92: a weak GPU on the phone render path (see WEAK_GPU) */
  WEAK_GPU,
  USE_GL: tier !== 'none',
  /** DPR caps from the plan's perf budget. */
  DPR: capDpr(window.innerWidth, window.innerHeight),
  MAX_PIXELS: MAX_RENDER_PIXELS,
  RIPPLE_SIZE: tier === 'low' ? 128 : 256,
  BLOOM_HQ: tier === 'high',
  USE_BLOOM: tier !== 'low' || WEAK_GPU,   // R6.92: the bloom (a few half-res passes) is cheap enough for a weak desktop GPU: the sky keeps its glow
  HTML_TEXTURES: tier !== 'low' && !q.has('nohtml'),
  PAINT_DT_SCALED: q.has('paintdt'), // ch.14 parity: fades are per-frame by default, like the original
  MOBILE_WIDTH,
}
;(window as any).__settings = settings
