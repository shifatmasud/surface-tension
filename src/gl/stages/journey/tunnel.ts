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
/** b9-gate-v4f: ?gatehard = the live hard rim (A/B) */
const GATE_DEF: Record<string, number> = (typeof location !== 'undefined' && /[?&]gatehard/.test(location.search)) ? { GATE_HARD: 1 } : {}
const BEND = /* glsl */ `
vec2 bendAt(float d){ return vec2(sin(u_phase + d * 2.2), cos(u_phase * 0.7 + d * 1.7) * 0.6) * u_bend * d * d * u_len * 0.12; }
`
const ZONE = /* glsl */ `
// R7.11 b7v2 COLOUR ZONES (Shifat's palette, linear light): silver #E8ECF5 -> cyan #3FD8FF -> violet #A463FF along the
// tunnel (short cross-fades); t = the scroll through the tube + a share of the depth, so the next zone shows far ahead first
vec3 zoneCol(float t){
  vec3 c = mix(vec3(0.807, 0.838, 0.913), vec3(0.050, 0.686, 1.0), smoothstep(0.30, 0.36, t));
  return mix(c, vec3(0.371, 0.125, 1.0), smoothstep(0.62, 0.68, t));
}
// the mouth: past u_mouth (m ahead) the tube is open (the world shows through); the last metres flare out like a horn
// b9-gate-v4f (Shifat 10:16 PM "Fade the circle gate borders"): the opening's rim was a hard circle against the black
// tube, because 3 m of wall far down the bore projects to a pixel or two. The fade now spans a share of the mouth's own
// distance (14 %, at least 3 m), so the rim feathers over a few % of the circle's radius at any distance (?gatehard = live)
#ifdef GATE_HARD
float mouthW(){ return 3.0; }
#else
float mouthW(){ return max(3.0, u_mouth * 0.14); }
#endif
float mouthOpen(float z){ float w = mouthW(); return smoothstep(u_mouth - w, u_mouth, z); }
`
const PAL = /* glsl */ `
// the tube's colour drifts with the travel: silver-blue → electric violet → cyan (all cool: the site's night palette)
vec3 pal(float t){ return (vec3(0.30, 0.55, 1.0) * (0.5 + 0.5 * cos(6.2832 * (t + 0.00)))
                         + vec3(0.78, 0.32, 1.0) * (0.5 + 0.5 * cos(6.2832 * (t + 0.33)))
                         + vec3(0.20, 0.95, 1.0) * (0.5 + 0.5 * cos(6.2832 * (t + 0.67)))) / 1.5; }
`
const VERT = /* glsl */ `
uniform float u_bend, u_phase, u_len, u_mouth;
varying vec3 vL; varying float vA;
${BEND}
void main(){
  vec3 p = position;                         // cylinder along -z: z in [0, -len], radius in xy
  float d = -p.z / u_len;                    // 0 at the lens → 1 far ahead
  vec2 c = bendAt(d);                        // the gentle curve ahead: the centre line swings off in a slow S
  vL = p; vA = atan(p.y, p.x);
  float fl = smoothstep(u_mouth - 18.0, u_mouth, -p.z);   // b7v2: the mouth flares open (x2.2) over its last 18 m
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p.xy * (1.0 + 1.2 * fl * fl) + c, p.z, 1.0);
}`
const FRAG = /* glsl */ `
uniform float u_on, u_travel, u_stretch, u_time, u_len, u_exit, u_hue, u_rush, u_pulse, u_mouth, u_build, u_wallRing;
uniform vec3 u_outCol;
varying vec3 vL; varying float vA;
float h11(float x){ return fract(sin(x * 127.1) * 43758.5453); }
vec3 film(float t){ return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
${ZONE}
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
  float halo = exp(-fx * fx * 22.0);         // a glow skirt round every line (the cheap bloom). b7-tunnel-v2d: tighter (was 9), so the black between the lanes stays black
  vec3 tint = zoneCol(u_hue + d * 0.35 + (r - 0.5) * 0.04);   // b7v2: the zone's colour (was a continuous drift)
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
  float ringGlow = exp(-rc * rc * 160.0) * step(0.35, h11(floor(rz)));   // v2d: tighter (was 90)
  float beat = 0.7 + 0.3 * sin(floor(rz) * 2.1 + u_time * 3.0);
  // b7-tunnel-v2l ROOT CAUSE of the 66.5 % glow (Tester v2k: default 34.7, ?qhide=wall 4.0, ring overlays already out):
  // the camera passing one of these PAINTED wall rings (and its glow skirt) right at the lens, a soft lavender band round
  // the frame edge. u_wallRing (JourneyStage) takes the painted ring + its glow out over the last stretch of the bore
  // (u 0.80 -> 0.84, ~66.1 -> 66.3 % page), so the exit never flies through a bright band. Streaks, zones, mouth stay.
  col += mix(vec3(0.95, 0.97, 1.0), tint, 0.5) * (ring * 1.8 + ringGlow * 0.45 * u_pulse) * u_stretch * beat * u_wallRing;
  // the wall itself: near-black, a faint cool sheen so the tube reads as a surface, tinted by the drift
  col += vec3(0.012, 0.014, 0.022) * 0.6 * (0.6 + 0.4 * sin(vA * 3.0 + z * 0.05));   // v2d: neutral (the zone tint lives on the streaks and rings only)
  // b7v2 depth: the far end is pure black (darkness falloff; the old navy exit glow is gone), and as the tube forms it
  // lights up from far to near (u_build)
  col *= 1.0 - smoothstep(0.4, 0.92, d);
  float front = mix(1.05, -0.05, u_build);
  col *= smoothstep(front, front + 0.08, d);
  // near the lens the wall fades so nothing smears across the frame; past the mouth the tube is open (the world shows)
  // b7-tunnel-v2: the lip catches the outside light (the sky's horizon colour) over its last ~14 m, so the wall and the
  // world beyond meet in the same light (no dark ring, no glow ring at the seam)
  // b7-tunnel-v2d (Tester: a one-frame grey-lavender wash at 66 %, mean 47 vs 26): the lit band was 14 m deep, so as the
  // mouth reached the lens the lit walls filled the frame. Now a thin 5 m band at the very lip, dimmer, and it fades out
  // as the mouth comes within ~14 m of the lens: the wall goes by dark and the world opens behind it
  float lip = smoothstep(u_mouth - 5.0, u_mouth, z) * smoothstep(3.0, 14.0, u_mouth);
  col = mix(col, u_outCol * 0.6, lip * lip * 0.6);
  // v2d (Tester: the backdrop read dark violet, darkest quartile (8,7,16) vs live (0,0,0)): a black floor, so the wall
  // between the lines is pure black again; the streaks, dots and rings (far above it) keep their colour
  // v2f: the last stretch before the lens clears the lip, the tube's light dims (its lines and ring glows to 30 %), so the
  // exit frame is never brighter than the frames either side of it; the world beyond carries the light from there
  col *= mix(0.3, 1.0, smoothstep(4.0, 22.0, u_mouth));
  col = max(col - vec3(0.008), vec3(0.0));
  float near = smoothstep(0.5, 6.0, z);
  float alpha = u_on * near * (1.0 - mouthOpen(z));
#ifdef GATE_HARD
  gl_FragColor = vec4(col * alpha, alpha);
#else
  // b9-gate-v4f: the hard circle Shifat saw is not the mouth's own fade. Once the mouth is more than ~22 m down the bore,
  // the flared horn folds over in the picture: its screen radius (R/z) shrinks down the plain tube and grows again along
  // the flare, so there is a ring of wall seen edge-on (the fold, ~9-15 m before the mouth) where the wall stops at full
  // alpha: a 1-px edge from black wall to the world. The wall now fades out over the 3 m before that fold, so the rim
  // feathers over a few % of the circle's radius; under ~22 m (no fold) the mouth fade above does it
  float sm = u_mouth - z;
  float kf = smoothstep(21.0, 24.0, u_mouth);
  float sF = 16.3 - 160.0 / max(u_mouth, 1.0);                 // the fold's distance before the mouth (fitted, +-0.4 m)
  alpha *= mix(1.0, smoothstep(sF - 0.3, sF + 3.0, sm), kf);
  // (Shifat 10:17 PM "Add subtle glow too"): a thin, faint cool halo on the wall just outside the feathered rim
  // (premultiplied add: it lifts the black a touch round the opening, never a bright ring); it goes as the tube goes
  float mw = mouthW();
  float gz = (sm - mix(mw * 1.1, sF + 1.0, kf)) / mix(mw * 0.9, 1.6, kf);
  vec3 glowC = mix(vec3(0.42, 0.62, 1.0), u_outCol * 2.0 + vec3(0.05, 0.08, 0.12), 0.35);
  vec3 glow = glowC * 0.03 * exp(-gz * gz) * u_on * near * smoothstep(3.0, 14.0, u_mouth);
  gl_FragColor = vec4(col * alpha + glow, alpha);
#endif
}`

