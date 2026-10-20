import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { MeshTransmissionMaterial } from '@react-three/drei'
import { props } from '../../../state/props'
import { settings } from '../../../services/settings'
import { input } from '../../../services/input'
import { Spring } from '../../../core/spring'
import { clamp, damp } from '../../../core/math'
import { slab } from './geometry'
import { createFloor, createBackdrop } from './shaders'
import { sys, SYSTEMS_ORIGIN, TOKENS, type ControlId } from './state'

/** The backdrop + floor live on this layer too, so the glass can refract them from one cheap buffer. */
export const SYS_LAYER = 5

const W = 2.3, R = 0.42               // tile footprint + corner radius
const H = [0.22, 0.2, 0.26]           // base (tokens), middle (components), top (product)
const ROT_Y = -0.5                    // the stack sits at an angle to the camera, like the reference
const ease = (t: number) => t * t * (3 - 2 * t)

type Ctl = { id: ControlId; layer: number; mesh: THREE.Object3D; w: number; d: number; pos: THREE.Vector3; y: number }

/**
 * S4 — Systems. One star: a small stack of glass tiles — tokens → components → product — that are real UI.
 * The base carries colour-token chips, the middle a button and a slider, the top a toggle. Picking a token
 * re-colours every layer above it; the toggle is the light. Hover/focus lifts and separates the layers.
 */
