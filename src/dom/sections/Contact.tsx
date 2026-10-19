import * as THREE from 'three'
import { useEffect, useRef, useState } from 'react'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp } from '../../core/math'
import { SITE } from '../../content/site'
import { ArrowUpRight, GithubLogo, XLogo, PaperPlaneTilt } from '@phosphor-icons/react'
import { ufxText } from '../../gl/ufx/UfxText'
import { scroll } from '../../services/scroll'
import { audio } from '../../services/audio'

function DhakaClock() {
  const [t, setT] = useState('')
  useEffect(() => {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: SITE.tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    const tick = () => setT(f.format(new Date()))
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id)
  }, [])
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{t} GMT+6</span>
}

/** S7 — Resurface + contact. One star: the line. Keep scrolling and the bar floats you back up. */
export function Contact() {
  const ref = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const over = useRef<HTMLDivElement>(null)
  const [msg, setMsg] = useState('')
  useSection(ref, (range) => {
    const pose = { pos: new THREE.Vector3(0, 7.2, 10.5), target: new THREE.Vector3(0, 0, 0.5), fov: 36 }
    const st = visuals.register('contact', () => pose, { fade: 0.25, vignette: 0.15, bloom: 0.22 })
    let h: ReturnType<typeof ufxText> | null = null
    let fired = false
    return {
      name: 'contact',
      init() { document.fonts.ready.then(() => { if (title.current) h = ufxText(title.current, { color: '#0b0b0d', sheen: '#c9ccd2' }) }) },
      update() {
        st.weight = weightFrom(range.ratio) * 1.3
        props.resurface = clamp(range.progress)
        const rv = clamp((props.scroll - (range.docTop - props.height * 0.8)) / (props.height * 0.7))
        h?.mats.forEach((m, i) => { m.uniforms.u_reveal.value = clamp(rv * 1.3 - i * 0.15) })
        // overscroll back-to-top bar
        const o = over.current
        if (o) {
          const r = o.getBoundingClientRect()
          const f = clamp((props.height - r.top) / (r.height + 1))
          props.overscroll = f
          if (bar.current) bar.current.style.transform = `scaleX(${f.toFixed(3)})`
          if (f > 0.985 && !fired) { fired = true; audio.swell(false); scroll.scrollTo(0, { duration: 3.2 }); setTimeout(() => (fired = false), 3500) }
        }
      },
      dispose() { h?.dispose() },
    }
  })
  const send = (e: React.FormEvent) => {
    e.preventDefault()
    const text = encodeURIComponent(msg || 'Hi Shifat!')
    if (SITE.email) location.href = `mailto:${SITE.email}?subject=Hello%20from%20your%20portfolio&body=${text}`
    else window.open(`${SITE.x}`, '_blank', 'noopener')
  }
  return (
    <>
      <section id="contact" className="section contact" ref={ref} aria-label="Contact">
        <h2 className="contact__title" ref={title}>Let’s make something that ripples.</h2>
        <div className="contact__row">
          <div className="contact__cta">
            <a className="big-btn" href={SITE.email ? `mailto:${SITE.email}` : SITE.x} target={SITE.email ? undefined : '_blank'} rel="noreferrer" data-cursor onMouseEnter={() => audio.tick()}>
              {SITE.email ? 'Write to me' : 'Say hi on X'} <i><ArrowUpRight size={20} weight="bold" /></i>
            </a>
            <form className="form" onSubmit={send} data-no-drop>
              <label className="sr-only" htmlFor="msg">Drop me a line</label>
              <input id="msg" placeholder="Drop me a line…" value={msg} onChange={(e) => setMsg(e.target.value)} />
              <button className="pill pill--dark" type="submit" aria-label="Send"><PaperPlaneTilt size={16} weight="bold" /></button>
            </form>
          </div>
          <div className="contact__meta">
            <div><h3>Elsewhere</h3>
              <a href={SITE.github} target="_blank" rel="noreferrer" data-cursor><GithubLogo size={16} /> GitHub</a><br />
              <a href={SITE.x} target="_blank" rel="noreferrer" data-cursor><XLogo size={16} /> X / Twitter</a>
            </div>
            <div><h3>Local time</h3><span>{SITE.city}</span><br /><DhakaClock /></div>
          </div>
        </div>
        <footer className="footer"><span>© {new Date().getFullYear()} {SITE.name}</span><span>Surface Tension — portfolio prototype</span></footer>
      </section>
      <div className="overscroll" ref={over} aria-hidden>
        <div className="overscroll__bar"><div className="overscroll__fill" ref={bar} />Keep scrolling — back to the surface</div>
      </div>
    </>
  )
}
