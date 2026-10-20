/**
 * TYPOGRAPHY (Shifat 18:06Z: no orphan words, lines optically balanced). CSS text-wrap (balance / pretty, app.css
 * A11Y/TYPE block) does the work in current browsers; this is the fallback for older Safari: the last two words of a
 * piece of copy are joined with a non-breaking space, so a line can never end the block with one lone word.
 * Copy of fewer than three words, or whose last two words are too long to share a phone line, is left as it is.
 */
export function noOrphan(s: string): string {
  const m = /^(.*\S)\s+(\S+\s+\S+)\s*$/s.exec(s)
  if (!m) return s
  const tail = m[2].replace(/\s+/, '\u00A0')
  return tail.length > 24 ? s : `${m[1]} ${tail}`
}

/**
 * The same rule for a headline drawn as fixed lines (the text slot's title stacks): a headline of three or more words
 * never ends on a lone word — the last word of the line above moves down to join it ("Under the / surface" →
 * "Under / the surface"). Two-word headlines stacked one word per line (a name, "Playable / worlds.") are left as set.
 */
export function noOrphanLines(lines: string[]): string[] {
  const words = lines.join(' ').trim().split(/\s+/)
  if (lines.length < 2 || words.length < 3) return lines
  const out = lines.slice()
  const last = out[out.length - 1].trim(), prev = out[out.length - 2].trim()
  if (/\s/.test(last)) return lines
  const pw = prev.split(/\s+/)
  if (pw.length < 2) return lines
  out[out.length - 2] = pw.slice(0, -1).join(' ')
  out[out.length - 1] = `${pw[pw.length - 1]} ${last}`
  return out
}
