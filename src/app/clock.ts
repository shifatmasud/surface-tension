import gsap from 'gsap'
import { advance } from '@react-three/fiber'
import { props } from '../state/props'
import { input } from '../services/input'
import { scroll } from '../services/scroll'
import { taskManager } from '../services/loader'
import { sections } from './sections'
import { clip } from '../gl/systems/clip'
import { audio } from '../services/audio'
import { settings } from '../services/settings'
import { engine } from '../gl/engine'

/**
 * The one clock (handbook ch.2 / ch.11.3). GSAP's ticker owns requestAnimationFrame; every system is
 * ticked from here in a fixed order, with dt capped at 1/20 s:
 *   taskManager → input → virtual scroll (VSCROLL HOOK) → sections (DOM → props) → audio → R3F advance()
 *   (inside R3F: camera rig → stages → paint → sim → post chain) → input.postUpdate
 */
let started = false
const fpsSamples: number[] = []
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
    const dt = Math.min(Math.max(ms, 0) / 1000, (window as any).__dtCap ?? 1 / 20)  // __dtCap: QA on slow remote GPUs (camera damping converges)
    props.dt = dt; props.time += dt; props.frame++
    taskManager.update()
    input.update()
    scroll.update(dt) // VSCROLL HOOK: the virtual scroll steps and writes the page offset here, before sections and GL read it
    sections.update(dt)
    clip.update()
    audio.update(dt)
    // PRELOAD: from the moment the GL canvas exists until the hero's shaders are linked (parallel compile), the
    // frame loop holds, so no frame blocks on a shader link and the counter keeps moving
    if (settings.USE_GL && (!engine.canvas || engine.warm)) advance(props.time)
    input.postUpdate()
    // rolling FPS probe for QA (window.__fps)
    fpsSamples.push(deltaMs); if (fpsSamples.length > 120) fpsSamples.shift()
    if (props.frame % 30 === 0) (window as any).__fps = Math.round(1000 / (fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length))
  })
}
