import * as THREE from 'three'
import { props } from '../../../state/props'
import { browser } from '../../../services/settings'

/**
 * W18 — THE ENDING (STRUCTURE v3, Shifat 13:27Z–13:33Z). After the crewmate breaks out of the tablet the camera pulls
 * back: the tablet hangs on a matte BLACK WALL. We glide down past it with the crewmate alongside as the hero, and the
 * CTA type is already there on the wall — no entrance, it just keeps rolling like an odometer. While the crewmate and
 * the type settle into their aligned places, six vinyl logo stickers slap onto the wall one by one around the edges,
 * framing the centre (Framer, Figma, React, Vercel, ChatGPT/OpenAI, Notion; no overlaps, a clean centre).
 *
 * Three clean planes (13:33Z): (1) the wall + stickers at the back under a raking light, (2) the odometer type floating
 * a clear distance off the wall and casting a soft shadow onto it, (3) the crewmate closest to the lens with a rim light.
 * Each plane sits at its own depth, so the glide and the cursor/tilt parallax separate them; no haze, no heavy blur.
 *
 * Everything lives in the journey's outer world (tablet-local units; the screen plane faces +z).
 */
export const WALL_Z = -0.33
const LOGOS: { id: string; label: string; shape: 'circle' | 'square'; bg: string; fg: string; d?: string; vb?: number; draw?: (c: CanvasRenderingContext2D, s: number) => void }[] = [
  // Simple Icons v16.35.0 paths (the brands' current marks; the OpenAI "blossom" is the current ChatGPT/OpenAI mark)
  { id: 'framer', label: 'Framer', shape: 'square', bg: '#ffffff', fg: '#000000', d: 'M4 0h16v8h-8zM4 8h8l8 8H4zM4 16h8v8z' },
  { id: 'figma', label: 'Figma', shape: 'square', bg: '#ffffff', fg: '#000', draw: figma },
  { id: 'react', label: 'React', shape: 'circle', bg: '#20232a', fg: '#61dafb', d: 'REACT' },
  { id: 'vercel', label: 'Vercel', shape: 'circle', bg: '#000000', fg: '#ffffff', d: 'm12 1.608 12 20.784H0Z' },
  { id: 'openai', label: 'ChatGPT', shape: 'circle', bg: '#ffffff', fg: '#000000', d: 'OPENAI' },
  { id: 'notion', label: 'Notion', shape: 'square', bg: '#ffffff', fg: '#000000', d: 'NOTION' },
]
export const LOGO_PATHS: Record<string, string> = {
  REACT: 'M14.23 12.004a2.236 2.236 0 0 1-2.235 2.236 2.236 2.236 0 0 1-2.236-2.236 2.236 2.236 0 0 1 2.235-2.236 2.236 2.236 0 0 1 2.236 2.236zm2.648-10.69c-1.346 0-3.107.96-4.888 2.622-1.78-1.653-3.542-2.602-4.887-2.602-.41 0-.783.093-1.106.278-1.375.793-1.683 3.264-.973 6.365C1.98 8.917 0 10.42 0 12.004c0 1.59 1.99 3.097 5.043 4.03-.704 3.113-.39 5.588.988 6.38.32.187.69.275 1.102.275 1.345 0 3.107-.96 4.888-2.624 1.78 1.654 3.542 2.603 4.887 2.603.41 0 .783-.09 1.106-.275 1.374-.792 1.683-3.263.973-6.365C22.02 15.096 24 13.59 24 12.004c0-1.59-1.99-3.097-5.043-4.032.704-3.11.39-5.587-.988-6.38-.318-.184-.688-.277-1.092-.278zm-.005 1.09v.006c.225 0 .406.044.558.127.666.382.955 1.835.73 3.704-.054.46-.142.945-.25 1.44-.96-.236-2.006-.417-3.107-.534-.66-.905-1.345-1.727-2.035-2.447 1.592-1.48 3.087-2.292 4.105-2.295zm-9.77.02c1.012 0 2.514.808 4.11 2.28-.686.72-1.37 1.537-2.02 2.442-1.107.117-2.154.298-3.113.538-.112-.49-.195-.964-.254-1.42-.23-1.868.054-3.32.714-3.707.19-.09.4-.127.563-.132zm4.882 3.05c.455.468.91.992 1.36 1.564-.44-.02-.89-.034-1.345-.034-.46 0-.915.01-1.36.034.44-.572.895-1.096 1.345-1.565zM12 8.1c.74 0 1.477.034 2.202.093.406.582.802 1.203 1.183 1.86.372.64.71 1.29 1.018 1.946-.308.655-.646 1.31-1.013 1.95-.38.66-.773 1.288-1.18 1.87-.728.063-1.466.098-2.21.098-.74 0-1.477-.035-2.202-.093-.406-.582-.802-1.204-1.183-1.86-.372-.64-.71-1.29-1.018-1.946.303-.657.646-1.313 1.013-1.954.38-.66.773-1.286 1.18-1.868.728-.064 1.466-.098 2.21-.098zm-3.635.254c-.24.377-.48.763-.704 1.16-.225.39-.435.782-.635 1.174-.265-.656-.49-1.31-.676-1.947.64-.15 1.315-.283 2.015-.386zm7.26 0c.695.103 1.365.23 2.006.387-.18.632-.405 1.282-.66 1.933-.2-.39-.41-.783-.64-1.174-.225-.392-.465-.774-.705-1.146zm3.063.675c.484.15.944.317 1.375.498 1.732.74 2.852 1.708 2.852 2.476-.005.768-1.125 1.74-2.857 2.475-.42.18-.88.342-1.355.493-.28-.958-.646-1.956-1.1-2.98.45-1.017.81-2.01 1.085-2.964zm-13.395.004c.278.96.645 1.957 1.1 2.98-.45 1.017-.812 2.01-1.086 2.964-.484-.15-.944-.318-1.37-.5-1.732-.737-2.852-1.706-2.852-2.474 0-.768 1.12-1.742 2.852-2.476.42-.18.88-.342 1.356-.494zm11.678 4.28c.265.657.49 1.312.676 1.948-.64.157-1.316.29-2.016.39.24-.375.48-.762.705-1.158.225-.39.435-.788.636-1.18zm-9.945.02c.2.392.41.783.64 1.175.23.39.465.772.705 1.143-.695-.102-1.365-.23-2.006-.386.18-.63.406-1.282.66-1.933zM17.92 16.32c.112.493.2.968.254 1.423.23 1.868-.054 3.32-.714 3.708-.147.09-.338.128-.563.128-1.012 0-2.514-.807-4.11-2.28.686-.72 1.37-1.536 2.02-2.44 1.107-.118 2.154-.3 3.113-.54zm-11.83.01c.96.234 2.006.415 3.107.532.66.905 1.345 1.727 2.035 2.446-1.595 1.483-3.092 2.295-4.11 2.295-.22-.005-.406-.05-.553-.132-.666-.38-.955-1.834-.73-3.703.054-.46.142-.944.25-1.438zm4.56.64c.44.02.89.034 1.345.034.46 0 .915-.01 1.36-.034-.44.572-.895 1.095-1.345 1.565-.455-.47-.91-.993-1.36-1.565z',
  OPENAI: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  NOTION: 'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z',
}

