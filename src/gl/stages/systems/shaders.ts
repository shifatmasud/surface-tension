import * as THREE from 'three'

/** The airy field the stack rests over, with the lit colour spill under the glass (light, not a UI shadow). */
export function createFloor() {
  const uniforms = {
    uPaper: { value: new THREE.Color('#f7f7f8') },
    uAccent: { value: new THREE.Color('#1f5bff') },
    uAccent2: { value: new THREE.Color('#6fd3ff') },
    uLight: { value: 1 },
    uPulse: { value: -1 },      // seconds since the last "ship" pulse (or -1)
    uCenter: { value: new THREE.Vector2(0, 0) },
    uRot: { value: 0 },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uPaper, uAccent, uAccent2; uniform float uLight, uPulse, uRot; uniform vec2 uCenter;
      varying vec2 vP;
      void main() {
        vec2 p = vP - uCenter;
        float c = cos(uRot), s = sin(uRot);
        vec2 q = mat2(c, -s, s, c) * p;                    // in the stack's own frame (square-ish spill)
        float r2 = dot(p, p);
        // a soft rounded-square core (the light passing through the tiles) and a wide falloff
        vec2 a = abs(q) / 1.55;
        float sq = pow(pow(a.x, 4.0) + pow(a.y, 4.0), 0.25);
        float core = exp(-sq * sq * 1.6);
        float wide = exp(-r2 / 9.0);
        // dispersion at the rim of the core: a thin cyan fringe, like light through thick glass
        float fringe = exp(-pow((sq - 1.05) * 3.2, 2.0)) * 0.55;
        float pulse = 0.0;
        if (uPulse >= 0.0) { float rr = uPulse * 6.0; pulse = exp(-pow((sqrt(r2) - rr) * 1.4, 2.0)) * exp(-uPulse * 1.6); }
        float k = clamp((core * 0.7 + wide * 0.13 + pulse * 0.35) * uLight, 0.0, 0.85);
        vec3 col = mix(uPaper, uAccent, k);
        col = mix(col, uAccent2, fringe * uLight * 0.35);
        float alpha = smoothstep(26.0, 10.0, sqrt(r2));
        gl_FragColor = vec4(col, alpha);
      }`,
  })
  return { material, uniforms }
}

/** A soft studio sweep around the stage: the look's background at the horizon, a touch brighter above. */
export function createBackdrop() {
  const uniforms = { uBg: { value: new THREE.Color('#f7f7f8') }, uTop: { value: 1.03 } }
  const material = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false,
    vertexShader: /* glsl */ `varying vec3 vN; void main() { vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform vec3 uBg; uniform float uTop; varying vec3 vN;
      void main() { float t = smoothstep(-0.05, 0.6, vN.y); gl_FragColor = vec4(uBg * mix(1.0, uTop, t), 1.0); }`,
  })
  return { material, uniforms }
}
