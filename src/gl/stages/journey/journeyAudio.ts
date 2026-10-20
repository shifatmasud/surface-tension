import { audio } from '../../../services/audio'

/**
 * Journey cues, all synthesised and quiet: space hum → descent whoosh → forest air (thud, leaves, two birds)
 * → a glassy shimmer as the tablet reveals → two knocks on the glass (a crack each) → the glass shatters (thump,
 * crack, a bright burst, a long scatter of tinkling pieces) → a soft bloop as it floats free.
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
  // 4 break: the glass shatters
  () => shatterSound(),
  // 5 out: a soft rising bloop
  () => audio.bubble(1.2),
]

function pan(ctx: AudioContext, x: number): AudioNode {
  const pn = ctx.createStereoPanner ? ctx.createStereoPanner() : null
  if (!pn) return ctx.createGain()
  pn.pan.value = Math.max(-1, Math.min(1, x)); return pn
}
/** a knock on the glass: a dull body thud, a glassy tock, and the tick of a crack running (harder on the second) */
function knockSound(hard: boolean) {
  const ctx = audio.ctx!, t = ctx.currentTime
  const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'
  o.frequency.setValueAtTime(hard ? 150 : 130, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.14)
  env(g, t, hard ? 0.13 : 0.08, 0.004, 0.22); o.connect(g); g.connect(audio.master); o.start(t); o.stop(t + 0.3)
  const tock = ctx.createOscillator(), tg = ctx.createGain(); tock.type = 'triangle'; tock.frequency.value = hard ? 1180 : 1040
  env(tg, t, hard ? 0.03 : 0.02, 0.002, 0.09); tock.connect(tg); out(tg); tock.start(t); tock.stop(t + 0.12)
  const ticks = hard ? 7 : 3
  for (let i = 0; i < ticks; i++) {
    const s = t + 0.012 + i * (0.006 + Math.random() * 0.02), n = noise(ctx, 0.02), hp = ctx.createBiquadFilter(), ng = ctx.createGain()
    hp.type = 'highpass'; hp.frequency.value = 2500 + Math.random() * 3000
    n.connect(hp); hp.connect(ng); env(ng, s, (hard ? 0.05 : 0.03) * (1 - i / (ticks + 2)), 0.001, 0.012); out(ng); n.start(s)
  }
}
/** the shatter: a low thump, the crack, a bright noise burst, and a long scatter of small pieces ringing as they fall */
function shatterSound() {
  const ctx = audio.ctx!, t = ctx.currentTime
  const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'
  o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(34, t + 0.35)
  env(g, t, 0.16, 0.004, 0.5); o.connect(g); g.connect(audio.master); o.start(t); o.stop(t + 0.6)
  const crack = noise(ctx, 0.06), chp = ctx.createBiquadFilter(), cg = ctx.createGain()
  chp.type = 'highpass'; chp.frequency.value = 1800; crack.connect(chp); chp.connect(cg); env(cg, t, 0.16, 0.001, 0.05); out(cg); crack.start(t)
  const body = noise(ctx, 1.4), bp = ctx.createBiquadFilter(), bg = ctx.createGain()
  bp.type = 'bandpass'; bp.frequency.setValueAtTime(6500, t); bp.frequency.exponentialRampToValueAtTime(3200, t + 0.9); bp.Q.value = 0.7
  body.connect(bp); bp.connect(bg); env(bg, t + 0.005, 0.07, 0.006, 0.75); out(bg); body.start(t)
  for (let i = 0; i < 46; i++) {
    const s = t + 0.02 + 1.6 * Math.pow(Math.random(), 1.8), f0 = 2400 + Math.random() * 6200
    const pg = ctx.createGain(), pn = pan(ctx, (Math.random() - 0.5) * 1.6)
    const dec = 0.04 + Math.random() * 0.16, amp = (0.004 + Math.random() * 0.013) * (s - t < 0.3 ? 1.4 : 1)
    ;[1, 2.76, 5.4].forEach((m, j) => {
      const po = ctx.createOscillator(); po.type = 'sine'; po.frequency.value = f0 * m * (1 + (Math.random() - 0.5) * 0.02)
      if (po.frequency.value > 16000) return
      const og = ctx.createGain(); env(og, s, amp / (1 + j * 1.8), 0.0015, dec / (1 + j * 0.6)); po.connect(og); og.connect(pg); po.start(s); po.stop(s + dec + 0.05)
    })
    pg.connect(pn); out(pn)
  }
}

/** one-shot hits, forward only (scrolling back through them stays quiet) */
const HITS = [0.772, 0.788]
let lastP = -1

/** Call every frame while the journey is on screen. Returns the beat index. */
export function journeyAudio(p: number) {
  if (lastP >= 0 && p > lastP && p - lastP < 0.05 && audio.enabled && audio.ctx) {
    HITS.forEach((h, i) => { if (lastP < h && p >= h) knockSound(i === 1) })
  }
  lastP = p
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
export function resetJourneyAudio() { current = -1; lastP = -1 }
