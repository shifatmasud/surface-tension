import * as THREE from 'three'
import { fboHelper, FS_VERT } from '../core/fbo'
import { props, shared } from '../../state/props'
import { settings } from '../../services/settings'

/**
 * Heightfield wave sim on the GPU (ping-pong half-float). R = height, G = velocity.
 * The pointer (projected onto the pool) paints a capsule impulse each frame; clicks and the intro
 * add drops. The water/mercury surface samples this texture for displacement and normals.
 */
const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D u_prev;
uniform vec2 u_texel;
uniform vec4 u_from, u_to;         // xy uv, z radius uv, w strength
uniform vec4 u_drops[4];           // xy uv, z radius, w strength
uniform float u_damping;
varying vec2 v_uv;
vec2 capsule(vec2 p, vec2 a, vec2 b){ vec2 ap = p - a, ab = b - a; float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0); return vec2(length(ap - ab * t), t); }
void main(){
  vec4 c = texture2D(u_prev, v_uv);
  float h = c.r, v = c.g;
  float n = texture2D(u_prev, v_uv + vec2(0.0, u_texel.y)).r;
  float s = texture2D(u_prev, v_uv - vec2(0.0, u_texel.y)).r;
  float e = texture2D(u_prev, v_uv + vec2(u_texel.x, 0.0)).r;
  float w = texture2D(u_prev, v_uv - vec2(u_texel.x, 0.0)).r;
  float avg = (n + s + e + w) * 0.25;
  v += (avg - h) * 2.0;
  v *= u_damping;
  h += v;
  h *= 0.998;
  // pointer stroke
  vec2 cap = capsule(v_uv, u_from.xy, u_to.xy);
  float r = mix(u_from.z, u_to.z, cap.y);
  if (r > 0.0) { float k = 1.0 - smoothstep(0.0, r, cap.x); h -= k * k * mix(u_from.w, u_to.w, cap.y); }
  for (int i = 0; i < 4; i++) {
    vec4 d = u_drops[i];
    if (d.w != 0.0) { float dd = length(v_uv - d.xy) / d.z; h -= d.w * exp(-dd * dd * 3.0); }
  }
  // soft walls: calm down near the pool edge
  vec2 edge = smoothstep(0.0, 0.04, v_uv) * smoothstep(0.0, 0.04, 1.0 - v_uv);
  h *= mix(0.9, 1.0, edge.x * edge.y);
  gl_FragColor = vec4(h, v, 0.0, 1.0);
}`

export class RippleSim {
  private a: THREE.WebGLRenderTarget
  private b: THREE.WebGLRenderTarget
  mat: THREE.ShaderMaterial
  private last = new THREE.Vector2(-1, -1)
  private lastR = 0
  readonly size: number
  constructor() {
    this.size = settings.RIPPLE_SIZE
    this.a = fboHelper.createRenderTarget(this.size, this.size, { float: true })
    this.b = fboHelper.createRenderTarget(this.size, this.size, { float: true })
    this.mat = fboHelper.track(new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: FRAG,
      uniforms: {
        u_prev: { value: null }, u_texel: { value: new THREE.Vector2(1 / this.size, 1 / this.size) },
        u_from: { value: new THREE.Vector4() }, u_to: { value: new THREE.Vector4() },
        u_drops: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
        u_damping: { value: 0.988 },
      },
      depthTest: false, depthWrite: false,
    }))
    shared.u_rippleTexel.value.set(1 / this.size, 1 / this.size)
  }
  clear() { fboHelper.clearColor(0, 0, 0, 1, this.a); fboHelper.clearColor(0, 0, 0, 1, this.b) }
  update(dt: number) {
    const u = this.mat.uniforms
    const t = this.a; this.a = this.b; this.b = t
    u.u_prev.value = this.b.texture
    // pointer stroke on the pool (uv), radius and strength from speed
    const p = props.waterPointer
    let r = 0, s = 0
    if (props.waterPointerActive && this.last.x >= 0) {
      const sp = p.distanceTo(this.last) / Math.max(dt, 1e-3)
      r = THREE.MathUtils.clamp(0.012 + sp * 0.004, 0.012, 0.035)
      s = THREE.MathUtils.clamp(sp * 0.0016, 0, 0.012)
    }
    u.u_from.value.set(this.last.x < 0 ? p.x : this.last.x, this.last.x < 0 ? p.y : this.last.y, this.lastR, s)
    u.u_to.value.set(p.x, p.y, r, s)
    this.last.copy(p); this.lastR = r
    const drops = props.drops.splice(0, 4)
    for (let i = 0; i < 4; i++) {
      const d = drops[i]
      u.u_drops.value[i].set(d ? d.x : 0, d ? d.y : 0, d ? d.r : 1, d ? d.s : 0)
    }
    fboHelper.render(this.mat, this.a)
    shared.u_rippleTexture.value = this.a.texture
  }
}
