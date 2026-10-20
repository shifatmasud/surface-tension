import * as THREE from 'three'
import { Pass } from 'postprocessing'
import { diveRays } from '../stages/dive/diveState'
import { shared } from '../../state/props'

/**
 * Screen-space god rays for the dive (order 5, before bloom). Occlusion-aware radial light scattering:
 *  1. mask   — the dive stage's light scene (Snell's window shimmering with the surface + the lit water column)
 *              with the vegetation drawn black over it, rendered at reduced size through a WIDENED copy of the
 *              camera (E× the frustum) so light from just outside the frame still streams in;
 *  2. blur   — two radial passes toward the sun's vanishing point (long, then short to smooth the steps), with
 *              exponential decay, static blue-noise jitter (temporally stable: no crawling grain);
 *              if the sun is behind the camera we march away from the anti-solar point (same parallel shafts);
 *  3. add    — the shafts are added to the frame, tinted by the water.
 * Off (removed from the chain) everywhere except under water in the dive.
 */
const E = 1.45
const VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`

const BLUR = /* glsl */ `
uniform sampler2D tMap, u_bn;
uniform vec2 u_sun;
uniform float u_behind, u_len, u_decay, u_gain, u_seed;
varying vec2 vUv;
void main(){
  vec2 d = u_sun - vUv;
  if (u_behind > 0.5) d = -d;
  float L = length(d);
  vec2 dir = d / max(L, 1e-5);
  float len = min(L, u_len);
  vec2 st = dir * len / float(N);
  float j = texture2D(u_bn, (gl_FragCoord.xy + u_seed) / 64.0).r;
  vec2 p = vUv + st * j;
  float illum = 1.0, wsum = 0.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++){
    vec2 q = clamp(p, 0.0, 1.0);
    acc += texture2D(tMap, q).rgb * illum;
    wsum += illum;
    illum *= u_decay;
    p += st;
  }
  gl_FragColor = vec4(acc / wsum * u_gain, 1.0);
}`

const COMP = /* glsl */ `
uniform sampler2D tMap, tRays;
uniform vec3 u_tint;
uniform float u_amount, u_e, u_debug;
varying vec2 vUv;
void main(){
  vec4 c = texture2D(tMap, vUv);
  vec2 ruv = (vUv - 0.5) / u_e + 0.5;
  vec3 r = texture2D(tRays, ruv).rgb;
  vec3 add = r * u_tint * u_amount;
  c.rgb += add * (1.0 - 0.35 * clamp(dot(c.rgb, vec3(0.33)), 0.0, 1.0));   // keep highlights from clipping
  if (u_debug > 0.5) c.rgb = r;
  gl_FragColor = c;
}`

export class DiveGodRaysPass extends Pass {
  private mask: THREE.WebGLRenderTarget
  private a: THREE.WebGLRenderTarget
  private b: THREE.WebGLRenderTarget
  private longMat: THREE.ShaderMaterial
  private shortMat: THREE.ShaderMaterial
  private comp: THREE.ShaderMaterial
  private maskCam = new THREE.PerspectiveCamera()
  private v4 = new THREE.Vector4()
  private m = new THREE.Matrix4()
  private sx = new THREE.Matrix4().makeScale(1 / E, 1 / E, 1)

  constructor(private cam: THREE.Camera) {
    super('DiveGodRays')
    this.needsSwap = true
    const rt = () => new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
    this.mask = rt(); this.a = rt(); this.b = rt()
    const blur = (n: number, len: number, decay: number, seed: number) => new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLUR, defines: { N: n }, depthTest: false, depthWrite: false,
      uniforms: {
        tMap: { value: null }, u_bn: shared.u_blueNoise, u_sun: { value: new THREE.Vector2(0.5, 1) },
        u_behind: { value: 0 }, u_len: { value: len }, u_decay: { value: decay }, u_gain: { value: 1 }, u_seed: { value: seed },
      },
    })
    const n = diveRays.samples
    this.longMat = blur(n, 0.7, 0.97, 0)
    this.shortMat = blur(Math.max(12, n >> 2), 0.62 / n * 2.5, 0.99, 23)
    this.comp = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMP, depthTest: false, depthWrite: false,
      uniforms: { tMap: { value: null }, tRays: { value: this.b.texture }, u_tint: { value: diveRays.tint }, u_amount: { value: 0 }, u_e: { value: E }, u_debug: { value: typeof location !== 'undefined' && /[?&]raysdebug/.test(location.search) ? 1 : 0 } },
    })
    this.fullscreenMaterial = this.comp
  }

  private fit(w: number, h: number) {
    const s = diveRays.scale
    const mw = Math.max(16, Math.round(w * s)), mh = Math.max(16, Math.round(h * s))
    if (this.mask.width !== mw || this.mask.height !== mh) { this.mask.setSize(mw, mh); this.a.setSize(mw, mh); this.b.setSize(mw, mh) }
  }

  render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget) {
    const R = diveRays
    this.fit(inputBuffer.width, inputBuffer.height)
    // 1. mask through the widened camera
    const cam = this.cam as THREE.PerspectiveCamera, mc = this.maskCam
    cam.matrixWorld.decompose(mc.position, mc.quaternion, mc.scale)
    mc.updateMatrixWorld(true)
    mc.projectionMatrix.multiplyMatrices(this.sx, cam.projectionMatrix)
    mc.projectionMatrixInverse.copy(mc.projectionMatrix).invert()
    this.m.multiplyMatrices(mc.projectionMatrix, mc.matrixWorldInverse)
    R.invVP.copy(this.m).invert()
    // the sun's vanishing point in mask uv
    this.v4.set(R.toSun.x, R.toSun.y, R.toSun.z, 0).applyMatrix4(this.m)
    const w = this.v4.w, behind = w < 0
    const ww = Math.abs(w) < 1e-4 ? 1e-4 : w
    const su = this.v4.x / ww * 0.5 + 0.5, sv = this.v4.y / ww * 0.5 + 0.5
    R.sun.set(su, sv, behind ? 1 : 0, this.mask.width / this.mask.height)
    for (const m of [this.longMat, this.shortMat]) { m.uniforms.u_sun.value.set(su, sv); m.uniforms.u_behind.value = behind ? 1 : 0 }
    const auto = renderer.autoClear
    renderer.autoClear = true
    if (R.scene) { renderer.setRenderTarget(this.mask); renderer.render(R.scene, mc) }
    renderer.autoClear = auto
    // 2. radial blur, long then short
    this.longMat.uniforms.tMap.value = this.mask.texture
    this.fullscreenMaterial = this.longMat
    renderer.setRenderTarget(this.a); renderer.render(this.scene, this.camera)
    this.shortMat.uniforms.tMap.value = this.a.texture
    this.fullscreenMaterial = this.shortMat
    renderer.setRenderTarget(this.b); renderer.render(this.scene, this.camera)
    // 3. composite
    this.comp.uniforms.tMap.value = inputBuffer.texture
    this.comp.uniforms.u_amount.value = R.intensity
    this.fullscreenMaterial = this.comp
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer)
    renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.mask.dispose(); this.a.dispose(); this.b.dispose()
    this.longMat.dispose(); this.shortMat.dispose(); this.comp.dispose()
    super.dispose()
  }
}
