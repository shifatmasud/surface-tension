import { props } from '../state/props'
/** Keep a horizontal field of view across aspect ratios (phones portrait → ultrawide), capped. */
export function vfovFor(hfovDeg: number, min = 22, max = 64) {
  const a = Math.max(0.3, props.width / Math.max(1, props.height))
  const v = 2 * Math.atan(Math.tan((hfovDeg * Math.PI) / 360) / a) * (180 / Math.PI)
  return Math.min(max, Math.max(min, v))
}
/** 0 on landscape, 1 on tall portrait phones */
export function portrait() { const a = props.width / Math.max(1, props.height); return Math.min(1, Math.max(0, (1.1 - a) / 0.6)) }
