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
    // POLISH: touch never shows the cursor or its label ("DRAG" over a sticker). The last REAL pointer decides: the
    // sticker layer re-dispatches a synthetic pointerover (pointerType '') when its label changes, so that one keeps
    // the type of the pointer that caused it; a coarse-only device (no fine pointer at all) never shows it either.
    const coarse = matchMedia('(pointer: coarse)'), fine = matchMedia('(any-pointer: fine)')
    let lastType = coarse.matches && !fine.matches ? 'touch' : 'mouse'
    const apply = () => {
      const el = ref.current; if (!el) return
      const touch = lastType === 'touch'
      el.style.display = touch ? 'none' : ''
      if (touch) { el.classList.remove('is-hover'); setLabel('') }
    }
    const seen = (e: PointerEvent) => {
      if (!e.isTrusted || !e.pointerType || e.pointerType === lastType) return
      lastType = e.pointerType; apply()
    }
    const over = (e: PointerEvent) => {
      seen(e)
      if (lastType === 'touch') return
      const t = (e.target as HTMLElement).closest('[data-cursor],a,button,.card') as HTMLElement | null
      ref.current?.classList.toggle('is-hover', !!t)
      setLabel(t?.dataset.cursorLabel ?? '')
    }
    const opts = { passive: true, capture: true }
    window.addEventListener('pointerover', over)
    window.addEventListener('pointerdown', seen, opts); window.addEventListener('pointermove', seen, opts)
    apply()
    return () => {
      gsap.ticker.remove(tick); window.removeEventListener('pointerover', over)
      window.removeEventListener('pointerdown', seen, opts); window.removeEventListener('pointermove', seen, opts)
    }
  }, [])
  return (
    <div className="cursor" ref={ref} aria-hidden>
      <div className="cursor__ring" />
      <div className="cursor__dot" />
      {label && <div className="cursor__label">{label}</div>}
    </div>
  )
}
