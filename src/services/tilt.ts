/** DeviceOrientation parallax for phones (iOS asks permission on first touch). */
export const tilt = {
  active: false, x: 0, y: 0, base: null as null | { b: number; g: number },
  init() {
    const on = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return
      if (!this.base) this.base = { b: e.beta, g: e.gamma }
      this.active = true
      this.x = Math.max(-1, Math.min(1, (e.gamma - this.base.g) / 25))
      this.y = Math.max(-1, Math.min(1, -(e.beta - this.base.b) / 25))
    }
    const D = (window as any).DeviceOrientationEvent
    if (!D || !matchMedia('(pointer: coarse)').matches) return
    if (typeof D.requestPermission === 'function') {
      const ask = () => { D.requestPermission().then((s: string) => { if (s === 'granted') window.addEventListener('deviceorientation', on) }).catch(() => {}); window.removeEventListener('touchend', ask) }
      window.addEventListener('touchend', ask)
    } else window.addEventListener('deviceorientation', on)
  },
}
