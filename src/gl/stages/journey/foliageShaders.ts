/**
 * GLSL for the fluffy journey foliage (foliage.ts): one shared lighting model so the grass, the meadow floor and
 * the tree canopies read as one painted landscape. Everything is procedural (no textures).
 *
 * Look: stylised-premium (Ghibli / "Journey"): soft rounded masses lit by a low sun BEHIND the clearing, so every
 * silhouette edge and every blade tip transmits warm gold-green light; shadow sides fall to a cool teal, never black.
 * Depth: foreground warmer and lighter, background cooler, lower-contrast and hazier (aerial perspective).
 */

export const FOLIAGE_NOISE = /* glsl */ `
  float fh2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float fvn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(fh2(i), fh2(i + vec2(1.0, 0.0)), u.x), mix(fh2(i + vec2(0.0, 1.0)), fh2(i + vec2(1.0, 1.0)), u.x), u.y); }
  // large soft meadow swaths (shared by blades and floor so they agree)
  float fpatch(vec2 xz){ return fvn(xz * 0.075) * 0.6 + fvn(xz * 0.23 + 7.3) * 0.4; }
`

/** aerial perspective + the depth colour rule, applied to a lit colour at distance d from the camera */
export const FOLIAGE_DEPTH = /* glsl */ `
  uniform vec3 u_haze; uniform vec3 u_warm;
  vec3 fdepth(vec3 c, float d){
    float nearK = 1.0 - smoothstep(3.0, 16.0, d);
    c *= mix(vec3(1.0), u_warm, nearK);                 // foreground: warmer, a touch lighter
    float farK = smoothstep(20.0, 110.0, d);
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, vec3(lum), farK * 0.28);                 // background: less saturated...
    c = mix(c, u_haze, farK * 0.5);                    // ...cooler and hazier, lower contrast
    return c;
  }
`

const LIGHT_UNIFORMS = /* glsl */ `
  uniform vec3 u_sun; uniform vec3 u_sunCol; uniform vec3 u_sky; uniform vec3 u_bounce; uniform float u_light;
`

// ------------------------------------------------------------------------------------------------ grass blades
export const grassVert = /* glsl */ `
  attribute vec4 aOff;   // root xyz, seed
  attribute vec4 aPrm;   // height, width, yaw, lean
  attribute vec4 aClump; // clump centre x z, clump radius, tint
  uniform float u_time; uniform vec3 u_crew; uniform float u_fadeFar; uniform float u_widen; uniform vec2 u_fieldO;
  varying vec3 vW; varying vec3 vN; varying float vY; varying float vSeed; varying float vTint; varying float vGust;
  ${FOLIAGE_NOISE}
  #include <fog_pars_vertex>
  void main(){
    vec3 root = aOff.xyz; float seed = aOff.w;
    float h = aPrm.x, w = aPrm.y, yaw = aPrm.z;
    float dist = distance(cameraPosition.xz, root.xz);
    // LOD: far blades get wider (they cover more ground each) and sink into the meadow floor before the field ends
    // (measured from the field's own origin, so the edge tapers away from every camera, the high descent shot too)
    h *= 1.0 - smoothstep(u_fadeFar * 0.5, u_fadeFar, distance(u_fieldO, root.xz));
    w *= 1.0 + dist * u_widen;
    // the crewmate parts the grass around its feet (only once it is down on the ground)
    vec2 dc = root.xz - u_crew.xz; float dcl = length(dc) + 1e-4;
    float part = (1.0 - smoothstep(0.2, 0.95, dcl)) * (1.0 - smoothstep(0.3, 1.2, u_crew.y));
    h *= 1.0 - 0.5 * part;
    // tufts: blades lean out from their clump centre, the centre stands tallest -> a soft rounded dome
    vec2 oc2 = root.xz - aClump.xy; float oc = length(oc2); vec2 outD = oc > 1e-4 ? oc2 / oc : vec2(0.0);
    float ocn = clamp(oc / max(aClump.z, 1e-3), 0.0, 1.0);
    h *= 1.0 - 0.32 * ocn * ocn;
    // wind: slow travelling gusts (visible as light rolling across the field) + a quick per-blade flutter
    vec2 wdir = vec2(0.94, 0.33);
    float gust = fvn(root.xz * 0.16 - wdir * u_time * 0.65); gust = smoothstep(0.25, 0.95, gust);
    float flut = sin(u_time * 3.4 + seed * 40.0 + root.x * 1.3);
    #ifndef BUSY_GRASS
    flut *= 0.5;   // b9-grass-v4f: a calmer flutter (less per-blade shimmer)
    #endif
    vec2 bendDir = outD * aPrm.w * (0.35 + ocn) + wdir * (0.18 + 0.62 * gust) + (dc / dcl) * part * 1.5 + vec2(flut, -flut) * 0.06;
    float t = position.y;
    float c = cos(yaw), s = sin(yaw);
    float bl = min(length(bendDir), 1.2);
    vec3 lp = vec3(position.x * w * c, 0.0, position.x * w * s);
    // a curved blade: the tip bends most, and the blade shortens as it bends so its length stays put
    vec3 curve = vec3(bendDir.x * t * t * h, t * h * (1.0 - 0.38 * bl * bl * t), bendDir.y * t * t * h);
    vec3 wp = root + lp + curve;
    vW = wp; vY = t; vSeed = seed; vTint = aClump.w; vGust = gust;
    // fluffy normal: the tuft's dome, nudged along the bend (lights a tuft as one soft mass, not as needles)
    vN = normalize(vec3(outD.x * ocn * 0.85 + bendDir.x * 0.35, 1.0, outD.y * ocn * 0.85 + bendDir.y * 0.35));
    vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`

