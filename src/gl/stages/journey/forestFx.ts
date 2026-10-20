import * as THREE from 'three'
import { groundHeight } from './forest'

/**
 * The forest's air and texture, all procedural and cheap:
 *  - grass: one instanced draw of tapered blades that sway in the wind and glow gold when backlit by the low sun
 *  - sun fan: soft crepuscular rays behind the tree line (the trees silhouette against it)
 *  - mist sheets: a few additive veils between the tree layers (depth, aerial perspective)
 *  - motes: pollen drifting in the light
 * Everything keys off the same SUN_DIR as the sky, so the light reads as one source.
 */
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) }

export function buildGrass(low: boolean, tier: 'low' | 'mid' | 'high', sunDir: THREE.Vector3) {
  void low; void tier
  const count = 15000 // PERF lane (eng #5): one count (dead path since the foliage helper; JourneyStage still imports it)
  // a tapered blade: 3 segments, 7 vertices (x across −0.5..0.5, y 0..1)
  const base = new THREE.BufferGeometry()
  const v: number[] = []
  const segs = 3
  for (let i = 0; i < segs; i++) {
    const y0 = i / segs, y1 = (i + 1) / segs, w0 = 1 - y0 * 0.85, w1 = 1 - y1 * 0.85
    if (i < segs - 1) v.push(-0.5 * w0, y0, 0, 0.5 * w0, y0, 0, 0.5 * w1, y1, 0, -0.5 * w0, y0, 0, 0.5 * w1, y1, 0, -0.5 * w1, y1, 0)
    else v.push(-0.5 * w0, y0, 0, 0.5 * w0, y0, 0, 0, 1, 0)
  }
  base.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', base.getAttribute('position'))
  const off = new Float32Array(count * 3), prm = new Float32Array(count * 4)
  const r = rng(11)
  for (let i = 0; i < count; i++) {
    // only where the landing camera looks (toward the sun, −z): a field in front of the lens, denser up close
    const z = 6.5 - Math.pow(r(), 1.35) * 24, half = 4 + (6.5 - z) * 0.55
    const x = (r() * 2 - 1) * half
    off.set([x, groundHeight(x, z) - 0.02, z], i * 3)
    const near = THREE.MathUtils.smoothstep(Math.hypot(x, z - 0.5), 0.7, 4.5)
    const edge = 1 - THREE.MathUtils.smoothstep(-z, 12, 17.5)
    // height, width, yaw, colour seed — short turf at the feet so the star is never hidden
    prm.set([(0.15 + r() * 0.2) * (0.45 + 0.75 * near) * (0.3 + 0.7 * edge), 0.04 + r() * 0.035, r() * Math.PI, r()], i * 4)
  }
  g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3))
  g.setAttribute('aPrm', new THREE.InstancedBufferAttribute(prm, 4))
  g.instanceCount = count
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      u_time: { value: 0 }, u_sun: { value: sunDir.clone() }, u_sunCol: { value: new THREE.Color('#ffc98a') },
      u_base: { value: new THREE.Color('#1a4d24') }, u_tip: { value: new THREE.Color('#58ad45') }, u_dry: { value: new THREE.Color('#93bd56') },
      u_amb: { value: new THREE.Color('#3a5a7a') }, u_opacity: { value: 1 },
    }]),
    vertexShader: `
      attribute vec3 aOff; attribute vec4 aPrm;
      uniform float u_time;
      varying float vH; varying float vSeed; varying vec3 vW;
      #include <fog_pars_vertex>
      void main(){
        float h = aPrm.x, w = aPrm.y, yaw = aPrm.z;
        vec3 p = position;
        float c = cos(yaw), s = sin(yaw);
        vec3 lp = vec3(p.x * w * c, p.y * h, p.x * w * s);
        // wind: a slow travelling gust + a quick flutter, bending the blade more toward the tip
        float gust = sin(u_time * 0.9 + aOff.x * 0.23 + aOff.z * 0.31) * 0.5 + 0.5;
        float flut = sin(u_time * 3.1 + aPrm.w * 40.0 + aOff.x * 1.7);
        float bend = p.y * p.y * h * (0.35 * gust + 0.08 * flut + 0.15);
        lp.x += bend * 0.85; lp.z += bend * 0.35; lp.y -= bend * bend * 0.6;
        vec3 wp = aOff + lp;
        vW = wp; vH = p.y; vSeed = aPrm.w;
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform vec3 u_sun, u_sunCol, u_base, u_tip, u_dry, u_amb; uniform float u_opacity;
      varying float vH; varying float vSeed; varying vec3 vW;
      #include <fog_pars_fragment>
      void main(){
        vec3 tip = mix(u_tip, u_dry, smoothstep(0.7, 1.0, vSeed) * 0.5);
        vec3 col = mix(u_base, tip, smoothstep(0.0, 1.0, vH));
        vec3 V = normalize(cameraPosition - vW);
        // lit from the sun side + sky ambient, darker at the roots (self-occlusion of the turf)
        float ao = mix(0.35, 1.0, smoothstep(0.0, 0.7, vH));
        col *= (u_amb * 0.8 + u_sunCol * 0.5) * ao;
        // backlight: looking toward the low sun the blades transmit gold
        float back = pow(max(dot(-V, u_sun), 0.0), 4.0);
        col += u_sunCol * back * pow(vH, 3.0) * 0.32 * (0.6 + 0.4 * vSeed);
        gl_FragColor = vec4(col, u_opacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  })
  const mesh = new THREE.Mesh(g, mat)
  mesh.frustumCulled = false
  return { mesh, material: mat }
}

/** Soft crepuscular rays fanning from the sun, far behind the tree line: the trees and hills silhouette against them. */
export function buildSunFan(sunDir: THREE.Vector3) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { u_time: { value: 0 }, u_col: { value: new THREE.Color('#ffd49a') }, u_opacity: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float u_time, u_opacity; uniform vec3 u_col; varying vec2 vUv;
      float h(float n){ return fract(sin(n) * 43758.5453); }
      float n1(float x){ float i = floor(x), f = fract(x); return mix(h(i), h(i + 1.0), f * f * (3.0 - 2.0 * f)); }
      void main(){
        float r = length(vUv), a = atan(vUv.y, vUv.x);
        float rays = n1(a * 7.0 + u_time * 0.05) * 0.65 + n1(a * 17.0 - u_time * 0.08) * 0.35;
        rays = smoothstep(0.3, 1.0, rays);
        float fall = exp(-r * 2.6);
        float core = exp(-r * r * 60.0) * 1.4 + exp(-r * 9.0) * 0.5;
        float up = smoothstep(-0.25, 0.15, vUv.y); // the ground hides the lower half
        gl_FragColor = vec4(u_col * (rays * fall * 0.26 * up + core) * u_opacity, 1.0);
      }`,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
  mesh.frustumCulled = false
  mesh.renderOrder = -8
  return { mesh, material: mat }
}

