import { test, expect } from "./fixtures/app.fixture.js";
import { CONTENT_SESSION_ROUTES } from "./helpers/route-builders.js";

/**
 * Helper: mock the content-session validate endpoint to return a valid session.
 */
async function mockValidSession(page, overrides = {}) {
  const session = {
    connection: {
      id: "direct-xtream",
      type: "xtream",
      label: "Direct provider",
      config: {
        type: "xtream",
        server: "http://provider.test",
        user: "direct-user",
        pass: "direct-password",
      },
    },
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
  await page.route("**/api/content-session/validate**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    }),
  );
  return session;
}

/**
 * Helper: mock Xtream proxy responses for content mode.
 */
async function mockXtreamProxy(page) {
  await page.route("**/proxy?url=**", (route) => {
    const proxiedUrl = new URL(route.request().url());
    const requestUrl = new URL(proxiedUrl.searchParams.get("url"));
    const action = requestUrl.searchParams.get("action");
    const body =
      action === "get_live_categories"
        ? [{ category_id: "1", category_name: "News" }]
        : action === "get_live_streams"
          ? [
              {
                stream_id: 101,
                name: "Direct Channel",
                category_id: "1",
                stream_icon: "",
              },
            ]
          : { user_info: { auth: 1 } };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(body),
    });
  });
}

