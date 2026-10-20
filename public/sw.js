/* Surface Tension service worker (PRELOAD, Shifat 10:06Z): repeat visits start from cache.
 * - pages: network first (a new deploy is always picked up), cache as the offline fallback
 * - /assets/* (content-hashed, never change): cache first
 * - /media/*, /brand/*: served from cache, refreshed in the background
 * - video and range requests: straight to the network (streamed) */
const V = 'st-v1'
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
    e.respondWith(fetch(r).then((res) => { const c = res.clone(); caches.open(V).then((ca) => ca.put(r, c)); return res }).catch(() => caches.match(r).then((m) => m || Response.error())))
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
