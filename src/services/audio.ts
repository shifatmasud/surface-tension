import { props } from '../state/props'
import { dive as diveState } from '../gl/stages/dive/diveState'
import * as K from './soundKit'
/**
 * Web Audio — every sound synthesised (no files; the voices live in soundKit.ts): a soft low-passed water bed, a sub drone that low-passes
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
  private legacy: ConvolverNode | null = null
  /** the R6.55 room (2.6 s decaying-noise impulse, wet 0.32), kept ONLY for the glass shatter, which Shifat locked
   *  (11:40Z "No lock current glass sound"); built on the first shatter */
  private legacyDry: GainNode | null = null
  private legacyBuilding = false
  /** W29 R6.74 (Shifat "Glass sound has bugs?", M02s): the room's 2.6 s IR used to be built INSIDE the first shatter's frame
   *  (~250k random samples, then the convolver), a stall on a weak phone right as ~140 voices start. It is now filled in
   *  short idle chunks as soon as sound is on (same impulse recipe, same 0.32 wet, so the locked shatter sounds the same);
   *  a shatter that arrives before it is ready plays dry once instead of stalling */
  get legacyReverb(): AudioNode {
    if (this.legacy) return this.legacy
    this.prepareLegacy()
    if (!this.legacyDry) { this.legacyDry = this.ctx!.createGain(); this.legacyDry.gain.value = 0 }
    return this.legacyDry
  }
  prepareLegacy() {
    if (this.legacy || this.legacyBuilding || !this.ctx) return
    this.legacyBuilding = true
    const ctx = this.ctx, len = Math.floor(ctx.sampleRate * 2.6), ir = ctx.createBuffer(2, len, ctx.sampleRate)
    const W = window as any
    const later = (f: () => void) => { if (W.requestIdleCallback) W.requestIdleCallback(f, { timeout: 400 }); else setTimeout(f, 16) }
    let c = 0, i = 0
    const step = () => {
      const d = ir.getChannelData(c), e = Math.min(len, i + 16384)
      for (; i < e; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2)
      if (i >= len) { c++; i = 0 }
      if (c < 2) { later(step); return }
      const cv = ctx.createConvolver()
      cv.buffer = ir
      const w = ctx.createGain(); w.gain.value = 0.32; cv.connect(w); w.connect(this.master)
      this.legacy = cv
    }
    later(step)
  }
  analyser: AnalyserNode | null = null
  private plipClock = 0
  private underK = 0
  private listeners = new Set<(on: boolean) => void>()
  onChange(f: (on: boolean) => void) { this.listeners.add(f); return () => { this.listeners.delete(f) } }
  private build() {
    // W29 R6.75: 'playback' asks for a larger output buffer. Offline, the shatter (~140 voices + the 2.6 s room) renders at
    // only ~4x real time on this box's core; on a low-end Android phone (Shifat's M02s) that is near or past real time, and
    // with the default interactive (smallest) buffer the device under-runs: crackle that reads as clipping. These are ambient
    // cues, so a few tens of ms more latency costs nothing
    let ctx: AudioContext
    try { ctx = new AudioContext({ latencyHint: 'playback' }) } catch { ctx = new AudioContext() }
    this.ctx = ctx
    this.master = ctx.createGain(); this.master.gain.value = 0
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 64
    // W25 R6.55 (sound audit #6): a safety limiter before the speakers. A splash (noise + six plips) over the bed, the drone
    // and the reverb tail could sum past full scale and clip; the limiter only acts on those peaks
    const lim = ctx.createDynamicsCompressor()
    // W29 R6.75 (Shifat "Weird sound distortion … clipping maybe"): measured offline through this chain, no path clipped a
    // sample, but the old -6 dB / 12:1 / soft-knee setting squashed the shatter's crack by several dB (and its automatic
    // make-up gain lifted the whole mix ~3 dB into it): audible crunch and pumping. Now a true ceiling that the cues sit
    // under: -3 dB, hard knee, 20:1, 2 ms attack, 150 ms release
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.15
    this.master.connect(lim); lim.connect(this.analyser); this.analyser.connect(ctx.destination)
    // W25 sound redesign: a short dark room (1.6 s, the highs dying first) in place of the bright 2.6 s noise impulse
    this.reverb = ctx.createConvolver()
    this.reverb.buffer = K.reverbIR(ctx)
    this.wet = ctx.createGain(); this.wet.gain.value = K.WET
    this.reverb.connect(this.wet); this.wet.connect(this.master)
    // water bed. W25 sound redesign: brown noise behind a 2.2 kHz ceiling and a moving low-pass (no bandpassed pink hiss),
    // breathing slowly. R6.55's seamless loop (#5) is kept: the 8 s loop's tail is cross-faded into its head (soundKit.bedBuffer)
    const bed = K.buildBed(ctx, [this.master, this.reverb])
    this.bedFilter = bed.filter; this.bedGain = bed.gain
    // drone for the deep: two detuned sines → lowpass
    this.droneFilter = ctx.createBiquadFilter(); this.droneFilter.type = 'lowpass'; this.droneFilter.frequency.value = 300
    this.droneGain = ctx.createGain(); this.droneGain.gain.value = 0
    ;[55, 55.6, 82.4].forEach((f) => { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(this.droneFilter); o.start() })
    this.droneFilter.connect(this.droneGain); this.droneGain.connect(this.master); this.droneGain.connect(this.reverb)
  }
  // W25 R6.55 (sound audit #1/#2/#3/#7):
  //  - the state flips synchronously, so a fast double tap is on → off (it used to read the stale state across the await and
  //    land on → on, with the wave line and the sound disagreeing)
  //  - the choice persists (localStorage); a returning visitor who left it on gets it back on their first gesture (still
  //    muted until a gesture: the autoplay rule)
  //  - a hidden tab suspends the context and a visible one resumes it; iOS/Android can also suspend or "interrupt" it (a
  //    call, the lock screen, another app's audio), so every later gesture resumes a context that should be running
  private wired = false
  private wire() {
    if (this.wired || typeof window === 'undefined') return
    this.wired = true
    const kick = () => { const c = this.ctx; if (this.enabled && c && c.state !== 'running' && !document.hidden) c.resume().catch(() => {}) }
    for (const ev of ['pointerup', 'touchend', 'keydown']) window.addEventListener(ev, kick, { passive: true })
    document.addEventListener('visibilitychange', () => {
      const c = this.ctx; if (!c) return
      if (document.hidden) { if (c.state === 'running') c.suspend().catch(() => {}) }
      else kick()
    })
  }
  /** a returning visitor's saved choice: armed for their first gesture (call once at boot) */
  restore() {
    let saved: string | null = null
    try { saved = localStorage.getItem('st-sound') } catch { /* private mode */ }
    if (saved !== '1' || typeof window === 'undefined') return
    // W29 R6.74: a first tap ON the sound pill is the pill's own toggle (its click turns sound on); arming here as well
    // made that one tap on → off
    const first = (e: Event) => { off(); if ((e.target as Element | null)?.closest?.('.pill--sound')) return; if (!this.enabled) this.toggle(true) }
    const off = () => { for (const ev of ['pointerup', 'touchend', 'keydown']) window.removeEventListener(ev, first) }
    for (const ev of ['pointerup', 'touchend', 'keydown']) window.addEventListener(ev, first, { passive: true })
  }
  async toggle(on = !this.enabled) {
    if (!this.ctx) this.build()
    this.wire()
    const ctx = this.ctx!
    this.enabled = on
    try { localStorage.setItem('st-sound', on ? '1' : '0') } catch { /* private mode */ }
    this.listeners.forEach((f) => f(on))
    this.master.gain.cancelScheduledValues(ctx.currentTime)
    this.master.gain.setTargetAtTime(on ? 0.7 : 0, ctx.currentTime, 0.4)
    if (on) this.prepareLegacy() // W29 R6.74: the shatter's room, built in idle chunks before it is needed
    if (on && ctx.state !== 'running') { try { await ctx.resume() } catch { /* the next gesture resumes it */ } }
  }
  private get bus(): K.Bus { return { ctx: this.ctx!, master: this.master, reverb: this.reverb } }
  /** a single droplet (soundKit.plip: a rounded sine bloop) */
  plip(intensity = 0.5, pitch = 1) { if (this.enabled && this.ctx) K.plip(this.bus, intensity, pitch) }
  /** hover: a tiny round tok (was a 3.2 kHz triangle through a 2.4 kHz high-pass) */
  tick() { if (this.enabled && this.ctx) K.tick(this.bus) }
  /** section swell: low-passed brown noise and a quiet fifth (was a white-noise bandpass sweep to 2.4 kHz) */
  swell(up = true) { if (this.enabled && this.ctx) K.swell(this.bus, up) }
  /** a bubbly rising "bloop" for the journey and resurface */
  bubble(pitch = 1) { if (this.enabled && this.ctx) K.bubble(this.bus, pitch) }
  /** opening a work card: a soft low water plunge and six droplets at the same offsets (was a 5 kHz white-noise burst) */
  splash() { if (this.enabled && this.ctx) K.splash(this.bus) }
  private aims = [NaN, NaN, NaN, NaN]
  private aim(i: number, p: AudioParam, v: number, t: number, tc: number, eps: number) {
    if (Math.abs(v - this.aims[i]) < eps) return
    this.aims[i] = v; p.cancelScheduledValues(t); p.setTargetAtTime(v, t, tc)
  }
  /** called every frame by the clock */
  update(dt: number) {
    if (!this.ctx || !this.enabled) return
    const t = this.ctx.currentTime
    // muffle only once actually under: the dive section's above-water first third keeps the open air
    const wantUnder = props.stage === 'dive' && !diveState.under ? 0 : props.look.dive
    this.underK += (wantUnder - this.underK) * (1 - Math.exp(-3 * dt))
    const dive = this.underK
    // W25 R6.55 (sound audit #8): these ran setTargetAtTime four times per frame forever, piling automation events on the
    // timeline (Safari keeps them: CPU creeps over a long visit). Now a target is re-scheduled only when it actually moves
    this.aim(0, this.bedFilter.frequency, K.bedCutoff(dive, props.scrollStrength), t, 0.2, 2)
    this.aim(1, this.bedGain.gain, K.bedLevel(dive, props.scrollStrength), t, 0.3, 0.001)
    this.aim(2, this.droneGain.gain, dive * 0.12, t, 0.5, 0.001)
    this.aim(3, this.droneFilter.frequency, 160 + (1 - dive) * 600, t, 0.4, 2)
    // the cursor paint speaks in droplets
    this.plipClock -= dt
    if (props.waterPointerActive && this.plipClock <= 0) { this.plip(0.4); this.plipClock = 0.16 + Math.random() * 0.25 }
  }
}
export const audio = new AudioService()
