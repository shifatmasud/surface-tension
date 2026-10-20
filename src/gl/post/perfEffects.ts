import * as THREE from 'three'
import { Effect } from 'postprocessing'

/**
 * PERF HOOK — the below-native-size sharpen, written to ride INSIDE the Grade pass (first effect of that EffectPass),
 * saving one full-screen pass on every phone. Same contrast-adaptive kernel as effects.ts SharpenEffect, but declared
 * without the CONVOLUTION attribute: the Grade effect transforms UVs (the dive waterline band) and postprocessing
 * refuses convolution + UV transforms in one pass. A 1-texel cross read at the (possibly warped) uv is the same
 * picture: sharpen(warp(input)) ≈ sharpen at the warped coordinate.
 */
export class InlineSharpenEffect extends Effect {
  constructor() {
    super('InlineSharpen', /* glsl */ `
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
      uniforms: new Map([['u_sharpness', new THREE.Uniform(0.6)]]),
    })
  }
}
