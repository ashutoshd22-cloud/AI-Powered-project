/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const apiTarget = process.env.LIFEOS_API_URL ?? 'http://127.0.0.1:8000'

// When the API is down, answer 502 (like a production reverse proxy) so the app treats it as offline.
const apiProxy = {
  '/api': {
    target: apiTarget,
    changeOrigin: false,
    configure(proxy: { on: (event: 'error', cb: (err: Error, req: unknown, res: unknown) => void) => void }) {
      proxy.on('error', (_err, _req, res) => {
        const r = res as { headersSent?: boolean; writeHead?: (s: number, h: Record<string, string>) => void; end: (b?: string) => void }
        if (r.writeHead && !r.headersSent) r.writeHead(502, { 'Content-Type': 'application/json' })
        r.end('{"detail":"API unavailable"}')
      })
    },
  },
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'LifeOS',
        short_name: 'LifeOS',
        description: 'Your personal AI operating system for tasks, plans and goals.',
        theme_color: '#0f766e',
        background_color: '#f7f6f3',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // App shell is precached; API responses are never cached by the service worker
        // (tasks live in IndexedDB and are synchronised explicitly).
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react'
          if (id.includes('node_modules/@tanstack') || id.includes('node_modules/react-router')) return 'vendor'
          return undefined
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'], exclude: ['src/test/**', 'src/main.tsx'] },
  },
})
