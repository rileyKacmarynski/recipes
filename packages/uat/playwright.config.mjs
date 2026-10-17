import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './scenarios',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: `${process.env.UAT_EVIDENCE}/browser`,
  reporter: [
    ['list'],
    ['json', { outputFile: `${process.env.UAT_EVIDENCE}/playwright.json` }],
    ['html', { outputFolder: `${process.env.UAT_EVIDENCE}/html`, open: 'never' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.UAT_BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
