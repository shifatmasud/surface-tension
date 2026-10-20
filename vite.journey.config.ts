import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Dev harness for the Journey stage only. Builds to /tmp/journey-dist — never site/.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '/tmp/journey-dist',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: { input: { journey: resolve(__dirname, 'journey.html') } },
  },
})
