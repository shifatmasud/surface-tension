import { WL_EDGE } from '../../water/waterline'
/**
 * Dive shaders — written fresh. Underwater optics by cheap, honest approximations:
 *  - Beer–Lambert absorption per channel (red dies first): light reaching depth d is exp(−K·d)
 *  - single-scattering in-scatter with a forward lobe toward the refracted sun
 *  - Snell's window: the surface seen from below refracts the sky inside the 48.6° cone; outside it,
 *    total internal reflection mirrors the deep. Per-channel IOR gives the window its thin rainbow rim.
 *  - god rays: a short ray-march where each sample looks up along the sun to the surface point its light
 *    entered through, and reads a drifting shaft pattern there (so shafts converge on the sun, for free)
 *  - caustics on the sand: two drifting cell-edge networks multiplied, projected along the sun
 */
export const DIVE_COMMON = /* glsl */ `
uniform vec3 u_cam;
uniform vec3 u_sun;        // direction the sunlight travels underwater (points down)
uniform vec3 u_sunAir;     // direction toward the sun in air
uniform float u_time, u_deep, u_split, u_star;
uniform float u_amb;       // v3: 0..1 the deep water's own glow takes over from the sunlit water (by depth)
uniform float u_abyss;     // v3: 0..1 the systems deep: exponential fog density, marine snow, the last shafts
uniform float u_sinkK;     // R6.88 SINK: 0..1 how far the tablet has taken us down below the Shade DS scene (the water darkens)
uniform float u_caus;      // caustic strength 0..1 (QA: ?nocaus)
uniform vec2 u_res;
uniform sampler2D u_bn;
const vec3 K  = vec3(0.34, 0.092, 0.072);           // absorption of light from the surface, per unit depth
const vec3 KV = vec3(0.26, 0.10, 0.085);          // extinction along the view
const vec3 SCAT = vec3(0.040, 0.255, 0.315);          // in-scatter albedo (graded: teal, not cyan)

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

/**
 * v3 deep water (Shifat 11:56Z: "interesting deep underwater scene. Exp fog needed too"). Below the sunlit layer the
 * water is not black: a blue-black volume, brighter overhead where the last light comes down, darkest below. This is
 * also the colour the exponential fog fades everything toward, so the deep reads as one volume.
 */
vec3 deepWater(vec3 dir){
  float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  // blue-black below, deep blue at the horizon, a teal-blue glow overhead; a little dimmer the deeper we are
  vec3 c = mix(vec3(0.002, 0.012, 0.028), vec3(0.008, 0.055, 0.105), smoothstep(0.0, 0.55, up));
  c = mix(c, vec3(0.030, 0.150, 0.230), smoothstep(0.5, 1.0, up));
  c += vec3(0.020, 0.110, 0.150) * pow(up, 6.0);                    // the faint glow of the surface, far overhead
  return c * (1.0 - 0.3 * u_abyss) * (1.0 - 0.42 * u_sinkK); // R7.04: 0.72 took the sink to near-black (PC ~5% luma); a deep navy now
}
/** FogExp2: density thickens with depth (u_abyss) */
float deepFog(float dist){
  float d = mix(0.028, 0.052, u_abyss) * dist;
  return 1.0 - exp(-d * d);
}


vec3 inscatter(vec3 dir, float depth){
  float up = dir.y * 0.5 + 0.5;
  float fwd = max(dot(dir, -u_sun), 0.0);
  float ph = 0.34 + 1.05 * up * up * up + 1.1 * pow(fwd, 5.0) + 1.7 * pow(fwd, 40.0);
  return SCAT * exp(-K * max(depth, 0.0)) * ph * (1.0 - u_deep);
}
/** sunlight that reaches a point at depth d, entering through surface point q */
float shaft(vec2 q){
  float t = u_time;
  float a = vnoise(q * vec2(0.42, 0.30) + vec2(t * 0.05, -t * 0.035));
  float b = vnoise(q * vec2(0.95, 0.70) - vec2(t * 0.04, t * 0.06) + 7.3);
  float s = a * 0.65 + b * 0.35;
  return pow(smoothstep(0.32, 0.92, s), 2.2) * 2.6;
}
/** the shafts' average glow along a view segment of length T (closed form of the march with a mean pattern) */
vec3 rayVeil(vec3 dir, float dc, float T){
  vec3 rate = max(K * (-dir.y) + KV, vec3(0.012));
  vec3 g = exp(-K * dc) * (1.0 - exp(-rate * T)) / rate;
  float fwd = max(dot(dir, -u_sun), 0.0);
  return g * 0.29 * vec3(0.30, 0.78, 0.86) * (0.05 + 0.32 * fwd * fwd * fwd) * (1.0 - u_deep);
}
vec2 surfaceEntry(vec3 p){ return p.xz - u_sun.xz * (p.y / u_sun.y); }

/**
 * Caustics, analytically: the surface is a sum of directional gravity waves h(x). Light refracted at x lands
 * displaced by D·∇h (D grows with depth), so the energy that reaches the sand is the inverse area change of
 * that map: I = 1 / |det(I + D·H)|, H the Hessian of h. det = 1 + D·tr(H) + D²·det(H), so the three colour
 * channels (slightly different D: dispersion) cost three multiply-adds once H is known. Where det → 0 the
 * light folds into the sharp bright filaments real caustics are made of. One fixed-point step maps the sand
 * point back to the surface point that feeds it, which bends the network the way real caustics drift.
 */
#define CW 13
const float CL[13] = float[13](0.61, 0.83, 1.07, 1.39, 1.83, 2.37, 0.71, 0.95, 1.23, 1.61, 3.1, 0.52, 2.05);
void cField(vec2 q, float t, out vec2 g, out vec3 h){
  g = vec2(0.0); h = vec3(0.0);
  for (int i = 0; i < CW; i++){
    float fi = float(i);
    float a = fi * 2.39996 + 0.3 + 0.35 * sin(fi * 5.1);
    vec2 k = vec2(cos(a), sin(a)) * (6.28318 / CL[i]);
    float A = 0.0085 * pow(CL[i], 1.6) * (0.75 + 0.5 * fract(fi * 0.618));   // steeper than λ¹: curvature spread over all scales → irregular cells
    float th = dot(q, k) - sqrt(9.8 * length(k)) * t + fi * 1.7;
    float s = sin(th), c = cos(th);
    g += A * c * k;
    h += -A * s * vec3(k.x * k.x, k.y * k.y, k.x * k.y);
  }
}
/** RGB caustic gain (mean ≈ 1) at surface-plane point q; D = focus (0.9 shallow … 1.6 deep); blur = extra softness */
vec3 causticRGB(vec2 q, float D, float blur){
  float t = u_time * 0.42;
  vec2 g; vec3 h;
  cField(q, t, g, h);
  q -= D * g;
  cField(q, t, g, h);
  float tr = h.x + h.y, dt = h.x * h.y - h.z * h.z;
  vec3 Dc = D * vec3(1.05, 1.0, 0.95);
  vec3 det = 1.0 + Dc * tr + Dc * Dc * dt;
  float eps = 0.025 + blur;
  vec3 I = 1.0 / (abs(det) + eps);
  I *= 2.26 * pow(eps, 0.375);                   // mean ≈ 1 at any softness (fitted)
  // knots where filaments cross get brighter, interiors stay dim; renormalised to mean ≈ 1 (fitted)
  return (I * I * 0.55 + I * 0.45) / (0.6 + 0.642 * pow(eps, -0.4535));
}
float caustic(vec2 q){ return causticRGB(q * 0.8, 1.3, 0.05).g; }
`

