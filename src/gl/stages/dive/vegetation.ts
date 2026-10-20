import { DIVE_COMMON, CLIP, CAUSTICS_FRAG } from './shaders'

/**
 * Underwater vegetation — kelp ribbons and seagrass blades, one instanced strip each.
 * A blade is a strip (x ∈ [-0.5, 0.5] across, y ∈ [0, 1] along). Per instance: root (xyz), height, width,
 * phase and twist. The vertex shader bends it with the current (phase-varied, stiff at the root), twists the
 * ribbon so it catches the light differently along its length, and parts it around the camera as it glides
 * through. The fragment shader cuts a ruffled ribbon outline, lights it from above with the same caustics as
 * the sand, lets the sun glow through it when you look toward the light (translucency + rim), and fogs it with
 * exactly the water the backdrop uses. MASK renders the same silhouettes black for the god-ray occlusion pass.
 */
export const vegVert = /* glsl */ `
${DIVE_COMMON}
attribute vec4 aRoot;      // xyz root, w height
attribute vec4 aShape;     // x width, y phase, z twist, w kind (0 kelp, 1 grass)
uniform float u_part;      // parting radius around the camera
uniform float u_xk;        // portrait screens pull the forest toward the axis (like the tool labels)
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vUv;
varying float vKind;
varying float vH;
varying float vW;
void main(){
  float y = position.y;                      // 0 root … 1 tip
  float H = aRoot.w, W = aShape.x, ph = aShape.y, kind = aShape.w;
  float h = y * H;
  // twist of the ribbon around its own axis
  float tw = aShape.z + h * (kind > 0.5 ? 0.9 : 0.32) + 0.35 * sin(u_time * 0.4 + ph + h * 0.5);
  vec3 side = vec3(cos(tw), 0.0, sin(tw));
  // width profile: stipe → blade → tapered tip, ruffle handled in the fragment
  float prof = kind > 0.5 ? (1.0 - smoothstep(0.55, 1.0, y) * 0.8) : 1.0;
  vec3 root = aRoot.xyz;
#ifdef FORE
  root.x *= 1.0 + (1.0 - u_xk) * 7.0;                  // portrait: the big near fronds step out of the narrow frame
#else
  root.x *= u_xk;
#endif
  vec3 p = root + side * position.x * W * prof + vec3(0.0, h, 0.0);
  // the current: a slow surge along +x/+z with travelling bends, stiff at the root
  float bendK = pow(y, kind > 0.5 ? 1.6 : 1.25);
  float t = u_time;
  float sway = sin(t * 0.55 + ph - h * 0.28) * 0.62 + sin(t * 1.13 + ph * 1.7 - h * 0.61) * 0.24;
  float crs = sin(t * 0.43 + ph * 2.3 - h * 0.22);
  float amp = kind > 0.5 ? 0.38 * H : 0.55 * H;
  p.x += (0.35 + sway) * amp * bendK * 0.42;
  p.z += (0.20 + crs * 0.55) * amp * bendK * 0.32;
  // parting: blades near the camera lean away from it (only around the camera's own depth)
  vec2 dv = p.xz - u_cam.xz;
  float r = length(dv);
  float near = (1.0 - smoothstep(u_part * 0.35, u_part, r)) * (1.0 - smoothstep(1.5, 4.5, abs(p.y - u_cam.y)));
  p.xz += dv / max(r, 1e-3) * near * bendK * min(H, 4.0) * 0.55;
  p.y -= near * bendK * 0.25 * min(H, 4.0);
  vWorld = p;
  vec3 tangentY = vec3(0.0, 1.0, 0.0);
  vN = normalize(cross(side, tangentY));
  vUv = vec2(position.x, y);
  vKind = kind;
  vH = H;
  vW = W;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`

