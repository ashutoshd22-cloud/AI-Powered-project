import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests. Requires the API on :8000 (see README "Testing").
 * Uses an installed browser channel when PW_CHANNEL is set (e.g. "msedge"), otherwise Playwright's Chromium.
 */
const channel = process.env.PW_CHANNEL || undefined

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  // In CI, failures also become GitHub annotations (readable without opening the job log).
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    // Lets you reproduce CI (UTC) or other zones locally: PW_TZ=UTC npx playwright test
    timezoneId: process.env.PW_TZ || undefined,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel, viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
