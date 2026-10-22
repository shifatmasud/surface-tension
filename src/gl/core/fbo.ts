import * as THREE from 'three'
/**
 * FboHelper (handbook ch.3), written fresh: one oversized triangle covers the screen with no
 * diagonal seam — (-1,-1), (4,-1)… expressed here as (-1,-1),(3,-1),(-1,3) in clip space.
 */
const tri = new THREE.BufferGeometry()
tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
tri.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))

export const FS_VERT = /* glsl */ `
varying vec2 v_uv;
void main(){ v_uv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`

const copyMat = new THREE.ShaderMaterial({
  uniforms: { u_texture: { value: null } },
  vertexShader: FS_VERT,
  fragmentShader: `uniform sampler2D u_texture; varying vec2 v_uv; void main(){ gl_FragColor = texture2D(u_texture, v_uv); }`,
  depthTest: false, depthWrite: false,
})

class FboHelper {
  renderer!: THREE.WebGLRenderer
  private mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> = new THREE.Mesh(tri, copyMat)
  private scene = new THREE.Scene()
  private cam = new THREE.Camera()
  materials: THREE.Material[] = []
  constructor() { this.mesh.frustumCulled = false; this.scene.add(this.mesh) }
  init(r: THREE.WebGLRenderer) { this.renderer = r }
  createRenderTarget(w: number, h: number, opts: { float?: boolean; nearest?: boolean } = {}) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: opts.float ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: opts.nearest ? THREE.NearestFilter : THREE.LinearFilter,
      magFilter: opts.nearest ? THREE.NearestFilter : THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    })
  }
  render(material: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    const r = this.renderer
    const prev = r.getRenderTarget(), auto = r.autoClear
    this.mesh.material = material
    r.autoClear = false
    r.setRenderTarget(target)
    r.render(this.scene, this.cam)
    r.setRenderTarget(prev); r.autoClear = auto
  }
  copy(tex: THREE.Texture, target: THREE.WebGLRenderTarget | null) {
    copyMat.uniforms.u_texture.value = tex
    this.render(copyMat, target)
  }
  clearColor(r: number, g: number, b: number, a: number, target: THREE.WebGLRenderTarget) {
    const gl = this.renderer, prev = gl.getRenderTarget()
    const c = new THREE.Color(); gl.getClearColor(c); const pa = gl.getClearAlpha()
    gl.setRenderTarget(target); gl.setClearColor(new THREE.Color(r, g, b), a); gl.clear(true, false, false)
    gl.setClearColor(c, pa); gl.setRenderTarget(prev)
  }
  /** PERFGOV: stand-in quads for the materials this helper draws (+ `extra`), with the helper's own scene and camera:
   *  prewarm.ts compiles them behind the preloader (the trail's passes used to compile on the first touch) */
  warmJob(extra: THREE.Material[], target: THREE.WebGLRenderTarget | null) {
    const roots = [copyMat, ...this.materials, ...extra].map((m) => { const q = new THREE.Mesh(tri, m); q.frustumCulled = false; return q })
    return { roots, scene: this.scene, camera: this.cam, target }
  }
  /** Material compile counts as a loading task (ch.9.6). */
  track<M extends THREE.Material>(m: M) { this.materials.push(m); return m }
}
export const fboHelper = new FboHelper()
