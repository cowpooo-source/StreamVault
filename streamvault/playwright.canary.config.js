/* global process */
import { defineConfig, devices } from "@playwright/test";

/**
 * Canary suite configuration — runs against real IPTV providers.
 *
 * This suite is optional and runs nightly or manually.  It must NOT run
 * on pull requests.  Credentials are read from environment variables
 * or CI secrets only.
 *
 * Required environment variables (per provider):
 *   CANARY_XTREAM_SERVER, CANARY_XTREAM_USER, CANARY_XTREAM_PASS
 *   CANARY_STALKER_PORTAL, CANARY_STALKER_MAC, CANARY_STALKER_CONTENT_TOKEN
 *   CANARY_M3U_URL
 */

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3201";

export default defineConfig({
  testDir: "./e2e/canary",
  timeout: 60000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  outputDir: "test-results/canary",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report-canary", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
    video: "off",
    viewport: { width: 1440, height: 900 },
  },
  webServer: undefined,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
