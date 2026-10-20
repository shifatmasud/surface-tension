import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { props, shared } from '../../state/props'
import { BLUE_NOISE } from '../shaders/chunks'
import { trailField } from '../systems/ScreenPaintField'
import { dive } from '../stages/dive/diveState'
import { journey } from '../stages/journey/journeyState'

/**
 * ScreenPaintDistortion — order 75, the one full-screen pass the trail costs. Written fresh.
 *
 * The fluid's ink is read as the thickness of a thin liquid lens lying on the glass:
 *   • refraction  — the frame under the ink is resampled along the ink's slope (thicker middle magnifies),
 *                   plus a short smear along the fluid velocity so fast ink streaks like wet glass
 *   • fringe      — R / G / B are sampled at slightly different refraction depths, but ONLY where the lens has
 *                   an edge (slope high, ink thinning), so the colour lives on the rims and the body stays clear
 *   • thin film   — a soft iridescent band on the rims; its hue follows the speed the ink was laid with
 *                   (slow = cool pearl, fast = warm vivid), and it shifts as the lens thins while settling
 *   • glass light — one soft specular glint + a faint emboss so the lens reads on paper-white too
 *   • worlds      — lake (hero / contact): deeper lens, quieter colour. Dive (under water): the ink sheds tiny
 *                   rising bubbles. Space (journey, first beats): gravitational-lens bending of the starlight,
 *                   almost no colour, a faint cold glow. Light sections: the default pearl lens.
 * Pixels with no ink take one texture read and leave. ?paintdebug shows the trail over flat grey.
 * The u_amount / u_rgbShift / u_multiplier / u_colorMultiplier uniforms keep their names (the post chain sets
 * them from the section look): amount 3 = 1×, rgbShift = fringe width, colorMultiplier 10 = 1× film.
 */
