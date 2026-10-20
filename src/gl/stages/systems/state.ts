import * as THREE from 'three'

/** World placement: far from the lake (origin), so the camera rig cuts here instead of dollying. */
export const SYSTEMS_ORIGIN = new THREE.Vector3(-200, 40, 0)

/** Colour tokens: the chips on the base layer pick one, and every layer above inherits it. */
export const TOKENS = [
  { name: 'Ultramarine', color: '#1f5bff' },
  { name: 'Violet', color: '#7b3dff' },
  { name: 'Coral', color: '#ff5a36' },
] as const

export type ControlId = 'toggle' | 'button' | 'slider' | 'chip0' | 'chip1' | 'chip2'

/**
 * The shared blackboard between the DOM section (real, accessible controls) and the GL stage
 * (the glass that shows them). The DOM owns values; the stage owns motion and writes back where
 * each control sits on screen so the DOM hit areas follow the glass.
 */
export const sys = {
  on: true,              // the toggle (top layer): the light
  level: 0.72,           // the slider (middle layer): light intensity 0..1
  token: 0,              // the chips (base layer): which colour token
  presses: 0,            // button press count (the button "ships" a pulse through the stack)
  press: { toggle: 0, button: 0, slider: 0, chip0: 0, chip1: 0, chip2: 0 } as Record<ControlId, number>, // time of last press
  hover: 0,              // 0..1 pointer over the stack (lifts and separates the layers)
  focus: 0,              // a control has keyboard focus (same as hover)
  open: 0,               // scroll-driven separation 0..1 (written by the section)
  openVis: 0,            // the separation actually shown (scroll, hover, focus; written by the stage) — the camera frames it
  exit: 0,               // 0..1 the hook: dim + tilt toward the dive
  enter: 0,              // 0..1 entry
  weight: 0,             // stage weight (visibility)
  active: false,         // the stage owns the camera
  /** DOM hit areas the stage positions every frame (viewport px) */
  els: {} as Partial<Record<ControlId | 'stack', HTMLElement>>,
  layer: null as HTMLElement | null, // the positioned container (to convert viewport → local)
  reduced: false,
}
;(window as any).__sys = sys
