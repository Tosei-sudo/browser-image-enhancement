import { defineConfig } from '@playwright/test';

// Use a preinstalled Chromium when one is provided (CI images, sandboxes).
const executablePath = process.env.CHROMIUM_PATH;

export default defineConfig({
  testDir: 'test/browser',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4174',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'PORT=4174 node test/browser/server.mjs',
    url: 'http://localhost:4174/test/browser/index.html',
    reuseExistingServer: !process.env.CI,
  },
});
