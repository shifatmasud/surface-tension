import gsap from 'gsap'
import { advance } from '@react-three/fiber'
import { props } from '../state/props'
import { input } from '../services/input'
import { scroll } from '../services/scroll'
import { taskManager } from '../services/loader'
import { sections } from './sections'
import { audio } from '../services/audio'
import { settings } from '../services/settings'

/**
 * The one clock (handbook ch.2 / ch.11.3). GSAP's ticker owns requestAnimationFrame; every system is
 * ticked from here in a fixed order, with dt capped at 1/20 s:
 *   taskManager → input → Lenis → scroll state → sections (DOM → props) → audio → R3F advance()
 *   (inside R3F: camera rig → stages → paint → sim → post chain) → input.postUpdate
 */
let started = false
const fpsSamples: number[] = []
export function startClock() {
  if (started) return
  started = true
  gsap.ticker.lagSmoothing(0)
  gsap.ticker.add((time, deltaMs) => {
    const dt = Math.min(deltaMs / 1000, (window as any).__dtCap ?? 1 / 20)  // __dtCap: QA on slow remote GPUs (camera damping converges)
    props.dt = dt; props.time += dt; props.frame++
    taskManager.update()
    input.update()
    scroll.raf(time * 1000)
    scroll.update(dt)
    sections.update(dt)
    audio.update(dt)
    if (settings.USE_GL) advance(props.time)
    input.postUpdate()
    // rolling FPS probe for QA (window.__fps)
    fpsSamples.push(deltaMs); if (fpsSamples.length > 120) fpsSamples.shift()
    if (props.frame % 30 === 0) (window as any).__fps = Math.round(1000 / (fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length))
  })
}
