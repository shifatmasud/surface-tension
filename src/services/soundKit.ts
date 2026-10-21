/**
 * W25 sound redesign (mockup, Shifat 11:37Z: "softer calmer cleaner … no noisy distorted sounds").
 * Every voice the site makes, as pure functions of a Bus, so the same code plays live and renders offline.
 * The palette: rounded sine tones, attacks of 10–40 ms, smooth exponential tails (no hard cut-offs), all
 * textures brown noise low-passed under ~2 kHz, nothing above ~6 kHz, a short dark reverb.
 * Cue names, trigger points and timings are unchanged; only the sound each one makes is new.
 */
export interface Bus { ctx: BaseAudioContext; master: AudioNode; reverb: AudioNode }

const now = (b: Bus, at?: number) => (at ?? b.ctx.currentTime)
/** soft envelope: linear rise over `a` (≥10 ms), then an exponential tail with time-constant r/4, so it lands at
 *  ~−35 dB at t+a+r and is fully silent by the stop time; no clicks at either end */
function env(g: GainNode, t: number, peak: number, a: number, r: number) {
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(peak, t + Math.max(0.01, a))
  g.gain.setTargetAtTime(0, t + Math.max(0.01, a), r / 4)
}
const tail = (a: number, r: number) => Math.max(0.01, a) + r * 1.6
function sine(b: Bus, t: number, hz: number, dur: number) {
  const o = b.ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(hz, t); o.start(t); o.stop(t + dur); return o
}
function lp(b: Bus, hz: number, q = 0.5) { const f = b.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = hz; f.Q.value = q; return f }
function out(b: Bus, n: AudioNode, wet = true) { n.connect(b.master); if (wet) n.connect(b.reverb) }
function pan(b: Bus, x: number): AudioNode {
  const c = b.ctx as AudioContext
  if (!c.createStereoPanner) return b.ctx.createGain()
  const p = c.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, x)); return p
}
/** brown noise (integrated white, DC-blocked): the soft base of every texture; nearly no energy up high */
export function brown(ctx: BaseAudioContext, sec: number, fadeIn = 0.02) {
  const n = Math.floor(ctx.sampleRate * sec), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0)
  let y = 0, dc = 0
  for (let i = 0; i < n; i++) { y = (y + 0.02 * (Math.random() * 2 - 1)) * 0.998; dc += (y - dc) * 0.0005; d[i] = (y - dc) * 3.2 }
  const fi = Math.floor(ctx.sampleRate * fadeIn), fo = Math.floor(ctx.sampleRate * 0.03)
  for (let i = 0; i < fi && i < n; i++) d[i] *= i / fi
  for (let i = 0; i < fo && i < n; i++) d[n - 1 - i] *= i / fo
  const s = ctx.createBufferSource(); s.buffer = buf; return s
}

/** a short, dark room: 1.6 s, 10 ms pre-delay, stereo-decorrelated, the highs dying faster than the lows (a one-pole
 *  low-pass inside the impulse that closes from ~3 kHz to ~700 Hz along the tail) */
export function reverbIR(ctx: BaseAudioContext) {
  const SR = ctx.sampleRate, len = Math.floor(SR * 1.6), pre = Math.floor(SR * 0.01), ir = ctx.createBuffer(2, len, SR)
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c); let y = 0, y2 = 0
    for (let i = pre; i < len; i++) {
      const k = (i - pre) / (len - pre), fc = 3000 * Math.pow(700 / 3000, k), a = 1 - Math.exp(-2 * Math.PI * fc / SR)
      y += a * ((Math.random() * 2 - 1) - y); y2 += a * (y - y2)
      d[i] = y2 * Math.pow(1 - k, 2.4) * Math.min(1, (i - pre) / (SR * 0.012)) * 2.2
    }
  }
  return ir
}
export const WET = 0.2

/** the water bed: a seamless 8 s loop of soft noise (mostly brown), the loop tail cross-faded (equal power) into the head */
export function bedBuffer(ctx: BaseAudioContext) {
  const SR = ctx.sampleRate, L = SR * 8, X = Math.floor(SR * 0.75), raw = new Float32Array(L + X)
  // 65% brown (the body) + 35% pink (the water's surface); the filters below take everything over ~2 kHz away
  let y = 0, dc = 0, b0 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1
    y = (y + 0.02 * w) * 0.998; dc += (y - dc) * 0.0005
    b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913
    raw[i] = (y - dc) * 3.2 * 0.65 + (b0 + b1 + b2 + w * 0.1848) * 0.11 * 0.35
  }
  const nb = ctx.createBuffer(1, L, SR), nd = nb.getChannelData(0)
  for (let i = 0; i < L; i++) nd[i] = raw[i]
  for (let i = 0; i < X; i++) { const k = i / X; nd[i] = raw[i] * Math.sin(k * Math.PI / 2) + raw[L + i] * Math.cos(k * Math.PI / 2) }
  return nb
}
/** bed tone: the moving low-pass (bedFilter) sits behind a fixed 2.2 kHz ceiling and an 80 Hz floor, and a 0.07 Hz
 *  swell (±25%) breathes the level like slow water; returns the nodes audio.ts drives */
