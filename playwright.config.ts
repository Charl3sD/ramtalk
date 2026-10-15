import { defineConfig } from '@playwright/test';

const PORT = 5199;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    // IPv4 loopback on purpose: Vite's "localhost" binds ::1 only, and Firefox then restricts ICE
    // gathering to that loopback interface and finds no candidates at all.
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    // Dev server (exposes the test hook). localhost is a secure context, so plain HTTP is fine.
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    env: { HTTPS: '0' },
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
});
