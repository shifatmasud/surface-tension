import { audio } from '../../../services/audio'
import * as K from '../../../services/soundKit'

/**
 * Journey cues, all synthesised, soft and quiet: space hum → descent swell → forest air (thud, leaves, two birds)
 * → a glassy shimmer as the tablet reveals → two soft taps on the glass → the glass shatters (locked, unchanged)
 * → a soft bloop as it floats free.
 * Beats come from scroll progress with hysteresis, so hovering on a threshold never re-triggers.
 */
const EDGES = [0.24, 0.49, 0.6, 0.8, 0.9] // beat i ↔ i+1
const HYST = 0.012
let current = -1

// W25 sound redesign: every voice lives in services/soundKit.ts (soft, calm, clean: rounded sines, 10–40 ms attacks,
// low-passed textures, nothing above ~6 kHz). The cues, their order, edges, hysteresis, HITS and rests are unchanged.
const bus = (): K.Bus => ({ ctx: audio.ctx!, master: audio.master, reverb: audio.reverb })
const cues: (() => void)[] = [
  () => K.jSpace(bus()),        // 0 space: a slow, wide, dark hum
  () => audio.swell(false),     // 1 descent: the soft falling swell
  () => K.jForest(bus()),       // 2 forest landing: felt thud, leaf breath, two low round birds
  () => K.jReveal(bus()),       // 3 reveal: the glassy shimmer, softer bloom
  () => shatterSound(),         // 4 break: the glass shatter. LOCKED by Shifat (11:40Z "No lock current glass sound"): untouched
  () => audio.bubble(1.2),      // 5 out: a soft rising bloop
]
const knockSound = (hard: boolean) => K.knock(bus(), hard) // soft wood + glass tap (was a thud, a tock and noise cracks)

/* ---- the glass shatter: LOCKED by Shifat (11:40Z). The R6.55 code below is byte-for-byte unchanged, and it keeps its own
   sound: it plays through the original bright 2.6 s room (audio.legacyReverb), not the new dark one ---- */
// R6.89: the shatter's voices go to audio.shatterBus (desktop: a unity gain into the master, so the same sound; phones: a
// lower peak, no sub, softer highs — Shifat "Glass shatter sounds clip distorted in my phone speaker"); nothing else changed
// R7.00 (Shifat 4:31 AM: "Glass shatter sound in our site causes performance drop & weird sound. Lusion.co does it better.";
// his ask overrides the shatter lock for its delivery only). lusion.co plays a 31 KB pre-recorded glass_broken.ogg through
// ONE buffer source (decoded up front). Ours built ~370 audio nodes (~140 oscillators with their gains and panners, two
// noise buffers) INSIDE the frame it fired on, and the phone's audio thread then had to run all ~140 voices plus the 2.6 s
// room at once: a main-thread hitch, and on a weak phone audio-thread underruns (crackle). Now the SAME synthesis (recipe
// unchanged below) renders once, offline, at idle after sound is switched on, into one stereo buffer (dry + its 0.32 room);
// the shatter plays it as one voice into the same shatter bus (phones keep their softer filter there). A retrigger fades the
// previous voice in 30 ms (no stacking); a peak over -1 dBFS is scaled down (no clipping). Until the render is ready (the
// first seconds after sound comes on) it falls back to the live synthesis. ?shatter=live = the old path.
type Dest = { dry: AudioNode; room: AudioNode }
function out(d: Dest, g: AudioNode) { g.connect(d.dry); g.connect(d.room) }
function env(g: GainNode, t: number, peak: number, a: number, r: number) {
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(peak, t + a)
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + r)
}
function noise(ctx: BaseAudioContext, sec: number) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate), d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const n = ctx.createBufferSource(); n.buffer = b; return n
}
function pan(ctx: BaseAudioContext, x: number): AudioNode {
  const pn = ctx.createStereoPanner ? ctx.createStereoPanner() : null
  if (!pn) return ctx.createGain()
  pn.pan.value = Math.max(-1, Math.min(1, x)); return pn
}
/** the shatter: a low thump, the crack, a bright noise burst, and a long scatter of small pieces ringing as they fall
 *  (the R6.55 recipe, values unchanged; only its destination is a parameter now) */
