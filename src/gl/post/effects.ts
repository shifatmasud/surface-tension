import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { shared } from '../../state/props'
import { BLUE_NOISE } from '../shaders/chunks'

// The cursor trail's lens pass lives in its own file (owned by the trail).
export { ScreenPaintDistortionEffect } from './ScreenPaintDistortion'

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
        ['u_fade', new THREE.Uniform(0)], ['u_lift', new THREE.Uniform(0)], ['u_tint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
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
