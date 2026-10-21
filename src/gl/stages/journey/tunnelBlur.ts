import * as THREE from 'three'

/**
 * TUNNEL ZOOM BLUR (Shifat Oct 21 12:44Z "blur … ultra fast smoothness even for cheap phone"): one cheap radial
 * (zoom) blur of the inner-world picture toward the tunnel's vanishing point, driven by the scroll speed.
 * It runs at HALF the inner render target's size (the inner target is already 1024 / 512-on-low on its long side,
 * i.e. far below the screen), with a fixed tap count per tier (high 10, mid 8, low 6 — same look, cheaper fill),
 * and ONLY while the tunnel is on. The screen shader then mixes the sharp picture with this blurred one by distance
 * from the vanishing point, so the crewmate (centre) stays crisp and the walls smear. No extra full-res pass.
 */
const VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`
const FS = /* glsl */ `
uniform sampler2D u_src; uniform vec2 u_c; uniform float u_amt;
varying vec2 vUv;
void main(){
  vec2 d = (u_c - vUv) * u_amt;              // step toward the vanishing point
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < TAPS; i++) {
    float t = float(i) / float(TAPS - 1);
    float w = 1.0 - 0.5 * t;                 // near taps weigh more: the smear trails, it does not ghost
    acc += texture2D(u_src, vUv + d * t).rgb * w; wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}`

export function buildTunnelBlur(src: THREE.WebGLRenderTarget, tier: 'low' | 'mid' | 'high') {
  const w = Math.max(64, src.width >> 1), h = Math.max(64, src.height >> 1)
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
  const taps = tier === 'high' ? 10 : tier === 'mid' ? 8 : 6
  const material = new THREE.ShaderMaterial({
    vertexShader: VS, fragmentShader: FS, depthTest: false, depthWrite: false, fog: false,
    defines: { TAPS: taps },
    uniforms: { u_src: { value: src.texture }, u_c: { value: new THREE.Vector2(0.5, 0.5) }, u_amt: { value: 0 } },
  })
  const scene = new THREE.Scene()
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  scene.add(quad)
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  /** render src → rt (the caller restores the previous target) */
  const render = (gl: THREE.WebGLRenderer) => { gl.setRenderTarget(rt); gl.render(scene, cam) }
  return { rt, material, render, taps, size: [w, h] as const }
}
