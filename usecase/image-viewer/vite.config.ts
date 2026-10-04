import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/** Short hash of the commit being built, or '' outside a git checkout. */
function commit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const library = JSON.parse(
  readFileSync(new URL('../../packages/browser-image-enhancement/package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  // Shown at the bottom of the side panel (src/build-info.ts).
  define: {
    __BUILD_INFO__: JSON.stringify({
      version: library.version,
      commit: commit(),
      // Set by GitHub Actions: the number of the workflow run that built the site.
      run: process.env.GITHUB_RUN_NUMBER ?? '',
      date: new Date().toISOString(),
    }),
  },
  // OpenLayers makes one large chunk; the site is a single page, so that is fine.
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 1500 },
});
