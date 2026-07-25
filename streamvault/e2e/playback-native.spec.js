import { test, expect } from "./fixtures/app.fixture.js";
import { mockLoggedOutUser, mockLoginSuccess, mockTurnstile, mockAppBackend } from "./fixtures/auth.fixture.js";
import { stubNativeMedia, stubHls, stubMpegts, getMediaLog } from "./fixtures/media-stubs.js";

/**
 * Helper: set up an authenticated session with native file content.
 */
async function setupNativePlayback(appPage) {
  await mockLoggedOutUser(appPage);
  await mockLoginSuccess(appPage);
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  await stubNativeMedia(appPage);
  await stubHls(appPage);
  await stubMpegts(appPage);
  await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));

  // Mock proxy to return an M3U with native MP4 and MKV items.
  await appPage.route("**/proxy?url=**", (route) => {
    const url = new URL(route.request().url());
    const target = url.searchParams.get("url") || "";
    if (target.includes(".m3u")) {
      return route.fulfill({
        status: 200,
        contentType: "application/vnd.apple.mpegurl",
        body: `#EXTM3U
#EXTINF:-1 group-title="Movies",MP4 Movie
http://media.test/vod/movie.mp4
#EXTINF:-1 group-title="Movies",MKV Movie
http://media.test/vod/movie.mkv`,
      });
    }
    return route.fulfill({ status: 200, contentType: "text/plain", body: "" });
  });
}

test.describe("Native file playback", () => {
  test(".mp4 metadata selects native playback", async ({ appPage }) => {
    await setupNativePlayback(appPage);

    await appPage.goto("/app");
    await appPage.getByPlaceholder("Username").fill("test-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    // Switch to M3U tab and connect.
    await appPage.getByRole("button", { name: "M3U Playlist" }).click();
    await appPage.getByPlaceholder("http://example.com/playlist.m3u").fill("http://provider.test/playlist.m3u");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText("MP4 Movie")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("MP4 Movie").click();

    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });

    // Verify native play was called (no HLS or mpegts engine).
    const log = await getMediaLog(appPage);
    expect(log.nativePlayCalls.length).toBeGreaterThan(0);
    expect(log.hlsLoadCalls.length).toBe(0);
    expect(log.mpegtsAttachCalls.length).toBe(0);
  });

  test(".mkv metadata selects native playback", async ({ appPage }) => {
    await setupNativePlayback(appPage);

    await appPage.goto("/app");
    await appPage.getByPlaceholder("Username").fill("test-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    await appPage.getByRole("button", { name: "M3U Playlist" }).click();
    await appPage.getByPlaceholder("http://example.com/playlist.m3u").fill("http://provider.test/playlist.m3u");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText("MKV Movie")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("MKV Movie").click();

    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });

    const log = await getMediaLog(appPage);
    expect(log.nativePlayCalls.length).toBeGreaterThan(0);
  });
});
