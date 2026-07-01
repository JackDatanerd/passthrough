import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // Dev only: Vite proxy routes /api to the Worker running via `wrangler dev`
      // In production (Cloudflare Pages): VITE_API_URL points directly to the deployed Worker
      '/api': { target: 'http://localhost:4000', changeOrigin: true }
    }
  }
})
