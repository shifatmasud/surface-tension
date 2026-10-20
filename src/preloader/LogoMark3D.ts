/**
 * Shifat Masud's mark as a 3D glossy-plastic object, for the black preloader.
 * Helper 99499b45 (logo3d). Dependency-free raw WebGL (no three.js), so it ships inline in index.html (~7 KB) and
 * renders on the very first frames, long before the scene bundle arrives.
 *
 * The mark (traced from Shifat's official logo, see src/assets/logo/shifat-logo.svg): two identical parallelograms,
 * 45-degree slant, horizontal side = height = s, stacked so the top one's bottom-right corner touches the bottom
 * one's top-left corner, which is the centre of the 2s x 2s mark.
 */

/** The mark in SVG units (viewBox 0 0 200 200, y down), s = 100. Shared with the flat SVG and the favicon set. */
export const LOGO_POLYS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[100, 0], [200, 0], [100, 100], [0, 100]],
  [[100, 100], [200, 100], [100, 200], [0, 200]],
]

export interface LogoGeometry { positions: Float32Array; normals: Float32Array; count: number }

/** Extrude the mark (centred, y up, s = 1, so it spans -1..1) with rounded front/back bevels kept INSIDE the outline,
 *  so the silhouette stays exactly the traced mark. depth is total thickness; bevel the radius; seg the bevel steps. */
export function buildLogoGeometry(depth = 0.44, bevel = 0.07, seg = 5, pillow = 0.22): LogoGeometry {
  const P: number[] = [], N: number[] = []
  const tri = (a: number[], b: number[], c: number[], na: number[], nb: number[], nc: number[]) => {
    P.push(...a, ...b, ...c); N.push(...na, ...nb, ...nc)
  }
  for (const poly of LOGO_POLYS) {
    // to centred units, y up; CCW after the y flip? make sure of it by signed area
    let pts = poly.map(([x, y]) => [x / 100 - 1, 1 - y / 100])
    let area = 0
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1] }
    if (area < 0) pts = pts.reverse()
    const n = pts.length
    const en: number[][] = [] // outward edge normals (CCW: (dy, -dx))
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy)
      en.push([dy / l, -dx / l])
    }
    // vertex i inset by o: miter of the two offset edge lines
    const inset = (i: number, o: number) => {
      const n0 = en[(i - 1 + n) % n], n1 = en[i], k = 1 + n0[0] * n1[0] + n0[1] * n1[1]
      return [pts[i][0] - o * (n0[0] + n1[0]) / k, pts[i][1] - o * (n0[1] + n1[1]) / k]
    }
    const h = depth / 2 - bevel
    for (const side of [1, -1]) {
      // bevel rings: k = 0 at the wall, k = seg at the cap
      for (let k = 0; k < seg; k++) {
        const f0 = (k / seg) * Math.PI / 2, f1 = ((k + 1) / seg) * Math.PI / 2
        const o0 = bevel * (1 - Math.cos(f0)), o1 = bevel * (1 - Math.cos(f1))
        const z0 = side * (h + bevel * Math.sin(f0)), z1 = side * (h + bevel * Math.sin(f1))
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, e = en[i]
          const a0 = inset(i, o0), b0 = inset(j, o0), a1 = inset(i, o1), b1 = inset(j, o1)
          const m0 = [e[0] * Math.cos(f0), e[1] * Math.cos(f0), side * Math.sin(f0)]
          const m1 = [e[0] * Math.cos(f1), e[1] * Math.cos(f1), side * Math.sin(f1)]
          tri([a0[0], a0[1], z0], [b0[0], b0[1], z0], [b1[0], b1[1], z1], m0, m0, m1)
          tri([a0[0], a0[1], z0], [b1[0], b1[1], z1], [a1[0], a1[1], z1], m0, m1, m1)
        }
      }
      // cap (convex: fan)
      // cap: a fan from the centroid with slightly "pillowed" normals (a soft vinyl dome in the shading only;
      // the surface stays flat, so the silhouette is untouched) so reflections glide across the face as it turns
      const c = pts.map((_, i) => inset(i, bevel)), zc = side * depth / 2
      const cx = c.reduce((s, v) => s + v[0], 0) / n, cy = c.reduce((s, v) => s + v[1], 0) / n
      // left unnormalised on purpose: linear across the face, so the per-pixel normalise in the shader is seamless
      const nrm = (x: number, y: number) => [(x - cx) * pillow, (y - cy) * pillow, side]
      const n0 = [0, 0, side]
      for (let i = 0; i < n; i++) {
        const a = c[i], b = c[(i + 1) % n]
        tri([cx, cy, zc], [a[0], a[1], zc], [b[0], b[1], zc], n0, nrm(a[0], a[1]), nrm(b[0], b[1]))
      }
    }
    // straight walls
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, e = [en[i][0], en[i][1], 0], a = pts[i], b = pts[j]
      tri([a[0], a[1], -h], [b[0], b[1], -h], [b[0], b[1], h], e, e, e)
      tri([a[0], a[1], -h], [b[0], b[1], h], [a[0], a[1], h], e, e, e)
    }
  }
  return { positions: new Float32Array(P), normals: new Float32Array(N), count: P.length / 3 }
}

