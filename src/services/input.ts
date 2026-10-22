import * as THREE from 'three'
import { props } from '../state/props'
/**
 * Layer 3 — Input singleton (handbook ch.5.1). Raw events accumulate between frames;
 * the loop reads "what happened since last frame" and postUpdate() resets the deltas.
 */
class Input {
  mouseXY = new THREE.Vector2(0, 0)          // -1..1, y up
  prevMouseXY = new THREE.Vector2(0, 0)
  mousePixelXY = new THREE.Vector2(-1, -1)  // CSS px, y down
  prevMousePixelXY = new THREE.Vector2(-1, -1)
  deltaXY = new THREE.Vector2()
  deltaPixelXY = new THREE.Vector2()
  isDown = false; wasDown = false
  hadMoved = false; hasMoved = false
  isTouch = false
  everMoved = false
  wheelDelta = 0
  clicked = false; clickPixel = new THREE.Vector2()
  private downEls = new Set<Element>()
  private _pending = new THREE.Vector2(-1, -1)
  private _pendingMoved = false
  readonly onDown: ((e: PointerEvent) => void)[] = []

  preInit() {
    const opts = { passive: true } as AddEventListenerOptions
    window.addEventListener('pointermove', this.onMove, opts)
    window.addEventListener('pointerdown', this.onPointerDown, opts)
    window.addEventListener('pointerup', this.onUp, opts)
    window.addEventListener('pointercancel', this.onUp, opts)
    window.addEventListener('blur', () => { this.isDown = false })
    window.addEventListener('wheel', (e) => { this.wheelDelta += e.deltaY }, opts)
  }
  private setPos(x: number, y: number) {
    this._pending.set(x, y); this._pendingMoved = true
    if (!this.everMoved) { this.mousePixelXY.set(x, y); this.prevMousePixelXY.set(x, y); this.everMoved = true }
  }
  private onMove = (e: PointerEvent) => { this.isTouch = e.pointerType === 'touch'; this.setPos(e.clientX, e.clientY) }
  private onPointerDown = (e: PointerEvent) => {
    this.isTouch = e.pointerType === 'touch'
    this.isDown = true
    this.setPos(e.clientX, e.clientY)
    this.downEls.clear()
    let el = e.target as Element | null
    while (el) { this.downEls.add(el); el = el.parentElement }
    this.onDown.forEach((f) => f(e))
  }
  private onUp = (e: PointerEvent) => {
    if (this.isDown && !this.isTouch) { this.clicked = true; this.clickPixel.set(e.clientX, e.clientY) }
    this.isDown = false
  }
  /** Did the current press start inside el? (so a pane only reacts to gestures that began in it) */
  hasThroughElem(el: Element) { return this.downEls.has(el) }

  update() {
    // Shifat 2:01 PM: while the gift holds the page scene, the pointer is frozen for the scene too (moving to the gift's
    // close button must not tilt the hero or swing the camera when the page comes back); the next real move resumes it
    if (props.sceneHold) { this._pendingMoved = false; this.hadMoved = false; this.deltaPixelXY.set(0, 0); this.deltaXY.set(0, 0); this.clicked = false; return }
    this.prevMousePixelXY.copy(this.mousePixelXY)
    this.prevMouseXY.copy(this.mouseXY)
    if (this._pendingMoved) this.mousePixelXY.copy(this._pending)
    this.hadMoved = this._pendingMoved
    this._pendingMoved = false
    // until a pointer has actually moved, the pointer is "centred" (not the top-left pixel 0,0 → -1,1, which used to
    // swing every visitor's camera left and push the hero stone off-centre)
    if (this.everMoved) this.mouseXY.set((this.mousePixelXY.x / props.width) * 2 - 1, 1 - (this.mousePixelXY.y / props.height) * 2)
    else this.mouseXY.set(0, 0)
    this.deltaPixelXY.subVectors(this.mousePixelXY, this.prevMousePixelXY)
    this.deltaXY.subVectors(this.mouseXY, this.prevMouseXY)
  }
  postUpdate() {
    this.wasDown = this.isDown
    this.wheelDelta = 0
    this.clicked = false
  }
}
export const input = new Input()
