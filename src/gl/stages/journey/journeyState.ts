import * as THREE from 'three'
/** Shared state between the Journey DOM section and its GL stage. */
export const journey = {
  active: false,
  /** world-space camera pose the stage writes every frame (the rig blends to it) */
  pose: { pos: new THREE.Vector3(200, 0, 11), target: new THREE.Vector3(200, 0, 0), fov: 35 },
  /** set true to make every spring jump to its target this frame (anchor jumps, stills, harness) */
  snap: false,
  /** the beat currently on screen: 0 space · 1 descent · 2 forest · 3 reveal · 4 break · 5 out */
  beat: -1,
}
