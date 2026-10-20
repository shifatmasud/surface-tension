/**
 * Preloader 3D logo boot. Helper 99499b45 (logo3d).
 * Inlined into index.html at build time (scripts/logoInline.mjs), so it runs during HTML parse with zero requests,
 * before the ~1.5 MB scene bundle even starts. It owns one small fixed canvas above the black intro panel:
 * spins the mark INSIDE the black intro panel (a child of it, clipped by it: Shifat 14:44Z), leaves with the curtain,
 * then loses its GL context and removes itself.
 *
 * Hook (src/preloader/hook.ts, called from Intro.tsx): logo3d.progress(0..1) each frame, logo3d.exit() when the
 * curtain starts. Without the hook it still works: idle spin, follows the .intro panel, cleans up on html.is-lifted.
 * QA: window.__logo3d.qa({ angle, progress, sweep }) freezes a frame (angle in degrees); qa(null) resumes.
 *     ?logohold keeps it alive (ignores exit/cleanup) for screenshots.
 */
import { createLogoRenderer, type LogoFrame } from './LogoMark3D'

export interface Logo3DApi {
  progress(p: number): void
  exit(): void
  qa(f: { angle?: number; progress?: number; sweep?: number } | null): void
  dispose(): void
  /** QA: performance.now() of the first rendered frame, and frames rendered so far */
  firstFrame: number
  frames: number
}

declare global { interface Window { __logo3d?: Logo3DApi } }

;(function () {
  const d = document, h = d.documentElement
  if (h.classList.contains('no-gl') || window.__logo3d) return
  const q = location.search, hold = /[?&]logohold/.test(q)
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const cv = d.createElement('canvas')
  cv.setAttribute('aria-hidden', 'true')
  cv.className = 'logo3d'
  const st = cv.style
  // Shifat 14:44Z: the logo lives INSIDE the preloader panel (a child of .intro, which clips), so it leaves with the
  // panel frame-exact and is cut by the panel's own edge — never floating over the hero
  st.cssText = 'position:absolute;left:50%;top:44%;z-index:1;pointer-events:none;opacity:0;transition:opacity .45s cubic-bezier(0.65,0,0.35,1);transform:translate(-50%,-50%)'
  let size = 0
  const layout = () => {
    const w = innerWidth, hh = innerHeight
    // calm and centred: ~40 % of the short side on desktop (max 400 px canvas; the mark fills ~58 % of it), bigger on phones
    size = Math.round(w < 640 ? Math.min(w * 0.64, hh * 0.36) : Math.max(170, Math.min(Math.min(w, hh) * 0.4, 400)))
    st.width = st.height = size + 'px'
  }
  layout()
  // the panel: React's .intro once it has mounted, else the static shell panel from index.html
  const panelOf = () => d.querySelector('.intro:not(.shell-intro)') || d.querySelector('.shell-intro')
  const adopt = () => { const p = panelOf(); if (p && cv.parentElement !== p) p.appendChild(cv); return p }
  if (!adopt()) (d.body || h).appendChild(cv)

  let R: ReturnType<typeof createLogoRenderer> | null = null
  let raf = 0, last = 0, phase = 0.08, prog = 0, progS = 0, exitT = 0, done = false
  let qa: { angle?: number; progress?: number; sweep?: number } | null = null
  let intro: Element | null = null
  const fr: LogoFrame = { angle: 0, tilt: 0, key: 1, sweep: 0, sweepAmt: 0 }
  const dpr = () => Math.min(devicePixelRatio || 1, 2)
  const onResize = () => { layout(); R && R.resize(Math.round(size * dpr())) }

  const dispose = () => {
    if (done) return
    done = true; cancelAnimationFrame(raf); removeEventListener('resize', onResize)
    R && R.dispose(); cv.remove(); delete window.__logo3d
  }

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick)
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0; last = now
    progS += (prog - progS) * (1 - Math.exp(-6 * dt))
    const p = qa && qa.progress != null ? qa.progress : progS
    // ~1 turn / 2.4 s at rest, ~25 % quicker as the counter nears 100; a short extra spin on exit
    const ex = exitT ? Math.min((now - exitT) / 1000, 2) : 0
    const speed = reduced ? 0 : (1 + 0.28 * p) * (1 + 2.2 * Math.exp(-((ex - 0.35) ** 2) / 0.08) * (exitT ? 1 : 0))
    phase += (dt / 2.4) * speed
    const u = phase % 1
    // eased per turn: lingers when it faces you, quicker through the back
    let ang = reduced ? -0.62 : 2 * Math.PI * u - 0.42 * Math.sin(2 * Math.PI * u)
    let tilt = reduced ? -0.16 : -0.1 + 0.05 * Math.sin(2 * Math.PI * phase * 0.5)
    if (qa && qa.angle != null) { ang = (qa.angle * Math.PI) / 180; tilt = -0.1 }
    fr.angle = ang; fr.tilt = tilt
    fr.key = 0.78 + 0.22 * p
    // light sweep across the mark as it completes (and on exit)
    const sw = qa && qa.sweep != null ? qa.sweep : exitT ? Math.min(ex / 0.7, 1) : p > 0.9 ? (p - 0.9) / 0.1 * 0.5 : 0
    fr.sweep = sw; fr.sweepAmt = sw > 0 && sw < 1 ? Math.sin(Math.PI * sw) : 0
    // reduced motion: one static 3/4 frame, then only the curtain/fade tracking below
    if (R && (!reduced || !api.frames || qa)) { R.render(fr); api.frames++; if (!api.firstFrame) api.firstFrame = now }

    // ride inside the panel (re-adopted when React's panel replaces the shell); the panel's transform and opacity carry it
    intro = adopt()
    if (intro && exitT && !hold) {
      const r = intro.getBoundingClientRect()
      if (r.bottom <= 1 || parseFloat(getComputedStyle(intro).opacity) <= 0.01 || now - exitT > 15000) dispose()
    }
    if (!hold && h.classList.contains('is-lifted')) dispose()
  }

  const api: Logo3DApi = {
    progress(v) { prog = Math.max(prog, Math.min(1, v || 0)) },
    exit() { if (!exitT) { exitT = performance.now(); prog = 1 } },
    qa(f) { qa = f },
    dispose,
    firstFrame: 0,
    frames: 0,
  }
  window.__logo3d = api
  // GL setup after the shell's first paint AND after the main bundle's loader (deferBoot in vite.config) has queued its
  // requests in that same frame: rAF -> timer -> timer runs behind deferBoot's rAF -> timer, so the scene download never
  // waits on this shader compile
  const init = () => {
    if (done) return
    R = createLogoRenderer(cv)
    if (!R.ok) { dispose(); return }
    onResize(); addEventListener('resize', onResize)
    raf = requestAnimationFrame((t) => { tick(t); st.opacity = '1' })
  }
  requestAnimationFrame(() => setTimeout(() => setTimeout(init, 0), 0))
})()
