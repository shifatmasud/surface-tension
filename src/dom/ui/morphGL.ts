import { viewport, PHONE } from '../../core/viewport'
/**
 * MOCKUP v2 (Shifat 11:44–11:46Z): the slide image comes TOWARD the viewer as a soft body, settles flat, and only then
 * does the card reveal from behind it. A tiny dedicated WebGL canvas draws the flying image as a 32×32 plane:
 * per-vertex delayed progress (top corners lead, bottom corners lag) so the edges really bend, a forward z swell with
 * perspective (the plane comes at you and bulges convex), and a soft landing that flattens it.
 * TUNE (Shifat 16:41 PT Oct 21: "Image to card wooble animation must be fluid gentler. Its too much snappy bouncy now"):
 * same path, calmer. The flight ease is a soft-start ease-out (peak speed 1.75x average, was the 3x of a cubic in-out),
 * the flight is 10 % longer, and the landing is one critically damped breath (≈2 % toward the viewer, peaking 1/5 into
 * the settle, starting and ending at rest, no reversal) instead of the ζ 0.45 spring (19 % rebound, then a dip behind).
 * One canvas, created on the first open and reused; it only draws while an image is in flight.
 */
export type MR = { left: number; top: number; width: number; height: number; radius: number }

export const SB = {
  AMP: 1.0,       // master strength (0.5 = half)
  SPREAD: 0.32,   // per-vertex delay spread: top corners lead, bottom corners lag
  Z: 0.28,        // forward swell at mid-flight, fraction of the focal length (≈1.5× apparent size at the peak)
  BOW: 0.075,     // convex bulge: edges bow outward at mid-flight (fraction of size)
  PULL: 0.03,     // the leading (top) corners pull up and out
  LIFT: 0.06,     // the body rises on its way (fraction of viewport height)
  SETTLE: 720,    // ms of soft landing after the flight (TUNE: was 560)
  LAND: 0.12,     // TUNE: landing breath strength (× SPR_Z / SPR_BOW); the old spring peaked at 1.0
  OUT: 1.4,       // TUNE: ease-out shape of the flight (1 = symmetric smoothstep; higher = earlier, longer tail)
  SPR_Z: 0.16,    // landing rebound toward the viewer (fraction of focal)
  SPR_BOW: 0.07,  // landing bulge
  LIGHT: 0.10,    // soft light on the near parts of the plane
}

const N = 32
/** R6.94: how much of the slide's own grade the plane carries at the slide end (0 = none) */
const GRADE = 1
const VS = `
attribute vec2 a_uv;
uniform vec4 u_a; uniform vec4 u_b; uniform vec2 u_res;
uniform float u_pp, u_spr, u_spread, u_z, u_bow, u_pull, u_lift, u_sz, u_sbow, u_amp, u_dir, u_ts, u_out;
varying vec2 v_uv; varying float v_z; varying vec2 v_sz; varying float v_eg;
// TUNE: soft start (zero speed), long ease-out tail; the close (u_dir < 0, progress runs 1 → 0) mirrors it so it too
// leaves gently and eases into the slide
float eo(float x){ float w = 1.-pow(1.-x, u_out); return w*w*(3.-2.*w); }
float ease(float x){ x=clamp(x,0.,1.); return u_dir > 0. ? eo(x) : 1.-eo(1.-x); }
void main(){
  vec2 uv = a_uv;
  float ax = abs(2.*uv.x-1.);
  // lead 1 = top corners (arrive first), 0 = bottom (arrive last)
  float lead = (1.-uv.y)*(0.8 + 0.2*ax*ax);
  float d = u_spread*(1.-lead);
  float pv = clamp((u_pp - d)/(1.-u_spread), 0., 1.);
  float e = ease(pv);
  float eg = ease(u_pp);
  vec2 A = u_a.xy + uv*u_a.zw, B = u_b.xy + uv*u_b.zw;
  vec2 P = mix(A, B, e);
  vec2 sz = mix(u_a.zw, u_b.zw, eg);
  vec2 C = mix(u_a.xy + .5*u_a.zw, u_b.xy + .5*u_b.zw, eg);
  float bump = sin(3.14159*e);                 // per vertex: 0 at both ends, 1 mid-flight
  float bumpG = sin(3.14159*eg);
  // landing spring, a ripple that reaches the lagging bottom a touch later
  float sp = u_spr;
  float dome = (1.-(2.*uv.x-1.)*(2.*uv.x-1.))*(1.-(2.*uv.y-1.)*(2.*uv.y-1.));
  // convex bulge: edges bow outward (strongest at edge middles), and the body rises
  vec2 q = uv*2.-1.;
  vec2 bow = vec2(q.x*(1.-q.y*q.y)*sz.x, q.y*(1.-q.x*q.x)*sz.y);
  P += bow*(u_bow*bump + u_sbow*sp)*u_amp;
  P += vec2(q.x*sz.x, -sz.y)*(1.-uv.y)*u_pull*bump*u_amp*vec2(1.,.6);
  P.y -= u_lift*u_res.y*bumpG*u_amp;
  // depth toward the viewer, with perspective about the body's own centre
  float f = 1.25*max(u_res.x, u_res.y);
  float z = f*u_amp*(u_z*bumpG*(0.9+0.1*lead) + 0.35*u_z*bumpG*dome + u_sz*sp*(0.6+0.4*dome));
  float s = f/max(f - z, 0.2*f);
  P = C + (P - C)*s;
  v_uv = uv; v_z = z/f; v_sz = sz; v_eg = eg;
  gl_Position = vec4(P.x/u_res.x*2.-1., 1.-P.y/u_res.y*2., 0., 1.);
}`
const FS = `
precision highp float;
uniform sampler2D u_tex; uniform float u_ia, u_ra, u_rb, u_light, u_alpha, u_osa, u_grade;
varying vec2 v_uv; varying float v_z; varying vec2 v_sz; varying float v_eg;
void main(){
  float ba = v_sz.x/v_sz.y;
  vec2 t = v_uv;
  if (ba > u_ia) t.y = .5 + (t.y-.5)*(u_ia/ba); else t.x = .5 + (t.x-.5)*(ba/u_ia);
  // R6.94: the slide's own overscan at the slide end, the card's plain cover at the card end (no zoom jump either side)
  t = .5 + (t-.5)*mix(u_osa, 1., v_eg);
  vec3 c = texture2D(u_tex, t).rgb;
  // R6.94: the slide's levels + S-curve (labGL W24) at the slide end, easing to the card's plain picture
  if (u_grade > 0.) {
    vec3 sq = sqrt(pow(max(c, vec3(0.)), vec3(2.2)));
    sq = clamp((sq - 0.075) / 0.94, 0., 1.);
    sq = mix(sq, sq*sq*(3.-2.*sq), 0.45);
    c = mix(pow(sq*sq, vec3(1./2.2)), c, clamp(v_eg + (1. - u_grade), 0., 1.));
  }
  c *= 1. + u_light*clamp(v_z*4., -1., 1.);
  float r = mix(u_ra, u_rb, v_eg);
  vec2 p = (v_uv-.5)*v_sz; vec2 h = .5*v_sz - r;
  float dd = length(max(abs(p)-h, 0.)) - r;
  float a = clamp(.5 - dd, 0., 1.)*u_alpha;
  gl_FragColor = vec4(c*a, a);
}`