export class ScreenPaintDistortionEffect extends Effect {
  private world = new THREE.Vector4(0, 0, 0, 1)
  constructor() {
    const debug = typeof location !== 'undefined' && /[?&]paintdebug/.test(location.search)
    super('ScreenPaintDistortion', /* glsl */ `
      uniform sampler2D u_trailDye;
      uniform sampler2D u_trailVelocity;
      uniform vec2 u_trailDyeTexel;
      uniform vec2 u_trailSimTexel;
      uniform vec2 u_screenPaintTexelSize;   // kept for the chain's setSize (unused)
      uniform float u_amount, u_rgbShift, u_multiplier, u_colorMultiplier, u_debug, u_time, u_aspect;
      uniform vec4 u_world;                  // x lake, y dive, z space, w paper (weights, sum ≈ 1)
      ${BLUE_NOISE}
      vec3 spd_encode(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      vec3 spd_decode(vec3 c){ c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      vec3 spd_hash3(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yzz) * q.zyx); }
      vec3 spd_grid(vec2 p){ // ?paintdebug: a fine checker so the bending is visible on its own
        vec2 c = floor(vec2(p.x * u_aspect, p.y) * 40.0); float k = mod(c.x + c.y, 2.0);
        return vec3(mix(0.42, 0.58, k));
      }
      vec3 sampleRGB(vec2 uv, vec2 off, float ca){
        if (u_debug > 0.5) return vec3(spd_grid(uv + off * (1.0 + ca)).r, spd_grid(uv + off).g, spd_grid(uv + off * (1.0 - ca)).b);
        // chromatic split along the refraction direction (ca = 0 → one read)
        if (ca < 0.0015) return spd_encode(texture2D(inputBuffer, uv + off).rgb);
        return spd_encode(vec3(
          texture2D(inputBuffer, uv + off * (1.0 + ca)).r,
          texture2D(inputBuffer, uv + off).g,
          texture2D(inputBuffer, uv + off * (1.0 - ca)).b));
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec4 d0 = texture2D(u_trailDye, uv);
        if (d0.r < 0.012) { outputColor = u_debug > 0.5 ? vec4(spd_decode(spd_grid(uv)), 1.0) : inputColor; return; }
        vec3 bn = getBlueNoise(gl_FragCoord.xy + vec2(17.0, 29.0));

        // —— lens thickness + slope (central differences over ~1.5 ink texels: continuous, never stepped)
        vec2 tx = u_trailDyeTexel * 2.0;
        float hl = texture2D(u_trailDye, uv - vec2(tx.x, 0.0)).r, hr = texture2D(u_trailDye, uv + vec2(tx.x, 0.0)).r;
        float hb = texture2D(u_trailDye, uv - vec2(0.0, tx.y)).r, ht = texture2D(u_trailDye, uv + vec2(0.0, tx.y)).r;
        float h = clamp(d0.r * 0.5 + (hl + hr + hb + ht) * 0.125, 0.0, 1.6);
        vec2 g = vec2(hr - hl, ht - hb) * 0.375;                  // ≈ per 1.5 texel, measured over 4, isotropic (square texels)
        float slope = length(g);
        float presence = smoothstep(0.012, 0.12, h);
        float edge = smoothstep(0.015, 0.11, slope) * (1.0 - smoothstep(0.55, 1.15, h)) * presence;
        float hue = clamp(d0.b / max(d0.r, 0.02), 0.0, 1.0);    // speed colour carried with the ink

        float lake = u_world.x, under = u_world.y, space = u_world.z, paper = u_world.w;
        float amt = u_amount / 3.0;
        // lens strength per world (viewport heights of displacement per unit slope)
        float lensK = (0.085 * paper + 0.11 * lake + 0.09 * under + 0.1 * space) * amt;
        vec2 off = g * lensK * vec2(1.0 / u_aspect, 1.0);
        // space: gravitational lensing — magnify toward the ink's heart, starlight bends around it
        off += g * space * 0.04 * smoothstep(0.1, 0.8, h) * vec2(1.0 / u_aspect, 1.0);

        // smear along the fluid velocity (wet-glass streak), jittered taps kill banding
        vec2 vel = texture2D(u_trailVelocity, uv).xy * u_trailSimTexel;   // uv / s
        vec2 smear = vel * 0.016 * presence * (u_multiplier / 5.0) * (1.0 - 0.8 * space);   // space: bend the stars, don't smear them into haze
        float sl = length(smear); if (sl > 0.03) smear *= 0.03 / sl;

        float ca = edge * u_rgbShift * (0.9 * paper + 0.6 * lake + 0.7 * under + 0.15 * space);
        vec3 acc = vec3(0.0);
        float t0 = bn.x / 5.0;
        for (int i = 0; i < 5; i++) {
          float t = (float(i) / 5.0 + t0) - 0.5;
          acc += sampleRGB(uv, off + smear * t, ca);
        }
        acc /= 5.0;

        // —— glass light: a soft glint and a faint emboss (so the lens reads on paper-white)
        vec3 N = normalize(vec3(-g * 7.0, 1.0));
        vec3 L = normalize(vec3(-0.5, 0.65, 0.58));
        float spec = pow(max(dot(reflect(-L, N), vec3(0.0, 0.0, 1.0)), 0.0), 36.0) * presence;
        float emboss = dot(N.xy, L.xy) * presence;
        acc *= 1.0 + emboss * (0.22 * paper + 0.16 * lake + 0.1 * under);
        acc += spec * (0.22 * paper + 0.3 * lake + 0.18 * under);

        // —— thin-film rims: hue follows the speed; slow = pearl (low saturation), fast = vivid
        float film = h * 1.7 + hue * 0.55 + (g.x - g.y) * 2.0 + bn.z * 0.05 + u_time * 0.04;
        vec3 thin = 0.5 + 0.5 * cos(6.28318 * (film + vec3(0.0, 0.33, 0.67)));
        float sat = mix(0.22, 0.78, hue);
        thin = mix(vec3(dot(thin, vec3(0.333))), thin, sat);
        float irid = (0.46 * paper + 0.32 * lake + 0.4 * under + 0.05 * space) * (u_colorMultiplier / 10.0);
        float rim = edge + d0.a * 0.6 * presence;                  // burst rings glow a touch more
        acc = mix(acc, acc * (0.7 + 0.6 * thin) + thin * 0.07, clamp(rim * irid, 0.0, 1.0));

        // —— worlds
        if (under > 0.01) {
          // a few bubbles shed by the moving ink: sparse hashed cells drifting up, each its own size and wobble
          vec2 q = vec2(uv.x * u_aspect, uv.y) * 24.0 - vec2(0.0, u_time * 0.9);
          vec2 cell = floor(q); vec2 f = fract(q) - 0.5;
          vec3 rnd = spd_hash3(cell);
          f.x += sin(u_time * 2.3 + rnd.z * 6.28) * 0.08;
          vec2 c = (rnd.xy - 0.5) * 0.5;
          float r = 0.05 + rnd.z * rnd.z * 0.16;
          float dd = length(f - c);
          float shell = smoothstep(r, r - 0.025, dd) - smoothstep(r - 0.03, r - 0.07, dd) * 0.8;
          float hi = smoothstep(r * 0.4, 0.0, length(f - c - vec2(-r, r) * 0.38));
          float fresh = clamp(d0.g * 2.0 + length(vel) * 1.5, 0.0, 1.0);                  // only where the ink is moving / new
          float show = step(0.8, fract(rnd.x * 13.7 + rnd.y * 7.1)) * smoothstep(0.1, 0.4, h) * fresh;
          acc += (shell * 0.3 + hi * 0.55) * show * under * vec3(0.86, 0.96, 1.0);
        }
        if (space > 0.01) {
          // starlight: a hairline rim + the ink gathers a few lensed star glints that twinkle as it settles
          acc += vec3(0.62, 0.78, 1.0) * (edge * 0.06 + spec * 0.2) * space;
          vec2 q = vec2(uv.x * u_aspect, uv.y) * 34.0;
          vec2 cell = floor(q); vec2 f = fract(q) - 0.5;
          vec3 rnd = spd_hash3(cell + 71.0);
          vec2 p = f - (rnd.xy - 0.5) * 0.6;
          float tw = 0.55 + 0.45 * sin(u_time * (2.0 + rnd.z * 3.0) + rnd.x * 6.28);
          float core = exp(-dot(p, p) * 160.0);
          float spike = exp(-abs(p.x) * 26.0) * exp(-p.y * p.y * 90.0) + exp(-abs(p.y) * 26.0) * exp(-p.x * p.x * 90.0);
          float on = step(0.72, rnd.z) * smoothstep(0.06, 0.35, h);
          acc += vec3(0.82, 0.9, 1.0) * (core * 0.8 + spike * 0.22) * tw * on * space;
        }

        outputColor = vec4(spd_decode(clamp(acc, 0.0, 1.0)), inputColor.a);
      }`, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform<any>>([
        ['u_trailDye', trailField.uniforms.u_trailDye as any],
        ['u_trailVelocity', trailField.uniforms.u_trailVelocity as any],
        ['u_trailDyeTexel', trailField.uniforms.u_trailDyeTexel as any],
        ['u_trailSimTexel', trailField.uniforms.u_trailSimTexel as any],
        ['u_screenPaintTexelSize', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['u_amount', new THREE.Uniform(3)],
        ['u_rgbShift', new THREE.Uniform(0.5)],
        ['u_multiplier', new THREE.Uniform(5)],
        ['u_colorMultiplier', new THREE.Uniform(10)],
        ['u_debug', new THREE.Uniform(debug ? 1 : 0)],
        ['u_time', shared.u_time as any],
        ['u_aspect', new THREE.Uniform(1)],
        ['u_world', new THREE.Uniform(new THREE.Vector4(0, 0, 0, 1))],
        ['u_blueNoise', shared.u_blueNoise as any],
        ['u_blueNoiseOffset', shared.u_blueNoiseOffset as any],
        ['u_blueNoiseSize', shared.u_blueNoiseSize as any],
      ]),
    })
  }
  u(name: string) { return this.uniforms.get(name)! }
  /** which world the trail is in (eased, so a section change never pops) */
  update(_r: THREE.WebGLRenderer, _input: THREE.WebGLRenderTarget, dt = 1 / 60) {
    const st = props.stage
    const t = new THREE.Vector4(0, 0, 0, 0)
    if (st === 'hero' || st === 'contact' || (st === 'dive' && !dive.under)) t.x = 1
    else if (st === 'dive') t.y = 1
    else if (st === 'journey' && journey.beat <= 1) t.z = 1
    else t.w = 1
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 4)
    this.world.lerp(t, k)
    ;(this.u('u_world').value as THREE.Vector4).copy(this.world)
    this.u('u_aspect').value = props.width / Math.max(1, props.height)
  }
}
