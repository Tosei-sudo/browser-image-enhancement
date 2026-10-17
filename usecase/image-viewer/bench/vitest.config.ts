import { defineConfig } from 'vitest/config';

// Timings of the heavy pixel loops on 12-megapixel inputs (npm run bench); not run by npm test.
export default defineConfig({ test: { include: ['bench/**/*.bench.test.ts'], testTimeout: 600_000 } });
