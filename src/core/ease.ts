import gsap from 'gsap'
import { CustomEase } from 'gsap/CustomEase'
gsap.registerPlugin(CustomEase)
// Our own curves (not the original's). "tension": fast lift, long settle — like a meniscus letting go.
export const EASE_TENSION = CustomEase.create('tension', 'M0,0 C0.18,0.72 0.24,1 1,1')
export const EASE_SURFACE = CustomEase.create('surface', 'M0,0 C0.62,0 0.06,1 1,1')
export const CSS_EASE = 'cubic-bezier(0.22, 0.9, 0.24, 1)'
export const expoOut = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t))
export const expoInOut = (t: number) => t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2
export const cubicOut = (t: number) => 1 - Math.pow(1 - t, 3)