function synthShatter(ctx: BaseAudioContext, t: number, d: Dest) {
  const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'
  o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(34, t + 0.35)
  env(g, t, 0.16, 0.004, 0.5); o.connect(g); g.connect(d.dry); o.start(t); o.stop(t + 0.6)
  const crack = noise(ctx, 0.06), chp = ctx.createBiquadFilter(), cg = ctx.createGain()
  chp.type = 'highpass'; chp.frequency.value = 1800; crack.connect(chp); chp.connect(cg); env(cg, t, 0.16, 0.001, 0.05); out(d, cg); crack.start(t)
  const body = noise(ctx, 1.4), bp = ctx.createBiquadFilter(), bg = ctx.createGain()
  bp.type = 'bandpass'; bp.frequency.setValueAtTime(6500, t); bp.frequency.exponentialRampToValueAtTime(3200, t + 0.9); bp.Q.value = 0.7
  body.connect(bp); bp.connect(bg); env(bg, t + 0.005, 0.07, 0.006, 0.75); out(d, bg); body.start(t)
  for (let i = 0; i < 46; i++) {
    const s = t + 0.02 + 1.6 * Math.pow(Math.random(), 1.8), f0 = 2400 + Math.random() * 6200
    const pg = ctx.createGain(), pn = pan(ctx, (Math.random() - 0.5) * 1.6)
    const dec = 0.04 + Math.random() * 0.16, amp = (0.004 + Math.random() * 0.013) * (s - t < 0.3 ? 1.4 : 1)
    ;[1, 2.76, 5.4].forEach((m, j) => {
      const po = ctx.createOscillator(); po.type = 'sine'; po.frequency.value = f0 * m * (1 + (Math.random() - 0.5) * 0.02)
      if (po.frequency.value > 16000) return
      const og = ctx.createGain(); env(og, s, amp / (1 + j * 1.8), 0.0015, dec / (1 + j * 0.6)); po.connect(og); og.connect(pg); po.start(s); po.stop(s + dec + 0.05)
    })
    pg.connect(pn); out(d, pn)
  }
}
const LIVE = typeof location !== 'undefined' && /[?&]shatter=live/.test(location.search)
const pre: { buf: AudioBuffer | null; busy: boolean; voice: AudioBufferSourceNode | null; vg: GainNode | null; ms: number; peak: number } = { buf: null, busy: false, voice: null, vg: null, ms: 0, peak: 0 }
/** render the shatter once, offline (its audio runs off the main and audio threads' hot path), at idle once the room exists */
function prerenderShatter() {
  if (LIVE || pre.buf || pre.busy || !audio.ctx || typeof OfflineAudioContext === 'undefined') return
  const ir = (audio as any).legacy?.buffer as AudioBuffer | undefined
  if (!ir) { audio.prepareLegacy(); return }          // the room's impulse is still being filled in idle chunks: try again later
  pre.busy = true
  const W = window as any, run = () => {
    try {
      const sr = audio.ctx!.sampleRate, oc = new OfflineAudioContext(2, Math.ceil(sr * 4.4), sr)
      const room = oc.createConvolver(); room.buffer = ir
      const wet = oc.createGain(); wet.gain.value = 0.32; room.connect(wet); wet.connect(oc.destination)
      synthShatter(oc, 0, { dry: oc.destination, room })
      oc.startRendering().then((b) => {
        let pk = 0
        for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > pk) pk = a } }
        pre.peak = pk
        if (pk > 0.89) { const k = 0.89 / pk; for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k } }
        pre.buf = b; pre.busy = false
      }, () => { pre.busy = false })
    } catch { pre.busy = false }
  }
  if (W.requestIdleCallback) W.requestIdleCallback(run, { timeout: 1500 }); else setTimeout(run, 50)
}
function shatterSound() {
  const ctx = audio.ctx!, t = ctx.currentTime, t0 = performance.now()
  if (pre.buf) {
    if (pre.voice && pre.vg) { const v = pre.voice; pre.vg.gain.setTargetAtTime(0, t, 0.01); try { v.stop(t + 0.06) } catch { /* ended */ } }
    const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = pre.buf; s.connect(g); g.connect(audio.shatterBus); s.start(t)
    pre.voice = s; pre.vg = g; s.onended = () => { if (pre.voice === s) { pre.voice = null; pre.vg = null } }
  } else {
    synthShatter(ctx, t, { dry: audio.shatterBus, room: audio.legacyReverb })
    prerenderShatter()
  }
  pre.ms = performance.now() - t0
}


/** one-shot hits, forward only (scrolling back through them stays quiet) */
const HITS = [0.772, 0.788]
let lastP = -1
const lastCue: number[] = []

/** Call every frame while the journey is on screen. Returns the beat index. */
export function journeyAudio(p: number) {
  if (!pre.buf && !pre.busy && audio.enabled && audio.ctx && !LIVE) prerenderShatter()
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
    // W25 R6.55 (sound audit #9): scrubbing fast back and forth over a beat edge re-fired its cue every crossing, stacking
    // copies (the shatter alone is ~140 oscillators); a cue now rests 1.5 s (the shatter 4 s) before it can play again
    const now = performance.now(), rest = b === 4 ? 4000 : 1500
    if (audio.enabled && audio.ctx && now - (lastCue[b] ?? -1e9) > rest) { lastCue[b] = now; cues[b]?.() }
  }
  return current
}
export function resetJourneyAudio() { current = -1; lastP = -1 }

/** R6.89 test hook (?audiotest only): the journey's real cues, for the offline render in services/audio.ts */
if (typeof window !== 'undefined' && /[?&]audiotest/.test(location.search)) {
  ;(window as any).__jaTest = { pre, prerender: () => prerenderShatter(), shatter: () => shatterSound(), knock: (h: boolean) => knockSound(h), reveal: () => K.jReveal(bus()), forest: () => K.jForest(bus()), splash: () => audio.splash(), swell: () => audio.swell(true) }
}
