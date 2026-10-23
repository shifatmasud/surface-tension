import { props } from '../state/props'
import { dive as diveState } from '../gl/stages/dive/diveState'
import * as K from './soundKit'
import { UnderwaterPad } from './underwaterPad' // R6.90: the deep pad
import { PORTAL0 } from '../gl/stages/dive/diveState'

/** R6.89 gain staging (see build) */
const MASTER_ON = 0.5
const HEADROOM_TRIM = 0.75   // -2.5 dB: takes back the compressor's automatic make-up gain
/** phones / touch screens: the shatter's softer bus (?phoneaudio / ?deskaudio force either for tests) */
const Q = typeof location !== 'undefined' ? location.search : ''
export const PHONE_AUDIO = /[?&]phoneaudio/.test(Q) ? true : /[?&]deskaudio/.test(Q) ? false
  : typeof matchMedia !== 'undefined' && matchMedia('(hover: none) and (pointer: coarse)').matches
/** a soft-knee ceiling: linear to 0.6 (-4.4 dBFS), then a tanh shoulder bounded at 0.84 (-1.5 dBFS); with no oversampling the
 *  shaper only interpolates this curve, so no output sample can pass it */
function ceilingCurve() {
  const N = 4097, c = new Float32Array(N), k = 0.6, top = 0.84
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1, a = Math.abs(x)
    const y = a <= k ? a : k + (top - k) * Math.tanh((a - k) / (top - k))
    c[i] = Math.sign(x) * y
  }
  return c
}
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
  prepareLegacy(sync = false) {
    if (this.legacy || (this.legacyBuilding && !sync) || !this.ctx) return
    this.legacyBuilding = true
    const ctx = this.ctx, len = Math.floor(ctx.sampleRate * 2.6), ir = ctx.createBuffer(2, len, ctx.sampleRate)
    const W = window as any
    const later = (f: () => void) => { if (sync) f(); else if (W.requestIdleCallback) W.requestIdleCallback(f, { timeout: 400 }); else setTimeout(f, 16) }
    let c = 0, i = 0
    const step = () => {
      const d = ir.getChannelData(c), e = Math.min(len, i + 16384)
      for (; i < e; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2)
      if (i >= len) { c++; i = 0 }
      if (c < 2) { later(step); return }
      const cv = ctx.createConvolver()
      cv.buffer = ir
      const w = ctx.createGain(); w.gain.value = 0.32; cv.connect(w); w.connect(this.shatterBus)   // R6.89: the room's tail rides the shatter's bus (phones: filtered with it)
      this.legacy = cv
    }
    later(step)
  }
  analyser: AnalyserNode | null = null
  /** R6.89: the shatter's own bus (see build) and the last node before the speakers */
  shatterBus!: GainNode
  outNode: AudioNode | null = null
  private plipClock = 0
  private underK = 0
  private listeners = new Set<(on: boolean) => void>()
  onChange(f: (on: boolean) => void) { this.listeners.add(f); return () => { this.listeners.delete(f) } }
  private build(offline?: BaseAudioContext) {
    // W29 R6.75: 'playback' asks for a larger output buffer. Offline, the shatter (~140 voices + the 2.6 s room) renders at
    // only ~4x real time on this box's core; on a low-end Android phone (Shifat's M02s) that is near or past real time, and
    // with the default interactive (smallest) buffer the device under-runs: crackle that reads as clipping. These are ambient
    // cues, so a few tens of ms more latency costs nothing
    let ctx: AudioContext
    if (offline) ctx = offline as AudioContext
    else try { ctx = new AudioContext({ latencyHint: 'playback' }) } catch { ctx = new AudioContext() }
    this.ctx = ctx
    this.master = ctx.createGain(); this.master.gain.value = 0
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 64
    // W25 R6.55 (sound audit #6): a safety limiter before the speakers. A splash (noise + six plips) over the bed, the drone
    // and the reverb tail could sum past full scale and clip; the limiter only acts on those peaks
    // R6.89 (Shifat Oct 23 3:43 AM "Sound need headroom so no clip distortion happens"): real gain staging on the whole mix.
    //   master (0.5, was 0.7: ~3 dB of headroom before anything else) → a fast compressor (threshold -6 dB, 1 ms attack,
    //   6:1, a 2 dB knee) that tucks the summed peaks in → a trim that takes back Chrome's automatic make-up gain → a
    //   soft-knee ceiling (linear to -4.4 dBFS, then a tanh shoulder that can never pass -1.7 dBFS, whatever goes in) →
    //   the speakers. The cues keep their sound; only the loudest instants are tucked under the ceiling.
    const lim = ctx.createDynamicsCompressor()
    lim.threshold.value = -6; lim.knee.value = 2; lim.ratio.value = 6; lim.attack.value = 0.001; lim.release.value = 0.12
    const trim = ctx.createGain(); trim.gain.value = HEADROOM_TRIM
    const ceil = ctx.createWaveShaper(); ceil.curve = ceilingCurve(); ceil.oversample = 'none'
    this.master.connect(lim); lim.connect(trim)
    if ((this as any).testRaw) trim.connect(this.analyser)   // ?audiotest only: read the stage before the ceiling
    else { trim.connect(ceil); ceil.connect(this.analyser) }
    this.analyser.connect(ctx.destination)
    this.outNode = ceil
    // R6.89 (Shifat "Glass shatter sounds clip distorted in my phone speaker, yet felt great in desktop"): the shatter rides
    // its own bus. Desktop: a unity gain straight into the master (bit-identical sound). Phones/touch: its peak comes down
    // 6 dB, the sub a phone speaker cannot move is cut (high-pass 150 Hz: the 95→34 Hz thump only ate headroom and rattled
    // the speaker), and the harsh top is softened (high shelf -8 dB from 6.5 kHz, low-pass 10 kHz)
    this.shatterBus = ctx.createGain()
    if (PHONE_AUDIO) {
      this.shatterBus.gain.value = 0.5
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 150; hp.Q.value = 0.7
      const hs = ctx.createBiquadFilter(); hs.type = 'highshelf'; hs.frequency.value = 6500; hs.gain.value = -8
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 10000; lp.Q.value = 0.5
      this.shatterBus.connect(hp); hp.connect(hs); hs.connect(lp); lp.connect(this.master)
    } else this.shatterBus.connect(this.master)
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
    // R6.90: the deep underwater pad (its own voice; underwaterPad.ts)
    this.pad = new UnderwaterPad(ctx, this.master, this.reverb, { phone: PHONE_AUDIO })
  }
  pad: UnderwaterPad | null = null
  private padK = 0
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
    this.master.gain.setTargetAtTime(on ? MASTER_ON : 0, ctx.currentTime, 0.4)   // R6.89: 0.5 (was 0.7)
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
    // R6.90 the deep pad: in as the camera goes under, deeper on the way down to the tablet, out over the portal push
    {
      const st = props.stage, inDive = (st === 'dive' || st === 'lab') && diveState.under
      const sm = (a: number, b: number, x: number) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u) }
      const want = inDive ? 1 - sm(PORTAL0, 1, diveState.push) : 0
      this.padK += (want - this.padK) * (1 - Math.exp(-4 * dt))
      this.pad?.update(dt, this.padK, sm(0, 0.42, diveState.push))
    }
    // the cursor paint speaks in droplets
    this.plipClock -= dt
    if (props.waterPointerActive && this.plipClock <= 0) { this.plip(0.4); this.plipClock = 0.16 + Math.random() * 0.25 }
  }
}
export const audio = new AudioService()

