import * as THREE from 'three'
/** Shared state between the Journey DOM section and its GL stage. */
export const journey = {
  active: false,
  /** NEIGHBOUR HOOK: in range, before the clip gate (the neighbour pass draws with it) */
  activeRaw: false,
  /** world-space camera pose the stage writes every frame (the rig blends to it) */
  pose: { pos: new THREE.Vector3(200, 0, 11), target: new THREE.Vector3(200, 0, 0), fov: 35 },
  /** set true to make every spring jump to its target this frame (anchor jumps, stills, harness) */
  snap: false,
  /** the beat currently on screen: 0 space · 1 descent · 2 forest · 3 reveal · 4 break · 5 out */
  beat: -1,
  /** STRUCTURE v2: 0 → 1 as the CTA (the black wall) takes over after the break-out (written by the Contact section) */
  cta: 0,
  /** the crewmate's centre in world space and its scale this frame (written by the timeline; the CTA wall reads it) */
  crew: new THREE.Vector3(200, 0, 0),
  crewScale: 1,
  /** seconds the CTA has been on screen (idle sway of the crewmate) */
  ctaTime: 0,
  /** TEXTROLL: 0 → 1 as the curtain lifts off the footer (written by the Contact section); the CTA lines roll up and out */
  ctaOut: 0,
}
