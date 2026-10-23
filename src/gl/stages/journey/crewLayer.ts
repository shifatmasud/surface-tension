import * as THREE from 'three'
import { settings } from '../../../services/settings'
import { LOW_END_GPU, SPLIT } from '../../quality'

/**
 * R6.87 SPLIT RESOLUTION, the crewmate inside a screen (Shifat: "Crewmate model must not be upscaled"; "Only crewmate,
 * stone, project images/videos are my true hi res subjects"). The dive tablet's glass and the journey's screen show an
 * inner world rendered into a background-resolution target. The crewmate is drawn out of that target (it holds the sky
 * and scenery only) into this one, sized to the screen's own pixels at the canvas density, occluded by the inner world's
 * depth (the forest's grass and trees still pass in front of it). The screen's overlay mesh (drawn in the hero pass)
 * samples it through the same mapping as the background picture, so nothing is magnified from a small texture.
 */
export const CREW_LAYER = 12
const VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`
const FS = /* glsl */ `uniform sampler2D u_depth; uniform vec2 u_dscale; varying vec2 vUv; void main(){ gl_FragDepth = texture2D(u_depth, vUv * u_dscale).r; gl_FragColor = vec4(0.0); }`

export class CrewLayer {
  readonly on = SPLIT
  rt: THREE.WebGLRenderTarget
  /** the drawn part's share of the allocation (the overlay samples uv × scale) */
  scale = new THREE.Vector2(1, 1)
  private aw = 16; private ah = 16
  private depthMat = new THREE.ShaderMaterial({ uniforms: { u_depth: { value: null }, u_dscale: { value: new THREE.Vector2(1, 1) } }, vertexShader: VS, fragmentShader: FS, depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth, colorWrite: false })
  private quad: THREE.Mesh; private qs = new THREE.Scene(); private qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private lit = new WeakSet<THREE.Scene>()
  private bb = new THREE.Box3(); private v = new THREE.Vector3()
  stats = { w: 0, h: 0, box: [0, 0, 0, 0] as number[] }
  /** the crewmate's part of the drawn area, in its uv (0..1): x0, y0, x1, y1; x1 <= x0 = nothing drawn */
  uvBox = new THREE.Vector4(0, 0, 0, 0)
  /** the screen rectangle (NDC) of that part, mapped onto a glass by `local(u, v, out)` (the glass's local point) */
  rectOn(mesh: THREE.Object3D, cam: THREE.Camera, local: (u: number, v: number, out: THREE.Vector3) => THREE.Vector3): number[] | null {
    const b = this.uvBox
    if (b.z <= b.x || b.w <= b.y) return null
    mesh.updateWorldMatrix(true, false)
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
    for (let i = 0; i < 4; i++) {
      local(i & 1 ? b.z : b.x, i & 2 ? b.w : b.y, this.v).applyMatrix4(mesh.matrixWorld).applyMatrix4(cam.matrixWorldInverse)
      if (this.v.z > -0.01) return [-1, -1, 1, 1]
      this.v.applyMatrix4(cam.projectionMatrix)
      x0 = Math.min(x0, this.v.x); x1 = Math.max(x1, this.v.x); y0 = Math.min(y0, this.v.y); y1 = Math.max(y1, this.v.y)
    }
    return [x0, y0, x1, y1]
  }
  constructor() {
    this.rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, depthBuffer: true, samples: LOW_END_GPU || settings.TIER === 'low' ? 0 : 4, generateMipmaps: false })
    this.rt.texture.minFilter = this.rt.texture.magFilter = THREE.LinearFilter
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.depthMat); this.quad.frustumCulled = false; this.qs.add(this.quad)
  }
  /** a background target gets a depth texture the crewmate is tested against */
  static depthFor(rt: THREE.WebGLRenderTarget) {
    if (!SPLIT || rt.depthTexture) return
    const d = new THREE.DepthTexture(rt.width, rt.height); d.type = THREE.UnsignedIntType
    rt.depthTexture = d; rt.dispose()
  }
  /** the allocation: grows to fit (never shrinks: no re-allocation churn as the screen grows and shrinks) */
  private fit(w: number, h: number) {
    if (w > this.aw || h > this.ah) {
      this.aw = Math.max(this.aw, Math.ceil(w / 16) * 16); this.ah = Math.max(this.ah, Math.ceil(h / 16) * 16)
      this.rt.setSize(this.aw, this.ah)
    }
  }
  /** mark a crewmate (and the lights of its scene) for the crew-only draw */
  private mark(scene: THREE.Scene, crew: THREE.Object3D) {
    crew.traverse((o) => o.layers.enable(CREW_LAYER))
    if (!this.lit.has(scene)) { this.lit.add(scene); scene.traverse((o) => { if ((o as THREE.Light).isLight) o.layers.enable(CREW_LAYER) }) }
  }
  /**
   * Draw the crewmate alone, w × h px, from `cam` (the same camera and projection the background target used), tested
   * against that target's depth (`bgScale`: the drawn part's share of its allocation).
   */
  render(gl: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera, crew: THREE.Object3D, bg: THREE.WebGLRenderTarget, bgScale: THREE.Vector2, w: number, h: number) {
    w = Math.max(16, Math.round(w)); h = Math.max(16, Math.round(h))
    this.fit(w, h)
    this.mark(scene, crew)
    this.scale.set(w / this.aw, h / this.ah)
    this.stats.w = w; this.stats.h = h
    // the crewmate's rectangle in the target (its bounds projected; the whole target when a corner is behind the lens)
    crew.updateWorldMatrix(true, true)
    this.bb.setFromObject(crew, false)
    let x0 = 1, y0 = 1, x1 = -1, y1 = -1, full = false
    const b = this.bb
    for (let i = 0; i < 8 && !full; i++) {
      this.v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(cam.matrixWorldInverse)
      if (this.v.z > -0.01) { full = true; break }
      this.v.applyMatrix4(cam.projectionMatrix)
      x0 = Math.min(x0, this.v.x); x1 = Math.max(x1, this.v.x); y0 = Math.min(y0, this.v.y); y1 = Math.max(y1, this.v.y)
    }
    if (full) { x0 = -1; y0 = -1; x1 = 1; y1 = 1 }
    const m = 0.04
    x0 = Math.max(-1, x0 - m); y0 = Math.max(-1, y0 - m); x1 = Math.min(1, x1 + m); y1 = Math.min(1, y1 + m)
    const prev = gl.getRenderTarget(), auto = gl.autoClear, ca = gl.getClearAlpha(), cc = gl.getClearColor(new THREE.Color())
    const mask = cam.layers.mask, bgd = scene.background
    this.rt.viewport.set(0, 0, w, h)
    // the whole drawn part is cleared (the overlay samples all of it); only the crewmate's box is drawn
    this.rt.scissor.set(0, 0, w, h); this.rt.scissorTest = true
    gl.setRenderTarget(this.rt); gl.autoClear = false; gl.setClearColor(0x000000, 0)
    gl.clear(true, true, false)
    this.uvBox.set(0, 0, 0, 0)
    if (x1 > x0 && y1 > y0) {
      const sx = Math.floor((x0 * 0.5 + 0.5) * w), sy = Math.floor((y0 * 0.5 + 0.5) * h)
      this.rt.scissor.set(sx, sy, Math.min(w - sx, Math.ceil((x1 - x0) * 0.5 * w) + 2), Math.min(h - sy, Math.ceil((y1 - y0) * 0.5 * h) + 2))
      this.uvBox.set(sx / w, sy / h, (sx + this.rt.scissor.z) / w, (sy + this.rt.scissor.w) / h)
      gl.setRenderTarget(this.rt)
      this.stats.box = [this.rt.scissor.x, this.rt.scissor.y, this.rt.scissor.z, this.rt.scissor.w]
      if (bg.depthTexture) {
        this.depthMat.uniforms.u_depth.value = bg.depthTexture; this.depthMat.uniforms.u_dscale.value.copy(bgScale)
        gl.render(this.qs, this.qc)
      }
      scene.background = null; cam.layers.set(CREW_LAYER)
      try { gl.render(scene, cam) } finally { cam.layers.mask = mask; scene.background = bgd }
    }
    gl.setClearColor(cc, ca); gl.autoClear = auto; gl.setRenderTarget(prev)
  }
  dispose() { this.rt.dispose(); this.depthMat.dispose() }
}