export const grassFrag = /* glsl */ `
  ${LIGHT_UNIFORMS}
  uniform vec3 u_base; uniform vec3 u_mid; uniform vec3 u_tip; uniform vec3 u_dry; uniform vec3 u_trans;
  varying vec3 vW; varying vec3 vN; varying float vY; varying float vSeed; varying float vTint; varying float vGust;
  ${FOLIAGE_NOISE}
  ${FOLIAGE_DEPTH}
  #include <fog_pars_fragment>
  void main(){
    float pat = fpatch(vW.xz);
  #ifdef BUSY_GRASS
    vec3 tip = mix(u_tip, u_dry, smoothstep(0.5, 0.9, pat) * 0.55 + vSeed * 0.12);
    tip = mix(tip, u_mid * 1.15, vTint * 0.35);
    vec3 col = mix(u_base, u_mid, smoothstep(0.0, 0.5, vY));
    col = mix(col, tip, smoothstep(0.35, 1.0, vY));
  #else
    // b9-grass-v4f (Shifat 10:15 PM "Also grass can be simpler"): the field read as busy pixel noise on the phone because
    // every blade ran dark root -> bright tip with its own tint. Calmer: the colour follows the big soft meadow swaths,
    // per-blade/clump variation a third, root-to-tip contrast about half (?busygrass = live)
    vec3 tip = mix(u_tip, u_dry, smoothstep(0.5, 0.9, pat) * 0.55 + vSeed * 0.04);
    tip = mix(tip, u_mid * 1.15, vTint * 0.12);
    vec3 col = mix(mix(u_base, u_mid, 0.5), u_mid, smoothstep(0.0, 0.5, vY));
    col = mix(col, mix(u_mid, tip, 0.7), smoothstep(0.35, 1.0, vY));
  #endif
    vec3 V = normalize(cameraPosition - vW);
    vec3 N = normalize(vN);
    float wrap = clamp(dot(N, u_sun) * 0.5 + 0.5, 0.0, 1.0);
    vec3 amb = mix(u_bounce, u_sky, N.y * 0.5 + 0.5);
    float ao = mix(0.5, 1.0, smoothstep(0.0, 0.8, vY));          // soft occlusion down in the turf
  #ifndef BUSY_GRASS
    ao = mix(0.76, 1.0, smoothstep(0.0, 0.8, vY));               // b9-grass-v4f: shallower turf darkening
  #endif
    vec3 c = col * (amb + u_sunCol * wrap * 0.45 * u_light) * ao;
    // translucency: looking toward the low sun, the upper blade transmits warm light
    float back = pow(max(dot(-V, u_sun), 0.0), 2.5);
  #ifdef BUSY_GRASS
    c += u_trans * col * back * vY * vY * 1.9 * u_light;
  #else
    c += u_trans * col * back * vY * 1.2 * u_light;               // b9-grass-v4f: tips glow less sharply (vY, not vY^2)
  #endif
    c *= 1.0 + vGust * 0.2 * vY;                                // gust sheen rolling across the field
    c *= mix(0.8, 1.04, smoothstep(0.2, 0.7, fvn(vW.xz * 0.045 + 3.1))); // soft cloud-shadow swaths: painterly depth
  #ifndef BUSY_GRASS
    // b9-grass-v4f: past ~10 m the blades melt into one soft turf tone (the blade's own lit colour, averaged up its
    // height), so the far field is a smooth meadow instead of sub-pixel blade noise
    { float dB = length(cameraPosition - vW); vec3 turf = mix(u_mid, tip, 0.45) * (amb + u_sunCol * wrap * 0.45 * u_light) * 0.92;
      c = mix(c, turf, smoothstep(9.0, 30.0, dB) * 0.7); }
  #endif
    c = fdepth(c, length(cameraPosition - vW));
    gl_FragColor = vec4(c, 1.0);
    #include <fog_fragment>
  }
`

