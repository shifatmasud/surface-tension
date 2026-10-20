import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import gsap from 'gsap'
import { SplitText } from 'gsap/SplitText'
import { props } from '../../state/props'
import { settings, browser } from '../../services/settings'
import { clamp } from '../../core/math'
import { PROJECTS } from '../../content/site'
import { PHRASES } from '../sections/Statement'
import { dive } from '../../gl/stages/dive/diveState'
import { ufx, textMaterial, type UfxItem } from '../../gl/ufx/ufx'
import { rasterLine } from '../../gl/ufx/UfxText'

gsap.registerPlugin(SplitText)

/**
 * GLOBAL TEXT LAYER (Shifat 10:17Z m:904e9e4d + 11:46Z m:91d85988).
 * "Text content position must stay same every section scenes etc. Only slides up & slides in to change contents."
 * "All Text content should be a layer above sections & scenes but just like now, they should be refracted by cursor trail."
 *
 * ONE fixed slot on the bottom grid (eyebrow · display headline · caption), the same box on every section and scene,
 * desktop and phone. The scenes and the clipped cards move underneath; the slot never moves. When the beat changes the
 * old lines slide UP out of their masks, line by line, and the new ones slide UP in, in the same place.
 * GL: every line is rasterised once and drawn by the SlotUfx pass (PostChain order 3050): once, over the composited
 * frame, BEFORE the trail distortion, so the cursor trail bends and silvers it exactly like the hero type did.
 * The DOM copy stays real text (selection, SEO, no-GL fallback) and transparent while GL draws it; each section keeps
 * its own semantic heading for screen readers, and the slot announces the beat politely (aria-live).
 * Reduced motion: a crossfade in place.
 *
 * The CTA's huge white type is not here on purpose: it is part of the CTA scene (drawn on the black wall BEHIND the
 * crewmate, STRUCTURE v3 CTA), not copy laid over it.
 */
type Beat = { id: string; eyebrow: string; title: string[]; body: string }
const BEATS: Beat[] = [
  { id: 'hero', eyebrow: 'Portfolio — 2026', title: ['Shifat', 'Masud'], body: 'Design engineer & creative technologist, Dhaka.' },
  ...PHRASES.map((p, i) => ({ id: 'statement' + i, eyebrow: `Principle 0${i + 1}`, title: p.t, body: p.c })),
  { id: 'dive', eyebrow: 'Craft', title: ['Under the', 'surface'], body: 'Shaders, physics and the GPU. The part of the work you feel before you see it.' },
  ...PROJECTS.map((p) => ({ id: 'lab-' + p.id, eyebrow: `Lab · ${p.no} / 0${PROJECTS.length}`, title: [p.title], body: `${p.blurb} ${p.tags.join(' · ')}` })),
  { id: 'systems', eyebrow: 'Systems', title: ['Shade DS'], body: 'A generative design system for teams who ship fast and want every screen to feel like one product. Plus the tooling that hands it to agents: MCP servers and the Upsy OAuth bridge.' },
  { id: 'journey1', eyebrow: 'Next', title: ['Playable', 'worlds.'], body: 'Made for the browser.' },
  { id: 'journey2', eyebrow: 'Next', title: ['Out of', 'the screen.'], body: 'Games, toys and tools that don’t stay inside the screen.' },
]
const IDX = new Map(BEATS.map((b, i) => [b.id, i]))
/** the slot's current top edge (viewport px; 1e5 when empty): 3D-pinned labels keep out of it */
export const slotBox = { top: 1e5 }

/** where each section sits in the document (virtual scroll px), measured on resize */
const R: Record<string, { top: number; h: number }> = {}
function measure() {
  for (const id of ['hero', 'statement', 'dive', 'lab', 'systems', 'journey', 'contact']) {
    const el = document.getElementById(id); if (!el) continue
    const r = el.getBoundingClientRect()
    R[id] = { top: r.top + props.scroll, h: r.height }
  }
}
const pin = (id: string, off = 0) => { const r = R[id]; return r ? (props.scroll - r.top + off) / Math.max(1, r.h - props.height) : -1 }

