/**
 * R6.90 (Shifat Oct 23 6:16 AM "add deep pad sounds for underwater theme feel"): a deep underwater ambient pad, a voice of its
 * own beside the existing bed and drone (journeyAudio's cues are untouched).
 *
 *  - when: it breathes in as the camera goes under the water, deepens with depth on the way down to the tablet, and fades out
 *    over the portal push (driven every frame by AudioService.update from the dive's progress)
 *  - sound: a warm, slow, dark pad around A1 with its fifth: a triangle on A1 and a sine on E2, each a detuned pair, plus a
 *    soft saw an octave up, all through a low-pass (~320 Hz in the shallows, opening to ~560 Hz in the deep) with a very slow
 *    LFO on the cutoff and the level (0.07 / 0.05 Hz), and a faint low "pressure" bed (filtered brown noise). Long swells
 *    (~3–4 s to settle), a send into the dark room (the shared reverb)
 *  - level: under the cues, about -24 to -20 dBFS at the speakers, through the R6.89 master chain (compressor + ceiling)
 *  - phones: high-passed at 120 Hz, so a small speaker is never asked for the sub it cannot move
 *  - cost: the voices exist only while the pad is audible; they are stopped ~8 s after it has faded out, and rebuilt on the
 *    next dive
 */
export type PadOpts = { phone: boolean }

const A1 = 55, E2 = 82.407
const PAD_GAIN = 0.16          // the pad bus at full presence (tuned offline: ≈ -22 dBFS peak at the output on its own, desktop)
const CUT_SHALLOW = 320, CUT_DEEP = 560

export class UnderwaterPad {
  private ctx: BaseAudioContext
  private out: GainNode           // presence × level (automated)
  private lfoAmp: GainNode | null = null
  private voices: { stop(t: number): void } | null = null
  private filter: BiquadFilterNode | null = null
  private quietFor = 0
  private last = -1
  private lastCut = -1
  constructor(ctx: BaseAudioContext, dest: AudioNode, reverb: AudioNode | null, private o: PadOpts) {
    this.ctx = ctx
    this.out = ctx.createGain(); this.out.gain.value = 0
    let tail: AudioNode = this.out
    if (o.phone) {   // the high-pass takes the fundamentals; +5 dB brings what is left back to the same place under the cues
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120; hp.Q.value = 0.7
      const mk = ctx.createGain(); mk.gain.value = 1.8; this.out.connect(hp); hp.connect(mk); tail = mk
    }
    tail.connect(dest)
    if (reverb) { const send = ctx.createGain(); send.gain.value = 0.35; tail.connect(send); send.connect(reverb) }
  }
  private start() {
    const ctx = this.ctx, t = ctx.currentTime
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = CUT_SHALLOW; f.Q.value = 0.6
    const amp = ctx.createGain(); amp.gain.value = 1
    f.connect(amp); amp.connect(this.out)
    const oscs: OscillatorNode[] = []
    const voice = (type: OscillatorType, freq: number, cents: number, g: number) => {
      const os = ctx.createOscillator(); os.type = type; os.frequency.value = freq; os.detune.value = cents
      const vg = ctx.createGain(); vg.gain.value = g
      os.connect(vg); vg.connect(f); os.start(t); oscs.push(os)
    }
    voice('triangle', A1, -6, 0.32); voice('triangle', A1, +5, 0.32)       // the root, a slow beating pair
    voice('sine', E2, -4, 0.26); voice('sine', E2, +7, 0.22)               // the fifth
    voice('sawtooth', A1 * 2, +3, 0.06)                                    // a soft saw an octave up (only its low harmonics pass)
    // the slow LFOs: on the cutoff (±70 Hz, 0.07 Hz) and on the level (±14 %, 0.05 Hz)
    const lf = ctx.createOscillator(); lf.frequency.value = 0.07
    const lfd = ctx.createGain(); lfd.gain.value = 70; lf.connect(lfd); lfd.connect(f.frequency); lf.start(t); oscs.push(lf)
    const la = ctx.createOscillator(); la.frequency.value = 0.05
    const lad = ctx.createGain(); lad.gain.value = 0.14; la.connect(lad); lad.connect(amp.gain); la.start(t); oscs.push(la)
    // the pressure bed: brown noise, band-limited low and very quiet
    const len = Math.floor(ctx.sampleRate * 4), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0)
    let b = 0; for (let i = 0; i < len; i++) { b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = b * 3.5 }
    const fade = Math.floor(ctx.sampleRate * 0.25); for (let i = 0; i < fade; i++) { const k = i / fade; d[len - fade + i] = d[len - fade + i] * (1 - k) + d[i] * k }
    const ns = ctx.createBufferSource(); ns.buffer = buf; ns.loop = true; ns.loopStart = 0.25; ns.loopEnd = 4
    const nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 140; nb.Q.value = 0.8
    const ng = ctx.createGain(); ng.gain.value = 0.10
    ns.connect(nb); nb.connect(ng); ng.connect(amp); ns.start(t)
    this.filter = f; this.lfoAmp = amp
    this.voices = { stop: (at: number) => { for (const os of oscs) { try { os.stop(at) } catch { /* stopped */ } } try { ns.stop(at) } catch { /* stopped */ } } }
  }
  /** every frame: k = presence 0..1 (under the water, faded over the portal), depth = 0..1 (shallow → the tablet's deep) */
  update(dt: number, k: number, depth: number) {
    const t = this.ctx.currentTime
    if (k > 0.001 && !this.voices) this.start()
    if (!this.voices) return
    const v = k * PAD_GAIN * (0.75 + 0.25 * depth)   // a little fuller in the deep
    if (Math.abs(v - this.last) > 0.002) { this.last = v; this.out.gain.cancelScheduledValues(t); this.out.gain.setTargetAtTime(v, t, 1.0) }   // ~3–4 s swells
    const cut = CUT_SHALLOW + (CUT_DEEP - CUT_SHALLOW) * depth
    if (this.filter && Math.abs(cut - this.lastCut) > 4) { this.lastCut = cut; this.filter.frequency.cancelScheduledValues(t); this.filter.frequency.setTargetAtTime(cut, t, 1.2) }
    // stop the voices once it has been silent a while (rebuilt on the next dive)
    if (k <= 0.001) { this.quietFor += dt; if (this.quietFor > 8) { this.voices.stop(t + 0.05); this.voices = null; this.filter = null; this.lfoAmp = null; this.last = -1; this.lastCut = -1 } }
    else this.quietFor = 0
  }
  /** ?audiotest: full presence and depth at once (offline peak check) */
  force(depth = 1) { if (!this.voices) this.start(); const g = PAD_GAIN * (0.75 + 0.25 * depth); this.out.gain.value = g; this.last = g; if (this.filter) this.filter.frequency.value = CUT_SHALLOW + (CUT_DEEP - CUT_SHALLOW) * depth }
}
