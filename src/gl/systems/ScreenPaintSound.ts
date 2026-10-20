import { audio } from '../../services/audio'

/**
 * The trail's voice — synthesised, silent until the visitor turns sound on (the site's speaker toggle).
 *   swish   a looping band-passed noise whose level and brightness follow pointer speed (a slow drift is
 *           nearly silent, a fast flick is an airy whoosh); very low in the mix
 *   flick   a soft rising "fwip" when a fast throw stops hard
 *   splash  a small round "bloop" + two droplets for a click / tap burst
 * All nodes hang off the site's master bus (and its reverb), so mute / unmute and the dive's muffling apply.
 */
class TrailSound {
  private gain: GainNode | null = null
  private bp: BiquadFilterNode | null = null
  private built = false
  private lvl = 0
  private lastSplash = 0
  private build() {
    const ctx = audio.ctx
    if (!ctx || this.built) return
    this.built = true
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0)
    let b = 0
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = (w * 0.55 + b * 2.2) * 0.5 }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true
    this.bp = ctx.createBiquadFilter(); this.bp.type = 'bandpass'; this.bp.frequency.value = 900; this.bp.Q.value = 0.9
    this.gain = ctx.createGain(); this.gain.gain.value = 0
    src.connect(this.bp); this.bp.connect(this.gain); this.gain.connect(audio.master); this.gain.connect(audio.reverb)
    src.start()
  }
  update(dt: number, speed: number, sN: number, drawing: boolean) {
    if (!audio.enabled || !audio.ctx) { if (this.gain && audio.ctx) this.gain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.05); return }
    if (!this.built) this.build()
    if (!this.gain || !this.bp) return
    const want = drawing ? Math.pow(sN, 1.6) * 0.05 : 0
    this.lvl += (want - this.lvl) * (1 - Math.exp(-dt * (want > this.lvl ? 18 : 6)))
    const t = audio.ctx.currentTime
    this.gain.gain.setTargetAtTime(this.lvl, t, 0.03)
    this.bp.frequency.setTargetAtTime(500 + Math.min(speed, 4000) * 0.9, t, 0.05)
    void dt
  }
  flick(strength: number) {
    const ctx = audio.ctx
    if (!audio.enabled || !ctx) return
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(380, t); o.frequency.exponentialRampToValueAtTime(980 + strength * 400, t + 0.11)
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.03 + strength * 0.02, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
    o.connect(g); g.connect(audio.master); g.connect(audio.reverb); o.start(t); o.stop(t + 0.2)
  }
  splash() {
    const ctx = audio.ctx
    if (!audio.enabled || !ctx) return
    const t = ctx.currentTime
    if (t - this.lastSplash < 0.12) return
    this.lastSplash = t
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(240, t); o.frequency.exponentialRampToValueAtTime(620, t + 0.07)
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
    o.connect(g); g.connect(audio.master); g.connect(audio.reverb); o.start(t); o.stop(t + 0.22)
    setTimeout(() => audio.plip(0.45, 1.15), 70)
    setTimeout(() => audio.plip(0.3, 1.4), 150)
  }
}
export const trailSound = new TrailSound()
