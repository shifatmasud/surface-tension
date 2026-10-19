import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { props } from '../../state/props'

/** Right-edge water-level line: scroll progress as a column of liquid silver. */
export function WaterLevel() {
  const fill = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const t = () => { if (fill.current) fill.current.style.transform = `scaleY(${props.scrollProgress.toFixed(4)})` }
    gsap.ticker.add(t); return () => gsap.ticker.remove(t)
  }, [])
  return (
    <div className="level" aria-hidden>
      <div className="level__fill" ref={fill} />
      {[0.2, 0.4, 0.6, 0.8].map((p) => <span key={p} className="level__tick" style={{ bottom: p * 100 + '%' }} />)}
    </div>
  )
}
