import { props } from '../state/props'
/**
 * Layer 3 — QuickLoader + TaskManager (handbook ch.9), written fresh.
 * One loader with typed items registered by extension; weighted progress; a cross-origin map;
 * GPU warm-up (shader compiles, texture uploads) counted as loading tasks so the intro only
 * ends when the GPU is actually warm.
 */
export abstract class LoadItem<T = unknown> {
  static type = 'any'
  static extensions: string[] = []
  weight = 1; loadedWeight = 0; content: T | null = null; crossOrigin?: string
  constructor(public url: string, opts: { weight?: number; crossOrigin?: string } = {}) {
    if (opts.weight) this.weight = opts.weight
    this.crossOrigin = opts.crossOrigin
  }
  abstract load(): Promise<T>
}
class ImageItem extends LoadItem<HTMLImageElement> {
  static type = 'image'; static extensions = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'svg', 'gif']
  load() {
    return new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image()
      if (this.crossOrigin) img.crossOrigin = this.crossOrigin
      img.decoding = 'async'
      img.onload = () => { this.loadedWeight = this.weight; this.content = img; res(img) }
      img.onerror = rej
      img.src = this.url
    })
  }
}
class VideoItem extends LoadItem<HTMLVideoElement> {
  static type = 'video'; static extensions = ['mp4', 'webm']
  load() {
    return new Promise<HTMLVideoElement>((res) => {
      const v = document.createElement('video')
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto'
      if (this.crossOrigin) v.crossOrigin = this.crossOrigin
      const done = () => { this.loadedWeight = this.weight; this.content = v; res(v) }
      v.addEventListener('loadeddata', done, { once: true })
      v.addEventListener('error', done, { once: true })
      setTimeout(done, 6000) // never block the intro on a slow video
      v.src = this.url
      v.load()
    })
  }
}
class FontItem extends LoadItem<FontFace[]> {
  static type = 'font'; static extensions = ['woff2', 'woff']
  family = 'Inter'; descriptors: FontFaceDescriptors = {}
  async load() {
    const f = new FontFace(this.family, `url(${this.url})`, this.descriptors)
    await f.load(); document.fonts.add(f)
    this.loadedWeight = this.weight; this.content = [f]
    return this.content
  }
}

type ItemCtor = { new (url: string, o?: any): LoadItem; type: string; extensions: string[] }

class QuickLoader {
  private registry = new Map<string, ItemCtor>()
  private items: LoadItem[] = []
  private urls = new Map<string, LoadItem>()
  crossOriginMap: Record<string, string> = {}
  totalWeight = 0
  constructor() { [ImageItem, VideoItem, FontItem].forEach((c) => this.register(c as unknown as ItemCtor)) }
  register(c: ItemCtor) { this.registry.set(c.type, c) }
  private typeFor(url: string) {
    const ext = url.split('?')[0].split('.').pop()!.toLowerCase()
    for (const c of this.registry.values()) if (c.extensions.includes(ext)) return c
    return this.registry.get('image')!
  }
  add<T = unknown>(url: string, opts: { type?: string; weight?: number } = {}): LoadItem<T> {
    const dup = this.urls.get(url); if (dup) return dup as LoadItem<T>
    const C = opts.type ? this.registry.get(opts.type)! : this.typeFor(url)
    const origin = Object.keys(this.crossOriginMap).find((o) => url.startsWith(o))
    const item = new C(url, { weight: opts.weight, crossOrigin: origin ? this.crossOriginMap[origin] : undefined })
    this.items.push(item); this.urls.set(url, item); this.totalWeight += item.weight
    return item as LoadItem<T>
  }
  get progress() {
    if (!this.totalWeight) return 1
    let w = 0; for (const i of this.items) w += i.loadedWeight
    return w / this.totalWeight
  }
  get(url: string) { return this.urls.get(url)?.content }
  start() { return Promise.allSettled(this.items.map((i) => (i.loadedWeight ? Promise.resolve(i.content) : i.load()))) }
}
export const loader = new QuickLoader()

/** TaskManager: GPU work spread over frames (one task per frame), counted toward the preloader. */
class TaskManager {
  private queue: (() => void)[] = []
  total = 0; done = 0
  add(fn: () => void) { this.queue.push(fn); this.total++ }
  /** PRELOAD: an async GPU task (parallel shader compile): it starts in its frame slot and counts as done when it
   *  resolves. DIAG: it may report partial progress (0..1) while it runs, so a long warm-up moves the counter in steps */
  private part = new Map<number, number>()
  private seq = 0
  addAsync(fn: (report: (f: number) => void) => Promise<unknown>) {
    this.total++
    const id = ++this.seq
    const report = (f: number) => { if (this.part.has(id)) this.part.set(id, Math.min(0.999, Math.max(this.part.get(id)!, f))) }
    this.queue.push(() => {
      this.done--; this.part.set(id, 0)
      let p: Promise<unknown>
      try { p = fn(report) } catch (e) { p = Promise.resolve(); console.warn(e) }
      p.catch((e) => console.warn(e)).finally(() => { this.part.delete(id); this.done++ })
    })
  }
  update() {
    const t0 = performance.now()
    // run tasks until ~6ms of the frame is used — keeps the intro animation smooth
    while (this.queue.length && performance.now() - t0 < 6) { const f = this.queue.shift()!; try { f() } catch (e) { console.warn(e) } this.done++ }
  }
  get progress() {
    if (!this.total) return 1
    let p = 0; for (const v of this.part.values()) p += v
    return Math.min(1, (this.done + p) / this.total)
  }
  get idle() { return this.queue.length === 0 }
}
export const taskManager = new TaskManager()
void props