export function buildBed(ctx: BaseAudioContext, dest: AudioNode[]) {
  const src = ctx.createBufferSource(); src.buffer = bedBuffer(ctx); src.loop = true
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 80; hp.Q.value = 0.5
  const ceil = ctx.createBiquadFilter(); ceil.type = 'lowpass'; ceil.frequency.value = 2200; ceil.Q.value = 0.5
  const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = BED_LP_REST; filter.Q.value = 0.6
  const breath = ctx.createGain(); breath.gain.value = 1
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07; const depth = ctx.createGain(); depth.gain.value = 0.25
  lfo.connect(depth); depth.connect(breath.gain); lfo.start()
  const gain = ctx.createGain(); gain.gain.value = BED_GAIN
  src.connect(hp); hp.connect(ceil); ceil.connect(filter); filter.connect(breath); breath.connect(gain); dest.forEach((d) => gain.connect(d))
  src.start()
  return { filter, gain, src }
}
/** where update() steers the bed: surface 1.7 kHz → deep 500 Hz, opened a little by scroll speed */
export const BED_LP_REST = 1700
export const bedCutoff = (dive: number, scroll: number) => BED_LP_REST - dive * 1200 + scroll * 400
export const BED_GAIN = 0.065
export const bedLevel = (dive: number, scroll: number) => BED_GAIN * (1 - dive * 0.55) + scroll * 0.025

/** a droplet: a rounded sine "bloop" (12 ms rise, a short upward glide as water bubbles do), no sharp click */
export function plip(b: Bus, intensity = 0.5, pitch = 1, at?: number) {
  const t = now(b, at), f = (520 + Math.random() * 260) * pitch
  const o = sine(b, t, f, 0.4); o.frequency.exponentialRampToValueAtTime(f * 1.45, t + 0.09)
  const g = b.ctx.createGain(); env(g, t, 0.05 * intensity, 0.012, 0.2)
  o.connect(g); out(b, g)
}
/** hover: a tiny round wooden "tok" (880 Hz sine, 10 ms rise, gone in 80 ms) */
export function tick(b: Bus, at?: number) {
  const t = now(b, at), o = sine(b, t, 880, 0.15), g = b.ctx.createGain()
  o.frequency.exponentialRampToValueAtTime(820, t + 0.06)
  env(g, t, 0.015, 0.01, 0.07); o.connect(g); out(b, g, false)
}
/** a section swell: low-passed brown noise breathing in and out, the cut-off gliding 250→1300 Hz (up) or 1300→220
 *  (down), with a quiet open fifth underneath; the same 1.5 s shape as before */
export function swell(b: Bus, up = true, at?: number) {
  const t = now(b, at), n = brown(b.ctx, 1.6, 0.05), f = lp(b, up ? 250 : 1300, 0.7)
  f.frequency.setValueAtTime(up ? 250 : 1300, t); f.frequency.exponentialRampToValueAtTime(up ? 1300 : 220, t + 1.4)
  const g = b.ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.028, t + 0.6); g.gain.linearRampToValueAtTime(0, t + 1.5)
  n.connect(f); f.connect(g); out(b, g); n.start(t)
  const pad = b.ctx.createGain(); pad.gain.setValueAtTime(0, t); pad.gain.linearRampToValueAtTime(0.003, t + 0.6); pad.gain.linearRampToValueAtTime(0, t + 1.5)
  ;(up ? [196, 293.7] : [293.7, 196]).forEach((hz, i) => { const o = sine(b, t, hz, 1.6); o.frequency.exponentialRampToValueAtTime(hz * (up ? 1.06 : 0.94), t + 1.4); if (i) o.detune.value = 4; o.connect(pad) })
  out(b, pad)
}
/** the journey/resurface bloop: a sine rising 240→560 Hz over 140 ms, 15 ms rise, round tail */
export function bubble(b: Bus, pitch = 1, at?: number) {
  const t = now(b, at), o = sine(b, t, 240 * pitch, 0.45), g = b.ctx.createGain()
  o.frequency.exponentialRampToValueAtTime(560 * pitch, t + 0.14)
  env(g, t, 0.03, 0.015, 0.24); o.connect(g); out(b, g)
}
/** opening a work card: a soft low-passed water "plunge" (brown noise, 20 ms rise, the cut-off sinking 1.6 kHz→280 Hz)
 *  and the same six droplets at the same offsets (80 ms, then every 70 ms) — scheduled on the audio clock now */
