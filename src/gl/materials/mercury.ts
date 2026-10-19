import * as THREE from 'three'
import { shared } from '../../state/props'

/**
 * Liquid-metal surface: a PBR metal (env-reflective) whose vertices are lifted by the ripple sim and
 * whose normals come from the heightfield gradient. Analytic contact shadows from the floating tiles
 * (uniform array) darken the surface around them — "neighbour-aware analytic shading" (ch.7.3), fresh.
 */
export const MAX_TILES = 8
export function createMercuryMaterial() {
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#d9dce0'), metalness: 1, roughness: 0.07, envMapIntensity: 1.05,
    clearcoat: 0.4, clearcoatRoughness: 0.12, side: THREE.DoubleSide,
  })
  const uniforms = {
    u_rippleTexture: shared.u_rippleTexture,
    u_rippleTexel: shared.u_rippleTexel,
    u_poolSize: { value: 22 },
    u_amp: { value: 1.25 },
    u_tiles: { value: Array.from({ length: MAX_TILES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    u_time: shared.u_time,
    u_under: { value: 0 },
    u_edgeColor: { value: new THREE.Color('#e7e8ea') },
  }
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D u_rippleTexture; uniform vec2 u_rippleTexel; uniform float u_poolSize; uniform float u_amp; uniform float u_time;
        varying vec3 v_world; varying vec2 v_poolUv;
        float st_h(vec2 uv){ return texture2D(u_rippleTexture, uv).r; }
        float st_swell(vec2 p){ return (sin(p.x * 0.55 + u_time * 0.6) * 0.5 + sin(p.y * 0.42 - u_time * 0.45 + 1.3) * 0.5) * 0.06; }`)
      .replace('#include <beginnormal_vertex>', `
        vec2 puv = position.xy / u_poolSize + 0.5;   // plane is built in XY then rotated
        v_poolUv = puv;
        float hc = st_h(puv);
        float hx = st_h(puv + vec2(u_rippleTexel.x, 0.0)) - st_h(puv - vec2(u_rippleTexel.x, 0.0));
        float hy = st_h(puv + vec2(0.0, u_rippleTexel.y)) - st_h(puv - vec2(0.0, u_rippleTexel.y));
        float cell = u_poolSize * u_rippleTexel.x * 2.0;
        vec2 sw = vec2(st_swell(position.xy + vec2(0.05, 0.0)) - st_swell(position.xy - vec2(0.05, 0.0)), st_swell(position.xy + vec2(0.0, 0.05)) - st_swell(position.xy - vec2(0.0, 0.05))) / 0.1;
        vec3 objectNormal = normalize(vec3(-hx * u_amp / cell - sw.x, -hy * u_amp / cell - sw.y, 1.0));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(1.0, 0.0, 0.0);
        #endif`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(position.xy, position.z + hc * u_amp + st_swell(position.xy));`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        v_world = (modelMatrix * vec4(transformed, 1.0)).xyz;`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 v_world; varying vec2 v_poolUv; uniform vec4 u_tiles[${MAX_TILES}]; uniform float u_under; uniform vec3 u_edgeColor;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        // analytic contact shadow + soft occlusion ring under each floating tile
        float occ = 1.0;
        for (int i = 0; i < ${MAX_TILES}; i++) {
          vec4 t = u_tiles[i];
          if (t.z <= 0.0) continue;
          float d = length(v_world.xz - t.xy);
          float lift = max(t.w, 0.0);
          float r = t.z * (1.0 + lift * 0.6);
          occ *= 1.0 - 0.55 * (1.0 - smoothstep(r * 0.55, r * 1.25, d)) / (1.0 + lift * 2.0);
        }
        gl_FragColor.rgb *= occ;
        // fade the pool edge into the room
        float edge = smoothstep(0.5, 0.36, max(abs(v_poolUv.x - 0.5), abs(v_poolUv.y - 0.5)));
        gl_FragColor.a = 1.0;
        if (!gl_FrontFacing) { gl_FragColor.rgb = mix(vec3(0.02), gl_FragColor.rgb * 0.35, 0.6); }
        gl_FragColor.rgb = mix(u_edgeColor, gl_FragColor.rgb, edge);`)
  }
  m.customProgramCacheKey = () => 'mercury-v1'
  return { material: m, uniforms }
}
