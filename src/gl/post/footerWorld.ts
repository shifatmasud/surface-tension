import * as THREE from 'three'
import { BlendFunction, Effect } from 'postprocessing'
import { WL_EDGE } from '../water/waterline'
import { journey } from '../stages/journey/journeyState'
import { props } from '../../state/props'
import { viewport } from '../../core/viewport'

/**
 * FOOTER MOCKUP (Shifat 13:23Z "Footer feels outside whole site. How to make it seamless", 13:24Z "cursor trail must work
 * on footer too"). Build-time switch VITE_FOOT: 0 = live behaviour (this effect is never created), 1 = A "light carries on",
 * 2 = B "waterline".
 *
 * Instead of the canvas element sliding up off the footer (which left the footer as a flat DOM slab outside the WebGL
 * world, with no trail on it), the canvas stays put and the curtain lifts INSIDE the frame: this effect rides in the Grade
 * pass (no extra pass), shifts the finished picture up by the same pixels the CSS transform did (mainUv) and draws the
 * footer's world in the rows the curtain uncovers. Everything after it (the locked trail distortion, SMAA, the blit) runs
 * over the footer too, so the cursor trail bends it like every other part of the site. ALU only, no textures, no target.
 *   A: flat curtain edge (the preloader's language); the footer is paper lit by slow caustic light from the water above.
 *   B: the curtain's lower edge is the water line itself (the dive's own wlEdge, a crisp meniscus, no band); the footer
 *      is the sunlit surface the loop resurfaces into, long soft glints drifting across it.
 */
export const FOOT_MODE: number = Number((import.meta as any).env?.VITE_FOOT ?? 2) || 0

