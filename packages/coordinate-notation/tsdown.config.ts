/** Builds the npm entry (dist/index.js); mgrs stays an external dependency. */
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  dts: { sourcemap: true },
  clean: ['dist/*', '!dist/cdn'],
  fixedExtension: false,
});
