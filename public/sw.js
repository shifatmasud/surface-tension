/* Surface Tension service worker (PRELOAD, Shifat 10:06Z): repeat visits start from cache.
 * - pages: network first (a new deploy is always picked up), cache as the offline fallback
 * - /assets/* (content-hashed, never change): cache first
 * - /media/*, /brand/*: served from cache, refreshed in the background
 * - video and range requests: straight to the network (streamed) */
const V = 'st-v1'
/* ENG #15 (eviction): /assets/* are content-hashed, so every release used to ADD its bundles (~600 KB br) to the cache
 * and nothing ever left. On every page load that brings a new entry bundle, the cache keeps only the /assets/ files the
 * current release still reaches: index.html → its entry JS/CSS → every chunk/font those cached files name (walked
 * transitively through what is already cached; nothing extra is fetched). Anything unreachable is a previous release
 * and is deleted. If the walk can't read the entry, nothing is pruned. */
let prunedFor = ''
// every file name a page or a chunk mentions ("assets/Scene-x.js", "./Stage-y.js", url(Inter-z.woff2)), keyed by name
const ASSET = /[\w.\-]+\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|avif|svg|ktx2|glb|gltf|bin|hdr|exr|wasm|json|mp3|ogg|m4a|wav)\b/g
async function prune(html) {
  const entry = ((html.match(/assets\/(index-[\w\-]+\.js)/) || [])[1]) || ''
  if (!entry || entry === prunedFor) return
  const ca = await caches.open(V)
  const keys = await ca.keys()
  const byName = new Map()
  for (const k of keys) { const p = new URL(k.url).pathname; const i = p.indexOf('/assets/'); if (i >= 0) byName.set(p.slice(i + 8), k) }
  const keep = new Set(), queue = []
  const take = (text) => { for (const m of text.matchAll(ASSET)) if (!keep.has(m[0])) { keep.add(m[0]); queue.push(m[0]) } }
  take(html)
  let readEntry = false
  while (queue.length) {
    const n = queue.shift()
    if (!/\.(js|css)$/.test(n)) continue
    let res = byName.has(n) ? await ca.match(byName.get(n)) : null
    if (!res && n === entry) res = await fetch(new URL('assets/' + n, self.registration.scope)).catch(() => null)   // the entry is needed to walk the chunks
    if (!res || !res.ok) continue
    if (n === entry) readEntry = true
    take(await res.text())
  }
  if (!readEntry) return
  for (const [n, k] of byName) if (!keep.has(n)) await ca.delete(k)
  prunedFor = entry
}
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== V) await caches.delete(k)
  await self.clients.claim()
})()))
self.addEventListener('fetch', (e) => {
  const r = e.request
  if (r.method !== 'GET' || r.headers.has('range')) return
  const u = new URL(r.url)
  if (u.origin !== location.origin || /\.(mp4|webm|mov)$/.test(u.pathname)) return
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then((res) => {
      const c = res.clone(); caches.open(V).then((ca) => ca.put(r, c))
      if (res.ok) { const t = res.clone(); e.waitUntil(t.text().then(prune).catch(() => {})) }   // A11Y lane (eng #15)
      return res
    }).catch(() => caches.match(r).then((m) => m || Response.error())))
    return
  }
  if (u.pathname.includes('/assets/')) {
    e.respondWith(caches.open(V).then(async (ca) => {
      const hit = await ca.match(r); if (hit) return hit
      const res = await fetch(r); if (res.ok) ca.put(r, res.clone()); return res
    }))
    return
  }
  if (/\/(media|brand)\//.test(u.pathname)) {
    e.respondWith(caches.open(V).then(async (ca) => {
      const hit = await ca.match(r)
      const net = fetch(r).then((res) => { if (res.ok) ca.put(r, res.clone()); return res }).catch(() => hit)
      return hit || net
    }))
  }
})
