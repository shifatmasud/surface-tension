import * as THREE from 'three'
import { fboHelper, FS_VERT } from './fbo'
/** Separable Gaussian blur: blur(radius, scale, input, intermediate[, output]). Without an output
 *  it renders H into intermediate and V back into input, blurring in place (ch.14 S.4 step 7). */
const mat = new THREE.ShaderMaterial({
  uniforms: { u_texture: { value: null }, u_delta: { value: new THREE.Vector2() } },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D u_texture; uniform vec2 u_delta; varying vec2 v_uv;
    void main(){
      // 9 taps, weights from a sigma≈radius/2.5 gaussian, offsets spread across the radius
      vec4 c = texture2D(u_texture, v_uv) * 0.2270270270;
      c += texture2D(u_texture, v_uv + u_delta * 1.3846153846) * 0.3162162162;
      c += texture2D(u_texture, v_uv - u_delta * 1.3846153846) * 0.3162162162;
      c += texture2D(u_texture, v_uv + u_delta * 3.2307692308) * 0.0702702703;
      c += texture2D(u_texture, v_uv - u_delta * 3.2307692308) * 0.0702702703;
      gl_FragColor = c;
    }`,
  depthTest: false, depthWrite: false,
})
export function blur(radius: number, scale: number, input: THREE.WebGLRenderTarget, inter: THREE.WebGLRenderTarget, output?: THREE.WebGLRenderTarget) {
  const u = mat.uniforms
  const s = (radius / 4) * scale
  u.u_texture.value = input.texture; u.u_delta.value.set(s / input.width, 0)
  fboHelper.render(mat, inter)
  u.u_texture.value = inter.texture; u.u_delta.value.set(0, s / inter.height)
  fboHelper.render(mat, output ?? input)
}
