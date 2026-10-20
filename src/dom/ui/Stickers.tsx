import { motion, useAnimationControls } from 'framer-motion'
import { useRef } from 'react'
import { audio } from '../../services/audio'

/**
 * Stickers on the CTA wall (STRUCTURE v2): die-cut vinyl — a white cut edge (the paper margin, not a CSS border),
 * a flat colour face, a slight curl (a corner that lifts on hover, the peel) and a flat specular band that sweeps on
 * hover. Drag them anywhere on the wall; let go and they slap back down with a little bounce and a soft tap.
 * Phones: drag works; a tap wobbles and flips the sticker. Colour here is part of the scene (the 3D world's palette),
 * the UI itself stays black and white.
 */
type S = { id: string; label: string; shape: 'pill' | 'circle' | 'star' | 'square' | 'drop'; bg: string; fg: string; x: string; y: string; mx: string; my: string; r: number; size: string }
const LIST: S[] = [
  // x/y on the wall (desktop), mx/my on phones — kept to the sides so the crewmate and the type stay the key elements
  { id: 'react', label: 'React', shape: 'pill', bg: '#5ad1ff', fg: '#04121a', x: '3%', y: '8%', mx: '0%', my: '4%', r: -8, size: 'm' },
  { id: 'fps', label: '60fps', shape: 'star', bg: '#7cf29a', fg: '#04170a', x: '19%', y: '30%', mx: '1%', my: '36%', r: -14, size: 'm' },
  { id: 'figma', label: 'Figma', shape: 'pill', bg: '#a78bfa', fg: '#0e0820', x: '6%', y: '62%', mx: '3%', my: '78%', r: 7, size: 's' },
  { id: 'glsl', label: 'GLSL', shape: 'circle', bg: '#ffd23f', fg: '#1a1400', x: '70%', y: '2%', mx: '76%', my: '0%', r: 10, size: 'm' },
  { id: 'r3f', label: 'R3F', shape: 'square', bg: '#ff5a5f', fg: '#1a0304', x: '89%', y: '24%', mx: '84%', my: '40%', r: -6, size: 's' },
  { id: 'ripple', label: 'make ripples', shape: 'drop', bg: '#2f6bff', fg: '#ffffff', x: '76%', y: '50%', mx: '70%', my: '70%', r: 12, size: 'l' },
  { id: 'ts', label: 'TypeScript', shape: 'pill', bg: '#ffffff', fg: '#0a0a0b', x: '24%', y: '4%', mx: '', my: '', r: 4, size: 's' },
]

function Sticker({ s, wall }: { s: S; wall: React.RefObject<HTMLDivElement> }) {
  const ctl = useAnimationControls()
  const flipped = useRef(false)
  return (
    <motion.button
      type="button"
      className={`sticker sticker--${s.shape} sticker--${s.size}${s.mx ? '' : ' sticker--wide-only'}`}
      style={{ rotate: s.r, ['--x' as any]: s.x, ['--y' as any]: s.y, ['--mx' as any]: s.mx || s.x, ['--my' as any]: s.my || s.y, ['--bg' as any]: s.bg, ['--fg' as any]: s.fg }}
      aria-label={`Sticker: ${s.label}. Drag it around the wall.`}
      drag dragConstraints={wall} dragElastic={0.12} dragMomentum={false}
      animate={ctl}
      whileHover={{ scale: 1.04, rotate: s.r * 0.6 }}
      whileDrag={{ scale: 1.1, rotate: s.r * 0.3, zIndex: 5 }}
      onDragStart={() => audio.tick()}
      onDragEnd={() => {
        ctl.start({ scale: [1.1, 0.96, 1.0], transition: { duration: 0.42, times: [0, 0.45, 1], ease: 'easeOut' } })
        audio.plip(0.45, 0.6 + Math.random() * 0.3)
      }}
      onTap={(e) => {
        if ((e as PointerEvent).pointerType !== 'touch') return
        flipped.current = !flipped.current
        ctl.start({ rotateY: flipped.current ? 180 : 0, rotate: [s.r, s.r + 6, s.r - 4, s.r], transition: { duration: 0.6 } })
        audio.plip(0.35, 0.9)
      }}
      data-cursor data-cursor-label="Drag"
    >
      <span className="sticker__face"><span className="sticker__label">{s.label}</span><i className="sticker__sheen" aria-hidden /></span>
      <i className="sticker__curl" aria-hidden />
    </motion.button>
  )
}

export function Stickers() {
  const wall = useRef<HTMLDivElement>(null)
  return (
    <div className="stickers" ref={wall} role="group" aria-label="Stickers: tools and skills">
      {LIST.map((s) => <Sticker key={s.id} s={s} wall={wall} />)}
    </div>
  )
}
