// Experts Phase 2A: the expert site's OWN build (experts.usepassthrough.com). Its own entry (experts.html), its own output folder (dist-experts),
// its own Pages project. It shares the component library and nothing else with the main site's bundle, and it never reads VITE_API_URL: the
// browser calls /api on the expert site's own host (a Worker route sends that path to the API), which is what keeps its cookie first-party.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { existsSync, renameSync } from 'node:fs'

// A11: Cloudflare Pages documents `/* /index.html 200` as the single-page fallback; a rewrite to any other file name is not covered. So the
// built page is written as index.html (the entry file keeps its name in the source tree). In dev the same page answers every route that is not
// a file or the API.
const expertsPage = () => ({
  name: 'experts-page',
  closeBundle() {
    const from = resolve(__dirname, 'dist-experts/experts.html'), to = resolve(__dirname, 'dist-experts/index.html')
    if (existsSync(from)) renameSync(from, to)
  },
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const path = (req.url || '').split('?')[0]
      if (req.method === 'GET' && !path.startsWith('/api') && !path.startsWith('/@') && !path.startsWith('/src/') && !path.startsWith('/node_modules/') && !/\.[a-z0-9]+$/i.test(path)) req.url = '/experts.html'
      next()
    })
  },
})

export default defineConfig({
  plugins: [react(), expertsPage()],
  publicDir: 'public-experts',      // its own _headers and _redirects; none of the main site's files (icons, sitemap, manifest) are copied
  build: { outDir: 'dist-experts', emptyOutDir: true, rollupOptions: { input: resolve(__dirname, 'experts.html') } },
  // The API only answers a request whose Host is the expert site's host AND whose Origin is that site's origin (the CSRF check). The page is served at
  // localhost:3100, so the proxy states both; without the Origin line every sign-in is refused. Set EXPERT_SITE_URL=http://experts.localhost for local use.
  server: { port: 3100, proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false, headers: { host: 'experts.localhost', origin: 'http://experts.localhost' } } } },
})