export const vegFrag = /* glsl */ `
${DIVE_COMMON}
${CAUSTICS_FRAG}
${CLIP}
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vUv;
varying float vKind;
varying float vH;
varying float vW;
void main(){
  splitClip();
  float y = vUv.y, x = vUv.x * 2.0;                      // x: -1 … 1 across
  float h = y * vH;
  float a;
  float leaf = 0.0;                                      // 1 on a kelp leaf, 0 on the stipe / grass
  if (vKind > 0.5){
    // seagrass: a clean tapered blade
    float aa = fwidth(x) * 1.2 + 1e-3;
    a = smoothstep(0.0, aa, 1.0 - abs(x)) * (1.0 - smoothstep(0.97, 1.0, y));
  } else {
    // giant kelp: a thin stipe with long leaves alternating up it, angled toward the light
    float W = vW * 0.5;
    vec2 pw = vec2(x * W, h);
    float aa = fwidth(pw.x) * 1.3 + 1e-3;
#ifdef FORE
    aa += 0.05;                                         // out of focus: soft edges
#endif
    float st = 0.022 * (1.0 - y * 0.5);
    a = smoothstep(st + aa, st, abs(pw.x));
    leaf = 0.85;                                         // the stipe is thick: no edge glow
    float sp = 0.34, Lf = 0.78;
    float k0 = floor(h / sp);
    for (int j = 0; j < 3; j++){
      float k = k0 - float(j);
      if (k < 2.0) break;
      float s = mod(k, 2.0) < 1.0 ? 1.0 : -1.0;
      float ang = 0.42 + 0.12 * sin(k * 3.7);
      vec2 dir = vec2(s * sin(ang), cos(ang));
      vec2 rel = pw - vec2(0.0, k * sp);
      float al = dot(rel, dir), pe = dot(rel, vec2(dir.y, -dir.x));
      float Lk = Lf * (0.75 + 0.25 * sin(k * 1.3)) * (1.0 - 0.4 * smoothstep(0.85, 1.0, y));
      float u = clamp(al / Lk, 0.0, 1.0);
      float hw = 0.085 * pow(sin(3.14159 * u), 0.65) * (1.0 + 0.18 * sin(al * 38.0));
      float inl = smoothstep(hw + aa, hw - aa, abs(pe)) * step(0.0, al) * step(al, Lk);
      if (inl > a) { a = inl; leaf = 1.0 - abs(pe) / max(hw, 1e-3) * 0.6; }
    }
  }
#ifdef FORE
  if (a < 0.02) discard;
#else
  if (a < 0.5) discard;
#endif
#ifdef MASK
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
#else
  vec3 p = vWorld;
  vec3 v = p - u_cam;
  float dist = length(v);
  vec3 V = v / dist;
  vec3 N = vN * (dot(vN, V) > 0.0 ? -1.0 : 1.0);         // two-sided: face the eye
  float d = max(-p.y, 0.0);
  vec3 toSun = -u_sun;
  // albedo: olive-amber kelp (paler, more golden leaves toward the light), greener seagrass
  vec3 alb = vKind > 0.5 ? mix(vec3(0.22, 0.34, 0.10), vec3(0.55, 0.66, 0.22), smoothstep(0.0, 1.0, y))
                         : mix(vec3(0.20, 0.16, 0.06), vec3(0.42, 0.34, 0.11), leaf);
  alb *= 0.9 + 0.1 * sin(h * 23.0);
  vec3 sunAt = exp(-K * d);
  float ndl = abs(dot(N, toSun));
  vec3 c = causticsAt(surfaceEntry(p), d, dist);
  if (vKind > 0.5) ndl = 0.6 + 0.4 * ndl;              // thin blades scatter light all round
  vec3 lit = sunAt * ndl * (0.45 + 0.55 * c) * 0.6;
  // translucency: the sun through the leaf when looking toward the light. Thin rims glow gold-green, the
  // thicker core stays darker; a scattering rim catches the light on the silhouette edges.
  float back = pow(max(dot(V, toSun), 0.0), 2.0);
  float rimK = vKind > 0.5 ? smoothstep(0.3, 1.0, abs(x)) : 1.0 - leaf;      // 0 core … 1 thin edge
  vec3 glowC = vec3(0.66, 0.80, 0.34);
  vec3 trans = sunAt * glowC * (back * (0.5 + 0.9 * rimK) + 0.05) * (0.65 + 0.35 * c.g);
  float rim = pow(1.0 - abs(dot(N, V)), 2.5);
  vec3 amb = inscatter(vec3(0.0, 1.0, 0.0), d) * (vKind > 0.5 ? 1.1 : 0.5);
  vec3 col = alb * (lit + amb) * (0.75 + 0.25 * rimK) + trans * mix(alb * 2.0, glowC, 0.45) + rim * sunAt * glowC * 0.22 * (0.3 + back);
  // the same water as the backdrop: extinction + in-scatter veil, red dies first
  vec3 tv = exp(-KV * dist);
  float dc = max(-u_cam.y, 0.02);
  vec3 fogC = inscatter(V, mix(dc, dc + max(-V.y, 0.0) * 4.0, 0.85));
  col = col * tv + fogC * (1.0 - tv) + rayVeil(V, dc, min(dist, 18.0));
  col *= 1.0 - u_deep * 0.85;
#ifdef FORE
  // close to the lens: a darker, softer silhouette that only carries the backlight
  col = mix(fogC * 0.3, col, 0.4);
  gl_FragColor = vec4(col, a * 0.92 * smoothstep(0.35, 1.2, dist));
#else
  gl_FragColor = vec4(col, 1.0);
#endif
#endif
}`

