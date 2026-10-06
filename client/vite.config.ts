import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// The client talks to the API on the same origin. In dev, Vite proxies /api and /socket.io
// to the Express server (override with VITE_PROXY_TARGET). In production Express serves the build.
const target = process.env.VITE_PROXY_TARGET || 'http://localhost:4000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: true },
      '/socket.io': { target, ws: true, changeOrigin: true }
    }
  },
  build: {
    chunkSizeWarningLimit: 4000
  }
})
