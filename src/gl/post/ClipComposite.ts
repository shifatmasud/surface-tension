import * as THREE from 'three'
import { Effect, EffectAttribute } from 'postprocessing'
import { fboHelper } from '../core/fbo'
import { clip } from '../systems/clip'
import { props } from '../../state/props'

/**
 * ClipComposite — the last pass (order 3000) of the clipped-sections transition (see systems/clip.ts).
 * Outside a boundary it only keeps a copy of the frame while the next block approaches.
 * During a boundary: the live frame (the incoming block's scene) shows inside the card — a rounded rect
 * whose top edge is the incoming section's top — shifted down for the inner parallax; everything outside
 * it is the outgoing block's captured frame, scaled about its (lagging) centre, darkened, with its own
 * rounded corners, over a near-black underlay. Card edges are antialiased in the shader (1 css px).
 */
export class ClipCompositeEffect extends Effect {
  private slots: { key: number; rt: THREE.WebGLRenderTarget; used: number }[] = []
  private w = 1; private h = 1; private tick = 0
  constructor() {
    super('ClipComposite', /* glsl */ `
      uniform sampler2D u_snap;
      uniform float u_on, u_has, u_swap, u_yTop, u_shift, u_scale, u_lag, u_dark, u_radius, u_inset, u_outRadius, u_px, u_xfade, u_t;
      uniform vec2 u_view;
      uniform vec3 u_under;
      float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        if (u_on < 0.5) { outputColor = inputColor; return; }
        if (u_xfade > 0.5) {
          // reduced motion: no card move — a soft crossfade from the outgoing frame to the live one
          // the outgoing frame softens (8-tap disc, radius grows with t) as it fades
          vec3 sn = inputColor.rgb;
          if (u_has > 0.5) {
            vec2 rr = (2.0 + 10.0 * u_t) / u_view;
            sn = texture2D(u_snap, uv).rgb * 0.2;
            for (int i = 0; i < 8; i++) { float a = float(i) * 0.785398; sn += texture2D(u_snap, uv + vec2(cos(a), sin(a)) * rr).rgb * 0.1; }
          }
          // u_swap: scrolling up, the live frame is the upper block (fading out) and the still is the lower one
          float k = smoothstep(0.15, 0.85, u_t);
          outputColor = vec4(u_swap > 0.5 ? mix(inputColor.rgb, sn, k) : mix(sn, inputColor.rgb, k), 1.0); return;
        }
        vec2 px = vec2(uv.x, 1.0 - uv.y) * u_view;                    // css px, origin top-left
        // card: from the boundary down past the bottom edge (only its top corners are ever seen)
        float r = u_radius;
        vec2 c0 = vec2(u_inset, u_yTop), c1 = vec2(u_view.x - u_inset, u_view.y + r + 2.0);
        float sdC = sdRound(px - 0.5 * (c0 + c1), 0.5 * (c1 - c0), r);
        float inC = clamp(0.5 - sdC / u_px, 0.0, 1.0);
        vec2 uvCard = vec2(uv.x, uv.y + u_shift / u_view.y);
        // outgoing: the captured frame, scaled about its lagging centre
        vec2 C = vec2(0.5 * u_view.x, 0.5 * u_view.y - u_lag);
        vec2 q = 0.5 * u_view + (px - C) / u_scale;                    // where this pixel was when captured
        float sdO = sdRound(q - 0.5 * u_view, 0.5 * u_view, u_outRadius / u_scale);
        float inO = clamp(0.5 - sdO * u_scale / u_px, 0.0, 1.0);
        // the outgoing frame drifts up slower than the scroll (no scale, no dimming — Shifat 08:37Z); in the thin gutters
        // beside the card, below the frame's bottom edge, its last rows are mirrored so no empty band ever shows
        if (q.y > u_view.y) { q.y = 2.0 * u_view.y - q.y; inO = 1.0; }
        vec2 uvOut = vec2(q.x / u_view.x, 1.0 - q.y / u_view.y);
        // scrolling down: the card (lower block) is live, the upper block is its last live frame;
        // scrolling up (u_swap): the upper block is live, the card holds the lower block's last live frame
        vec3 cardC, upC;
        if (u_swap > 0.5) {
          cardC = u_has > 0.5 ? texture2D(u_snap, uvCard).rgb : texture2D(inputBuffer, uvOut).rgb;
          upC = texture2D(inputBuffer, uvOut).rgb;
        } else {
          cardC = texture2D(inputBuffer, uvCard).rgb;
          upC = u_has > 0.5 ? texture2D(u_snap, uvOut).rgb : texture2D(inputBuffer, uvCard).rgb;
        }
        vec3 outC = mix(u_under, upC * (1.0 - u_dark), inO);
        outputColor = vec4(mix(outC, cardC, inC), 1.0);
      }`, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['u_snap', new THREE.Uniform(null)], ['u_on', new THREE.Uniform(0)], ['u_has', new THREE.Uniform(0)], ['u_swap', new THREE.Uniform(0)],
        ['u_yTop', new THREE.Uniform(0)], ['u_shift', new THREE.Uniform(0)], ['u_scale', new THREE.Uniform(1)],
        ['u_lag', new THREE.Uniform(0)], ['u_dark', new THREE.Uniform(0)], ['u_radius', new THREE.Uniform(0)],
        ['u_inset', new THREE.Uniform(0)], ['u_outRadius', new THREE.Uniform(0)], ['u_px', new THREE.Uniform(1)], ['u_xfade', new THREE.Uniform(0)], ['u_t', new THREE.Uniform(0)],
        ['u_view', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['u_under', new THREE.Uniform(new THREE.Color('#0b0c0e').convertSRGBToLinear())],
      ]),
    })
  }
  u(name: string) { return this.uniforms.get(name)! }
  setSize(width: number, height: number) {
    this.w = width; this.h = height
    for (const s of this.slots) s.rt.setSize(width, height)
  }
  private slot(key: number, create: boolean) {
    let s = this.slots.find((x) => x.key === key)
    if (!s && create) {
      if (this.slots.length < 2) { s = { key, rt: fboHelper.createRenderTarget(this.w, this.h, { float: true }), used: 0 }; this.slots.push(s) }
      else { s = this.slots.reduce((a, b) => (a.used < b.used ? a : b)); s.key = key }
    }
    if (s) s.used = ++this.tick
    return s
  }
  update(_r: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget) {
    if (clip.capture >= 0) {
      const s = this.slot(clip.capture, true)!
      if (s.rt.width !== inputBuffer.width || s.rt.height !== inputBuffer.height) s.rt.setSize(inputBuffer.width, inputBuffer.height)
      fboHelper.copy(inputBuffer.texture, s.rt)
    }
    const on = clip.boundary
    this.u('u_on').value = on ? 1 : 0
    if (!on) return
    // the still block's slot holds its frame from when it was last the live render (copied every frame while live)
    const s = clip.still >= 0 ? this.slot(clip.still, false) : undefined
    this.u('u_swap').value = clip.liveUpper ? 1 : 0
    this.u('u_has').value = s ? 1 : 0
    this.u('u_snap').value = s ? s.rt.texture : null
    ;(this.u('u_view').value as THREE.Vector2).set(props.width, props.height)
    this.u('u_px').value = 1 / Math.max(1, props.dpr)
    this.u('u_yTop').value = clip.yTop; this.u('u_shift').value = clip.shift; this.u('u_scale').value = clip.scale
    this.u('u_lag').value = clip.lag; this.u('u_dark').value = clip.dark; this.u('u_radius').value = clip.radius
    this.u('u_xfade').value = clip.reduced ? 1 : 0; this.u('u_t').value = clip.t
    this.u('u_inset').value = clip.inset; this.u('u_outRadius').value = clip.outRadius
  }
}
