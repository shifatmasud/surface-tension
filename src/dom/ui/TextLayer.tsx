import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import gsap from 'gsap'
import { SplitText } from 'gsap/SplitText'
import { props } from '../../state/props'
import { settings, browser } from '../../services/settings'
import { clamp } from '../../core/math'
import { PROJECTS } from '../../content/site'
import { SrHeadings } from '../a11y/SrHeadings'
import { noOrphan, noOrphanLines } from '../a11y/noOrphans'
import { dive } from '../../gl/stages/dive/diveState'
import { ufx, textMaterial, type UfxItem } from '../../gl/ufx/ufx'
import { rasterLine } from '../../gl/ufx/UfxText'
import { onViewport } from '../../core/viewport'
import { scrollHost } from '../../services/scrollHost'

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
type Beat = { id: string; eyebrow: string; title: string[]; body: string | string[] }
const bodyText = (b: Beat) => (Array.isArray(b.body) ? b.body.join(' ') : b.body)
const BEATS: Beat[] = [
  { id: 'hero', eyebrow: 'Portfolio — 2026', title: ['Shifat', 'Masud'], body: ['Design engineer &', 'creative technologist'] },   // W23 (Shifat 02:28Z m:b33ea208): the subtitle is always 2 lines, at every width
  // TEXT GAP (Shifat 18:52Z m:ef4a3572): "After Shifat Masud, no other text untill project sections texts." The
  // principle line and "Under the surface" are gone: the descent plays wordless until the first work beat.
  ...PROJECTS.map((p) => ({ id: 'lab-' + p.id, eyebrow: `Work · ${p.no} / 0${PROJECTS.length}`, title: [p.title], body: `${p.blurb} ${p.tags.join(' · ')}` })),
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
  for (const id of ['hero', 'dive', 'lab', 'systems', 'journey', 'contact']) {
    const el = document.getElementById(id); if (!el) continue
    const r = el.getBoundingClientRect()
    R[id] = { top: r.top + props.scroll, h: r.height }
  }
}
const pin = (id: string, off = 0) => { const r = R[id]; return r ? (props.scroll - r.top + off) / Math.max(1, r.h - props.height) : -1 }

/** the hero's name block hands the slot over at this hero pin progress (unchanged); the slot then stays empty until the work */
const ST_FROM_HERO = 0.45

