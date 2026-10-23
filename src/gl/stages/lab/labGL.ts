import * as THREE from 'three'
import { preload } from '../../../services/preload'
import { ufx, type UfxItem } from '../../ufx/ufx'
import { props, shared } from '../../../state/props'
import { settings, browser } from '../../../services/settings'
import { PROJECTS } from '../../../content/site'
import { damp } from '../../../core/math'
import { Spring } from '../../../core/spring'
import { dive } from '../dive/diveState'
import { DIVE_COMMON } from '../dive/shaders'
import { SlideFluid, FLUID_GLSL } from './slideFluid'
import { heroPass } from '../../post/heroPass' // R6.87 SPLIT

/**
 * SLIDES (Shifat 17:49Z): "Project slides no need appear animation. Over animation is bad. They should naturally live in
 * underwater scene. Make them positioned in a cylinder curve layout too. Ensure cursor move fluid displaces each slide image".
 *
 * The three work slides are panels standing in the deep water on the INSIDE OF A CYLINDER CENTRED ON THE LENS: every
 * slide is the same distance from the eye, curved along the arc, turned to face it, one arc step (≈25° on desktop)
 * apart. Scrolling turns the arc past the lens (the world moves; the camera never does), and the slide at the centre is
 * pixel-true to its DOM card (radius = the lens distance), so the slide→card morph starts exactly where the reel is.
 *  - no entrance animation of any kind: no fade, scale, lift, stagger or grey→colour ramp; on screen = in place
 *  - full colour on every slide (REVIEW-visual #10); depth comes from the deep's own fog (shaders.ts deepWater/deepFog,
 *    the same water colour the scene fades to) and a little defocus away from the centre, never desaturation
 *  - lit like the water around them: soft light from above and a faint caustic shimmer (brightness only)
 *  - a slow sway (a few px) — nothing else moves on its own
 *  - the pointer / a finger moving across a slide drags its image like water (slideFluid.ts), then it settles
 *  - reduced motion: the same static arc, no sway, no fluid
 * The DOM cards stay the interaction + accessibility truth: each gets the same cylinder transform in CSS 3D (also the
 * visible layer on the no-WebGL page), so hover / click / focus land on the slide you see.
 * ENG #7: nothing here reads layout per frame — card rects are measured on resize, the sticky shelf position is computed.
 */

/** SCENE CONTRACT: the arc's frame, in CSS px. x / z move the cylinder's axis away from the lens (0, 0 = centred on
 *  the camera, Shifat's ask); y moves the arc's centre line from the DOM slot's (0 = the card band's own centre).
 *  radius: null = the lens distance (the centred slide is pixel-true to its DOM card). The one-scene lane sets these
 *  from its world map at merge; nothing else here needs to change. */
export const LAB_ARC_ORIGIN = { x: 0, y: 0, z: 0, radius: null as number | null }

/** UI STATES mockup: how far a pressed slide sinks (fraction of its size) and its release spring (f Hz, zeta) */
const PRESS_DEPTH = 0.03, PRESS_F = 2.6, PRESS_ZETA = 0.55
const VERT = /* glsl */ `
#define PRESS_DEPTH ${PRESS_DEPTH.toFixed(3)}
uniform float u_R, u_phi, u_ax, u_az, u_cy, u_w, u_h, u_time, u_sway, u_seed, u_press;
varying vec2 v_uv;
varying vec3 v_dir;
void main(){
  v_uv = uv;
  // the slide is a strip of the cylinder: local x walks along the arc (arc length = card px), y stays upright
  float t = u_time;
  // UI STATES mockup: a press sinks the slide toward its centre (3 % at full press), released on a spring
  vec2 pp = position.xy * (1.0 - PRESS_DEPTH * u_press);
  float th = u_phi + pp.x * u_w / u_R + sin(t * 0.31 + u_seed * 1.7) * 0.0022 * u_sway;
  float bob = sin(t * 0.47 + u_seed * 2.3) * 3.0 * u_sway;
  vec3 w = vec3(u_ax + u_R * sin(th), u_cy + pp.y * u_h + bob, u_az - u_R * cos(th));
  w += modelMatrix[3].xyz;   // ufx's boundary drift (0 inside the lab's block)
  v_dir = w - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`

