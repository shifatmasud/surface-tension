import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { props } from '../../../state/props'
import { browser } from '../../../services/settings'
import { portrait } from '../../../core/frame'
import { nb, useStageFrame } from '../../systems/neighbour' // NEIGHBOUR HOOK
import { input } from '../../../services/input'
import { SYSUI_LAYER } from '../hero/HeroStage'
import { dive, SYS_C, TAB_F, sysLift, DIVE_LAYER, TAB_DEEP, PORTAL0, tabletUpright } from './diveState'
import { sys, type ControlId } from '../systems/state' // W20: the Shade DS keyboard proxies (dom/sections/Systems.tsx)
import { AtomField } from './Atom'
import { Disintegrate, DIS_COUNTS, DIS_GLSL, type DisSource } from './disintegrate' // R6.88 SINK: one particle-morph for the parts and the diamond
import { brilliantGeometry } from '../hero/diamond'
import { gemRef } from '../hero/HeroStage'
import { prewarm, runToEnd } from '../../prewarm' // PERFGOV
import { pmremFromSceneSteps } from '../../core/pmremSteps' // R6.77
import { crewGeometrySteps } from '../journey/crewmate' // PERFGOV
import { TabletWindow, IPAD_GLASS, IPAD_T, WIN_HW, WIN_HH } from '../journey/tabletWindow'; import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js' // TABLET HOOK: the live 3D window (journey/tabletWindow.ts)
/** QA: ?atom holds the sequence at the atom, ?drum at the drum; window.__morph (0..1) pins it */
const KEEP_EYE = new THREE.Vector3(0, 0, -1e3), KEEP_F = new THREE.Vector3(0, 0, 1), KEEP_V = new THREE.Vector3() // POLISH-2: the main lens, for the ring's keep-out
const DIS_SCL = new THREE.Matrix4(), DIS_TOF = new THREE.Matrix4() // R6.88 SINK scratch
const STONE_D = new THREE.Vector3() // W20: the eye→stone direction (phones' stone keep-out)
const BAND_P = new THREE.Vector3() // W21: a part's world point, for the wide-screen text band keep-out
let BAND_TOP = 0, BAND_AT = 0
/** W21: the top of the text slot (SYSTEMS, title, caption) in css px, minus a little air; read at most every 250 ms */
function bandTop() {
  const now = performance.now()
  if (now > BAND_AT) {
    BAND_AT = now + 250
    const b = document.querySelector('.slot .slot__beat[data-beat="systems"]') as HTMLElement | null  // the drum only plays under this beat
    const rc = b?.getBoundingClientRect()
    BAND_TOP = rc && rc.height > 0 ? rc.top - 16 : props.height * 0.66
  }
  return BAND_TOP
}
const KB_V = new THREE.Vector3(), KB_CORNERS: [number, number][] = [[-1.05, -0.42], [1.05, -0.42], [1.05, 0.42], [-1.05, 0.42]] // W20: a part's face, for the keyboard proxy box
const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const QS = typeof location !== 'undefined' ? location.search : ''
// QA: ?drumlift=<m> tries another phone drum lift
const DRUM_LIFT = (() => { const m = /[?&]drumlift=([\d.]+)/.exec(QS); return m ? +m[1] : 0 })()
const HOLD = /[?&]atom/.test(QS) ? 0 : /[?&]drum/.test(QS) ? 1 : -1
// QA (R6.88): ?drumoff=<rad> turns the drum by a fixed angle, to put a chosen part in front of the stone
const ORBIT_TILT = 0.6
const DRUM_OFF = (() => { const m = /[?&]drumoff=(-?[\d.]+)/.exec(QS); return m ? +m[1] : 0 })()

/**
 * v3 Systems (Shifat 11:41Z–12:00Z): the stone at the axis of a vertical CYLINDER of solid 3D Shade DS parts —
 * buttons, toggles, sliders, inputs, cards, chips, a type specimen, checkbox, segmented control, avatar, progress
 * ring, badge — turning slowly with the scroll, deep in the same water as the work. No hologram.
 * Materials = his favourites (checklist 08:04Z): iridescent liquid glass, glossy plastic and metal, thin-film
 * fringes; colour direction black / white / silver (12:00Z), the iridescence supplies the subtle colour. They sit IN
 * the water: lit from above by the last light, and they take the deep's exponential fog (shaders.ts deepFog).
 * They are on SYSUI_LAYER, which the stone's env capture also sees, so the stone refracts the parts around it.
 * Same pieces on every tier.
 */
const FOG_GLSL = /* glsl */ `
uniform float u_amb, u_abyss, u_sinkK;
varying vec3 vDW;
vec3 deepWaterC(vec3 dir){
  float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(vec3(0.002, 0.012, 0.028), vec3(0.008, 0.055, 0.105), smoothstep(0.0, 0.55, up));
  c = mix(c, vec3(0.030, 0.150, 0.230), smoothstep(0.5, 1.0, up));
  c += vec3(0.020, 0.110, 0.150) * pow(up, 6.0);
  return c * (1.0 - 0.3 * u_abyss) * (1.0 - 0.72 * u_sinkK);
}
float deepFogC(float dist){ float d = mix(0.028, 0.052, u_abyss) * dist; return 1.0 - exp(-d * d); }
`
/** R6.88 SINK: the parts' dissolve (disintegrate.ts): k 0..1 and world → drum space (the front sweeps the drum, not the screen) */
export const DIS_U = { u_disK: { value: 0 }, u_toDrum: { value: new THREE.Matrix4() } }
function deepFogPatch(m: THREE.Material, u: Record<string, THREE.IUniform>, dis = true) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.u_amb = u.u_amb; sh.uniforms.u_abyss = u.u_abyss; sh.uniforms.u_sinkK = u.u_sinkK
    if (dis) { sh.uniforms.u_disK = DIS_U.u_disK; sh.uniforms.u_toDrum = DIS_U.u_toDrum }
    sh.vertexShader = 'varying vec3 vDW;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vDW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    sh.fragmentShader = '#define PART_FOG 0.6\n' + FOG_GLSL + (dis ? 'uniform float u_disK; uniform mat4 u_toDrum;\n' + DIS_GLSL : '') + sh.fragmentShader.replace('#include <fog_fragment>', `{
      vec3 dv = vDW - cameraPosition; float dd = length(dv);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, deepWaterC(dv / dd) * gl_FragColor.a, deepFogC(dd) * u_amb * PART_FOG);
    }` + (dis ? `
    if (u_disK > 0.0) {
      float disR = disRaw(u_disK, disFUi((u_toDrum * vec4(vDW, 1.0)).xyz));
      if (disR >= 0.0) discard;
      gl_FragColor.rgb += disEmber(disR) * gl_FragColor.a;
    }` : ''))
  }
  m.customProgramCacheKey = () => (dis ? 'deepfogpart2' : 'deepfogtab')
  return m
}
let fogU: Record<string, THREE.IUniform> | null = null // R6.88: the tablet's own (non-dissolving) patch reads the same fog

type Mats = ReturnType<typeof makeMats>
/**
 * The deep's own reflection world for the parts: a dark water sphere, the bright disc of the surface far overhead,
 * three tall soft light strips and a ring. Black plastic then reads black with long crisp highlights and the metal
 * reads as metal (the site's grey studio env made every material the same flat grey down here).
 */
function* deepEnv(gl: THREE.WebGLRenderer) {
  const s = new THREE.Scene()
  s.add(new THREE.Mesh(new THREE.SphereGeometry(20, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vP; void main(){
      float y = vP.y;
      // W17: neutral (it was deep cyan: every part read blue-grey). The water's colour comes from the fog; the
      // reflections are true black / white / silver, and the thin film supplies the only colour
      vec3 c = mix(vec3(0.006, 0.007, 0.009), vec3(0.055, 0.065, 0.075), smoothstep(-0.4, 0.6, y));
      c += vec3(2.3, 2.35, 2.4) * smoothstep(0.86, 0.97, y);        // the surface window, far overhead
      c += vec3(0.22, 0.25, 0.28) * pow(max(y, 0.0), 3.0);
      gl_FragColor = vec4(c, 1.0); }`,
  })))
  const strip = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 3.0, 3.0), side: THREE.DoubleSide })
  const soft = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.05, 1.05, 1.1), side: THREE.DoubleSide })
  for (const [a, w, m] of [[0.6, 0.5, strip], [2.5, 0.35, strip], [4.3, 1.6, soft]] as [number, number, THREE.Material][]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, 16), m)
    p.position.set(Math.cos(a) * 12, 2, Math.sin(a) * 12); p.lookAt(0, 2, 0); s.add(p)
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(3, 0.25, 8, 48), strip)
  ring.position.set(4, 9, 6); ring.lookAt(0, 0, 0); s.add(ring)
  // a broad white softbox in front and above: long clean highlights across black gloss, a bright face on white
  const box = new THREE.Mesh(new THREE.PlaneGeometry(9, 3.2), soft)
  box.position.set(0, 7, 10); box.lookAt(0, 0, 0); s.add(box)
  const pm = new THREE.PMREMGenerator(gl)
  const rt = yield* pmremFromSceneSteps(gl, pm, s, 0.02) // R6.77: = pm.fromScene(s, 0.02), one GPU pass per step
  pm.dispose()
  s.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose() } })
  return rt
}


