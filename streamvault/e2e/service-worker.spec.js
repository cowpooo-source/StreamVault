import { test, expect } from "@playwright/test";

/**
 * Service worker tests run in a separate project with serviceWorkers: "allow".
 *
 * Each test that verifies a caching policy must first make a controlled request
 * to populate the cache, then inspect the Cache API.  Asserting a fresh cache
 * is empty proves nothing about the policy.
 */

async function waitForSW(page) {
  await page.goto("/app");
  await page.waitForFunction(
    () => navigator.serviceWorker && navigator.serviceWorker.controller,
    { timeout: 15000 },
  );
  await page.waitForTimeout(500);
}

async function cachedPaths(page) {
  return page.evaluate(async () => {
    const paths = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      paths.push(...(await cache.keys()).map((request) => new URL(request.url).pathname));
    }
    return paths;
  });
}

test.describe("Service worker", () => {
  test("manifest starts at /app", async ({ page }) => {
    const response = await page.goto("/manifest.json");
    expect(response.status()).toBe(200);
    const manifest = await response.json();
    expect(manifest.start_url).toBe("/app");
  });

  test("/api/auth/* is not cached after a real auth request", async ({
    page,
  }) => {
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
    );
    await waitForSW(page);

    // Make a controlled auth request so the SW gets a chance to cache it.
    const authResponse = await page.evaluate(async () => {
      const res = await fetch("/api/auth/me");
      return { status: res.status };
    });
    // Regardless of the response, the route should not be in the SW cache.
    expect(authResponse.status).toBeDefined();

    expect(await cachedPaths(page)).not.toContain("/api/auth/me");
  });

  test("/api/content-session is not cached after a validate call", async ({
    page,
  }) => {
    await page.route("**/api/content-session/validate?token=test", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
    );
    await waitForSW(page);

    // Trigger content-session validate.
    await page.evaluate(async () => {
      await fetch("/api/content-session/validate?token=test").catch(() => {});
    });
    expect(await cachedPaths(page)).not.toContain("/api/content-session/validate");
  });

  test("stream and proxy responses are not cached after fetch", async ({
    page,
  }) => {
    for (const pattern of ["**/proxy?*", "**/stream?*", "**/stalker/play?*", "**/img?*"]) {
      await page.route(pattern, (route) =>
        route.fulfill({ status: 200, contentType: "application/octet-stream", body: "test" }),
      );
    }
    await waitForSW(page);

    // Make a fetch through the proxy and a direct stream request so the SW
    // has an opportunity to cache them.
    await page.evaluate(async () => {
      await fetch("/proxy?url=http://example.com/stream.ts").catch(() => {});
      await fetch("/stream?url=http://example.com/segment.ts").catch(() => {});
      await fetch("/stalker/play?cmd=test").catch(() => {});
      await fetch("/img?url=http://example.com/poster.jpg").catch(() => {});
    });

    const paths = await cachedPaths(page);
    expect(paths).not.toContain("/proxy");
    expect(paths).not.toContain("/stream");
    expect(paths).not.toContain("/stalker/play");
    expect(paths).not.toContain("/img");
  });

  test("marketing root is not used as the offline app shell", async ({
    page,
  }) => {
    await waitForSW(page);

    const cacheContents = await page.evaluate(async () => {
      const names = await caches.keys();
      for (const name of names) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        const urls = keys.map((r) => new URL(r.url));
        const hasApp = urls.some((u) => u.pathname === "/app");
        const hasRoot = urls.some(
          (u) => u.pathname === "/" || u.pathname === "/index.html",
        );
        if (hasApp || hasRoot) return { hasApp, hasRoot };
      }
      return { hasApp: false, hasRoot: false };
    });

    expect(cacheContents.hasApp).toBe(true);
    expect(cacheContents.hasRoot).toBe(false);
  });

  test("application shell is precached for offline /app use", async ({
    page,
  }) => {
    await waitForSW(page);

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const allUrls = [];
      for (const name of names) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        allUrls.push(...keys.map((r) => new URL(r.url).pathname));
      }
      return allUrls;
    });

    expect(cached).toContain("/app");
  });

  test("old cache versions are deleted during activation", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const oldCache = await caches.open("sv-obsolete-e2e");
      await oldCache.put("/obsolete", new Response("obsolete"));
    });

    await waitForSW(page);

    await expect
      .poll(() => page.evaluate(() => caches.keys()))
      .not.toContain("sv-obsolete-e2e");
    expect((await page.evaluate(() => caches.keys())).some((name) => name.startsWith("sv-"))).toBe(true);
  });

  test("offline /app serves the cached app shell", async ({ page, context }) => {
    await waitForSW(page);

    // Verify /app is cached.
    const appCached = await page.evaluate(async () => {
      const names = await caches.keys();
      for (const name of names) {
        const cache = await caches.open(name);
        const match = await cache.match("/app");
        if (match) return true;
      }
      return false;
    });
    expect(appCached).toBe(true);

    // Go offline and navigate to /app.
    await context.setOffline(true);
    try {
      const response = await page.goto("/app");
      expect(response).not.toBeNull();
      expect(response.status()).toBe(200);
      await expect(page).toHaveURL(/\/app/);
    } finally {
      await context.setOffline(false);
    }
  });

  test("offline unknown marketing route returns an error page, not the app", async ({
    page,
    context,
  }) => {
    await waitForSW(page);

    await context.setOffline(true);
    try {
      const response = await page.goto("/some-random-page", { timeout: 5000 });
      expect(response).not.toBeNull();
      expect(response.status()).toBe(503);
      expect(await page.content()).not.toContain('id="root"');
    } finally {
      await context.setOffline(false);
    }
  });

  test("precache failures are isolated with allSettled", async ({ request }) => {
    const response = await request.get("/sw.js");
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain("Promise.allSettled");
  });
});