const FRAG = /* glsl */ `
${DIVE_COMMON}
${FLUID_GLSL}
uniform sampler2D u_map, u_html;
uniform float u_hasHtml, u_radius, u_opacity, u_ready, u_off, u_fx, u_rise, u_vid;
// three uploads a VideoTexture as plain RGBA8 and only decodes it inside its built-in materials: decode the reel's sRGB
// here (the poster is a normal sRGB texture, hardware-decoded), so the playing reel keeps its true blacks and colour
vec3 dec(vec3 c){ return u_vid > 0.5 ? mix(pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045)))) : c; }
uniform vec2 u_size, u_mapSize;
varying vec2 v_uv;
varying vec3 v_dir;
float rbox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
vec2 coverUV(vec2 st){
  float ca = u_size.x / u_size.y, ma = u_mapSize.x / max(u_mapSize.y, 1.0);
  vec2 uv = st - 0.5;
  if (ca > ma) uv.y *= ma / ca; else uv.x *= ca / ma;
  return uv * 0.96 + 0.5;                       // a little overscan, so the fluid never drags the edge in
}
void main(){
  // card px, origin top-left, y down (the splats are written in the same frame)
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y) * u_size;
  float hl = 0.0;
  vec2 d = u_fx > 0.5 ? slideFluid(p, u_size.x, hl) : vec2(0.0);
  vec2 st = (p + d) / u_size;
  vec2 uv = clamp(coverUV(vec2(st.x, 1.0 - st.y)), 0.001, 0.999);
  // defocus away from the centre of the arc (depth of field), 4 taps around the centre one
  float b = u_off * 0.0045;
  vec3 col = dec(texture2D(u_map, uv).rgb);
  if (b > 0.0004){
    vec2 o = vec2(b, b * u_size.x / u_size.y);
    col = col * 0.36 + (dec(texture2D(u_map, uv + vec2(o.x, o.y)).rgb) + dec(texture2D(u_map, uv + vec2(-o.x, o.y)).rgb)
        + dec(texture2D(u_map, uv + vec2(o.x, -o.y)).rgb) + dec(texture2D(u_map, uv - o).rgb)) * 0.16;
  }
  // until the first picture arrives, a dark water-grey plate (no fade: the picture replaces it when it lands)
  col = mix(vec3(0.06, 0.08, 0.1), col, u_ready);
  if (u_hasHtml > 0.5) {
    vec4 h = texture2D(u_html, v_uv);
    float lum = dot(h.rgb / max(h.a, 1e-3), vec3(0.333));
    float m = h.a * smoothstep(0.9, 0.99, lum) * (1.0 - smoothstep(0.14, 0.2, v_uv.y));
    col = mix(col, vec3(1.0), m);
  }
  // W24: the reels are mastered low-contrast (near-black ~17/255 and mid-grey type) and read muddy under the water:
  // a gentle levels + S-curve in perceptual space, the same curve on every channel (hues and saturation kept)
  if (u_vid > 0.5 || u_ready > 0.5) {
    vec3 sq = sqrt(max(col, vec3(0.0)));
    sq = clamp((sq - 0.075) / 0.94, 0.0, 1.0);
    sq = mix(sq, sq * sq * (3.0 - 2.0 * sq), 0.45);
    col = sq * sq;
  }
  // the water's light: a little brighter toward the surface, and a faint caustic shimmer drifting over the panel —
  // brightness only, the reel's colours stay true
  float shim = vnoise(p / u_size.x * 7.0 + vec2(u_time * 0.21, -u_time * 0.17)) + vnoise(p / u_size.x * 13.0 - vec2(u_time * 0.13, u_time * 0.25));
  shim = pow(1.0 - abs(shim - 1.0), 6.0);
  col *= (0.955 + 0.05 * v_uv.y) * (1.0 + 0.06 * shim * u_fx);
  // the fluid's crest: a thin specular line, never a veil
  col += vec3(0.9, 0.95, 1.0) * clamp(hl, 0.0, 1.0) * 0.07;
  // the deep's own fog density (shaders.ts deepFog), stronger the further round the arc a slide stands — as VALUE and
  // contrast only (Shifat: "no colour affected by underwater"): the picture dims toward the deep's darkness with its hues
  // and saturation kept, never tinted teal or greyed
  float fogK = u_amb * deepFog(7.0 + 9.0 * u_off);
  vec3 deepV = vec3(dot(deepWater(normalize(v_dir)), vec3(0.2126, 0.7152, 0.0722)));
  // (W24: the lift toward the water's value is 0.6× — the full lift greyed the side slides' blacks into a veil)
  col = mix(col, col * 0.42 + deepV * 0.6, fogK);
  // while the shelf is still coming up out of the deep (before it pins) the water below is thicker: the slides rise out
  // of the deep's own fog colour as the world moves (scroll-mapped, never timed; the panel stays solid), so they never
  // sit bright under the dive's last lines of copy
  // (the band: a slide is still deep in the fog while any of it could reach the slot's copy — its pinned bottom sits
  // ≥ 0.22 vh above the copy at 1440 and ≥ 0.3 vh at 390 — and stands clear in the last 0.04 vh of the climb)
  // (deepWater() is the volume's colour before the backdrop's own absorption; scaled to what the deep reads behind the
  // shelf at this depth — measured 0/36/65 sRGB at 1440 — so the fogged slide sits in the water, not as a lighter slab)
  col = mix(col, deepWater(normalize(v_dir)) * vec3(0.25, 0.34, 0.52), smoothstep(0.04, 0.22, u_rise) * 0.98);
  vec2 px = (v_uv - 0.5) * u_size;
  float sd = rbox(px, u_size * 0.5, u_radius);
  float a = 1.0 - smoothstep(-1.0, 0.5, sd);
  gl_FragColor = vec4(col, a * u_opacity);
}`