// ------------------------------------------------------------------------------------------------ meadow floor
export const floorVert = /* glsl */ `
  varying vec3 vW; varying vec3 vN;
  #include <fog_pars_vertex>
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = viewMatrix * w;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`
export const floorFrag = /* glsl */ `
  ${LIGHT_UNIFORMS}
  uniform vec3 u_base; uniform vec3 u_mid; uniform vec3 u_tip; uniform vec3 u_dry; uniform vec3 u_trans;
  uniform float u_high; uniform vec3 u_tint;
  varying vec3 vW; varying vec3 vN;
  ${FOLIAGE_NOISE}
  ${FOLIAGE_DEPTH}
  #include <fog_pars_fragment>
  void main(){
    float d = length(cameraPosition - vW);
    float pat = fpatch(vW.xz);
    // under the blades the floor is the turf's lower colour (no dark gaps); far away, grazing views see only tips
    vec3 tip = mix(u_tip, u_dry, smoothstep(0.5, 0.9, pat) * 0.55);
    vec3 col = mix(mix(u_base, u_mid, 0.72), mix(u_mid, tip, 0.5 + 0.25 * pat), smoothstep(4.0, 26.0, d));
    col *= 0.88 + 0.24 * fvn(vW.xz * 1.7);                      // fine clumpy grain
    col *= mix(0.8, 1.04, smoothstep(0.2, 0.7, fvn(vW.xz * 0.045 + 3.1)));
    vec3 N = normalize(vN);
    float wrap = clamp(dot(N, u_sun) * 0.5 + 0.5, 0.0, 1.0);
    vec3 amb = mix(u_bounce, u_sky, N.y * 0.5 + 0.5);
    vec3 c = col * (amb + u_sunCol * wrap * 0.45 * u_light) * mix(0.8, 1.0, smoothstep(2.0, 20.0, d));
    // seen from afar the meadow is all tips: give it the same backlit glow the blades have, so the field has no edge
    vec3 Vd = normalize(cameraPosition - vW);
    float back = pow(max(dot(-Vd, u_sun), 0.0), 2.5);
    c += u_trans * col * back * 0.75 * u_light * smoothstep(2.0, 18.0, d);
    vec3 cd = fdepth(c, d);
    // R7.05 GROUND (Shifat: after the tunnel the land read flat grey): from high up every bit of floor is past the
    // depth haze's reach, so the whole land went 28% grey + 50% haze. While it is high (u_high) the land keeps the
    // forest's own greens instead — woodland / meadow patches, the grass's yellow-green, lit by the light of the moment —
    // and the scene haze (which now takes the sky's horizon colour) rises later, still reaching the far land in full
    if (u_high > 0.001) {
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float pt = fvn(vW.xz * 0.03) * 0.65 + fvn(vW.xz * 0.1 + 7.0) * 0.35;
      float mw = smoothstep(0.38, 0.64, pt);   // v5.3: crisper woodland / meadow edges (was 0.3-0.72: soft blotches read as blur)
      vec3 c1 = mix(vec3(0.05, 0.16, 0.035), vec3(0.18, 0.34, 0.045), mw);
      c1 = mix(c1, vec3(0.32, 0.43, 0.07), smoothstep(0.64, 0.82, fvn(vW.xz * 0.055 + 3.0)) * 0.55); // sunlit meadows
      // v5.3 (phone 66-70 %: the land from high up had no detail below ~10 m, a still frame read as out of focus): tree
      // crowns as clumps in the woodland, a fine grain in the meadows; faded out with distance (the haze has it there)
      float dk = 1.0 - smoothstep(120.0, 270.0, d), dk2 = 1.0 - smoothstep(50.0, 130.0, d);
      // (three rotated octaves, so the value-noise grid never shows as square blobs)
      vec2 q1 = mat2(0.8, -0.6, 0.6, 0.8) * vW.xz, q2 = mat2(0.26, -0.97, 0.97, 0.26) * vW.xz;
      float cr = fvn(vW.xz * 0.27 + 11.0) * 0.5 + fvn(q1 * 0.57 + 5.0) * 0.3 + mix(0.1, fvn(q2 * 1.13 + 2.0) * 0.2, dk2);
      c1 *= mix(1.0, mix(0.7 + 0.5 * smoothstep(0.25, 0.75, cr), 0.92 + 0.16 * cr, mw), dk);
      c1 *= u_tint * (0.85 + 0.3 * clamp(l * 3.0, 0.0, 1.0));
      cd = mix(cd, c1, u_high);
    }
    gl_FragColor = vec4(cd, 1.0);
    #ifdef USE_FOG
      float fogFactor = pow(smoothstep(fogNear, fogFar, vFogDepth), 1.0 + 2.2 * u_high);   // v5.3: 1.4 -> 2.2, near/mid land keeps its greens from high up (far land still fully hazed)
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
    #endif
  }
`

