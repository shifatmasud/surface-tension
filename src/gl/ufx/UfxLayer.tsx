import { useFrame } from '@react-three/fiber'
import { bendUniform, viewHUniform, ufx } from './ufx'
import { props } from '../../state/props'
import { damp } from '../../core/math'

/** Keeps the Ufx layer in step with the frame: the scroll-velocity cylinder bend eases back to flat at rest. */
export function UfxLayer() {
  useFrame(() => {
    viewHUniform.value = ufx.h
    const target = Math.max(-1, Math.min(1, props.scrollVel / 60)) * 0.22
    bendUniform.value = damp(bendUniform.value, target, 5, props.dt)
  }, 0)
  return null
}