function makeMats(u: Record<string, THREE.IUniform>, env: THREE.Texture) {
  const film = { iridescenceIOR: 1.4, iridescenceThicknessRange: [160, 760] as [number, number] }
  const m = {
    // liquid glass: clear, bright edges, a thin-film rainbow across it
    glass: new THREE.MeshPhysicalMaterial({ color: '#eef5ff', roughness: 0.03, metalness: 0, transparent: true, opacity: 0.34, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 1, ...film, envMapIntensity: 2.4, specularIntensity: 1, depthWrite: false }),
    black: new THREE.MeshPhysicalMaterial({ color: '#040405', roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 0.85, iridescenceIOR: 1.45, iridescenceThicknessRange: [280, 900], envMapIntensity: 1.5 }),
    white: new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.04, iridescence: 0.5, ...film, envMapIntensity: 1.25, emissive: '#ffffff', emissiveIntensity: 0.07 }),
    silver: new THREE.MeshPhysicalMaterial({ color: '#eef0f3', metalness: 1, roughness: 0.08, iridescence: 0.9, iridescenceIOR: 1.7, iridescenceThicknessRange: [240, 820], envMapIntensity: 2.2 }),
  }
  fogU = u
  Object.values(m).forEach((x) => { x.envMap = env; deepFogPatch(x, u) })
  return m
}

/** crisp text on a part's face (canvas texture, Inter) */
function label(text: string, h: number, color: string, u: Record<string, THREE.IUniform>, weight = 500, opacity = 1) {
  const fs = 96, pad = 16
  const c = document.createElement('canvas'), ctx = c.getContext('2d')!
  const font = `${weight} ${fs}px Inter, "Helvetica Neue", Arial, sans-serif`
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2
  c.width = w; c.height = 128
  ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'middle'
  ctx.fillText(text, pad, 66)
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4
  const mat = deepFogPatch(new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false }), u)
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(h * (w / 128), h), mat)
  return mesh
}

/** Shifat 13:04Z: "Ensure each ui looks flat in 3d. No need bevel, emboss. Only 3d material." Every part is a FLAT slab:
 *  a rounded-rect outline (the UI's own corner radius, in plan) extruded THIN with no bevel. Depth reads from the
 *  materials alone (iridescent glass, gloss black / white, silver metal). Geometries are cached by size. */
const T_SLAB = 0.028
const geoCache = new Map<string, THREE.BufferGeometry>()
function rrShape(w: number, h: number, r: number, s = new THREE.Shape()) {
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4)
  const x = -w / 2, y = -h / 2
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false)
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false)
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false)
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false)
  return s
}
function extrude(key: string, shape: () => THREE.Shape, d = T_SLAB) {
  let g = geoCache.get(key)
  if (!g) { g = new THREE.ExtrudeGeometry(shape(), { depth: d, bevelEnabled: false, curveSegments: 12 }); g.translate(0, 0, -d / 2); geoCache.set(key, g) }
  return g
}
const flat = (w: number, h: number, r: number, d = T_SLAB) => extrude(`r${w}|${h}|${r}|${d}`, () => rrShape(w, h, r), d)
const disc = (r: number, d = T_SLAB) => extrude(`d${r}|${d}`, () => { const s = new THREE.Shape(); s.absarc(0, 0, r, 0, Math.PI * 2, false); return s }, d)
const ring = (r: number, w: number, arc = 1, d = T_SLAB) => extrude(`a${r}|${w}|${arc}|${d}`, () => {
  const s = new THREE.Shape(), a1 = Math.PI * 2 * arc
  if (arc >= 1) { s.absarc(0, 0, r + w / 2, 0, a1, false); const hole = new THREE.Path(); hole.absarc(0, 0, r - w / 2, 0, a1, true); s.holes.push(hole) }
  else { s.absarc(0, 0, r + w / 2, 0, a1, false); s.absarc(0, 0, r - w / 2, a1, 0, true) }
  return s
}, d)

