/** Shifat Masud's mark as a flat inline SVG (traced from his official logo; see shifat-logo.svg). Helper 99499b45.
 *  Inherits currentColor, so it is black on light and white on dark. Size it with font-size (1em = cap-ish height). */
import type { CSSProperties } from 'react'

export const LOGO_PATH = 'M100 0H200L100 100H0Z M100 100H200L100 200H0Z'

export function Logo({ size = '1em', title = 'Shifat Masud', className, style }: { size?: string | number; title?: string; className?: string; style?: CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 200 200" width={size} height={size} fill="currentColor" role="img" aria-label={title} focusable="false">
      <path d={LOGO_PATH} />
    </svg>
  )
}