const VS = `attribute vec3 p;attribute vec3 n;uniform mat4 M,VP;varying vec3 vN,vP;
void main(){vec4 w=M*vec4(p,1.);vP=w.xyz;vN=mat3(M)*n;gl_Position=VP*w;}`

// Studio on black: lights are fixed to the camera, the mark turns through them, so the reflections sweep across it.
// Glossy white vinyl: soft wrapped diffuse (a hint of subsurface), a rough base specular and a crisp clearcoat.
const FS = `precision highp float;varying vec3 vN,vP;uniform vec3 C;uniform float K,S,A;
float rect(vec3 d,vec3 c,vec3 u,float w,float h,float s){float q=dot(d,c);if(q<=0.)return 0.;vec3 p=d/q;
 vec3 v=cross(c,u);return smoothstep(w+s,w-s,abs(dot(p,u)))*smoothstep(h+s,h-s,abs(dot(p,v)));}
vec3 env(vec3 d,float s){
 vec3 e=vec3(.02)*(.5+.5*d.y);
 e+=vec3(1.,.98,.95)*18.*K*rect(d,normalize(vec3(-.45,.5,.75)),normalize(vec3(.86,0.,.52)),.34,.24,s);
 e+=vec3(1.)*10.*K*rect(d,normalize(vec3(.28,.2,1.)),normalize(vec3(1.,0.,-.28)),.12,.42,s);
 e+=vec3(.92,.96,1.)*22.*rect(d,normalize(vec3(1.,.12,-.38)),normalize(vec3(.35,0.,.94)),.07,.95,s);
 e+=vec3(.9,.95,1.)*12.*rect(d,normalize(vec3(-1.,.05,-.5)),normalize(vec3(-.45,0.,.9)),.06,.9,s);
 e+=vec3(1.)*5.*rect(d,vec3(0.,1.,0.),vec3(1.,0.,0.),.55,.4,s*1.4);
 vec3 sc=normalize(vec3(mix(-1.4,1.4,S),.1,1.));e+=vec3(1.)*30.*A*rect(d,sc,normalize(cross(vec3(0.,1.,0.),sc)),.06,1.4,s);
 return e;}
vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
void main(){vec3 N=normalize(vN);vec3 V=normalize(C-vP);if(dot(N,V)<0.)N=-N;vec3 R=reflect(-V,N);float nv=max(dot(N,V),0.);
 vec3 L1=normalize(vec3(-.45,.5,.75)),L2=normalize(vec3(1.,.12,-.38)),L3=normalize(vec3(-1.,.05,-.5));
 float w=.35;
 vec3 dif=vec3(1.,.98,.95)*1.25*K*max(dot(N,L1)+w,0.)/(1.+w)+vec3(.92,.96,1.)*.45*max(dot(N,L2)+w,0.)/(1.+w)
  +vec3(.9,.95,1.)*.3*max(dot(N,L3)+w,0.)/(1.+w)+vec3(.22)*(.6+.4*N.y)+vec3(.35)*max(N.z,0.)*K;
 vec3 alb=vec3(.9,.895,.88);
 float F=.04+.96*pow(1.-nv,5.);
 vec3 base=env(R,.3)*(.03+.3*pow(1.-nv,5.));
 vec3 coat=env(R,.02)*F;
 vec3 col=alb*dif*(1.-F)*.62+base*.5+coat;
 col=aces(col*.95);gl_FragColor=vec4(pow(col,vec3(1./2.2)),1.);}`

