import { defineConfig } from 'vite';

export default defineConfig({
  // OpenLayers makes one large chunk; the site is a single page, so that is fine.
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 1500 },
});
