/* global process */
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://localhost:5173";
const externalTestIgnore = [
  "**/canary/**",
  "**/deployment-smoke.spec.js",
];

export default defineConfig({
  testDir: "./e2e",
  testIgnore: externalTestIgnore,
  timeout: 60000,
  // Service-worker lifecycle tests must run serially within their file;
  // other spec files can still execute in parallel.
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  outputDir: "test-results/playwright",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
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
        url: "http://localhost:5173",
        reuseExistingServer: true,
        timeout: 120000,
      },
  projects: [
    {
      name: "chromium",
      testIgnore: [...externalTestIgnore, "**/service-worker.spec.js"],
      use: {
        ...devices["Desktop Chrome"],
        serviceWorkers: "block",
      },
    },
    {
      name: "service-worker",
      testMatch: /service-worker\.spec\.js/,
      use: {
        ...devices["Desktop Chrome"],
        serviceWorkers: "allow",
      },
    },
  ],
});
