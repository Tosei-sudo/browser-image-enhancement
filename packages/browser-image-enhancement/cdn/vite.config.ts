/**
 * Builds the self-contained files served by CDNs (jsDelivr, unpkg):
 *
 *   dist/cdn/browser-image-enhancement.min.js       ES module
 *   dist/cdn/browser-image-enhancement.iife.min.js  <script> tag, global `BrowserImageEnhancement`
 *
 * The worker is inlined (see default-worker.inline.ts), so each file works on its own
 * from any origin. The npm entry (dist/index.js, built by tsc) is unchanged.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const outDir = fileURLToPath(new URL('../dist/cdn', import.meta.url));
const inlineWorker = fileURLToPath(new URL('./default-worker.inline.ts', import.meta.url));

/** Swaps the file-based default worker for the inlined one. */
function useInlineWorker(): Plugin {
  return {
    name: 'bie-inline-worker',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './default-worker.js' && importer?.includes('/src/worker/')) return inlineWorker;
      return null;
    },
    // The worker is inlined as a string, so its own source map would be an orphan file.
    closeBundle() {
      rmSync(join(outDir, 'assets'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [useInlineWorker()],
  worker: { format: 'iife' },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
    lib: {
      entry: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      name: 'BrowserImageEnhancement',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'browser-image-enhancement.min.js' : 'browser-image-enhancement.iife.min.js'),
    },
    // Lib mode leaves ES output unminified by default.
    rolldownOptions: { output: { minify: true } },
  },
});
