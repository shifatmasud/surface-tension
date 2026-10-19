import { useEffect, useRef } from 'react'
import gsap from 'gsap'

/** Rolling digit counter: each digit is a 0–9 strip that rolls into place (staggered, eased). */
export function Odometer({ value, digits, className, duration = 1.6, play = true, delay = 0 }: { value: number; digits?: number; className?: string; duration?: number; play?: boolean; delay?: number }) {
  const n = Math.max(0, Math.round(value))
  const str = String(n).padStart(digits ?? String(n).length, '0')
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const strips = ref.current.querySelectorAll<HTMLElement>('.odo__strip')
    strips.forEach((s, i) => {
      const d = Number(str[i])
      // roll at least one full turn for the leading digits so it reads as a mechanism
      const turns = play ? (strips.length - i) : 0
      gsap.to(s, { yPercent: -((d + turns * 10) * (100 / 30)), duration: play ? duration + i * 0.12 : 0, ease: 'expo.out', delay: delay + i * 0.05, overwrite: true })
    })
  }, [str, play, duration, delay])
  return (
    <span ref={ref} className={'odo ' + (className ?? '')} aria-label={String(n)} role="text">
      {str.split('').map((_, i) => (
        <span className="odo__col" key={i} aria-hidden>
          <span className="odo__strip">{Array.from({ length: 30 }, (_, k) => <span key={k}>{k % 10}</span>)}</span>
        </span>
      ))}
    </span>
  )
}

/** Fast odometer for per-frame values (intro counter): sets transforms directly, no tween per frame. */
export function setOdometer(root: HTMLElement, value: number, digits = 3) {
  const s = String(Math.round(value)).padStart(digits, '0')
  root.querySelectorAll<HTMLElement>('.odo__strip').forEach((el, i) => {
    el.style.transform = `translate3d(0, ${-(Number(s[i]) + 10) * (100 / 30)}%, 0)`
  })
}