// ------------------------------------------------------------------------------------------------ fluffy trees
/**
 * One material draws a whole tree: bark (kind 0), the dark inner canopy core (kind 1) that fills the gaps, and
 * camera-facing leaf-cluster cards (kind 2) scattered over the canopy lobes. Every canopy vertex carries the
 * canopy's own outward normal, so the whole crown shades as one soft "cotton" mass; each card adds a little dome
 * bump of its own so the puffs read.
 */
export const treeVert = /* glsl */ `
  attribute vec2 aCorner; attribute vec3 aNrm; attribute vec4 aInfo; attribute vec3 aCol; attribute vec2 aExtra;
  uniform float u_time;
  varying vec2 vUv; varying vec3 vNv; varying vec3 vW; varying float vAo; varying float vKind; varying float vSeed;
  varying vec3 vCol; varying float vDist;
  #include <fog_pars_vertex>
  void main(){
    mat4 m = modelMatrix;
    #ifdef USE_INSTANCING
      m = m * instanceMatrix;
    #endif
    vec3 tint = vec3(1.0);
    #ifdef USE_INSTANCING_COLOR
      tint = instanceColor;
    #endif
    vec4 w = m * vec4(position, 1.0);
    vec3 org = (m * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float ph = org.x * 0.37 + org.z * 0.21;
    float sway = aExtra.y;                                   // 0 at the roots -> 1 at the crown top
    w.x += (sin(u_time * 0.8 + ph) * 0.07 + sin(u_time * 1.9 + ph * 1.7) * 0.025) * sway;
    w.z += cos(u_time * 0.63 + ph) * 0.045 * sway;
    float scale = length(m[0].xyz);
    vec4 mv = viewMatrix * w;
    if (aInfo.w > 1.5) {
      // leaf card: a camera-facing puff, gently fluttering
      float r = aInfo.y + sin(u_time * 1.6 + aExtra.x * 23.0 + ph) * 0.09;
      vec2 cs = vec2(cos(r), sin(r));
      vec2 off = vec2(aCorner.x * cs.x - aCorner.y * cs.y, aCorner.x * cs.y + aCorner.y * cs.x);
      mv.xy += off * aInfo.x * scale;
      mv.z += 0.04 * scale;                                   // a hair toward the lens so cards sit over the core
    }
    vUv = aCorner; vKind = aInfo.w; vAo = aInfo.z; vSeed = aExtra.x; vCol = aCol * tint;
    vNv = normalize(mat3(viewMatrix) * normalize(mat3(m) * aNrm));
    vW = w.xyz; vDist = -mv.z;
    vec4 mvPosition = mv;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`

