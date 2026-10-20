import type * as THREE from 'three'
import type { ScreenPaint } from './systems/ScreenPaint'
import type { RippleSim } from './systems/RippleSim'
import type { PostChain } from './post/PostChain'
/** Handles to the singleton GL systems, filled when the Canvas mounts. */
export const engine = {
  gl: null as THREE.WebGLRenderer | null,
  canvas: null as HTMLCanvasElement | null,
  paint: null as ScreenPaint | null,
  ripple: null as RippleSim | null,
  chain: null as PostChain | null,
  ready: false,
  /** PRELOAD: the hero's programs are linked; the frame loop runs from here */
  warm: false,
}
;(window as any).__engine = engine
