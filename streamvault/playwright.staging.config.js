/* global process */
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL;
const contentUrl = process.env.E2E_CONTENT_URL;

if (!baseURL) {
  throw new Error("E2E_BASE_URL is required for staging config");
}
if (!contentUrl) {
  throw new Error("E2E_CONTENT_URL is required for staging config — content-host checks must not be silently skipped");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /deployment-smoke\.spec\.js/,
  timeout: 30000,
  fullyParallel: false,
  retries: 1,
  workers: 1,
  outputDir: "test-results/staging",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report-staging", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  // No webServer — tests run against the deployed staging environment.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