type Tex = { tex: WebGLTexture; aspect: number }
class Morph {
  cv: HTMLCanvasElement | null = null
  gl: WebGLRenderingContext | null = null
  pr: WebGLProgram | null = null
  u: Record<string, WebGLUniformLocation | null> = {}
  n = 0
  tex = new Map<string, Tex>()
  failed = false

  init() {
    if (this.gl || this.failed) return !!this.gl
    try {
      const cv = document.createElement('canvas')
      cv.className = 'morph-gl'; cv.setAttribute('aria-hidden', 'true')
      Object.assign(cv.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', zIndex: '72', pointerEvents: 'none', display: 'none' })
      { const u = PHONE ? '100svh' : '100dvh'; if (typeof CSS !== 'undefined' && CSS.supports('height', u)) cv.style.height = u }   // R7.07: phones 100svh, everything else 100dvh
      const gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false }) as WebGLRenderingContext | null
      if (!gl) { this.failed = true; return false }
      const sh = (t: number, s: string) => { const o = gl.createShader(t)!; gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o) || 'sh'); return o }
      const pr = gl.createProgram()!
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr)
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('link')
      const uv: number[] = []; const ix: number[] = []
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) uv.push(i / N, j / N)
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1; ix.push(a, c, b, b, c, d) }
      const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW)
      const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(ix), gl.STATIC_DRAW)
      gl.useProgram(pr)
      const loc = gl.getAttribLocation(pr, 'a_uv'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
      for (const k of ['u_a', 'u_b', 'u_res', 'u_pp', 'u_spr', 'u_spread', 'u_z', 'u_bow', 'u_pull', 'u_lift', 'u_sz', 'u_sbow', 'u_amp', 'u_dir', 'u_ts', 'u_out', 'u_tex', 'u_ia', 'u_ra', 'u_rb', 'u_light', 'u_alpha', 'u_osa', 'u_grade']) this.u[k] = gl.getUniformLocation(pr, k)
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      document.body.appendChild(cv)
      this.cv = cv; this.gl = gl; this.pr = pr; this.n = ix.length
      return true
    } catch { this.failed = true; return false }
  }

  async texture(src: string): Promise<Tex | null> {
    const hit = this.tex.get(src); if (hit) return hit
    const gl = this.gl!; const im = new Image(); im.decoding = 'async'; im.src = src
    try { await Promise.race([im.decode(), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 400))]) } catch { if (!im.complete || !im.naturalWidth) return null }
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const t = { tex, aspect: im.naturalWidth / im.naturalHeight }; this.tex.set(src, t); return t
  }

  /** fly from→to. dir 1 = open (slide→card), -1 = close (card→slide, the open played backwards).
   *  Resolves when the plane has settled FLAT on `to`; call hide() once the DOM under it has taken over. */
  vtex: WebGLTexture | null = null
  /** R6.94: the plane can carry the slide's live reel (`video`), re-uploaded every frame of the flight, so the picture
   *  keeps playing from the frame the slide was on; until the reel has a frame, the poster stands in (what the slide
   *  showed too). `overscan` = the slide's framing at the slide end (labGL LAB_OVERSCAN), eased to the card's cover. */
  async fly(from: MR, to: MR, src: string, dir: 1 | -1, ms: number, opt: { video?: HTMLVideoElement | null; overscan?: number } = {}): Promise<{ flat: Promise<void>; hide: () => void } | null> {
    if (!this.init()) return null
    const vid = opt.video && opt.video.readyState >= 2 && opt.video.videoWidth ? opt.video : null
    const t = vid ? null : await this.texture(src); if (!vid && !t) return null
    const gl = this.gl!, cv = this.cv!
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = viewport.w, H = viewport.h
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr) }
    cv.style.display = 'block'
    gl.viewport(0, 0, cv.width, cv.height); gl.useProgram(this.pr)
    if (vid) {
      if (!this.vtex) {
        this.vtex = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, this.vtex)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      }
      gl.bindTexture(gl.TEXTURE_2D, this.vtex)
    } else gl.bindTexture(gl.TEXTURE_2D, t!.tex)
    const up = () => { if (!vid) return; gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vid) } catch { /* a frame that cannot be read keeps the last one */ } }
    up()
    const A = dir > 0 ? from : to, B = dir > 0 ? to : from   // geometry is always slide (A) → card (B)
    const U = this.u
    gl.uniform4f(U.u_a, A.left, A.top, A.width, A.height); gl.uniform4f(U.u_b, B.left, B.top, B.width, B.height)
    gl.uniform2f(U.u_res, W, H); gl.uniform1f(U.u_ia, vid ? vid.videoWidth / vid.videoHeight : t!.aspect); gl.uniform1f(U.u_osa, opt.overscan ?? 1); gl.uniform1f(U.u_grade, (opt.overscan ?? 1) < 1 ? GRADE : 0); gl.uniform1f(U.u_ra, A.radius); gl.uniform1f(U.u_rb, B.radius)
    gl.uniform1f(U.u_spread, SB.SPREAD); gl.uniform1f(U.u_z, SB.Z); gl.uniform1f(U.u_bow, SB.BOW); gl.uniform1f(U.u_pull, SB.PULL)
    gl.uniform1f(U.u_lift, SB.LIFT); gl.uniform1f(U.u_sz, SB.SPR_Z); gl.uniform1f(U.u_sbow, SB.SPR_BOW); gl.uniform1f(U.u_light, SB.LIGHT)
    gl.uniform1f(U.u_dir, dir); gl.uniform1f(U.u_out, SB.OUT); gl.uniform1f(U.u_alpha, 1); gl.uniform1i(U.u_tex, 0)
    const settle = dir > 0 ? SB.SETTLE : SB.SETTLE * 0.75, sAmp = dir > 0 ? SB.LAND : SB.LAND * 0.6
    // TUNE: a critically damped breath, (t/τ)² e^(2(1 − t/τ)): 0 with zero speed at touchdown, 1 at τ, ~0 by the end
    const tau = settle / 5000
    const t0 = performance.now()
    let done!: () => void; const flat = new Promise<void>((r) => { done = r })
    let stop = false
    const draw = () => {
      if (stop) return
      const qh = (window as any).__morphGLHold as number | undefined   // QA: freeze the flight at a fraction 0..1 of flight + landing
      const el = qh != null ? qh * (ms + settle) : performance.now() - t0
      const p = Math.min(1, el / ms)
      const pp = dir > 0 ? p : 1 - p
      const ts = Math.max(0, el - ms) / 1000
      const k = ts / tau, spr = el > ms ? sAmp * k * k * Math.exp(2 - 2 * k) * Math.max(0, 1 - ts * 1000 / settle) : 0
      gl.uniform1f(U.u_pp, pp); gl.uniform1f(U.u_spr, spr); gl.uniform1f(U.u_amp, SB.AMP); gl.uniform1f(U.u_ts, ts)
      up()
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawElements(gl.TRIANGLES, this.n, gl.UNSIGNED_SHORT, 0)
      if (el >= ms + settle && qh == null) { done(); return }
      requestAnimationFrame(draw)
    }
    draw()
    const hide = () => { stop = true; requestAnimationFrame(() => { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); cv.style.display = 'none' }) }
    return { flat, hide }
  }
}
export const morphGL = new Morph()
