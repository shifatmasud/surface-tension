import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import glsl from 'vite-plugin-glsl'

// Chapter 1: one shell, code-split vendor chunks (three/R3F, motion, app)
export default defineConfig({
  plugins: [react(), glsl({ include: ['**/*.glsl', '**/*.vert', '**/*.frag'], compress: false })],
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
