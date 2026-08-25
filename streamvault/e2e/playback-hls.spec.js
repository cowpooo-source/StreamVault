import { test, expect } from "./fixtures/app.fixture.js";
import { mockLoggedOutUser, mockLoginSuccess, mockTurnstile, mockAppBackend } from "./fixtures/auth.fixture.js";
import { stubHls, stubNativeMedia, getMediaLog } from "./fixtures/media-stubs.js";

/**
 * Helper: set up an authenticated session with HLS content ready.
 */
async function setupHlsPlayback(appPage) {
  await mockLoggedOutUser(appPage);
  await mockLoginSuccess(appPage);
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  await stubHls(appPage);
  await stubNativeMedia(appPage);
  await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));

  // Mock Xtream proxy to return an HLS stream.
  await appPage.route("**/proxy?url=**", (route) => {
    const url = new URL(route.request().url());
    const target = url.searchParams.get("url") || "";
    const action = new URL(target).searchParams.get("action");

    if (action === "get_live_categories") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ category_id: "1", category_name: "News" }]) });
    }
    if (action === "get_live_streams") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
        { stream_id: 101, name: "HLS Channel", category_id: "1", stream_icon: "" },
      ]) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user_info: { auth: 1, status: "Active" } }) });
  });
}

test.describe("HLS playback", () => {
  test(".m3u8 URL selects the HLS engine", async ({ appPage }) => {
    await setupHlsPlayback(appPage);

    await appPage.goto("/app");
    await appPage.getByPlaceholder("Username").fill("test-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("test-user");
    await appPage.getByPlaceholder("password").fill("test-pass");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText("HLS Channel")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("HLS Channel").click();

    // Wait for the video element.
    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });

    // Verify HLS engine was loaded.
    const log = await getMediaLog(appPage);
    expect(log.hlsLoadCalls.length).toBeGreaterThan(0);
  });

  test("successful playing event removes the loading overlay", async ({ appPage }) => {
    await setupHlsPlayback(appPage);

    await appPage.goto("/app");
    await appPage.getByPlaceholder("Username").fill("test-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("test-user");
    await appPage.getByPlaceholder("password").fill("test-pass");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText("HLS Channel")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("HLS Channel").click();
    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });
    await expect(appPage.getByTestId("player-loading")).toBeVisible();

    // Trigger the playing event to clear loading state.
    await appPage.evaluate(() => {
      const video = document.querySelector("video");
      if (video) video.dispatchEvent(new Event("playing"));
    });

    await expect(appPage.getByTestId("player-loading")).toBeHidden();
  });

  test("manual retry creates a new playback generation", async ({ appPage }) => {
    await setupHlsPlayback(appPage);

    await appPage.goto("/app");
    await appPage.getByPlaceholder("Username").fill("test-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("test-user");
    await appPage.getByPlaceholder("password").fill("test-pass");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText("HLS Channel")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("HLS Channel").click();
    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });

    // Exhaust bounded HLS network recovery to expose the manual retry action.
    await appPage.evaluate(() => {
      const hls = window.__e2eMedia.hlsInstances.at(-1);
      for (let i = 0; i < 3; i++) {
        hls._triggerFatalError(
          window.Hls.ErrorTypes.NETWORK_ERROR,
          "manifestLoadError",
          404,
        );
      }
    });

    const retryBtn = appPage.getByRole("button", { name: /retry|try again/i });
    await expect(retryBtn).toBeVisible();
    const loadCountBefore = (await getMediaLog(appPage)).hlsLoadCalls.length;
    await retryBtn.click();
    await expect
      .poll(async () => (await getMediaLog(appPage)).hlsLoadCalls.length)
      .toBeGreaterThan(loadCountBefore);
  });
});
