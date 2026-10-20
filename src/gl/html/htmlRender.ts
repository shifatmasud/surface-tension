import type * as THREE from 'three'
import { settings } from '../../services/settings'

/**
 * three-html-render (repalash) as one shared service: live HTML → WebGL textures through the WICG
 * HTML-in-Canvas polyfill. The HTML lives inside the WebGL <canvas layoutsubtree> (so it is laid out
 * and stays in the accessibility tree); one ThreeHTMLRenderer is connected to our renderer, and any
 * stage can register an element and read back its texture. Fallback: when the polyfill cannot run
 * (or ?nohtml), callers get null and keep their DOM version visible.
 */
type HR = { addObject(el: HTMLElement, mesh: THREE.Object3D): unknown; update(): void; getTexture(el: HTMLElement): THREE.Texture | null; connect(c: HTMLCanvasElement, cam: THREE.Camera, r: THREE.WebGLRenderer): void }
let renderer: HR | null = null
let host: HTMLDivElement | null = null
let failed = false
let pending: Promise<HR | null> | null = null

export const htmlRender = {
  get ok() { return !!renderer },
  async init(canvas: HTMLCanvasElement, camera: THREE.Camera, gl: THREE.WebGLRenderer) {
    if (renderer || failed || !settings.HTML_TEXTURES) return renderer
    if (pending) return pending
    pending = (async () => {
      try {
        const poly = await import('three-html-render/polyfill')
        poly.installHtmlInCanvasPolyfill()
        const { ThreeHTMLRenderer } = await import('three-html-render/renderer')
        canvas.setAttribute('layoutsubtree', '')
        host = document.createElement('div')
        host.className = 'html-render-host'
        canvas.appendChild(host)
        const r = new ThreeHTMLRenderer() as unknown as HR
        r.connect(canvas, camera, gl)
        renderer = r
      } catch (e) {
        console.warn('[surface-tension] three-html-render unavailable, DOM fallback', e)
        failed = true
      }
      return renderer
    })()
    return pending
  },
  /** Move `el` into the canvas subtree and bind it to `mesh`; returns a getter for its texture. */
  add(el: HTMLElement, mesh: THREE.Object3D) {
    if (!renderer || !host) return null
    host.appendChild(el)
    renderer.addObject(el, mesh)
    return () => renderer!.getTexture(el)
  },
  update() { if (renderer) { try { renderer.update() } catch (e) { console.warn(e); renderer = null; failed = true } } },
}