type Kind = 'button' | 'toggle' | 'slider' | 'input' | 'card' | 'chip' | 'type' | 'checkbox' | 'segmented' | 'avatar' | 'progress' | 'badge'
function piece(kind: Kind, M: Mats, u: Record<string, THREE.IUniform>, alt: number) {
  const g = new THREE.Group()
  // W17: what a tap does to this part (toggles flip, sliders move, checkboxes tick, the segmented pill slides)
  const A: Record<string, any> = { kind }
  g.userData.act = A
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); g.add(o); return o }
  const put = (o: THREE.Object3D, x: number, y: number, z: number) => { o.position.set(x, y, z); g.add(o); return o }
  const F = T_SLAB / 2 + 0.004            // just above a slab's face
  switch (kind) {
    case 'button': {
      const dark = alt % 2 === 0
      add(flat(1.3, 0.44, 0.22), dark ? M.black : M.white)
      put(label(alt % 3 === 0 ? 'Ship it' : 'Continue', 0.19, dark ? '#ffffff' : '#0a0a0b', u, 500), 0, 0, F)
      break
    }
    case 'toggle': {
      const on = alt % 2 === 0
      add(flat(0.9, 0.46, 0.23), on ? M.black : M.glass)
      const k = add(disc(0.17), M.silver, on ? 0.22 : -0.22, 0, T_SLAB)
      A.on = on; A.knob = k; A.track = g.children[0] as THREE.Mesh; A.mOn = M.black; A.mOff = M.glass
      break
    }
    case 'slider': {
      add(flat(1.6, 0.1, 0.05), M.glass)
      const v = 0.35 + 0.4 * ((alt * 0.37) % 1)
      const fill = add(flat(1, 0.1, 0.05), M.white, -0.8 + 0.8 * v, 0, 0.006); fill.scale.x = 1.6 * v
      const t = add(disc(0.15), M.silver, -0.8 + 1.6 * v, 0, T_SLAB)
      put(label(`${Math.round(v * 100)}%`, 0.15, '#ffffff', u, 500, 0.9), -0.66, 0.26, 0)
      A.v = v; A.vT = v; A.fill = fill; A.thumb = t; A.L = 1.6
      break
    }
    case 'input': {
      add(flat(1.6, 0.46, 0.12), M.glass)
      put(label(alt % 2 ? 'Search tokens' : 'you@studio.com', 0.16, '#e4e9ee', u, 400, 0.9), -0.18, 0, F)
      add(flat(0.018, 0.22, 0.004), M.white, 0.6, 0, F)
      break
    }
    case 'card': {
      add(flat(1.15, 1.4, 0.1), M.glass)
      add(flat(0.95, 0.6, 0.06), alt % 2 ? M.white : M.black, 0, 0.29, F)
      add(disc(0.11), M.silver, alt % 2 ? -0.24 : 0.24, 0.33, F + T_SLAB)
      put(label('Shade DS', 0.15, '#ffffff', u, 600), -0.13, -0.2, F)
      put(label(alt % 2 ? 'Tokens · v2.4' : 'Motion · 12 specs', 0.11, '#d2d9e0', u, 400, 0.9), -0.11, -0.38, F)
      add(flat(0.38, 0.15, 0.075), M.white, 0.25, -0.56, F)
      break
    }
    case 'chip': {
      const dark = alt % 2 === 1
      add(flat(0.8, 0.3, 0.15), dark ? M.black : M.white)
      put(label(['Primary', 'Neutral', 'Accent'][alt % 3], 0.13, dark ? '#ffffff' : '#0a0a0b', u, 500), 0, 0, F)
      break
    }
    case 'type': {
      add(flat(1.0, 1.0, 0.1), M.silver)
      put(label('Aa', 0.5, '#0b0c0e', u, 400), 0, 0.06, F)
      put(label('Inter 400', 0.09, '#2a2d33', u, 500, 0.9), 0, -0.32, F)
      break
    }
    case 'checkbox': {
      add(flat(0.38, 0.38, 0.08), M.black, -0.34, 0, 0)
      A.check = put(label('✓', 0.26, '#ffffff', u, 600), -0.34, 0, F); A.on = true
      put(label('Remember', 0.15, '#ffffff', u, 400, 0.9), 0.24, 0, 0)
      break
    }
    case 'segmented': {
      add(flat(1.5, 0.42, 0.21), M.glass)
      const i = alt % 3
      A.pill = add(flat(0.48, 0.34, 0.17), M.white, -0.49 + 0.49 * i, 0, F - 0.006); A.i = i
      A.labs = ['Day', 'Week', 'Month'].map((t, j) => [put(label(t, 0.13, '#0a0a0b', u, 500), -0.49 + 0.49 * j, 0, F + T_SLAB), put(label(t, 0.13, '#e9eef3', u, 500), -0.49 + 0.49 * j, 0, F + T_SLAB)])
      A.labs.forEach(([d, l]: THREE.Object3D[], j: number) => { d.visible = j === i; l.visible = j !== i })
      A.step = 0.49
      break
    }
    case 'avatar': {
      add(disc(0.32), alt % 2 ? M.black : M.silver)
      add(ring(0.41, 0.04), M.glass)
      put(label('SM', 0.21, alt % 2 ? '#ffffff' : '#0a0a0b', u, 600), 0, 0, F)
      break
    }
    case 'progress': {
      add(ring(0.36, 0.05), M.glass)
      const a = add(ring(0.36, 0.08, 0.72, T_SLAB * 1.4), M.silver); a.rotation.z = Math.PI / 2
      put(label('72', 0.25, '#ffffff', u, 500), 0, 0, 0)
      break
    }
    case 'badge': {
      add(flat(0.66, 0.28, 0.14), alt % 2 ? M.white : M.black)
      put(label('New', 0.13, alt % 2 ? '#0a0a0b' : '#ffffff', u, 600), 0.07, 0, F)
      add(disc(0.045), M.silver, -0.19, 0, F)
      break
    }
  }
  return g
}

/** W17 SCENE 3 ENTRY: the tablet INSIDE the stone (STRUCTURE v3: "a tablet is seen through inside the stone, then the
 *  camera goes into the stone, then into the tablet, where the display shows the starry sky + the crewmate").
 *  It sits just behind the stone's centre, smaller than the stone's silhouette from every camera on the path, so you only
 *  ever see it THROUGH the stone: it is on SYSUI_LAYER, which the stone's env capture sees and refracts into its facets.
 *  Its screen is the journey's opening in miniature: deep space, stars, a faint nebula, the little red crewmate drifting. */
