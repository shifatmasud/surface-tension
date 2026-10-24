import * as THREE from 'three'

/**
 * W18 — STRUCTURE v3 UPDATE 13:24Z, step 3 "space to forest": the stars become fireflies, the black of space becomes
 * the night sky, and the camera descends through the canopy into the forest.
 *  - fireflies: warm glowing points in a column along the fall (they take over from the fading stars) and a swarm
 *    low in the clearing; each blinks on its own slow clock and drifts; additive, no texture.
 *  - canopy: leafy crowns the camera falls past at tree-top height (procedural leaf masks on camera-facing cards, dark
 *    against the dusk sky with a warm backlit rim), so the descent reads as dropping through the trees.
 * Same counts on every tier; both are a single draw each.
 */
let seed = 11
const R = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

export function buildFireflies(n = 260) {
  seed = 11
  const pos = new Float32Array(n * 3), rnd = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    const col = i < n * 0.45 // the column along the fall
    const a = R() * Math.PI * 2, r = col ? 1.5 + R() * 9 : 2 + Math.pow(R(), 0.7) * 16
    const y = col ? 7 + Math.pow(R(), 0.8) * 36 : 0.4 + R() * 4.5
    pos.set([Math.cos(a) * r + (col ? 1.6 : 0), y, Math.sin(a) * r + (col ? 3.5 : -2)], i * 3)
    rnd.set([R(), R(), R(), R()], i * 4)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4))
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { u_time: { value: 0 }, u_on: { value: 0 }, u_px: { value: 900 }, u_day: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec4 aRnd;
      uniform float u_time, u_px, u_on;
      varying float vA; varying vec3 vC;
      void main(){
        vec3 p = position;
        float t = u_time * (0.25 + aRnd.x * 0.35) + aRnd.y * 40.0;
        p += vec3(sin(t) * 0.9, sin(t * 1.3 + 2.0) * 0.45, cos(t * 0.8) * 0.9) * (0.6 + aRnd.z);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        // a firefly glows for a second or two, then rests in the dark
        float ph = fract(u_time * (0.12 + aRnd.w * 0.16) + aRnd.x * 7.0);
        float blink = smoothstep(0.0, 0.18, ph) * (1.0 - smoothstep(0.32, 0.62, ph));
        vA = u_on * (0.18 + 0.82 * blink);
        vC = mix(vec3(0.85, 1.0, 0.32), vec3(1.0, 0.78, 0.3), aRnd.z);
        float d = max(0.5, -mv.z);
        gl_PointSize = clamp(u_px * (0.2 + 0.1 * aRnd.y) / d, 2.5, 40.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float u_day;
      varying float vA; varying vec3 vC;
      void main(){
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float core = exp(-r * r * 22.0), halo = exp(-r * r * 4.0) * 0.35;
        float a = (core + halo) * vA * (1.0 - smoothstep(0.9, 1.0, r));
        if (a < 0.003) discard;
        gl_FragColor = vec4(vC * a * mix(2.6, 1.2, u_day), 1.0);
      }`,
  })
  const points = new THREE.Points(g, material)
  points.frustumCulled = false; points.renderOrder = 4
  return { points, material }
}

export function buildCanopy() {
  seed = 29
  // crowns placed round the fall: the camera chases the crewmate from about (+2.6, +0.6, +6.8); the crowns sit off
  // that sight line (so the star is never covered) and close to the lens path (so they rush past)
  const spots: [number, number, number, number][] = []
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + R() * 0.3
    const r = 4.5 + R() * 6.5
    const x = 1.3 + Math.cos(a) * r, z = 3.4 + Math.sin(a) * r * 0.9
    spots.push([x, 9 + R() * 9, z, 3.2 + R() * 3.2])
  }
  const N = spots.length
  const quad = new THREE.PlaneGeometry(1, 1)
  const g = new THREE.InstancedBufferGeometry()
  g.index = quad.index; g.setAttribute('position', quad.getAttribute('position')); g.setAttribute('uv', quad.getAttribute('uv'))
  const off = new Float32Array(N * 4), rnd = new Float32Array(N)
  spots.forEach((s, i) => { off.set(s, i * 4); rnd[i] = R() })
  g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4))
  g.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 1))
  g.instanceCount = N
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    defines: (typeof location !== 'undefined' && /[?&]oldcanopy/.test(location.search)) ? { OLD_CANOPY: 1 } : {}, // R7.05 A/B
    extensions: { derivatives: true } as any,
    uniforms: { u_time: { value: 0 }, u_on: { value: 0 }, u_rim: { value: new THREE.Color('#b9d870') }, u_leaf: { value: new THREE.Color('#163a20') }, u_leaf2: { value: new THREE.Color('#3f7a33') } },
    vertexShader: /* glsl */ `
      attribute vec4 aOff; attribute float aRnd;
      uniform float u_time;
      varying vec2 vUv; varying float vR; varying float vD; varying float vK;
      void main(){
        vUv = uv; vR = aRnd;
        // camera-facing card (cylindrical about y would show the edge from above; full billboard)
        vec4 c = modelViewMatrix * vec4(aOff.xyz, 1.0);
        float sway = sin(u_time * 0.6 + aRnd * 20.0) * 0.06;
        vec2 q = position.xy * aOff.w * vec2(1.25, 1.0);
        q = mat2(cos(sway), -sin(sway), sin(sway), cos(sway)) * q;
        c.xy += q;
        vD = -c.z;
        gl_Position = projectionMatrix * c;
        // R7.05 CANOPY (falling through the trees read as big blurry leaf blobs over the whole frame): a crown that would
        // fill a big share of the frame, or that sits over the middle of the picture, fades out before it gets there;
        // the crowns rush past round the edges and the fall stays clean
        vec4 cc = projectionMatrix * vec4(c.xyz - vec3(q, 0.0), 1.0);
        vec2 ndc = cc.xy / max(cc.w, 0.001);
        float span = aOff.w / max(vD, 0.001);                 // crown size / distance ~ share of the frame it covers
        vK = (1.0 - smoothstep(0.4, 0.85, span)) * smoothstep(0.35, 0.85, max(abs(ndc.x), abs(ndc.y) * 0.8));
        #ifdef OLD_CANOPY
        vK = 1.0;
        #endif
      }`,
    fragmentShader: /* glsl */ `
      uniform float u_on; uniform vec3 u_rim, u_leaf, u_leaf2;
      varying vec2 vUv; varying float vR; varying float vD; varying float vK;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){
        vec2 p = vUv - 0.5;
        // a crown: a lumpy disc made of overlapping leaf cells
        float edge = length(p * vec2(1.0, 1.15)) - 0.42 - 0.06 * sin(atan(p.y, p.x) * 7.0 + vR * 30.0);
        vec2 g = (vUv + vR) * 18.0; vec2 id = floor(g); vec2 f = fract(g) - 0.5;
        float leaf = 0.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 o = vec2(float(i), float(j)); vec2 c = o + (vec2(h(id + o), h(id + o + 9.3)) - 0.5) * 0.8 - f;
          float a = h(id + o + 3.1) * 6.283; c = mat2(cos(a), -sin(a), sin(a), cos(a)) * c;
          leaf = max(leaf, smoothstep(0.02, -0.02, length(c * vec2(1.0, 2.1)) - 0.42));
        }
        #ifdef OLD_CANOPY
        float body = smoothstep(0.04, -0.12, edge);
        float a = max(body * 0.94, leaf * smoothstep(0.12, -0.02, edge)) * u_on;
        #else
        // R7.05: a crisp crown edge (one pixel of antialias, not a wide soft falloff that read as blur)
        float aa = max(fwidth(edge), 1e-4) * 1.2;
        float body = smoothstep(aa, -aa, edge + 0.05);
        float a = max(body * 0.97, leaf * smoothstep(0.1, 0.0, edge)) * u_on * vK;
        #endif
        a *= smoothstep(0.6, 2.2, vD);                     // never a flat card filling the lens
        if (a < 0.01) discard;
        // backlit by the low sky: the outer leaves glow warm, the mass stays dark
        // leaves: deep green inside, lighter green leaf faces, backlit yellow-green at the crown's edge
        float rim = smoothstep(-0.16, 0.04, edge);
        vec3 col = mix(u_leaf, u_leaf2, leaf * (0.35 + 0.4 * h(id + 5.0)));
        col = mix(col, u_rim, rim * leaf * 0.55);
        gl_FragColor = vec4(col, a);
      }`,
  })
  const mesh = new THREE.Mesh(g, material)
  mesh.frustumCulled = false; mesh.renderOrder = 3
  return { mesh, material }
}