function figma(c: CanvasRenderingContext2D, s: number) {
  // the official five-shape mark, unit = s/3 tall columns (each piece 1×1 with radius 0.5)
  const u = s / 3.1, x0 = -u, y0 = -1.5 * u
  const piece = (x: number, y: number, col: string, tl: number, tr: number, br: number, bl: number) => {
    c.fillStyle = col; c.beginPath(); (c as any).roundRect(x0 + x * u, y0 + y * u, u, u, [tl * u, tr * u, br * u, bl * u]); c.fill()
  }
  piece(0, 0, '#F24E1E', 0.5, 0, 0, 0.5); piece(1, 0, '#FF7262', 0, 0.5, 0.5, 0)
  piece(0, 1, '#A259FF', 0.5, 0, 0, 0.5)
  c.fillStyle = '#1ABCFE'; c.beginPath(); c.arc(x0 + 1.5 * u, y0 + 1.5 * u, 0.5 * u, 0, Math.PI * 2); c.fill()
  piece(0, 2, '#0ACF83', 0.5, 0, 0.5, 0.5)
}

/** the six stickers as one atlas (3 × 2 cells): a die-cut white vinyl margin round a printed face */
function stickerAtlas(paths: Record<string, string>) {
  const C = 384, cv = document.createElement('canvas'); cv.width = C * 3; cv.height = C * 2
  const c = cv.getContext('2d')!
  LOGOS.forEach((L, i) => {
    const cx = (i % 3) * C + C / 2, cy = Math.floor(i / 3) * C + C / 2
    const R = C * 0.42, m = C * 0.045
    const shape = (r: number) => { c.beginPath(); if (L.shape === 'circle') c.arc(cx, cy, r, 0, Math.PI * 2); else (c as any).roundRect(cx - r, cy - r, r * 2, r * 2, r * 0.36) }
    // the die-cut margin (white vinyl), then the printed face
    c.fillStyle = '#f4f4f2'; shape(R); c.fill()
    c.fillStyle = L.bg; shape(R - m); c.fill()
    c.save(); c.translate(cx, cy)
    const s = (R - m) * 1.12
    if (L.draw) L.draw(c, s)
    else {
      const d = paths[L.d!] ?? L.d!
      const k = s / 24
      c.translate(-12 * k, -12 * k); c.scale(k, k)
      c.fillStyle = L.fg
      c.fill(new Path2D(d))
    }
    c.restore()
  })
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter
  return tex
}

