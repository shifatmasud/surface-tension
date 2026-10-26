import gsap from 'gsap'
import { advance } from '@react-three/fiber'
import { props } from '../state/props'
import { input } from '../services/input'
import { scroll } from '../services/scroll'
import { taskManager } from '../services/loader'
import { sections } from './sections'
import { clip } from '../gl/systems/clip'
import { journey } from '../gl/stages/journey/journeyState'
import { audio } from '../services/audio'
import { settings } from '../services/settings'
import { engine } from '../gl/engine'
import { quality, stageWindow } from '../gl/quality' // PERF HOOK

/**
 * The one clock (handbook ch.2 / ch.11.3). GSAP's ticker owns requestAnimationFrame; every system is
 * ticked from here in a fixed order, with dt capped at 1/20 s:
 *   taskManager → input → virtual scroll (VSCROLL HOOK) → sections (DOM → props) → audio → R3F advance()
 *   (inside R3F: camera rig → stages → paint → sim → post chain) → input.postUpdate
 */
let started = false
const fpsSamples: number[] = []
/** R6.95 QA KNOB ?fps (any value): a small frame-time readout, bottom-left — fps, p95 frame ms over the last 120 frames,
 *  the governor level and the background / hero density. Absent by default (nothing is created without the param). */
const FPS_HUD = typeof location !== 'undefined' && new URLSearchParams(location.search).has('fps')
let hud: HTMLDivElement | null = null
const ring = new Float32Array(120), sorted = new Float32Array(120)
let ringN = 0
function hudTick(ms: number) {
  ring[ringN % 120] = ms; ringN++
  if (props.frame % 20 !== 0) return
  if (!hud) {
    hud = document.createElement('div')
    hud.setAttribute('aria-hidden', 'true')
    hud.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none;font:11px/1.3 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.6);padding:3px 6px;border-radius:3px;white-space:pre'
    document.body.appendChild(hud)
  }
  const n = Math.min(ringN, 120)
  sorted.set(n < 120 ? ring.subarray(0, n) : ring); const s = sorted.subarray(0, n).sort()
  let sum = 0; for (let i = 0; i < n; i++) sum += s[i]
  const p95 = s[Math.min(n - 1, Math.floor(n * 0.95))], mx = s[n - 1]
  hud.textContent = `${Math.round(1000 / (sum / n))} fps  p95 ${p95.toFixed(1)}  max ${mx.toFixed(0)} ms\nL${quality.level}  bg ${(+props.dpr).toFixed(2)}  hero ${(+(props as any).heroDpr || 0).toFixed(2)}  ${quality.aa}`
}
export function startClock() {
  if (started) return
  started = true
  gsap.ticker.lagSmoothing(0)
  let lastNow = -1 // VSCROLL HOOK
  gsap.ticker.add((time, deltaMs) => {
    // VSCROLL HOOK: frame time from performance.now (sub-millisecond, like Lusion's loop). GSAP's deltaMs comes from
    // Date.now (whole ms), so at 60 Hz it alternates 16/17 ms: a ±4% wobble in every eased step and in the fling velocity.
    const now = performance.now()
    const ms = lastNow < 0 ? deltaMs : now - lastNow
    lastNow = now
    const dt = props.sceneHold ? 0 : Math.min(Math.max(ms, 0) / 1000, (window as any).__dtCap ?? 1 / 20)   // Shifat 1:55 PM: the page scene never moves while the gift is in or out (time frozen while held)  // __dtCap: QA on slow remote GPUs (camera damping converges)
    // R7.11 QA CLOCK (absent by default: nothing reads it unless a test sets window.__qClock): a fixed-step fake clock so a
    // headless before/after pair lands on the same moment. On set, the scene time jumps to `reset`, then exactly `frames`
    // steps of `dt` run, then time holds (dt 0) while frames keep drawing.
    const qc = (window as any).__qClock
    let qdt = dt
    if (qc) { if (qc.reset != null) { props.time = qc.reset; qc.reset = null; qc.n = 0 } qdt = qc.n < qc.frames ? qc.dt : 0; qc.n++ }
    props.dt = qdt; props.time += qdt; props.frame++
    taskManager.update()
    input.update()
    scroll.update(qdt) // VSCROLL HOOK: the virtual scroll steps and writes the page offset here, before sections and GL read it
    sections.update(qdt)
    const ownerKey0 = clip.ownerKey
    clip.update()
    // R6.96 HAND-OFF: Journey.tsx gates journey.active on clip.allowed('journey') inside sections.update, which runs
    // BEFORE clip.update() hands the journey block the render. On the dive -> journey cut frame the journey stage was
    // therefore still gated off while the dive block was already hidden: one near-black frame (R6.94/R6.95, all tiers).
    // Re-read the gate on the frame the owner changes, so the incoming stage draws on the cut frame itself.
    if (clip.ownerKey !== ownerKey0 && journey.activeRaw && !journey.active && clip.allowed('journey')) journey.active = true
    audio.update(qdt)
    // PRELOAD: from the moment the GL canvas exists until the hero's shaders are linked (parallel compile), the
    // frame loop holds, so no frame blocks on a shader link and the counter keeps moving
    // R6.83 GIFT: while the gift dialog is open its blurred still covers the page, so the scene does not draw at all
    if (settings.USE_GL && (!engine.canvas || engine.warm) && !props.sceneHold) advance(props.time)
    input.postUpdate()
    // PERF HOOK: the governor judges real frame deltas once the intro is done and the page is visible
    // (R6.83: frozen while the scene is held: no judging, no rest change, so nothing re-allocates under the gift)
    if (!props.sceneHold) {
      quality.judging = props.introDone && !props.overlayOpen && document.visibilityState === 'visible' && engine.warm
      quality.frame(ms, now)
      quality.restTick(Math.abs(props.scrollVel) > 0.5 || input.hadMoved || input.isDown || props.overlayOpen, now)
    }
    stageWindow.step()
    if (FPS_HUD) hudTick(ms)
    // rolling FPS probe for QA (window.__fps)
    fpsSamples.push(deltaMs); if (fpsSamples.length > 120) fpsSamples.shift()
    if (props.frame % 30 === 0) (window as any).__fps = Math.round(1000 / (fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length))
  })
}
