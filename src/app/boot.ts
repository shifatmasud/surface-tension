import { loader, taskManager } from '../services/loader'
import { preload, warmGate } from '../services/preload'
import { scroll } from '../services/scroll'
import { input } from '../services/input'
import { settings } from '../services/settings'
import { props } from '../state/props'
import { engine } from '../gl/engine'
import { pool } from '../gl/systems/pool'
import { audio } from '../services/audio'
import { startClock } from './clock'
import { sections } from './sections'
import { tilt } from '../services/tilt'
import { ufx } from '../gl/ufx/ufx'
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'

/**
 * Boot in three named phases (ch.2 / ch.11.2):
 *   preRun → brand font first (so the very first pixels are already in Inter)
 *   run    → build every system, start the one clock, queue the rest of the assets
 *   init   → content exists (sections, GL); GPU warm-up tasks run a little each frame
 *   start  → the droplet falls, scroll switches on
 */
export const boot = {
  phase: 'idle' as 'idle' | 'preRun' | 'run' | 'init' | 'start',
  async preRun() {
    this.phase = 'preRun'
    document.documentElement.classList.remove('no-js')
    document.documentElement.classList.toggle('no-gl', !settings.USE_GL) // the index.html probe may have set it early
    const f = loader.add(interUrl, { type: 'font', weight: 2 }) as any
    f.family = 'Inter Variable'; f.descriptors = { weight: '100 900', display: 'block' }
    try { await f.load() } catch (e) { console.warn('font', e) }
  },
  run() {
    this.phase = 'run'
    input.preInit()
    scroll.init()
    tilt.init()
    startClock()
    const setVh = () => {
      document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`)
      props.width = window.innerWidth; props.height = window.innerHeight
      props.useMobileLayout = window.innerWidth <= settings.MOBILE_WIDTH
    }
    setVh()
    let rt = 0
    window.addEventListener('resize', () => { setVh(); clearTimeout(rt); rt = window.setTimeout(() => { sections.resize(); ufx.measureAll() }, 120) })
    // click on the water drops a big droplet
    window.addEventListener('click', (e) => {
      if (!props.introDone || props.overlayOpen) return
      const t = e.target as HTMLElement
      if (t.closest('a,button,input,[data-no-drop],.card')) return
      const p = pool.pointer
      if (p.active) { pool.drop(p.x, p.z, 0.14, 0.05); audio.plip(1, 0.7) }
    })
    loader.start()
  },
  /** PRELOAD: real progress of the hero + the next section only (Shifat 10:51Z): the boot JS (byte-weighted, includes
   *  the hero scene chunk), the brand font, the hero's GPU warm-up and the lab's card posters. Every other section is
   *  mounted as it enters the ±1 window around the current one (gl/Scene.tsx LaterStages). */
  progress() {
    const js = preload.files(), font = loader.progress
    // DIAG: the GPU share is the hero's program links AND the post chain's warm-up frames (they used to run after 100 %)
    // PRELOAD: + the warm gate (services/preload.ts): each program of the first real frame built once, counted per
    // program; 100 = every one of them has drawn (gate closed, chain.warmDone)
    const warmed = engine.chain?.warmDone ? 1 : 0
    const gpu = engine.ready ? taskManager.progress * 0.25 + Math.max(warmGate.progress, warmed) * 0.75 : 0
    const next = preload.next(engine.ready)
    return settings.USE_GL ? js * 0.5 + font * 0.05 + gpu * 0.3 + next * 0.15 : js * 0.9 + font * 0.1
  },
  async drop() {
    this.phase = 'start'
    props.introDrop = 1
    document.documentElement.classList.add('is-ready')
    // the first droplet hits the middle of the pool
    pool.drop(0, 0.6, 0.22, 0.06)
    window.dispatchEvent(new CustomEvent('st:drop'))
    await new Promise((r) => setTimeout(r, 380))
    props.introDone = true
    sections.resize(); ufx.measureAll()
    scroll.start()
  },
}
;(window as any).__boot = boot
