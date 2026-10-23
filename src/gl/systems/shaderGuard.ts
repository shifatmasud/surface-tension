import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'

/**
 * R6.92 SHADER GUARD (Shifat's Windows log: "useProgram: program not valid" on ANGLE-D3D11 / Intel UHD 600). three already
 * checks every program's link status at its first use (renderer.debug.checkShaderErrors, on by default; without
 * KHR_parallel_shader_compile that link wait is paid at the same moment anyway, so the check costs nothing extra). Here
 * a failed link is named and logged (material/program name + the driver's program and shader logs, as a warning a visitor
 * can paste back to us; window.__shaderFails keeps them), and every mesh in the scene drawing with that program gets a
 * plain stand-in material of its own colour, so one shader the driver refuses costs one object's look, not the frame.
 * QA: ?shaderfail=<substring of a program name> fakes a failure for that program.
 */
type Fail = { name: string; log: string }
const bad = new Set<WebGLProgram>()
let pending = false
const fails: Fail[] = []
;(window as any).__shaderFails = fails
const fake = new URLSearchParams(location.search).get('shaderfail')

export function installShaderGuard(gl: THREE.WebGLRenderer) {
  gl.debug.checkShaderErrors = true
  gl.debug.onShaderError = (ctx: WebGLRenderingContext, program: WebGLProgram, vs: WebGLShader, fs: WebGLShader) => {
    if (ctx.isContextLost()) return   // a dying context fails every link: not a shader's fault (the loss handler takes it)
    const w = (((gl.info as any).programs ?? []) as any[]).find((p) => p.program === program)
    const name = String(w?.name || w?.cacheKey?.slice(0, 40) || 'unknown')
    const log = [ctx.getProgramInfoLog(program), ctx.getShaderInfoLog(vs), ctx.getShaderInfoLog(fs)].map((s) => (s || '').trim()).filter(Boolean).join(' | ').slice(0, 1500)
    fails.push({ name, log }); bad.add(program); pending = true
    console.warn(`[surface-tension] shader failed to link: ${name} · ${gl.getContext().getParameter(gl.getContext().VERSION)} · ${log || '(no driver log)'}`)
  }
}

function standIn(m: THREE.Material) {
  const a = m as any
  const b = new THREE.MeshBasicMaterial({
    color: a.color?.isColor ? a.color.clone() : new THREE.Color('#9aa3ad'),
    map: a.map ?? null, transparent: !!a.transparent, opacity: a.opacity ?? 1, side: a.side ?? THREE.FrontSide,
    depthWrite: a.depthWrite ?? true, depthTest: a.depthTest ?? true, toneMapped: a.toneMapped ?? true,
  })
  b.name = `standin:${m.name || m.type}`
  return b
}

/** Mount once inside the Canvas: swaps materials whose program failed (checked only after a failure was reported). */
export function ShaderGuard() {
  const { gl, scene } = useThree()
  useFrame(() => {
    if (fake && !pending && !(ShaderGuard as any).faked) {
      for (const p of ((gl.info as any).programs ?? []) as any[]) if (String(p.name).includes(fake)) { bad.add(p.program); pending = true; (ShaderGuard as any).faked = true; fails.push({ name: p.name, log: 'faked (?shaderfail)' }); console.warn(`[surface-tension] shader failed to link: ${p.name} · faked`) }
    }
    if (!pending) return
    pending = false
    const swap = new Map<THREE.Material, THREE.Material>()
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.material) return
      const one = (m: THREE.Material) => {
        const p = (gl.properties.get(m) as any)?.currentProgram
        if (!p || !bad.has(p.program)) return m
        if (!swap.has(m)) swap.set(m, standIn(m))
        return swap.get(m)!
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material)
    })
    if (swap.size) console.warn(`[surface-tension] ${swap.size} material(s) drawn with a plain stand-in: ${[...swap.keys()].map((m) => m.name || m.type).join(', ')}`)
  }, -999)
  return null
}