const TAB_FRAG = /* glsl */ `
uniform float u_time, u_on, u_sweep, u_portrait, u_fill;
varying vec2 vUv;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main(){
  vec2 uv = vUv;
  // W18: the same night the journey opens on (near-black space, a faint cool band of stars) so the hand-off is one push
  vec3 c = mix(vec3(0.004, 0.005, 0.012), vec3(0.010, 0.012, 0.026), smoothstep(0.0, 1.0, uv.y));
  c += vec3(0.035, 0.045, 0.08) * exp(-pow((uv.y - 0.25 - uv.x * 0.6) * 4.0, 2.0)) * 0.6;
  for (int L = 0; L < 3; L++) {
    float s = 40.0 + float(L) * 38.0;
    vec2 g = uv * vec2(s * 1.45, s) + float(L) * 7.1; vec2 id = floor(g), f = fract(g) - 0.5;
    float r = h21(id); float tw = 0.6 + 0.4 * sin(u_time * (1.0 + r * 3.0) + r * 40.0);
    c += vec3(0.9, 0.95, 1.0) * step(0.93, r) * smoothstep(0.12, 0.0, length(f + (vec2(h21(id + 3.1), h21(id + 7.7)) - 0.5) * 0.6)) * tw * (1.2 - float(L) * 0.3);
  }
  // the crewmate, small, drifting (body, backpack, visor)
  // where the journey's crewmate sits at its first frame: the left third on wide screens, centred on phones
  vec2 p = (uv - vec2(mix(0.417, 0.5, u_portrait) + 0.008 * sin(u_time * 0.4), 0.5 + 0.01 * sin(u_time * 0.55))) * vec2(1.5, 1.0) * mix(9.1, 6.5, u_portrait);
  float a = 0.25 * sin(u_time * 0.3); p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
  float body = min(sdBox(p, vec2(0.42, 0.62), 0.38), sdBox(p - vec2(-0.5, 0.0), vec2(0.16, 0.36), 0.14));
  float legs = sdBox(p - vec2(0.0, -0.66), vec2(0.4, 0.2), 0.12);
  float b2 = min(body, legs);
  vec3 red = vec3(0.86, 0.09, 0.08) * (0.65 + 0.35 * smoothstep(-0.6, 0.6, p.x + p.y));
  c = mix(c, red, smoothstep(0.03, -0.03, b2));
  float vis = sdBox(p - vec2(0.17, 0.2), vec2(0.27, 0.15), 0.14);
  c = mix(c, mix(vec3(0.55, 0.8, 0.95), vec3(0.95), smoothstep(0.1, 0.25, p.y - 0.12)), smoothstep(0.03, -0.03, vis));
  // bezel + glass
  float bez = sdBox(uv - 0.5, vec2(0.5), 0.06);
  float scr = sdBox(uv - 0.5, vec2(0.46, 0.44), 0.035);
  c = mix(vec3(0.012), c, smoothstep(0.004, -0.004, scr));
  c += vec3(0.08) * smoothstep(0.35, 0.0, abs(uv.x + uv.y - 1.1)) * step(scr, 0.0) * (1.0 - u_fill);  // the glass sheen clears as the screen fills the frame
  // the stone's caustic light passes across the glass (the light hand-off)
  float sw = exp(-pow((uv.x + uv.y * 0.35 - u_sweep) * 7.0, 2.0));
  c += vec3(0.55, 0.75, 1.0) * sw * 0.32 * (1.0 - u_fill);
  gl_FragColor = vec4(c * mix(0.35 + 1.4 * u_on, 1.0, u_fill), 1.0);
}`
function makeTablet(M: Mats) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { u_time: { value: 0 }, u_on: { value: 0 }, u_sweep: { value: -1 }, u_portrait: { value: 0 }, u_fill: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: TAB_FRAG, toneMapped: false,
  })
  // Shifat 12:10Z (Oct 21): "Tablet design can be replaced with lated ipad 3d model" — the latest iPad Pro (13", Space
  // Black), procedural: an ultra-thin anodised slab (5.1 mm on 281.6 mm, to scale) with flat sides and softly rounded,
  // concentric corners; edge-to-edge cover glass with a uniform thin black bezel; the landscape front camera on the long
  // bezel; machined volume/top-button bumps; speaker slots on the short sides; the camera bump on the back. The DISPLAY
  // rectangle (WIN_HW × WIN_HH on the 1.5 × 1.0 glass UV frame) is untouched, so the portal and the push land exactly.
  const { hw: GW, hh: GH, r: GR } = IPAD_GLASS
  const g = new THREE.Group()
  const T = IPAD_T, bt = 0.0022, bs = 0.0022                                   // depth to scale; a soft machined edge radius
  const front = 0.0318                                                        // the body's front face, a hair under the glass (z 0.032)
  const parts: THREE.BufferGeometry[] = []
  const slab = new THREE.ExtrudeGeometry(rrShape(GW * 2 - 2 * bs, GH * 2 - 2 * bs, GR - bs), { depth: T - 2 * bt, bevelEnabled: true, bevelThickness: bt, bevelSize: bs, bevelSegments: 3, curveSegments: 10 })
  slab.translate(0, 0, front - T + bt); parts.push(slab)
  // side buttons (landscape, camera on top): two volume keys on the top edge toward the left, the top button on the left edge
  const key = (len: number, x: number, y: number, rotZ: number) => {
    const k = new THREE.ExtrudeGeometry(rrShape(len, 0.0105, 0.0052), { depth: 0.0016, bevelEnabled: true, bevelThickness: 0.0006, bevelSize: 0.0006, bevelSegments: 1, curveSegments: 4 })
    k.rotateX(-Math.PI / 2); k.rotateZ(rotZ); k.translate(x, y, front - T / 2 + 0.00525); return k
  }
  parts.push(key(0.072, -0.50, GH - 0.0004, 0), key(0.072, -0.415, GH - 0.0004, 0), key(0.082, -GW + 0.0004, 0.36, Math.PI / 2))
  // the back camera bump (upper left seen from behind = upper right in front-local x): a raised rounded square
  const bump = new THREE.ExtrudeGeometry(rrShape(0.118, 0.118, 0.03), { depth: 0.0018, bevelEnabled: true, bevelThickness: 0.0008, bevelSize: 0.0008, bevelSegments: 2, curveSegments: 6 })
  bump.rotateY(Math.PI); bump.translate(GW - 0.105, GH - 0.105, front - T + 0.0001); parts.push(bump)
  const metal = M.silver.clone()                                              // its own: the drum's fade must not touch it
  metal.color.set('#2e2f33'); metal.roughness = 0.34; metal.metalness = 1; metal.iridescence = 0; metal.envMapIntensity = 1.9
  deepFogPatch(metal, fogU!, false) // R6.88: the tablet never dissolves (its own patch, no dissolve)
  const body = new THREE.Mesh(mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p))), metal)
  // the cover glass: the same 1.5 × 1.0 UV frame (so the display, the portal rect and the shader are pixel-identical), its
  // outline cut to the slab's rounded corners and its thin uniform bezel
  const sg = new THREE.ShapeGeometry(rrShape(GW * 2, GH * 2, GR), 16)
  const sp = sg.attributes.position as THREE.BufferAttribute, suv = sg.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < sp.count; i++) suv.setXY(i, sp.getX(i) / 1.5 + 0.5, sp.getY(i) / 1.0 + 0.5)
  const screen = new THREE.Mesh(sg, mat); screen.position.z = 0.032
  // the small dark details (one draw): front camera dot on the long bezel, speaker slots on the short sides, back lenses
  const dk: THREE.BufferGeometry[] = []
  const dot = (r: number, x: number, y: number, z: number, back = false) => { const c = new THREE.CircleGeometry(r, 20); if (back) c.rotateY(Math.PI); c.translate(x, y, z); dk.push(c) }
  dot(0.0042, 0, GH - (GH - WIN_HH) / 2, 0.0326)                              // the landscape front camera
  dot(0.0021, 0.034, GH - (GH - WIN_HH) / 2, 0.0326)                          // the ambient/TrueDepth sensor, barely there
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {                       // four speaker slots: short sides, near each corner
    const sl = new THREE.PlaneGeometry(0.011, 0.07); sl.rotateY(sx * Math.PI / 2); sl.translate(sx * (GW + 0.0003), sy * 0.33, front - T / 2); dk.push(sl)
  }
  const bz = front - T - 0.0026
  dot(0.022, GW - 0.135, GH - 0.075, bz, true); dot(0.022, GW - 0.075, GH - 0.135, bz, true); dot(0.009, GW - 0.075, GH - 0.075, bz, true) // wide + ultra-wide-sized lenses, the LiDAR
  const dmat = new THREE.MeshPhysicalMaterial({ color: '#06070a', roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  dmat.envMap = M.silver.envMap; deepFogPatch(dmat, fogU!, false)
  const details = new THREE.Mesh(mergeGeometries(dk.map((p) => (p.index ? p.toNonIndexed() : p))), dmat)
  g.add(body, screen, details)                                                // children[1] stays the glass (TabletWindow's hook)
  g.traverse((o) => { o.layers.set(SYSUI_LAYER); o.renderOrder = 11 })
  g.userData.mat = mat
  return g
}

// Shifat 13:04Z: "Limit ui components to 4 per row … It looks too crowded now." Three rings of FOUR, interleaved
// (each row turned 30° on the last) so the front of the drum always shows a calm, open stagger of flat parts.
const ROWS: { y: number; phase: number; kinds: Kind[] }[] = [
  { y: 1.3, phase: 0.33, kinds: ['button', 'toggle', 'slider', 'chip'] },
  { y: 0.0, phase: 0.0, kinds: ['card', 'type', 'segmented', 'avatar'] },
  { y: -1.3, phase: 0.66, kinds: ['input', 'checkbox', 'progress', 'badge'] },
]

/** PERFGOV: the cylinder's build as steps (one part per step: its labels are canvas text), spread over short tasks behind
 *  the preloader by prebuildCylinder; a later re-mount runs it in one go as before */
function* buildCylSteps(gl: THREE.WebGLRenderer, u: Record<string, THREE.IUniform>) {
  const envRT = yield* deepEnv(gl)
  yield // PERFGOV
  const M = makeMats(u, envRT.texture)
  const items: { g: THREE.Group; a: number; y: number; ph: number }[] = []
  let alt = 0
  for (const row of ROWS) {
    const n = row.kinds.length
    for (let i = 0; i < n; i++) {
      const k = row.kinds[i]
      const g = piece(k, M, u, alt++)
      // the dive's backdrop sphere draws at renderOrder 10 with no depth test: the parts draw after it (11, with the
      // stone and the sand, depth-sorted; transparent ones in the transparent list)
      g.traverse((o) => { o.layers.set(SYSUI_LAYER); o.renderOrder = 11 })
      items.push({ g, a: ((i + row.phase) / n) * Math.PI * 2, y: row.y, ph: Math.random() * 6.28 })
      yield
    }
  }
  // the last light from above, and a cold fill from the open water
  const key = new THREE.DirectionalLight('#ffffff', 3.2); key.position.set(2.5, 10, 3)
  // a cold rim from behind and above: every part gets a lit edge against the deep
  const rim = new THREE.DirectionalLight('#e4edf5', 2.0); rim.position.set(-3, 4, -9)
  const hemi = new THREE.HemisphereLight('#cfd8e0', '#040506', 0.6)
  yield
  const tablet = makeTablet(M); yield
  yield* crewGeometrySteps(false) // PERFGOV: the tablet window's crewmate geometry (shared), in steps
  new TabletWindow(gl, tablet) // TABLET HOOK: swaps the glass for the portal; disposed with the painted material
  yield
  const atom = new AtomField(gl)
  atom.setTargets(items.map((it) => it.g))
  // the parts fade in as the particles settle on them: every part material can be faded (opaque ones keep depth)
  for (const k of ['black', 'white', 'silver'] as const) { M[k].transparent = true; M[k].depthWrite = true }
  const fades: { m: THREE.Material & { opacity: number }; base: number }[] = []
  const seen = new Set<THREE.Material>()
  for (const it of items) it.g.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material & { opacity: number }; if (m && !seen.has(m)) { seen.add(m); fades.push({ m, base: m.opacity }) } })
  // R6.88 SINK: the parts' points (every slab, disc and ring of every part; the text labels go with the front only) and
  // the diamond's (its own facets, object space), sampled once here, behind the preloader
  const glow = new Map<THREE.Material, THREE.Color>([[M.black, new THREE.Color(0.42, 0.5, 0.6)], [M.white, new THREE.Color(1.05, 1.08, 1.12)], [M.silver, new THREE.Color(0.8, 0.88, 1.0)], [M.glass, new THREE.Color(0.55, 0.9, 1.0)]])
  const srcs: DisSource[] = []
  items.forEach((it, i) => it.g.children.forEach((c) => { const mm = c as THREE.Mesh; const col = mm.isMesh ? glow.get(mm.material as THREE.Material) : undefined; if (col) { mm.updateMatrix(); srcs.push({ geo: mm.geometry, matrix: mm.matrix.clone(), part: i, color: col }) } }))
  const disUi = new Disintegrate(srcs, DIS_COUNTS.ui, { seed: 11, size: 0.022, grav: 2.6, spread: 0.55 })
  yield
  const gemGeo = brilliantGeometry(1)
  const disGem = new Disintegrate([{ geo: gemGeo, matrix: new THREE.Matrix4(), part: 0, color: new THREE.Color(0.42, 0.66, 1.45) }], DIS_COUNTS.gem, { gem: true, seed: 5, size: 0.034, grav: 1.4, spread: 1.6 })
  gemGeo.dispose()
  disUi.points.layers.set(DIVE_LAYER); disGem.points.layers.set(DIVE_LAYER)
  return { M, items, key, rim, hemi, envRT, tablet, atom, fades, fade: { v: -1 }, disUi, disGem }
}
type CylBuilt = ReturnType<typeof buildCylSteps> extends Generator<unknown, infer R, unknown> ? R : never
let prebuilt: { u: Record<string, THREE.IUniform>; gl: THREE.WebGLRenderer; b: CylBuilt } | null = null
/** PERFGOV: build the cylinder behind the preloader (gl/Scene.tsx), for the dive's shared uniforms */
export function* prebuildCylinder(gl: THREE.WebGLRenderer, u: Record<string, THREE.IUniform>) {
  if (prebuilt && prebuilt.u === u && prebuilt.gl === gl) return
  const b = yield* buildCylSteps(gl, u)
  prebuilt = { u, gl, b }
}

