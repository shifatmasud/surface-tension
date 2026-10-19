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
const gl2 = detectWebGL2()

const lowPower = /SwiftShader|llvmpipe|Software|Mali-4|Adreno \(TM\) [2-4]/i.test(gl2.renderer)

export type Tier = 'high' | 'mid' | 'low' | 'none'
function pickTier(): Tier {
  if (q.has('nogl') || !gl2.ok) return 'none'
  if (browser.reducedMotion && !q.has('motion')) return 'none'
  if (q.has('hd')) return 'high'
  if (q.has('lowq')) return 'low'
  if (browser.isMobile || window.innerWidth <= MOBILE_WIDTH) return 'low'
  if (lowPower) return 'mid'
  return (navigator.hardwareConcurrency || 4) >= 8 ? 'high' : 'mid'
}
const tier = pickTier()

export const settings = {
  GRID: q.has('grid'),
  DEBUG: q.has('debug'),
  TIER: tier as Tier,
  WEBGL2: gl2.ok,
  GPU: gl2.renderer,
  USE_GL: tier !== 'none',
  /** DPR caps from the plan's perf budget. */
  DPR: tier === 'high' ? Math.min(browser.dpr, 1.5) : tier === 'mid' ? Math.min(browser.dpr, 1.25) : Math.min(browser.dpr, 1.25),
  MAX_PIXELS: 2560 * 1440,
  RIPPLE_SIZE: tier === 'low' ? 128 : 256,
  BLOOM_HQ: tier === 'high',
  USE_BLOOM: tier !== 'low',
  PARTICLES: tier === 'high' ? 128 : tier === 'mid' ? 96 : 64, // GPGPU grid side
  FLIP_RES: tier === 'low' ? 40 : 64,
  HTML_TEXTURES: tier !== 'low' && !q.has('nohtml'),
  TILE_COUNT: tier === 'low' ? 4 : 6,
  PAINT_DT_SCALED: q.has('paintdt'), // ch.14 parity: fades are per-frame by default, like the original
  MOBILE_WIDTH,
}
;(window as any).__settings = settings
