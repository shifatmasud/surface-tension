import * as THREE from 'three'
import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { props } from '../../../state/props'
import { journey } from './journeyState'
import { onViewport } from '../../../core/viewport'

/**
 * CTA wall (STRUCTURE v2, Shifat 08:32Z): after the crewmate breaks out of the tablet it lands in front of a plain
 * BLACK wall carrying the huge flat WHITE headline. The wall is a camera-facing plane placed just behind the
 * crewmate (so the 3D figure stands in front of the type) and in front of the tablet and space (so they are covered).
 * The type is drawn from the DOM headline's own line boxes into a texture sampled in screen space, so it lands
 * exactly where the accessible DOM text sits (the DOM text is transparent while this draws it). The wall's top edge
 * is the Contact section's top on screen: it rises with the scroll like a card, no fade, no cut.
 */
export const ctaWall = { top: 1e5, lines: [] as HTMLElement[], dirty: true }
;(window as any).__ctaWall = ctaWall

const vert = /* glsl */ `
varying vec4 vClip;
void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vClip = projectionMatrix * mv; gl_Position = vClip; }`
const frag = /* glsl */ `
uniform sampler2D u_type; uniform float u_top, u_shift; uniform vec2 u_view;
varying vec4 vClip;
void main() {
  vec2 uv = vClip.xy / vClip.w * 0.5 + 0.5;            // screen uv, origin bottom-left
  float y = (1.0 - uv.y) * u_view.y;                   // css px from the top
  if (y < u_top) discard;                              // above the rising edge: the journey shows through
  float a = texture2D(u_type, vec2(uv.x, (y - u_shift) / u_view.y)).a;  // drawn at rest; rides up with the section
  gl_FragColor = vec4(vec3(a), 1.0);                   // flat white type on flat black, no tone, no glow
}`

export function CtaWall() {
  const { camera, scene } = useThree() as { camera: THREE.PerspectiveCamera; scene: THREE.Scene }
  const S = useMemo(() => {
    const canvas = document.createElement('canvas')
    const tex = new THREE.CanvasTexture(canvas)
    tex.flipY = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, depthWrite: true, depthTest: true, toneMapped: false, fog: false,
      uniforms: { u_type: { value: tex }, u_top: { value: 1e5 }, u_shift: { value: 0 }, u_view: { value: new THREE.Vector2(1, 1) } },
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
    mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = -1
    return { canvas, tex, mat, mesh, w: 0, h: 0, fw: '', tmp: new THREE.Vector3(), fwd: new THREE.Vector3() }
  }, [])
  useEffect(() => {
    scene.add(S.mesh)
    const onResize = () => { ctaWall.dirty = true }
    const offVp = onViewport(onResize) // R7.07: real resizes only (not the address bar)
    document.fonts?.ready.then(() => { ctaWall.dirty = true })
    return () => { scene.remove(S.mesh); offVp() }
  }, [scene, S])

  const draw = () => {
    const vw = props.width, vh = props.height, k = Math.min(2, window.devicePixelRatio || 1)
    const W = Math.round(vw * k), H = Math.round(vh * k)
    if (W !== S.canvas.width || H !== S.canvas.height) { S.canvas.width = W; S.canvas.height = H }
    const ctx = S.canvas.getContext('2d')!
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#fff'
    for (const el of ctaWall.lines) {
      const cs = getComputedStyle(el)
      const fs = parseFloat(cs.fontSize), lh = parseFloat(cs.lineHeight) || fs * 0.88
      ctx.font = `400 ${fs * k}px ${cs.fontFamily}`
      ;(ctx as any).letterSpacing = `${(parseFloat(cs.letterSpacing) || 0) * k}px`
      ctx.textBaseline = 'alphabetic'
      // the line box at the section's REST position (pinned, title in place): its live rect minus how far the section
      // still has to rise; the shader adds the live rise back (u_shift)
      const r = el.getBoundingClientRect()
      const base = r.top - Math.max(0, ctaWall.top) + (lh - 1.2109 * fs) / 2 + 0.96875 * fs   // Inter: ascent .96875, descent .2422
      ctx.fillText(el.textContent || '', r.left * k, base * k)
    }
    S.tex.needsUpdate = true
    ctaWall.dirty = false
  }

  useFrame(() => {
    const on = journey.active && journey.cta > 0.001 && ctaWall.lines.length > 0
    S.mesh.visible = on
    if (!on) return
    if (ctaWall.dirty) draw()
    S.mat.uniforms.u_view.value.set(props.width, props.height)
    S.mat.uniforms.u_top.value = Math.max(0, ctaWall.top)
    S.mat.uniforms.u_shift.value = Math.max(0, ctaWall.top)
    journey.ctaTime += props.dt
    // place a frustum-filling plane just behind the crewmate
    const d = Math.max(2, camera.position.distanceTo(journey.crew) + 0.9 * journey.crewScale)
    camera.getWorldDirection(S.fwd)
    S.mesh.position.copy(camera.position).addScaledVector(S.fwd, d)
    S.mesh.quaternion.copy(camera.quaternion)
    const hh = d * Math.tan((camera.fov * Math.PI) / 360)
    S.mesh.scale.set(hh * 2 * camera.aspect * 1.2, hh * 2 * 1.2, 1)
    S.mesh.updateMatrixWorld()
  })
  return null
}
