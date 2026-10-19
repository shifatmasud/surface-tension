import { useEffect } from 'react'
import { sections, type Section } from '../../app/sections'
import { DomRange } from '../../services/scroll'

/** Hook: register a DOM section with the lifecycle manager (preInit/init/resize/update/show/hide). */
export function useSection(ref: React.RefObject<HTMLElement>, make: (range: DomRange) => Omit<Section, 'range'>, deps: unknown[] = []) {
  useEffect(() => {
    if (!ref.current) return
    const range = new DomRange(ref.current)
    const s = { ...make(range), range } as Section
    const off = sections.add(s)
    return () => { off(); (s as any).dispose?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
export const weightFrom = (ratio: number) => { const t = Math.max(0, 1 - Math.abs(ratio)); return t * t * (3 - 2 * t) }
