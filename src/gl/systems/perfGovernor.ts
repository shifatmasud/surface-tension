import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { quality } from '../quality'
import { props } from '../../state/props'

/** R7.10 ?gpums (Shifat's PC report: EXT_disjoint_timer_query_webgl2 is there): a small overlay of the real GPU ms per
 *  frame, kept per 5 % of the scroll (sections and the transitions between them) with the stage name, so a run
 *  through the page on the real device gives its own per-section table. window.__gpums holds the numbers. */
const GPUMS = typeof location !== 'undefined' && new URLSearchParams(location.search).has('gpums')
const hud = {
  el: null as HTMLPreElement | null, last: 0, ema: 0,
  b: new Map<number, { n: number; sum: number; max: number; v: number[]; stage: string }>(),
  na(why: string) {
    if (!GPUMS || typeof document === 'undefined' || !document.body) return
    if (!this.el) { const e = document.createElement('pre'); e.id = 'gpums'; e.style.cssText = 'position:fixed;left:6px;top:6px;z-index:2147483647;margin:0;padding:6px 8px;background:rgba(0,0,0,.72);color:#b8ff3c;font:11px/1.3 ui-monospace,Consolas,monospace;pointer-events:none;white-space:pre'; document.body.appendChild(e); this.el = e }
    this.el.textContent = `GPU ms: n/a on this device (${why})`
  },
  add(ms: number) {
    if (!GPUMS) return
    this.ema = this.ema ? this.ema + (ms - this.ema) * 0.1 : ms
    const W = window as any, max = W.__sh?.max?.() || 1, f = Math.max(0, Math.min(0.999, (props.scroll || 0) / max))
    const k = Math.floor(f * 20)
    let r = this.b.get(k); if (!r) { r = { n: 0, sum: 0, max: 0, v: [], stage: '' }; this.b.set(k, r) }
    r.n++; r.sum += ms; r.max = Math.max(r.max, ms); r.stage = String(props.stage || ''); if (r.v.length < 600) r.v.push(ms)
    W.__gpums = this
    const now = performance.now(); if (now - this.last < 250) return; this.last = now
    if (!this.el) {
      const e = document.createElement('pre'); e.id = 'gpums'
      e.style.cssText = 'position:fixed;left:6px;top:6px;z-index:2147483647;margin:0;padding:6px 8px;background:rgba(0,0,0,.72);color:#b8ff3c;font:11px/1.3 ui-monospace,Consolas,monospace;pointer-events:none;white-space:pre'
      document.body.appendChild(e); this.el = e
    }
    const p90 = (v: number[]) => { const s = v.slice().sort((a, b) => a - b); return s[Math.floor(s.length * 0.9)] || 0 }
    let t = `GPU ${this.ema.toFixed(1)} ms  @${(f * 100).toFixed(0)}% ${props.stage}\nscroll   avg   p90  n\n`
    for (const [kk, rr] of [...this.b.entries()].sort((a, b) => a[0] - b[0])) t += `${String(kk * 5).padStart(3)}% ${(rr.sum / rr.n).toFixed(1).padStart(5)} ${p90(rr.v).toFixed(1).padStart(5)} ${String(rr.n).padStart(4)} ${rr.stage}\n`
    this.el.textContent = t
  },
}

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
      if (!ext) { hud.na('no timer query'); return }
      this.gl = g; this.ext = ext; this.ok = true
      // R6.92 (Shifat's Windows log: "getQueryParameter: object does not belong to this context" right after "Context
      // Restored"): queries die with the context. Lost → forget them (no GL call on a lost context); restored → start
      // over with the new context's extension object on the next frame.
      if (!this.hooked) {
        this.hooked = true
        const c = r.domElement
        c.addEventListener('webglcontextlost', () => { this.drop() }, false)
        c.addEventListener('webglcontextrestored', () => { this.drop(); this.tried = false }, false)
      }
    } catch { this.ok = false }
  }
  private hooked = false
  private waits = 0
  /** forget every query and the extension (their context is gone) */
  drop() { this.q = null; this.open = null; this.gl = null; this.ext = null; this.ok = false }
  begin() {
    const g = this.gl, x = this.ext
    if (!g || !x) return
    if (g.isContextLost()) { this.drop(); return }
    // R6.92: never touch a query this context does not own (a stale one from before a restore)
    if (this.open && !g.isQuery(this.open)) this.open = null
    if (this.q && !g.isQuery(this.q)) this.q = null
    // a frame that began a query but never reached the post chain (intro, a held loop): close it and discard it
    if (this.open) { g.endQuery(x.TIME_ELAPSED_EXT); g.deleteQuery(this.open); this.open = null }
    // collect the previous frame's result first (non-blocking)
    if (this.q) {
      // R6.92: a driver that exposes the timer but never answers (Adreno with disable_timestamp_queries style workarounds)
      // stops being asked after ~4 s of frames: the governor keeps its blind probe, as without the extension
      if (!g.getQueryParameter(this.q, g.QUERY_RESULT_AVAILABLE)) { if (++this.waits > 240) { try { g.deleteQuery(this.q) } catch { /* lost */ } this.drop(); hud.na('timer never answered') } return }
      this.waits = 0
      const dj = g.getParameter(x.GPU_DISJOINT_EXT)
      if (dj) this.disjoint++
      else { const ms = g.getQueryParameter(this.q, g.QUERY_RESULT) / 1e6; quality.gpuSample(ms, performance.now()); this.samples++; hud.add(ms) }
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
    if (g.isContextLost() || !g.isQuery(this.open)) { this.open = null; return }
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
