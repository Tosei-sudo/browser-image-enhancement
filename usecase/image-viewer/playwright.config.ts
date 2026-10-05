import { defineConfig } from '@playwright/test';

// Use a preinstalled Chromium when one is provided (CI images, sandboxes).
const executablePath = process.env.CHROMIUM_PATH;

export default defineConfig({
  testDir: 'test',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4175',
    // The first-visit guide stays away, so it covers no part of the map the tests click (shell.spec.ts shows it).
    storageState: { cookies: [], origins: [{ origin: 'http://localhost:4175', localStorage: [{ name: 'image-viewer.guide-seen', value: '1' }] }] },
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'node test/server.mjs',
    url: 'http://localhost:4175/index.html',
    reuseExistingServer: !process.env.CI,
  },
});
