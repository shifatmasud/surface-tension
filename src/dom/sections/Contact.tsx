import { Odometer } from '../ui/Odometer'
import * as THREE from 'three'
import { useEffect, useRef, useState } from 'react'
import { useSection, weightFrom } from './useSection'
import { visuals } from '../../gl/systems/visuals'
import { props } from '../../state/props'
import { clamp, mix } from '../../core/math'
import { vfovFor, portrait } from '../../core/frame'
import { SITE } from '../../content/site'
import { ArrowUpRight, GithubLogo, XLogo, PaperPlaneTilt } from '@phosphor-icons/react'
import { ufxText } from '../../gl/ufx/UfxText'
import { scroll } from '../../services/scroll'
import { audio } from '../../services/audio'
import { pool } from '../../gl/systems/pool'
import './contact.css'

function DhakaClock() {
  const [t, setT] = useState([0, 0, 0])
  useEffect(() => {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: SITE.tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    const tick = () => setT(f.format(new Date()).split(':').map(Number))
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id)
  }, [])
  // every second the reels roll one step (odometer); minutes and hours carry when they turn over
  return <span className="clock"><Odometer value={t[0]} digits={2} />:<Odometer value={t[1]} digits={2} />:<Odometer value={t[2]} digits={2} duration={0.7} /> GMT+6</span>
}

/** S7 — Resurface + contact. One star: the line. Keep scrolling and the bar floats you back up. */
export function Contact() {
  const ref = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const over = useRef<HTMLDivElement>(null)
  const [msg, setMsg] = useState('')
  useSection(ref, (range) => {
    // bookend: the blue gem settles back onto the lake as the star of the upper ~60 % (it was a small blue blob
    // sitting on the headline from the old far pose); droplets ring around it
    const pose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 36 }
    const st = visuals.register('contact', () => {
      const pr = portrait()
      pose.pos.set(0, 2.4 - pr * 0.5, 5.0 - pr * 0.6)
      pose.fov = vfovFor(46, 22, 60)
      // the stone keeps the same share of the frame height at any aspect: on ultrawide (narrow vertical fov) the
      // camera backs off along the same line instead of letting the gem crop off the top
      const back = Math.max(1, 30 / pose.fov) * mix(1.15, 1, pr) // landscape: a touch further (the type now sits lower, so the stone can be a little bigger)
      pose.pos.y = 0.33 + (pose.pos.y - 0.33) * back; pose.pos.z *= back
      // aim so the gem sits ~28 % from the top at any aspect (ultrawide's narrow vertical fov would push a fixed
      // aim off the top): down-angle to the gem plus the angle that puts it k of the half-height above centre
      const aspect = props.width / Math.max(1, props.height)
      // ultrawide: the narrow vertical fov lifts the stone toward the header, so aim it a little lower there
      const half = (pose.fov * Math.PI) / 360, k = 0.6 - pr * 0.06 - 0.24 * clamp((aspect - 1.6) / 0.8)
      const dz = pose.pos.z, gemDown = Math.atan2(pose.pos.y - 0.33, dz)
      const pitch = gemDown + Math.atan(k * Math.tan(half))
      pose.target.set(0, pose.pos.y - Math.tan(pitch) * dz, 0)
      return pose
    }, { fade: 0.1, vignette: 0.05, bloom: 0.22, exposure: 1.1, lift: 0.5 })
    let h: ReturnType<typeof ufxText> | null = null
    let fired = false
    // the crewmate's break-out droplets land on the bright water as the field turns light again
    let landed = false
    let dripT = 3
    const land = () => {
      const n = 7
      for (let i = 0; i < n; i++) {
        setTimeout(() => {
          const a = (i / n) * Math.PI * 2 + Math.random() * 0.6, r = 0.9 + Math.random() * 1.6
          const x = Math.cos(a) * r * 1.3, z = Math.sin(a) * r * 0.8 + 0.3
          pool.drop(x, z, 0.12 + Math.random() * 0.06, 0.018 + Math.random() * 0.012)
          if (i % 2 === 0) audio.plip(0.55, 0.8 + Math.random() * 0.5)
        }, 90 + i * (110 + Math.random() * 90))
      }
    }
    return {
      name: 'contact',
      init() { document.fonts.ready.then(() => { if (title.current) h = ufxText(title.current, { color: '#0b0b0d', sheen: '#c9ccd2' }) }) },
      update() {
        st.weight = weightFrom(range.ratio) * 1.3
        props.resurface = clamp(range.progress)
        const rv = clamp((props.scroll - (range.docTop - props.height * 0.8)) / (props.height * 0.7))
        h?.mats.forEach((m, i) => { m.uniforms.u_reveal.value = clamp(rv * 1.3 - i * 0.15) })
        if (rv > 0.15 && !landed) { landed = true; land() } else if (rv <= 0.0 && landed) landed = false
        // after the landing, the calm: a single late droplet now and then, near the gem, so the water stays alive
        if (landed && st.weight > 0.5) {
          dripT -= props.dt
          if (dripT <= 0) {
            dripT = 2.6 + Math.random() * 2.4
            const a = Math.random() * Math.PI * 2, r = 0.7 + Math.random() * 1.4
            pool.drop(Math.cos(a) * r * 1.3, Math.sin(a) * r * 0.8 + 0.3, 0.1 + Math.random() * 0.05, 0.02)
            if (Math.random() < 0.5) audio.plip(0.35, 0.8 + Math.random() * 0.5)
          }
        }
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
        <h2 className="contact__title" ref={title}>Let’s make<br />it ripple.</h2>
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
        <footer className="footer"><span>© <Odometer value={new Date().getFullYear()} digits={4} /> {SITE.name}</span><span>Surface Tension — portfolio prototype</span></footer>
      </section>
      <div className="overscroll" ref={over} aria-hidden>
        <div className="overscroll__bar"><p className="overscroll__label">Keep scrolling — back to the surface</p><div className="overscroll__track"><div className="overscroll__fill" ref={bar} /></div></div>
      </div>
    </>
  )
}
