import { useEffect, useRef } from 'react'
import { createRoller, type Roller } from './maskedRoll'

/** MASKED ROLL in React (maskedRoll.ts has the move, the easing and the duration). digits: a per-column odometer roll for
 *  numbers; line: the whole line rolls out and the next rolls in, in one mask. Screen readers get the plain value. */
export function MaskedRoll(props: { mode: 'digits'; value: number; digits?: number; className?: string } | { mode: 'line'; text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const roller = useRef<Roller | null>(null)
  const next = props.mode === 'digits' ? props.value : props.text
  const digits = props.mode === 'digits' ? props.digits ?? String(Math.round(props.value)).length : 0
  useEffect(() => {
    const el = ref.current; if (!el) return
    roller.current = props.mode === 'digits' ? createRoller(el, { mode: 'digits', digits, value: props.value }) : createRoller(el, { mode: 'line', text: props.text })
    return () => { roller.current?.destroy(); roller.current = null; el.replaceChildren() }
    // the roller is rebuilt only when the mode or column count changes; value changes roll (below)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode, digits])
  useEffect(() => { roller.current?.set(next) }, [next])
  const label = props.mode === 'digits' ? String(Math.round(props.value)).padStart(digits, '0') : props.text
  return (
    <span className={props.className}>
      <span className="sr-only">{label}</span>
      <span ref={ref} aria-hidden="true" style={props.mode === 'line' ? { display: 'block' } : undefined} />
    </span>
  )
}
