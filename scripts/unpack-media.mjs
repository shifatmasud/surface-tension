// The repo is pushed through a text-only door, so the binary media (reels, posters, textures, depth maps) live in
// media-src/*.b64 as base64 text. Before a build this writes them back to public/media (skips files already there).
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const src = 'media-src', out = join('public', 'media')
if (existsSync(src)) {
  mkdirSync(out, { recursive: true })
  let n = 0
  for (const f of readdirSync(src)) {
    if (!f.endsWith('.b64')) continue
    const target = join(out, f.slice(0, -4))
    if (existsSync(target)) continue
    writeFileSync(target, Buffer.from(readFileSync(join(src, f), 'utf8'), 'base64')); n++
  }
  console.log(`[unpack-media] wrote ${n} file(s) to ${out}`)
}
