import * as THREE from 'three'

/** the low golden-hour sun sits behind the clearing, a little to the right (the camera looks down -z) */
export const SUN_DIR = new THREE.Vector3(0.28, 0.1, -0.95).normalize()

const NOISE = /* glsl */ `
float h31(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
`

/**
 * Inner sky: one dome that is deep space at u_atmos = 0 (a graded two-hue nebula: magenta-violet and teal,
 * with dark dust lanes) and a clean morning sky at u_atmos = 1. In between it passes through dusk.
 */
export function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { u_atmos: { value: 0 }, u_sun: { value: SUN_DIR }, u_time: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      uniform float u_atmos; uniform vec3 u_sun; uniform float u_time;
      varying vec3 vDir;
      ${NOISE}
      void main(){
        vec3 d = normalize(vDir);
        // ---- space: a real night sky. Near-black with the faintest cool grade, the Milky Way as a soft diagonal band
        // (a brighter warm core, mottled star clouds, dark dust lanes along its spine), a dense unresolved star dust
        // that thickens inside the band, and the old nebula kept only as a faint far accent. Kept low so the
        // crewmate stays the one bright, saturated thing in the frame.
        float g = smoothstep(-0.8, 0.9, d.y * 0.7 + d.x * 0.3);
        vec3 space = mix(vec3(0.0016, 0.002, 0.006), vec3(0.0045, 0.005, 0.012), g);
        vec3 MWN = normalize(vec3(0.55, 0.83, 0.0));
        float lat = dot(d, MWN);
        vec3 core = normalize(vec3(0.35, -0.23, -0.9));
        float toCore = max(dot(d, core), 0.0);
        float wq = fbm(d * 4.0 + 3.7);
        float band = exp(-pow(lat / (0.11 + 0.04 * wq + 0.05 * toCore), 2.0));
        float clouds = fbm(d * 14.0 + vec3(wq * 1.4));
        float fine = fbm(d * 42.0 - 2.0);
        // dust lanes: thin, ragged, hugging the band's spine
        float lane = smoothstep(0.5, 0.75, fbm(d * vec3(18.0, 18.0, 18.0) + vec3(5.1, 1.3, 0.0) + vec3(clouds))) * exp(-pow((lat + 0.01 * (wq - 0.5)) / 0.028, 2.0));
        float glow = band * pow(clouds, 1.6) * (0.6 + 0.8 * fine) * (0.5 + 0.9 * pow(toCore, 3.0));
        glow *= 1.0 - 0.6 * lane;
        vec3 mwCol = mix(vec3(0.05, 0.062, 0.1), vec3(0.085, 0.08, 0.09), pow(toCore, 2.0) * band); // cool and deep; only the core warms a touch
        space += mwCol * glow * 0.62;
        // the nebula, demoted to a faint far accent
        vec3 q = d * 1.15 + vec3(0.0, 0.0, u_time * 0.0015);
        float n1 = fbm(q * 1.7 + vec3(wq * 1.6));
        float region = pow(max(dot(d, normalize(vec3(0.7, 0.35, -0.62))), 0.0), 2.0);
        space += mix(vec3(0.12, 0.03, 0.24), vec3(0.42, 0.08, 0.3), smoothstep(0.42, 0.75, n1)) * smoothstep(0.38, 0.8, n1) * region * 0.06;
        // unresolved star dust: two scales, denser inside the band, a few coloured
        for (int L = 0; L < 2; L++) {
          float sc = L == 0 ? 260.0 : 520.0;
          vec3 cp = d * sc, sid = floor(cp); float sh = h31(sid + float(L) * 17.0);
          float sr = length(fract(cp) - 0.5 - (vec3(h31(sid + 1.3), h31(sid + 2.7), h31(sid + 4.1)) - 0.5) * 0.6);
          float th = mix(L == 0 ? 0.986 : 0.978, L == 0 ? 0.9 : 0.84, band * smoothstep(0.3, 0.7, clouds) * (1.0 - lane));
          float star = step(th, sh) * smoothstep(0.26, 0.0, sr) * (0.25 + 0.75 * pow(h31(sid + 9.1), 3.0));
          vec3 sCol = mix(vec3(0.72, 0.8, 1.0), vec3(1.0, 0.86, 0.72), h31(sid + 5.5));
          space += sCol * star * (L == 0 ? 0.55 : 0.3) * (0.85 + 0.15 * sin(u_time * 1.3 + sh * 60.0));
        }
        // ---- sky (morning): zenith blue → warm horizon, sun glow
        float y = d.y;
        float sd = max(dot(d, u_sun), 0.0);
        vec3 zen = vec3(0.03, 0.12, 0.45), mid = vec3(0.2, 0.4, 0.7), hor = vec3(0.95, 0.5, 0.2), gnd = vec3(0.12, 0.22, 0.14);
        vec3 sky = mix(hor, mix(mid, zen, smoothstep(0.1, 0.42, y)), smoothstep(-0.01, 0.13, y));
        sky = mix(gnd, sky, smoothstep(-0.12, 0.0, y));
        sky += vec3(1.0, 0.5, 0.2) * (pow(sd, 14.0) * 0.18 + pow(sd, 80.0) * 0.2) + vec3(1.0, 0.85, 0.6) * pow(sd, 1500.0) * 5.0;
        // dusk in the middle of the descent
        vec3 dusk = mix(vec3(1.0, 0.36, 0.22), vec3(0.09, 0.05, 0.26), pow(smoothstep(-0.03, 0.6, y), 0.5)) + vec3(1.0, 0.5, 0.25) * (pow(sd, 5.0) * 0.5 + pow(sd, 400.0) * 3.0);
        // below the horizon: a hazy dim land that warms up into the horizon glow (it was a flat dark-violet slab with a
        // hard edge, which showed as a purple band between the hill tops and the sky during the descent)
        // (continuous at the horizon: the land haze reaches exactly the horizon glow at y = 0, so there is no line)
        vec3 duskGnd = mix(vec3(0.05, 0.08, 0.07), dusk, smoothstep(-0.28, 0.0, y));
        dusk = mix(duskGnd, dusk, step(0.0, y));
        float a = u_atmos;
        vec3 col = a < 0.5 ? mix(space, dusk, smoothstep(0.0, 0.5, a)) : mix(dusk, sky, smoothstep(0.5, 1.0, a));
        // dither: the near-black grades would band on 8-bit screens
        col += (h31(vec3(gl_FragCoord.xy, fract(u_time) * 61.0)) - 0.5) * (1.5 / 255.0);
        gl_FragColor = vec4(max(col, 0.0), 1.0);
      }`,
  })
}

/** Star points: a gaussian core with a faint halo (bright ones bloom a touch), a slow, subtle scintillation. */
export function starMaterial(pr: number) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { u_opacity: { value: 1 }, u_time: { value: 0 }, u_pr: { value: pr } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute vec3 aColor; uniform float u_time; uniform float u_pr;
      varying vec3 vC; varying float vS;
      void main(){
        float ph = position.x * 3.1 + position.y * 1.7;
        vC = aColor * (0.86 + 0.14 * sin(u_time * (0.7 + fract(ph) * 1.6) + ph));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        vS = aSize;
        gl_PointSize = (aSize * 1.6 + 1.0) * u_pr;
      }`,
    fragmentShader: /* glsl */ `
      uniform float u_opacity; varying vec3 vC; varying float vS;
      void main(){ vec2 c = gl_PointCoord - 0.5; float r = length(c) * 2.0;
        float core = exp(-r * r * 9.0), halo = exp(-r * 3.5) * 0.12 * smoothstep(1.4, 2.6, vS);
        float a = (core + halo) * smoothstep(1.0, 0.8, r);
        gl_FragColor = vec4(vC * a * u_opacity, 1.0); }`,
  })
}

