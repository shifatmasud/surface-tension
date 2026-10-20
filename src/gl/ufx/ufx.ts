import * as THREE from 'three'
import { props, shared } from '../../state/props'
import { BICUBIC } from '../shaders/chunks'
import { clip } from '../systems/clip'

/**
 * Ufx — DOM → WebGL sync (handbook ch.4), written fresh. Real HTML elements stay the layout truth
 * (and stay in the accessibility tree); a GPU quad mirrors each one. Rects are measured on resize
 * (document space), the scroll offset is applied every frame, off-screen quads are skipped.
 * Two layers: `under` (PreUfx, order 50: bends with the cursor paint) and `over` (PostUfx, 100: crisp).
 * The camera is a "pixel-perfect" perspective camera: z = 0 maps 1 unit to 1 CSS px, so vertex bends
 * in z read as real depth.
 */
export type UfxKind = 'text' | 'image' | 'html' | 'plane'
export interface UfxItem {
  el: HTMLElement
  mesh: THREE.Mesh
  layer: 'under' | 'over'
  docTop: number; docLeft: number; w: number; h: number
  /** extra per-frame hook (reveal progress, hover…) */
  onUpdate?: (it: UfxItem, screenY: number) => void
  fixed?: boolean
  /** positioned by its own onUpdate (sticky / transformed parents): skip the doc-space placement */
  selfPlaced?: boolean
  measure?: () => void
  /** inside a sticky/transformed ancestor: read the live screen rect every frame instead of doc space */
  live?: () => { top: number; left: number; w: number; h: number }
  visibleWhen?: () => boolean
  /** id of the section the element lives in (resolved once; '' = global) */
  section?: string
}

const FOV = 30
class UfxSystem {
  under = new THREE.Scene()
  over = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(FOV, 1, 1, 10000)
  items: UfxItem[] = []
  enabled = true
  w = 1; h = 1
  constructor() { this.under.name = 'PreUfx'; this.over.name = 'PostUfx' }
  resize(w: number, h: number) {
    this.w = w; this.h = h
    const dist = (h / 2) / Math.tan(THREE.MathUtils.degToRad(FOV / 2))
    this.camera.aspect = w / h; this.camera.position.set(0, 0, dist); this.camera.near = dist / 20; this.camera.far = dist * 4
    this.camera.updateProjectionMatrix()
    this.measureAll()
  }
  measureAll() {
    for (const it of this.items) this.measure(it)
  }
  measure(it: UfxItem) {
    if (it.measure) return it.measure()
    const r = it.el.getBoundingClientRect()
    it.docTop = r.top + (it.fixed ? 0 : window.scrollY); it.docLeft = r.left; it.w = r.width; it.h = r.height
  }
  add(it: UfxItem) {
    this.items.push(it); this.measure(it)
    ;(it.layer === 'under' ? this.under : this.over).add(it.mesh)
    it.mesh.frustumCulled = false
    return it
  }
  remove(it: UfxItem) {
    this.items = this.items.filter((i) => i !== it)
    it.mesh.parent?.remove(it.mesh)
  }
  update() {
    const vw = this.w, vh = this.h
    // clipped sections: the live frame is drawn shifted down inside the incoming card (inner parallax), so the
    // DOM-mirrored layer renders that much higher and lands exactly on its DOM boxes
    this.camera.position.y = clip.ufxY
    for (const it of this.items) {
      let top = it.docTop - (it.fixed ? 0 : props.scroll)
      if (it.section === undefined) it.section = it.el.closest('section')?.id ?? ''
      // scrolling up through a boundary the upper (outgoing) section is the live render and its DOM carries the
      // clip's drift transform; a live screen rect includes it, so take it out (the camera offset puts it back once)
      const drift = clip.liveUpper && it.section === clip.outName ? clip.outTy : 0
      if (it.live) { const L = it.live(); top = L.top - drift; it.docLeft = L.left; it.w = L.w; it.h = L.h }
      const inView = it.selfPlaced || (top < vh + 200 && top + it.h > -200)
      // clipped sections: a mirrored item belongs to its section's block; the still block's items live on in its
      // captured frame, so the live render must not draw them again
      const owned = !it.section || clip.allowed(it.section)
      const on = this.enabled && inView && owned && (it.visibleWhen ? it.visibleWhen() : true)
      it.mesh.visible = on && (it.w > 0 || !!it.selfPlaced)
      if (!it.mesh.visible) continue
      if (!it.selfPlaced) {
        it.mesh.position.set(it.docLeft + it.w / 2 - vw / 2, -(top + it.h / 2 - vh / 2), 0)
        it.mesh.scale.set(it.w, it.h, 1)
      }
      it.onUpdate?.(it, top)
      if (drift && it.selfPlaced) it.mesh.position.y += drift   // self-placed items read their transformed rect
    }
  }
}
export const ufx = new UfxSystem()
;(window as any).__ufx = ufx

