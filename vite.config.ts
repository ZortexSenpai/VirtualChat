import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'icon.svg',
        'favicon.ico',
        'apple-touch-icon-180x180.png',
        'pwa-64x64.png',
        'pwa-192x192.png',
        'pwa-512x512.png',
        'maskable-icon-512x512.png',
      ],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],
        navigateFallback: '/index.html',
        // Matrix homeserver requests are cross-origin and should always go to
        // the network; the SW only caches the app shell.
        navigateFallbackDenylist: [/^\/_matrix\//, /^\/api\//],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: 'VirtualChat',
        short_name: 'VirtualChat',
        description: 'Matrix chat client with a Discord-like interface',
        theme_color: '#0a0b14',
        background_color: '#0a0b14',
        display: 'standalone',
        orientation: 'any',
        scope: '/',
        start_url: '/',
        icons: [
          { src: 'pwa-64x64.png',            sizes: '64x64',   type: 'image/png' },
          { src: 'pwa-192x192.png',          sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png',          sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  optimizeDeps: {
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 1500,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
})