export interface LogoFrame {
  /** turn around the vertical axis, radians (0 = facing the viewer) */ angle: number
  /** tilt toward the viewer, radians */ tilt: number
  /** key light gain (progress hint) */ key: number
  /** light sweep position 0..1 and its strength */ sweep: number; sweepAmt: number
}

export interface LogoRenderer { render(f: LogoFrame): void; resize(px: number): void; dispose(): void; ok: boolean }

export function createLogoRenderer(canvas: HTMLCanvasElement): LogoRenderer {
  const attrs: WebGLContextAttributes = { antialias: true, alpha: true, premultipliedAlpha: true, depth: true, powerPreference: 'low-power', preserveDrawingBuffer: false }
  const gl = (canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs)) as WebGLRenderingContext | null
  const dead: LogoRenderer = { render() {}, resize() {}, dispose() {}, ok: false }
  if (!gl) return dead
  const sh = (t: number, s: string) => { const o = gl.createShader(t)!; gl.shaderSource(o, s); gl.compileShader(o); return o }
  const prog = gl.createProgram()!
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS))
  gl.bindAttribLocation(prog, 0, 'p'); gl.bindAttribLocation(prog, 1, 'n'); gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return dead
  const geo = buildLogoGeometry()
  const buf = (d: Float32Array, loc: number) => {
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0); return b
  }
  const bp = buf(geo.positions, 0), bn = buf(geo.normals, 1)
  gl.useProgram(prog)
  const u = (k: string) => gl.getUniformLocation(prog, k)
  const uM = u('M'), uVP = u('VP'), uC = u('C'), uK = u('K'), uS = u('S'), uA = u('A')
  // camera: z = 6.6, 29 deg vertical fov; the mark (2 units tall) fills ~58 % of the square canvas
  const cz = 6.6, f = 1 / Math.tan((29 * Math.PI / 180) / 2), nr = 0.1, fr = 20
  // VP = P * T(0, 0, -cz), column-major
  const A = (fr + nr) / (nr - fr), B = (2 * fr * nr) / (nr - fr)
  const VP = new Float32Array([f, 0, 0, 0, 0, f, 0, 0, 0, 0, A, -1, 0, 0, -cz * A + B, cz])
  gl.uniformMatrix4fv(uVP, false, VP); gl.uniform3f(uC, 0, 0, cz)
  gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.clearColor(0, 0, 0, 0)
  const M = new Float32Array(16)
  let lost = false
  const onLost = (e: Event) => { e.preventDefault(); lost = true }
  canvas.addEventListener('webglcontextlost', onLost)
  return {
    ok: true,
    resize(px) { if (canvas.width !== px) { canvas.width = canvas.height = px } gl.viewport(0, 0, px, px) },
    render(fr) {
      if (lost) return
      // M = Rx(tilt) * Ry(angle), column-major
      const ca = Math.cos(fr.angle), sa = Math.sin(fr.angle), ct = Math.cos(fr.tilt), st = Math.sin(fr.tilt)
      M[0] = ca; M[1] = st * sa; M[2] = -ct * sa; M[3] = 0
      M[4] = 0; M[5] = ct; M[6] = st; M[7] = 0
      M[8] = sa; M[9] = -st * ca; M[10] = ct * ca; M[11] = 0
      M[12] = 0; M[13] = 0; M[14] = 0; M[15] = 1
      gl.uniformMatrix4fv(uM, false, M); gl.uniform1f(uK, fr.key); gl.uniform1f(uS, fr.sweep); gl.uniform1f(uA, fr.sweepAmt)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, geo.count)
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost)
      gl.deleteBuffer(bp); gl.deleteBuffer(bn); gl.deleteProgram(prog)
      const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext()
    },
  }
}