/** Additive veils of morning mist between the tree layers, lit warmer toward the sun. */
export function buildMist(low: boolean) {
  // PERF lane (eng #5): the same four veils on every tier (phones used to get two); each is one cheap additive quad
  void low
  const layers = [[-9, 26, 3.5], [-18, 40, 5.5], [-34, 64, 8], [-58, 110, 12]]
  const group = new THREE.Group()
  const mats: THREE.ShaderMaterial[] = []
  layers.forEach(([z, w, hgt], i) => {
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { u_time: { value: 0 }, u_col: { value: new THREE.Color('#f3ead8') }, u_opacity: { value: 1 }, u_seed: { value: i * 7.3 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float u_time, u_opacity, u_seed; uniform vec3 u_col; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        void main(){
          vec2 p = vec2(vUv.x * 6.0 + u_time * 0.03 + u_seed, vUv.y * 1.6);
          float m = n(p) * 0.6 + n(p * 2.3 + 4.0) * 0.4;
          float band = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.35, 1.0, vUv.y)); // hugs the ground
          float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
          gl_FragColor = vec4(u_col * m * band * edge * 0.11 * u_opacity, 1.0);
        }`,
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w as number, hgt as number), mat)
    mesh.position.set(0, (hgt as number) * 0.5 - 0.6, z as number)
    mesh.frustumCulled = false
    group.add(mesh); mats.push(mat)
  })
  return { group, mats }
}

/** Pollen in the light: slow drifting motes that glow when they sit between the camera and the sun. */
export function buildMotes(low: boolean, pr: number, sunDir: THREE.Vector3) {
  void low
  const N = 180 // PERF lane (eng #5): one mote count; phones already pay less per mote through pr (dpr × render scale)
  const pos = new Float32Array(N * 3), seed = new Float32Array(N)
  const r = rng(5)
  for (let i = 0; i < N; i++) { pos.set([(r() - 0.5) * 14, 0.1 + Math.pow(r(), 1.6) * 2.2, -1 - r() * 12], i * 3); seed[i] = r() }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { u_time: { value: 0 }, u_pr: { value: pr }, u_sun: { value: sunDir.clone() }, u_opacity: { value: 1 } },
    vertexShader: `attribute float aSeed; uniform float u_time, u_pr; uniform vec3 u_sun; varying float vB;
      void main(){
        vec3 p = position;
        float t = u_time * (0.15 + aSeed * 0.2) + aSeed * 30.0;
        p += vec3(sin(t) * 0.5, sin(t * 1.3 + 2.0) * 0.25, cos(t * 0.8) * 0.4);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec3 V = normalize(cameraPosition - (modelMatrix * vec4(p, 1.0)).xyz);
        vB = (0.05 + pow(max(dot(-V, u_sun), 0.0), 8.0) * 1.4) * (0.5 + 0.5 * sin(u_time * 1.7 + aSeed * 50.0));
        gl_PointSize = u_pr * (1.2 + aSeed * 1.8) * 18.0 / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform float u_opacity; varying float vB;
      void main(){ float d = length(gl_PointCoord - 0.5); float a = exp(-d * d * 18.0);
        gl_FragColor = vec4(vec3(1.0, 0.86, 0.6) * a * vB * u_opacity, 1.0); }`,
  })
  const pts = new THREE.Points(g, mat)
  pts.frustumCulled = false
  return { points: pts, material: mat }
}
