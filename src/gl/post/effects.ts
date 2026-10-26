import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { shared } from '../../state/props'
import { BLUE_NOISE } from '../shaders/chunks'
import { WL_EDGE } from '../water/waterline'
import { TRAIL_HR, u_trailField } from '../systems/ScreenPaint'

/**
 * ScreenPaintDistortion (ch.14 S.6) — order 75. Smears the finished frame along the paint velocity
 * with 9 taps (blue-noise jittered start) and adds the phase-shifted sine fringe in the fading wake.
 * The reference composites in 8-bit display space, so the taps are averaged and the fringe is added
 * on sRGB-encoded values and decoded back for the linear chain — same numbers, same look.
 * u_iridescence is an extra thin-film pass on the wake edges (off = 1:1 with the reference).
 * ?paintdebug draws the trail over a flat grey field so the trail can be judged on its own.
 */
/** R7.07 HI-RES TRAIL (Shifat 12:15 PM Oct 24: "Hi res the cursor trail without performance issue"). The trail field is
 *  a 1/4-size texture (ScreenPaint), and one bilinear read of it per pixel drew its piecewise-linear ridges and texel
 *  steps as blocky, diamond-shaped edges in the smear. The field and the shader maths are unchanged (look locked); only how
 *  the field is READ changes: 1 = the same single tap with a smooth (C1) in-texel curve (zero extra texture reads: phones
 *  and weak PCs), 2 = a 4-tap B-spline bicubic (C2, desktop/tablet only). ?trailf=0 = 7.06's plain bilinear read. */
