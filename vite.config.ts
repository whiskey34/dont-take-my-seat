import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative paths so the same build works on GitHub Pages, inside the
  // messenger WebView and inside the Capacitor APK.
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
