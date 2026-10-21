import * as THREE from 'three'

/**
 * W18 — Shifat 14:25Z: "Crewmate from starsky to land must go through a lusion.co like tunnel tube". Our own build
 * (Lusion's tunnel is the feel reference only): between the starry space and the night sky over the forest, the stars
 * stretch into streaks that wrap into a cylindrical tube; the camera rides inside, behind the crewmate, along a gently
 * curving path, with speed lines and light rings rushing past in black, silver and iridescent glints. At the exit the
 * streaks shorten back to points and the tube opens into the night sky (the fireflies take over from there).
 *
 * TUNNEL DRAMA (Shifat Oct 21 12:44Z: "glowing lights objects, blur, crazy stuff… ultra fast smoothness even for cheap
 * phone"): the wall now carries hot glow lanes, pulse rings synced to the travel and a colour that drifts through the
 * tube (silver-blue → violet → cyan); two instanced light families fly down the bore toward the lens — glow orbs that
 * stretch into streaks with the speed, and big pulse rings — every instance placed and moved IN THE VERTEX SHADER from a
 * per-instance seed, so the CPU touches nothing per frame (no matrices, no allocations) and each family is ONE draw.
 * Same instance counts on every tier. The zoom blur and the chromatic split live in tunnelBlur.ts / the screen shader.
 *
 * The tube rides with the inner camera (its axis is the view direction) and bends ahead of it in the vertex shader, so
 * the camera's own move from the space orbit to the falling chase happens inside it, unseen. Everything is a pure
 * function of the scroll (u) plus a slow shimmer: reversible, never frozen.
 */
const BEND = /* glsl */ `
vec2 bendAt(float d){ return vec2(sin(u_phase + d * 2.2), cos(u_phase * 0.7 + d * 1.7) * 0.6) * u_bend * d * d * u_len * 0.12; }
`
const PAL = /* glsl */ `
// the tube's colour drifts with the travel: silver-blue → electric violet → cyan (all cool: the site's night palette)
vec3 pal(float t){ return (vec3(0.30, 0.55, 1.0) * (0.5 + 0.5 * cos(6.2832 * (t + 0.00)))
                         + vec3(0.78, 0.32, 1.0) * (0.5 + 0.5 * cos(6.2832 * (t + 0.33)))
                         + vec3(0.20, 0.95, 1.0) * (0.5 + 0.5 * cos(6.2832 * (t + 0.67)))) / 1.5; }
`
const VERT = /* glsl */ `
uniform float u_bend, u_phase, u_len;
varying vec3 vL; varying float vA;
${BEND}
void main(){
  vec3 p = position;                         // cylinder along -z: z in [0, -len], radius in xy
  float d = -p.z / u_len;                    // 0 at the lens → 1 far ahead
  vec2 c = bendAt(d);                        // the gentle curve ahead: the centre line swings off in a slow S
  vL = p; vA = atan(p.y, p.x);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p.xy + c, p.z, 1.0);
}`
const FRAG = /* glsl */ `
uniform float u_on, u_travel, u_stretch, u_time, u_len, u_exit, u_hue, u_rush, u_pulse;
varying vec3 vL; varying float vA;
float h11(float x){ return fract(sin(x * 127.1) * 43758.5453); }
vec3 film(float t){ return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
${PAL}
void main(){
  float z = -vL.z;                           // distance ahead of the lens (m)
  float d = z / u_len;
  float a = (vA / 6.28318 + 0.5) * 112.0;    // 112 lanes round the tube
  float lane = floor(a), fx = fract(a) - 0.5;
  float r = h11(lane + 1.7), r2 = h11(lane * 3.1 + 9.0);
  // speed lines: each lane carries dashes that rush toward the lens; their length is the stretch (stars → streaks),
  // and the rush (scroll speed) stretches them further still
  float sp = 0.6 + r * 0.9;
  float s = (z + u_travel * sp) / (6.0 + r2 * 10.0) + r * 13.0;
  float seg = fract(s);
  float len = mix(0.015, 0.55 + 0.35 * r2, u_stretch) * (1.0 + 0.6 * u_rush);
  float dash = smoothstep(0.0, 0.02, seg) * (1.0 - smoothstep(len, len + 0.03, seg)) * step(0.62, h11(floor(s) + lane * 7.0)); // sparser than before: dark gaps make the glow read
  float thin = exp(-fx * fx * 90.0);
  float halo = exp(-fx * fx * 9.0);          // a soft glow skirt round every line (the cheap bloom: no extra pass)
  vec3 tint = pal(u_hue + r * 0.15);
  vec3 silver = mix(vec3(0.86, 0.9, 0.98), tint, 0.85);
  vec3 col = silver * dash * (thin * (0.5 + 0.9 * r) + halo * 0.12 * u_stretch);
  // a few lanes are iridescent (thin film along their length)
  col = mix(col, film(z * 0.03 + r * 5.0 + u_travel * 0.004) * dash * (thin * 1.3 + halo * 0.4), step(0.86, r2));
  // HOT LANES: every ~9th lane is a glow strip, lit in waves that chase down the bore with the travel
  float hot = step(0.91, h11(lane * 0.37 + 4.2));
  float wave = 0.5 + 0.5 * sin(z * 0.11 - u_travel * 0.09 + r * 6.0);
  col += tint * hot * (thin * 1.6 + halo * 0.5) * wave * wave * u_stretch * (0.8 + 0.6 * u_rush);
  // light rings, every ~22 m, sweeping past — now with a glow skirt and a pulse that beats with the travel
  float rz = (z + u_travel) / 22.0;
  float rc = fract(rz) - 0.5;
  float ring = exp(-rc * rc * 1400.0) * step(0.35, h11(floor(rz)));
  float ringGlow = exp(-rc * rc * 90.0) * step(0.35, h11(floor(rz)));
  float beat = 0.7 + 0.3 * sin(floor(rz) * 2.1 + u_time * 3.0);
  col += mix(vec3(0.95, 0.97, 1.0), pal(u_hue + 0.5), 0.5) * (ring * 1.8 + ringGlow * 0.45 * u_pulse) * u_stretch * beat;
  // the wall itself: near-black, a faint cool sheen so the tube reads as a surface, tinted by the drift
  col += mix(vec3(0.012, 0.014, 0.022), tint * 0.03, 0.4) * (0.6 + 0.4 * sin(vA * 3.0 + z * 0.05));
  // depth: darker far ahead, then the exit glow (the night sky waiting at the end)
  col *= mix(1.0, 0.25, smoothstep(0.35, 1.0, d));
  col += vec3(0.06, 0.09, 0.18) * smoothstep(0.55, 1.0, d) * (0.3 + u_exit * 2.5);
  // near the lens the wall fades so nothing smears across the frame
  float near = smoothstep(0.5, 6.0, z);
  float alpha = u_on * near;
  gl_FragColor = vec4(col * alpha, alpha);
}`

