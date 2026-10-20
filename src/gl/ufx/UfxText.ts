import * as THREE from 'three'
import { SplitText } from 'gsap/SplitText'
import gsap from 'gsap'
import { ufx, textMaterial, type UfxItem } from './ufx'
import { settings } from '../../services/settings'

gsap.registerPlugin(SplitText)
const GEO = new THREE.PlaneGeometry(1, 1, 1, 24)

/** Rasterise one DOM line (its computed font) into an alpha texture. */
export function rasterLine(el: HTMLElement, text: string, w: number, h: number) {
  const cs = getComputedStyle(el)
  const dpr = Math.min(window.devicePixelRatio || 1, 3) // Shifat 14:01Z: big type rasterised at the device's own density (up to 3×)
  const c = document.createElement('canvas')
  const padX = Math.ceil(parseFloat(cs.fontSize) * 0.1)
  const padY = Math.ceil(parseFloat(cs.fontSize) * 0.22) // room for descenders: tight display leading would clip g/p/y
  c.width = Math.max(2, Math.ceil((w + padX * 2) * dpr)); c.height = Math.max(2, Math.ceil((h + padY * 2) * dpr))
  const ctx = c.getContext('2d')!
  ctx.scale(dpr, dpr)
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  ;(ctx as any).letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
  ;(ctx as any).fontKerning = 'normal'
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'alphabetic'
  const m = ctx.measureText('Hg')
  const asc = m.fontBoundingBoxAscent ?? parseFloat(cs.fontSize) * 0.93
  const desc = m.fontBoundingBoxDescent ?? parseFloat(cs.fontSize) * 0.24
  const y = padY + (h - (asc + desc)) / 2 + asc
  ctx.fillText(text, padX, y)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false
  return { tex, padX, padY }
}

export type UfxTextHandle = { lines: UfxItem[]; mats: THREE.ShaderMaterial[]; split: SplitText | null; dispose: () => void; setReveal: (fn: (i: number) => number) => void }

/**
 * Mirror a DOM headline into WebGL line by line. The DOM text stays (transparent) for selection,
 * SEO and screen readers; the GL copy bends with the cursor paint and reveals with a mask slide-up.
 */
export function ufxText(el: HTMLElement, opts: { color?: string; sheen?: string; layer?: 'under' | 'over' } = {}): UfxTextHandle {
  const split = new SplitText(el, { type: 'lines', linesClass: 'ufx-line', autoSplit: false, aria: 'none' }) // the line divs stay real text; no aria-label on a <p> (axe: aria-prohibited-attr)
  const lines: UfxItem[] = []; const mats: THREE.ShaderMaterial[] = []
  if (!settings.USE_GL) return { lines, mats, split, dispose: () => split.revert(), setReveal: () => {} }
  el.classList.add('is-ufx')
  // a sticky ancestor pins the line on screen while the document scrolls: track its live rect
  let sticky = false
  for (let p: HTMLElement | null = el; p && p !== document.body; p = p.parentElement) { if (getComputedStyle(p).position === 'sticky') { sticky = true; break } }
  ;(split.lines as HTMLElement[]).forEach((line) => {
    const r = line.getBoundingClientRect()
    const { tex, padX, padY } = rasterLine(line, line.textContent || '', r.width, r.height)
    const mat = textMaterial(tex, opts.color ?? '#0b0b0c', opts.sheen)
    const mesh = new THREE.Mesh(GEO, mat)
    mesh.renderOrder = 10
    const it: UfxItem = {
      el: line, mesh, layer: opts.layer ?? 'under', docTop: 0, docLeft: 0, w: 0, h: 0,
      measure() {
        const rr = line.getBoundingClientRect()
        it.docTop = rr.top - padY + window.scrollY; it.docLeft = rr.left - padX; it.w = rr.width + padX * 2; it.h = rr.height + padY * 2
      },
    }
    if (sticky) it.live = () => { const rr = line.getBoundingClientRect(); return { top: rr.top - padY, left: rr.left - padX, w: rr.width + padX * 2, h: rr.height + padY * 2 } }
    ufx.add(it); lines.push(it); mats.push(mat)
  })
  return {
    lines, mats, split,
    setReveal(fn) { mats.forEach((m, i) => { m.uniforms.u_reveal.value = fn(i) }) },
    dispose() { lines.forEach((l) => { ufx.remove(l); (l.mesh.material as THREE.ShaderMaterial).uniforms.u_map.value.dispose() }); el.classList.remove('is-ufx'); split.revert() },
  }
}
