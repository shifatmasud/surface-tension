import { Odometer } from './Odometer'
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight, X } from '@phosphor-icons/react'
import { overlay } from './overlayState'
import { PROJECTS } from '../../content/site'
import { inkWipe } from './inkWipe'

/** Project overlay: ink wipe in (2D canvas) → video loads → panel springs in; Esc / click out closes. */
export function ProjectOverlay() {
  const [id, setId] = useState<string | null>(null)
  const [phase, setPhase] = useState('idle')
  const vid = useRef<HTMLVideoElement>(null)
  useEffect(() => overlay.sub((cur, s) => {
    setPhase(s)
    if (s === 'hiding') inkWipe.play('in').then(() => overlay.advance())
    if (s === 'loading') { setId(cur); setTimeout(() => overlay.advance(), 60) }
    if (s === 'showing') inkWipe.play('out').then(() => overlay.advance())
    if (s === 'closing') { inkWipe.play('in').then(() => { setId(null); inkWipe.play('out'); overlay.advance() }) }
  }), [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') overlay.close() }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [])
  const p = PROJECTS.find((x) => x.id === id)
  return (
    <AnimatePresence>
      {p && (
        <motion.div className="overlay" role="dialog" aria-modal="true" aria-label={p.title} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="overlay__bg" onClick={() => overlay.close()} />
          <motion.div className="overlay__panel" initial={{ y: 60, scale: 0.96 }} animate={{ y: 0, scale: 1 }} exit={{ y: 40, scale: 0.98 }} transition={{ type: 'spring', stiffness: 140, damping: 20 }}>
            <button className="pill overlay__close" onClick={() => overlay.close()} aria-label="Close"><X size={16} weight="bold" /></button>
            <video ref={vid} src={p.media} poster={p.poster} autoPlay muted loop playsInline />
            <div className="overlay__body">
              <span className="eyebrow"><Odometer value={Number(p.no)} digits={2} delay={0.2} /> · <Odometer value={Number(p.year)} digits={4} delay={0.25} />{p.client ? ' · ' + p.client : ''}</span>
              <h3>{p.title}</h3>
              <p style={{ color: '#a9adb3', fontSize: 'var(--fs-m)', margin: 0 }}>{p.blurb}</p>
              <div className="tags">{p.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>
              <a className="big-btn" href={p.url} target="_blank" rel="noreferrer" style={{ marginTop: 'auto' }}>Live demo <i><ArrowUpRight size={18} weight="bold" /></i></a>
            </div>
          </motion.div>
        </motion.div>
      )}
      {phase === 'never' && null}
    </AnimatePresence>
  )
}