// R7.11: u_czIntensity is 2.2 on every page load (0 only behind ?oldcaus, the before/after QA switch), so the old
// analytic caustics behind 'czNew' never show; fold the switch at compile time and the compiler drops causticsAt()
// from the seabed and kelp programs (it was still evaluated per pixel: a uniform ternary is not a guaranteed skip)
export const CZ_LINE = typeof location !== 'undefined' && /[?&]oldcaus/.test(location.search) ? 'float czNew = step(0.001, u_czIntensity);' : 'const float czNew = 1.0;'

export const CAUSTICS_FRAG = /* glsl */ `
/** caustics on a surface at depth d whose surface-entry point is q; softened by the pixel footprint (fwidth) */
vec3 causticsAt(vec2 q, float d, float dist){
  vec2 cq = q * 2.6;
  // wave groups: the light focuses harder where the swell lines up (the same pattern drives the shafts), so the
  // network is crisp and bright in patches and soft between them — the ocean, not a pool floor
  float grp = smoothstep(0.05, 0.85, shaft(q * 0.55) * 0.38);
  cq += 0.45 * vec2(vnoise(cq * 0.21 + 3.0), vnoise(cq * 0.21 + 11.0));        // break the wave sum's regularity:
  cq += 0.5 * (vec2(vnoise(cq * 0.6 + 5.0), vnoise(cq * 0.6 + 17.0)) - 0.5);  // large drift + uneven cell sizes
  float fw = length(fwidth(cq));
  float blur = fw * 1.0 + 0.008 + (1.0 - grp) * 0.12 + smoothstep(8.0, 30.0, d) * 0.25 + smoothstep(5.0, 16.0, dist) * 0.35;   // far sand goes soft
  vec3 c = min(causticRGB(cq, 1.0 + 0.035 * d, blur), vec3(9.0));
  return mix(vec3(1.0), c, (0.4 + 0.6 * grp) * exp(-max(d - 11.0, 0.0) * 0.1) * exp(-max(dist - 9.0, 0.0) * 0.08) * u_caus);
}
`