test.describe("Content session lifecycle", () => {
  test("valid token hydrates the correct connection and shows channels", async ({
    appPage,
  }) => {
    await mockValidSession(appPage);
    await mockXtreamProxy(appPage);

    await appPage.goto("/content?token=valid-session-token");

    await expect(appPage.getByText("Direct Channel")).toBeVisible({
      timeout: 15000,
    });
    // Token is stored in session storage.
    await expect
      .poll(() =>
        appPage.evaluate(() =>
          sessionStorage.getItem("sv-content-session-token"),
        ),
      )
      .toBe("valid-session-token");
  });

  test("/api/auth/me is not called in HTTP content mode", async ({
    appPage,
  }) => {
    let authMeCount = 0;
    appPage.on("request", (req) => {
      if (req.url().includes("/api/auth/me")) authMeCount++;
    });

    await mockValidSession(appPage);
    await mockXtreamProxy(appPage);

    await appPage.goto("/content?token=valid-session-token");
    await expect(appPage.getByText("Direct Channel")).toBeVisible({
      timeout: 15000,
    });

    expect(authMeCount).toBe(0);
  });

  test("provider credentials are not stored in browser storage", async ({
    appPage,
  }) => {
    await mockValidSession(appPage);
    await mockXtreamProxy(appPage);

    await appPage.goto("/content?token=valid-session-token");
    await expect(appPage.getByText("Direct Channel")).toBeVisible({
      timeout: 15000,
    });

    const storage = await appPage.evaluate(() => {
      const all = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        all[`ls:${key}`] = localStorage.getItem(key);
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        all[`ss:${key}`] = sessionStorage.getItem(key);
      }
      return all;
    });
    const storageText = JSON.stringify(storage);

    expect(storageText).not.toContain("direct-user");
    expect(storageText).not.toContain("direct-password");
  });

  test("unknown token returns to /app?reason=auth", async ({ appPage, allowBrowserError }) => {
    allowBrowserError(/^401 GET https?:\/\/[^/]+\/api\/content-session\/validate\?/);
    await appPage.route("**/api/auth/me", (route) =>
      route.fulfill({ status: 401, body: "{}" }),
    );
    await appPage.route("**/api/content-session/validate**", (route) =>
      route.fulfill({ status: 401, body: "{}" }),
    );

    await appPage.goto("/content?token=bad-token");

    // The app should redirect to /app with reason=auth.
    await expect(appPage).toHaveURL(/\/app\?reason=auth/, { timeout: 10000 });
  });

  test("expired token returns to /app?reason=auth", async ({ appPage, allowBrowserError }) => {
    allowBrowserError(/^410 GET https?:\/\/[^/]+\/api\/content-session\/validate\?/);
    await appPage.route("**/api/auth/me", (route) =>
      route.fulfill({ status: 401, body: "{}" }),
    );
    await appPage.route("**/api/content-session/validate**", (route) =>
      route.fulfill({ status: 410, body: "{}" }),
    );

    await appPage.goto("/content?token=expired-token");

    await expect(appPage).toHaveURL(/\/app\?reason=auth/, { timeout: 10000 });
  });

  test("refresh extends an active token", async ({ appPage }) => {
    await mockValidSession(appPage);
    await mockXtreamProxy(appPage);

    let refreshCalled = false;
    await appPage.route("**/api/content-session/refresh", (route) => {
      refreshCalled = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ expiresAt: Date.now() + 120_000 }),
      });
    });

    await appPage.goto("/content?token=valid-session-token");
    await expect(appPage.getByText("Direct Channel")).toBeVisible({
      timeout: 15000,
    });

    await appPage.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect.poll(() => refreshCalled).toBe(true);
  });

  test("refresh failure invalidates the content session", async ({
    appPage,
    allowBrowserError,
  }) => {
    allowBrowserError(/^401 POST https?:\/\/[^/]+\/api\/content-session\/refresh/);
    await mockValidSession(appPage);
    await mockXtreamProxy(appPage);

    await appPage.route("**/api/content-session/refresh", (route) =>
      route.fulfill({ status: 401, body: "{}" }),
    );

    await appPage.goto("/content?token=valid-session-token");
    await expect(appPage.getByText("Direct Channel")).toBeVisible({
      timeout: 15000,
    });

    await appPage.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect(
      appPage.getByText("Unable to open content session"),
    ).toBeVisible({ timeout: 10000 });
    await expect
      .poll(() =>
        appPage.evaluate(() =>
          sessionStorage.getItem("sv-content-session-token"),
        ),
      )
      .toBeNull();
  });

  test("disconnect deletes the session and returns to /app", async ({
    appPage,
  }) => {
    await mockValidSession(appPage);
    await mockXtreamProxy(appPage);

    await appPage.route("**/api/content-session", (route) => {
      if (route.request().method() === "DELETE") {
        return route.fulfill({ status: 200, body: "{}" });
      }
      return route.fallback();
    });

    await appPage.goto("/content?token=valid-session-token");
    await expect(appPage.getByText("Direct Channel")).toBeVisible({
      timeout: 15000,
    });

    // Find and click disconnect.
    const disconnectBtn = appPage.getByRole("button", {
      name: /disconnect/i,
    });
    await expect(disconnectBtn).toBeVisible();
    await disconnectBtn.click();
    await expect(appPage).toHaveURL(/\/app/, { timeout: 10000 });
  });

  test("switch connection deletes the session and returns to /app", async ({
    appPage,
  }) => {
    await mockValidSession(appPage);
    await mockXtreamProxy(appPage);

    await appPage.goto("/content?token=valid-session-token");
    await expect(appPage.getByText("Direct Channel")).toBeVisible({
      timeout: 15000,
    });

    // Find switch connection button.
    const switchBtn = appPage.locator(".conn-card").filter({
      has: appPage.locator(".conn-card-switch"),
    });
    await expect(switchBtn).toBeVisible();
    appPage.once("dialog", (dialog) => dialog.accept());
    await switchBtn.click();
    await expect(appPage).toHaveURL(/\/app/, { timeout: 10000 });
  });

  test("guest content-session includes X-Guest-Id header", async ({
    appPage,
  }) => {
    let guestIdHeader = null;
    appPage.on("request", (req) => {
      if (req.url().includes("/api/content-session/validate")) {
        guestIdHeader = req.headers()["x-guest-id"];
      }
    });

    await mockValidSession(appPage);
    await mockXtreamProxy(appPage);
    // Set guest mode.
    await appPage.addInitScript(() => {
      localStorage.setItem("sv-guest-mode", "1");
    });

    await appPage.goto("/content?token=guest-session-token");
    await expect(appPage.getByText("Direct Channel")).toBeVisible({
      timeout: 15000,
    });

    // Verify a guest ID header was sent.
    expect(guestIdHeader).toBeTruthy();
    expect(guestIdHeader.length).toBeGreaterThan(0);
  });
});
