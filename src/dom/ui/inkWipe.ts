import gsap from 'gsap'
/**
 * Transition overlay as a 2D canvas (ch.6.5), written fresh: a liquid ink front with a noisy meniscus
 * edge sweeps up the screen (expo in), then drains away (expo out). Black / silver only.
 */
class InkWipe {
  private c: HTMLCanvasElement | null = null
  private ctx!: CanvasRenderingContext2D
  private ensure() {
    if (this.c) return
    this.c = document.createElement('canvas'); this.c.className = 'ink'
    document.body.appendChild(this.c); this.ctx = this.c.getContext('2d')!
  }
  play(dir: 'in' | 'out') {
    this.ensure()
    const c = this.c!, ctx = this.ctx
    const dpr = Math.min(devicePixelRatio, 1.5)
    c.width = innerWidth * dpr; c.height = innerHeight * dpr
    const st = { p: 0 }
    return new Promise<void>((res) => {
      gsap.to(st, {
        p: 1, duration: dir === 'in' ? 0.7 : 0.8, ease: dir === 'in' ? 'expo.in' : 'expo.out',
        onUpdate: () => {
          const w = c.width, h = c.height, t = performance.now() * 0.002
          ctx.clearRect(0, 0, w, h)
          const front = dir === 'in' ? 1 - st.p : -st.p      // 1 → 0 covers; 0 → -1 drains upward
          const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#0a0a0b'); g.addColorStop(1, '#1b1c1f')
          ctx.fillStyle = g
          ctx.beginPath()
          const y0 = front * h * 1.15
          ctx.moveTo(0, h * 2)
          for (let x = 0; x <= w; x += w / 48) {
            const n = Math.sin(x * 0.004 + t) * 0.5 + Math.sin(x * 0.011 - t * 1.3) * 0.3
            ctx.lineTo(x, y0 + n * h * 0.06 * Math.sin(Math.PI * Math.min(1, st.p * 1.1)))
          }
          ctx.lineTo(w, h * 2); ctx.closePath(); ctx.fill()
          // silver meniscus highlight
          ctx.strokeStyle = 'rgba(220,222,226,0.35)'; ctx.lineWidth = 2 * dpr; ctx.stroke()
          if (dir === 'out' && front < -1.05) ctx.clearRect(0, 0, w, h)
        },
        onComplete: () => { if (dir === 'out') ctx.clearRect(0, 0, c.width, c.height); res() },
      })
    })
  }
}
export const inkWipe = new InkWipe()
