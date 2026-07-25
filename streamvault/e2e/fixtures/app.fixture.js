/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixture `use()` is not a React hook */
import { Buffer } from "node:buffer";
import { test as base } from "@playwright/test";
import { ConsoleMonitor } from "./console-monitor.js";
import { mockAppBackend } from "./auth.fixture.js";
import { assertNoUnexpectedBrowserErrors } from "../helpers/assertions.js";

/**
 * Extended Playwright test with automatic browser-error monitoring.
 *
 * Usage:
 *   import { test, expect } from "../fixtures/app.fixture.js";
 *
 * Provides:
 *   - appPage:           a Playwright Page with error monitoring attached.
 *   - browserErrors:     the ConsoleMonitor instance for the current test.
 *   - allowBrowserError: register an expected error for this test.
 */
export const test = base.extend({
  _backendMock: [async ({ page }, use) => {
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("https://fonts.gstatic.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "font/woff2", body: "" }),
    );
    await page.route("**/img?*", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: pixel }),
    );
    await page.route("http://images.test/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: pixel }),
    );
    await page.route("http://media.test/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/octet-stream", body: "" }),
    );
    // Register the guard before defaults and per-test routes. Playwright runs
    // matching routes newest-first, so explicit mocks always take precedence.
    await page.route("**/api/**", (route) => route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({
        error: `Unhandled E2E API route: ${route.request().method()} ${new URL(route.request().url()).pathname}`,
      }),
    }));
    await mockAppBackend(page);
    await use();
  }, { auto: true }],

  _monitor: [async ({}, use) => { // eslint-disable-line no-empty-pattern
    const monitor = new ConsoleMonitor();
    await use(monitor);
  }, { scope: "test" }],

  appPage: async ({ page, _monitor }, use) => {
    _monitor.attach(page);
    await use(page);
    const errors = _monitor.snapshot();
    const allowlist = page.__allowlistedErrors || [];
    assertNoUnexpectedBrowserErrors(errors, allowlist);
    _monitor.detach();
  },

  browserErrors: async ({ _monitor }, use) => {
    await use(_monitor);
  },

  allowBrowserError: async ({ page }, use) => {
    await use((pattern) => {
      if (!page.__allowlistedErrors) page.__allowlistedErrors = [];
      page.__allowlistedErrors.push(pattern);
    });
  },
});

export { expect } from "@playwright/test";
