// Inverse of unpack-media: writes public/media/* as base64 text into media-src/ for the text-only repo push.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
mkdirSync('media-src', { recursive: true })
for (const f of readdirSync(join('public', 'media'))) writeFileSync(join('media-src', f + '.b64'), readFileSync(join('public', 'media', f)).toString('base64'))
