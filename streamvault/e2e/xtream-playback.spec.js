import { test, expect } from "./fixtures/app.fixture.js";
import { mockLoggedOutUser, mockLoginSuccess, mockTurnstile, mockAppBackend } from "./fixtures/auth.fixture.js";
import { installXtreamMock } from "./fixtures/provider-mocks.js";
import { stubHls, stubMpegts, stubNativeMedia, getMediaLog, triggerVideoEvent } from "./fixtures/media-stubs.js";

/**
 * Helper: reach setup and connect with Xtream.
 */
async function connectXtream(appPage, options = {}) {
  await mockLoggedOutUser(appPage);
  await mockLoginSuccess(appPage);
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  await stubHls(appPage);
  await stubMpegts(appPage);
  await stubNativeMedia(appPage);
  await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));

  installXtreamMock(appPage, options);

  await appPage.goto("/app");
  await appPage.getByPlaceholder("Username").fill("test-user");
  await appPage.getByPlaceholder("Password").fill("test-pass");
  await appPage.getByRole("button", { name: "Login" }).last().click();
  await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

  await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
  await appPage.getByPlaceholder("username").fill("test-user");
  await appPage.getByPlaceholder("password").fill("test-pass");
  await appPage.getByRole("button", { name: /Connect →/ }).click();
}

async function openXtreamLivePlayer(appPage) {
  await connectXtream(appPage, { auth: "valid" });
  await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });
  await appPage.getByText("News Channel").click();
  await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });
}

async function exhaustDirectErrors(appPage, status) {
  await expect
    .poll(async () => (await getMediaLog(appPage)).hlsInstances.length)
    .toBeGreaterThan(0);

  // The direct path may use HLS, MPEG-TS, or native playback depending on
  // provider metadata. Drive whichever direct engine is active.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await appPage.evaluate((code) => {
      const mpegts = window.__e2eMedia.mpegtsInstances.at(-1);
      if (mpegts) {
        mpegts._triggerError(code);
        return;
      }
      const hls = window.__e2eMedia.hlsInstances.at(-1);
      if (hls) hls._triggerFatalError("networkError", "manifestLoadError", code);
    }, status);
    await appPage.waitForTimeout(250);
  }
}

test.describe("Xtream playback", () => {
  test("valid account loads Live, Movies, and Series", async ({ appPage }) => {
    await connectXtream(appPage, { auth: "valid" });

    await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });

    // Navigate to Movies.
    const moviesBtn = appPage.locator(".sidebar .nav", { hasText: "Movies" });
    await expect(moviesBtn).toBeVisible();
    await moviesBtn.click();
    await expect(appPage.getByText("Test Movie")).toBeVisible({ timeout: 10000 });

    // Navigate to Series.
    const seriesBtn = appPage.locator(".sidebar .nav", { hasText: "Series" });
    await expect(seriesBtn).toBeVisible();
    await seriesBtn.click();
    await expect(appPage.getByText("Test Series")).toBeVisible({ timeout: 10000 });
  });

  test("disabled or expired account does not pass validation", async ({ appPage }) => {
    await connectXtream(appPage, { auth: "expired" });

    await expect(appPage.getByText(/account has expired/i)).toBeVisible({ timeout: 10000 });
  });

  test("empty VOD categories do not leave an infinite spinner", async ({ appPage }) => {
    await connectXtream(appPage, { auth: "valid", emptyCatalog: true });

    // With empty catalog, the channel list should not appear.
    await expect(appPage.getByText("News Channel")).not.toBeVisible({ timeout: 5000 });
    await expect(appPage.getByText(/no content found/i)).toBeVisible();
    // The app should show an empty state, not an infinite spinner.
    // We just verify it doesn't hang — a timeout here means the spinner is stuck.
  });

  test("direct live TS is attempted before /stream relay", async ({ appPage }) => {
    await connectXtream(appPage, { auth: "valid" });

    await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("News Channel").click();

    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });

    // Verify the MPEG-TS engine was used (Xtream live defaults to TS).
    const log = await getMediaLog(appPage);
    const tsUsed = log.mpegtsAttachCalls.length > 0 || log.nativePlayCalls.length > 0;
    expect(tsUsed).toBe(true);
  });

  for (const [status, message] of [
    [401, "Access Denied (401)"],
    [403, "Access Denied (403)"],
    [407, "Client Error (407)"],
  ]) {
    test("direct media " + status + " becomes a bounded playback error without relay", async ({ appPage }) => {
      const relayRequests = [];
      appPage.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/stream" || url.pathname.startsWith("/stream/")) {
          relayRequests.push(request.url());
        }
      });

      await openXtreamLivePlayer(appPage);
      await exhaustDirectErrors(appPage, status);

      await expect(appPage.getByText(message)).toBeVisible({ timeout: 10000 });
      expect(relayRequests).toHaveLength(0);
    });
  }

  test("favorites persist after reload", async ({ appPage }) => {
    await connectXtream(appPage, { auth: "valid" });

    await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });

    await appPage.getByText("News Channel").click();
    const favBtn = appPage.getByRole("button", { name: /fav/i });
    await expect(favBtn).toBeVisible();
    await favBtn.click();
    await appPage.getByRole("button", { name: /close/i }).click();

    // Reload and check favorites.
    await appPage.reload();
    await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });
    await appPage.locator(".sidebar .nav", { hasText: "Favorites" }).click();
    await expect(appPage.getByText("News Channel")).toBeVisible();
  });
});