export const CLIP = /* glsl */ `
${WL_EDGE}
void splitClip(){
  // W18-DIVE OVER-UNDER: u_split = the waterline's screen y (0 bottom … 1 top) while the lens crosses; the water
  // world draws below it only (the air render shows above). The edge is shared with the lake and the post meniscus.
  if (u_split < -0.5) return;
  float x = gl_FragCoord.x / u_res.y;
  float edge = u_split + wlEdge(x, u_time);
  if (gl_FragCoord.y > edge * u_res.y) discard;
}
`

export const FLOOR_H = /* glsl */ `
float floorH(vec2 xz){
  float edge = 20.0 + 1.2 * sin(xz.x * 0.23 + 0.7);
  float s = smoothstep(edge, edge + 18.0, xz.y);
  return -11.0 - 40.0 * s + 0.45 * sin(xz.x * 0.37 + xz.y * 0.21) * sin(xz.y * 0.17 - xz.x * 0.11);
}`

/** The water volume around the camera: in-scatter, the surface from below, god rays. */
export const backdropVert = /* glsl */ `
varying vec3 vDir;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`
/** v3 the deep's own glow and its last shafts (jittered by full-res blue noise: drawn at the full density even when the
 *  rest of the volume is shaded at half, R7.10 diveLo, so its fine grain stays the grain of riptide v2) */
export const BACKDROP_AMB = /* glsl */ `if (u_amb > 0.001){
    vec3 deep = deepWater(dir);
    float sh = 0.0;
    for (int i = 0; i < 4; i++){
      float ti = 2.0 + float(i) * 4.5 + jit * 4.5;
      vec3 p = u_cam + dir * ti;
      sh += shaft(p.xz * 0.35 - p.y * u_sun.xz * 0.35 + vec2(0.0, u_time * 0.01)) * exp(-0.06 * ti);
    }
    float upw = smoothstep(-0.25, 0.85, dir.y);
    deep += vec3(0.020, 0.090, 0.125) * sh * upw * (1.0 - 0.5 * u_abyss);
    col = mix(col, deep, u_amb);
  }`
