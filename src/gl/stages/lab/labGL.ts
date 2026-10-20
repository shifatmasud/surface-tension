import * as THREE from 'three'
import { preload } from '../../../services/preload'
import { ufx, type UfxItem } from '../../ufx/ufx'
import { props, shared } from '../../../state/props'
import { settings } from '../../../services/settings'
import { input } from '../../../services/input'
import { htmlRender } from '../../html/htmlRender'
import { PROJECTS } from '../../../content/site'
import { damp } from '../../../core/math'

/**
 * Lab cards in WebGL (ufx "under" layer, so the cursor paint bends them). Each DOM card stays the
 * layout + interaction + accessibility truth; its GPU twin adds what the DOM can't:
 *  - grey at rest → full colour as the card reaches the centre (or on hover / keyboard focus)
 *  - a subtle cylinder bend proportional to the track's velocity
 *  - depth-map 3D parallax on the reel (where a depth map exists), driven by the pointer
 *  - damped mouse tilt + lift on hover
 *  - the card's label (number, year, tags) is live HTML rendered to a texture by three-html-render
 * Only the focused card's video plays; the others show their poster.
 */
const VERT = /* glsl */ `
uniform float u_bendX, u_viewW, u_lift;
uniform vec2 u_tilt;           // damped mouse tilt (radians-ish)
uniform vec2 u_size;           // card size in px
varying vec2 v_uv;
void main(){
  v_uv = uv;
  vec3 p = position;
  // tilt about the card centre: z offset proportional to local x/y
  float tz = p.x * u_tilt.y * u_size.x + p.y * -u_tilt.x * u_size.y;
  vec4 world = modelMatrix * vec4(p, 1.0);
  world.z += tz * 0.5 + u_lift;
  // cylinder bend across the screen, proportional to horizontal scroll velocity
  float nx = clamp(world.x / (u_viewW * 0.5), -1.6, 1.6);
  world.z -= (1.0 - cos(nx * 1.1)) * u_bendX * u_viewW * 0.35;
  world.x -= sin(nx * 1.1) * u_bendX * 18.0;
  gl_Position = projectionMatrix * viewMatrix * world;
}`
const FRAG = /* glsl */ `
uniform sampler2D u_map, u_depth, u_html;
uniform float u_hasDepth, u_hasHtml, u_focus, u_color, u_radius, u_opacity, u_time, u_ready;
uniform vec2 u_size, u_mapSize, u_mouse;
varying vec2 v_uv;
float rbox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main(){
  // cover-fit the reel into the card
  float ca = u_size.x / u_size.y, ma = u_mapSize.x / max(u_mapSize.y, 1.0);
  vec2 uv = v_uv - 0.5;
  if (ca > ma) uv.y *= ma / ca; else uv.x *= ca / ma;
  uv *= 0.94;                                     // a little overscan for the parallax to move in
  uv += 0.5;
  if (u_hasDepth > 0.5) {
    float d = texture2D(u_depth, uv).r;
    uv += (d - 0.5) * u_mouse * vec2(-0.035, 0.028) * (0.4 + 0.6 * u_focus);
  }
  vec3 col = texture2D(u_map, uv).rgb;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 grey = vec3(l) * 0.96 + 0.02;
  // the star card gets a gentle S-curve + saturation lift so the reel reads vivid on the light field
  vec3 vivid = col * col * (3.0 - 2.0 * col);
  vivid = mix(vec3(dot(vivid, vec3(0.2126, 0.7152, 0.0722))), vivid, 1.18);
  col = mix(col, clamp(vivid, 0.0, 1.0), 0.55 * u_focus);
  col = mix(grey, col, u_focus * u_color);
  col *= mix(0.82, 1.0, u_focus);                 // receding cards sit back in tone
  // until the reel's first frame arrives, a quiet light-grey plate (never an empty black sampler)
  col = mix(vec3(0.885, 0.889, 0.897), col, u_ready);
  if (u_hasHtml > 0.5) {
    // the live HTML label is white text; key it by brightness and keep it to the bottom strip so whatever the
    // rasteriser puts behind the text can never veil the reel (it washed the whole card out before)
    vec4 h = texture2D(u_html, v_uv);
    float lum = dot(h.rgb / max(h.a, 1e-3), vec3(0.333));
    float m = h.a * smoothstep(0.9, 0.99, lum) * (1.0 - smoothstep(0.14, 0.2, v_uv.y));
    col = mix(col, vec3(1.0), m);
  }
  vec2 px = (v_uv - 0.5) * u_size;
  float sd = rbox(px, u_size * 0.5, u_radius);
  float a = 1.0 - smoothstep(-1.0, 0.5, sd);
  gl_FragColor = vec4(col, a * u_opacity);
}`

