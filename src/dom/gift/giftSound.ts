/**
 * R6.83b gift reveal sounds (Shifat 07:57 "A+B with magical sounds reveal"). All synthesised (no files), scheduled once on
 * the tap against the open timeline: a satin rustle with fairy-dust sparkles as the ribbon burns away, a soft air lift
 * under the lid, an airy shimmer and a rising bell arpeggio as the dust swirls, and a warm bloom as the card forms.
 * Rides the site's own sound switch: when the site is muted (or sound never turned on) the gift is silent. Goes through
 * the site's master (its limiter) and room; journeyAudio is not touched.
 */
import { audio } from '../../services/audio'

type TLs = { R0: number; RK: number; L1a: number; L2b: number; D0: number; F0: number; F1: number }
let noiseBuf: AudioBuffer | null = null
function noise(ctx: BaseAudioContext) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf
  const len = Math.floor(ctx.sampleRate * 3), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0)
  let last = 0
  for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = last * 0.4 + w * 0.6; d[i] = last }   // a touch softer than white
  noiseBuf = b
  return b
}
const pan = (ctx: BaseAudioContext, v: number, to: AudioNode) => {
  if (!('createStereoPanner' in ctx)) return to
  const p = ctx.createStereoPanner(); p.pan.value = v; p.connect(to); return p
}