export function SystemsStage() {
  const { gl, scene, camera, size } = useThree()
  const hi = settings.TIER === 'high' || settings.TIER === 'mid'
  const root = useRef<THREE.Group>(null!)
  const rig = useRef<THREE.Group>(null!)
  const stack = useRef<THREE.Group>(null!)
  const tiles = [useRef<THREE.Group>(null!), useRef<THREE.Group>(null!), useRef<THREE.Group>(null!)]

  const geo = useMemo(() => ({
    tiles: H.map((h) => slab(W, W, h, R, 0.075, hi ? 14 : 8)),
    track: slab(1.12, 0.54, 0.05, 0.27, 0.02),
    knob: slab(0.44, 0.44, 0.16, 0.22, 0.06),
    button: slab(0.86, 0.34, 0.1, 0.17, 0.04),
    sTrack: slab(0.92, 0.08, 0.03, 0.04, 0.012),
    sFill: slab(1, 0.08, 0.034, 0.04, 0.012),
    thumb: slab(0.22, 0.22, 0.1, 0.11, 0.04),
    chip: slab(0.52, 0.22, 0.07, 0.11, 0.03),
  }), [hi])

  const floor = useMemo(createFloor, [])
  const backdrop = useMemo(createBackdrop, [])

  // the glass's view of what is behind it: the stage's own backdrop + spill, rendered once per frame at low res
  const buf = useMemo(() => {
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true })
    const cam = new THREE.PerspectiveCamera()
    return { rt, cam, scale: settings.TIER === 'high' ? 0.5 : 0.35 }
  }, [])
  useEffect(() => {
    buf.rt.setSize(Math.max(4, Math.floor(size.width * props.dpr * buf.scale)), Math.max(4, Math.floor(size.height * props.dpr * buf.scale)))
  }, [size, buf])

  const mats = useMemo(() => {
    const top = new THREE.MeshPhysicalMaterial({ color: '#1f5bff', roughness: 0.1, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, emissive: new THREE.Color('#1f5bff'), emissiveIntensity: 0.2, envMapIntensity: 0.7, sheen: 0.5, sheenRoughness: 0.35, sheenColor: new THREE.Color('#9cc0ff') })
    const white = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 1.0 })
    const track = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.4, transparent: true, opacity: 0.3, depthWrite: false })
    const accent = new THREE.MeshPhysicalMaterial({ color: '#1f5bff', roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.15, emissive: new THREE.Color('#1f5bff'), emissiveIntensity: 0.18 })
    const grey = new THREE.MeshPhysicalMaterial({ color: '#c3c7cd', roughness: 0.5 })
    const chips = TOKENS.map((t) => new THREE.MeshPhysicalMaterial({ color: t.color, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.15, emissive: new THREE.Color(t.color), emissiveIntensity: 0.2, transparent: true }))
    // cheap glass for phones: no transmission pass at all
    const lowMid = new THREE.MeshPhysicalMaterial({ color: '#f4f6fa', roughness: 0.55, transparent: true, opacity: 0.78, clearcoat: 1, clearcoatRoughness: 0.4 })
    const lowBase = new THREE.MeshPhysicalMaterial({ color: '#9db8ff', roughness: 0.15, transparent: true, opacity: 0.55, clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0.4 })
    return { top, white, track, accent, grey, chips, lowMid, lowBase }
  }, [])
  const glass = useRef<{ mid: any; base: any }>({ mid: null, base: null })

  const st = useMemo(() => ({
    accent: new THREE.Color('#1f5bff'), accent2: new THREE.Color('#6fd3ff'), tmpC: new THREE.Color(),
    light: new Spring(1, 0.8, 1, 0),
    open: new Spring(0, 1.1, 0.62, 0),
    knob: new Spring(1, 2.2, 0.48, 0),
    level: new Spring(sys.level, 2.4, 0.8, 0),
    squash: [new Spring(1, 2.3, 0.3, 0), new Spring(1, 2.3, 0.3, 0), new Spring(1, 2.3, 0.3, 0)],
    lift: [new Spring(0, 1.6, 0.55, 0), new Spring(0, 1.6, 0.55, 0), new Spring(0, 1.6, 0.55, 0)],
    press: {} as Record<string, Spring>,
    seen: { toggle: 0, button: 0, slider: 0, chip0: 0, chip1: 0, chip2: 0 } as Record<ControlId, number>,
    pulseAt: -10,
    hoverS: 0,
    v: new THREE.Vector3(), corners: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
    ctls: [] as Ctl[],
    knobMesh: null as THREE.Mesh | null, fill: null as THREE.Mesh | null, thumb: null as THREE.Mesh | null,
    chipMeshes: [] as THREE.Mesh[],
    trackMat: null as THREE.MeshPhysicalMaterial | null,
  }), [])
  ;(['toggle', 'button', 'slider', 'chip0', 'chip1', 'chip2'] as ControlId[]).forEach((k) => { if (!st.press[k]) st.press[k] = new Spring(0, 3, 0.35, 0) })

  // UI parts: positions in each tile's local frame (top face at y = h/2); "front" (+z) faces the camera
  const parts = useMemo(() => {
    const yTop = (i: number) => H[i] / 2
    return {
      toggle: { layer: 2, x: 0, z: 0.05, w: 1.12, d: 0.54, y: yTop(2) },
      button: { layer: 1, x: -0.5, z: 0.55, w: 0.86, d: 0.34, y: yTop(1) },
      slider: { layer: 1, x: 0.55, z: 0.55, w: 0.92, d: 0.34, y: yTop(1) },
      chip0: { layer: 0, x: -0.62, z: 0.72, w: 0.52, d: 0.22, y: yTop(0) },
      chip1: { layer: 0, x: 0, z: 0.72, w: 0.52, d: 0.22, y: yTop(0) },
      chip2: { layer: 0, x: 0.62, z: 0.72, w: 0.52, d: 0.22, y: yTop(0) },
    } as Record<ControlId, { layer: number; x: number; z: number; w: number; d: number; y: number }>
  }, [])

  useFrame((_, dt) => {
    const vis = sys.weight > 0.002 || props.stage === 'systems'
    root.current.visible = vis
    if (!vis) return
    const t = props.time
    const c = camera as THREE.PerspectiveCamera

    // ---- values the DOM owns → motion
    for (const k of Object.keys(st.seen) as ControlId[]) {
      if (sys.press[k] !== st.seen[k]) {
        st.seen[k] = sys.press[k]
        const p = parts[k]
        st.squash[p.layer].velocity -= k === 'button' ? 3.2 : 2.2
        st.press[k].velocity -= 1.6
        if (k === 'button') { st.pulseAt = t; for (let i = 0; i < 3; i++) st.lift[i].velocity += 1.4 + i * 0.5 }
      }
    }
    const pointerOver = input.everMoved && !input.isTouch && st.hoverS > 0
    const openT = clamp(Math.max(sys.open * 0.62, sys.focus, pointerOver ? 1 : 0) * (1 - sys.exit))
    const open = st.open.update(openT, dt)
    sys.openVis = clamp(open, 0, 1.2)
    const lightT = (sys.on ? 0.3 + 0.7 * sys.level : 0.06) * (1 - sys.exit * 0.85)
    const light = clamp(st.light.update(lightT, dt), 0, 1.2)
    const level = st.level.update(sys.level, dt)
    const knob = st.knob.update(sys.on && sys.exit < 0.45 ? 1 : 0, dt)
    st.tmpC.set(TOKENS[sys.token].color)
    st.accent.lerp(st.tmpC, 1 - Math.exp(-5 * dt))
    st.accent2.copy(st.accent).offsetHSL(-0.08, 0.1, 0.25)

    // ---- the stack: rests closed (the reference frame); opens into a staircase so every layer's face shows
    const enter = ease(clamp(sys.enter))
    // the hook: the light goes out (the toggle flips itself off), the surface tilts up toward us and we push in
    const ex = ease(sys.exit)
    rig.current.rotation.x = ex * 0.38
    rig.current.position.y = ex * 0.25
    const breathe = sys.reduced ? 0 : Math.sin(t * 0.9) * 0.035
    stack.current.position.y = 0.42 + breathe + (1 - enter) * -0.5 + ex * 0.15
    stack.current.rotation.y = ROT_Y + (1 - enter) * 0.25 + (sys.reduced ? 0 : Math.sin(t * 0.21) * 0.025)
    const gap = 0.05 + open * 0.62
    const slide = open * 0.55
    let y = 0
    for (let i = 0; i < 3; i++) {
      const g = tiles[i].current
      const sq = st.squash[i].update(1, dt)
      const lift = st.lift[i].update(0, dt)
      const stagger = clamp(enter * 1.6 - i * 0.3)
      g.position.set(0, y + H[i] / 2 + lift * 0.12 + (1 - ease(stagger)) * (0.8 + i * 0.5), -i * slide)
      g.scale.set(1 + (1 - sq) * 0.35, sq, 1 + (1 - sq) * 0.35)
      y += H[i] + gap
    }
    // parts
    if (st.knobMesh) { st.knobMesh.position.x = parts.toggle.x - 0.29 + knob * 0.58; st.knobMesh.position.y = parts.toggle.y + 0.07 + st.press.toggle.update(0, dt) * 0.06; st.knobMesh.scale.set(1 + Math.abs(st.knob.velocity) * 0.05, 1, 1) }
    if (st.trackMat) { const lit = sys.on && sys.exit < 0.45; st.trackMat.color.set(lit ? '#ffffff' : '#0a0a0b'); st.trackMat.opacity = lit ? 0.34 : 0.22 }
    if (st.fill) { const lv = clamp(level); st.fill.scale.x = Math.max(0.08, lv * 0.92); st.fill.position.x = parts.slider.x - 0.46 + Math.max(0.08, lv * 0.92) / 2 }
    if (st.thumb) { st.thumb.position.x = parts.slider.x - 0.46 + clamp(level) * 0.92; st.thumb.position.y = parts.slider.y + 0.05 + st.press.slider.update(0, dt) * 0.05 }
    st.chipMeshes.forEach((m, i) => {
      const sel = sys.token === i ? 1 : 0
      const k = ('chip' + i) as ControlId
      m.position.y = parts[k].y + 0.035 + sel * 0.04 + st.press[k].update(0, dt) * 0.05
      ;(m.material as THREE.MeshPhysicalMaterial).opacity = damp((m.material as THREE.MeshPhysicalMaterial).opacity, sel ? 1 : 0.5, 8, dt)
    })
    const bp = st.press.button.update(0, dt)
    const btn = st.ctls.find((q) => q.id === 'button')
    if (btn) { btn.mesh.position.y = parts.button.y + 0.05 + bp * 0.05; btn.mesh.scale.set(1 - bp * 0.4, 1 + bp * 0.6, 1 - bp * 0.4) }

    // ---- colour & light
    // beauty pass: a deeper body + crisp reflections reads as glossy ultramarine (the reference), not flat periwinkle
    mats.top.color.copy(st.accent).multiplyScalar(0.62); mats.top.emissive.copy(st.accent); mats.top.emissiveIntensity = 0.02 + 0.17 * light
    mats.accent.color.copy(st.accent); mats.accent.emissive.copy(st.accent); mats.accent.emissiveIntensity = 0.05 + 0.2 * light
    mats.top.envMapIntensity = 0.45 + 0.4 * light
    if (glass.current.base) { glass.current.base.attenuationColor?.copy?.(st.tmpC.copy(st.accent).lerp(new THREE.Color(1, 1, 1), 0.35)); glass.current.base.color?.copy?.(st.tmpC.copy(st.accent).lerp(new THREE.Color(1, 1, 1), 0.72)) }
    if (!hi) mats.lowBase.color.copy(st.accent).lerp(new THREE.Color(1, 1, 1), 0.45)
    floor.uniforms.uAccent.value.copy(st.accent)
    floor.uniforms.uAccent2.value.copy(st.accent2)
    floor.uniforms.uLight.value = light
    floor.uniforms.uPulse.value = t - st.pulseAt < 3 ? t - st.pulseAt : -1
    floor.uniforms.uRot.value = -stack.current.rotation.y
    floor.uniforms.uPaper.value.copy(props.look.bg)
    backdrop.uniforms.uBg.value.copy(props.look.bg)

    // ---- DOM hit areas follow the glass (viewport px → the layer's local px)
    root.current.updateMatrixWorld()
    const layerTop = sys.layer ? sys.layer.getBoundingClientRect().top : 0
    const W2 = props.width / 2, H2 = props.height / 2
    let sx0 = 1e9, sy0 = 1e9, sx1 = -1e9, sy1 = -1e9
    const project = (obj: THREE.Object3D, x: number, yv: number, z: number, w: number, d: number) => {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
      const cs = st.corners
      cs[0].set(x - w / 2, yv, z - d / 2); cs[1].set(x + w / 2, yv, z - d / 2); cs[2].set(x + w / 2, yv, z + d / 2); cs[3].set(x - w / 2, yv, z + d / 2)
      for (const p of cs) {
        st.v.copy(p).applyMatrix4(obj.matrixWorld).project(c)
        const px = (st.v.x + 1) * W2, py = (1 - st.v.y) * H2
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py)
      }
      return [x0, y0, x1, y1]
    }
    for (let i = 0; i < 3; i++) {
      const [a, b, cc, d] = project(tiles[i].current, 0, H[i] / 2, 0, W, W)
      sx0 = Math.min(sx0, a); sy0 = Math.min(sy0, b); sx1 = Math.max(sx1, cc); sy1 = Math.max(sy1, d)
    }
    const mx = input.mousePixelXY.x, my = input.mousePixelXY.y
    const over = mx > sx0 - 20 && mx < sx1 + 20 && my > sy0 - 20 && my < sy1 + 40
    st.hoverS = over ? 1 : 0
    sys.hover = damp(sys.hover, over ? 1 : 0, 6, dt)
    for (const k of Object.keys(parts) as ControlId[]) {
      const el = sys.els[k]; if (!el) continue
      const p = parts[k]
      const [a, b, cc, d] = project(tiles[p.layer].current, p.x, p.y + 0.06, p.z, p.w, p.d)
      // at least a 44 px target (WCAG / Fitts), centred on the part
      const ww = Math.max(44, cc - a + 12), hh = Math.max(44, d - b + 12)
      const cx = (a + cc) / 2, cy = (b + d) / 2
      el.style.transform = `translate3d(${(cx - ww / 2).toFixed(1)}px, ${(cy - hh / 2 - layerTop).toFixed(1)}px, 0)`
      el.style.width = `${ww.toFixed(1)}px`; el.style.height = `${hh.toFixed(1)}px`
    }
    const se = sys.els.stack
    if (se) { se.style.transform = `translate3d(${sx0.toFixed(1)}px, ${(sy0 - layerTop).toFixed(1)}px, 0)`; se.style.width = `${(sx1 - sx0).toFixed(1)}px`; se.style.height = `${(sy1 - sy0).toFixed(1)}px` }

    // ---- the glass's buffer: just this stage's backdrop + spill, from the main camera
    if (hi) {
      const bc = buf.cam
      bc.copy(c, false); bc.layers.set(SYS_LAYER)
      bc.updateMatrixWorld()
      const prevRT = gl.getRenderTarget(), prevA = gl.getClearAlpha(), cc = new THREE.Color(); gl.getClearColor(cc)
      const bg = scene.background
      scene.background = null
      gl.setRenderTarget(buf.rt); gl.setClearColor(props.look.bg, 1); gl.clear(true, true, false)
      gl.render(scene, bc)
      scene.background = bg
      gl.setRenderTarget(prevRT); gl.setClearColor(cc, prevA)
    }
  })

  const onLayer = (o: THREE.Object3D) => o.layers.enable(SYS_LAYER)
  const reg = (id: ControlId, layer: number) => (m: THREE.Object3D | null) => {
    if (!m) return
    if (!st.ctls.find((q) => q.id === id)) st.ctls.push({ id, layer, mesh: m, w: 0, d: 0, pos: m.position.clone(), y: m.position.y })
  }
  const P = parts

  return (
    <group ref={root} position={SYSTEMS_ORIGIN} visible={false}>
      <mesh material={backdrop.material} onUpdate={onLayer} renderOrder={-10} frustumCulled={false}>
        <sphereGeometry args={[60, 32, 16]} />
      </mesh>
      <group ref={rig}>
        <mesh material={floor.material} rotation-x={-Math.PI / 2} onUpdate={onLayer} renderOrder={-5}>
          <planeGeometry args={[60, 60]} />
        </mesh>
        <group ref={stack}>
          {/* base: tokens — clear tinted glass carrying the colour chips */}
          <group ref={tiles[0]}>
            <mesh geometry={geo.tiles[0]} material={hi ? undefined : mats.lowBase}>
              {hi && <MeshTransmissionMaterial ref={(m: any) => (glass.current.base = m)} buffer={buf.rt.texture} resolution={32} samples={settings.TIER === 'high' ? 8 : 5}
                transmission={1} thickness={0.9} roughness={0.06} ior={1.45} chromaticAberration={0.06} anisotropicBlur={0.08} distortion={0.05} distortionScale={0.4} temporalDistortion={0}
                color="#d6e2ff" attenuationColor="#8fb0ff" attenuationDistance={1.4} clearcoat={1} clearcoatRoughness={0.05} envMapIntensity={1} />}
            </mesh>
            {[0, 1, 2].map((i) => (
              <mesh key={i} geometry={geo.chip} material={mats.chips[i]} position={[P[('chip' + i) as ControlId].x, P.chip0.y + 0.035, P.chip0.z]}
                ref={(m) => { if (m && !st.chipMeshes[i]) st.chipMeshes[i] = m }} />
            ))}
          </group>
          {/* middle: components — frosted glass with a button and a slider */}
          <group ref={tiles[1]}>
            <mesh geometry={geo.tiles[1]} material={hi ? undefined : mats.lowMid}>
              {hi && <MeshTransmissionMaterial ref={(m: any) => (glass.current.mid = m)} buffer={buf.rt.texture} resolution={32} samples={settings.TIER === 'high' ? 8 : 5}
                transmission={1} thickness={0.7} roughness={0.4} ior={1.3} chromaticAberration={0.03} anisotropicBlur={0.3} distortion={0.1} distortionScale={0.5} temporalDistortion={0}
                color="#ffffff" clearcoat={1} clearcoatRoughness={0.35} envMapIntensity={0.9} />}
            </mesh>
            <mesh geometry={geo.button} material={mats.accent} position={[P.button.x, P.button.y + 0.05, P.button.z]} ref={reg('button', 1)} />
            <mesh geometry={geo.sTrack} material={mats.grey} position={[P.slider.x, P.slider.y + 0.015, P.slider.z]} />
            <mesh geometry={geo.sFill} material={mats.accent} position={[P.slider.x, P.slider.y + 0.02, P.slider.z]} ref={(m) => { if (m) st.fill = m }} />
            <mesh geometry={geo.thumb} material={mats.white} position={[P.slider.x, P.slider.y + 0.05, P.slider.z]} ref={(m) => { if (m) st.thumb = m }} />
          </group>
          {/* top: product — the vivid tile, and the toggle that is the light */}
          <group ref={tiles[2]}>
            <mesh geometry={geo.tiles[2]} material={mats.top} />
            <mesh geometry={geo.track} material={mats.track} position={[P.toggle.x, P.toggle.y + 0.018, P.toggle.z]} ref={(m) => { if (m) st.trackMat = m.material as THREE.MeshPhysicalMaterial }} />
            <mesh geometry={geo.knob} material={mats.white} position={[P.toggle.x + 0.29, P.toggle.y + 0.07, P.toggle.z]} ref={(m) => { if (m) st.knobMesh = m }} />
          </group>
        </group>
      </group>
    </group>
  )
}