export function splash(b: Bus, at?: number) {
  const t = now(b, at), n = brown(b.ctx, 1.2), f = lp(b, 1600, 0.6)
  f.frequency.setValueAtTime(1600, t); f.frequency.exponentialRampToValueAtTime(280, t + 0.9)
  const g = b.ctx.createGain(); env(g, t, 0.2, 0.02, 0.7)
  n.connect(f); f.connect(g); out(b, g); n.start(t)
  for (let i = 0; i < 6; i++) plip(b, 0.55, 0.7 + Math.random() * 0.6, t + 0.08 + i * 0.07)
}

/* ---------- journey ---------- */
/** 0 space: the slow wide hum (detuned fifths), darker (600 Hz low-pass), 1.4 s in, 2.6 s out */
export function jSpace(b: Bus, at?: number) {
  const t = now(b, at), f = lp(b, 600), g = b.ctx.createGain()
  ;[110, 110.7, 164.8, 220.4].forEach((hz) => sine(b, t, hz, 4.4).connect(f))
  f.connect(g); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.025, t + 1.4); g.gain.setTargetAtTime(0, t + 1.4, 0.7); out(b, g)
}
/** 2 forest landing: a soft felt thud (15 ms rise), a gentle leaf breath (brown noise, 900–1800 Hz), two low round birds */
export function jForest(b: Bus, at?: number) {
  const t = now(b, at)
  const o = sine(b, t, 90, 0.7), g = b.ctx.createGain(); o.frequency.exponentialRampToValueAtTime(48, t + 0.2)
  env(g, t, 0.12, 0.015, 0.32); o.connect(g); out(b, g, false)
  const n = brown(b.ctx, 1.5, 0.1), bp = b.ctx.createBiquadFilter(), ng = b.ctx.createGain(), cap = lp(b, 2000)
  bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 0.5
  n.connect(bp); bp.connect(cap); cap.connect(ng)
  ng.gain.setValueAtTime(0, t + 0.05); ng.gain.linearRampToValueAtTime(0.09, t + 0.3); ng.gain.setTargetAtTime(0, t + 0.3, 0.28); out(b, ng); n.start(t)
  ;[0.55, 0.78].forEach((d, i) => {
    const s = t + d, base = i ? 2100 : 1850, w = sine(b, s, base, 0.4), wg = b.ctx.createGain()
    w.frequency.exponentialRampToValueAtTime(base * 1.18, s + 0.07); w.frequency.exponentialRampToValueAtTime(base * 0.94, s + 0.15)
    env(wg, s, 0.012, 0.018, 0.16); w.connect(wg); out(b, wg)
  })
}
/** 3 reveal: the two glassy partials, now with a 40 ms bloom and a longer, calmer tail */
export function jReveal(b: Bus, at?: number) {
  const t = now(b, at)
  ;[1318.5, 1975.5].forEach((hz, i) => {
    const o = sine(b, t, hz + i * 1.5, 3.4), g = b.ctx.createGain()
    env(g, t, i ? 0.007 : 0.012, 0.04, 2.0); o.connect(g); out(b, g)
  })
}
/** a knock on the glass, now a soft tap: a round wooden body (200→120 Hz, 10 ms rise) and a short glass tink
 *  (two partials, 12 ms rise, 0.3 s ring); the harder second knock is a touch louder and rings a little longer */
export function knock(b: Bus, hard: boolean, at?: number) {
  const t = now(b, at)
  const o = sine(b, t, hard ? 210 : 190, 0.5), g = b.ctx.createGain(); o.frequency.exponentialRampToValueAtTime(115, t + 0.08)
  env(g, t, hard ? 0.13 : 0.09, 0.01, 0.13); o.connect(g); out(b, g, false)
  const f0 = hard ? 1180 : 1040, cap = lp(b, 4000, 0.4), cg = b.ctx.createGain(); cap.connect(cg); out(b, cg)
  ;[[1, 1], [2.76, 0.22]].forEach(([m, k]) => {
    const w = sine(b, t, f0 * m, 0.8), wg = b.ctx.createGain()
    env(wg, t, (hard ? 0.024 : 0.016) * k, 0.012, (hard ? 0.36 : 0.26) / m); w.connect(wg); wg.connect(cap)
  })
}
