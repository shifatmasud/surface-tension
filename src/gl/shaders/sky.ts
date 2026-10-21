import * as THREE from 'three'

/**
 * High-key daylight sky, analytic (no HDR download). One function shared by the dome, the lake's reflection
 * and the diamond's environment capture, so everything agrees on where the light is.
 * Palette is controlled like a film grade: cool grey zenith, near-white body, paper-white horizon.
 */
export const sky = {
  // high-key "studio daylight": an airy near-white field, a cool soft zenith so ripples still read
  u_sunDir: { value: new THREE.Vector3(-0.45, 0.9, -0.35).normalize() },
  u_sunColor: { value: new THREE.Color('#fffaf2') },
  u_skyZenith: { value: new THREE.Color('#aebccd') },
  u_skyMid: { value: new THREE.Color('#e3e8ee') },
  u_skyHorizon: { value: new THREE.Color('#f7f7f8') },
  u_skyGlow: { value: new THREE.Color('#ffffff') },
}

export const SKY_PARS = /* glsl */ `
uniform vec3 u_sunDir, u_sunColor, u_skyZenith, u_skyMid, u_skyHorizon, u_skyGlow;
vec3 skyColor(vec3 d, float sunDisc){
  d = normalize(d);
  float e = max(d.y, 0.0);
  // vertical gradient: horizon band → mid → zenith (power curves keep the band thin and warm)
  vec3 c = mix(u_skyHorizon, u_skyMid, smoothstep(0.0, 0.22, pow(e, 0.7)));
  c = mix(c, u_skyZenith, smoothstep(0.18, 0.9, e));
  // forward scattering around the sun (Henyey–Greenstein-ish lobe) warms that side of the sky
  float mu = max(dot(d, u_sunDir), 0.0);
  float hg = pow(mu, 6.0) * 0.55 + pow(mu, 48.0) * 0.9;
  c += u_skyGlow * hg * (1.0 - e * 0.6);
  // horizon haze
  c = mix(c, u_skyHorizon * 1.05, exp(-e * 28.0) * 0.6);
  // sun disc with a soft limb
  c += u_sunColor * smoothstep(0.99955, 0.99985, mu) * 18.0 * sunDisc;
  // studio softbox high in front of the lake: a soft-edged bright panel; ripples crossing its edge are
  // what makes a high-key water surface read as water (the trick product photographers use)
  float az = atan(d.x, -d.z);
  float panel = smoothstep(0.30, 0.38, e) * (1.0 - smoothstep(0.56, 0.66, e)) * (1.0 - smoothstep(0.55, 0.8, abs(az)));
  c = mix(c, vec3(1.0), panel * 0.85);
  c = mix(c, u_skyZenith * 0.82, smoothstep(0.7, 0.95, e) * 0.6);
  // below the horizon (seen only by far reflections): a dim warm floor
  if (d.y < 0.0) c = mix(u_skyHorizon * 0.9, u_skyHorizon * 0.55, smoothstep(0.0, 0.3, -d.y));
  return c;
}
`

export function createSkyDome() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...sky },
    vertexShader: /* glsl */ `
      varying vec3 v_dir;
      void main(){ v_dir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      ${SKY_PARS}
      varying vec3 v_dir;
      // W23 (scorer-r621/r6261: a grey 1 px seam on the 1440 dive horizon): the lake ends a hair below the true horizon, and the
      // dome's dim below-horizon floor showed through that gap; the dome itself never draws below the horizon colour
      void main(){ gl_FragColor = vec4(skyColor(vec3(v_dir.x, max(v_dir.y, 0.0), v_dir.z), 1.0), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(600, 48, 24), mat)
  mesh.frustumCulled = false
  mesh.renderOrder = -10
  return mesh
}