/** The few bright stars: a tight core, a soft halo and four thin diffraction spikes, gently breathing. */
export function glintStarMaterial(pr: number) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { u_opacity: { value: 1 }, u_time: { value: 0 }, u_pr: { value: pr } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute vec3 aColor; attribute float aAngle; uniform float u_time; uniform float u_pr;
      varying vec3 vC; varying float vA; varying float vTw;
      void main(){
        vC = aColor; vA = aAngle * 0.15; vTw = 0.9 + 0.1 * sin(u_time * 0.9 + aAngle * 7.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * u_pr;
      }`,
    fragmentShader: /* glsl */ `
      uniform float u_opacity; varying vec3 vC; varying float vA; varying float vTw;
      void main(){
        vec2 c = (gl_PointCoord - 0.5) * 2.0;
        float cs = cos(vA), sn = sin(vA); c = mat2(cs, -sn, sn, cs) * c;
        float r = length(c);
        float core = exp(-r * r * 110.0) * 1.5;
        float halo = exp(-r * 7.0) * 0.38;
        float sx = exp(-abs(c.y) * 180.0) * pow(max(1.0 - abs(c.x), 0.0), 3.0);
        float sy = exp(-abs(c.x) * 180.0) * pow(max(1.0 - abs(c.y), 0.0), 3.0);
        float spikes = (sx + sy) * 0.6 * vTw;
        float a = (core + halo + spikes) * smoothstep(1.0, 0.85, r);
        gl_FragColor = vec4(vC * a * u_opacity, 1.0); }`,
  })
}

/** A soft round contact shadow disc. */
export function shadowMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { u_opacity: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float u_opacity; varying vec2 vUv; void main(){ float r = length(vUv - 0.5) * 2.0; float a = pow(smoothstep(1.0, 0.0, r), 1.6); gl_FragColor = vec4(0.02, 0.06, 0.03, a * u_opacity); }`,
  })
}

/**
 * The tablet screen as a water surface. It shows the inner world (render target) and carries the rupture:
 * a gaussian membrane that bulges and stretches with the emerging crewmate, then snaps into travelling rings.
 * Refraction wobble = the surface normal bends the lookup; dispersion on the crests; Fresnel + one specular.
 */
