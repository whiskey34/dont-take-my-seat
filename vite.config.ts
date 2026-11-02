import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative paths so the same build works on GitHub Pages, inside the
  // messenger WebView and inside the Capacitor APK.
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
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