type Geo = { baseX: number; relY: number; w: number; h: number }
type Card = {
  id: string; el: HTMLElement; item: UfxItem; mat: THREE.ShaderMaterial; video?: HTMLVideoElement; vtex?: THREE.VideoTexture
  poster?: THREE.Texture; vt?: number; getHtml?: (() => THREE.Texture | null) | null
  geo: Geo; phi: number; fluid: SlideFluid; seed: number; css: string; pressT: number; pressS: Spring
}

const loader = new THREE.TextureLoader()
const RVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype
const geo = new THREE.PlaneGeometry(1, 1, 40, 2)
const QA = new URLSearchParams(location.search).has('qa')
const MOTION = !browser.reducedMotion

/** pointer / finger over the page (passive: never blocks scrolling). Touch keeps reporting while the page scrolls. */
const ptr = { x: -1, y: -1, px: -1, py: -1, moved: false, has: false, down: false, t: 0 }
function onPMove(e: PointerEvent) { if (e.pointerType === 'touch') return; setPtr(e.clientX, e.clientY) }
function onTMove(e: TouchEvent) { const t = e.touches[0]; if (t) setPtr(t.clientX, t.clientY) }
function onTStart(e: TouchEvent) { const t = e.touches[0]; if (!t) return; ptr.has = false; setPtr(t.clientX, t.clientY); ptr.down = true }
function onTEnd() { ptr.down = false; ptr.has = false }
function setPtr(x: number, y: number) {
  if (!ptr.has) { ptr.px = x; ptr.py = y; ptr.has = true }
  ptr.x = x; ptr.y = y; ptr.moved = true
}

