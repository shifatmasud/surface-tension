import { ArrowUpRight } from '@phosphor-icons/react'
import { PROJECTS } from '../../content/site'

/**
 * A11Y (eng #20): the reduced-motion / no-WebGL page is the whole site for those visitors, so it carries every
 * project's live link as a plain list next to the contact CTA. Shown only on that page (html.no-gl); the GL page
 * reaches the same links through the project cards and their overlay, so it adds no extra tab stops there.
 */
export function ProjectLinks() {
  return (
    <nav className="a11y-work" aria-label="Project links">
      <p className="a11y-work__label">Selected work</p>
      <ul>
        {PROJECTS.map((p) => (
          <li key={p.id}><a href={p.url} target="_blank" rel="noreferrer">{p.title} <ArrowUpRight size={12} aria-hidden="true" /></a></li>
        ))}
      </ul>
    </nav>
  )
}