/** the wall uniforms every tunnel material shares (one object: the stage sets them once per frame) */
export function tunnelUniforms(len: number) {
  return {
    u_on: { value: 0 }, u_travel: { value: 0 }, u_stretch: { value: 0 }, u_time: { value: 0 }, u_len: { value: len },
    u_bend: { value: 1 }, u_phase: { value: 0 }, u_exit: { value: 0 },
    u_hue: { value: 0 }, u_rush: { value: 0 }, u_pulse: { value: 0 },
  }
}

export function buildTunnel(len = 140) {
  const geo = new THREE.CylinderGeometry(4.6, 4.6, len, 96, 140, true)
  geo.rotateX(-Math.PI / 2)                  // axis along z
  geo.translate(0, 0, -len / 2 + 1.0)        // from just behind the lens to len ahead
  const uniforms = tunnelUniforms(len)
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms,
  })
  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false; mesh.renderOrder = 6; mesh.visible = false
  return { mesh, material, uniforms }
}

// ---------------------------------------------------------------------------------------------------------------------
// LIGHT OBJECTS: two instanced families, each one draw. The vertex shader owns every instance: its seed → angle, radius,
// start depth, speed, size, colour; its depth wraps with the travel (the objects already exist all along the bore and
// simply come past the lens — no spawn, no pop, reversible with the scroll). Additive, depth-tested, no depth write.
// ---------------------------------------------------------------------------------------------------------------------
const LIGHT_VERT = /* glsl */ `
uniform float u_bend, u_phase, u_len, u_travel, u_stretch, u_rush, u_hue, u_time;
attribute vec4 aSeed;                        // x: angle 0..1, y: radius 0..1, z: depth 0..1, w: speed/size seed
varying vec2 vQ; varying vec3 vC; varying float vA;
${BEND}
${PAL}
void main(){
  float r1 = aSeed.w, r2 = fract(aSeed.w * 7.31 + 0.17);
  // where it lives in the bore: at the wall or floating in the bore (a quarter of them), ahead of the lens
  float rad = r2 < 0.25 ? mix(0.8, 2.6, aSeed.y) : mix(3.2, 4.2, aSeed.y);
  float ang = aSeed.x * 6.28318 + u_travel * 0.004 * (r1 - 0.5); // a slow drift round the bore
  float sp = 0.7 + r1 * 0.9;
  float z = mod(aSeed.z * u_len + u_travel * sp * 0.55, u_len);     // depth ahead, wrapping with the travel
  float d = z / u_len;
  vec3 c = vec3(cos(ang) * rad, sin(ang) * rad, -z);
  c.xy += bendAt(d);
  // view-space billboard, stretched along its own screen-radial direction (the direction it streaks at the lens)
  vec4 vc = modelViewMatrix * vec4(c, 1.0);
  vec2 dir = normalize(vc.xy + vec2(1e-4, 0.0));
  float size = mix(0.18, 0.6, r2) * (1.0 + 0.4 * sin(u_time * 2.0 + r1 * 20.0) * 0.5);
  float stretch = 1.0 + (2.5 + 4.0 * u_rush) * u_stretch * (0.4 + 0.6 * r1);
  vec2 q = position.xy;                      // unit quad -0.5..0.5
  vec2 off = dir * q.x * size * stretch + vec2(-dir.y, dir.x) * q.y * size;
  vc.xy += off;
  vQ = q * 2.0; vA = smoothstep(0.6, 5.0, z) * (1.0 - smoothstep(0.75, 1.0, d));
  vC = pal(u_hue + r2 * 0.3 + 0.1) * (0.8 + 0.8 * r1);
  gl_Position = projectionMatrix * vc;
}`
const LIGHT_FRAG = /* glsl */ `
uniform float u_on;
varying vec2 vQ; varying vec3 vC; varying float vA;
void main(){
  float rr = dot(vQ, vQ);
  float glow = exp(-rr * 3.0);               // the soft skirt
  float core = exp(-rr * 22.0);              // the hot centre
  vec3 col = vC * glow * 0.9 + mix(vC, vec3(1.0), 0.6) * core * 0.9;
  gl_FragColor = vec4(col * vA * u_on, 0.0); // additive (dst keeps its alpha)
}`
const RING_VERT = /* glsl */ `
uniform float u_bend, u_phase, u_len, u_travel, u_stretch, u_hue, u_pulse, u_time;
attribute vec4 aSeed;
varying vec2 vQ; varying vec3 vC; varying float vA; varying float vW;
${BEND}
${PAL}
void main(){
  float z = mod(aSeed.z * u_len + u_travel * 0.5, u_len);
  float d = z / u_len;
  vec3 c = vec3(bendAt(d), -z);
  vec4 vc = modelViewMatrix * vec4(c, 1.0);
  float R = 4.3 + 0.6 * sin(aSeed.w * 30.0);
  vc.xy += position.xy * R * 2.3;            // a quad wide enough for the ring and its glow
  vQ = position.xy * 2.3;
  vA = smoothstep(1.5, 8.0, z) * (1.0 - smoothstep(0.7, 1.0, d)) * u_stretch;
  vW = 0.5 + 0.5 * sin(u_time * 2.4 + aSeed.w * 40.0);  // each ring breathes on its own beat
  vC = mix(vec3(0.95, 0.97, 1.0), pal(u_hue + aSeed.w * 0.5), 0.6);
  gl_Position = projectionMatrix * vc;
}`
const RING_FRAG = /* glsl */ `
uniform float u_on, u_pulse;
varying vec2 vQ; varying vec3 vC; varying float vA; varying float vW;
void main(){
  float r = length(vQ);
  float e = r - 1.0;
  float line = exp(-e * e * 900.0);          // the thin bright hoop
  float glow = exp(-e * e * 40.0);           // its halo
  vec3 col = vC * (line * 1.4 + glow * (0.25 + 0.35 * vW) * u_pulse);
  gl_FragColor = vec4(col * vA * u_on, 0.0);
}`

