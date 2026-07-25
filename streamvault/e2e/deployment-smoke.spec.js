/* global process */
import { test, expect } from "@playwright/test";

/**
 * Deployment smoke suite — runs against the staging environment.
 *
 * These tests are non-destructive and verify that the deployed application
 * serves the correct documents and routes.  They do not authenticate or
 * modify any data.
 *
 * Requires:
 *   E2E_BASE_URL=https://media.portalheaven.stream
 *   E2E_CONTENT_URL=http://40.233.113.76
 */

const contentUrl = process.env.E2E_CONTENT_URL;

test.describe("HTTPS host checks", () => {
  test("/ returns marketing page", async ({ page }) => {
    const response = await page.goto("/");
    expect(response.status()).toBe(200);
    await expect(page.getByText(/Portal Heaven|personal IPTV/i)).toBeVisible();
  });

  test("/app returns application document", async ({ page }) => {
    const response = await page.goto("/app");
    expect(response.status()).toBe(200);
    // The app document should contain the root element.
    const html = await page.content();
    expect(html).toContain("root");
  });

  test("/features returns features page", async ({ page }) => {
    const response = await page.goto("/features");
    expect(response.status()).toBe(200);
  });

  test("/privacy returns privacy page", async ({ page }) => {
    const response = await page.goto("/privacy");
    expect(response.status()).toBe(200);
  });

  test("/manifest.json has start_url: /app", async ({ page }) => {
    const response = await page.goto("/manifest.json");
    expect(response.status()).toBe(200);
    const manifest = await response.json();
    expect(manifest.start_url).toBe("/app");
  });

  test("unknown route returns 404", async ({ page }) => {
    const response = await page.goto("/this-route-does-not-exist");
    expect(response.status()).toBe(404);
  });

  test("/health returns 200", async ({ page }) => {
    const response = await page.goto("/health");
    expect(response.status()).toBe(200);
  });
});

test.describe("HTTP content host checks", () => {
  test.skip(!contentUrl, "E2E_CONTENT_URL not set");

  test("/content?token=test-invalid returns the application document", async ({ page }) => {
    const response = await page.goto(`${contentUrl}/content?token=test-invalid`);
    expect(response.status()).toBe(200);
    const html = await page.content();
    expect(html).toContain("root");
  });

  test("invalid token redirects to /app?reason=auth", async ({ page }) => {
    await page.goto(`${contentUrl}/content?token=test-invalid`);
    // The app should redirect to the secure app URL with reason=auth.
    await expect(page).toHaveURL(/\/app\?reason=auth/, { timeout: 15000 });
  });

  test("/app returns the application document", async ({ page }) => {
    const response = await page.goto(`${contentUrl}/app`);
    expect(response.status()).toBe(200);
    const html = await page.content();
    expect(html).toContain("root");
  });

  test("unknown route returns 404", async ({ page }) => {
    const response = await page.goto(`${contentUrl}/nonexistent`);
    expect(response.status()).toBe(404);
  });

  test("no HSTS header on bare IP host", async ({ page }) => {
    const response = await page.goto(`${contentUrl}/health`);
    const headers = response.headers();
    expect(headers["strict-transport-security"]).toBeUndefined();
  });
});
