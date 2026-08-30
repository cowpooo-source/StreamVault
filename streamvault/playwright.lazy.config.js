/* global process */
import { defineConfig, devices } from "@playwright/test";

process.env.VITE_STALKER_LAZY_CATALOG_ENABLED = "true";
const baseURL = process.env.E2E_BASE_URL || "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /stalker-(?:catalog|lazy-flow)\.spec\.js/,
  timeout: 60000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-lazy", open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev -- --host localhost",
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120000,
        env: { ...process.env, VITE_STALKER_LAZY_CATALOG_ENABLED: "true" },
      },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], serviceWorkers: "block" } }],
});
