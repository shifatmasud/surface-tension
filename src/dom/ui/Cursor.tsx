import { useEffect, useRef, useState } from 'react'
import { input } from '../../services/input'
import { Spring } from '../../core/spring'
import gsap from 'gsap'

/** A ring that trails the pointer on a spring and swells over anything interactive. */
export function Cursor() {
  const ref = useRef<HTMLDivElement>(null)
  const [label, setLabel] = useState('')
  useEffect(() => {
    const sx = new Spring(0, 2.6, 0.75, 0.4), sy = new Spring(0, 2.6, 0.75, 0.4)
    let first = true
    const tick = (_t: number, dms: number) => {
      const el = ref.current; if (!el || !input.everMoved) return
      if (first) el.classList.add('is-live')
      const dt = Math.min(dms / 1000, 0.05)
      if (first) { sx.reset(input.mousePixelXY.x); sy.reset(input.mousePixelXY.y); first = false }
      const x = sx.update(input.mousePixelXY.x, dt), y = sy.update(input.mousePixelXY.y, dt)
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`
      const dot = el.querySelector<HTMLElement>('.cursor__dot')!
      dot.style.transform = `translate3d(${input.mousePixelXY.x - x}px, ${input.mousePixelXY.y - y}px, 0)`
    }
    gsap.ticker.add(tick)
    const over = (e: PointerEvent) => {
      const t = (e.target as HTMLElement).closest('[data-cursor],a,button,.card') as HTMLElement | null
      ref.current?.classList.toggle('is-hover', !!t)
      setLabel(t?.dataset.cursorLabel ?? '')
    }
    window.addEventListener('pointerover', over)
    return () => { gsap.ticker.remove(tick); window.removeEventListener('pointerover', over) }
  }, [])
  return (
    <div className="cursor" ref={ref} aria-hidden>
      <div className="cursor__ring" />
      <div className="cursor__dot" />
      {label && <div className="cursor__label">{label}</div>}
    </div>
  )
}
