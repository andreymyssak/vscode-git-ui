import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/browser',
  timeout: 10000,
  ...(process.env.CI ? { workers: 1 } : {}),
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/test/browser-test-server.ts',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { open: 'never' }],
        ['junit', { outputFile: '.artifacts/browser-results.xml' }],
      ]
    : 'list',
});
