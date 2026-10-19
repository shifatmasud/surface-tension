import { audio } from '../../../services/audio'

/**
 * Journey cues, all synthesised and quiet: space hum → descent whoosh → forest air (thud, leaves, two birds)
 * → a glassy shimmer as the tablet reveals → the liquid break → a soft bloop as it floats free.
 * Beats come from scroll progress with hysteresis, so hovering on a threshold never re-triggers.
 */
const EDGES = [0.24, 0.49, 0.6, 0.8, 0.9] // beat i ↔ i+1
const HYST = 0.012
let current = -1

function env(g: GainNode, t: number, peak: number, a: number, r: number) {
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(peak, t + a)
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + r)
}
function noise(ctx: AudioContext, sec: number) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate), d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const n = ctx.createBufferSource(); n.buffer = b; return n
}
function out(g: AudioNode) { g.connect(audio.master); g.connect(audio.reverb) }

const cues: (() => void)[] = [
  // 0 space: a slow, wide hum (detuned fifths), swells in and dissolves
  () => {
    const ctx = audio.ctx!, t = ctx.currentTime, g = ctx.createGain(), f = ctx.createBiquadFilter()
    f.type = 'lowpass'; f.frequency.value = 900
    ;[110, 110.7, 164.8, 220.4].forEach((hz) => { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = hz; o.connect(f); o.start(t); o.stop(t + 4.2) })
    f.connect(g); env(g, t, 0.035, 1.4, 2.6); out(g)
  },
  // 1 descent: a long airy whoosh falling in pitch
  () => audio.swell(false),
  // 2 forest landing: soft thud, leaf rustle, two little birds
  () => {
    const ctx = audio.ctx!, t = ctx.currentTime
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'
    o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18)
    env(g, t, 0.09, 0.008, 0.3); o.connect(g); g.connect(audio.master); o.start(t); o.stop(t + 0.4)
    const n = noise(ctx, 1.4), bp = ctx.createBiquadFilter(), ng = ctx.createGain()
    bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.8
    n.connect(bp); bp.connect(ng); env(ng, t + 0.05, 0.025, 0.25, 1.0); out(ng); n.start(t)
    ;[0.55, 0.78].forEach((d, i) => {
      const b = ctx.createOscillator(), bg = ctx.createGain(); b.type = 'sine'
      const s = t + d, base = i ? 3900 : 3400
      b.frequency.setValueAtTime(base, s); b.frequency.exponentialRampToValueAtTime(base * 1.35, s + 0.06); b.frequency.exponentialRampToValueAtTime(base * 0.9, s + 0.12)
      env(bg, s, 0.012, 0.01, 0.14); b.connect(bg); out(bg); b.start(s); b.stop(s + 0.2)
    })
  },
  // 3 reveal: a clean glassy shimmer (two partials, slow beat)
  () => {
    const ctx = audio.ctx!, t = ctx.currentTime
    ;[1318.5, 1975.5].forEach((hz, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = hz + i * 1.5
      env(g, t, 0.014, 0.02, 1.8); o.connect(g); out(g); o.start(t); o.stop(t + 2)
    })
  },
  // 4 break: the liquid rupture
  () => { audio.splash(); setTimeout(() => audio.bubble(0.8), 120) },
  // 5 out: a soft rising bloop
  () => audio.bubble(1.2),
]

/** Call every frame while the journey is on screen. Returns the beat index. */
export function journeyAudio(p: number) {
  let b = current < 0 ? EDGES.filter((e) => p >= e).length : current
  if (current >= 0) {
    while (b < EDGES.length && p > EDGES[b] + HYST) b++
    while (b > 0 && p < EDGES[b - 1] - HYST) b--
  }
  if (b !== current) {
    current = b
    if (audio.enabled && audio.ctx) cues[b]?.()
  }
  return current
}
export function resetJourneyAudio() { current = -1 }