function seeds(n: number, seed: number) {
  let s = seed; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  const a = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) { a[i * 4] = r(); a[i * 4 + 1] = r(); a[i * 4 + 2] = r(); a[i * 4 + 3] = r() }
  return new THREE.InstancedBufferAttribute(a, 4)
}
function instanced(n: number, seed: number) {
  const g = new THREE.InstancedBufferGeometry()
  const quad = new THREE.PlaneGeometry(1, 1)
  g.setIndex(quad.getIndex()); g.setAttribute('position', quad.getAttribute('position'))
  g.setAttribute('aSeed', seeds(n, seed)); g.instanceCount = n
  quad.dispose()
  return g
}
const ORBS = 220, RINGS = 18 // PERF HOOK (eng #5): one count on every tier — phones scale the blur, not the lights

/** the glow orbs/streaks (one instanced draw) and the pulse rings (one instanced draw), sharing the wall's uniforms */
export function buildTunnelLights(uniforms: ReturnType<typeof tunnelUniforms>) {
  const common = { transparent: true, depthWrite: false, depthTest: true, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide as THREE.Side }
  const orbMat = new THREE.ShaderMaterial({ ...common, vertexShader: LIGHT_VERT, fragmentShader: LIGHT_FRAG, uniforms })
  const ringMat = new THREE.ShaderMaterial({ ...common, vertexShader: RING_VERT, fragmentShader: RING_FRAG, uniforms })
  const orbs = new THREE.Mesh(instanced(ORBS, 11), orbMat)
  const rings = new THREE.Mesh(instanced(RINGS, 23), ringMat)
  for (const m of [orbs, rings]) { m.frustumCulled = false; m.renderOrder = 7; m.visible = false }
  return { orbs, rings, orbMat, ringMat, counts: { orbs: ORBS, rings: RINGS } }
}
