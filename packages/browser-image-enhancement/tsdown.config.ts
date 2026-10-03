/**
 * Builds the npm entry (dist/index.js and friends) with the same file layout as the
 * sources, so `new URL('./worker.js', import.meta.url)` still finds dist/worker/worker.js.
 * The internal @browser-image/workers package is compiled in, types included,
 * because it is not published.
 */
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/openlayers/index.ts', 'src/worker/worker.ts'],
  // OpenLayers is a peer dependency of the `openlayers` entry, never bundled.
  external: [/^ol(\/|$)/],
  outDir: 'dist',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  unbundle: true,
  sourcemap: true,
  dts: { sourcemap: true, tsconfig: 'tsconfig.build.json' },
  tsconfig: 'tsconfig.build.json',
  noExternal: [/^@browser-image\//],
  clean: ['dist/*', '!dist/cdn'],
  fixedExtension: false,
});
