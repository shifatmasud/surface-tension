/** Shared GLSL chunks (ch.8.6): registered once, spliced with #include-style replacement. Written fresh. */
export const NOISE_D = /* glsl */ `
// Gradient noise returning (value, d/dx, d/dy) with an analytic derivative.
vec2 st_hash2(vec2 p){
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
vec3 noised(in vec2 x){
  vec2 i = floor(x), f = fract(x);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);          // quintic fade
  vec2 du = 30.0*f*f*(f*(f-2.0)+1.0);
  vec2 ga = st_hash2(i), gb = st_hash2(i+vec2(1,0)), gc = st_hash2(i+vec2(0,1)), gd = st_hash2(i+vec2(1,1));
  float va = dot(ga, f), vb = dot(gb, f-vec2(1,0)), vc = dot(gc, f-vec2(0,1)), vd = dot(gd, f-vec2(1,1));
  float v = va + u.x*(vb-va) + u.y*(vc-va) + u.x*u.y*(va-vb-vc+vd);
  vec2 d = ga + u.x*(gb-ga) + u.y*(gc-ga) + u.x*u.y*(ga-gb-gc+gd)
         + du*(u.yx*(va-vb-vc+vd) + vec2(vb,vc) - va);
  return vec3(v, d);
}`

export const BLUE_NOISE = /* glsl */ `
uniform sampler2D u_blueNoise; uniform vec2 u_blueNoiseOffset; uniform vec2 u_blueNoiseSize;
vec3 getBlueNoise(vec2 coord){ return texture2D(u_blueNoise, coord / u_blueNoiseSize + u_blueNoiseOffset).rgb; }`

export const BICUBIC = /* glsl */ `
// Catmull-Rom-ish bicubic via 4 bilinear taps — hides low-res texels on big type.
vec4 cubicW(float v){ vec4 n = vec4(1.0,2.0,3.0,4.0) - v; vec4 s = n*n*n;
  float x = s.x, y = s.y - 4.0*s.x, z = s.z - 4.0*s.y + 6.0*s.x, w = 6.0 - x - y - z; return vec4(x,y,z,w) * (1.0/6.0); }
vec4 textureBicubic(sampler2D t, vec2 uv, vec2 size){
  vec2 inv = 1.0/size; uv = uv*size - 0.5; vec2 fxy = fract(uv); uv -= fxy;
  vec4 xc = cubicW(fxy.x), yc = cubicW(fxy.y);
  vec4 c = uv.xxyy + vec2(-0.5, 1.5).xyxy; vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 o = c + vec4(xc.yw, yc.yw) / s; o *= inv.xxyy;
  vec4 s0 = texture2D(t, o.xz), s1 = texture2D(t, o.yz), s2 = texture2D(t, o.xw), s3 = texture2D(t, o.yw);
  float sx = s.x/(s.x+s.y), sy = s.z/(s.z+s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}`

export const FRESNEL = /* glsl */ `
float st_fresnel(vec3 n, vec3 v, float f0, float p){ return f0 + (1.0 - f0) * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), p); }`
