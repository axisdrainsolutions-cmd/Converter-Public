import { defineConfig, devices } from '@playwright/test';

/**
 * Tests run against the REAL production build served under the real
 * /Converter-Public/ sub-path — not against the dev server, and not at the
 * domain root. That combination is what previously let "works locally, breaks
 * on Pages" bugs escape.
 */
export default defineConfig({
  testDir: './test',
  // ffmpeg.wasm has to download a 30 MB core and then software-encode H.264.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173/Converter-Public/',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Set PW_CHROMIUM_PATH when a Chromium is already on the machine and
        // you do not want Playwright to download its own.
        launchOptions: process.env.PW_CHROMIUM_PATH
          ? { executablePath: process.env.PW_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/Converter-Public/',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