/** Shared vertex: a unit plane with enough segments to bend like a sheet on a cylinder. */
export const UFX_VERT = /* glsl */ `
uniform float u_bend;        // scroll-velocity bend (cylinder), eases to 0 at rest
uniform float u_viewH;
uniform float u_lift;        // hover lift in px
varying vec2 v_uv;
varying vec3 v_view;
void main(){
  v_uv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  // cylinder: the further from screen centre (y), the more it curls away in z
  float ny = world.y / (u_viewH * 0.5);
  world.z -= (1.0 - cos(clamp(ny, -1.5, 1.5) * 1.2)) * u_bend * u_viewH * 0.5;
  world.y -= sin(clamp(ny, -1.5, 1.5) * 1.2) * u_bend * 6.0;
  world.z += u_lift;
  vec4 mv = viewMatrix * world;
  v_view = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`

/** Text quad: line rises from under a mask (reveal), and the cursor paint texture shades it (ch.14 S.8 reader). */
export const UFX_TEXT_FRAG = /* glsl */ `
uniform sampler2D u_map;
uniform float u_reveal;        // 0 hidden under the mask → 1 in place
uniform float u_opacity;
uniform sampler2D u_currPaintTexture;
uniform vec2 u_paintTextureSize;
uniform vec2 u_resolution;
uniform vec3 u_color;
uniform vec3 u_sheen;
uniform float u_time;
varying vec2 v_uv;
${BICUBIC}
void main(){
  // mask slide-up: sample the glyphs shifted down by (1 - reveal); clip below the line box
  // reveal 0→1 rises from under the line's mask; 1→2 keeps rising and leaves through the top edge
  float off = (1.0 - u_reveal) * 1.15;
  vec2 uv = vec2(v_uv.x, v_uv.y + off);
  if (uv.y > 1.0 || uv.y < 0.0) discard;
  float a = texture2D(u_map, uv).a;
  // the cursor paints liquid silver into the type: velocity picks a sheen, weight decides how much
  vec2 suv = gl_FragCoord.xy / u_resolution;
  vec4 paint = textureBicubic(u_currPaintTexture, suv, u_paintTextureSize);
  float w = max(paint.z, paint.w);
  float phase = (paint.x + paint.y) * 1.5 + uv.x * 2.0;
  vec3 sheen = mix(u_sheen * 0.55, u_sheen, 0.5 + 0.5 * sin(phase * 6.2831 + u_time * 0.5));
  vec3 col = mix(u_color, sheen, clamp(w * 1.6, 0.0, 1.0));
  gl_FragColor = vec4(col, a * u_opacity);
}`

export function textMaterial(map: THREE.Texture, color: string, sheen = '#9aa0a8') {
  return new THREE.ShaderMaterial({
    vertexShader: UFX_VERT, fragmentShader: UFX_TEXT_FRAG,
    uniforms: {
      u_map: { value: map }, u_reveal: { value: 0 }, u_opacity: { value: 1 },
      u_bend: bendUniform, u_viewH: viewHUniform, u_lift: { value: 0 },
      u_currPaintTexture: shared.u_currPaintTexture, u_paintTextureSize: shared.u_paintTextureSize,
      u_resolution: shared.u_resolution, u_color: { value: new THREE.Color(color) }, u_sheen: { value: new THREE.Color(sheen) },
      u_time: shared.u_time,
    },
    transparent: true, depthTest: false, depthWrite: false,
  })
}
export const bendUniform = { value: 0 }
export const viewHUniform = { value: 1 }