/** schedules every cue into dest (dry) and rev (room send); t is the tap's time on ctx's clock */
export function cues(ctx: BaseAudioContext, dest: AudioNode, rev: AudioNode | null, t: number, TL: TLs) {
  const send = (g: number) => { const n = ctx.createGain(); n.gain.value = g; n.connect(dest); if (rev) { const w = ctx.createGain(); w.gain.value = g * 1.6; n.connect(w); w.connect(rev) } return n }
  const nz = noise(ctx)
  const swish = (t0: number, dur: number, f0: number, f1: number, q: number, peak: number, type: BiquadFilterType, wob: number, p0: number, p1: number, out: AudioNode) => {
    const s = ctx.createBufferSource(); s.buffer = nz; s.loop = true; s.loopEnd = nz.duration
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q
    f.frequency.setValueAtTime(f0, t0); f.frequency.exponentialRampToValueAtTime(f1, t0 + dur)
    const g = ctx.createGain()
    const n = 72, curve = new Float32Array(n)
    for (let i = 0; i < n; i++) { const x = i / (n - 1); const env = Math.sin(Math.PI * Math.min(1, x * 1.15)) ** 1.4; curve[i] = peak * env * (1 - wob + wob * Math.random()) }
    curve[0] = 0; curve[n - 1] = 0
    g.gain.setValueAtTime(0, t0); g.gain.setValueCurveAtTime(curve, t0 + 0.001, dur)
    let o: AudioNode = out
    if ('createStereoPanner' in ctx) { const pn = ctx.createStereoPanner(); pn.pan.setValueAtTime(p0, t0); pn.pan.linearRampToValueAtTime(p1, t0 + dur); pn.connect(out); o = pn }
    s.connect(f); f.connect(g); g.connect(o)
    s.start(t0, Math.random() * 2); s.stop(t0 + dur + 0.05)
  }
  const bell = (t0: number, fr: number, peak: number, decay: number, pv: number, out: AudioNode) => {
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(peak, t0 + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay)
    g.connect(pan(ctx, pv, out))
    for (const [m, a] of [[1, 1], [2.76, 0.22], [5.4, 0.07]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr * m
      const og = ctx.createGain(); og.gain.value = a; o.connect(og); og.connect(g); o.start(t0); o.stop(t0 + decay + 0.05)
    }
  }
  // 1) the ribbon: a satin rustle that lifts in pitch as it burns away, and fairy-dust sparkles rising with it
  const r0 = t + TL.R0, rDur = TL.RK * 1.25
  swish(r0, rDur, 1600, 5200, 0.8, 0.22, 'bandpass', 0.55, -0.35, 0.3, send(0.9))
  swish(r0 + 0.05, rDur * 0.9, 5200, 9000, 1.2, 0.07, 'bandpass', 0.7, 0.3, -0.2, send(0.8))
  const sp = send(0.5), PENT = [2637, 2960, 3322, 3951, 4434, 5274]
  for (let i = 0; i < 12; i++) bell(r0 + 0.15 + Math.random() * (rDur + 0.5), PENT[(Math.random() * PENT.length) | 0], 0.035 + Math.random() * 0.025, 0.35 + Math.random() * 0.3, Math.random() * 1.2 - 0.6, sp)
  // 2) the lid: a soft breath of air as it lifts and tips back
  swish(t + TL.L1a, TL.L2b - TL.L1a + 0.4, 260, 900, 0.7, 0.12, 'lowpass', 0.2, 0.15, -0.15, send(0.9))
  // 3) the dust swirls: an airy shimmer that rises, and a bell arpeggio climbing into the card
  const d0 = t + TL.D0
  swish(d0, TL.F1 - TL.D0 + 0.3, 2400, 7600, 1.0, 0.08, 'bandpass', 0.4, -0.5, 0.5, send(0.8))
  const ARP = [880, 987.8, 1108.7, 1318.5, 1480, 1760, 2217.5, 2637], ab = send(0.6)
  const span = TL.F1 - TL.D0 - 0.35
  ARP.forEach((f, i) => bell(d0 + 0.2 + (i / (ARP.length - 1)) * span, f, 0.06, 1.6, i % 2 ? 0.35 : -0.35, ab))
  // 4) the card forms: a warm bloom (a soft open chord through an opening low-pass) and a last bright ting as it settles
  const b0 = t + (TL.F0 + TL.F1) / 2 - 0.35, bl = ctx.createBiquadFilter(), bg = ctx.createGain()
  bl.type = 'lowpass'; bl.Q.value = 0.5
  bl.frequency.setValueAtTime(260, b0); bl.frequency.exponentialRampToValueAtTime(1900, b0 + 0.9); bl.frequency.exponentialRampToValueAtTime(700, b0 + 3.4)
  bg.gain.setValueAtTime(0, b0); bg.gain.linearRampToValueAtTime(0.085, b0 + 0.7); bg.gain.setTargetAtTime(0, b0 + 1.6, 0.8)
  bl.connect(bg); bg.connect(send(1))
  for (const f of [110, 164.8, 220, 277.2, 329.6]) for (const dt of [-6, 6]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = dt
    const og = ctx.createGain(); og.gain.value = 0.16; o.connect(og); og.connect(bl); o.start(b0); o.stop(b0 + 5.5)
  }
  const sub = ctx.createOscillator(), sg = ctx.createGain(); sub.type = 'sine'; sub.frequency.setValueAtTime(70, b0); sub.frequency.exponentialRampToValueAtTime(52, b0 + 1)
  sg.gain.setValueAtTime(0, b0); sg.gain.linearRampToValueAtTime(0.16, b0 + 0.12); sg.gain.exponentialRampToValueAtTime(0.0001, b0 + 1.6)
  sub.connect(sg); sg.connect(dest); sub.start(b0); sub.stop(b0 + 1.7)
  const tg = send(0.7); bell(t + TL.F1, 2637, 0.05, 2.2, 0.1, tg); bell(t + TL.F1 + 0.04, 3520, 0.03, 1.8, -0.1, tg)
}

/** plays the reveal on the site's audio, if the site's sound is on; stop() fades it out (the gift was closed) */
export function giftSound(TL: TLs): { stop(): void } {
  const ctx = audio.ctx
  if (!audio.enabled || !ctx || ctx.state === 'closed') return { stop() {} }
  try {
    const bus = ctx.createGain(); bus.gain.value = 1; bus.connect(audio.master)
    const wet = ctx.createGain(); wet.connect(audio.reverb)
    cues(ctx, bus, wet, ctx.currentTime + 0.02, TL)
    return {
      stop() {
        const n = ctx.currentTime
        for (const g of [bus, wet]) { g.gain.cancelScheduledValues(n); g.gain.setTargetAtTime(0, n, 0.08) }
        setTimeout(() => { try { bus.disconnect(); wet.disconnect() } catch { /* gone */ } }, 600)
      },
    }
  } catch { return { stop() {} } }
}

/** QA: renders the reveal offline to 16-bit stereo WAV bytes (used to put the sound on the preview clip) */
export async function giftSoundWav(TL: TLs, secs = 8): Promise<Uint8Array> {
  const sr = 44100, oc = new OfflineAudioContext(2, sr * secs, sr)
  const lim = oc.createDynamicsCompressor(); lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.15
  const master = oc.createGain(); master.gain.value = 0.7; master.connect(lim); lim.connect(oc.destination)
  const rv = oc.createConvolver(), len = sr * 1.6, ir = oc.createBuffer(2, len, sr)
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3) }
  rv.buffer = ir; const rw = oc.createGain(); rw.gain.value = 0.2; rv.connect(rw); rw.connect(master)
  cues(oc, master, rv, 0, TL)
  const buf = await oc.startRendering(), n = buf.length, out = new DataView(new ArrayBuffer(44 + n * 4))
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true)
  out.setUint32(24, sr, true); out.setUint32(28, sr * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * 4, true)
  const L = buf.getChannelData(0), R = buf.getChannelData(1)
  for (let i = 0; i < n; i++) { out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true) }
  return new Uint8Array(out.buffer)
}