const _v = new THREE.Vector3()
export const labGL = {
  track: null as HTMLElement | null,
  inner: null as HTMLElement | null,
  section: null as HTMLElement | null,
  cards: [] as Card[],
  /** cards lifted out into the detail card (slide→card morph): the GL copy hides while the DOM morph flies */
  hidden: new Set<string>(),
  /** arc position in slide units (0 = the first slide centred) and its step (rad) */
  q: 0, primed: false, step: 0.45, R: 1000, D: 1000,
  sec: { top: 0, h: 0, padT: 0, padB: 0, pinH: 0, trackTop: 0 },
  persp: '',
  gl: false,
  mount(el: HTMLElement) {
    this.track = el
    this.inner = el.closest<HTMLElement>('.lab__inner')
    this.section = el.closest<HTMLElement>('section')
    this.gl = settings.USE_GL
    window.addEventListener('pointermove', onPMove, { passive: true })
    window.addEventListener('touchstart', onTStart, { passive: true })
    window.addEventListener('touchmove', onTMove, { passive: true })
    window.addEventListener('touchend', onTEnd, { passive: true })
    window.addEventListener('touchcancel', onTEnd, { passive: true })
    const cardEls = Array.from(el.querySelectorAll<HTMLElement>('.card'))
    if (this.gl) document.documentElement.classList.add('lab-gl')
    cardEls.forEach((cardEl, i) => {
      const id = cardEl.dataset.id!
      const p = PROJECTS.find((x) => x.id === id)!
      const fluid = new SlideFluid()
      const card: Card = { id, el: cardEl, item: null as any, mat: null as any, geo: { baseX: 0, relY: 0, w: 0, h: 0 }, phi: 0, fluid, seed: i * 1.37 + 0.4, css: '', pressT: 0, pressS: new Spring(0, PRESS_F, PRESS_ZETA, 0) }
      this.cards.push(card)
      if (!this.gl) return
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
        uniforms: {
          u_map: { value: null }, u_html: { value: null }, u_hasHtml: { value: 0 }, u_radius: { value: 14 }, u_opacity: { value: 1 },
          u_ready: { value: 0 }, u_off: { value: 0 }, u_rise: { value: 0 }, u_vid: { value: 0 }, u_fx: { value: MOTION ? 1 : 0 },
          u_size: { value: new THREE.Vector2(1, 1) }, u_mapSize: { value: new THREE.Vector2(16, 9) },
          u_R: { value: 1000 }, u_phi: { value: 0 }, u_ax: { value: 0 }, u_az: { value: 0 }, u_cy: { value: 0 },
          u_w: { value: 1 }, u_h: { value: 1 }, u_press: { value: 0 }, u_sway: { value: MOTION ? 1 : 0 }, u_seed: { value: card.seed },
          u_sp: { value: fluid.sp }, u_st: { value: fluid.st }, u_n: { value: 0 },
          // the deep's shared look (DiveStage drives the same numbers from the dive state)
          u_time: shared.u_time, u_amb: { value: 0 }, u_abyss: { value: 0 },
        },
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.renderOrder = 5
      card.mat = mat
      const media = cardEl.querySelector<HTMLElement>('.card__dom')!
      card.item = {
        el: media, mesh, layer: 'under', selfPlaced: true, docTop: 0, docLeft: 0, w: 0, h: 0,
        measure: () => { card.item.w = card.geo.w; card.item.h = card.geo.h },
        onUpdate: () => this.draw(card, p),
        visibleWhen: () => this.onScreen(card),
      }
      ufx.add(card.item)
      heroPass.add(mesh, true) // R6.87 SPLIT RESOLUTION: the project slides (images + reels) draw at the canvas density
      // (Shifat 18:52Z, no duplicate labels: the slot's "Work · 0n / 03" line already carries the number and the tags,
      // so the slide no longer paints its own label texture)
      // posters are small: fetch them all up front so no card ever shows before its picture
      this.ensureMedia(card, p)
    })
    this.measure()
    if (QA) (window as any).__slides = this
  },
  /** the sticky shelf's screen top (computed, no layout read): it pins at 0 between the section's padded ends */
  shelfTop() {
    const s = props.scroll, S = this.sec
    const lo = S.top + S.padT, hi = Math.max(lo, S.top + S.h - S.padB - S.pinH)
    return Math.min(hi, Math.max(lo, s)) - s
  },
  /** drawn only while its panel is actually on screen: the slides are always there in the water and simply scroll into
   *  and out of view with the world (Shifat 18:14Z: nothing pops, fades or scales into existence); off screen they cost
   *  no draw, and the reels only decode inside the lab segment (W19 perf item, see draw()) */
  onScreen(c: Card) {
    if (this.hidden.has(c.id) || Math.abs(c.phi) > 1.35) return false
    const top = this.shelfTop() + c.geo.relY + LAB_ARC_ORIGIN.y - c.geo.h * 0.7
    return top < props.height && top + c.geo.h * 1.4 > 0
  },
  /** ENG #7: everything layout-dependent, once per resize (transforms cleared so the reads are the untransformed slots) */
  measure() {
    const tr = this.track, inner = this.inner, sec = this.section
    if (!tr || !inner || !sec) return
    tr.style.transform = ''
    for (const c of this.cards) c.el.style.transform = ''
    const ri = inner.getBoundingClientRect(), rs = sec.getBoundingClientRect(), rt = tr.getBoundingClientRect()
    const cs = getComputedStyle(sec)
    this._tl = rt.left
    this.sec = { top: rs.top + window.scrollY, h: rs.height, padT: parseFloat(cs.paddingTop) || 0, padB: parseFloat(cs.paddingBottom) || 0, pinH: ri.height, trackTop: rt.top - ri.top }
    for (const c of this.cards) {
      const r = c.el.getBoundingClientRect()
      c.geo = { baseX: r.left + r.width / 2, relY: r.top - ri.top + r.height / 2, w: r.width, h: r.height }
      if (c.item) { c.item.w = r.width; c.item.h = r.height }
      c.css = ''
    }
    const vh = window.innerHeight, vw = window.innerWidth
    // the lens: ufx's pixel-true camera distance (z = 0 maps 1 CSS px to 1 px)
    this.D = (vh / 2) / Math.tan(THREE.MathUtils.degToRad(15))
    this.R = LAB_ARC_ORIGIN.radius ?? this.D
    // the arc step: one slide's arc width plus a gap (≈25° on desktop; tighter on a phone so the neighbours peek in)
    const w = this.cards[0]?.geo.w ?? 600
    const gap = Math.min(200, Math.max(26, vw * 0.12 - 20))
    this.step = (w + gap) / this.R
    this.persp = ''
    this.place()
  },
  /** Lab.tsx: the reader's place in the shelf, in slides (dwell already applied) */
  update(q: number, dt: number) {
    const reduce = !MOTION
    this.q = this.primed && !reduce ? damp(this.q, q, 8, dt) : q
    this.primed = true
    this.place()
    this.pointer()
    // outside the lab segment nothing draws, so no reel decodes either
    if (!(props.lab > 0 && props.lab < 1)) for (const c of this.cards) if (c.video && !c.video.paused) c.video.pause()
  },
  /** the cylinder: each slide's angle, and the DOM card's matching CSS 3D transform (write-only, only on change) */
  place() {
    const vw = window.innerWidth, vh = window.innerHeight
    const shelf = this.shelfTop()
    // CSS perspective = the same lens, its eye at the viewport centre (in the track's own box)
    const po = `${(vw / 2 - this.trackLeft()).toFixed(1)}px ${(vh / 2 - shelf - this.sec.trackTop).toFixed(1)}px`
    if (this.track && po !== this.persp) {
      this.persp = po
      this.track.style.perspective = `${this.D.toFixed(1)}px`
      this.track.style.perspectiveOrigin = po
    }
    const R = this.R, D = this.D, ax = LAB_ARC_ORIGIN.x, az = LAB_ARC_ORIGIN.z
    this.cards.forEach((c, i) => {
      c.phi = (i - this.q) * this.step
      const x = vw / 2 + ax + R * Math.sin(c.phi) - c.geo.baseX
      const z = (D - az) - R * Math.cos(c.phi)
      const css = Math.abs(c.phi) > 1.35 ? 'translate3d(0,0,-99999px)'
        : `translate3d(${x.toFixed(2)}px,${LAB_ARC_ORIGIN.y.toFixed(1)}px,${z.toFixed(2)}px) rotateY(${(-c.phi).toFixed(5)}rad)`
      if (css !== c.css) { c.css = css; c.el.style.transform = css }
    })
  },
  _tl: 0,
  /** the track's left edge in the viewport (measured with the resize pass) */
  trackLeft() { return this._tl },
  /** ufx world → screen px (the pixel-true lens) */
  project(p: THREE.Vector3, out: { x: number; y: number }) {
    const cam = ufx.camera.position, k = this.D / Math.max(1, cam.z - p.z)
    out.x = ufx.w / 2 + (p.x - cam.x) * k; out.y = ufx.h / 2 - (p.y - cam.y) * k
    return out
  },
  /** a slide's centre line in ufx world y */
  cy(c: Card) { return -(this.shelfTop() + c.geo.relY + LAB_ARC_ORIGIN.y - ufx.h / 2) },
  /** screen point → that slide's local px (top-left origin), or null when the ray misses it */
  hit(c: Card, sx: number, sy: number) {
    const cam = ufx.camera.position
    const dx = sx - ufx.w / 2, dy = ufx.h / 2 - sy, dz = -this.D
    // ray (cam + t·d) against the cylinder |xz − axis| = R, the far root (the camera is inside)
    const axx = LAB_ARC_ORIGIN.x, azz = cam.z - LAB_ARC_ORIGIN.z
    const ox = cam.x - axx, oz = cam.z - azz
    const A = dx * dx + dz * dz, B = 2 * (ox * dx + oz * dz), C = ox * ox + oz * oz - this.R * this.R
    const disc = B * B - 4 * A * C
    if (disc < 0) return null
    const t = (-B + Math.sqrt(disc)) / (2 * A)
    const hx = cam.x + t * dx - axx, hz = cam.z + t * dz - azz, hy = cam.y + t * dy
    const th = Math.atan2(hx, -hz)
    const lx = (th - c.phi) * this.R + c.geo.w / 2
    const ly = -(hy - this.cy(c)) + c.geo.h / 2
    return { x: lx, y: ly }
  },
  /** pointer / finger → splats on the slide under it */
  pointer() {
    if (!this.gl || !MOTION) { ptr.moved = false; ptr.px = ptr.x; ptr.py = ptr.y; return }
    const t = shared.u_time.value as number, dt = Math.max(props.dt, 1 / 240)
    const moved = ptr.moved && ptr.has && (Math.abs(ptr.x - ptr.px) + Math.abs(ptr.y - ptr.py) > 0.5)
    for (const c of this.cards) {
      c.fluid.prune(t)
      if (!moved || !c.item?.mesh.visible || props.overlayOpen) continue
      const a = this.hit(c, ptr.px, ptr.py), b = this.hit(c, ptr.x, ptr.y)
      if (!a || !b) continue
      const inside = (h: { x: number; y: number }) => h.x > -8 && h.y > -8 && h.x < c.geo.w + 8 && h.y < c.geo.h + 8
      if (!inside(a) && !inside(b)) continue
      let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt
      const sp = Math.hypot(vx, vy), cap = c.geo.w * 2.2
      if (sp > cap) { vx *= cap / sp; vy *= cap / sp }
      // one splat per ~4 % of the slide's width travelled (at least one), spread along the segment
      const len = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.min(4, Math.round(len / (c.geo.w * 0.04))))
      const str = Math.min(1, 0.35 + len / (c.geo.w * 0.08))
      for (let k = 1; k <= n; k++) {
        const f = k / n
        c.fluid.add(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, vx, vy, str, t - (1 - f) * dt)
      }
    }
    ptr.px = ptr.x; ptr.py = ptr.y; ptr.moved = false
  },
  draw(card: Card, p: (typeof PROJECTS)[number]) {
    const it = card.item, u = card.mat.uniforms
    it.mesh.position.set(0, 0, 0)
    const cam = ufx.camera.position
    u.u_R.value = this.R; u.u_phi.value = card.phi
    u.u_ax.value = LAB_ARC_ORIGIN.x; u.u_az.value = cam.z - LAB_ARC_ORIGIN.z
    u.u_cy.value = this.cy(card)
    u.u_w.value = card.geo.w; u.u_h.value = card.geo.h
    u.u_size.value.set(card.geo.w, card.geo.h)
    const off = Math.min(2, Math.abs(card.phi) / Math.max(1e-3, this.step))
    u.u_off.value = off
    u.u_rise.value = Math.max(0, this.shelfTop() / Math.max(1, props.height))
    u.u_opacity.value = this.hidden.has(card.id) ? 0 : 1
    // the deep's look, from the shared dive state (the same mapping DiveStage uses for its own water)
    const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
    u.u_amb.value = dive.active ? ss(-9, -22, dive.camY) : 1
    u.u_abyss.value = dive.abyss
    u.u_n.value = card.fluid.n
    u.u_press.value = MOTION ? card.pressS.update(card.pressT, Math.min(Math.max(props.dt, 1 / 240), 0.1)) : 0
    // video: only the slide at the centre of the arc plays
    this.ensureMedia(card, p)
    if (card.video) {
      // PRELOAD: reels stay unrequested until the lab is near
      if (card.video.preload === 'none') card.video.preload = 'metadata'
      const want = off < 0.5 && props.lab > 0 && props.lab < 1 && !(window as any).__labPause // QA: __labPause holds every card on its poster
      if (want && card.video.paused) card.video.play().catch(() => {})
      else if (!want && !card.video.paused) card.video.pause()
      // W19 (visual P0-1, the black card after a card closes): "playing" also needs a FRESH decoded frame (the
      // video-frame callback that also feeds three's upload); a stalled reel falls back to its poster, never a black plate
      const fresh = RVFC ? performance.now() - (card.vt ?? -1e9) < 2500 : card.video.currentTime > 0
      const playing = !card.video.paused && card.video.readyState >= 2 && fresh
      if (card.vtex && playing) { u.u_map.value = card.vtex; u.u_vid.value = 1; u.u_mapSize.value.set(card.video.videoWidth, card.video.videoHeight) }
      else if (card.poster?.image && u.u_map.value !== card.poster) { u.u_map.value = card.poster; u.u_vid.value = 0; u.u_mapSize.value.set((card.poster.image as any).width, (card.poster.image as any).height) }
    }
    // no fade-in: the picture is simply there once it has arrived
    u.u_ready.value = u.u_map.value ? 1 : 0
    if (card.getHtml) { const t = card.getHtml(); if (t) { u.u_html.value = t; u.u_hasHtml.value = 1 } }
  },
  ensureMedia(card: Card, p: (typeof PROJECTS)[number]) {
    if (card.poster) return
    preload.expect()
    const done = () => preload.arrived()
    card.poster = loader.load(p.poster, (t) => { done(); t.colorSpace = THREE.SRGBColorSpace; if (!card.video || card.video.paused) { card.mat.uniforms.u_map.value = t; card.mat.uniforms.u_vid.value = 0; card.mat.uniforms.u_mapSize.value.set((t.image as any).width, (t.image as any).height) } }, undefined, done)
    this.makeVideo(card, p)
  },
  /** the card's own reel: a detached muted video + its texture (W19: also rebuilt from scratch when the detail card closes) */
  makeVideo(card: Card, p: (typeof PROJECTS)[number]) {
    const v = document.createElement('video')
    // PERF HOOK (Shifat 10:21Z: lower texture res on phones): phones play a 640×360 encode of the reel (-m.mp4)
    v.src = settings.TIER === 'low' ? p.media.replace(/\.mp4$/, '-m.mp4') : p.media; v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'none'; v.crossOrigin = 'anonymous'
    v.setAttribute('aria-hidden', 'true')
    card.video = v
    if (RVFC) { const cb = () => { card.vt = performance.now(); (v as any).requestVideoFrameCallback(cb) }; (v as any).requestVideoFrameCallback(cb) }
    card.vtex = new THREE.VideoTexture(v); card.vtex.colorSpace = THREE.SRGBColorSpace
  },
  unmount() {
    window.removeEventListener('pointermove', onPMove); window.removeEventListener('touchstart', onTStart)
    window.removeEventListener('touchmove', onTMove); window.removeEventListener('touchend', onTEnd); window.removeEventListener('touchcancel', onTEnd)
    this.cards.forEach((c) => { if (c.item) ufx.remove(c.item); c.video?.pause(); c.vtex?.dispose(); c.el.style.transform = '' })
    this.cards = []; this.track = null; this.primed = false
  },
  /** where the slide is drawn right now, in CSS px (the projected bounds of its curved panel), for the slide→card morph */
  rectOf(id: string) {
    const c = this.cards.find((x) => x.id === id)
    if (!c) return null
    if (!this.gl) {
      const r = c.el.getBoundingClientRect()
      return { left: r.left, top: r.top, width: r.width, height: r.height, radius: 14 }
    }
    const cam = ufx.camera.position, cy = this.cy(c), ax = LAB_ARC_ORIGIN.x, az = cam.z - LAB_ARC_ORIGIN.z
    let l = 1e9, r = -1e9, t = 1e9, b = -1e9
    const o = { x: 0, y: 0 }
    for (let k = 0; k <= 8; k++) {
      const th = c.phi + (k / 8 - 0.5) * c.geo.w / this.R
      for (const sy of [-0.5, 0.5]) {
        this.project(_v.set(ax + this.R * Math.sin(th), cy + sy * c.geo.h, az - this.R * Math.cos(th)), o)
        l = Math.min(l, o.x); r = Math.max(r, o.x); t = Math.min(t, o.y); b = Math.max(b, o.y)
      }
    }
    // a pressed slide is drawn smaller about its centre: the morph starts from the size you see
    const k = 1 - PRESS_DEPTH * (MOTION ? c.pressS.value : 0), cx = (l + r) / 2, cyy = (t + b) / 2
    return { left: cx - (r - l) * k / 2, top: cyy - (b - t) * k / 2, width: (r - l) * k, height: (b - t) * k, radius: 14 * k * this.D / this.R }
  },
  /** W19: the detail card closed — put this card back on its poster and make its reel prove a fresh frame again */
  restore(id: string) {
    const c = this.cards.find((x) => x.id === id); if (!c) return
    this.hidden.delete(id); c.vt = undefined; c.fluid.clear()
    const u = c.mat?.uniforms
    if (u && c.poster?.image) { u.u_map.value = c.poster; u.u_vid.value = 0; u.u_mapSize.value.set((c.poster.image as any).width, (c.poster.image as any).height) }
  },
  /** kept for the DOM card's hover / focus handlers: the slides no longer lift or tilt (Shifat: no over-animation) */
  hover(_id: string, _on: boolean) {},
  /** UI STATES mockup: a finger / mouse / Enter press on the slide's DOM card (services/press.ts) */
  press(id: string, on: boolean) {
    const c = this.cards.find((x) => x.id === id); if (c) c.pressT = on ? 1 : 0
  },
  /** QA (?qa): each slide's angle, drawn rect and live splats */
  state() {
    return this.cards.map((c) => ({ id: c.id, phiDeg: +(c.phi * 57.2958).toFixed(2), rect: this.rectOf(c.id), splats: c.fluid.n, visible: !!c.item?.mesh.visible }))
  },
}