/** which beat the scroll is on right now (-1: the slot is empty and lets the scene breathe) */
function current(dropped: boolean): number {
  const vh = props.height, s = props.scroll
  if (!R.hero) return -1
  if (props.overlayOpen) return -1
  if (R.contact && s > R.contact.top - vh * 0.55) return -1
  if (R.journey && s > R.journey.top - vh * 0.5) {
    const p = pin('journey')
    return p > 0.03 && p < 0.2 ? IDX.get('journey1')! : p > 0.6 && p < 0.79 ? IDX.get('journey2')! : -1
  }
  if (R.systems && s > R.systems.top - vh * 0.35) return IDX.get('systems')!
  if (R.lab && s > R.lab.top - vh * 0.45) {
    const n = PROJECTS.length, a = Math.round(clamp(pin('lab')) * (n - 1))
    return IDX.get('lab-' + PROJECTS[a].id)!
  }
  if (props.stage === 'dive' || (R.dive && s > R.dive.top)) return dive.u > 0.405 ? IDX.get('dive')! : -1
  if (R.statement) {
    const p = pin('statement', vh * 0.2), n = PHRASES.length
    // the phrases take over at the same scroll points the statement used (each rises as the previous sinks)
    if (p * n + 0.09 >= 0) return IDX.get('statement' + Math.min(n - 1, Math.floor(p * n + 0.09)))!
  }
  return dropped ? 0 : -1
}

type LineGL = { it: UfxItem; mat: THREE.ShaderMaterial; el: HTMLElement; role: 'eyebrow' | 'title' | 'body' }
// Shifat 15:33Z ("looks cheap" → premium): one motion language for all copy. IN: each line rises from under its hard
// mask on cubic-bezier(0.19, 1, 0.22, 1) over 1.0 s, 75 ms apart, with a 2.5° tilt that settles to 0; OUT: up and out
// through the top of the mask, 0.6 s ease-in-out, a touch quicker. No opacity on the glyphs (reduced motion: fades).
const OUT_DUR = 0.45, IN_DUR = 1.0, STAGGER = 0.075, IN_DELAY = 0.42   // the incoming beat waits until the outgoing lines have (nearly) cleared the shared masks
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const X = (t: number) => ((ax * t + bx) * t + cx) * t, Y = (t: number) => ((ay * t + by) * t + cy) * t, dX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x: number) => {
    if (x <= 0) return 0; if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 6; i++) { const d = dX(t); if (Math.abs(d) < 1e-6) break; t -= (X(t) - x) / d }
    t = Math.min(1, Math.max(0, t))
    return Y(t)
  }
}
export const easeOutPremium = bezier(0.19, 1, 0.22, 1)
export const easeInOutPremium = bezier(0.65, 0, 0.35, 1)
const easeOut = easeOutPremium
const easeIn = easeInOutPremium

