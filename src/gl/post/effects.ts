import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { shared } from '../../state/props'
import { BLUE_NOISE } from '../shaders/chunks'

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
      uniform float u_amount, u_rgbShift, u_multiplier, u_colorMultiplier, u_shade, u_iridescence, u_debug;
      ${BLUE_NOISE}
      vec3 spd_encode(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      vec3 spd_decode(vec3 c){ c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec3 bn = getBlueNoise(gl_FragCoord.xy + vec2(17.0, 29.0));
        vec4 data = texture2D(u_screenPaintTexture, uv);
        float weight = (data.z + data.w) * 0.5;
        vec2 vel = (0.5 - data.xy - 0.001) * 2.0 * weight;           // signed, flipped, fades with paint
        vec2 stepUv = vel * u_amount / 4.0 * u_screenPaintTexelSize * u_multiplier;
        vec2 p = uv + bn.xy * stepUv;                                 // jittered first tap kills banding
        vec4 acc = vec4(0.0);
        for (int i = 0; i < 9; i++) { vec4 s = texture2D(inputBuffer, p); acc += vec4(spd_encode(s.rgb), s.a); p += stepUv; }
        acc /= 9.0;
        if (u_debug > 0.5) acc = vec4(vec3(0.5 + 0.35 * weight), 1.0);
        // wake fringe: strongest where weight is low, gone above 0.4
        acc.rgb += sin(vec3(vel.x + vel.y) * 40.0 + vec3(0.0, 2.0, 4.0) * u_rgbShift)
                 * smoothstep(0.4, -0.9, weight) * u_shade * max(abs(vel.x), abs(vel.y)) * u_colorMultiplier;
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
        ['u_blueNoise', shared.u_blueNoise as any],
        ['u_blueNoiseOffset', shared.u_blueNoiseOffset as any],
        ['u_blueNoiseSize', shared.u_blueNoiseSize as any],
      ]),
    })
  }
  u(name: string) { return this.uniforms.get(name)! }
}

/**
 * Grade ("Final", ch.8.5) — order 30. Our own grading: exposure, saturation, contrast, brightness,
 * tint, a soft vignette, a fade toward the section colour, and a blue-noise 1/255 dither to kill banding.
 * Also hosts the surface-break band for the dive (a refractive waterline swept across the frame).
 */
export class GradeEffect extends Effect {
  constructor() {
    super('Grade', /* glsl */ `
      uniform float u_exposure, u_saturation, u_contrast, u_brightness, u_vignette, u_vignetteSoft, u_fade;
      uniform vec3 u_tint, u_fadeColor;
      uniform float u_waterline;   // -1 hidden, 0..1 screen y of the waterline band
      uniform float u_aspect;
      ${BLUE_NOISE}
      float wlHash(float n){ return fract(sin(n) * 43758.5453); }
      float wlNoise(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(wlHash(i), wlHash(i + 1.0), f) * 2.0 - 1.0; }
      void mainUv(inout vec2 uv){
        // refraction band around the waterline (surface break): bend + slight chroma-free magnify.
        // the meniscus wobble is two octaves of value noise along x (aspect-scaled so ultrawide isn't stretched),
        // not a regular sine scallop
        if (u_waterline > -0.5) {
          float d = uv.y - u_waterline;
          float band = exp(-d * d * 900.0);
          float x = uv.x * u_aspect, s = u_waterline * 6.0;
          float wob = wlNoise(x * 7.0 + s) * 0.65 + wlNoise(x * 19.0 - s * 1.7 + 11.0) * 0.35;
          uv.y += band * 0.010 * wob + band * d * -0.6;
          uv.x += band * 0.004 * wlNoise(uv.y * 60.0 + s * 3.0);
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
        // fade toward the section colour from a highlight-clipped copy: the HDR buffer carries speculars and caustics
        // far above 1.0, and a 0.97 fade of a value of 20 still leaves a bright blotch (the lab's white patches)
        c = mix(c, min(c, vec3(1.0)), smoothstep(0.0, 0.35, u_fade));
        c = mix(c, u_fadeColor, u_fade);
        if (u_waterline > -0.5) {
          float d = uv.y - u_waterline;
          c += exp(-d * d * 4000.0) * 0.35;           // bright meniscus line
        }
        c += (getBlueNoise(gl_FragCoord.xy).r - 0.5) / 255.0;  // dither
        outputColor = vec4(c, inputColor.a);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform<any>>([
        ['u_exposure', new THREE.Uniform(1)], ['u_saturation', new THREE.Uniform(1)], ['u_contrast', new THREE.Uniform(1)],
        ['u_brightness', new THREE.Uniform(0)], ['u_vignette', new THREE.Uniform(0.2)], ['u_vignetteSoft', new THREE.Uniform(0.7)],
        ['u_fade', new THREE.Uniform(0)], ['u_tint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['u_fadeColor', new THREE.Uniform(new THREE.Color(0, 0, 0))],
        ['u_waterline', new THREE.Uniform(-1)], ['u_aspect', new THREE.Uniform(1)],
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