/** The light the god-ray pass blurs: the bright Snell's window (shimmering with the surface) and the lit water. */
export const rayMaskVert = /* glsl */ `
varying vec2 vNdc;
void main(){ vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`
export const rayMaskFrag = /* glsl */ `
${DIVE_COMMON}
uniform mat4 u_invVP;
uniform vec4 u_sunInfo;    // sun vanishing point in mask uv, behind-camera flag, mask aspect
varying vec2 vNdc;
/** beams: an angular pattern around the sun's vanishing point (the radial blur turns it into shafts that all
    converge on the sun, as parallel shafts do in perspective), slowly re-forming as the surface moves */
float beams(vec2 uv){
  vec2 v = uv - u_sunInfo.xy;
  v.x *= u_sunInfo.w;
  if (u_sunInfo.z > 0.5) v = -v;
  vec2 cs = normalize(v + 1e-5);
  float t = u_time;
  float n = vnoise(cs * 7.0 + vec2(t * 0.11, -t * 0.07)) * 0.62 + vnoise(cs * 19.0 - vec2(t * 0.19, t * 0.13) + 5.1) * 0.38;
  return pow(smoothstep(0.42, 0.9, n), 1.8);
}
void main(){
  vec4 a = u_invVP * vec4(vNdc, -1.0, 1.0), b = u_invVP * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(b.xyz / b.w - a.xyz / a.w);
  float dc = max(-u_cam.y, 0.02);
  vec3 toSun = -u_sun;
  float fwd = max(dot(dir, toSun), 0.0);
  float bm = beams(vNdc * 0.5 + 0.5);
  // lit water: brightest looking toward the light, so shafts stream in even when the window is off-frame
  float L = (0.12 + 0.7 * pow(fwd, 2.0)) * exp(-K.g * dc) * smoothstep(-0.7, 0.4, dir.y)
          * (0.55 + 0.45 * caustic(surfaceEntry(u_cam + dir * 4.0) * 0.5));   // the shafts flicker with the surface
  if (dir.y > 0.0){
    float t = dc / dir.y;
    vec2 hp = u_cam.xz + dir.xz * t;
    float win = smoothstep(0.62, 0.70, dir.y);           // Snell's window edge (cos 48.6° ≈ 0.66)
    float c = caustic(hp * 0.5);                          // the moving surface breaks the light up
    L += win * (0.5 + 0.5 * c) * (0.4 + 1.8 * pow(fwd, 4.0)) * exp(-KV.g * min(t, 40.0));
  }
  L *= bm;
  L = L / (1.0 + 0.5 * L);
  gl_FragColor = vec4(vec3(L * (1.0 - u_deep)), 1.0);
}`