// ---------------------------------------------------------------- the wall
const WALL_VERT = /* glsl */ `
varying vec3 vP;
void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const WALL_FRAG = /* glsl */ `
uniform vec3 u_light; uniform vec2 u_c; uniform float u_hw, u_on;
varying vec3 vP;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
void main(){
  // matte black paint on a plaster wall: a fine, low relief that only a RAKING light picks out
  vec2 p = vP.xy;
  float e = 0.02;
  float hC = vn(p * 5.0) * 0.6 + vn(p * 13.0) * 0.18 + vn(p * 1.7) * 0.5;
  float hX = vn((p + vec2(e, 0.0)) * 5.0) * 0.6 + vn((p + vec2(e, 0.0)) * 13.0) * 0.18 + vn((p + vec2(e, 0.0)) * 1.7) * 0.5;
  float hY = vn((p + vec2(0.0, e)) * 5.0) * 0.6 + vn((p + vec2(0.0, e)) * 13.0) * 0.18 + vn((p + vec2(0.0, e)) * 1.7) * 0.5;
  // fade the relief with distance in screen space (no salt-and-pepper sparkle when the wall is small on a phone)
  float fw = clamp(length(fwidth(p)) * 6.0, 0.0, 1.0);
  vec3 n = normalize(vec3(-(hX - hC) / e * 0.008 * (1.0 - fw), -(hY - hC) / e * 0.008 * (1.0 - fw), 1.0));
  vec3 L = normalize(-u_light);
  float graze = max(dot(n, L), 0.0);
  // the raking wash: strongest across the upper left of the CTA area, falling off over the wall
  vec2 q = (p - u_c - vec2(-0.55, 0.45) * u_hw) / u_hw;
  float wash = exp(-dot(q, q) * 0.9);
  float base = 0.010 + 0.004 * hC;
  vec3 col = vec3(base) + vec3(0.11, 0.105, 0.1) * graze * wash * 0.55 + vec3(0.016) * wash;
  gl_FragColor = vec4(col * u_on, 1.0);
}`

// ---------------------------------------------------------------- stickers
const ST_VERT = /* glsl */ `
attribute vec4 aSt;      // x, y (wall), size, tilt
attribute vec2 aCell;    // atlas cell
attribute vec3 aProg;    // slap progress 0..1, lifted-corner amount, seed
uniform float u_z, u_shadow;
uniform vec3 u_light;
varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying float vA; varying float vLift;
void main(){
  float s = clamp(aProg.x, 0.0, 1.0);
  // slap: from a curled sheet a little off the wall, pressed flat with a tiny squash, then settled
  float press = smoothstep(0.0, 0.62, s);
  float squash = sin(clamp((s - 0.55) / 0.45, 0.0, 1.0) * 3.14159) * 0.06;
  vec2 q = position.xy;                                   // -0.5..0.5
  float ca = cos(aSt.w), sa = sin(aSt.w);
  // curl: the sheet bends up along its diagonal, unrolling as it presses down; a lifted corner remains on some
  float diag = dot(q, normalize(vec2(1.0, -1.0)));
  float curl = (1.0 - press) * 0.9;
  float lift = max(0.0, diag - 0.18) * max(curl, aProg.y * smoothstep(0.85, 1.0, s));
  vec3 lp = vec3(q * vec2(1.0 + squash, 1.0 - squash), 0.0);
  lp.z = lift * lift * 1.6 + (1.0 - press) * 0.55;
  lp.xy *= mix(1.08, 1.0, press);
  lp.xy *= aSt.z; lp.z *= aSt.z;
  vec3 wp = vec3(aSt.x + ca * lp.x - sa * lp.y, aSt.y + sa * lp.x + ca * lp.y, u_z + lp.z);
  // a shadow copy lies on the wall, offset along the light, softer the higher the sheet
  if (u_shadow > 0.5) { float hgt = lp.z + 0.03; wp.xy += (u_light.xy / -u_light.z) * hgt; wp.z = u_z - 0.022; vLift = hgt; }
  else vLift = lift;
  vN = normalize(vec3(-sa * 0.0 + (ca + sa) * 0.7 * lift * 2.0, (sa - ca) * 0.7 * lift * 2.0, 1.0));
  vUv = (aCell + (q + 0.5)) / vec2(3.0, 2.0);
  vA = step(0.001, s);
  vW = wp;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}`
const ST_FRAG = /* glsl */ `
uniform sampler2D u_atlas; uniform float u_shadow, u_time; uniform vec3 u_light, u_cam;
varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying float vA; varying float vLift;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main(){
  if (vA < 0.5) discard;
  if (u_shadow > 0.5) {
    float a = texture2D(u_atlas, vUv, 2.5 + vLift * 6.0).a;
    a *= 0.75 - min(vLift * 0.9, 0.5);
    if (a < 0.01) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, a); return;
  }
  vec4 t = texture2D(u_atlas, vUv);
  if (t.a < 0.5) discard;
  // glossy vinyl under the raking light: a broad sheen + a tight highlight that slides with the view, a whisper of
  // wrinkle in the film
  vec3 n = normalize(vN);
  vec3 L = normalize(-u_light), V = normalize(u_cam - vW), H = normalize(L + V);
  float diff = 0.8 + 0.2 * max(dot(n, L), 0.0);
  float spec = pow(max(dot(n, H), 0.0), 220.0) * 0.4 + pow(max(dot(n, H), 0.0), 30.0) * 0.025;
  vec3 col = t.rgb * diff * 0.92 + vec3(spec);
  col *= 1.0 - vLift * 0.25;
  gl_FragColor = vec4(col, 1.0);
}`

// ---------------------------------------------------------------- the odometer type
const TX_VERT = /* glsl */ `
attribute vec4 aGeo;     // x (em, centred per word), line (0/1), w (em), h (em)
attribute vec4 aUv;      // atlas rect u0 v0 u1 v1
attribute vec4 aRole;    // word index, letter index, copy (0 leaving / 1 arriving), words in this line
uniform float u_time, u_em, u_gap, u_still, u_shadow, u_z, u_desc;
uniform vec2 u_off, u_c;
varying vec2 vUv; varying float vY; varying float vOn;
const float PERIOD = 3.4, ROLL = 0.62, STAG = 0.045, TRAVEL = 1.25;
float ease(float x){ x = clamp(x, 0.0, 1.0); return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }
void main(){
  float n = aRole.w;
  float k = floor(u_time / PERIOD), lt = u_time - k * PERIOD;
  float cw = mod(k, n), nw = mod(k + 1.0, n);
  float delay = aRole.y * STAG + aGeo.y * 0.14;
  float still = max(u_still, step(n, 1.5));                // a one-word line ("Let’s make") never rolls
  float e = still > 0.5 ? 0.0 : ease((lt - (PERIOD - 1.25) - delay) / ROLL);
  float on, dy;
  if (aRole.z < 0.5) { on = step(abs(aRole.x - cw), 0.1); dy = e * TRAVEL; }
  else { on = step(abs(aRole.x - nw), 0.1) * (still > 0.5 ? 0.0 : 1.0); dy = (e - 1.0) * TRAVEL; }
  vOn = on;
  vec2 q = position.xy + 0.5;                              // 0..1 in the glyph box
  float baseY = -aGeo.y * u_gap;
  vec2 g = vec2(aGeo.x + q.x * aGeo.z, baseY - u_desc + q.y * aGeo.w + dy);
  vY = g.y - baseY;                                         // height above this line's baseline (em)
  vUv = mix(aUv.xy, aUv.zw, q);
  vec3 wp = vec3(u_c + g * u_em + u_off, u_z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}`
const TX_FRAG = /* glsl */ `
uniform sampler2D u_atlas; uniform float u_shadow;
varying vec2 vUv; varying float vY; varying float vOn;
void main(){
  if (vOn < 0.5 || vY < -0.24 || vY > 0.84) discard;      // each line is a masked slot
  if (u_shadow > 0.5) {
    float a = texture2D(u_atlas, vUv, 4.0).a * 0.45;
    if (a < 0.01) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, a); return;
  }
  float a = texture2D(u_atlas, vUv).a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vec3(1.0) * a, a);
}`

const LINE1 = 'Let’s make'
const WORDS = ['it ripple.', 'it move.', 'it play.', 'it real.']

function glyphAtlas(font: string, spacingEm: number) {
  const FS = 112, PAD = 26
  const chars = Array.from(new Set((LINE1 + WORDS.join('')).split(''))).filter((c) => c !== ' ')
  const cv = document.createElement('canvas'); const c = cv.getContext('2d')!
  c.font = `400 ${FS}px ${font}`
  const cellH = Math.ceil(FS * 1.3) + PAD * 2
  const widths = chars.map((ch) => Math.ceil(c.measureText(ch).width) + PAD * 2)
  const W = 2048
  let x = 0, y = 0; const pos: Record<string, [number, number, number]> = {}
  chars.forEach((ch, i) => { if (x + widths[i] > W) { x = 0; y += cellH } pos[ch] = [x, y, widths[i]]; x += widths[i] })
  cv.width = W; cv.height = THREE.MathUtils.ceilPowerOfTwo(y + cellH)
  c.font = `400 ${FS}px ${font}`; c.fillStyle = '#fff'; c.textBaseline = 'alphabetic'
  for (const ch of chars) { const [px, py] = pos[ch]; c.fillText(ch, px + PAD, py + PAD + FS * 0.98) }
  const tex = new THREE.CanvasTexture(cv)
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.anisotropy = 4
  // layout: x advances from prefix widths (kerning kept), centred per word
  const em = (px: number) => px / FS
  const layout = (s: string) => {
    const out: { ch: string; x: number }[] = []
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]; if (ch === ' ') continue
      out.push({ ch, x: em(c.measureText(s.slice(0, i)).width) + i * spacingEm })
    }
    const w = em(c.measureText(s).width) + (s.length - 1) * spacingEm
    return { glyphs: out, w }
  }
  const rect = (ch: string) => { const [px, py, w] = pos[ch]; return { u0: px / W, v0: 1 - (py + cellH) / cv.height, u1: (px + w) / W, v1: 1 - py / cv.height, w: em(w), h: em(cellH), padX: em(PAD), padY: em(PAD) } }
  return { tex, layout, rect, FS, desc: (cellH - PAD - FS * 0.98) / FS }
}

export type CtaLayout = { C: THREE.Vector3; D: number; hw: number; wv: number; fov: number; textZ: number; em: number; crewZ: number; crewY: number; crewScale: number }

export function buildCta(portrait: boolean) {
  const group = new THREE.Group()
  const light = new THREE.Vector3(0.32, -0.42, -1).normalize()
  // wall
  const wallMat = new THREE.ShaderMaterial({ vertexShader: WALL_VERT, fragmentShader: WALL_FRAG, toneMapped: false, fog: false,
    uniforms: { u_light: { value: light }, u_c: { value: new THREE.Vector2() }, u_hw: { value: 10 }, u_on: { value: 1 } } })
  wallMat.polygonOffset = true; wallMat.polygonOffsetFactor = 4; wallMat.polygonOffsetUnits = 8   // decals never z-fight it
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(420, 300), wallMat)
  wall.position.set(0, -60, WALL_Z); wall.renderOrder = -6
  // stickers (+ their shadows on the wall)
  const N = LOGOS.length
  const quad = new THREE.PlaneGeometry(1, 1, 14, 14)
  const sGeo = new THREE.InstancedBufferGeometry()
  sGeo.index = quad.index; sGeo.setAttribute('position', quad.getAttribute('position'))
  const aSt = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4)
  const aCell = new THREE.InstancedBufferAttribute(new Float32Array(LOGOS.flatMap((_, i) => [i % 3, 1 - Math.floor(i / 3)])), 2)
  const aProg = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3)
  aSt.setUsage(THREE.DynamicDrawUsage); aProg.setUsage(THREE.DynamicDrawUsage)
  sGeo.setAttribute('aSt', aSt); sGeo.setAttribute('aCell', aCell); sGeo.setAttribute('aProg', aProg); sGeo.instanceCount = N
  const atlas = stickerAtlas(LOGO_PATHS)
  const sU = { u_atlas: { value: atlas }, u_z: { value: WALL_Z + 0.03 }, u_light: { value: light }, u_cam: { value: new THREE.Vector3() }, u_time: { value: 0 } }
  const sMat = new THREE.ShaderMaterial({ vertexShader: ST_VERT, fragmentShader: ST_FRAG, toneMapped: false, fog: false, side: THREE.DoubleSide, uniforms: { ...sU, u_shadow: { value: 0 } } })
  const sShadowMat = new THREE.ShaderMaterial({ vertexShader: ST_VERT, fragmentShader: ST_FRAG, toneMapped: false, fog: false, transparent: true, depthWrite: false, uniforms: { ...sU, u_shadow: { value: 1 } } })
  const stickers = new THREE.Mesh(sGeo, sMat); stickers.frustumCulled = false; stickers.renderOrder = -4
  const stickerShadows = new THREE.Mesh(sGeo, sShadowMat); stickerShadows.frustumCulled = false; stickerShadows.renderOrder = -5
  // type + its shadow
  const tU = { u_atlas: { value: null as THREE.Texture | null }, u_time: { value: 0 }, u_em: { value: 1 }, u_gap: { value: 0.9 }, u_still: { value: browser.reducedMotion ? 1 : 0 }, u_off: { value: new THREE.Vector2() }, u_c: { value: new THREE.Vector2() }, u_desc: { value: 0.55 } }
  const tMat = new THREE.ShaderMaterial({ vertexShader: TX_VERT, fragmentShader: TX_FRAG, toneMapped: false, fog: false, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, uniforms: { ...tU, u_shadow: { value: 0 }, u_z: { value: 0 } } })
  const tShadowMat = new THREE.ShaderMaterial({ vertexShader: TX_VERT, fragmentShader: TX_FRAG, toneMapped: false, fog: false, transparent: true, depthWrite: false, uniforms: { ...tU, u_shadow: { value: 1 }, u_z: { value: WALL_Z + 0.012 }, u_off: { value: new THREE.Vector2() } } })
  const tGeo = new THREE.InstancedBufferGeometry()
  const tq = new THREE.PlaneGeometry(1, 1)
  tGeo.index = tq.index; tGeo.setAttribute('position', tq.getAttribute('position'))
  const type = new THREE.Mesh(tGeo, tMat); type.frustumCulled = false; type.renderOrder = 2
  const typeShadow = new THREE.Mesh(tGeo, tShadowMat); typeShadow.frustumCulled = false; typeShadow.renderOrder = -3
  type.visible = typeShadow.visible = false
  // the type itself is drawn at full device density by the text layer (PostChain → SharpText), behind the crewmate's
  // depth: it lives outside the scene graph in its own root (placed at the journey origin by the stage)
  const typeRoot = new THREE.Group()
  typeRoot.add(type)
  group.add(wall, stickerShadows, stickers, typeShadow)

  let built = false
  const buildType = () => {
    const ref = document.querySelector<HTMLElement>('.contact__title') ?? document.body
    const cs = getComputedStyle(ref)
    const fs = parseFloat(cs.fontSize) || 100
    const sp = (parseFloat(cs.letterSpacing) || -0.065 * fs) / fs
    const A = glyphAtlas(cs.fontFamily || 'sans-serif', sp)
    const rows: number[][] = []
    const push = (line: number, word: number, nWords: number, s: string) => {
      const L = A.layout(s)
      L.glyphs.forEach((g, li) => {
        const r = A.rect(g.ch)
        for (let copy = 0; copy < 2; copy++) rows.push([g.x - L.w / 2 - r.padX, line, r.w, r.h, r.u0, r.v0, r.u1, r.v1, word, li, copy, nWords])
      })
      return L.w
    }
    const w1 = push(0, 0, 1, LINE1)
    let w2 = 0
    WORDS.forEach((wd, i) => { w2 = Math.max(w2, push(1, i, WORDS.length, wd)) })
    const n = rows.length
    const geo = new Float32Array(n * 4), uv = new Float32Array(n * 4), role = new Float32Array(n * 4)
    rows.forEach((r, i) => { geo.set(r.slice(0, 4), i * 4); uv.set(r.slice(4, 8), i * 4); role.set(r.slice(8, 12), i * 4) })
    tGeo.setAttribute('aGeo', new THREE.InstancedBufferAttribute(geo, 4))
    tGeo.setAttribute('aUv', new THREE.InstancedBufferAttribute(uv, 4))
    tGeo.setAttribute('aRole', new THREE.InstancedBufferAttribute(role, 4))
    tGeo.instanceCount = n
    tU.u_atlas.value?.dispose?.()
    tU.u_atlas.value = A.tex
    tU.u_desc.value = A.desc
    widthEm = Math.max(w1, w2)
    built = true
  }
  let widthEm = 6
  document.fonts?.ready.then(() => { buildType(); dirty = true })
  let dirty = true

  /** stickers placed in the final frame (fractions of the visible wall), framing the centre */
  const PLACE_WIDE: [number, number, number, number][] = [
    // fx, fy, size (× wall height), tilt (deg)
    [-0.37, 0.31, 0.22, -9], [0.355, 0.33, 0.21, 8], [-0.425, -0.03, 0.2, 6],
    [0.42, 0.0, 0.2, -7], [-0.345, -0.33, 0.21, 10], [0.36, -0.315, 0.2, -5],
  ]
  const PLACE_TALL: [number, number, number, number][] = [
    [-0.3, 0.335, 0.29, -9], [0.02, 0.37, 0.25, 6], [0.31, 0.325, 0.28, 8],
    [-0.375, -0.115, 0.24, 7], [0.375, -0.07, 0.24, -6], [-0.35, -0.255, 0.22, -8],
  ]
  // slap order: round the frame, top-left first
  const ORDER = [0, 1, 3, 5, 4, 2]
  const lay: CtaLayout = { C: new THREE.Vector3(), D: 20, hw: 12, wv: 19, fov: 34, textZ: WALL_Z + 1.4, em: 1, crewZ: 6, crewY: 0, crewScale: 1 }

  /** the final aligned composition for this screen (tablet-local) */
  function layout(sw: number, sh: number, aspect: number, crewHeight: number) {
    const fov = 34, t = Math.tan(THREE.MathUtils.degToRad(fov / 2))
    let hw: number, wv: number
    if (!portrait) { hw = sh * 1.42; wv = hw * aspect } else { wv = sw * 1.18; hw = wv / aspect }
    const D = hw / (2 * t)
    lay.fov = fov; lay.hw = hw; lay.wv = wv; lay.D = D
    lay.C.set(0, -(sh / 2 + 1.4 + hw / 2), WALL_Z)
    lay.textZ = WALL_Z + D * (portrait ? 0.05 : 0.05)
    // type: the wider line spans ~70 % (wide) / ~88 % (phones) of the frame at its own depth
    const wAtText = wv * (D - (lay.textZ - WALL_Z)) / D
    lay.em = (wAtText * (portrait ? 0.84 : 0.56)) / Math.max(1, widthEm)
    // crewmate: closest plane, ~34 % (wide) / ~26 % (phones) of the frame tall
    lay.crewZ = WALL_Z + D * 0.42
    const hAtCrew = hw * (D - (lay.crewZ - WALL_Z)) / D
    lay.crewScale = (hAtCrew * (portrait ? 0.26 : 0.3)) / crewHeight
    lay.crewY = lay.C.y - hw * (portrait ? 0.09 : 0.08) * (D - (lay.crewZ - WALL_Z)) / D
    const P = portrait ? PLACE_TALL : PLACE_WIDE
    P.forEach((s, i) => aSt.setXYZW(i, lay.C.x + s[0] * wv, lay.C.y + s[1] * hw, s[2] * (portrait ? wv : hw), THREE.MathUtils.degToRad(s[3])))
    LOGOS.forEach((_, i) => aProg.setY(i, i === 1 || i === 4 ? 0.06 : 0)) // a lifted corner on two of them
    LOGOS.forEach((_, i) => aProg.setZ(i, i * 0.37))
    aSt.needsUpdate = true; aProg.needsUpdate = true
    wallMat.uniforms.u_c.value.set(lay.C.x, lay.C.y); wallMat.uniforms.u_hw.value = hw
    dirty = false
    return lay
  }

  /** a = the align/glide progress 0..1 (stickers slap during it); on = whether anything of the wall is in view */
  function update(time: number, a: number, cam: THREE.Vector3, on: boolean) {
    group.visible = on
    if (!on) return
    sU.u_cam.value.copy(cam); sU.u_time.value = time
    for (let j = 0; j < N; j++) {
      const i = ORDER[j]
      const s0 = 0.28 + j * 0.105
      aProg.setX(i, THREE.MathUtils.clamp((a - s0) / 0.16, 0, 1))
    }
    aProg.needsUpdate = true
    const showType = built
    type.visible = typeShadow.visible = showType
    if (showType) {
      tU.u_time.value = time; tU.u_em.value = lay.em
      tU.u_c.value.set(lay.C.x, lay.C.y + lay.em * 0.42 + lay.hw * 0.04)
      tMat.uniforms.u_z.value = lay.textZ
      // the soft shadow: the type projected along the light onto the wall
      const h = lay.textZ - WALL_Z
      tShadowMat.uniforms.u_off.value.set((light.x / -light.z) * h, (light.y / -light.z) * h)
    }
  }
  /** the type's box (tablet-local, at its depth): both lines, a margin for the roll and the trail */
  const typeRect = () => {
    const cy = lay.C.y + lay.em * 0.42 + lay.hw * 0.04, half = (widthEm * 0.5 + 0.25) * lay.em
    return { x0: lay.C.x - half, x1: lay.C.x + half, y0: cy - (tU.u_gap.value + 0.6) * lay.em, y1: cy + 1.05 * lay.em, z: lay.textZ }
  }
  return { group, typeRoot, type, typeRect, layout, update, lay, get dirty() { return dirty }, set dirty(v: boolean) { dirty = v }, wall }
}
