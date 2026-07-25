import { test, expect } from "./fixtures/app.fixture.js";

test.describe("Login to Playback Smoke Flow", () => {

  test("complete login-to-playback flow with mocked APIs", async ({ appPage }) => {
    // Spy on HTMLMediaElement.prototype.play to verify playback was triggered
    await appPage.addInitScript(() => {
      HTMLMediaElement.prototype.play = function () {
        window.__playCalled = true;
        return Promise.resolve();
      };
    });

    // 1. Mock auth APIs
    await appPage.route("**/api/auth/me", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
    );
    await appPage.route("**/api/auth/login", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: 1,
            username: "demo",
            role: "regular",
            maxConnections: 5,
          },
        }),
      });
    });

    // 2. Mock proxy endpoint to pass through M3U URLs, return empty for others
    await appPage.route("**/proxy?url=**", async (route) => {
      const url = new URL(route.request().url());
      const targetUrl = url.searchParams.get("url") || "";
      // The proxy passes through the M3U playlist itself
      if (targetUrl.includes(".m3u8") || targetUrl.includes(".m3u")) {
        await route.fulfill({
          status: 200,
          contentType: "application/vnd.apple.mpegurl",
          body: `#EXTM3U
#EXTINF:-1,Demo Channel
http://media.test/stream.m3u8
#EXT-X-ENDLIST`,
        });
      } else {
        await route.fulfill({ status: 200, contentType: "text/plain", body: "" });
      }
    });

    // 3. Mock HLS manifest at media.test
    await appPage.route("http://media.test/stream.m3u8", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/vnd.apple.mpegurl",
        body: `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-VERSION:3
#EXTINF:2,
segment.ts
#EXT-X-ENDLIST`,
      });
    });

    // 4. Mock HLS segment (optional, avoids 404 noise)
    await appPage.route("http://media.test/segment.ts", async (route) => {
      await route.fulfill({ status: 200, contentType: "video/mp2t", body: "" });
    });

    // 5. Navigate to the app
    await appPage.goto("/app");

    // 6. Click the Login tab on AuthScreen (two Login buttons - pick the tab)
    await appPage.getByRole("button", { name: "Login" }).first().click();

    // 7. Fill in username and password, then submit
    await appPage.getByPlaceholder("Username").fill("demo");
    await appPage.getByPlaceholder("Password").fill("password");
    await appPage.getByRole("button", { name: "Login" }).last().click();

    // 8. Verify we reach the setup/connection screen (Portal Heaven is visible)
    await expect(appPage.getByText("Portal Heaven")).toBeVisible();

    // 9. Click the "M3U Playlist" tab
    await appPage.getByRole("button", { name: "M3U Playlist" }).click();

    // 10. Fill the M3U URL field
    await appPage.getByPlaceholder("http://example.com/playlist.m3u").fill("http://mock.test/playlist.m3u");

    // 11. Click Connect
    await appPage.getByRole("button", { name: "Connect →" }).click();

    // 12. Wait for the disclaimer modal if shown, dismiss it
    const agreeBtn = appPage.getByRole("button", { name: /I Agree/ });
    if (await agreeBtn.isVisible({ timeout: 3000 })) {
      await agreeBtn.click();
    }

    // 13. Wait for "Demo Channel" channel to appear in the list
    await expect(appPage.getByText("Demo Channel", { exact: false })).toBeVisible({ timeout: 10000 });

    // 14. Click the channel to start playback
    await appPage.getByText("Demo Channel", { exact: false }).click();

    // 15. Verify the video element becomes visible and play() was called
    const video = appPage.locator("video");
    await expect(video).toBeVisible({ timeout: 10000 });

    // Intentional media initialization timeout — allowed by test rules.
    await appPage.waitForTimeout(1500);
    const playWasCalled = await appPage.evaluate(() => window.__playCalled === true);
    expect(playWasCalled).toBe(true);
  });
});