export function TextLayer() {
  const root = useRef<HTMLDivElement>(null)
  const live = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    const host = root.current; if (!host) return
    document.documentElement.classList.add('slot-on')
    const reduced = browser.reducedMotion
    const gl = settings.USE_GL
    const beatsEl = Array.from(host.querySelectorAll<HTMLElement>('.slot__beat'))
    // per beat: its lines (DOM + GL), and its animation state: dir +1 coming in / -1 going out, t0, live
    const st = beatsEl.map(() => ({ lines: [] as LineGL[], dom: [] as HTMLElement[], dir: 0, t0: -10, on: false }))
    let splits: SplitText[] = []
    const ink = { title: new THREE.Color('#0a0a0b'), body: new THREE.Color('#0a0a0b'), eyebrow: new THREE.Color('#5f646b') }
    const want = { title: new THREE.Color(), body: new THREE.Color(), eyebrow: new THREE.Color() }
    let dropped = false, dropAt = 1e9
    const onDrop = () => { dropped = true; dropAt = performance.now() / 1000 + 1.4 }
    window.addEventListener('st:drop', onDrop)
    if (props.introDone) onDrop()

    const build = () => {
      // tear down, then split every beat's copy into lines and rasterise each line once (fonts are ready)
      st.forEach((s) => { s.lines.forEach((l) => { ufx.remove(l.it); (l.mat.uniforms.u_map.value as THREE.Texture).dispose(); l.mat.dispose() }); s.lines = []; s.dom = [] })
      splits.forEach((s) => s.revert()); splits = []
      beatsEl.forEach((b, bi) => {
        b.style.visibility = 'hidden'; b.style.display = 'flex'   // W19: the 17:12Z text-block rule is a flex row
        for (const el of Array.from(b.querySelectorAll<HTMLElement>('[data-role]'))) {
          const role = el.dataset.role as LineGL['role']
          const sp = new SplitText(el, { type: 'lines', linesClass: 'slot__line', aria: 'none' }); splits.push(sp)
          for (const line of sp.lines as HTMLElement[]) {
            // each line in its own mask (the DOM fallback slides the inner span; GL slides the glyphs in the shader)
            const inner = document.createElement('span'); inner.className = 'slot__in'
            while (line.firstChild) inner.appendChild(line.firstChild)
            line.appendChild(inner)
            st[bi].dom.push(inner)
            if (!gl) continue
            const r = line.getBoundingClientRect()
            const { tex, padX, padY } = rasterLine(line, line.textContent || '', r.width, r.height)
            const mat = textMaterial(tex, '#0a0a0b', '#9fb4d6')
            const mesh = new THREE.Mesh(GEO, mat); mesh.renderOrder = 10
            const it: UfxItem = {
              el: line, mesh, layer: 'slot', fixed: true, docTop: 0, docLeft: 0, w: 0, h: 0, section: '',
              measure() { const rr = line.getBoundingClientRect(); it.docTop = rr.top - padY; it.docLeft = rr.left - padX; it.w = rr.width + padX * 2; it.h = rr.height + padY * 2; mat.uniforms.u_hw.value = it.h / Math.max(1, it.w) },
              visibleWhen: () => st[bi].on,
            }
            ufx.add(it)
            st[bi].lines.push({ it, mat, el: line, role })
          }
        }
        b.style.visibility = ''; b.style.display = ''
      })
      if (gl) host.classList.add('is-gl')
    }
    let active = -1, built = false
    /** W19: take a beat off the screen this frame — every line under its mask, transparent */
    const hideNow = (s: (typeof st)[number]) => {
      s.on = false
      for (const L of s.lines) { L.mat.uniforms.u_reveal.value = 0; L.mat.uniforms.u_opacity.value = 0 }
      if (!gl) s.dom.forEach((d) => { d.style.transform = 'translate3d(0, 110%, 0)'; d.style.opacity = '0' })
    }
    const set = (i: number) => {
      if (i === active) return
      const now = performance.now() / 1000
      // W19 (Shifat 17:18Z "Ensure no leaking letters"): ONE beat on screen at a time.
      // - an outgoing beat that had not finished revealing (a fast scroll / fling / reverse) is cleared at once: playing
      //   its exit from 'in place' made the half-risen lines pop up whole for a frame
      // - the incoming beat waits until every leaving line has fully cleared its mask (no two headlines together)
      const lines = (s: (typeof st)[number]) => Math.max(s.lines.length, s.dom.length)
      if (active >= 0) {
        const s = st[active]
        const revealed = s.dir > 0 && now >= s.t0 + IN_DUR + STAGGER * (lines(s) - 1)
        if (revealed) { s.dir = -1; s.t0 = now } else hideNow(s)
      }
      let clearAt = now
      for (const s of st) if (s.on && s.dir < 0) clearAt = Math.max(clearAt, s.t0 + OUT_DUR + STAGGER * (lines(s) - 1))
      if (i >= 0) { const s = st[i]; hideNow(s); s.dir = 1; s.t0 = active >= 0 ? Math.max(now + 0.06, clearAt + 0.04) : now; s.on = true }
      beatsEl.forEach((b, k) => b.classList.toggle('is-active', k === i))
      active = i
      slotBox.top = i >= 0 ? beatsEl[i].getBoundingClientRect().top : 1e5
      if (live.current) live.current.textContent = i >= 0 ? `${BEATS[i].title.join(' ')}. ${BEATS[i].body}` : ''
    }
    const tick = () => {
      if (!built) return
      const now = performance.now() / 1000
      set(current(dropped && now > dropAt))
      // ink follows the UI tone (black on the light water, white in the deep, in space and on the CTA wall)
      // W19 (rv-visual P0-3): during the over-under shot the copy sits BELOW the rising waterline (teal) while the header
      // is still in the air: the slot flips to white once the line passes the middle of the active beat
      const H = window.innerHeight
      const lineOver = props.stage === 'dive' && dive.split >= 0 && dive.split * H > H - (slotBox.top + 60)
      const dark = document.documentElement.dataset.bg === 'dark' || lineOver
      want.title.set(dark ? '#ffffff' : '#0a0a0b'); want.body.set(dark ? '#f2f4f6' : '#0a0a0b'); want.eyebrow.set(dark ? '#d3d7dc' : '#5f646b')
      // W19 (rv-visual P0-3): the flip is a snap (~0.1 s), never a readable mid-grey on teal
      const k = 1 - Math.exp(-30 * Math.min(props.dt, 0.1))
      ink.title.lerp(want.title, k); ink.body.lerp(want.body, k); ink.eyebrow.lerp(want.eyebrow, k)
      for (let b = 0; b < st.length; b++) {
        const s = st[b]; if (!s.on) continue
        const n = Math.max(s.lines.length, s.dom.length)
        let done = true
        for (let i = 0; i < n; i++) {
          // reveal 0 under the mask → 1 in place → 2 gone through the top (UFX_TEXT_FRAG); reduced motion: opacity only
          let v: number, o = 1
          // QA: window.__slotScrub = 0..1 pins the active beat's IN timeline (frames of the reveal on a slow rig)
          const scrub = (window as any).__slotScrub
          const x = typeof scrub === 'number' && s.dir > 0 ? clamp((scrub * (IN_DUR + STAGGER * (n - 1)) - i * STAGGER) / IN_DUR) : clamp((now - s.t0 - i * STAGGER) / (s.dir > 0 ? IN_DUR : OUT_DUR))
          if (s.dir > 0) { v = reduced ? 1 : easeOut(x); o = reduced ? easeIn(x) : 1; if (x < 1) done = false }
          else { v = reduced ? 1 : 1 + easeIn(x); o = reduced ? 1 - easeIn(x) : 1; if (x < 1) done = false }
          const L = s.lines[i]
          if (L) {
            L.mat.uniforms.u_reveal.value = v; L.mat.uniforms.u_opacity.value = o
            ;(L.mat.uniforms.u_color.value as THREE.Color).copy(ink[L.role])
          }
          const d = s.dom[i]
          if (d && !gl) { d.style.transform = `translate3d(0, ${((1 - v) * 110).toFixed(1)}%, 0)`; d.style.opacity = o.toFixed(3) }
        }
        if (s.dir < 0 && done) { s.on = false; if (!gl) s.dom.forEach((d) => { d.style.opacity = '0' }) }   // W19 (P0-4): a cleared beat leaves no glyph tops in the mask
      }
    }
    gsap.ticker.add(tick)
    let ro: ResizeObserver | null = null
    document.fonts.ready.then(() => {
      build(); measure(); built = true
      ro = new ResizeObserver(() => { measure() }); ro.observe(document.body)
    })
    let rt = 0
    const onResize = () => { clearTimeout(rt); rt = window.setTimeout(() => { measure(); const a = active; active = -1; build(); set(a); slotBox.top = a >= 0 ? beatsEl[a].getBoundingClientRect().top : 1e5; st.forEach((s, i) => { if (i === a) { s.on = true; s.dir = 1; s.t0 = -10 } }) }, 180) }
    window.addEventListener('resize', onResize)
    return () => {
      gsap.ticker.remove(tick); window.removeEventListener('resize', onResize); window.removeEventListener('st:drop', onDrop); ro?.disconnect()
      st.forEach((s) => s.lines.forEach((l) => ufx.remove(l.it))); splits.forEach((s) => s.revert())
      document.documentElement.classList.remove('slot-on')
    }
  }, [])
  return (
    <div className="slot" ref={root}>
      <div className="slot__frame" aria-hidden="true">
        {BEATS.map((b) => (
          <div key={b.id} className="slot__beat" data-beat={b.id}>
            <p className="slot__eyebrow" data-role="eyebrow">{b.eyebrow}</p>
            <p className="slot__title" data-role="title">{b.title.map((t, i) => <span key={i}>{t}{i < b.title.length - 1 && <br />}</span>)}</p>
            <p className="slot__body" data-role="body">{b.body}</p>
          </div>
        ))}
      </div>
      <p className="sr-only" aria-live="polite" ref={live} />
    </div>
  )
}
const GEO = new THREE.PlaneGeometry(1, 1, 1, 24)
