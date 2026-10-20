import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import glsl from 'vite-plugin-glsl'


/** First paint: the stylesheet goes ahead of the JS module preloads (they contend for bandwidth on slow phones), and
 *  the Inter file is preloaded so the shell's text paints in the brand face sooner. */
const cssFirst = (): Plugin => ({
  name: 'css-first',
  enforce: 'post',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      const m = html.match(/\s*<link rel="stylesheet"[^>]*>/)
      if (m) { html = html.replace(m[0], ''); html = html.replace(/(\s*<script type="module")/, m[0] + '$1') }
      const font = ctx.bundle && Object.keys(ctx.bundle).find((k) => /inter-latin-wght-normal.*\.woff2$/.test(k))
      if (font) html = html.replace(/(<link rel="stylesheet"[^>]*>)/, `$1\n    <link rel="preload" as="font" type="font/woff2" crossorigin href="./${font}">`)
      return html
    },
  },
})


/** First paint, part 2: the JS graph (react + three + r3f + motion, ~1.5 MB) starts only after the static shell has painted,
 *  so a slow phone's first paint never waits on it (and Lighthouse's simulated FCP stops depending on chunk timing).
 *  The module preloads are injected at that same moment, so the chunks still download in parallel. */
const deferBoot = (): Plugin => ({
  name: 'defer-boot',
  enforce: 'post',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      if (!ctx.bundle) return html
      const entry = html.match(/\s*<script type="module" crossorigin src="([^"]+)"><\/script>/)
      if (!entry) return html
      const pre = [...html.matchAll(/\s*<link rel="modulepreload" crossorigin href="([^"]+)">/g)]
      html = html.replace(entry[0], '')
      for (const m of pre) html = html.replace(m[0], '')
      const loader = `<script>(function(){var d=document,E=${JSON.stringify(entry[1])},P=${JSON.stringify(pre.map((m) => m[1]))},done=0;` +
        `function go(){if(done)return;done=1;var h=d.head;P.forEach(function(u){var l=d.createElement('link');l.rel='modulepreload';l.crossOrigin='';l.href=u;h.appendChild(l)});` +
        `var s=d.createElement('script');s.type='module';s.crossOrigin='';s.src=E;h.appendChild(s)}` +
        `requestAnimationFrame(function(){setTimeout(go,0)});setTimeout(go,2500)})()</script>`
      return html.replace(/(\s*<\/body>)/, `\n    ${loader}$1`)
    },
  },
})

// Chapter 1: one shell, code-split vendor chunks (three/R3F, motion, app)
export default defineConfig({
  plugins: [cssFirst(), deferBoot(), react(), glsl({ include: ['**/*.glsl', '**/*.vert', '**/*.frag'], compress: false })],
  base: './',
  build: {
    outDir: 'site',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (/three-html-render/.test(id)) return 'html-in-canvas'
            if (/[\\/](three|three-stdlib|postprocessing)[\\/]/.test(id)) return 'three'
            if (/@react-three/.test(id)) return 'r3f'
            if (/gsap|lenis|framer-motion|motion-dom|motion-utils/.test(id)) return 'motion'
            if (/react|scheduler/.test(id)) return 'react'
          }
        },
      },
    },
  },
  server: { port: 5173, host: true },
})
