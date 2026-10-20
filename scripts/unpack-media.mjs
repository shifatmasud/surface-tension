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
    // 'brand__icon.png.b64' -> public/brand/icon.png, 'root__og.png.b64' -> public/og.png, plain names -> public/media
    const name = f.slice(0, -4), parts = name.split('__')
    const dir = parts.length > 1 ? (parts[0] === 'root' ? 'public' : join('public', parts[0])) : out
    mkdirSync(dir, { recursive: true })
    const target = join(dir, parts[parts.length - 1])
    if (existsSync(target)) continue
    writeFileSync(target, Buffer.from(readFileSync(join(src, f), 'utf8'), 'base64')); n++
  }
  console.log(`[unpack-media] wrote ${n} file(s) to ${out}`)
}
