import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative paths so the same build works on GitHub Pages, inside the
  // messenger WebView and when installed as a web app.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? 'dev'),
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        game: 'index.html',
        // Demo chat that uses the messenger SDK (published next to the game).
        chatDemo: 'messenger-sdk/demo/index.html',
      },
    },
  },
  plugins: [
    VitePWA({
      // The app decides when to apply an update (never in the middle of a game).
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: './',
        name: "Don't Take My Seat",
        short_name: 'My Seat',
        description: 'Musical chairs on the commuter train. Rebutan kursi di kereta komuter.',
        start_url: './',
        scope: './',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'landscape',
        background_color: '#17232f',
        theme_color: '#17232f',
        categories: ['games'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // Everything the game needs offline: code, styles, fonts, icons, both pages.
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest}'],
        // Links carry options (?embed=messenger, ?signal=local, ?room=...); serve the cached page for any of them.
        ignoreURLParametersMatching: [/.*/],
        navigateFallback: null,
        cleanupOutdatedCaches: true,
        // Take over the first visit right away so it is ready for offline play.
        // Updates still wait (no skipWaiting) until the game applies them from the menu.
        clientsClaim: true,
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    // Whole-game simulations take ~2 s; leave room for slow CI machines.
    testTimeout: 20_000,
  },
});
