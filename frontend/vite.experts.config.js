// Experts Phase 2A: the expert site's OWN build (experts.usepassthrough.com). Its own entry (experts.html), its own output folder (dist-experts),
// its own Pages project. It shares the component library and nothing else with the main site's bundle, and it never reads VITE_API_URL: the
// browser calls /api on the expert site's own host (a Worker route sends that path to the API), which is what keeps its cookie first-party.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  publicDir: 'public-experts',      // its own _headers and _redirects; none of the main site's files (icons, sitemap, manifest) are copied
  build: { outDir: 'dist-experts', emptyOutDir: true, rollupOptions: { input: resolve(__dirname, 'experts.html') } },
  server: { port: 3100, proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false, headers: { host: 'experts.localhost' } } } },
})
