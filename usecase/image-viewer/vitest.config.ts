import { defineConfig } from 'vitest/config';

// Unit tests only; test/*.spec.ts are the Playwright browser tests.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