type Card = { id: string; el: HTMLElement; item: UfxItem; mat: THREE.ShaderMaterial; video?: HTMLVideoElement; vtex?: THREE.VideoTexture; poster?: THREE.Texture; focus: number; hover: number; tx: number; ty: number; lift: number; getHtml?: (() => THREE.Texture | null) | null }

const loader = new THREE.TextureLoader()
const geo = new THREE.PlaneGeometry(1, 1, 32, 20)
const viewW = { value: 1 }
const bendX = { value: 0 }

export const labGL = {
  offsetX: 0,
  track: null as HTMLElement | null,
  cards: [] as Card[],
  hovered: '' as string,
  bend: 0,
  mount(el: HTMLElement) {
    this.track = el
    if (!settings.USE_GL) return
    document.documentElement.classList.add('lab-gl')
    el.querySelectorAll<HTMLElement>('.card').forEach((cardEl) => {
      const id = cardEl.dataset.id!
      const p = PROJECTS.find((x) => x.id === id)!
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
        uniforms: {
          u_map: { value: null }, u_depth: { value: null }, u_html: { value: null },
          u_hasDepth: { value: 0 }, u_hasHtml: { value: 0 }, u_focus: { value: 0 }, u_color: { value: p.color ? 1 : 0 },
          u_radius: { value: 14 }, u_opacity: { value: 1 }, u_time: shared.u_time, u_ready: { value: 0 },
          u_size: { value: new THREE.Vector2(1, 1) }, u_mapSize: { value: new THREE.Vector2(16, 9) }, u_mouse: { value: new THREE.Vector2() },
          u_bendX: bendX, u_viewW: viewW, u_lift: { value: 0 }, u_tilt: { value: new THREE.Vector2() },
        },
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.renderOrder = 5
      const media = cardEl.querySelector<HTMLElement>('.card__dom')!
      const card: Card = { id, el: cardEl, mat, focus: 0, hover: 0, tx: 0, ty: 0, lift: 0, item: null as any }
      const item: UfxItem = {
        el: media, mesh, layer: 'under', selfPlaced: true, docTop: 0, docLeft: 0, w: 0, h: 0,
        measure: () => {
          // the track moves by transform; measure untransformed so the offset can be applied per frame
          const r = media.getBoundingClientRect()
          card.item.docTop = r.top + window.scrollY; card.item.docLeft = r.left - this.offsetX; card.item.w = r.width; card.item.h = r.height
        },
        onUpdate: (it) => {
          // the card lives in a sticky, transformed track: read its real screen rect (no layout write in between)
          const r = media.getBoundingClientRect()
          it.w = r.width; it.h = r.height
          it.mesh.position.set(r.left + r.width / 2 - ufx.w / 2, -(r.top + r.height / 2 - ufx.h / 2), 0)
          const cx = it.mesh.position.x
          const f = Math.max(0, 1 - Math.abs(cx) / Math.max(1, ufx.w * 0.42))
          const target = Math.max(f * f * (3 - 2 * f), card.hover)
          card.focus = damp(card.focus, target, 5, props.dt)
          // one star: the centred reel is full size; its neighbours recede (smaller, lighter) on the field
          const sc = 0.82 + 0.18 * card.focus
          it.mesh.scale.set(r.width * sc, r.height * sc, 1)
          const u = mat.uniforms
          u.u_opacity.value = 0.62 + 0.38 * card.focus
          u.u_focus.value = card.focus
          u.u_size.value.set(it.w, it.h)
          // damped mouse tilt + lift on hover (pointer relative to the card)
          const left = r.left, top = r.top
          const mx = ((input.mousePixelXY.x - left) / Math.max(1, it.w)) * 2 - 1
          const my = ((input.mousePixelXY.y - top) / Math.max(1, it.h)) * 2 - 1
          const inside = card.hover > 0.01
          card.tx = damp(card.tx, inside ? my * 0.12 : 0, 6, props.dt)
          card.ty = damp(card.ty, inside ? mx * 0.12 : 0, 6, props.dt)
          card.lift = damp(card.lift, card.hover * 40, 6, props.dt)
          u.u_tilt.value.set(card.tx, card.ty); u.u_lift.value = card.lift
          const qm = (window as any).__labMouse as [number, number] | undefined // QA: force the parallax pointer
          if (qm) u.u_mouse.value.set(qm[0], qm[1]); else u.u_mouse.value.set(input.mouseXY.x, input.mouseXY.y)
          // video: only the focused card plays
          this.ensureMedia(card, p)
          if (card.video) {
            // PRELOAD: reels stay unrequested until the lab is near (no five video streams competing with the boot)
            if (card.video.preload === 'none') card.video.preload = 'metadata'
            const want = card.focus > 0.55 && !(window as any).__labPause // QA: __labPause holds every card on its poster
            if (want && card.video.paused) card.video.play().catch(() => {})
            else if (!want && !card.video.paused) card.video.pause()
            // a paused video's texture never receives a frame (three uploads on video frames): show the reel only
            // while it is actually playing, the poster otherwise — this was the black-card bug on ultrawide
            const playing = !card.video.paused && card.video.readyState >= 2 && card.video.currentTime > 0
            if (card.vtex && playing) { u.u_map.value = card.vtex; u.u_mapSize.value.set(card.video.videoWidth, card.video.videoHeight) }
            else if (card.poster?.image && u.u_map.value !== card.poster) { u.u_map.value = card.poster; u.u_mapSize.value.set((card.poster.image as any).width, (card.poster.image as any).height) }
          }
          u.u_ready.value = damp(u.u_ready.value, u.u_map.value ? 1 : 0, 6, props.dt)
          if (card.getHtml) { const t = card.getHtml(); if (t) { u.u_html.value = t; u.u_hasHtml.value = 1 } }
        },
        visibleWhen: () => props.stage === 'lab' || (props.lab > 0 && props.lab < 1),
      }
      card.item = item
      ufx.add(item)
      // live HTML label → texture (three-html-render); stays DOM if unavailable
      const label = cardEl.querySelector<HTMLElement>('.card__label')
      if (label && htmlRender.ok) {
        const clone = label.cloneNode(true) as HTMLElement
        clone.setAttribute('aria-hidden', 'true')
        clone.classList.add('card__label--tex')
        card.getHtml = htmlRender.add(clone, new THREE.Object3D())
      }
      this.cards.push(card)
      // posters are small: fetch them all up front so no card ever shows before its picture (ultrawide shows 4+)
      // PRELOAD (Shifat 10:51Z): the lab is the section after the hero, so its posters are part of the counter
      this.ensureMedia(card, p)
    })
  },
  ensureMedia(card: Card, p: (typeof PROJECTS)[number]) {
    if (card.poster) return
    preload.expect()
    const done = () => preload.arrived()
    card.poster = loader.load(p.poster, (t) => { done(); t.colorSpace = THREE.SRGBColorSpace; if (!card.video || card.video.paused) { card.mat.uniforms.u_map.value = t; card.mat.uniforms.u_mapSize.value.set((t.image as any).width, (t.image as any).height) } }, undefined, done)
    if (p.depth) loader.load(p.depth, (t) => { card.mat.uniforms.u_depth.value = t; card.mat.uniforms.u_hasDepth.value = 1 })
    const v = document.createElement('video')
    // PERF HOOK (Shifat 10:21Z: lower texture res on phones): phones play a 640×360 encode of the reel (-m.mp4): the
    // per-frame video→texture upload is 2.25x smaller and the card is ~400 device px wide there anyway
    v.src = settings.TIER === 'low' ? p.media.replace(/\.mp4$/, '-m.mp4') : p.media; v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'none'; v.crossOrigin = 'anonymous'
    v.setAttribute('aria-hidden', 'true')
    card.video = v
    card.vtex = new THREE.VideoTexture(v); card.vtex.colorSpace = THREE.SRGBColorSpace
  },
  unmount() { this.cards.forEach((c) => { ufx.remove(c.item); c.video?.pause(); c.vtex?.dispose() }); this.cards = []; this.track = null },
  measure() { this.cards.forEach((c) => ufx.measure(c.item)) },
  hover(id: string, on: boolean) { const c = this.cards.find((x) => x.id === id); if (c) c.hover = on ? 1 : 0 },
  update(vel: number, dt: number) {
    viewW.value = ufx.w
    // bend eases toward the (clamped) velocity and back to 0 at rest
    const ov = (window as any).__labBend as number | undefined // QA: force the bend to inspect its shape
    const target = ov ?? Math.max(-1, Math.min(1, vel / 4000)) * 0.35
    this.bend = damp(this.bend, target, 6, dt)
    bendX.value = this.bend
  },
}