const HZ_SOFT = typeof location !== 'undefined' && /[?&]hzhard\b/.test(location.search) ? '1.0' : 'smoothstep(0.0, 0.08, dir.y)'   // R7.10 b8/b9
export const backdropFrag = /* glsl */ `
${DIVE_COMMON}
${CLIP}
uniform float u_raySteps, u_rayGain;
varying vec3 vDir;

float surfH(vec2 p){
  float t = u_time;
  return 0.050 * sin(dot(p, vec2(0.80, 0.30)) * 1.1 - t * 0.9)
       + 0.034 * sin(dot(p, vec2(-0.40, 0.90)) * 1.7 - t * 1.25)
       + 0.020 * sin(dot(p, vec2(0.95, -0.25)) * 2.9 - t * 1.7)
       + 0.012 * sin(dot(p, vec2(0.20, 1.00)) * 4.6 - t * 2.3)
       + 0.010 * (vnoise(p * 2.2 + t * 0.3) - 0.5);
}
vec3 skyAir(vec3 a){
  float y = clamp(a.y, 0.0, 1.0);
  vec3 c = mix(vec3(1.05, 1.03, 1.0), vec3(0.72, 0.86, 1.06), pow(y, 0.6)) * 1.55;
  float sd = max(dot(a, u_sunAir), 0.0);
  c += vec3(1.0, 0.95, 0.85) * (pow(sd, 900.0) * 30.0 + pow(sd, 24.0) * 1.4);
  return c;
}

void main(){
  splitClip();
  vec3 dir = normalize(vDir);
  float dc = max(-u_cam.y, 0.02);
  float deepView = dc + max(-dir.y, 0.0) * 4.0;
  vec3 col = inscatter(dir, mix(dc, deepView, 0.85));
  float tEnd = 18.0;

  if (dir.y > 0.0){
    float t = dc / dir.y;
    tEnd = min(t, 18.0);
    if (t < 220.0){
      vec2 hp = u_cam.xz + dir.xz * t;
      float e = 0.04;
      float h0 = surfH(hp);
      vec3 n = normalize(vec3(-(surfH(hp + vec2(e, 0.0)) - h0) / e, 1.0, -(surfH(hp + vec2(0.0, e)) - h0) / e));
      n = normalize(mix(vec3(0.0, 1.0, 0.0), n, clamp(6.0 / (t + 3.0), 0.08, 1.0)));   // calm far away (no shimmer)
      float c = dot(dir, n);
      float s2 = max(0.0, 1.0 - c * c);
      vec3 eta = vec3(1.329, 1.333, 1.341);
      vec3 k = 1.0 - eta * eta * s2;
      vec3 win = smoothstep(vec3(0.0), vec3(0.055), k);
      vec3 a = refract(dir, -n, 1.333);
      vec3 sky = skyAir(length(a) > 0.0 ? a : vec3(0.0, 1.0, 0.0));
      float tr = 1.0 - pow(1.0 - sqrt(max(k.g, 0.0)), 5.0);
      vec3 r = reflect(dir, n);
      // W18-DIVE OVER-UNDER: at grazing angles (the view just under the line) total internal reflection mirrors the
      // near-horizontal water, a silvery teal, not the deep (it read as a black band across the top of the frame)
      // R6.97 (phones): a tall portrait frame reaches dir.y ≈ 0.6 at its top edge, still outside the window, and that
      // stretch mirrored the deep (a near-black band for ~6 frames right after the lens went under, then the bright
      // window). Just under the surface the mirror sees the lit shallows, so the deep look comes in with depth.
      float gz = smoothstep(0.0, 0.45, dir.y) * smoothstep(0.5, 3.0, dc);
      vec3 mirror = inscatter(r, dc + 12.0 * gz) * mix(0.95, 0.55, gz) + vec3(0.05, 0.11, 0.12) * (1.0 - gz) * exp(-K * dc);
      float dance = 0.78 + 0.42 * caustic(hp * 1.15);              // the window shimmers as the swell focuses light
      vec3 surf = sky * win * tr * mix(1.0, dance, clamp(4.0 / (t + 2.0), 0.0, 1.0)) + mirror * (1.0 - win * tr);
      // R7.10 b8 (Shifat's real M02s, the dive start: "hard line at the stone's top"): just under the surface (dc → 0.02) the
      // underside faded in over a sliver of view angle (t = dc / dir.y), a hard horizontal line with a dark slab below it.
      // b9: the underside now fades in over the first 0.08 of dir.y above the horizon (≈4.6°, ~100 px on his phone); above
      // that the water is exactly as before (b8 spread the whole fade, which paled the upper water). ?hzhard = the old line
      vec3 tv = exp(-KV * t) * ${HZ_SOFT};
      col = surf * tv + col * (1.0 - tv);
    }
  }

  // god rays: march toward the surface / into the blue
  float N = u_raySteps;
  float jit = texture2D(u_bn, gl_FragCoord.xy / 64.0).r;   // static blue noise: no pattern, no shimmer
  vec3 acc = vec3(0.0);
  float dt = tEnd / N;
  for (int i = 0; i < 16; i++){
    if (float(i) >= N) break;
    float fi = (float(i) + jit) / N;
    float ti = fi * fi * tEnd;                      // dense near the eye, where shafts are big and distinct
    vec3 p = u_cam + dir * ti;
    float d = -p.y;
    if (d <= 0.0) continue;
    acc += shaft(surfaceEntry(p)) * exp(-K * d - KV * ti) * (2.0 * fi);   // × dt/dfi of the quadratic spacing
  }
  float fwd = max(dot(dir, -u_sun), 0.0);
  col += acc * dt * u_rayGain * vec3(0.30, 0.78, 0.86) * (0.07 + 0.52 * pow(fwd, 2.5)) * (1.0 - u_deep); // shafts read as the star of the open-water frames

  col *= 1.0 - u_deep * 0.9;
  // v3: the deep's own glow, and the last light shafts slanting down into it (fading with depth)
#ifndef BD_LO_PASS
  ${BACKDROP_AMB}
#endif
  gl_FragColor = vec4(col, 1.0);
}`