/** R6.90 video hook (?offlineaudio=SECONDS only): the whole page's sound renders into an OfflineAudioContext that advances
 *  in step with a frame-stepped capture (__offAdvance(t) renders up to t seconds and holds there), so every cue lands on the
 *  frame that triggered it; __offFinish() renders the rest and returns 16-bit PCM (interleaved stereo, 48 kHz) as base64 chunks */
if (typeof window !== 'undefined' && /[?&]offlineaudio=/.test(location.search)) {
  const secs = Math.max(1, +(location.search.match(/offlineaudio=([\d.]+)/)?.[1] || 60))
  const sr = 48000, off = new OfflineAudioContext(2, Math.ceil(sr * secs), sr)
  const A = audio as any
  A.build(off); A.enabled = true; audio.master.gain.value = MASTER_ON; audio.prepareLegacy(true)
  ;(audio as any).toggle = async () => {}   // the speaker pill cannot rebuild it
  let started = false, render: Promise<AudioBuffer> | null = null
  ;(window as any).__offAdvance = (t: number) => new Promise<void>((res) => {
    if (t >= secs - 0.01) { res(); return }
    off.suspend(t).then(() => res())
    if (!started) { started = true; render = off.startRendering() } else off.resume()
  })
  ;(window as any).__offFinish = async () => {
    if (!started) { started = true; render = off.startRendering() } else off.resume()
    const buf = await render!
    const L = buf.getChannelData(0), R = buf.getChannelData(1), n = buf.length, pcm = new Int16Array(n * 2)
    let peak = 0
    for (let i = 0; i < n; i++) { const l = L[i], r = R[i]; peak = Math.max(peak, Math.abs(l), Math.abs(r)); pcm[2 * i] = Math.max(-1, Math.min(1, l)) * 32767; pcm[2 * i + 1] = Math.max(-1, Math.min(1, r)) * 32767 }
    const bytes = new Uint8Array(pcm.buffer), out: string[] = []
    for (let i = 0; i < bytes.length; i += 3 * 1 << 20) { let s = ''; const e = Math.min(bytes.length, i + (3 << 20)); for (let j = i; j < e; j += 8192) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(j, Math.min(e, j + 8192)))); out.push(btoa(s)) }
    return { chunks: out, peakDb: 20 * Math.log10(peak || 1e-9), frames: n }
  }
}

/** R6.89 test hook (?audiotest only): renders the real chain offline (6 s, 48 kHz) and reports the output's peak. `play`
 *  schedules the cues at the context's time 0; `raw` skips the ceiling so the compressor + trim stage can be read alone */
if (typeof window !== 'undefined' && /[?&]audiotest/.test(location.search)) {
  ;(window as any).__audio = audio   // R6.90: the pad's offline check calls __audio.pad.force()
  ;(window as any).__audioTest = async (play: () => void, raw = false) => {
    const sr = 48000, off = new OfflineAudioContext(2, sr * 6, sr)
    const A = audio as any
    A.testRaw = raw
    A.legacy = null; A.legacyBuilding = false; A.legacyDry = null
    A.build(off); A.enabled = true
    audio.master.gain.value = MASTER_ON
    audio.prepareLegacy(true)
    audio.bedGain.gain.value = 0.2; audio.droneGain.gain.value = 0.12
    play()
    const buf = await off.startRendering()
    let peak = 0, sum = 0, n = 0
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += v * v; n++ } }
    return { peak: +peak.toFixed(4), peakDb: +(20 * Math.log10(peak || 1e-9)).toFixed(2), rmsDb: +(10 * Math.log10(sum / n || 1e-12)).toFixed(2), phone: PHONE_AUDIO, raw }
  }
}
