/** Hook from the React preloader (Intro.tsx) into the inline 3D logo (boot.ts). Helper 99499b45 (logo3d).
 *  Safe no-ops when the logo is not running (no-gl, reduced-motion shell, WebGL refused, already disposed). */
import type {} from './boot'
export const logo3d = {
  progress(p: number) { window.__logo3d?.progress(p) },
  exit() { window.__logo3d?.exit() },
}
