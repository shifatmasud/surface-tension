import * as THREE from 'three'

/**
 * W18 — Shifat 14:25Z: "Crewmate from starsky to land must go through a lusion.co like tunnel tube". Our own build
 * (Lusion's tunnel is the feel reference only): between the starry space and the night sky over the forest, the stars
 * stretch into streaks that wrap into a cylindrical tube; the camera rides inside, behind the crewmate, along a gently
 * curving path, with speed lines and light rings rushing past in black, silver and iridescent glints. At the exit the
 * streaks shorten back to points and the tube opens into the night sky (the fireflies take over from there).
 *
 * The tube rides with the inner camera (its axis is the view direction) and bends ahead of it in the vertex shader, so
 * the camera's own move from the space orbit to the falling chase happens inside it, unseen. Everything is a pure
 * function of the scroll (u) plus a slow shimmer: reversible, never frozen. One draw, same on every tier.
 */
const VERT = /* glsl */ `
uniform float u_bend, u_phase, u_len;
varying vec3 vL; varying float vA;
void main(){
  vec3 p = position;                         // cylinder along -z: z in [0, -len], radius in xy
  float d = -p.z / u_len;                    // 0 at the lens → 1 far ahead
  // the gentle curve ahead: the tube's centre line swings off in a slow S as it recedes
  vec2 c = vec2(sin(u_phase + d * 2.2), cos(u_phase * 0.7 + d * 1.7) * 0.6) * u_bend * d * d * u_len * 0.12;
  vL = p; vA = atan(p.y, p.x);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p.xy + c, p.z, 1.0);
}`
const FRAG = /* glsl */ `
uniform float u_on, u_travel, u_stretch, u_time, u_len, u_exit;
varying vec3 vL; varying float vA;
float h11(float x){ return fract(sin(x * 127.1) * 43758.5453); }
vec3 film(float t){ return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
void main(){
  float z = -vL.z;                           // distance ahead of the lens (m)
  float d = z / u_len;
  float a = (vA / 6.28318 + 0.5) * 112.0;    // 112 lanes round the tube
  float lane = floor(a), fx = fract(a) - 0.5;
  float r = h11(lane + 1.7), r2 = h11(lane * 3.1 + 9.0);
  // speed lines: each lane carries dashes that rush toward the lens; their length is the stretch (stars → streaks)
  float sp = 0.6 + r * 0.9;
  float s = (z + u_travel * sp) / (6.0 + r2 * 10.0) + r * 13.0;
  float seg = fract(s);
  float len = mix(0.015, 0.55 + 0.35 * r2, u_stretch);
  float dash = smoothstep(0.0, 0.02, seg) * (1.0 - smoothstep(len, len + 0.03, seg)) * step(0.45, h11(floor(s) + lane * 7.0));
  float thin = exp(-fx * fx * 90.0);
  vec3 silver = vec3(0.86, 0.9, 0.98);
  vec3 col = silver * dash * thin * (0.5 + 0.9 * r);
  // a few lanes are iridescent (thin film along their length)
  col = mix(col, film(z * 0.03 + r * 5.0 + u_travel * 0.004) * dash * thin * 1.3, step(0.86, r2));
  // light rings, every ~22 m, sweeping past
  float rz = (z + u_travel) / 22.0;
  float ring = exp(-pow(fract(rz) - 0.5, 2.0) * 1400.0) * step(0.35, h11(floor(rz)));
  col += vec3(0.95, 0.97, 1.0) * ring * 1.4 * u_stretch;
  // the wall itself: near-black, a faint cool sheen so the tube reads as a surface
  col += vec3(0.012, 0.014, 0.022) * (0.6 + 0.4 * sin(vA * 3.0 + z * 0.05));
  // depth: darker far ahead, then the exit glow (the night sky waiting at the end)
  col *= mix(1.0, 0.25, smoothstep(0.35, 1.0, d));
  col += vec3(0.06, 0.09, 0.18) * smoothstep(0.55, 1.0, d) * (0.3 + u_exit * 2.5);
  // near the lens the wall fades so nothing smears across the frame
  float near = smoothstep(0.5, 6.0, z);
  float alpha = u_on * near;
  gl_FragColor = vec4(col * alpha, alpha);
}`

export function buildTunnel(len = 140) {
  const geo = new THREE.CylinderGeometry(4.6, 4.6, len, 96, 140, true)
  geo.rotateX(-Math.PI / 2)                  // axis along z
  geo.translate(0, 0, -len / 2 + 1.0)        // from just behind the lens to len ahead
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { u_on: { value: 0 }, u_travel: { value: 0 }, u_stretch: { value: 0 }, u_time: { value: 0 }, u_len: { value: len }, u_bend: { value: 1 }, u_phase: { value: 0 }, u_exit: { value: 0 } },
  })
  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false; mesh.renderOrder = 6; mesh.visible = false
  return { mesh, material }
}
