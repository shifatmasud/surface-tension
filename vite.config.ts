import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import glsl from 'vite-plugin-glsl'
import logoInline from './scripts/logoInline.mjs' // logo3d hook (helper 99499b45): inline 3D preloader logo


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
      // PRELOAD: the hero scene chunk (a dynamic import) is fetched in the same parallel batch as the vendors instead
      // of after React mounts (one round trip saved), and every boot chunk is weighed by its size so the counter
      // shows real byte progress from the first frame (the shell counter, before React exists)
      const P = pre.map((m) => m[1])
      const bundle = ctx.bundle as Record<string, any>
      const sceneChunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && (c.name === 'Scene' || /^assets\/Scene-[\w-]+\.js$/.test(c.fileName) || (c.facadeModuleId && /[\\/]gl[\\/]Scene\.tsx$/.test(c.facadeModuleId))))
      const S: string[] = [] // GL-only boot chunks: skipped on the static (no-gl) page
      if (sceneChunk) for (const f of [...(sceneChunk.imports || []), sceneChunk.fileName]) { const u = './' + f; if (!P.includes(u) && u !== entry[1]) S.push(u) }
      const size = (u: string) => { const c = bundle[u.replace(/^\.\//, '')]; return c ? (c.code ? c.code.length : (c.source?.length || 1)) : 1 }
      const B: Record<string, number> = {}; for (const u of [entry[1], ...P, ...S]) B[u] = size(u)
      const loader = `<script>(function(){var d=document,E=${JSON.stringify(entry[1])},P=${JSON.stringify(P)},S=${JSON.stringify(S)},B=${JSON.stringify(B)},done=0,got={},T=0,M={},k;` +
        `if(d.documentElement.classList.contains('no-gl'))S.forEach(function(u){delete B[u]});else P=P.concat(S);` +
        `for(k in B){T+=B[k];M[new URL(k,location.href).href]=k}` +
        `var W=window.__stboot={t0:performance.now(),shown:0,files:function(){var s=0;for(var k in got)s+=B[k];return T?s/T:1}};` +
        `try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){var k=M[e.name];if(k)got[k]=1})}).observe({type:'resource',buffered:true})}catch(e){}` +
        `var cur=0;function tick(){var el=d.querySelector('.shell-intro .intro__count');if(!el)return;var t=W.files()*60;cur+=(t-cur)*0.12;var v=Math.floor(cur);if(v/100>W.shown){W.shown=v/100;el.textContent=('00'+v).slice(-3)}requestAnimationFrame(tick)}` +
        `function go(){if(done)return;done=1;var h=d.head;P.forEach(function(u){var l=d.createElement('link');l.rel='modulepreload';l.crossOrigin='';l.fetchPriority='high';l.href=u;h.appendChild(l)});` +
        `var s=d.createElement('script');s.type='module';s.crossOrigin='';s.fetchPriority='high';s.src=E;h.appendChild(s);requestAnimationFrame(tick)}` +
        `requestAnimationFrame(function(){setTimeout(go,0)});setTimeout(go,2500)})()</script>`
      return html.replace(/(\s*<\/body>)/, `\n    ${loader}$1`)
    },
  },
})

// Chapter 1: one shell, code-split vendor chunks (three/R3F, motion, app)
export default defineConfig({
  plugins: [logoInline(), cssFirst(), deferBoot(), react(), glsl({ include: ['**/*.glsl', '**/*.vert', '**/*.frag'], compress: false })],
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