/** which beat the scroll is on right now (-1: the slot is empty and lets the scene breathe) */
function current(dropped: boolean): number {
  const vh = props.height, s = props.scroll
  if (!R.hero) return -1
  if (props.overlayOpen) return -1
  if (R.contact && s > R.contact.top - vh * 0.55) return -1
  // SECTION CUT (REVIEW-visual #17): each beat lives exactly as long as its scene. The journey owns the slot from the
  // moment its top enters (the space scene takes over there), so "Shade DS" is gone before the stars arrive …
  if (R.journey && s > R.journey.top - vh) {
    // a 100vh (reduced-motion, unpinned) journey has no pin to scrub: its two lines split the section instead
    if (R.journey.h < vh * 1.5) return s < R.journey.top - vh * 0.2 ? IDX.get('journey1')! : IDX.get('journey2')!
    // SECTION CUT: 600 → 420vh, so the windows widen a little to keep ~1 s of line reveal readable (cut-review P2-3)
    const p = pin('journey')
    return p > 0.02 && p < 0.24 ? IDX.get('journey1')! : p > 0.58 && p < 0.82 ? IDX.get('journey2')! : -1
  }
  // … and it leaves as the camera starts its push into the tablet (dive.push), so its exit has played before the cut
  // (the work tail's last card is drawn only while 0 < props.lab < 1 — labGL visibleWhen — so the systems beat takes the
  // slot exactly where the tail unpins: lab pin 1 = systems.top − vh)
  // (only a pinned systems section gates on the push: under reduced motion sections are 100vh and the push would clear
  // "Shade DS" before the section is even on screen — cut-review P1-2)
  // W21 (no 3D over text): in the pinned section the stone and its particle ring are still sinking through the bottom
  // band until the Systems turn begins (measured at 1440: the ring crossed the caption at dive.sys = 0, clear by 0.067),
  // so the beat waits for the stone to settle; the descent stays wordless a moment longer
  if (R.systems && s >= R.systems.top - vh) {
    const pinned = R.systems.h > vh * 1.5
    return pinned && (dive.push > 0.1 || dive.sys < 0.04) ? -1 : IDX.get('systems')!
  }
  // the work beats show only while their GL cards are on screen (0 < pin < 1); before that "Under the surface" holds
  const pl = R.lab ? pin('lab') : -1
  if (pl > 0 && pl < 1) {
    const n = PROJECTS.length, a = Math.round(clamp(pl) * (n - 1))
    return IDX.get('lab-' + PROJECTS[a].id)!
  }
  // TEXT GAP (Shifat 18:52Z): the whole descent (crane-down, crossing, window of light, the deep) is wordless
  if (props.stage === 'dive' || (R.dive && s > R.dive.top)) return -1
  // the hero's name block leaves where it always did (second half of the hero's pin); nothing replaces it
  if (dropped && pin('hero') > ST_FROM_HERO) return -1
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
    // TEXTROLL (Shifat 19:39Z "Text must always appear & disappear (even hero text contents) rolling up masked by each
    // lines"): every line keeps its live reveal (v), so a beat that leaves mid-entrance rolls up and out FROM WHERE IT IS
    // (ot0/from), and a beat that is re-entered mid-exit finishes leaving before it rolls back in. Nothing is cut.
    const st = beatsEl.map(() => ({ lines: [] as LineGL[], dom: [] as HTMLElement[], dir: 0, t0: -10, on: false, ot0: -1, v: [] as number[], from: [] as number[] }))
    let splits: SplitText[] = []
    const ink = { title: new THREE.Color('#0a0a0b'), body: new THREE.Color('#0a0a0b'), eyebrow: new THREE.Color('#5f646b') }
    const want = { title: new THREE.Color(), body: new THREE.Color(), eyebrow: new THREE.Color() }
    let dropped = false, dropAt = 1e9
    const onDrop = () => { dropped = true; dropAt = performance.now() / 1000 + 1.4 }
    window.addEventListener('st:drop', onDrop)
    if (props.introDone) onDrop()

    // R6.76 LOAD PATH (M02 census: the first build was one ~0.46 s task at 6x CPU behind the curtain, the shell counter
    // frozen through it): the build is a step generator, one step per text element. The first build runs in short tasks
    // (the counter keeps rolling, the same lines and textures come out); a resize still rebuilds in one go. A newer build
    // cancels an older one still in flight (gen), so nothing is ever added twice.
    let gen = 0
    function* buildSteps(): Generator<void, void, unknown> {
      const my = ++gen
      // tear down, then split every beat's copy into lines and rasterise each line once (fonts are ready)
      st.forEach((s) => { s.lines.forEach((l) => { ufx.remove(l.it); (l.mat.uniforms.u_map.value as THREE.Texture).dispose(); l.mat.dispose() }); s.lines = []; s.dom = [] })
      splits.forEach((s) => s.revert()); splits = []
      for (let bi = 0; bi < beatsEl.length; bi++) {
        const b = beatsEl[bi]
        b.style.visibility = 'hidden'; b.style.display = 'flex'   // W19: the 17:12Z text-block rule is a flex row
        for (const el of Array.from(b.querySelectorAll<HTMLElement>('[data-role]'))) {
          const role = el.dataset.role as LineGL['role']
          const sp = new SplitText(el, { type: 'lines', linesClass: 'slot__line', aria: 'none' }); splits.push(sp)
          for (const line of sp.lines as HTMLElement[]) {
            // each line in its own mask (the DOM fallback slides the inner span; GL slides the glyphs in the shader)
            const inner = document.createElement('span'); inner.className = 'slot__in'
            while (line.firstChild) inner.appendChild(line.firstChild)
            line.appendChild(inner)
            // W21: the DOM fallback starts every line below its mask and unseen; the tick rolls the active beat in. (Before,
            // every beat's copy painted stacked for a frame at mount: a flash of overlapping text on the no-GL page, and
            // the stacked Shade DS caption became the page's largest paint.)
            if (!gl) { inner.style.transform = 'translate3d(0, 110%, 0)'; inner.style.opacity = '0' }
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
          b.style.visibility = ''; b.style.display = ''
          yield
          if (my !== gen) return   // a newer build took over (it rebuilt and restyled every beat itself)
          b.style.visibility = 'hidden'; b.style.display = 'flex'
        }
        b.style.visibility = ''; b.style.display = ''
      }
      if (gl) host!.classList.add('is-gl')
      host!.classList.add('is-built')   // W21: until the lines are split and masked, no beat paints (app.css)
    }
    const build = () => { const g = buildSteps(); while (!g.next().done) { /* one go */ } }
    /** the first build: its steps back to back in short tasks (~8 ms of steps each), yielding to frames between */
    const buildSliced = () => new Promise<void>((resolve) => {
      const g = buildSteps(), ch = new MessageChannel()
      const run = () => {
        const t0 = performance.now()
        for (;;) { if (g.next().done) { ch.port1.close(); resolve(); return } if (performance.now() - t0 > 8) break }
        ch.port2.postMessage(0)
      }
      ch.port1.onmessage = run
      run()
    })
    let active = -1, built = false
    const set = (i: number) => {
      if (i === active) return
      const now = performance.now() / 1000
      // W19 (Shifat 17:18Z "Ensure no leaking letters"): ONE beat on screen at a time.
      // - an outgoing beat that had not finished revealing (a fast scroll / fling / reverse) is cleared at once: playing
      //   its exit from 'in place' made the half-risen lines pop up whole for a frame
      // - the incoming beat waits until every leaving line has fully cleared its mask (no two headlines together)
      const lines = (s: (typeof st)[number]) => Math.max(s.lines.length, s.dom.length)
      // TEXTROLL: the outgoing beat always rolls up and out per line, each line from its current place (a line still
      // under its mask stays there; a half-risen line keeps rising through the top; never a cut, never a pop)
      if (active >= 0) {
        const s = st[active]
        if (s.on) { s.from = Array.from({ length: lines(s) }, (_, k) => s.v[k] ?? 0); s.ot0 = now; s.dir = -1 }
      }
      let clearAt = now
      for (const s of st) if (s.on && s.dir < 0 && s.ot0 >= 0) clearAt = Math.max(clearAt, s.ot0 + (reduced ? 0 : OUT_DUR + STAGGER * (lines(s) - 1)))
      if (i >= 0) {
        const s = st[i]
        // a beat re-entered while it is still leaving finishes its exit first (it never reverses or snaps back down)
        if (!s.on) { s.ot0 = -1; s.v = []; s.from = [] }
        s.dir = 1; s.t0 = active >= 0 ? Math.max(now + 0.06, clearAt + 0.04) : now; s.on = true
      }
      beatsEl.forEach((b, k) => b.classList.toggle('is-active', k === i))
      active = i
      slotBox.top = i >= 0 ? beatsEl[i].getBoundingClientRect().top : 1e5
      if (live.current) live.current.textContent = i >= 0 ? `${BEATS[i].title.join(' ')}. ${bodyText(BEATS[i])}` : ''
    }
    const tick = () => {
      if (!built) return
      const now = performance.now() / 1000
      set(current(dropped && now > dropAt))
      // ink follows the UI tone (black on the light water, white in the deep, in space and on the CTA wall)
      // W19 (rv-visual P0-3): during the over-under shot the copy sits BELOW the rising waterline (teal) while the header
      // is still in the air: the slot flips to white once the line passes the middle of the active beat
      const H = props.height
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
          // reveal 0 under the mask → 1 in place → 2 gone through the top (UFX_TEXT_FRAG); reduced motion: instant
          let v = 0, o = 1
          // QA: window.__slotScrub = 0..1 pins the active beat's IN timeline (frames of the reveal on a slow rig)
          const scrub = (window as any).__slotScrub
          const xin = s.dir > 0 ? (typeof scrub === 'number' ? (scrub * (IN_DUR + STAGGER * (n - 1)) - i * STAGGER) / IN_DUR : (now - s.t0 - i * STAGGER) / IN_DUR) : -1
          if (s.dir > 0 && xin >= 0) {
            v = reduced ? 1 : easeOut(clamp(xin)); if (xin < 1 && !reduced) done = false
          } else if (s.ot0 >= 0) {
            // rolling out (or still finishing an exit before a re-entry): from this line's own place up through the top
            // QA: window.__slotOutScrub = 0..1 pins the leaving beat's OUT timeline
            const oscrub = (window as any).__slotOutScrub
            const f = s.from[i] ?? 0, xo = reduced ? 1 : clamp(((typeof oscrub === 'number' ? oscrub * (OUT_DUR + STAGGER * (n - 1)) : now - s.ot0) - i * STAGGER) / OUT_DUR)
            v = f < 0.03 ? 0 : f >= 2 ? 2 : f + (2 - f) * easeIn(xo)
            if (xo < 1) done = false
            if (reduced && xo >= 1) o = 0
          } else { v = 0; if (s.dir > 0) done = false }
          s.v[i] = v
          const L = s.lines[i]
          if (L) {
            L.mat.uniforms.u_reveal.value = v; L.mat.uniforms.u_opacity.value = o
            ;(L.mat.uniforms.u_color.value as THREE.Color).copy(ink[L.role])
          }
          const d = s.dom[i]
          if (d && !gl) { d.style.transform = `translate3d(0, ${((1 - v) * 110).toFixed(1)}%, 0)`; d.style.opacity = o.toFixed(3) }
        }
        if (s.dir > 0 && done) s.ot0 = -1
        if (s.dir < 0 && done) { s.on = false; s.ot0 = -1; for (const L of s.lines) L.mat.uniforms.u_opacity.value = 0; if (!gl) s.dom.forEach((d) => { d.style.opacity = '0' }) }   // W19 (P0-4): a cleared beat leaves no glyph tops in the mask
      }
    }
    // v5.5 (review: "Out of the screen" low-contrast on the bright meadow, phone 76–77%): a soft dark scrim under the
    // slot, drawn in the slot pass just before the lines, only while the journey2 beat holds the slot. Full width, runs
    // off the bottom and both sides, alpha rises from 0 on a smoothstep and is dithered: no edge, no band.
    const J2 = IDX.get('journey2')!
    let scrimA = 0
    const scrimMat = gl ? new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 v_uv; void main(){ v_uv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float u_a; uniform float u_ramp; varying vec2 v_uv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){ float y = clamp((1.0 - v_uv.y) / u_ramp, 0.0, 1.0); float a = u_a * y * y * (3.0 - 2.0 * y);
          a += (h(gl_FragCoord.xy) - 0.5) / 255.0; gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(a, 0.0, 1.0)); }`,
      uniforms: { u_a: { value: 0 }, u_ramp: { value: 0.5 } },
      transparent: true, depthTest: false, depthWrite: false,
    }) : null
    const scrim: UfxItem | null = scrimMat ? {
      el: host, mesh: new THREE.Mesh(new THREE.PlaneGeometry(1, 1), scrimMat), layer: 'slot', fixed: true, selfPlaced: true,
      docTop: 0, docLeft: 0, w: 0, h: 0, section: '', measure() { /* placed every frame */ },
      visibleWhen: () => scrimA > 0.003,
      onUpdate(it) {
        const vw = ufx.w, vh = ufx.h, top = Math.min(slotBox.top, vh * 0.85) - 170, h = vh - top + 40
        it.mesh.position.set(0, -(top + h / 2 - vh / 2), 0); it.mesh.scale.set(vw + 80, h, 1)
        scrimMat!.uniforms.u_ramp.value = 230 / h; scrimMat!.uniforms.u_a.value = scrimA
      },
    } : null
    if (scrim) { scrim.mesh.renderOrder = 5; ufx.add(scrim) }
    // v5.6c (phone only, review: the CTA stickers rise behind "Out of / the screen." at ~79–82% and read busy under the
    // white type; ctaScene is locked and retiming/moving the title were rejected): a soft dark PLATE right behind the
    // title block, on top of the v5.5 scrim. A rounded box hugging the text's own glyph rects with a wide quintic
    // feather (C2, no knee) and the same 1/255 dither: no edge, no band. Its strength rides the v5.5 fade (scrimA, i.e.
    // the title's own in/out) times a short ramp at the beat's late part (journey pin 0.645→0.675 ≈ page 77.3→78%), so
    // 76–77% looks as v5.5. Narrow layout only (ufx.w < 700): the PC frame never draws it.
    // The box starts 40 px below the eyebrow's top (the small grey eyebrow sits on clear black) and its feather is 70 px,
    // so the plate fades out above the type and never shades the tablet's bottom edge; sides and bottom run off-screen.
    const PLATE_PEAK = 0.75, PLATE_F = 70, PLATE_TOP = 40
    let plateA = 0, plateK = '', plateBox = { l: 0, t: 0, r: 0, b: 0 }
    const plateMat = gl ? new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 v_uv; void main(){ v_uv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float u_a; uniform vec2 u_size; uniform vec2 u_half; uniform float u_f; varying vec2 v_uv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){ vec2 p = (v_uv - 0.5) * u_size; float r = 48.0; vec2 q = abs(p) - (u_half - r);
          float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
          float t = clamp((d + 16.0) / (u_f + 16.0), 0.0, 1.0); float a = u_a * (1.0 - t * t * t * (t * (t * 6.0 - 15.0) + 10.0));
          a += (h(gl_FragCoord.xy + 17.0) - 0.5) / 255.0; gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(a, 0.0, 1.0)); }`,
      uniforms: { u_a: { value: 0 }, u_size: { value: new THREE.Vector2(1, 1) }, u_half: { value: new THREE.Vector2(1, 1) }, u_f: { value: PLATE_F } },
      transparent: true, depthTest: false, depthWrite: false,
    }) : null
    const plateMeasure = () => {
      // the title block's tight glyph box (eyebrow, both title lines, body), viewport px; the slot never moves
      const rg = document.createRange(); let l = 1e5, t = 1e5, r = -1e5, b = -1e5
      for (const el of Array.from(beatsEl[J2].querySelectorAll<HTMLElement>('[data-role]'))) {
        rg.selectNodeContents(el); const q = rg.getBoundingClientRect(); if (q.width < 1) continue
        l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom)
      }
      if (r > l) plateBox = { l, t: t + PLATE_TOP, r, b }
    }
    const plate: UfxItem | null = plateMat ? {
      el: host, mesh: new THREE.Mesh(new THREE.PlaneGeometry(1, 1), plateMat), layer: 'slot', fixed: true, selfPlaced: true,
      docTop: 0, docLeft: 0, w: 0, h: 0, section: '', measure() { /* placed every frame */ },
      visibleWhen: () => plateA > 0.003,
      onUpdate(it) {
        const vw = ufx.w, vh = ufx.h, k = vw + 'x' + vh
        if (k !== plateK) { plateK = k; plateMeasure() }
        const B = plateBox, pad = 14, w = B.r - B.l + pad * 2 + PLATE_F * 2, h = B.b - B.t + pad * 2 + PLATE_F * 2
        it.mesh.position.set((B.l + B.r) / 2 - vw / 2, -((B.t + B.b) / 2 - vh / 2), 0); it.mesh.scale.set(w, h, 1)
        plateMat!.uniforms.u_size.value.set(w, h); plateMat!.uniforms.u_half.value.set((B.r - B.l) / 2 + pad, (B.b - B.t) / 2 + pad)
        plateMat!.uniforms.u_a.value = plateA
      },
    } : null
    if (plate) { plate.mesh.renderOrder = 5; ufx.add(plate) }
    const scrimTick = () => {
      const on = active === J2 && document.documentElement.dataset.bg === 'dark'
      scrimA += ((on ? 0.5 : 0) - scrimA) * (1 - Math.exp(-4 * Math.min(props.dt, 0.1)))
      if (plate) { const jp = pin('journey'), u = clamp((jp - 0.645) / 0.03), late = u * u * (3 - 2 * u); plateA = ufx.w < 700 ? PLATE_PEAK * (scrimA / 0.5) * late : 0 }
    }
    gsap.ticker.add(scrimTick)
    gsap.ticker.add(tick)
    let ro: ResizeObserver | null = null
    let gone = false
    document.fonts.ready.then(() => buildSliced()).then(() => {
      if (gone) return
      measure(); built = true
      ro = new ResizeObserver(() => { measure() }); scrollHost.observe(ro)
    })
    let rt = 0
    const onResize = () => { clearTimeout(rt); rt = window.setTimeout(() => { measure(); const a = active; active = -1; build(); set(a); slotBox.top = a >= 0 ? beatsEl[a].getBoundingClientRect().top : 1e5; st.forEach((s, i) => { if (i === a) { s.on = true; s.dir = 1; s.t0 = -10 } }) }, 180) }
    const offVp = onViewport(onResize) // R7.07: real resizes only (not the address bar)
    return () => {
      gone = true; gen++
      gsap.ticker.remove(tick); gsap.ticker.remove(scrimTick); if (scrim) { ufx.remove(scrim); scrim.mesh.geometry.dispose(); scrimMat!.dispose() }; if (plate) { ufx.remove(plate); plate.mesh.geometry.dispose(); plateMat!.dispose() }; offVp(); window.removeEventListener('st:drop', onDrop); ro?.disconnect()
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
            <p className="slot__title" data-role="title">{noOrphanLines(b.title).map((t, i, a) => <span key={i}>{t}{i < a.length - 1 && <br />}</span>)}</p>
            <p className="slot__body" data-role="body">{Array.isArray(b.body) ? b.body.map((t, i, a) => <span key={i}>{t}{i < a.length - 1 && <br />}</span>) : noOrphan(b.body)}</p>
          </div>
        ))}
      </div>
      <p className="sr-only" aria-live="polite" ref={live} />
      {/* A11Y (eng #19): sr-only heading copies of the beats, placed inside their sections (no visual change) */}
      <SrHeadings />
    </div>
  )
}
const GEO = new THREE.PlaneGeometry(1, 1, 1, 24)