export function screenMaterial(tex: THREE.Texture, size: THREE.Vector2) {
  return new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      u_map: { value: tex }, u_size: { value: size },
      u_center: { value: new THREE.Vector2(0, 0) },   // local xy of the rupture
      u_bulge: { value: 0 }, u_width: { value: 1.5 },
      u_ringT: { value: -1 }, u_ringAmp: { value: 0 },
      u_bright: { value: 1 }, u_time: { value: 0 }, u_gloss: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform vec2 u_center; uniform float u_bulge, u_width, u_ringT, u_ringAmp, u_time;
      varying vec2 vUv; varying vec3 vWPos; varying float vH;
      float height(vec2 p){
        float r = length(p - u_center);
        float h = u_bulge * exp(-pow(r / u_width, 2.0));
        if (u_ringT >= 0.0) {
          float front = u_ringT * 2.6;                       // ring speed (units / s)
          float k = 2.3;                                     // long, calm wavelength
          float env = exp(-pow((r - front) / (1.1 + u_ringT * 0.5), 2.0)) * exp(-u_ringT * 0.7);
          float inner = smoothstep(front, 0.0, r) * exp(-u_ringT * 1.1);
          h += u_ringAmp * (env * (0.5 + 0.5 * sin(k * (r - front))) + inner * (0.5 + 0.5 * sin(k * 1.3 * r - u_ringT * 5.0)) * 0.35);
        }
        return max(h, 0.0); // the surface lifts; it never sinks behind the bezel
      }
      void main(){
        vUv = uv;
        vec3 p = position;
        float h = height(p.xy);
        p.z += h;
        vH = h;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D u_map; uniform vec2 u_size; uniform float u_bright, u_time, u_gloss;
      varying vec2 vUv; varying vec3 vWPos; varying float vH;
      void main(){
        vec3 n = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
        vec3 V = normalize(cameraPosition - vWPos);
        if (dot(n, V) < 0.0) n = -n;
        // refraction: the bent normal shifts the lookup (water over a picture)
        vec2 off = n.xy * 0.11;
        float disp = clamp(abs(vH) * 0.5, 0.0, 1.0);
        vec3 col;
        col.r = texture2D(u_map, vUv - off * (1.0 + 0.10 * disp)).r;
        col.g = texture2D(u_map, vUv - off).g;
        col.b = texture2D(u_map, vUv - off * (1.0 - 0.10 * disp)).b;
        col *= u_bright;
        // liquid glass highlights: Fresnel sheen + one soft key, only where the surface actually bends
        float bend = 1.0 - n.z;  // 0 on flat glass
        float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
        vec3 L = normalize(vec3(-0.4, 0.7, 0.6));
        float spec = pow(max(dot(reflect(-L, n), V), 0.0), 90.0);
        float wet = smoothstep(0.0, 0.08, bend);
        col += vec3(0.9, 0.95, 1.0) * (spec * 1.4 * wet + fres * 0.08 * wet);
        // flat glass: a faint diagonal sheen when we see the tablet from outside
        float sheen = smoothstep(0.55, 1.25, vUv.y * 0.8 + (1.0 - vUv.x) * 0.6); // a soft studio reflection across the top-left of the glass
        col = col * (1.0 - 0.12 * sheen * u_gloss) + vec3(0.75, 0.8, 0.9) * sheen * 0.05 * u_gloss;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    extensions: { derivatives: true } as any,
  })
}

/**
 * Droplets: liquid-glass beads (instanced). Each one is a tiny lens carrying the forest inside it:
 * the view-space normal looks up the inner world, wrapped in a Fresnel rim and a crisp highlight.
 */
export function dropletMaterial(tex: THREE.Texture) {
  return new THREE.ShaderMaterial({
    fog: false,
    uniforms: { u_map: { value: tex }, u_opacity: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main(){
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vec4 mv = viewMatrix * wp; vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D u_map; varying vec3 vN; varying vec3 vV;
      void main(){
        vec3 n = normalize(vN);
        vec2 uv = 0.5 - n.xy * 0.42;                // refracted and flipped, like a real drop
        vec3 col = texture2D(u_map, uv).rgb * 0.85;
        float fres = pow(1.0 - max(dot(n, vV), 0.0), 3.0);
        col = mix(col, vec3(0.75, 0.82, 0.9), fres * 0.7);
        vec3 L = normalize(vec3(-0.4, 0.7, 0.6));
        col += pow(max(dot(reflect(-L, n), vV), 0.0), 120.0) * 2.5;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
}

/** The page behind the tablet: graphite → deep blue, radial, fading to the page colour at the edges. */
export function backdropMaterial() {
  return new THREE.ShaderMaterial({
    fog: false, depthWrite: false,
    uniforms: { u_amount: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float u_amount; varying vec2 vUv;
      void main(){
        vec2 q = (vUv - vec2(0.5, 0.56)) * vec2(1.6, 1.0);
        float r = length(q);
        vec3 page = vec3(0.0055, 0.0055, 0.007);
        vec3 core = mix(vec3(0.035, 0.05, 0.11), vec3(0.06, 0.065, 0.075), smoothstep(-0.2, 0.3, q.y));
        vec3 col = mix(core, page, smoothstep(0.05, 0.42, r));
        gl_FragColor = vec4(mix(page, col, u_amount), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
}
