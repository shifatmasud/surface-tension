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
const OUT_DUR = 0.62, IN_DUR = 0.9, STAGGER = 0.07, IN_DELAY = 0.22
const easeOut = (x: number) => 1 - Math.pow(1 - x, 4)
const easeIn = (x: number) => x * x * x

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
    const ink = { title: new THREE.Color('#0a0a0b'), body: new THREE.Color('#5f646b'), eyebrow: new THREE.Color('#5f646b') }
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
        b.style.visibility = 'hidden'; b.style.display = 'grid'
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
              measure() { const rr = line.getBoundingClientRect(); it.docTop = rr.top - padY; it.docLeft = rr.left - padX; it.w = rr.width + padX * 2; it.h = rr.height + padY * 2 },
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
    const set = (i: number) => {
      if (i === active) return
      const now = performance.now() / 1000
      if (active >= 0) { const s = st[active]; s.dir = -1; s.t0 = now }
      if (i >= 0) { const s = st[i]; s.dir = 1; s.t0 = now + (active >= 0 ? IN_DELAY : 0); s.on = true }
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
      const dark = document.documentElement.dataset.bg === 'dark'
      want.title.set(dark ? '#ffffff' : '#0a0a0b'); want.body.set(dark ? '#b9bec5' : '#5f646b'); want.eyebrow.set(dark ? '#b9bec5' : '#5f646b')
      const k = 1 - Math.exp(-8 * Math.min(props.dt, 0.1))
      ink.title.lerp(want.title, k); ink.body.lerp(want.body, k); ink.eyebrow.lerp(want.eyebrow, k)
      for (let b = 0; b < st.length; b++) {
        const s = st[b]; if (!s.on) continue
        const n = Math.max(s.lines.length, s.dom.length)
        let done = true
        for (let i = 0; i < n; i++) {
          // reveal 0 under the mask → 1 in place → 2 gone through the top (UFX_TEXT_FRAG); reduced motion: opacity only
          let v: number, o = 1
          const x = clamp((now - s.t0 - i * STAGGER) / (s.dir > 0 ? IN_DUR : OUT_DUR))
          if (s.dir > 0) { v = reduced ? 1 : easeOut(x); o = reduced ? x : 1; if (x < 1) done = false }
          else { v = reduced ? 1 : 1 + easeIn(x); o = reduced ? 1 - x : 1; if (x < 1) done = false }
          const L = s.lines[i]
          if (L) {
            L.mat.uniforms.u_reveal.value = v; L.mat.uniforms.u_opacity.value = o
            ;(L.mat.uniforms.u_color.value as THREE.Color).copy(ink[L.role])
          }
          const d = s.dom[i]
          if (d && !gl) { d.style.transform = `translate3d(0, ${((1 - v) * 110).toFixed(1)}%, 0)`; d.style.opacity = o.toFixed(3) }
        }
        if (s.dir < 0 && done) s.on = false
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
