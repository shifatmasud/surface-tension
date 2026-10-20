import type { BloomEffect } from 'postprocessing'

/**
 * CINEMATIC (Shifat 18:50Z: "Use selective bloom pass for cinematic finish"): the existing bloom, made selective,
 * with NO extra pass. The bloom's own luminance pre-pass (it already runs at the bloom's reduced resolution) gets a
 * hot-spot mask: a texel blooms only where it is brighter than the threshold AND clearly brighter than its
 * neighbourhood (8 taps). Small hot spots pass: the stone's glints and sheen, the caustic web, bubble cores, specular
 * edges. Broad bright areas do not: the sky, the Snell window, a white studio wall, a lit card. So no haze, no milky
 * veil over the frame. Very hot texels (≥ HOT.always, e.g. the sun disc) always pass.
 * Text and UI never bloom by construction: the type layer and the UFX passes are drawn after the bloom (PostChain).
 */
export const HOT = {
  floor: 0.86,     // the lowest threshold any section may ask for (the journey asked 0.75: haze)
  knee: 0.14,      // the threshold's soft knee: hot spots ease in, no hard sparkle edge
  local: 0.35,     // how much brighter than the neighbourhood a texel must be (relative) to count as a hot spot
  always: 2.2,     // HDR level that always blooms
  gain: 1.35,      // fewer texels bloom, so each one glows a little more (sections' bloom amounts are kept)
}

const FRAG = /* glsl */ `#include <common>
uniform mediump sampler2D inputBuffer;
uniform float threshold; uniform float smoothing; uniform float hsLocal; uniform float hsAlways;
varying vec2 vUv;
float lumAt(vec2 o){ return luminance(texture2D(inputBuffer, vUv + o).rgb); }
void main(){
  vec4 texel = texture2D(inputBuffer, vUv);
  float l = luminance(texel.rgb);
  vec2 px = 1.0 / vec2(textureSize(inputBuffer, 0));
  vec2 a = px * 6.0, b = px * 14.0;
  float la = (lumAt(vec2(a.x, a.y)) + lumAt(vec2(-a.x, a.y)) + lumAt(vec2(a.x, -a.y)) + lumAt(vec2(-a.x, -a.y))
            + lumAt(vec2(b.x, 0.0)) + lumAt(vec2(-b.x, 0.0)) + lumAt(vec2(0.0, b.y)) + lumAt(vec2(0.0, -b.y))) * 0.125;
  float hot = smoothstep(threshold, threshold + smoothing, l);
  hot *= smoothstep(0.0, hsLocal, (l - la) / max(la, 0.04));
  hot = max(hot, smoothstep(hsAlways, hsAlways * 1.4, l));
  l *= hot;
  gl_FragColor = vec4(texel.rgb * clamp(l, 0.0, 1.0), l);
}`

/** Swap the bloom's luminance pre-pass for the hot-spot mask (call once per BloomEffect, after construction). */
export function makeSelective(bloom: BloomEffect) {
  const m = bloom.luminanceMaterial as any
  m.fragmentShader = FRAG
  m.uniforms.hsLocal = { value: HOT.local }
  m.uniforms.hsAlways = { value: HOT.always }
  m.defines.THRESHOLD = '1'
  m.needsUpdate = true
  bloom.luminanceMaterial.smoothing = HOT.knee
  return bloom
}

/** The section's look → the selective bloom (threshold floor + gain). */
export function syncSelective(bloom: BloomEffect, amount: number, threshold: number) {
  bloom.intensity = amount * HOT.gain
  bloom.luminanceMaterial.threshold = Math.max(threshold, HOT.floor)
}
