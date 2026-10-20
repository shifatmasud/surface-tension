import * as THREE from 'three'
import { SYSUI_LAYER } from '../hero/HeroStage'

/**
 * Shifat 13:04Z, option B (?atom): "we can go conceptual using an atom-like 3d model around stone using simple 3d gpgpu
 * particles". The stone is the nucleus; three tilted elliptical orbits of particles flow around it, simulated on the GPU
 * (FBO ping-pong: each particle chases its point on its orbit through a little curl noise, so the bands breathe and
 * trail instead of running on rails). Black / white / silver beads with a few iridescent glints. 64 × 64 = 4096
 * particles on every tier (PERF RULES: same object count; only the point size follows the DPR).
 * The SYSTEMS SEQUENCE (13:13Z) morphs these particles into the flat UI drum (UiCylinder.tsx drives `morph`).
 * On SYSUI_LAYER, so the stone's env capture sees the orbits and refracts them where they pass behind it.
 */
const N = 64
const SIM_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
const SIM_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D u_pos, u_seed, u_local;
uniform float u_t, u_dt, u_init, u_open, u_morph;
uniform mat4 u_part[12];
varying vec2 vUv;
vec3 hash3(vec3 p){ p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0; }
vec3 noise3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z); }
mat3 rx(float a){ float c = cos(a), s = sin(a); return mat3(1,0,0, 0,c,s, 0,-s,c); }
mat3 rz(float a){ float c = cos(a), s = sin(a); return mat3(c,s,0, -s,c,0, 0,0,1); }
vec3 orbit(vec4 s, float t){
  float k = floor(s.x * 2.999);
  float dir = k == 1.0 ? -1.0 : 1.0;
  float ph = s.y * 6.2831853 + t * (0.30 + 0.22 * s.w) * dir;
  float A = 2.0 * (1.0 + 0.9 * u_open), B = 0.78 * (1.0 + 0.9 * u_open);
  float j = (s.z - 0.5);
  vec3 lp = vec3(cos(ph) * (A + j * 0.32), sin(ph) * (B + j * 0.2), j * 0.16 * sin(ph * 3.0 + s.w * 9.0));
  return rz(k * 2.0943951 + 0.25) * rx(1.12) * lp;
}
void main(){
  vec4 s = texture2D(u_seed, vUv);
  vec4 p = texture2D(u_pos, vUv);
  vec3 tgt = orbit(s, u_t);
  // Shifat 13:13Z: "Start sequence with B then morph into A". Each particle owns a point on one of the 12 flat parts;
  // through the scroll it leaves its orbit (staggered by its seed) and streams onto that point; scrolling up reverses it
  vec4 L = texture2D(u_local, vUv);
  float mi = clamp(u_morph * 1.45 - s.y * 0.45, 0.0, 1.0); mi = mi * mi * (3.0 - 2.0 * mi);
  if (mi > 0.0) {
    int k = int(L.w + 0.5);
    mat4 M = u_part[0];
    for (int i = 1; i < 12; i++) if (i == k) M = u_part[i];
    vec3 pt = (M * vec4(L.xyz, 1.0)).xyz;
    // the stream bows outward on its way (an arc, not a straight cut through the stone)
    vec3 mid = normalize(tgt + pt + vec3(1e-3)) * 0.9 * sin(3.14159 * mi);
    tgt = mix(tgt, pt, mi) + mid * (1.0 - abs(2.0 * mi - 1.0)) * 0.6;
  }
  if (u_init > 0.5) { gl_FragColor = vec4(tgt, 1.0); return; }
  vec3 n = noise3(p.xyz * 0.9 + vec3(0.0, u_t * 0.12, 0.0)) * (1.0 - 0.85 * mi);
  vec3 q = mix(p.xyz, tgt + n * 0.11, 1.0 - exp(-(4.5 + 6.0 * mi) * u_dt));
  gl_FragColor = vec4(q, 1.0);
}`
const PT_VERT = /* glsl */ `
uniform sampler2D u_pos, u_seed;
uniform float u_px;
attribute vec2 ref;
varying vec4 vSeed; varying float vDist; varying vec3 vView;
void main(){
  vec3 p = texture2D(u_pos, ref).xyz;
  vSeed = texture2D(u_seed, ref);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDist = -mv.z; vView = normalize(-mv.xyz);
  gl_PointSize = u_px * (0.55 + vSeed.w * 0.9) / max(0.5, -mv.z);
  gl_Position = projectionMatrix * mv;
}`
const PT_FRAG = /* glsl */ `
uniform float u_amb, u_on;
varying vec4 vSeed; varying float vDist; varying vec3 vView;
vec3 film(float x){ return 0.5 + 0.5 * cos(6.2831853 * (x + vec3(0.0, 0.33, 0.67))); }
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0; float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  // a tiny glossy bead: a sphere normal from the sprite, a key from above, a crisp spec
  vec3 nrm = vec3(c.x, -c.y, sqrt(1.0 - r2));
  float dif = 0.35 + 0.65 * max(dot(nrm, normalize(vec3(0.3, 0.8, 0.5))), 0.0);
  float spec = pow(max(dot(reflect(-normalize(vec3(0.3, 0.8, 0.5)), nrm), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
  float kind = vSeed.z;
  vec3 base = kind < 0.16 ? vec3(0.02) : kind < 0.62 ? vec3(0.80, 0.82, 0.85) : vec3(0.97);
  vec3 col = base * dif + vec3(spec) * (kind < 0.16 ? 0.9 : 0.6);
  // iridescent glints: thin film by view angle and the bead's own phase
  float g = smoothstep(0.86, 1.0, vSeed.w);
  col = mix(col, film(nrm.z * 0.8 + vSeed.y * 2.0) * (0.7 + spec), g * 0.85);
  float fog = exp(-max(vDist - 6.0, 0.0) * 0.06) * (1.0 - 0.35 * u_amb * smoothstep(8.0, 16.0, vDist));
  gl_FragColor = vec4(col * fog, smoothstep(1.0, 0.7, r2) * u_on);
}`

export class AtomField {
  points: THREE.Points
  private rtA: THREE.WebGLRenderTarget
  private rtB: THREE.WebGLRenderTarget
  private sim: THREE.ShaderMaterial
  private quad: THREE.Mesh
  private cam = new THREE.Camera()
  private scene = new THREE.Scene()
  private seed: THREE.DataTexture
  private inited = false
  mat: THREE.ShaderMaterial
  constructor(private gl: THREE.WebGLRenderer) {
    const float = gl.capabilities.isWebGL2 && gl.extensions.has('EXT_color_buffer_float')
    const opts = { type: float ? THREE.FloatType : THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false }
    this.rtA = new THREE.WebGLRenderTarget(N, N, opts); this.rtB = new THREE.WebGLRenderTarget(N, N, opts)
    const sd = new Float32Array(N * N * 4)
    for (let i = 0; i < N * N; i++) { sd[i * 4] = (i % 3 + 0.5) / 3; sd[i * 4 + 1] = Math.random(); sd[i * 4 + 2] = Math.random(); sd[i * 4 + 3] = Math.random() }
    this.seed = new THREE.DataTexture(sd, N, N, THREE.RGBAFormat, THREE.FloatType); this.seed.needsUpdate = true
    this.sim = new THREE.ShaderMaterial({ vertexShader: SIM_VERT, fragmentShader: SIM_FRAG, depthTest: false, depthWrite: false,
      uniforms: { u_pos: { value: null }, u_seed: { value: this.seed }, u_local: { value: null }, u_part: { value: Array.from({ length: 12 }, () => new THREE.Matrix4()) }, u_morph: { value: 0 }, u_t: { value: 0 }, u_dt: { value: 0.016 }, u_init: { value: 1 }, u_open: { value: 0 } } })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.sim); this.quad.frustumCulled = false; this.scene.add(this.quad)
    const geo = new THREE.BufferGeometry()
    const ref = new Float32Array(N * N * 2)
    for (let i = 0; i < N * N; i++) { ref[i * 2] = ((i % N) + 0.5) / N; ref[i * 2 + 1] = (Math.floor(i / N) + 0.5) / N }
    geo.setAttribute('ref', new THREE.BufferAttribute(ref, 2))
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * N * 3), 3))
    this.mat = new THREE.ShaderMaterial({ vertexShader: PT_VERT, fragmentShader: PT_FRAG, transparent: true, depthWrite: false,
      uniforms: { u_pos: { value: this.rtA.texture }, u_seed: { value: this.seed }, u_px: { value: 60 }, u_amb: { value: 1 }, u_on: { value: 1 } } })
    this.points = new THREE.Points(geo, this.mat)
    this.points.frustumCulled = false; this.points.renderOrder = 12
    this.points.layers.set(SYSUI_LAYER)
  }
  /** the morph targets: for every particle a point on one of the parts' faces (part-local) and the part's index */
  setTargets(parts: THREE.Object3D[]) {
    const d = new Float32Array(N * N * 4), box = new THREE.Box3(), v = new THREE.Vector3()
    const boxes = parts.map((g) => {
      // the part's main slab (its first mesh) in the part's own space
      const m = g.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh
      m.geometry.computeBoundingBox(); box.copy(m.geometry.boundingBox!).translate(m.position)
      return box.clone()
    })
    for (let i = 0; i < N * N; i++) {
      const k = i % parts.length, b = boxes[k]
      v.set(b.min.x + Math.random() * (b.max.x - b.min.x), b.min.y + Math.random() * (b.max.y - b.min.y), b.max.z + 0.01)
      d[i * 4] = v.x; d[i * 4 + 1] = v.y; d[i * 4 + 2] = v.z; d[i * 4 + 3] = k
    }
    this.local?.dispose()
    this.local = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.FloatType); this.local.needsUpdate = true
    this.sim.uniforms.u_local.value = this.local
  }
  private local: THREE.DataTexture | null = null
  /** each part's matrix in the atom's space, every frame (the drum turns and the parts breathe) */
  get partMatrices() { return this.sim.uniforms.u_part.value as THREE.Matrix4[] }
  /** one sim step (main pass only), then the points read the newest positions */
  /** `px`: the bead size in device px at 1 m (the same world size on every screen) */
  step(t: number, dt: number, open: number, pxScale: number, morph = 0) {
    const u = this.sim.uniforms
    u.u_morph.value = morph
    u.u_t.value = t; u.u_dt.value = Math.min(dt, 0.05); u.u_open.value = open
    u.u_init.value = this.inited ? 0 : 1
    u.u_pos.value = this.rtA.texture
    const prev = this.gl.getRenderTarget()
    this.gl.setRenderTarget(this.rtB); this.gl.render(this.scene, this.cam); this.gl.setRenderTarget(prev)
    const tmp = this.rtA; this.rtA = this.rtB; this.rtB = tmp
    this.inited = true
    this.mat.uniforms.u_pos.value = this.rtA.texture
    this.mat.uniforms.u_px.value = pxScale
  }
  dispose() { this.local?.dispose(); this.rtA.dispose(); this.rtB.dispose(); this.seed.dispose(); this.sim.dispose(); this.quad.geometry.dispose(); this.points.geometry.dispose(); this.mat.dispose() }
}
