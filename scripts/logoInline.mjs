// Inline the preloader's 3D logo (src/preloader/boot.ts) into index.html. Helper 99499b45 (logo3d).
// Build: bundled + minified by esbuild into one classic <script> right after #root (no request, runs during parse).
// Dev: a module script pointing at the TS source.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../src/preloader/boot.ts', import.meta.url))

export default function logoInline() {
  return {
    name: 'logo3d-inline',
    transformIndexHtml: {
      order: 'pre',
      async handler(html, ctx) {
        let tag
        if (!ctx.bundle && ctx.server) tag = '<script type="module" src="/src/preloader/boot.ts"></script>'
        else {
          const r = await build({ entryPoints: [entry], bundle: true, minify: true, format: 'iife', target: 'es2019', write: false, legalComments: 'none' })
          tag = '<script>' + r.outputFiles[0].text.trim().replace(/<\/script/gi, '<\\/script') + '</script>'
        }
        const at = html.indexOf('<noscript>')
        return at >= 0 ? html.slice(0, at) + tag + '\n    ' + html.slice(at) : html.replace('</body>', tag + '\n</body>')
      },
    },
  }
}