export const treeFrag = /* glsl */ `
  ${LIGHT_UNIFORMS}
  uniform vec3 u_leafDark; uniform vec3 u_leafMid; uniform vec3 u_leafLight; uniform vec3 u_trans; uniform vec3 u_rimCol;
  varying vec2 vUv; varying vec3 vNv; varying vec3 vW; varying float vAo; varying float vKind; varying float vSeed;
  varying vec3 vCol; varying float vDist;
  ${FOLIAGE_DEPTH}
  #include <fog_pars_fragment>
  float puff(vec2 p, float s){
    float d = length(p - vec2(0.0, 0.18)) - 0.56;
    d = min(d, length(p - vec2(-0.4, -0.2)) - 0.44);
    d = min(d, length(p - vec2(0.38, -0.24)) - 0.42);
    float a = atan(p.y, p.x);
    return d + sin(a * 7.0 + s * 31.0) * 0.045 + sin(a * 12.0 + s * 13.0) * 0.03;
  }
  void main(){
    vec3 Lv = normalize(mat3(viewMatrix) * u_sun);
    vec3 Vv = vec3(0.0, 0.0, 1.0);
    vec3 N = normalize(vNv);
    float edge = 0.0;
    if (vKind > 1.5) {
      float d = puff(vUv, vSeed);
      if (d > 0.0) discard;
      edge = smoothstep(-0.3, -0.02, d);                         // 0 inside the puff -> 1 at its rim
      // the puff's own dome: tilt the canopy normal toward the card's edge
      N = normalize(N + vec3(vUv * 0.2, 0.0));
    }
    float wrap = clamp(dot(N, Lv) * 0.5 + 0.5, 0.0, 1.0);
    // backlight: the sun sits behind the trees; light scatters through the thin edges of the crown
    vec3 Vw = normalize(cameraPosition - vW);
    float back = pow(max(dot(-Vw, u_sun), 0.0), 3.0);
    float rim = pow(1.0 - abs(N.z), 2.5);
    vec3 c;
    if (vKind < 0.5) {
      // bark: warm brown, darker at the roots and under the crown
      vec3 bark = vCol * (0.55 + 0.45 * vAo);
      c = bark * (mix(u_bounce, u_sky, 0.4) * 0.9 + u_sunCol * wrap * 0.35 * u_light);
      c += u_rimCol * rim * back * 0.25 * u_light * bark * 2.0;
    } else {
      float t = wrap * 0.6 + vAo * 0.4;
      if (vKind < 1.5) t *= 0.78;                                // the core is the crown's shadowed interior
      vec3 col = mix(u_leafDark, u_leafMid, smoothstep(0.1, 0.52, t));
      col = mix(col, u_leafLight, smoothstep(0.58, 0.98, t));
      col *= vCol;
      c = col * (0.72 + 0.4 * u_light) + u_sky * 0.05 * max(N.y, 0.0);
      // translucency (soft gold-green glow through the edges) + a warm rim on the silhouette
      float thin = mix(0.35, 1.0, edge) * mix(1.0, 0.45, vAo);
      c += u_trans * col * back * thin * 1.6 * u_light;
      c += u_rimCol * rim * (0.25 + 0.75 * back) * 0.22 * u_light * (vKind > 1.5 ? 1.0 : 0.4);
    }
    c = fdepth(c, vDist);
    gl_FragColor = vec4(c, 1.0);
    #include <fog_fragment>
  }
`
