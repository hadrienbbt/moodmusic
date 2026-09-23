import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development the browser talks to the Vite dev server only: /api and
// /auth are proxied to the Express server, so everything is same-origin and
// the Spotify redirect URI is http://127.0.0.1:5173/auth/callback. Spotify
// refuses "localhost", hence the explicit 127.0.0.1 host and fixed port.
// shared/ (the mood table used by the server too) sits outside app/, so it
// gets an alias and the dev server may read from the repository root.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8004',
      '/auth': 'http://127.0.0.1:8004',
    },
    fs: {
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
  },
  build: {
    outDir: 'dist',
  },
})