/** Sand: sun-lit, caustics projected along the sun, fogged with the same water as the backdrop. */
export const floorVert = /* glsl */ `
${FLOOR_H}
varying vec3 vWorld;
varying vec3 vNormal2;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.y = floorH(wp.xz);
  float e = 0.25;
  float hx = floorH(wp.xz + vec2(e, 0.0)) - wp.y, hz = floorH(wp.xz + vec2(0.0, e)) - wp.y;
  vNormal2 = normalize(vec3(-hx / e, 1.0, -hz / e));
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`
export const floorFrag = /* glsl */ `
${DIVE_COMMON}
${CAUSTICS_FRAG}
${CLIP}
varying vec3 vWorld;
varying vec3 vNormal2;
void main(){
  splitClip();
  vec3 p = vWorld;
  // sand ripples (normal only)
  float near = exp(-length(p - u_cam) * 0.07);                 // detail only where it can resolve
  float rp = sin(p.x * 3.1 + sin(p.z * 0.8) * 1.6 + p.z * 0.9) * 0.5 + 0.5;
  vec3 n = normalize(vNormal2 + near * (vec3(0.42 * (rp - 0.5), 0.0, 0.22 * (rp - 0.5)) + 0.05 * (vec3(vnoise(p.xz * 6.0), 0.0, vnoise(p.zx * 6.0 + 3.0)) - 0.5)));
  rp = mix(0.5, rp, near);
  vec3 alb = vec3(0.86, 0.76, 0.60) * (0.8 + 0.2 * vnoise(p.xz * 1.7)) * (0.9 + 0.1 * rp) * (0.9 + 0.1 * vnoise(p.xz * 9.0));
  float d = max(-p.y, 0.0);
  vec2 q = surfaceEntry(p);
  float sunL = max(dot(n, -u_sun), 0.0);
  ${CZ_LINE}
  vec3 cOld = czNew > 0.5 ? vec3(1.0) : causticsAt(q, d, length(p - u_cam));
  vec3 light = exp(-K * d) * (sunL * mix(0.6 + 0.48 * cOld, vec3(0.55), czNew) * 0.62) + inscatter(vec3(0.0, 1.0, 0.0), d) * 0.55;
  vec3 col = alb * light;
  vec3 cz = causticLight(p, n);
  col += alb * cz * 0.9 + cz * 0.08;
  vec3 v = p - u_cam;
  float dist = length(v);
  vec3 dir = v / dist;
  vec3 tv = exp(-KV * dist);
  float dc = max(-u_cam.y, 0.02);
  vec3 fogC = inscatter(dir, mix(dc, dc + max(-dir.y, 0.0) * 4.0, 0.85));   // exactly the backdrop's veil: far sand melts into it
  vec3 veil = rayVeil(dir, dc, min(dist, 18.0));
  col = col * tv + fogC * (1.0 - tv) + veil;
  // the deep slope and the plane's borders dissolve into the open water (no visible edges)
  float lose = max(max(smoothstep(14.0, 30.0, d), smoothstep(28.0, 43.0, abs(p.x))), smoothstep(58.0, 76.0, p.z));
  col *= 1.0 - u_deep * 0.85;
  col = mix(col, deepWater(dir), u_amb * (0.3 + 0.7 * deepFog(dist)));
  gl_FragColor = vec4(col, 1.0 - lose);   // fades into the backdrop itself: no seam, no plane edge
}`

