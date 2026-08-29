import { defineConfig, devices } from '@playwright/test'

const webPort = process.env.WEB_PORT ?? '5173'
const baseURL = `http://127.0.0.1:${webPort}`

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'pnpm -w dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
