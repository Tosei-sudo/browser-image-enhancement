/**
 * Builds the self-contained files served by CDNs (jsDelivr, unpkg), mgrs included:
 *
 *   dist/cdn/coordinate-notation.min.js       ES module
 *   dist/cdn/coordinate-notation.iife.min.js  <script> tag, global `CoordinateNotation`
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('../dist/cdn', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
    lib: {
      entry: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      name: 'CoordinateNotation',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'coordinate-notation.min.js' : 'coordinate-notation.iife.min.js'),
    },
    // Lib mode leaves ES output unminified by default.
    rolldownOptions: { output: { minify: true } },
  },
});