export class FooterWorldEffect extends Effect {
  private t = 0
  private reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  constructor(mode: number) {
    super('FooterWorld', /* glsl */ `
      #define FOOT_MODE ${mode}
      uniform float u_fk;      // lift as a fraction of the screen height (0 = curtain down)
      uniform float u_fb;      // R7.07: the canvas below the visible bottom (address bar showing), as a fraction of its height
      uniform float u_ft;      // seconds
      uniform float u_fasp;    // width / height
      uniform float u_fvel;    // smoothed scroll speed, 0..1 (B: the line sloshes)
      uniform vec4 u_bar;      // W28 glow bar: the DOM track's rect in css px (x0, top, x1, bottom); x1 <= x0 = none
      uniform vec3 u_bfill;    // x: the bar's fill (eased like the DOM's .32 s transition), yz: the viewport in css px
      ${WL_EDGE}
      float fEdge(float x){
      #if FOOT_MODE == 2
        return u_fk + (wlEdge(x * u_fasp, u_ft) * (0.9 + 1.6 * u_fvel)) * smoothstep(0.0, 0.06, u_fk);
      #else
        return u_fk;
      #endif
      }
      void mainUv(inout vec2 uv){ if (u_fk > 0.0) uv.y -= u_fk; }
      // caustic net: a warped sine lattice, bright where it crosses zero (pool light), cheap, no texture
      float fnet(vec2 p, float t, float k){
        for (int i = 0; i < 3; i++) {
          float fi = float(i);
          p += k * vec2(sin(p.y * 1.7 + t * 0.6 + fi * 1.3), cos(p.x * 1.3 - t * 0.5 + fi * 2.1));
        }
        float v = abs(sin(p.x) * sin(p.y));
        return pow(1.0 - v, 10.0);
      }
      vec3 lin(vec3 s){ return pow(s, vec3(2.2)); }
      // W28 (Shifat 16:20Z "Trail must bend glowbar too"): the footer's lime bar is drawn HERE, inside the picture, so the
      // locked trail distortion that runs after this pass bends it like the water. It reproduces the DOM bar layer for layer
      // (contact.css .site-footer--world .overscroll__*: the 24 px #b8ff3c halo, the 9 px lime glow, the ink track, the fill's
      // 6/14 px box-shadow spill inside the track, the lime fill and its 3 px highlight), composited in display space the way
      // the browser composites CSS; the DOM bar stays for the no-GL page and goes transparent while this draws it.
      float ferf(float x){ float x2 = x * x; float t = sqrt(1.0 - exp(-x2 * (1.2732395 + 0.147 * x2) / (1.0 + 0.147 * x2))); return x < 0.0 ? -t : t; }
      float fgbox(float x, float a, float b, float s){ float k = 0.70710678 / s; return 0.5 * (ferf((x - a) * k) - ferf((x - b) * k)); }
      float fcap(vec2 p, vec2 a, vec2 b){ float r = 0.5 * (b.y - a.y); vec2 q = abs(p - 0.5 * (a + b)) - (0.5 * (b - a) - vec2(r)); return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
      vec3 footBar(vec3 col){
        if (u_bar.z <= u_bar.x) return col;
        vec2 pc = vec2(vUv.x * u_bfill.y, (1.0 - vUv.y) * u_bfill.z);
        float x0 = u_bar.x, yT = u_bar.y, x1 = u_bar.z, yB = u_bar.w, W = x1 - x0, f = u_bfill.x;
        if (pc.y < yT - 72.0 || pc.y > yB + 72.0 || pc.x < x0 - 80.0 || pc.x > x1 + 80.0) return col;
        const vec3 LIME = vec3(0.639, 1.0, 0.071);
        if (f > 0.001) {
          // the halo and the glow are blurred, THEN scaled by the fill (CSS filter before transform): local x = (x - origin) / f
          float cb = fgbox(6.0 + (pc.x - x0) / f, 0.0, W + 12.0, 24.0) * fgbox(pc.y, yB - 22.0, yB + 10.0, 24.0);
          col = mix(col, vec3(0.722, 1.0, 0.235), clamp(cb, 0.0, 1.0) * (0.45 + 0.4 * f));
          float ca = fgbox((pc.x - x0) / f, 0.0, W, 9.0) * fgbox(pc.y, yB - 12.0, yB, 9.0);
          col = mix(col, LIME, clamp(ca, 0.0, 1.0) * (0.55 + 0.45 * f));
        }
        float aa = u_bfill.z / resolution.y;      // css px per drawn pixel
        float ct = clamp(0.5 - fcap(pc, vec2(x0, yT), vec2(x1, yB)) / aa, 0.0, 1.0);
        if (ct <= 0.0) return col;
        vec3 c = vec3(0.0706, 0.0745, 0.0824);   // --c-ink #121315
        float xr = x0 + f * W;                    // the fill's right end (translateX((f - 1) * 100%))
        if (f > 0.001) {
          float sy2 = fgbox(pc.y, yT, yB, 7.0), sy1 = fgbox(pc.y, yT, yB, 3.0);
          c = mix(c, LIME, clamp(0.5 * (1.0 - ferf((pc.x - xr) * 0.70710678 / 7.0)) * sy2, 0.0, 1.0) * 0.8);
          c = mix(c, LIME, clamp(0.5 * (1.0 - ferf((pc.x - xr) * 0.70710678 / 3.0)) * sy1, 0.0, 1.0));
        }
        float cf = clamp(0.5 - fcap(pc, vec2(xr - W, yT), vec2(xr, yB)) / aa, 0.0, 1.0);
        c = mix(c, LIME, cf);
        c = mix(c, vec3(1.0), clamp(0.5 - fcap(pc, vec2(xr - W + 6.0, yT + 2.0), vec2(xr - 6.0, yT + 5.0)) / aa, 0.0, 1.0) * 0.55);
        return mix(col, c, ct);
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        outputColor = inputColor;
        if (u_fk <= 0.0) return;
        float sy = vUv.y - u_fb;              // screen y (0 = the VISIBLE bottom .. 1 top), unshifted
        float e = fEdge(vUv.x);
        // R6.92b (Shifat 9:03 AM: the footer water's top edge read hard and jaggy, worst on the phone's 0.5–0.75 background):
        // the curtain edge is drawn with analytic coverage over one drawn pixel (along its slope), not a hard step
        float fw = max(fwidth(e - sy), 0.5 / resolution.y);
        float fcov = clamp((e - sy) / fw + 0.5, 0.0, 1.0);
        if (fcov <= 0.0) return;
        vec2 q = vec2(vUv.x * u_fasp, sy);      // footer space, units of screen height
      #if FOOT_MODE == 1
        // A: paper under moving pool light. Base and peaks stay inside the band where the footer's small grey text keeps
        // AA (silver-3 #5f646b on the darkest base pixel #e7ebee = 5.0:1)
        float l = clamp(fnet(q * 14.0, u_ft, 0.55) * 0.9 + fnet(q * 9.0 + vec2(3.1, 1.7), u_ft * 0.8 + 2.0, 0.55) * 0.5, 0.0, 1.0);
        vec3 base = vec3(0.906, 0.922, 0.933), hi = vec3(0.99, 0.994, 0.998);
        outputColor = vec4(mix(inputColor.rgb, lin(footBar(mix(base, hi, l))), fcov), 1.0);
      #else
        // B: the sunlit surface seen from just above it, receding to the curtain's line (its horizon)
        float d = max(e - sy, 0.0);                       // below the line, in screen heights
        float z = 1.0 / (d * 3.2 + 0.12);                 // far rows bunch up at the line
        vec2 p = vec2((vUv.x - 0.5) * u_fasp * (0.35 + 0.9 * d) * 18.0, z * 3.2 + u_ft * 0.5);
        for (int i = 0; i < 2; i++) {
          float fi = float(i);
          p += vec2(0.5 * sin(p.y * 1.3 + u_ft * 0.5 + fi), 0.35 * cos(p.x * 1.1 - u_ft * 0.4 + fi * 2.0));
        }
        float g = pow(1.0 - abs(sin(p.x) * sin(p.y)), 8.0) * (0.5 + 0.5 * smoothstep(0.0, 0.3, d));
        vec3 base = vec3(0.886, 0.918, 0.937), hi = vec3(0.99, 0.995, 1.0);
        vec3 col = mix(base, hi, clamp(g, 0.0, 1.0));
        // the meniscus: one crisp bright line where the curtain meets the surface (~2 css px), no band, no gradient
        float px = 1.0 / resolution.y;
        col = mix(col, vec3(1.0), (1.0 - smoothstep(1.2 * px, 2.6 * px, e - sy)) * 0.9);
        outputColor = vec4(mix(inputColor.rgb, lin(footBar(col)), fcov), 1.0);
      #endif
      }`, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform<any>>([
        ['u_fk', new THREE.Uniform(0)], ['u_fb', new THREE.Uniform(0)], ['u_ft', new THREE.Uniform(0)], ['u_fasp', new THREE.Uniform(1)], ['u_fvel', new THREE.Uniform(0)],
        ['u_bar', new THREE.Uniform(new THREE.Vector4(0, 0, 0, 0))], ['u_bfill', new THREE.Uniform(new THREE.Vector3(0, 1, 1))],
      ]),
    })
    // the DOM bar goes transparent while this pass draws it (contact.css html.foot-glbar); it stays for the no-GL page
    if (typeof document !== 'undefined') {
      document.documentElement.classList.add('foot-glbar')
      const dirty = () => { this.barDirty = true }
      window.addEventListener('resize', dirty) // the bar's rect follows the visible bottom (address bar too): re-read it (a rect read, no re-allocation)
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(dirty)
        const hook = () => { const root = document.querySelector('.site-footer'); if (!root) return false; for (const el of Array.from(root.children)) ro.observe(el); return true }
        if (!hook()) requestAnimationFrame(function again() { if (!hook()) requestAnimationFrame(again) })
      }
      document.fonts?.ready?.then(dirty)
    }
  }
  /** the DOM track's rect, read only when something could have moved it (resize, the footer's blocks resizing, fonts) */
  private barDirty = true
  private measureBar() {
    const el = document.querySelector<HTMLElement>('.site-footer .overscroll__track')
    if (!el) return
    this.barDirty = false
    const r = el.getBoundingClientRect()
    ;(this.uniforms.get('u_bar')!.value as THREE.Vector4).set(r.left, r.top, r.right, r.bottom)
  }
  /** the DOM fill rode a .32 s transition on var(--ease) (cubic-bezier(0.19, 1, 0.22, 1)), restarted from where it is
   *  whenever --f changes; the same here, so the GL fill moves exactly as the DOM one did */
  private bf = 0; private bfFrom = 0; private bfTo = 0; private bfT = 1
  private static ease(x: number) {
    // cubic-bezier(0.19, 1, 0.22, 1): solve x(t) = x by Newton, return y(t)
    const ax = 3 * 0.19, bx = 3 * (0.22 - 0.19) - ax, cx = 1 - ax - bx
    const ay = 3, by = 3 * (1 - 1) - ay, cy = 1 - ay - by
    let t = x
    for (let i = 0; i < 6; i++) { const xt = ((cx * t + bx) * t + ax) * t - x, d = (3 * cx * t + 2 * bx) * t + ax; if (Math.abs(d) < 1e-6) break; t = Math.min(1, Math.max(0, t - xt / d)) }
    return ((cy * t + by) * t + ay) * t
  }
  private vel = 0
  private kd = -1
  private footEl: HTMLElement | null = null
  update(_r: THREE.WebGLRenderer, _i: THREE.WebGLRenderTarget, dt = 0.016) {
    const u = this.uniforms
    const h = Math.max(1, props.height)
    u.get('u_fk')!.value = Math.max(0, journey.lift || 0) / h
    u.get('u_fb')!.value = Math.max(0, h - (viewport.vis || h)) / h   // R7.07
    if (!this.reduced) this.t += Math.min(dt, 0.1)
    u.get('u_ft')!.value = this.t
    u.get('u_fasp')!.value = (props.width || h) / h
    const v = Math.min(1, Math.abs(props.scrollDelta || 0) / 40)
    this.vel += (v - this.vel) * Math.min(1, dt * 4)
    u.get('u_fvel')!.value = this.reduced ? 0 : this.vel
    // R6.89 (Shifat 5:25 AM "reveal footer … the CTA and footer must never overlap or paint over each other"): the curtain's
    // lower edge is the sloshing water line, which dips below the straight line the footer's DOM is uncovered by; the DOM is
    // uncovered that much later (--kd: the line's deepest dip right now), so none of its text ever paints over the page
    {
      const fk = Math.max(0, journey.lift || 0) / h, s = Math.min(1, fk / 0.06), sm = s * s * (3 - 2 * s)
      const kd = FOOT_MODE === 2 ? Math.ceil(0.019 * (0.9 + 1.6 * (this.reduced ? 0 : this.vel)) * sm * h) + 1 : 0
      if (kd !== this.kd) { this.kd = kd; (this.footEl ??= document.querySelector<HTMLElement>('.site-footer'))?.style.setProperty('--kd', `${kd}px`) }
    }
    // the glow bar: rect + fill
    if ((journey.lift || 0) > 0 && this.barDirty) this.measureBar()
    const f = Math.min(1, Math.max(0, props.overscroll || 0))
    if (this.reduced) this.bf = f
    else {
      if (Math.abs(f - this.bfTo) > 1e-4) { this.bfFrom = this.bf; this.bfTo = f; this.bfT = 0 }
      this.bfT = Math.min(1, this.bfT + Math.min(dt, 0.1) / 0.32)
      this.bf = this.bfFrom + (this.bfTo - this.bfFrom) * FooterWorldEffect.ease(this.bfT)
    }
    ;(u.get('u_bfill')!.value as THREE.Vector3).set(this.bf, props.width || 1, props.height || 1)
  }
}
