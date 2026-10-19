import { props } from '../state/props'
/**
 * Web Audio — every sound synthesised (no files): a filtered-noise water bed, a sub drone that low-passes
 * under the dive, droplet "plips" from the cursor paint, hover ticks and section swells.
 * Muted until the first gesture + the speaker toggle (autoplay policy).
 */
class AudioService {
  ctx: AudioContext | null = null
  master!: GainNode
  bedFilter!: BiquadFilterNode
  bedGain!: GainNode
  droneGain!: GainNode
  droneFilter!: BiquadFilterNode
  reverb!: ConvolverNode
  wet!: GainNode
  enabled = false
  analyser: AnalyserNode | null = null
  private plipClock = 0
  private listeners = new Set<(on: boolean) => void>()
  onChange(f: (on: boolean) => void) { this.listeners.add(f); return () => { this.listeners.delete(f) } }
  private build() {
    const ctx = new AudioContext()
    this.ctx = ctx
    this.master = ctx.createGain(); this.master.gain.value = 0
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 64
    this.master.connect(this.analyser); this.analyser.connect(ctx.destination)
    // convolution reverb from a generated decaying-noise impulse
    this.reverb = ctx.createConvolver()
    const len = ctx.sampleRate * 2.6, ir = ctx.createBuffer(2, len, ctx.sampleRate)
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2) }
    this.reverb.buffer = ir
    this.wet = ctx.createGain(); this.wet.gain.value = 0.32
    this.reverb.connect(this.wet); this.wet.connect(this.master)
    // water bed: pink-ish noise → bandpass, slow LFO on the filter
    const nb = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate), nd = nb.getChannelData(0)
    let b0 = 0, b1 = 0, b2 = 0
    for (let i = 0; i < nd.length; i++) { const w = Math.random() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; nd[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18 }
    const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true
    this.bedFilter = ctx.createBiquadFilter(); this.bedFilter.type = 'bandpass'; this.bedFilter.frequency.value = 700; this.bedFilter.Q.value = 0.6
    this.bedGain = ctx.createGain(); this.bedGain.gain.value = 0.12
    noise.connect(this.bedFilter); this.bedFilter.connect(this.bedGain); this.bedGain.connect(this.master); this.bedGain.connect(this.reverb)
    noise.start()
    // drone for the deep: two detuned sines → lowpass
    this.droneFilter = ctx.createBiquadFilter(); this.droneFilter.type = 'lowpass'; this.droneFilter.frequency.value = 300
    this.droneGain = ctx.createGain(); this.droneGain.gain.value = 0
    ;[55, 55.6, 82.4].forEach((f) => { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(this.droneFilter); o.start() })
    this.droneFilter.connect(this.droneGain); this.droneGain.connect(this.master); this.droneGain.connect(this.reverb)
  }
  async toggle(on = !this.enabled) {
    if (!this.ctx) this.build()
    const ctx = this.ctx!
    if (ctx.state === 'suspended') await ctx.resume()
    this.enabled = on
    this.master.gain.cancelScheduledValues(ctx.currentTime)
    this.master.gain.setTargetAtTime(on ? 0.7 : 0, ctx.currentTime, 0.4)
    this.listeners.forEach((f) => f(on))
  }
  /** a single droplet: sine with a fast downward pitch glide, into the reverb */
  plip(intensity = 0.5, pitch = 1) {
    if (!this.enabled || !this.ctx) return
    const ctx = this.ctx, t = ctx.currentTime
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.type = 'sine'
    const f = (900 + Math.random() * 700) * pitch
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.42, t + 0.12)
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.06 * intensity, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
    o.connect(g); g.connect(this.master); g.connect(this.reverb); o.start(t); o.stop(t + 0.25)
  }
  tick() {
    if (!this.enabled || !this.ctx) return
    const ctx = this.ctx, t = ctx.currentTime
    const o = ctx.createOscillator(), g = ctx.createGain(), hp = ctx.createBiquadFilter()
    hp.type = 'highpass'; hp.frequency.value = 2400
    o.type = 'triangle'; o.frequency.value = 3200
    g.gain.setValueAtTime(0.02, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04)
    o.connect(hp); hp.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.05)
  }
  swell(up = true) {
    if (!this.enabled || !this.ctx) return
    const ctx = this.ctx, t = ctx.currentTime
    const n = ctx.createBufferSource(); const b = ctx.createBuffer(1, ctx.sampleRate * 1.6, ctx.sampleRate); const d = b.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    n.buffer = b
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2
    f.frequency.setValueAtTime(up ? 200 : 2000, t); f.frequency.exponentialRampToValueAtTime(up ? 2400 : 160, t + 1.4)
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 0.6); g.gain.linearRampToValueAtTime(0, t + 1.5)
    n.connect(f); f.connect(g); g.connect(this.master); g.connect(this.reverb); n.start(t)
  }
  /** a bubbly rising "bloop" for the journey and resurface */
  bubble(pitch = 1) {
    if (!this.enabled || !this.ctx) return
    const ctx = this.ctx, t = ctx.currentTime
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.type = 'sine'; o.frequency.setValueAtTime(220 * pitch, t); o.frequency.exponentialRampToValueAtTime(880 * pitch, t + 0.09)
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14)
    o.connect(g); g.connect(this.master); g.connect(this.reverb); o.start(t); o.stop(t + 0.16)
  }
  splash() {
    if (!this.enabled || !this.ctx) return
    const ctx = this.ctx, t = ctx.currentTime
    const n = ctx.createBufferSource(); const b = ctx.createBuffer(1, ctx.sampleRate * 1.2, ctx.sampleRate); const d = b.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4)
    n.buffer = b
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(5000, t); f.frequency.exponentialRampToValueAtTime(400, t + 0.9)
    const g = ctx.createGain(); g.gain.value = 0.12
    n.connect(f); f.connect(g); g.connect(this.master); g.connect(this.reverb); n.start(t)
    for (let i = 0; i < 6; i++) setTimeout(() => this.plip(0.6, 0.7 + Math.random() * 0.6), 80 + i * 70)
  }
  /** called every frame by the clock */
  update(dt: number) {
    if (!this.ctx || !this.enabled) return
    const t = this.ctx.currentTime
    const dive = props.look.dive
    this.bedFilter.frequency.setTargetAtTime(700 - dive * 520 + props.scrollStrength * 400, t, 0.2)
    this.bedGain.gain.setTargetAtTime(0.1 * (1 - dive * 0.6) + props.scrollStrength * 0.05, t, 0.3)
    this.droneGain.gain.setTargetAtTime(dive * 0.12, t, 0.5)
    this.droneFilter.frequency.setTargetAtTime(160 + (1 - dive) * 600, t, 0.4)
    // the cursor paint speaks in droplets
    this.plipClock -= dt
    if (props.waterPointerActive && this.plipClock <= 0) { this.plip(0.4); this.plipClock = 0.16 + Math.random() * 0.25 }
  }
}
export const audio = new AudioService()
