import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { quality } from '../quality'

/**
 * SHARP — the governor's measurement (Shifat: "crisp at full quality yet fast on phones").
 * 60 Hz vsync hides headroom: a 6 ms frame and a 15 ms frame both read 16.7 ms on the clock. Where the GPU exposes
 * EXT_disjoint_timer_query_webgl2 (desktop Chrome, many Android GPUs) the whole frame's GPU work is timed: begin in the
 * earliest frame callback (before the neighbour pass, the stage pre-renders and the post chain), end after the post
 * chain's last draw (PostChain.render → gpuTimer.end). The result arrives a frame or two later and feeds
 * quality.gpuSample, so the governor climbs toward native only where the measurement says the next step fits.
 * No timer (iOS Safari, WebGL1) → the governor keeps its blind probe. One query in flight at a time; a frame where
 * another TIME_ELAPSED query is already active (a QA probe) is skipped instead of raising INVALID_OPERATION.
 * QA: window.__gpuTimer = { ok, ms (EMA in quality.gpuMs), samples, skipped, disjoint }.
 */
type Ext = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
class GpuTimer {
  ok = false
  samples = 0
  skipped = 0
  disjoint = 0
  private gl: WebGL2RenderingContext | null = null
  private ext: Ext | null = null
  private tried = false
  private q: WebGLQuery | null = null      // the query awaiting its result
  private open: WebGLQuery | null = null   // the query begun this frame
  init(r: THREE.WebGLRenderer) {
    if (this.tried) return
    this.tried = true
    try {
      const g = r.getContext() as WebGL2RenderingContext
      if (typeof WebGL2RenderingContext === 'undefined' || !(g instanceof WebGL2RenderingContext)) return
      if (new URLSearchParams(location.search).has('nogpu')) return
      const ext = g.getExtension('EXT_disjoint_timer_query_webgl2') as Ext | null
      if (!ext) return
      this.gl = g; this.ext = ext; this.ok = true
    } catch { this.ok = false }
  }
  begin() {
    const g = this.gl, x = this.ext
    if (!g || !x) return
    // a frame that began a query but never reached the post chain (intro, a held loop): close it and discard it
    if (this.open) { g.endQuery(x.TIME_ELAPSED_EXT); g.deleteQuery(this.open); this.open = null }
    // collect the previous frame's result first (non-blocking)
    if (this.q) {
      if (!g.getQueryParameter(this.q, g.QUERY_RESULT_AVAILABLE)) return   // still in flight: time a later frame
      const dj = g.getParameter(x.GPU_DISJOINT_EXT)
      if (dj) this.disjoint++
      else { quality.gpuSample(g.getQueryParameter(this.q, g.QUERY_RESULT) / 1e6, performance.now()); this.samples++ }
      g.deleteQuery(this.q); this.q = null
    }
    if (g.getQuery(x.TIME_ELAPSED_EXT, g.CURRENT_QUERY)) { this.skipped++; return }
    const q = g.createQuery()
    if (!q) return
    g.beginQuery(x.TIME_ELAPSED_EXT, q)
    this.open = q
  }
  end() {
    const g = this.gl, x = this.ext
    if (!g || !x || !this.open) return
    g.endQuery(x.TIME_ELAPSED_EXT)
    this.q = this.open; this.open = null
  }
}
export const gpuTimer = new GpuTimer()
;(window as any).__gpuTimer = gpuTimer

/** Mount once inside the Canvas (Scene.tsx, SHARP HOOK). Priority -1000: before every other frame callback. */
export function GpuFrameTimer() {
  const gl = useThree((s) => s.gl)
  useFrame(() => { gpuTimer.init(gl); gpuTimer.begin() }, -1000)
  return null
}