test.describe("M3U playback", () => {
  test("HLS item selects HLS engine", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await mockLoginSuccess(appPage);
    await mockTurnstile(appPage);
    await mockAppBackend(appPage);
    await stubHls(appPage);
    await stubMpegts(appPage);
    await stubNativeMedia(appPage);
    await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));

    // Mock M3U with HLS item.
    await appPage.route("**/proxy?url=**", (route) => {
      const url = new URL(route.request().url());
      const target = url.searchParams.get("url") || "";
      if (target.includes(".m3u")) {
        return route.fulfill({
          status: 200,
          contentType: "application/vnd.apple.mpegurl",
          body: `#EXTM3U
#EXTINF:-1 group-title="Live",HLS Stream
http://media.test/live/stream.m3u8`,
        });
      }
      return route.fulfill({ status: 200, contentType: "text/plain", body: "" });
    });

    await appPage.goto("/app");
    await appPage.getByPlaceholder("Username").fill("test-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    await appPage.getByRole("button", { name: "M3U Playlist" }).click();
    await appPage.getByPlaceholder("http://example.com/playlist.m3u").fill("http://provider.test/playlist.m3u");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText("HLS Stream")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("HLS Stream").click();

    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });

    const log = await getMediaLog(appPage);
    expect(log.hlsLoadCalls.length).toBeGreaterThan(0);
  });

  test("native MP4 item selects native playback", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await mockLoginSuccess(appPage);
    await mockTurnstile(appPage);
    await mockAppBackend(appPage);
    await stubHls(appPage);
    await stubMpegts(appPage);
    await stubNativeMedia(appPage);
    await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));

    await appPage.route("**/proxy?url=**", (route) => {
      const url = new URL(route.request().url());
      const target = url.searchParams.get("url") || "";
      if (target.includes(".m3u")) {
        return route.fulfill({
          status: 200,
          contentType: "application/vnd.apple.mpegurl",
          body: `#EXTM3U
#EXTINF:-1 group-title="Movies",MP4 File
http://media.test/vod/movie.mp4`,
        });
      }
      return route.fulfill({ status: 200, contentType: "text/plain", body: "" });
    });

    await appPage.goto("/app");
    await appPage.getByPlaceholder("Username").fill("test-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    await appPage.getByRole("button", { name: "M3U Playlist" }).click();
    await appPage.getByPlaceholder("http://example.com/playlist.m3u").fill("http://provider.test/playlist.m3u");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText("MP4 File")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("MP4 File").click();

    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });

    const log = await getMediaLog(appPage);
    expect(log.nativePlayCalls.length).toBeGreaterThan(0);
    expect(log.hlsLoadCalls.length).toBe(0);

    // A direct-file failure such as ERR_BLOCKED_BY_ORB must be actionable.
    await triggerVideoEvent(appPage, "error");
    await expect(appPage.getByText("Playback Error")).toBeVisible({ timeout: 5000 });
  });

  test("group/category navigation works", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await mockLoginSuccess(appPage);
    await mockTurnstile(appPage);
    await mockAppBackend(appPage);
    await stubHls(appPage);
    await stubMpegts(appPage);
    await stubNativeMedia(appPage);
    await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));

    await appPage.route("**/proxy?url=**", (route) => {
      const url = new URL(route.request().url());
      const target = url.searchParams.get("url") || "";
      if (target.includes(".m3u")) {
        return route.fulfill({
          status: 200,
          contentType: "application/vnd.apple.mpegurl",
          body: `#EXTM3U
#EXTINF:-1 group-title="News",News HD
http://media.test/live/news.ts
#EXTINF:-1 group-title="Sports",Sports HD
http://media.test/live/sports.ts`,
        });
      }
      return route.fulfill({ status: 200, contentType: "text/plain", body: "" });
    });

    await appPage.goto("/app");
    await appPage.getByPlaceholder("Username").fill("test-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    await appPage.getByRole("button", { name: "M3U Playlist" }).click();
    await appPage.getByPlaceholder("http://example.com/playlist.m3u").fill("http://provider.test/playlist.m3u");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    // Both channels should be visible.
    await expect(appPage.getByText("News HD")).toBeVisible({ timeout: 15000 });
    await expect(appPage.getByText("Sports HD")).toBeVisible();
  });
});