export function trailFilterMode(lowOrWeak: boolean) {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
  const f = q && q.has('trailf') ? parseInt(q.get('trailf') || '0', 10) : (lowOrWeak ? 1 : 2)
  return f === 0 || f === 1 || f === 2 ? f : 1
}
export class ScreenPaintDistortionEffect extends Effect {
  /** R7.08: true = the field arrives pre-reconstructed (ScreenPaint's display field) and the wake fringe is drawn in the
   *  final blit at the canvas's full density (PostChain.blit); this pass keeps only the smear, and skips it where empty */
  readonly hr: boolean
  constructor(trailF = 0) {
    const hr = TRAIL_HR
    const debug = typeof location !== 'undefined' && /[?&]paintdebug/.test(location.search)
    super('ScreenPaintDistortion', /* glsl */ `
      #define SPD_F ${hr ? 0 : trailF}
      #define SPD_HR ${hr ? 1 : 0}
      uniform sampler2D u_screenPaintTexture;
      uniform vec2 u_screenPaintTexelSize;
      uniform float u_amount, u_rgbShift, u_multiplier, u_colorMultiplier, u_shade, u_iridescence, u_debug;
      ${BLUE_NOISE}
      vec3 spd_encode(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      vec3 spd_decode(vec3 c){ c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      vec4 spd_paint(vec2 uv){
      #if SPD_F == 1
        vec2 sz = 1.0 / u_screenPaintTexelSize, p = uv * sz + 0.5, i = floor(p), f = p - i;
        f = f * f * (3.0 - 2.0 * f);
        return texture2D(u_screenPaintTexture, (i + f - 0.5) * u_screenPaintTexelSize);
      #elif SPD_F == 2
        vec2 tx = u_screenPaintTexelSize, p = uv / tx - 0.5, f = fract(p); p -= f;
        vec2 f2 = f * f, f3 = f2 * f;
        vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
        vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
        vec2 g0 = w0 + w1, g1 = w2 + w3, h0 = (w1 / g0 - 0.5 + p) * tx, h1 = (w3 / g1 + 1.5 + p) * tx;
        return g0.y * (g0.x * texture2D(u_screenPaintTexture, h0) + g1.x * texture2D(u_screenPaintTexture, vec2(h1.x, h0.y)))
             + g1.y * (g0.x * texture2D(u_screenPaintTexture, vec2(h0.x, h1.y)) + g1.x * texture2D(u_screenPaintTexture, h1));
      #else
        return texture2D(u_screenPaintTexture, uv);
      #endif
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec3 bn = getBlueNoise(gl_FragCoord.xy + vec2(17.0, 29.0));
        vec4 data = spd_paint(uv);
      #if SPD_HR == 1
        // R7.08: nothing painted here (the display field is exactly at rest): the 7.07 result is the input clamped to 1 (each
        // tap was clamped in display space), so skip the 9 taps and the 27 pow() calls on every untouched pixel
        if (data.z + data.w < 0.002 && u_debug < 0.5) { outputColor = vec4(clamp(inputColor.rgb, 0.0, 1.0), 1.0); return; }
      #endif
      #if SPD_F > 0
        data += (vec4(bn.yz, bn.xy) - 0.5) * (1.0 / 255.0);           // R7.07: the field is 8-bit, a 1-level blue-noise dither hides its steps (no extra reads)
      #endif
        float weight = (data.z + data.w) * 0.5;
        vec2 vel = (0.5 - data.xy - 0.001) * 2.0 * weight;           // signed, flipped, fades with paint
        vec2 stepUv = vel * u_amount / 4.0 * u_screenPaintTexelSize * u_multiplier;
        vec2 p = uv + bn.xy * stepUv;                                 // jittered first tap kills banding
        vec4 acc = vec4(0.0);
        for (int i = 0; i < 9; i++) { vec4 s = texture2D(inputBuffer, p); acc += vec4(min(spd_encode(s.rgb), 1.0), s.a); p += stepUv; }  // each tap as the reference's 8-bit buffer holds it
        acc /= 9.0;
        if (u_debug > 0.5) acc = vec4(vec3(0.5 + 0.35 * weight), 1.0);
        // wake fringe: strongest where weight is low, gone above 0.4 (R7.08 hi-res: drawn by the final blit at full density)
      #if SPD_HR == 0
        acc.rgb += sin(vec3(vel.x + vel.y) * 40.0 + vec3(0.0, 2.0, 4.0) * u_rgbShift)
                 * smoothstep(0.4, -0.9, weight) * u_shade * max(abs(vel.x), abs(vel.y)) * u_colorMultiplier;
      #endif
        if (u_iridescence > 0.0) {
          // accumulated thin film on the wake edges: the long-tail weight is the film thickness,
          // the weight gradient finds the edges; off by default (the reference has only the sine fringe)
          vec2 tx = u_screenPaintTexelSize;
          float bx = texture2D(u_screenPaintTexture, uv + vec2(tx.x, 0.0)).z - texture2D(u_screenPaintTexture, uv - vec2(tx.x, 0.0)).z;
          float by = texture2D(u_screenPaintTexture, uv + vec2(0.0, tx.y)).z - texture2D(u_screenPaintTexture, uv - vec2(0.0, tx.y)).z;
          float edge = smoothstep(0.02, 0.22, length(vec2(bx, by))) * smoothstep(0.0, 0.08, data.z);
          float film = data.z * 2.4 + (data.x - data.y) * 1.5 + bn.z * 0.08;
          vec3 thin = 0.5 + 0.5 * cos(6.28318 * (film + vec3(0.0, 0.33, 0.67)));
          acc.rgb = mix(acc.rgb, acc.rgb * (0.65 + thin * 0.7) + thin * 0.06, edge * u_iridescence);
        }
      #if SPD_HR == 1
        // alpha x0.997 = "the trail is here": the final blit draws the fringe only on pixels whose alpha is under 0.999 (the
        // untouched ones are written at exactly 1.0 above). The NORMAL blend mixes by this alpha, so 0.3% of the unbent input
        // shows through (under 1/255 at full contrast: invisible); alpha 0 would discard the smear entirely
        outputColor = vec4(spd_decode(clamp(acc.rgb, 0.0, 1.0)), acc.a * 0.997);
      #else
        outputColor = vec4(spd_decode(clamp(acc.rgb, 0.0, 1.0)), acc.a);
      #endif
      }`, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform<any>>([
        ['u_screenPaintTexture', (hr ? u_trailField : shared.u_currPaintTexture) as any],   // R7.08: the type and heroes share this uniform, so they read the display field too
        ['u_screenPaintTexelSize', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['u_amount', new THREE.Uniform(3)],
        ['u_rgbShift', new THREE.Uniform(0.5)],
        ['u_multiplier', new THREE.Uniform(5)],
        ['u_colorMultiplier', new THREE.Uniform(10)],
        ['u_shade', new THREE.Uniform(1.25)],
        ['u_iridescence', new THREE.Uniform(0)],
        ['u_debug', new THREE.Uniform(debug ? 1 : 0)],
        // W25 R6.45 (Shifat 09:16Z "restore it to this", the R6.20 trail; LOCKED): the shader above is R6.20's exactly. These
        // uniforms are still fed by PostChain (dark-wall mode, sticker/stone keep-outs) but the R6.20 shader does not read them.
        ['u_dark', new THREE.Uniform(0)],
        ['u_stk', new THREE.Uniform([new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()])],
        ['u_stkOn', new THREE.Uniform(0)],
        ['u_view', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['u_gem', new THREE.Uniform(new THREE.Vector4())],
        ['u_blueNoise', shared.u_blueNoise as any],
        ['u_blueNoiseOffset', shared.u_blueNoiseOffset as any],
        ['u_blueNoiseSize', shared.u_blueNoiseSize as any],
      ]),
    })
    this.hr = hr
  }
  u(name: string) { return this.uniforms.get(name)! }
  /** The paint keeps the reference's own resolution (ScreenPaint.resize), independent of the render DPR, so the
   * velocity step follows the paint texture's size every frame rather than the composer size. */
  update() {
    const s = shared.u_paintTextureSize.value
    this.u('u_screenPaintTexelSize').value.set(1 / Math.max(1, s.x), 1 / Math.max(1, s.y))
  }
}

/**
 * Grade ("Final", ch.8.5) — order 30. Our own grading: exposure, saturation, contrast, brightness,
 * tint, a soft vignette, a fade toward the section colour, and a blue-noise 1/255 dither to kill banding.
 * Also hosts the surface-break band for the dive (a refractive waterline swept across the frame).
 */
/** the grade's lens mainUv (the waterline meniscus, ripple, droplets, crossing wobble); a no-op while u_waterline < -0.5 */
const WL_HARD = /[?&]wlhard\b/.test(location.search)   // R7.10 b6: the old sub-pixel waterline edge
const WL_OLD = /[?&]wlold\b/.test(location.search)   // R7.11 b6: ?wlold = b5's two-band waterline (QA A/B)
const GRADE_UV = /* glsl */ `void mainUv(inout vec2 uv){
        if (u_waterline > -0.5) {
          float L = wlLine(uv);
          float d = uv.y - L;
          float t = u_wlTime;
          // the meniscus: water climbing the dome is a thin cylindrical lens along the line; it pulls the image toward
          // the line (a magnified sliver of both worlds) and shivers along x
          // R7.11 b6 (Shifat, real M02s: "Why the double air water intersection line?"): the lens was ±0.02 of the screen wide
          // at 2.5x, so it blew the crisp line and the slivers either side of it up into bands; now ±0.01 at 1.4x: one line
          float band = exp(-d * d * ${WL_OLD ? '2200.0' : '9000.0'});
          uv.y -= band * d * ${WL_OLD ? '0.6' : '0.3'};
          uv.x += band * 0.003 * wlNoise(uv.x * u_aspect * 30.0 + t * 0.8) * u_wlMo;
          // the underwater half: refraction ripple, and the slight magnification of the water (n = 1.33) about the line
          float uw = smoothstep(0.0, -0.012, d) * u_wlK;
          vec2 rp = vec2(sin(uv.y * 38.0 + t * 1.6 + 2.0 * sin(uv.x * u_aspect * 9.0)), cos(uv.x * u_aspect * 31.0 - t * 1.3 + uv.y * 7.0));
          uv += uw * rp * 0.0024 * u_wlMo;
          float Lm = min(L, 1.0);
          uv.y = mix(uv.y, Lm + (uv.y - Lm) * 0.95, uw);
          // droplets above the line: each a tiny inverted lens
          vec3 dr = wlDrop(uv);
          #ifdef WL_AA
          uv -= dr.xy * dr.z * 0.010 * smoothstep(1.0, 2.5, wlR / 24.0 / texelSize.y);   // R7.10 b9: sub-pixel drops do not refract
          #else
          uv -= dr.xy * dr.z * 0.010;
          #endif
          // the crossing: the frame wobbles once as the line rises past the lens
          if (u_wlWob > 0.0) {
            float w = u_wlWob * u_wlMo;
            uv += w * vec2(0.010 * sin(uv.y * 14.0 + t * 3.1 + sin(uv.x * 6.0)), 0.014 * sin(uv.x * u_aspect * 10.0 - t * 2.7 + uv.y * 4.0));
          }
        }
      }`
export class GradeEffect extends Effect {
  /** R7.10: withUv = false builds the same grade without its mainUv (a UV transform cannot share an EffectPass with a
   *  convolution effect such as SMAA); used only on frames whose waterline is hidden, where mainUv does nothing */
  constructor(withUv = true) {
    super(withUv ? 'Grade' : 'GradeNoUv', /* glsl */ `
      uniform float u_exposure, u_saturation, u_contrast, u_brightness, u_vignette, u_vignetteSoft, u_fade, u_lift;
      uniform float u_liftK, u_expK;   // R7.11 b6b: the background pass's share of the lift (GRADE_CHAIN only; the hero composite keeps 1)
      uniform vec3 u_tint, u_fadeColor;
      uniform float u_waterline;   // -1 hidden, else the lens waterline's screen y (0 bottom … 1 top; > 1 = just passed above the frame)
      uniform float u_wlK;         // W18-DIVE OVER-UNDER: strength of the underwater half's look (tint, refraction, caustic shimmer)
      uniform float u_wlWob;       // the crossing: a brief wobble through the whole frame as the line rises past the lens
      uniform float u_wlMo;        // 1 = motion, 0 = reduced motion (no ripple, no droplets, no wobble)
      uniform float u_wlTime;
      uniform float u_aspect;
      ${BLUE_NOISE}
      ${WL_EDGE}
      float wlHash(float n){ return fract(sin(n) * 43758.5453); }
      float wlNoise(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(wlHash(i), wlHash(i + 1.0), f) * 2.0 - 1.0; }
      /** the line's screen y at this x: the same edge the water world and the lake are cut along (water/waterline.ts) */
      float wlLine(vec2 uv){ return u_waterline + wlEdge(uv.x * u_aspect, u_wlTime); }
      /** droplets clinging to the dome just above the meniscus: xy = offset from the drop's centre (in drop radii), z = coverage */
      float wlR = 0.0;   // R7.10 b9: the last drop's radius (cells of 1/24 screen height)
      vec3 wlDrop(vec2 uv){
        wlR = 0.0;
        float d = uv.y - u_waterline;
        #ifdef WL_AA
        if (u_wlMo < 0.5 || d < 0.0 || d > 0.25) return vec3(0.0);   // R7.10 b9: past 0.2 every drop has shrunk to nothing (by its centre)
        #else
        if (u_wlMo < 0.5 || d < 0.0 || d > 0.2) return vec3(0.0);
        #endif
        vec2 g = vec2(uv.x * u_aspect, d) * 24.0;
        vec2 id = floor(g), f = fract(g) - 0.5;
        float h1 = wlHash(id.x * 7.13 + id.y * 13.71 + 3.0), h2 = wlHash(id.x * 3.31 - id.y * 5.97 + 17.0);
        if (h1 > 0.38) return vec3(0.0);
        vec2 q = f - (vec2(h1 / 0.38, h2) - 0.5) * 0.5;
        #ifdef WL_AA
        // R7.10 b9 (Reviewer, PC 11.5%: "bubbles sliced flat"): each drop's size and fade come from its own centre, so a drop is
        // a whole bead that shrinks and fades as one, never squashed or cut by the band's edges or the line
        float dC = (id.y + 0.5 + (h2 - 0.5) * 0.5) / 24.0;
        float r = mix(0.14, 0.34, h2) * (1.0 - smoothstep(0.03, 0.2, dC));
        // and a drop always fits inside its own cell (a bigger one was cut flat by the cell's edge: the "sliced" beads)
        float cy = 0.5 + (h2 - 0.5) * 0.5, cx = 0.5 + (h1 / 0.38 - 0.5) * 0.5;
        r = min(r, min(min(cy, 1.0 - cy) / 1.3, min(cx, 1.0 - cx)) - 0.02);
        #else
        float r = mix(0.14, 0.34, h2) * (1.0 - smoothstep(0.03, 0.2, d));
        #endif
        float l = length(q / vec2(1.0, 1.3));
        wlR = r;
        #ifdef WL_AA
        // R7.10 b9: a drop sitting ON the line lensed the bright meniscus into a hard white blob, cut flat by the line;
        // drops now bead up a little above it
        return vec3(q / max(r, 1e-3), (1.0 - smoothstep(r * 0.8, r, l)) * smoothstep(0.012, 0.035, dC));
        #else
        return vec3(q / max(r, 1e-3), 1.0 - smoothstep(r * 0.8, r, l));
        #endif
      }
      ${withUv ? GRADE_UV : ''}
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec3 c = inputColor.rgb;
        #ifdef WL_AA
        // R7.10 b6 (Shifat's real M02s: "jagged waterline"): on his phone the crossing is drawn at half density and the lake / water
        // world are cut along the line by discard, so the cut is a staircase of half-density pixels (which the meniscus lens
        // then magnifies). Within 2.5 buffer pixels of the analytic line the colour is re-made from a clean sample on each
        // side, blended by the line's own sub-pixel coverage: a smooth edge at any density. ?wlhard = the old staircase
        if (u_waterline > -0.5) {
          float wl0 = wlLine(uv), dd = uv.y - wl0, px = texelSize.y;
          if (abs(dd) < 2.5 * px) {
            vec3 ca = texture2D(inputBuffer, vec2(uv.x, wl0 + 2.5 * px)).rgb, cb = texture2D(inputBuffer, vec2(uv.x, wl0 - 2.5 * px)).rgb;
            c = mix(cb, ca, smoothstep(-0.7 * px, 0.7 * px, dd));
          }
        }
        #endif
        // R7.11 b6d: the background pass's exposure share (u_expK, GRADE_CHAIN only, like u_liftK below): the hero look's 1.12
        // eases toward the dive look's 1.0 on the lake + sky as the lens drops; the stone (heroPass, no define) keeps 1.12
        #ifdef GRADE_CHAIN
        c *= u_exposure * u_expK;
        #else
        c *= u_exposure;
        #endif
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, u_saturation);
        c = (c - 0.5) * u_contrast + 0.5 + u_brightness;
        c *= u_tint;
        vec2 q = uv - 0.5; q.x *= mix(1.0, u_aspect, 0.5);
        float vig = smoothstep(0.85, 0.85 - u_vignetteSoft, length(q) * 1.15);
        c *= mix(1.0, vig, u_vignette);
        // airy field: pull near-white, near-neutral pixels toward paper white (north-star field). Gated by luminance,
        // so the gem, the type and the grey water keep their values
        if (u_lift > 0.0) {
          vec3 cc = min(c, vec3(1.0));
          float lw = smoothstep(0.52, 0.8, dot(cc, vec3(0.2126, 0.7152, 0.0722)));
          // an equal offset on all channels (toward white by the headroom of the brightest channel) keeps tinted
          // pixels' chroma, so the blue glow's falloff stays smooth (a chroma gate left a grey ring around it)
          // R7.11 b6b (Shifat's real M02s: the hero's crisp floor turned milky white on scroll): this pass grades the background
          // (the hero subjects are composited after it by heroPass, which splices this source WITHOUT the effect's defines), so
          // u_liftK eases the lift on the lake and sky alone as the lens drops; the stone keeps the full lift everywhere
          #ifdef GRADE_CHAIN
          c += (1.0 - max(cc.r, max(cc.g, cc.b))) * u_lift * u_liftK * lw;
          #else
          c += (1.0 - max(cc.r, max(cc.g, cc.b))) * u_lift * lw;
          #endif
        }
        // fade toward the section colour from a highlight-clipped copy: the HDR buffer carries speculars and caustics
        // far above 1.0, and a 0.97 fade of a value of 20 still leaves a bright blotch (the lab's white patches)
        c = mix(c, min(c, vec3(1.0)), smoothstep(0.0, 0.35, u_fade));
        c = mix(c, u_fadeColor, u_fade);
        if (u_waterline > -0.5) {
          // W18-DIVE OVER-UNDER: the split-level shot
          float L = wlLine(uv);
          float d = uv.y - L;
          // R7.11 b6: the underwater tint switches on right under the crisp line (b5 ramped it over 0.008 of the screen, which the
          // lens stretched into a half-tinted slate band: the dark half of the double line)
          float uw = ${WL_OLD ? 'smoothstep(0.002, -0.006, d)' : 'smoothstep(0.0012, -0.0012, d)'} * u_wlK;
          // the underwater half: teal absorption (red goes first) and caustic light dancing just under the surface
          c = mix(c, c * vec3(0.64, 0.92, 1.0) + vec3(0.0, 0.012, 0.018), uw);
          float cs = wlNoise(uv.x * u_aspect * 21.0 + u_wlTime * 0.9 + 1.5 * sin(uv.y * 26.0 + u_wlTime * 0.7)) * 0.5 + 0.5;
          c *= 1.0 + uw * exp(d * 7.0) * 0.22 * pow(cs, 3.0);
          // the meniscus. R7.11 b6 (Shifat, real M02s: "Why the double air water intersection line?"): b5 drew a crisp bright edge,
          // a silvered underside band 0.011 below it and a cool halo above it, so the eye read a bright line, a dark strip and a
          // grey band (two lines). Real over-under shots show one thin meniscus: the crisp edge alone now (?wlold = b5's bands)
          ${WL_OLD ? `float sq0 = (d + 0.011) / 0.009;
          float sil = exp(-(sq0 * sq0)) * min(1.0, u_wlK * 1.5);
          c = mix(c, c * 0.7 + vec3(0.66, 0.82, 0.86) * 0.36, sil * 0.6);` : ''}
          // R7.10 b6 (Shifat's real M02s: "jagged waterline"): the crisp edge is 0.0016 of the screen height, under one pixel of
          // the 0.5-density buffer the crossing is drawn in on his phone, so it (and the cut under it) read as stair-steps.
          // Its width never goes under 1.1 buffer pixels now, its peak scaled so the line carries the same light (identical
          // wherever a pixel is already finer than the line). ?wlhard = the old edge
          // (heroPass.ts splices this source without the effect's defines and has no texelSize / inputBuffer: WL_AA is off there)
          #ifdef WL_AA
          float w1 = max(0.0016, 1.1 * texelSize.y);
          #else
          float w1 = 0.0016;
          #endif
          float sq1 = d / w1;
          c += vec3(0.93, 0.98, 1.0) * exp(-(sq1 * sq1)) * 0.95 * min(1.0, 0.0016 / w1 * 1.25);
          ${WL_OLD ? `float sq2 = (d - 0.004) / 0.006;
          c += vec3(0.55, 0.82, 0.95) * exp(-(sq2 * sq2)) * 0.12;` : ''}
          // droplets: a dark rim and a highlight up and to the left (the sky caught in each bead)
          vec3 dr = wlDrop(uv);
          float rim = smoothstep(0.55, 0.95, length(dr.xy));
          #ifdef WL_AA
          // R7.10 b9 (Reviewer, M02s 10-10.5%: "white droplet dots"): a drop's highlight was 0.18 drop radii wide, under one
          // pixel of the half-density crossing buffer, so each drop showed a hard white pixel (and the shrinking drops near the
          // top of the band became lone white specks). Drops under ~1.5 buffer pixels now fade out, and the highlight is never
          // narrower than 1.2 buffer pixels, its peak scaled so it carries the same light. ?wlhard = the old drops
          float rPx = wlR / 24.0 / texelSize.y;
          float dk = smoothstep(1.0, 2.5, rPx);
          float sw = max(0.18, 1.2 / max(rPx, 1e-3));
          c = mix(c, c * 0.72, dr.z * rim * 0.5 * dk);
          c += vec3(1.0) * dr.z * dk * smoothstep(sw, 0.0, length(dr.xy - vec2(-0.35, 0.4))) * 0.55 * min(1.0, (0.18 * 0.18) / (sw * sw) * 1.4);
          #else
          c = mix(c, c * 0.72, dr.z * rim * 0.5);
          c += vec3(1.0) * dr.z * smoothstep(0.18, 0.0, length(dr.xy - vec2(-0.35, 0.4))) * 0.55;
          #endif
        }
        // R7.08c: the dither moved to the final blit (canvas density, where the frame becomes 8-bit; PostChain.ts blitMat)
        outputColor = vec4(c, inputColor.a);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      defines: new Map<string, string>([...(WL_HARD ? [] : [['WL_AA', '1']]), ['GRADE_CHAIN', '1']] as [string, string][]),   // GRADE_CHAIN: R7.11 b6b, this pass only (heroPass splices the source without it)   // R7.10 b6: the waterline AA (the effect pass only; ?wlhard = off)
      uniforms: new Map<string, THREE.Uniform<any>>([
        ['u_exposure', new THREE.Uniform(1)], ['u_saturation', new THREE.Uniform(1)], ['u_contrast', new THREE.Uniform(1)],
        ['u_brightness', new THREE.Uniform(0)], ['u_vignette', new THREE.Uniform(0.2)], ['u_vignetteSoft', new THREE.Uniform(0.7)],
        ['u_fade', new THREE.Uniform(0)], ['u_lift', new THREE.Uniform(0)], ['u_liftK', new THREE.Uniform(1)], ['u_expK', new THREE.Uniform(1)], ['u_tint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['u_fadeColor', new THREE.Uniform(new THREE.Color(0, 0, 0))],
        ['u_waterline', new THREE.Uniform(-1)], ['u_aspect', new THREE.Uniform(1)],
        // W18-DIVE OVER-UNDER
        ['u_wlK', new THREE.Uniform(0)], ['u_wlWob', new THREE.Uniform(0)], ['u_wlMo', new THREE.Uniform(1)], ['u_wlTime', shared.u_time as any],
        ['u_blueNoise', shared.u_blueNoise as any], ['u_blueNoiseOffset', shared.u_blueNoiseOffset as any], ['u_blueNoiseSize', shared.u_blueNoiseSize as any],
      ]),
    })
  }
  u(name: string) { return this.uniforms.get(name)! }
}

/** "Fsr"-style last pass (order 2000) — only when rendering below native size: contrast-adaptive sharpen. */
export class SharpenEffect extends Effect {
  constructor() {
    super('Sharpen', /* glsl */ `
      uniform float u_sharpness;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec3 a = texture2D(inputBuffer, uv + vec2(0.0, -texelSize.y)).rgb;
        vec3 b = texture2D(inputBuffer, uv + vec2(-texelSize.x, 0.0)).rgb;
        vec3 d = texture2D(inputBuffer, uv + vec2(texelSize.x, 0.0)).rgb;
        vec3 e = texture2D(inputBuffer, uv + vec2(0.0, texelSize.y)).rgb;
        vec3 c = inputColor.rgb;
        vec3 mn = min(c, min(min(a, b), min(d, e))), mx = max(c, max(max(a, b), max(d, e)));
        vec3 amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
        vec3 w = -amp * mix(0.125, 0.2, u_sharpness);
        outputColor = vec4((c + (a + b + d + e) * w) / (1.0 + 4.0 * w), inputColor.a);
      }`, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([['u_sharpness', new THREE.Uniform(0.6)]]),
    })
  }
}
