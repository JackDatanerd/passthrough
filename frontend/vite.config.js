import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import seoPlugin from './seo/vitePlugin.js'

export default defineConfig({
  // seoPlugin writes sitemap.xml and one <head>-per-page copy of index.html into dist/ (see frontend/seo/vitePlugin.js).
  plugins: [react(), seoPlugin()],
  server: {
    port: 3000,
    proxy: {
      // Dev only: Vite proxy routes /api to the Worker running via `wrangler dev`
      // In production (Cloudflare Pages): VITE_API_URL points directly to the deployed Worker
      '/api': { target: 'http://localhost:4000', changeOrigin: true }
    }
  }
})
