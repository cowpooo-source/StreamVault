import { test, expect } from "@playwright/test";

test.describe("Login to Playback Smoke Flow", () => {

  test("complete login-to-playback flow with mocked APIs", async ({ page }) => {
    // Spy on HTMLMediaElement.prototype.play to verify playback was triggered
    let playCalled = false;
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.play = function () {
        window.__playCalled = true;
        return Promise.resolve();
      };
    });

    // 1. Mock login API
    await page.route("**/api/auth/login", async (route) => {
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
    await page.route("**/proxy?url=**", async (route) => {
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
    await page.route("http://media.test/stream.m3u8", async (route) => {
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
    await page.route("http://media.test/segment.ts", async (route) => {
      await route.fulfill({ status: 200, contentType: "video/mp2t", body: "" });
    });

    // 5. Navigate to the app
    await page.goto("/");

    // 6. Click the Login tab on AuthScreen (two Login buttons - pick the tab)
    await page.getByRole("button", { name: "Login" }).first().click();

    // 7. Fill in username and password, then submit
    await page.getByPlaceholder("Username").fill("demo");
    await page.getByPlaceholder("Password").fill("password");
    await page.getByRole("button", { name: "Login" }).last().click();

    // 8. Verify we reach the setup/connection screen (Portal Heaven is visible)
    await expect(page.getByText("Portal Heaven")).toBeVisible();

    // 9. Click the "M3U Playlist" tab
    await page.getByRole("button", { name: "M3U Playlist" }).click();

    // 10. Fill the M3U URL field
    await page.getByPlaceholder("http://example.com/playlist.m3u").fill("http://mock.test/playlist.m3u");

    // 11. Click Connect
    await page.getByRole("button", { name: "Connect →" }).click();

    // 12. Wait for the disclaimer modal if shown, dismiss it
    const agreeBtn = page.getByRole("button", { name: /I Agree/ });
    if (await agreeBtn.isVisible({ timeout: 3000 })) {
      await agreeBtn.click();
    }

    // 12. Wait for "Demo Channel" channel to appear in the list
    await expect(page.getByText("Demo Channel", { exact: false })).toBeVisible({ timeout: 10000 });

    // 13. Click the channel to start playback
    await page.getByText("Demo Channel", { exact: false }).click();

    // 14. Verify the video element becomes visible and play() was called
    const video = page.locator("video");
    await expect(video).toBeVisible({ timeout: 10000 });

    // Give the player a moment to initialize, then check that play was called
    await page.waitForTimeout(1500);
    const playWasCalled = await page.evaluate(() => window.__playCalled === true);
    expect(playWasCalled).toBe(true);
  });
});