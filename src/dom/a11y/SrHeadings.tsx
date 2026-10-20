import { useEffect } from 'react'
import { PROJECTS } from '../../content/site'

/**
 * A11Y (eng #19): a real heading outline for screen readers, with no visual change.
 * The beats are painted by the global text slot (TextLayer), which is aria-hidden and sits outside <main>, so a
 * section that has no heading of its own gets an sr-only copy of its beat INSIDE the section, in reading order:
 *   h1 Shifat Masud (Hero) · (the dive is wordless since Shifat 18:52Z: no principle, no Under the surface)
 *   · h2 Selected work + h3 per project (Work) · h2 Shade DS (Systems) · h2 Journey + h3 per beat · h2 CTA (Contact)
 * Sections that already carry a heading (systems, contact) are left alone.
 */
type H = { section: string; at: 'start' | 'end'; level: 2 | 3; text: string }
const HEADINGS: H[] = [
  { section: 'lab', at: 'start', level: 2, text: 'Selected work' },
  ...PROJECTS.map((p) => ({ section: 'lab', at: 'end' as const, level: 3 as const, text: `${p.title}, ${p.year}` })),
  { section: 'journey', at: 'start', level: 2, text: 'Journey' },
  { section: 'journey', at: 'end', level: 3, text: 'Playable worlds. Made for the browser.' },
  { section: 'journey', at: 'end', level: 3, text: 'Out of the screen. Games, toys and tools that don’t stay inside the screen.' },
]

export function SrHeadings() {
  useEffect(() => {
    const made: HTMLElement[] = []
    for (const h of HEADINGS) {
      const sec = document.getElementById(h.section)
      if (!sec) continue
      if (h.level === 2 && h.at === 'start' && sec.querySelector('h1, h2')) continue   // the section already has one
      const el = document.createElement('h' + h.level)
      el.className = 'sr-only'; el.textContent = h.text; el.dataset.srHeading = ''
      if (h.at === 'start') sec.insertBefore(el, sec.firstChild); else sec.appendChild(el)
      made.push(el)
    }
    return () => made.forEach((el) => el.remove())
  }, [])
  return null
}