/** the wall uniforms every tunnel material shares (one object: the stage sets them once per frame) */
export function tunnelUniforms(len: number) {
  return {
    u_on: { value: 0 }, u_travel: { value: 0 }, u_stretch: { value: 0 }, u_time: { value: 0 }, u_len: { value: len },
    u_bend: { value: 1 }, u_phase: { value: 0 }, u_exit: { value: 0 },
    u_hue: { value: 0 }, u_rush: { value: 0 }, u_pulse: { value: 0 },
    u_mouth: { value: 1e4 }, u_build: { value: 1 }, u_ringOn: { value: 1 }, u_wallRing: { value: 1 }, u_outCol: { value: new THREE.Color(0, 0, 0) },   // b7v2: the open mouth's distance ahead (m; far = closed), the far-to-near build (0..1)
  }
}

export function buildTunnel(len = 140) {
  const geo = new THREE.CylinderGeometry(4.6, 4.6, len, 96, 140, true)
  geo.rotateX(-Math.PI / 2)                  // axis along z
  geo.translate(0, 0, -len / 2 + 1.0)        // from just behind the lens to len ahead
  const uniforms = tunnelUniforms(len)
  const material = new THREE.ShaderMaterial({ defines: GATE_DEF,
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
uniform float u_bend, u_phase, u_len, u_travel, u_stretch, u_rush, u_hue, u_time, u_mouth, u_build;
attribute vec4 aSeed;                        // x: angle 0..1, y: radius 0..1, z: depth 0..1, w: speed/size seed
varying vec2 vQ; varying vec3 vC; varying float vA;
${BEND}
${ZONE}
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
  float size = mix(0.12, 0.4, r2) * (1.0 + 0.4 * sin(u_time * 2.0 + r1 * 20.0) * 0.5);   // b7v2: smaller dots
  float stretch = 1.0 + (2.5 + 4.0 * u_rush) * u_stretch * (0.4 + 0.6 * r1);
  vec2 q = position.xy;                      // unit quad -0.5..0.5
  vec2 off = dir * q.x * size * stretch + vec2(-dir.y, dir.x) * q.y * size;
  vc.xy += off;
  float front = mix(1.05, -0.05, u_build);
  vQ = q * 2.0; vA = smoothstep(0.6, 5.0, z) * (1.0 - smoothstep(0.4, 0.92, d)) * smoothstep(front, front + 0.08, d) * (1.0 - mouthOpen(z));
  vA *= mix(0.3, 1.0, smoothstep(4.0, 22.0, u_mouth));   // v2f: the dots dim as the mouth nears the lens
  vC = zoneCol(u_hue + d * 0.35 + (r2 - 0.5) * 0.04) * (0.8 + 0.8 * r1);
  gl_Position = projectionMatrix * vc;
}`
const LIGHT_FRAG = /* glsl */ `
uniform float u_on;
varying vec2 vQ; varying vec3 vC; varying float vA;
void main(){
  float rr = dot(vQ, vQ);
  // b7v2: a hard-edged dot with only a tight rim of glow (was a wide soft skirt)
  float glow = exp(-rr * 6.0);
  float core = 1.0 - smoothstep(0.16, 0.16 + fwidth(rr) * 1.5, rr);
  vec3 col = vC * glow * 0.3 + mix(vC, vec3(1.0), 0.55) * core * 1.1;
  gl_FragColor = vec4(col * vA * u_on, 0.0); // additive (dst keeps its alpha)
}`
const RING_VERT = /* glsl */ `
uniform float u_bend, u_phase, u_len, u_travel, u_stretch, u_hue, u_pulse, u_time, u_mouth, u_build;
attribute vec4 aSeed;
varying vec2 vQ; varying vec3 vC; varying float vA; varying float vW;
${BEND}
${ZONE}
void main(){
  float z = mod(aSeed.z * u_len + u_travel * 0.5, u_len);
  float d = z / u_len;
  vec3 c = vec3(bendAt(d), -z);
  vec4 vc = modelViewMatrix * vec4(c, 1.0);
  float R = 4.3 + 0.6 * sin(aSeed.w * 30.0);
  vc.xy += position.xy * R * 2.3;            // a quad wide enough for the ring and its glow
  vQ = position.xy * 2.3;
  float front = mix(1.05, -0.05, u_build);
  vA = smoothstep(1.5, 8.0, z) * (1.0 - smoothstep(0.4, 0.92, d)) * smoothstep(front, front + 0.08, d) * (1.0 - mouthOpen(z)) * u_stretch;
  vA *= smoothstep(4.0, 22.0, u_mouth);   // b7-tunnel-v2f (Tester: at 66.5 % the ring glow filled the frame, mean 35 vs 17/21): the rings go out as the mouth nears the lens
  vW = 0.5 + 0.5 * sin(u_time * 2.4 + aSeed.w * 40.0);  // each ring breathes on its own beat
  vC = mix(vec3(0.95, 0.97, 1.0), zoneCol(u_hue + d * 0.35), 0.6);
  gl_Position = projectionMatrix * vc;
}`
const RING_FRAG = /* glsl */ `
uniform float u_on, u_pulse, u_ringOn;
varying vec2 vQ; varying vec3 vC; varying float vA; varying float vW;
void main(){
  float r = length(vQ);
  float e = r - 1.0;
  float line = exp(-e * e * 900.0);          // the thin bright hoop
  float glow = exp(-e * e * 40.0);           // its halo
  vec3 col = vC * (line * 1.4 + glow * (0.25 + 0.35 * vW) * u_pulse);
  gl_FragColor = vec4(col * vA * u_on * u_ringOn, 0.0);   // b7-tunnel-v2h: u_ringOn (JourneyStage) takes the ring overlays out as the exit starts
}`

function seeds(n: number, seed: number) {
  let s = seed; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  const a = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) { a[i * 4] = r(); a[i * 4 + 1] = r(); a[i * 4 + 2] = r(); a[i * 4 + 3] = r() }
  return new THREE.InstancedBufferAttribute(a, 4)
}
function instanced(n: number, seed: number, shape?: THREE.BufferGeometry) {
  const g = new THREE.InstancedBufferGeometry()
  const quad = shape ?? new THREE.PlaneGeometry(1, 1)
  g.setIndex(quad.getIndex()); g.setAttribute('position', quad.getAttribute('position'))
  g.setAttribute('aSeed', seeds(n, seed)); g.instanceCount = n
  quad.dispose()
  return g
}
const RING_QUAD = typeof location !== 'undefined' && /[?&]ringquad\b/.test(location.search)
const ORBS = 220, RINGS = 18 // PERF HOOK (eng #5): one count on every tier — phones scale the blur, not the lights

/** the glow orbs/streaks (one instanced draw) and the pulse rings (one instanced draw), sharing the wall's uniforms */
export function buildTunnelLights(uniforms: ReturnType<typeof tunnelUniforms>) {
  const common = { transparent: true, depthWrite: false, depthTest: true, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide as THREE.Side }
  const orbMat = new THREE.ShaderMaterial({ defines: GATE_DEF, ...common, vertexShader: LIGHT_VERT, fragmentShader: LIGHT_FRAG, uniforms })
  const ringMat = new THREE.ShaderMaterial({ defines: GATE_DEF, ...common, vertexShader: RING_VERT, fragmentShader: RING_FRAG, uniforms })
  const orbs = new THREE.Mesh(instanced(ORBS, 11), orbMat)
  // b7-tunnel-v2: each ring is an annulus (|vQ| 0.62..1.3: the hoop and all of its glow above 0.3 %) instead of a full quad,
  // so its hollow middle is never shaded: the 18 rings were near-fullscreen quads as they passed the lens. Same look (the
  // halo now ends round instead of at the quad's square edge), far fewer fragments. ?ringquad = the old quads (A/B)
  const ringShape = RING_QUAD ? undefined : new THREE.RingGeometry(0.62 / 2.3, 1.3 / 2.3, 64, 1)
  const rings = new THREE.Mesh(instanced(RINGS, 23, ringShape), ringMat)
  for (const m of [orbs, rings]) { m.frustumCulled = false; m.renderOrder = 7; m.visible = false }
  return { orbs, rings, orbMat, ringMat, counts: { orbs: ORBS, rings: RINGS } }
}

/** b7v2: the zone colour for a hue value (the crewmate's rim takes it inside the tube) */
const Z0 = new THREE.Color(0.807, 0.838, 0.913), Z1 = new THREE.Color(0.05, 0.686, 1.0), Z2 = new THREE.Color(0.371, 0.125, 1.0)
const sst = (a: number, b: number, x: number) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k) }
export function tunnelZoneColor(t: number, out: THREE.Color) { return out.copy(Z0).lerp(Z1, sst(0.30, 0.36, t)).lerp(Z2, sst(0.62, 0.68, t)) }
