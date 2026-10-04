import { defineConfig } from 'vite';

export default defineConfig({
  // OpenLayers makes one large chunk; the site is a single page, so that is fine.
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 1500 },
  // SQLite (GeoPackages) finds its .wasm next to its own module, which pre-bundling would move.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
});