/** Fine silt: a wrapped box of points around the camera, slowly sinking. */
export const siltVert = /* glsl */ `
${DIVE_COMMON}
attribute vec3 aRand;
uniform float u_box, u_pxScale, u_size;
varying float vA;
varying float vL;
void main(){
  vec3 base = position * u_box;
  float t = u_time;
  base.y -= t * (0.025 + 0.03 * aRand.y + 0.05 * u_abyss * aRand.z);
  base.x += 0.22 * sin(t * 0.11 + aRand.x * 6.2831);
  base.z += 0.22 * cos(t * 0.09 + aRand.z * 6.2831);
  vec3 rel = mod(base - u_cam + u_box * 0.5, vec3(u_box)) - u_box * 0.5;
  vec3 wp = u_cam + rel;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  float sz = u_size * (0.45 + aRand.x * 1.1) * (1.0 + 0.9 * u_abyss) * u_pxScale / max(dist, 0.1);
  gl_PointSize = clamp(sz, 1.0, 7.0);
  float edge = 1.0 - smoothstep(u_box * 0.32, u_box * 0.5, length(rel));
  vA = smoothstep(0.25, 1.1, dist) * edge * exp(-0.11 * dist) * (sz < 1.0 ? sz : 1.0);
  vL = exp(-K.g * max(-wp.y, 0.0)) * (0.6 + 0.8 * shaft(surfaceEntry(wp)));
  vL += u_amb * (0.16 + 0.22 * u_abyss) * (0.5 + aRand.y);   // marine snow: flakes catching the deep's faint light
}`
export const siltFrag = /* glsl */ `
${DIVE_COMMON}
${CLIP}
varying float vA;
varying float vL;
void main(){
  splitClip();
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c));
  vec3 col = vec3(0.62, 0.86, 0.88) * vL * (1.0 - u_star) * (1.0 - u_deep * 0.8 * (1.0 - u_amb));
  gl_FragColor = vec4(col * a * vA * 0.9, 1.0);
}`

/** Stars: the deep becomes space. Points at infinity around the camera, fading in as the water goes black. */
export const starVert = /* glsl */ `
${DIVE_COMMON}
attribute vec3 aRand;
uniform float u_dpr;
varying float vA;
void main(){
  vec3 wp = u_cam + normalize(position) * 80.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  gl_PointSize = (1.3 + aRand.x * aRand.x * 2.6) * u_dpr;
  float tw = 0.75 + 0.25 * sin(u_time * (0.6 + aRand.y * 1.6) + aRand.z * 40.0);
  vA = u_star * tw * (0.45 + 0.9 * aRand.z * aRand.z);
}`
export const starFrag = /* glsl */ `
${DIVE_COMMON}
${CLIP}
varying float vA;
void main(){
  splitClip();
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.15, length(c));
  gl_FragColor = vec4(vec3(0.86, 0.92, 1.0) * a * vA, 1.0);
}`
