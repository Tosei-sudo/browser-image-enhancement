import { defineConfig } from '@playwright/test';

// Use a preinstalled Chromium when one is provided (CI images, sandboxes).
const executablePath = process.env.CHROMIUM_PATH;

export default defineConfig({
  testDir: 'test',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4175',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'node test/server.mjs',
    url: 'http://localhost:4175/index.html',
    reuseExistingServer: !process.env.CI,
  },
});