export function UiCylinder({ u }: { u: Record<string, THREE.IUniform> }) {
  const { camera, gl } = useThree()
  const root = useRef<THREE.Group>(null!)
  const spin = useRef<THREE.Group>(null!)
  const built = useMemo(() => {
    // PERFGOV: the one built behind the preloader, else built here in one go
    if (prebuilt && prebuilt.u === u && prebuilt.gl === gl) { const b = prebuilt.b; prebuilt = null; return b }
    return runToEnd(buildCylSteps(gl, u))
  }, [u, gl])
  // PERFGOV: the particle sim's own pass and the tablet's live window, warmed behind the preloader (prewarm.ts)
  useEffect(() => prewarm.add('dive', () => {
    const a = built.atom as unknown as { scene: THREE.Scene; cam: THREE.Camera; rtA: THREE.WebGLRenderTarget; rtB: THREE.WebGLRenderTarget }
    const tw = TabletWindow.last
    return { jobs: [{ roots: [a.scene], scene: a.scene, camera: a.cam, target: a.rtB }], targets: [a.rtA, a.rtB, built.envRT], steps: tw ? tw.warmSteps() : undefined }
  }), [built])
  useEffect(() => {
    camera.layers.enable(SYSUI_LAYER)
    return () => { Object.values(built.M).forEach((m) => m.dispose()); built.envRT.dispose(); (built.tablet.userData.mat as THREE.Material).dispose(); built.tablet.children.forEach((c, i) => { if (i !== 1) ((c as THREE.Mesh).material as THREE.Material).dispose() }); built.atom.dispose(); built.disUi.dispose(); built.disGem.dispose() }
  }, [camera, built])

  // W17: the parts answer the pointer — hover lifts a part out of the ring toward you, a tap plays it (toggle flips,
  // slider steps, checkbox ticks, segmented pill slides, buttons press, cards turn). Raycast against SYSUI_LAYER only,
  // once per frame at most, only while the cylinder is on screen and never inside the neighbour pass.
  const ia = useMemo(() => ({
    ray: new THREE.Raycaster(), ndc: new THREE.Vector2(), moved: false, hover: -1, tap: null as null | { x: number; y: number },
    down: { x: 0, y: 0, t: 0 }, touchHold: 0, hits: [] as THREE.Intersection[],
  }), [])
  useEffect(() => {
    ia.ray.layers.set(SYSUI_LAYER)
    const setNdc = (e: PointerEvent) => { ia.ndc.set((e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2); ia.moved = true }
    const interactive = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('a,button,input,textarea,select,[role=button],[role=dialog]')
    const move = (e: PointerEvent) => { if (e.pointerType !== 'touch') setNdc(e) }
    const down = (e: PointerEvent) => { ia.down = { x: e.clientX, y: e.clientY, t: performance.now() } }
    const up = (e: PointerEvent) => {
      if (interactive(e)) return
      if (Math.hypot(e.clientX - ia.down.x, e.clientY - ia.down.y) > 10 || performance.now() - ia.down.t > 450) return
      setNdc(e); ia.tap = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerdown', down, { passive: true })
    window.addEventListener('pointerup', up, { passive: true })
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up) }
  }, [ia])
  const tbDir = useMemo(() => new THREE.Vector3(), []), tbLook = useMemo(() => new THREE.Vector3(), []), tbW = useMemo(() => new THREE.Vector3(), [])
  const st = useMemo(() => built.items.map(() => ({ h: 0, press: 0, turn: 0, turnT: 0 })), [built])
  const kbState = useRef({ off: 0, map: null as null | Record<string, number>, focused: false, on: null as null | boolean, presses: 0, token: 0, level: 0 }) // W20 keyboard proxies
  useEffect(() => { built.items.forEach((it, i) => it.g.traverse((o) => { o.userData.part = i })) }, [built])
  const cursorHover = (on: boolean) => {
    document.querySelector('.cursor')?.classList.toggle('is-hover', on)
    document.documentElement.style.cursor = on ? 'pointer' : ''
  }
  const play = (i: number) => {
    const A = built.items[i].g.userData.act as Record<string, any>, S = st[i]
    switch (A.kind) {
      case 'toggle': A.on = !A.on; A.track.material = A.on ? A.mOn : A.mOff; break
      case 'checkbox': A.on = !A.on; A.check.visible = A.on; S.press = 1; break
      case 'slider': A.vT = A.vT > 0.82 ? 0.18 : Math.min(0.95, A.vT + 0.22); break
      case 'segmented': A.i = (A.i + 1) % 3; A.labs.forEach(([d, l]: THREE.Object3D[], j: number) => { d.visible = j === A.i; l.visible = j !== A.i }); break
      case 'card': case 'avatar': case 'type': case 'progress': S.turnT += Math.PI * 2; break
      default: S.press = 1
    }
  }

  useStageFrame('divecyl', (state) => {
    const r = root.current, s = spin.current; if (!r || !s) return
    if (!nb.active && !(window as any).__cyl) (window as any).__cyl = {
      get hover() { return ia.hover }, n: built.items.length,
      // QA: the screen point (CSS px) of each part's centre, nearest the camera first
      front: () => built.items.map((it, i) => { const v = it.g.getWorldPosition(new THREE.Vector3()); const d = v.distanceTo(state.camera.position); v.project(state.camera); return { i, kind: (it.g.userData.act as any).kind, x: Math.round((v.x + 1) / 2 * innerWidth), y: Math.round((1 - v.y) / 2 * innerHeight), d: +d.toFixed(2) } }).sort((p, q) => p.d - q.d),
    }
    const on = dive.abyss > 0.02
    r.visible = on
    if (!on) { if (ia.hover >= 0 && !nb.active) { ia.hover = -1; cursorHover(false) } return }
    r.position.copy(SYS_C)
    // W19 (key-frame review 21:0xZ: at 1440 the lower drum parts sat over the "Shade DS" title and lede): wide screens lift
    // the drum so its bottom row clears the text slot (phones have their own framing below)
    r.position.y += sysLift()   // R6.82: the same lift the stone settles at (diveState.sysLift)
    // phones: a tighter ring so no part crops at the screen edge as it turns
    // Scene 3 entry: as the camera pushes into the stone the ring opens outward to let it through
    const pw = dive.push * dive.push * (3 - 2 * dive.push)
    // R6.88 SINK: the parts no longer open out of the lens's way (they dissolve and the camera sinks with the tablet): a
    // gentle breath outward only, so the falling points read as the drum coming apart where it stood
    const ringK = 1 + 0.3 * pw
    const R = (3.0 - 0.75 * portrait()) * ringK
    // SCENE 3 FOCUS HAND-OFF (Shifat 13:24Z): the drum has dissolved, the stone drifts aside and down into the fog, and
    // the tablet rises out of the deep in front of it, bobbing; the stone's caustic sweeps across its glass. The camera
    // then pushes into its screen (Dive.tsx) until the stars fill the frame.
    // R6.88b DEEP TABLET (Shifat 10:41 PM: "Tablets should be by default in the deep underwater scene. Not spawned in the
    // Shade DS scene"): the tablet is no part of the drum. It waits from the start SINK_M below it (TAB_DEEP, world),
    // facing back up the dive, a slow float only; phones hold it upright. The camera comes down to it and then pushes
    // through its glass (Dive.tsx); it never moves to the camera. (Parented to the root for its lights only: the root is a
    // pure translation, taken out here, so the tablet's place is world-fixed.)
    const tb = built.tablet, tu = (tb.userData.mat as THREE.ShaderMaterial).uniforms
    if (!nb.active) (window as any).__mainCam = state.camera // QA: the settled camera (fbf captures wait for it)
    tb.visible = dive.push > 0.02
    if (tb.visible) {
      const up = tabletUpright(), tt = browser.reducedMotion ? 0 : props.time, bob = 1 - ss(0.5, PORTAL0, dive.push)
      tb.userData.upright = up
      tb.position.set(TAB_DEEP.x - r.position.x, TAB_DEEP.y - r.position.y + Math.sin(tt * 0.9) * 0.04 * bob, TAB_DEEP.z - r.position.z)
      tb.rotation.set(Math.sin(tt * 0.7) * 0.02 * bob, Math.PI + Math.sin(tt * 0.5) * 0.025 * bob, (up ? Math.PI / 2 : 0) + Math.sin(tt * 0.6) * 0.012 * bob)
      tu.u_time.value = props.time; tu.u_portrait.value = props.height > props.width * 1.05 ? 1 : 0; tu.u_fill.value = ss(PORTAL0, 1.0, dive.push); tu.u_on.value = ss(0.2, 0.42, dive.push); tu.u_sweep.value = -0.6 + 2.4 * ss(0.35, 0.65, dive.push)
      ;(tb.userData.tw as TabletWindow | undefined)?.update(state.camera, dive.push) // TABLET HOOK: render the 3D picture through the glass from this pass's camera
    }
    const t = props.time, dt = Math.min(props.dt, 0.05)
    s.rotation.y = t * 0.035 + dive.sys * 1.9 + kbState.current.off + DRUM_OFF // W20: + the keyboard turn (a focused part comes to the front)
    // W20 (root 22:43Z + 22:55Z: on phones a dark panel sat behind the 'DS' of the title, then just on the 'SYSTEMS'
    // eyebrow; text over busy 3D, r22): phones lift the DRUM (the spin group) so its bottom row keeps ~24 px of clear air
    // above the eyebrow as it turns. Only the drum moves: the particle atom stays centred on the stone (its morph targets
    // read the spin matrix, so the particles still land on the lifted parts) and the tablet keeps its pose.
    s.position.y = DRUM_LIFT * portrait()
    // SYSTEMS SEQUENCE (Shifat 13:13Z: "Start sequence with B then morph into A"): it opens as the particle atom around
    // the stone; through the section the particles stream onto the flat parts, the parts' real materials fade in as
    // they settle and the particles dissolve; it ends as the drum. Scroll-driven, so scrolling up runs it backward.
    const qm = (window as any).__morph
    // W19 (Shifat 19:3xZ: the particle → 3D UI formation was right in R4): POLISH's "no appear" freeze at morph = 1 reverted
    const morph = typeof qm === 'number' ? qm : HOLD >= 0 ? HOLD : ss(0.06, 0.56, dive.sys)
    const pf = ss(0.62, 0.96, morph)
    const atom = built.atom
    atom.points.visible = pf < 0.995
    if (atom.points.visible) atom.mat.uniforms.u_on.value = 1 - pf
    // R6.88 (Shifat 10:31–10:32 PM: the stone INSIDE the atom): the beads write depth while they are solid, so the near
    // ones hide the sharp stone where they pass in front of it (the hero pass depth-tests against the scene's depth)
    { const dw = 1 - pf > 0.6; if (atom.mat.depthWrite !== dw) atom.mat.depthWrite = dw }
    s.visible = pf > 0.002
    // and as the camera pushes into the stone the drum dissolves around it (nothing ever crosses the lens)
    // W20: phones dissolve the drum a little earlier on the push, so a part opening past the lens never crosses the lede
    // R6.88 SINK (Shifat 10:05 PM: "Ui fall as particle morphed disintegration"): no opacity fade on the push any more —
    // the parts are eaten by the dissolve front and fall away as points (disintegrate.ts); gone by dive.dis = 1
    const fv = pf
    s.visible = fv > 0.002 && dive.dis < 0.9995
    if (Math.abs(fv - built.fade.v) > 1e-3) { built.fade.v = fv; for (const f of built.fades) f.m.opacity = f.base * fv }
    atom.mat.uniforms.u_amb.value = dive.abyss
    // R6.88 SINK: the dissolve's uniforms. The front lives in DRUM space (the spin group's frame, the ring's breath taken
    // out), so it stays on the parts as they turn; the points read the same frame, so a fragment and its points agree
    {
      const du = built.disUi, dg = built.disGem
      DIS_U.u_disK.value = dive.dis
      const pxs = (props.height * props.dpr) / (2 * Math.tan((((state.camera as THREE.PerspectiveCamera).fov ?? 40) * Math.PI) / 360))
      du.set(dive.dis, pxs, t); dg.set(dive.gemDis, pxs, t)
      du.mat.uniforms.u_amb.value = dive.abyss
      if (dive.dis > 0 && dive.dis < 1) {
        s.updateMatrix(); r.updateMatrixWorld()
        DIS_SCL.makeScale(1 / ringK, 1, 1 / ringK)
        DIS_TOF.copy(s.matrix).invert().premultiply(DIS_SCL)              // root → drum
        du.mat.uniforms.u_toF.value.copy(DIS_TOF)
        DIS_U.u_toDrum.value.copy(r.matrixWorld).invert().premultiply(DIS_TOF) // world → drum
        for (let i = 0; i < built.items.length; i++) { const g = built.items[i].g; g.updateMatrix(); du.M[i].multiplyMatrices(s.matrix, g.matrix) }
      }
      const gm = gemRef.m
      if (dg.points.visible && gm) {
        gm.updateWorldMatrix(true, false); r.updateMatrixWorld()
        dg.M[0].copy(r.matrixWorld).invert().multiply(gm.matrixWorld)    // the diamond, in the root's space
      }
    }
    // pointer → part (the main pass only)
    if (!nb.active && (ia.moved || ia.tap) && pf > 0.9) {
      ia.moved = false
      ia.ray.setFromCamera(ia.ndc, state.camera)
      ia.hits.length = 0
      ia.ray.intersectObject(s, true, ia.hits)
      const hit = ia.hits.length ? (ia.hits[0].object.userData.part as number | undefined) ?? -1 : -1
      if (ia.tap) { ia.tap = null; if (hit >= 0) { play(hit); ia.touchHold = props.time + 0.7; ia.hover = hit } }
      else if (hit !== ia.hover) { ia.hover = hit; cursorHover(hit >= 0) }
    }
    if (ia.hover >= 0 && input.isTouch && props.time > ia.touchHold) ia.hover = -1
    // POLISH-2 keep-out: the main lens (position + forward), read in the main pass only
    if (!nb.active) { KEEP_EYE.copy(state.camera.position); state.camera.getWorldDirection(KEEP_F) }
    for (let i = 0; i < built.items.length; i++) {
      const it = built.items[i], S = st[i], A = it.g.userData.act as Record<string, any>
      // W20 (root 23:16Z: on phones the middle row passed over the stone, and a lifted bottom row did too): phones raise the
      // top and middle rows so no row sits at the stone's height; the bottom row stays below it, clear of the SYSTEMS
      // eyebrow. A per-aspect layout of the same parts, like the wide-screen lift above.
      const iy = it.y + portrait() * (it.y > 0.5 ? 0.9 : it.y > -0.5 ? 1.05 : 0)
      S.h += ((i === ia.hover ? 1 : 0) - S.h) * (1 - Math.exp(-10 * dt))
      S.press = Math.max(0, S.press - dt * 4)
      S.turn += (S.turnT - S.turn) * (1 - Math.exp(-6 * dt))
      const lift = S.h * 0.32 - Math.sin(S.press * Math.PI) * 0.08
      const rr = R + lift
      // POLISH-2 (Shifat 19:30Z "Camera mustn't go through hard objects"): a part that would sit in the lens's corridor
      // (just behind to ~5 m ahead, within ~2.2 m of the axis, so nothing crosses the lens or the tablet coming to it) slides up (upper rows) or down (lower rows) by exactly
      // what keeps it clear: sqrt(lat² + r²) − lat, a smooth path change, never a fade or a pop. Driven by the main
      // camera (KEEP_EYE / KEEP_F), so every pass draws the part at the same place.
      let dodge = 0, sideX = 0, sideZ = 0
      {
        const wa = it.a + s.rotation.y
        KEEP_V.set(SYS_C.x + Math.sin(wa) * rr - KEEP_EYE.x, SYS_C.y + iy - KEEP_EYE.y, SYS_C.z + Math.cos(wa) * rr - KEEP_EYE.z)
        const z = KEEP_V.dot(KEEP_F)
        const rk = 2.2 * ss(-0.8, 0.2, z) * (1 - ss(4.0, 6.0, z)) * ss(0, 0.15, dive.push) // only on the push toward the tablet
        if (rk > 0) {
          const lat = Math.sqrt(Math.max(0, KEEP_V.lengthSq() - z * z))
          dodge = (iy >= 0 ? 1 : -1) * (Math.sqrt(lat * lat + rk * rk) - lat)
          // W20 (root 22:55Z, r22): on phones a lower-row part sliding DOWN out of the corridor crossed the Shade DS
          // eyebrow/title at the bottom of the screen. Phones move lower parts SIDEWAYS instead, straight away from the
          // lens axis by the same clearance (the same smooth path change, never a fade or a pop).
          if (dodge < 0) {   // W21: wide screens too (a lower part dodging down crossed the 1440 caption on the push)
            const lx = KEEP_V.x - z * KEEP_F.x, lz = KEEP_V.z - z * KEEP_F.z, ln = Math.hypot(lx, lz)
            const sx = ln > 1e-4 ? lx / ln : Math.sin(wa), sz = ln > 1e-4 ? lz / ln : Math.cos(wa), m = -dodge, ry = s.rotation.y
            sideX = (sx * Math.cos(ry) - sz * Math.sin(ry)) * m; sideZ = (sx * Math.sin(ry) + sz * Math.cos(ry)) * m
            dodge = 0
          }
        }
      }
      // W20 (root 23:34Z: 'give the stone a small clear radius in screen space at 390 through the whole section'): on
      // phones every part, in front of the stone or behind it, keeps out of a disc around the eye→stone line (stone
      // ≈0.9 m + half a part + margin). The part slides straight away from the line by a soft-max (smooth, compact:
      // parts already clear barely move), so nothing tucks in front of or behind the diamond. Fades out as the push
      // begins (the drum dissolves and the stone drifts aside there).
      let kx = 0, ky = 0, kz = 0
      // (W20 00:0xZ: wide screens too — the 1440 'Aa' panel sat over the stone. Parts are placed from the root, which wide
      // screens lift by 1 m, so the part's world point uses r.position)
      // R6.88 (Shifat 10:31–10:32 PM: "The stone should feel like inside of particle atom not in front" — in the Shade DS ring
      // the near parts pass IN FRONT of the stone, the far ones behind it; the hero pass now depth-tests the sharp stone
      // against them): the stone keep-out is off
      const kw = 0 * (1 - ss(0.2, 0.5, pw))
      if (kw > 0.001) {
        const ry = s.rotation.y, cr = Math.cos(ry), sr = Math.sin(ry)
        const lx0 = Math.sin(it.a) * rr + sideX, lz0 = Math.cos(it.a) * rr + sideZ, ly0 = iy + dodge + s.position.y
        STONE_D.set(SYS_C.x - KEEP_EYE.x, SYS_C.y + sysLift() - KEEP_EYE.y, SYS_C.z - KEEP_EYE.z).normalize()
        KEEP_V.set(r.position.x + lx0 * cr + lz0 * sr - KEEP_EYE.x, r.position.y + ly0 - KEEP_EYE.y, r.position.z - lx0 * sr + lz0 * cr - KEEP_EYE.z)
        KEEP_V.addScaledVector(STONE_D, -KEEP_V.dot(STONE_D)) // the part's offset from the eye→stone line
        const lat = KEEP_V.length(), rk = 1.35, e = 0.25
        if (lat > 1e-4 && lat < rk + 1.0) {
          const push = (0.5 * (lat + rk + Math.sqrt((lat - rk) * (lat - rk) + e * e)) - lat) * kw
          const wx = KEEP_V.x / lat * push, wy = KEEP_V.y / lat * push, wz = KEEP_V.z / lat * push
          kx = wx * cr - wz * sr; ky = wy; kz = wx * sr + wz * cr
        }
      }
      // W21 (root 00:26Z: 'no 3D over text' — at 1440 the turned drum's bottom row crossed the Shade DS caption): on wide
      // screens no part may come down into the text band at the bottom of the screen (the slot: SYSTEMS, the title and
      // the caption). The part's lower edge is projected; past the band's top it rises by a soft-max in world Y, the
      // same smooth path change as the other keep-outs, never a fade or a pop. Phones keep their own framing above.
      const bw = 1 - portrait()
      if (bw > 0.001 && !nb.active) {
        const ry = s.rotation.y, cr = Math.cos(ry), sr = Math.sin(ry)
        const lx1 = Math.sin(it.a) * rr + sideX + kx, lz1 = Math.cos(it.a) * rr + sideZ + kz, ly1 = iy + dodge + ky + s.position.y
        BAND_P.set(r.position.x + lx1 * cr + lz1 * sr, r.position.y + ly1, r.position.z - lx1 * sr + lz1 * cr)
        const depth = (BAND_P.x - KEEP_EYE.x) * KEEP_F.x + (BAND_P.y - KEEP_EYE.y) * KEEP_F.y + (BAND_P.z - KEEP_EYE.z) * KEEP_F.z
        if (depth > 0.5) {
          const cam = state.camera as THREE.PerspectiveCamera, H = props.height
          const mpp = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov || 40) / 2) * depth / H   // metres per css px at the part
          BAND_P.project(cam)
          const yc = (1 - BAND_P.y) * 0.5 * H, half = 0.42 * it.g.scale.y / mpp                 // a part is ≈0.84 m tall
          const d = bandTop() - (yc + half), e = 28
          const pushPx = 0.5 * (d + Math.sqrt(d * d + e * e)) - d                                 // ≈0 when well clear
          ky += pushPx * mpp * bw
        }
      }
      // R6.88 ATOM (Shifat 10:31–10:32 PM: the stone INSIDE the ring, near parts passing in front of it): on phones the ring's
      // near side runs 0.6 m lower and its far side 0.6 m higher (a tilted orbit), so the near parts cross the stone's face
      // instead of passing above it; the hero pass hides the stone wherever they are in front. Eases out as the push begins.
      ky += ORBIT_TILT * Math.cos(it.a + s.rotation.y) * portrait() * (1 - ss(0.2, 0.5, pw))
      it.g.position.set(Math.sin(it.a) * rr + sideX + kx, iy + dodge + ky + Math.sin(t * 0.6 + it.ph) * 0.05, Math.cos(it.a) * rr + sideZ + kz)
      // each part turns halfway toward the lens from its place on the drum (no edge-on slivers at the sides)
      let off = Math.PI - (it.a + s.rotation.y); off = Math.atan2(Math.sin(off), Math.cos(off))
      it.g.rotation.set(Math.sin(t * 0.5 + it.ph) * 0.04 * (1 - S.h), it.a + off * (0.55 + 0.45 * S.h) + S.turn, Math.sin(t * 0.4 + it.ph * 1.3) * 0.03 * (1 - S.h))
      it.g.scale.setScalar((1 + S.h * 0.08) * (1 - 0.45 * pw) * (0.9 + 0.1 * pf))
      if (A.kind === 'toggle') { const x = A.on ? 0.22 : -0.22; A.knob.position.x += (x - A.knob.position.x) * (1 - Math.exp(-14 * dt)) }
      else if (A.kind === 'slider') {
        A.v += (A.vT - A.v) * (1 - Math.exp(-9 * dt))
        A.fill.scale.x = A.L * A.v; A.fill.position.x = -A.L / 2 + (A.L / 2) * A.v; A.thumb.position.x = -A.L / 2 + A.L * A.v
      } else if (A.kind === 'segmented') { const x = A.step * (A.i - 1); A.pill.position.x += (x - A.pill.position.x) * (1 - Math.exp(-12 * dt)) }
    }
    // W20 (root 00:0xZ, keyboard): the Shade DS controls are real DOM buttons (Systems.tsx). They are always tab stops (W26);
    // once the drum has formed each one sits over its drum part (a ≥44 px box, so the focus ring
    // shows where the part is) and the focused part lifts like a hover. Enter / Space plays the part, as a tap would.
    if (!nb.active) {
      const layer = sys.layer, formed = pf > 0.9 && fv > 0.6 && props.stage === 'dive'
      if (layer) {
        // W26 (scorer-r655 #1): never inert. Setting inert while the drum was not formed evicted keyboard focus to <body>
        // (1440: R6.53's scroll un-formed the drum under the focused toggle) and made the controls no tab stops at all
        // (390). The controls stay reachable; focusing one jump-cuts the page to the formed drum first (Systems.tsx).
        if ((layer as any).inert) (layer as any).inert = false
        sys.formed = formed
        const kb = kbState.current
        if (!kb.map) { kb.map = {}; built.items.forEach((it, i) => { const k = (it.g.userData.act as any).kind as string; if (!(k in kb.map!)) kb.map![k] = i }) }
        const M = kb.map, idx: Record<ControlId, number | undefined> = { toggle: M.toggle, button: M.button, slider: M.slider, chip0: M.segmented, chip1: M.segmented, chip2: M.segmented }
        if (formed) {
          const top = layer.getBoundingClientRect().top, W2 = props.width / 2, H2 = props.height / 2
          let focusPart = -1
          for (const id of Object.keys(idx) as ControlId[]) {
            const el = sys.els[id], i = idx[id]; if (!el || i === undefined) continue
            const g = built.items[i].g; g.updateMatrixWorld()
            let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
            for (const [cx, cy] of KB_CORNERS) { KB_V.set(cx, cy, 0).applyMatrix4(g.matrixWorld).project(state.camera); const px = (KB_V.x + 1) * W2, py = (1 - KB_V.y) * H2; x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py) }
            const ww = Math.max(44, x1 - x0), hh = Math.max(44, y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
            el.style.transform = `translate3d(${(cx - ww / 2).toFixed(1)}px, ${(cy - hh / 2 - top).toFixed(1)}px, 0)`; el.style.width = `${ww.toFixed(1)}px`; el.style.height = `${hh.toFixed(1)}px`
            if (document.activeElement && (el === document.activeElement || el.contains(document.activeElement))) focusPart = i
          }
          if (focusPart >= 0) { ia.hover = focusPart; kb.focused = true } else if (kb.focused) { ia.hover = -1; kb.focused = false }
          // a focused part on the far side of the drum turns to the front (eased; the turn stays where it lands, no snap back)
          if (focusPart >= 0) { let d = Math.PI - built.items[focusPart].a - s.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); kb.off += d * (1 - Math.exp(-4 * dt)) }
        }
        // keyboard activation: the DOM owns the values; play the matching part when one changes
        if (kb.on === null) { kb.on = sys.on; kb.presses = sys.presses; kb.token = sys.token; kb.level = sys.level }
        if (sys.on !== kb.on && M.toggle !== undefined) { kb.on = sys.on; play(M.toggle) }
        if (sys.presses !== kb.presses && M.button !== undefined) { kb.presses = sys.presses; play(M.button) }
        if (sys.token !== kb.token && M.segmented !== undefined) { kb.token = sys.token; const A = built.items[M.segmented].g.userData.act as any; A.i = (sys.token + 2) % 3; play(M.segmented) }
        if (sys.level !== kb.level && M.slider !== undefined) { kb.level = sys.level; (built.items[M.slider].g.userData.act as any).vT = Math.min(0.95, Math.max(0.05, sys.level)) }
      }
    }
    if (atom.points.visible) {
      // the morph targets follow the drum as it turns (part matrices in the atom's space = the root's)
      s.updateMatrix()
      const PM = atom.partMatrices
      for (let i = 0; i < built.items.length; i++) { const g = built.items[i].g; g.updateMatrix(); PM[i].multiplyMatrices(s.matrix, g.matrix) }
      // a bead keeps one world size on every screen: device px per metre at 1 m = buffer height / (2 tan(vfov / 2))
      const vf = (state.camera as THREE.PerspectiveCamera).fov ?? 40
      const px = 0.034 * (props.height * props.dpr) / (2 * Math.tan((vf * Math.PI) / 360))
      if (!nb.active) atom.step(t, props.dt, pw * (1 - morph), px, morph)
    }
  }, root)

  return (
    <group ref={root} visible={false}>
      <primitive object={built.key} />
      <primitive object={built.key.target} />
      <primitive object={built.rim} />
      <primitive object={built.rim.target} />
      <primitive object={built.hemi} />
      <primitive object={built.tablet} />
      <primitive object={built.atom.points} />
      <primitive object={built.disUi.points} />
      <primitive object={built.disGem.points} />
      <group ref={spin}>
        {built.items.map((it, i) => <primitive key={i} object={it.g} />)}
      </group>
    </group>
  )
}
