import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { shared } from '../../state/props'
import { BLUE_NOISE } from '../shaders/chunks'
import { WL_EDGE } from '../water/waterline'

/**
 * ScreenPaintDistortion (ch.14 S.6) — order 75. Smears the finished frame along the paint velocity
 * with 9 taps (blue-noise jittered start) and adds the phase-shifted sine fringe in the fading wake.
 * The reference composites in 8-bit display space, so the taps are averaged and the fringe is added
 * on sRGB-encoded values and decoded back for the linear chain — same numbers, same look.
 * u_iridescence is an extra thin-film pass on the wake edges (off = 1:1 with the reference).
 * ?paintdebug draws the trail over a flat grey field so the trail can be judged on its own.
 */
export class ScreenPaintDistortionEffect extends Effect {
  constructor() {
    const debug = typeof location !== 'undefined' && /[?&]paintdebug/.test(location.search)
    super('ScreenPaintDistortion', /* glsl */ `
      uniform sampler2D u_screenPaintTexture;
      uniform vec2 u_screenPaintTexelSize;
      uniform float u_amount, u_rgbShift, u_multiplier, u_colorMultiplier, u_shade, u_iridescence, u_debug, u_dark;
      uniform vec4 u_stk[4]; uniform float u_stkOn; uniform vec2 u_view; uniform vec4 u_gem;   // W23: the CTA stickers on screen (viewport px)
      ${BLUE_NOISE}
      vec3 spd_encode(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      vec3 spd_decode(vec3 c){ c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec3 bn = getBlueNoise(gl_FragCoord.xy + vec2(17.0, 29.0));
        vec4 data = texture2D(u_screenPaintTexture, uv);
        float weight = (data.z + data.w) * 0.5;
        vec2 vel = (0.5 - data.xy - 0.001) * 2.0 * weight;           // signed, flipped, fades with paint
        // W23: no smear on or next to a sticker (it dragged the die-cut white margin out across the wall as a wedge)
        float stkM = 1.0;
        if (u_stkOn > 0.5) {
          vec2 px = vec2(uv.x, 1.0 - uv.y) * u_view;
          for (int i = 0; i < 4; i++) if (u_stk[i].w > 0.5) stkM = min(stkM, smoothstep(u_stk[i].z * 1.05, u_stk[i].z * 1.05 + 80.0, distance(px, u_stk[i].xy)));
        }
        // W23: nor across the hero stone's edge (it dragged a grey hook off its silhouette onto the water)
        if (u_gem.w > 0.5) stkM = min(stkM, smoothstep(u_gem.z, u_gem.z + 36.0, distance(vec2(uv.x, 1.0 - uv.y) * u_view, u_gem.xy)));
        vec2 stepUv = vel * u_amount / 4.0 * u_screenPaintTexelSize * u_multiplier * (1.0 - 0.6 * u_dark) * stkM;   // W23: on the dark wall a shorter smear (it dragged the matte texture into dirty streaks)
        vec2 p = uv + bn.xy * stepUv;                                 // jittered first tap kills banding
        vec4 acc = vec4(0.0);
        for (int i = 0; i < 9; i++) { vec4 s = texture2D(inputBuffer, p); acc += vec4(min(spd_encode(s.rgb), 1.0), s.a); p += stepUv; }  // each tap as the reference's 8-bit buffer holds it
        acc /= 9.0;
        // W23 (scorer-r6261 #5: on the dark wall the smear dragged a red streak off the crewmate's legs): on dark sections the
        // smear only moves the dark wall itself; wherever the pixel or what it would pull in is brighter than the wall (the
        // crewmate, the stickers, the type) the frame stays as rendered
        float keep = 0.0;
        if (u_dark > 0.001) {
          vec3 orig = min(spd_encode(texture2D(inputBuffer, uv).rgb), 1.0);
          vec3 hi3 = max(orig, acc.rgb);   // brightest channel: the red crewmate is dim in luminance but far off the grey wall
          keep = u_dark * smoothstep(0.2, 0.34, max(max(hi3.r, hi3.g), hi3.b));
          acc.rgb = mix(acc.rgb, orig, keep);
        }
        if (u_debug > 0.5) acc = vec4(vec3(0.5 + 0.35 * weight), 1.0);
        // wake fringe: strongest where weight is low, gone above 0.4
        vec3 fringe = sin(vec3(vel.x + vel.y) * 40.0 + vec3(0.0, 2.0, 4.0) * u_rgbShift)
                 * smoothstep(0.4, -0.9, weight) * u_shade * max(abs(vel.x), abs(vel.y)) * u_colorMultiplier;
        // W23 (scorer-r618/r621: the trail on the dark CTA wall read as an oily navy smudge): on dark sections the fringe
        // only ever lightens, as a soft glassy tint at a third of the strength; its dark half (which clipped to black
        // contours on the wall) is dropped. Light sections are unchanged.
        // W23 (scorer-r6261 #5): on dark it is also colourless now (the chromatic phase read as an oily fringe), and off anything bright
        vec3 glass = vec3(dot(max(fringe, 0.0), vec3(0.3333))) * 0.35;
        acc.rgb += mix(fringe, glass * (1.0 - keep), u_dark) * stkM;
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
        outputColor = vec4(spd_decode(clamp(acc.rgb, 0.0, 1.0)), acc.a);
      }`, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform<any>>([
        ['u_screenPaintTexture', shared.u_currPaintTexture as any],
        ['u_screenPaintTexelSize', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['u_amount', new THREE.Uniform(3)],
        ['u_rgbShift', new THREE.Uniform(0.5)],
        ['u_multiplier', new THREE.Uniform(5)],
        ['u_colorMultiplier', new THREE.Uniform(10)],
        ['u_shade', new THREE.Uniform(1.25)],
        ['u_iridescence', new THREE.Uniform(0)],
        ['u_debug', new THREE.Uniform(debug ? 1 : 0)],
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
export class GradeEffect extends Effect {
  constructor() {
    super('Grade', /* glsl */ `
      uniform float u_exposure, u_saturation, u_contrast, u_brightness, u_vignette, u_vignetteSoft, u_fade, u_lift;
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
      vec3 wlDrop(vec2 uv){
        float d = uv.y - u_waterline;
        if (u_wlMo < 0.5 || d < 0.0 || d > 0.2) return vec3(0.0);
        vec2 g = vec2(uv.x * u_aspect, d) * 24.0;
        vec2 id = floor(g), f = fract(g) - 0.5;
        float h1 = wlHash(id.x * 7.13 + id.y * 13.71 + 3.0), h2 = wlHash(id.x * 3.31 - id.y * 5.97 + 17.0);
        if (h1 > 0.38) return vec3(0.0);
        vec2 q = f - (vec2(h1 / 0.38, h2) - 0.5) * 0.5;
        float r = mix(0.14, 0.34, h2) * (1.0 - smoothstep(0.03, 0.2, d));
        float l = length(q / vec2(1.0, 1.3));
        return vec3(q / max(r, 1e-3), 1.0 - smoothstep(r * 0.8, r, l));
      }
      void mainUv(inout vec2 uv){
        if (u_waterline > -0.5) {
          float L = wlLine(uv);
          float d = uv.y - L;
          float t = u_wlTime;
          // the meniscus: water climbing the dome is a thin cylindrical lens along the line; it pulls the image toward
          // the line (a magnified sliver of both worlds) and shivers along x
          float band = exp(-d * d * 2200.0);
          uv.y -= band * d * 0.6;
          uv.x += band * 0.003 * wlNoise(uv.x * u_aspect * 30.0 + t * 0.8) * u_wlMo;
          // the underwater half: refraction ripple, and the slight magnification of the water (n = 1.33) about the line
          float uw = smoothstep(0.0, -0.012, d) * u_wlK;
          vec2 rp = vec2(sin(uv.y * 38.0 + t * 1.6 + 2.0 * sin(uv.x * u_aspect * 9.0)), cos(uv.x * u_aspect * 31.0 - t * 1.3 + uv.y * 7.0));
          uv += uw * rp * 0.0024 * u_wlMo;
          float Lm = min(L, 1.0);
          uv.y = mix(uv.y, Lm + (uv.y - Lm) * 0.95, uw);
          // droplets above the line: each a tiny inverted lens
          vec3 dr = wlDrop(uv);
          uv -= dr.xy * dr.z * 0.010;
          // the crossing: the frame wobbles once as the line rises past the lens
          if (u_wlWob > 0.0) {
            float w = u_wlWob * u_wlMo;
            uv += w * vec2(0.010 * sin(uv.y * 14.0 + t * 3.1 + sin(uv.x * 6.0)), 0.014 * sin(uv.x * u_aspect * 10.0 - t * 2.7 + uv.y * 4.0));
          }
        }
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec3 c = inputColor.rgb * u_exposure;
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
          c += (1.0 - max(cc.r, max(cc.g, cc.b))) * u_lift * lw;
        }
        // fade toward the section colour from a highlight-clipped copy: the HDR buffer carries speculars and caustics
        // far above 1.0, and a 0.97 fade of a value of 20 still leaves a bright blotch (the lab's white patches)
        c = mix(c, min(c, vec3(1.0)), smoothstep(0.0, 0.35, u_fade));
        c = mix(c, u_fadeColor, u_fade);
        if (u_waterline > -0.5) {
          // W18-DIVE OVER-UNDER: the split-level shot
          float L = wlLine(uv);
          float d = uv.y - L;
          float uw = smoothstep(0.002, -0.006, d) * u_wlK;
          // the underwater half: teal absorption (red goes first) and caustic light dancing just under the surface
          c = mix(c, c * vec3(0.64, 0.92, 1.0) + vec3(0.0, 0.012, 0.018), uw);
          float cs = wlNoise(uv.x * u_aspect * 21.0 + u_wlTime * 0.9 + 1.5 * sin(uv.y * 26.0 + u_wlTime * 0.7)) * 0.5 + 0.5;
          c *= 1.0 + uw * exp(d * 7.0) * 0.22 * pow(cs, 3.0);
          // the meniscus: a silvered underside (total internal reflection) just under the line, a crisp bright edge on
          // it and a thin cool halo above it
          float sq0 = (d + 0.011) / 0.009;
          float sil = exp(-(sq0 * sq0)) * min(1.0, u_wlK * 1.5);
          c = mix(c, c * 0.7 + vec3(0.66, 0.82, 0.86) * 0.36, sil * 0.6);   // W18: lighter underside band
          float sq1 = d / 0.0016;
          c += vec3(0.93, 0.98, 1.0) * exp(-(sq1 * sq1)) * 0.95;
          float sq2 = (d - 0.004) / 0.006;
          c += vec3(0.55, 0.82, 0.95) * exp(-(sq2 * sq2)) * 0.12;
          // droplets: a dark rim and a highlight up and to the left (the sky caught in each bead)
          vec3 dr = wlDrop(uv);
          float rim = smoothstep(0.55, 0.95, length(dr.xy));
          c = mix(c, c * 0.72, dr.z * rim * 0.5);
          c += vec3(1.0) * dr.z * smoothstep(0.18, 0.0, length(dr.xy - vec2(-0.35, 0.4))) * 0.55;
        }
        c += (getBlueNoise(gl_FragCoord.xy).r - 0.5) / 255.0;  // dither
        outputColor = vec4(c, inputColor.a);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform<any>>([
        ['u_exposure', new THREE.Uniform(1)], ['u_saturation', new THREE.Uniform(1)], ['u_contrast', new THREE.Uniform(1)],
        ['u_brightness', new THREE.Uniform(0)], ['u_vignette', new THREE.Uniform(0.2)], ['u_vignetteSoft', new THREE.Uniform(0.7)],
        ['u_fade', new THREE.Uniform(0)], ['u_lift', new THREE.Uniform(0)], ['u_tint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
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
