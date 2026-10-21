import * as THREE from 'three'
import { BlendFunction, Effect } from 'postprocessing'
import { WL_EDGE } from '../water/waterline'
import { journey } from '../stages/journey/journeyState'
import { props } from '../../state/props'

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
      uniform float u_ft;      // seconds
      uniform float u_fasp;    // width / height
      uniform float u_fvel;    // smoothed scroll speed, 0..1 (B: the line sloshes)
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
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        outputColor = inputColor;
        if (u_fk <= 0.0) return;
        float sy = vUv.y;                     // screen y (0 bottom .. 1 top), unshifted
        float e = fEdge(vUv.x);
        if (sy >= e) return;
        vec2 q = vec2(vUv.x * u_fasp, sy);      // footer space, units of screen height
      #if FOOT_MODE == 1
        // A: paper under moving pool light. Base and peaks stay inside the band where the footer's small grey text keeps
        // AA (silver-3 #5f646b on the darkest base pixel #e7ebee = 5.0:1)
        float l = clamp(fnet(q * 14.0, u_ft, 0.55) * 0.9 + fnet(q * 9.0 + vec2(3.1, 1.7), u_ft * 0.8 + 2.0, 0.55) * 0.5, 0.0, 1.0);
        vec3 base = vec3(0.906, 0.922, 0.933), hi = vec3(0.99, 0.994, 0.998);
        outputColor = vec4(lin(mix(base, hi, l)), 1.0);
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
        outputColor = vec4(lin(col), 1.0);
      #endif
      }`, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform<any>>([
        ['u_fk', new THREE.Uniform(0)], ['u_ft', new THREE.Uniform(0)], ['u_fasp', new THREE.Uniform(1)], ['u_fvel', new THREE.Uniform(0)],
      ]),
    })
  }
  private vel = 0
  update(_r: THREE.WebGLRenderer, _i: THREE.WebGLRenderTarget, dt = 0.016) {
    const u = this.uniforms
    const h = Math.max(1, props.height)
    u.get('u_fk')!.value = Math.max(0, journey.lift || 0) / h
    if (!this.reduced) this.t += Math.min(dt, 0.1)
    u.get('u_ft')!.value = this.t
    u.get('u_fasp')!.value = (props.width || h) / h
    const v = Math.min(1, Math.abs(props.scrollDelta || 0) / 40)
    this.vel += (v - this.vel) * Math.min(1, dt * 4)
    u.get('u_fvel')!.value = this.reduced ? 0 : this.vel
  }
}
