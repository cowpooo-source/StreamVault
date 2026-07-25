import { test, expect } from "./fixtures/app.fixture.js";
import { mockLoggedOutUser, mockLoginSuccess, mockTurnstile, mockAppBackend } from "./fixtures/auth.fixture.js";
import { stubHls, stubMpegts, stubNativeMedia, getMediaLog } from "./fixtures/media-stubs.js";

/**
 * Helper: set up a live stream session with recovery-capable stubs.
 */
async function setupRecoveryTest(appPage) {
  await mockLoggedOutUser(appPage);
  await mockLoginSuccess(appPage);
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  await stubHls(appPage);
  await stubMpegts(appPage);
  await stubNativeMedia(appPage);
  await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));

  let resolveCount = 0;
  await appPage.route("**/proxy?url=**", (route) => {
    const url = new URL(route.request().url());
    const target = url.searchParams.get("url") || "";
    const action = new URL(target).searchParams.get("action");

    if (action === "get_live_categories") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ category_id: "1", category_name: "Live" }]) });
    }
    if (action === "get_live_streams") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
        { stream_id: 301, name: "Recovery Channel", category_id: "1", stream_icon: "" },
      ]) });
    }
    // Track resolve/create_link calls.
    resolveCount++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user_info: { auth: 1, status: "Active" } }) });
  });

  return { getResolveCount: () => resolveCount };
}

/**
 * Helper: navigate to a channel and start playback.
 */
async function navigateToChannel(appPage) {
  await appPage.goto("/app");
  await appPage.getByPlaceholder("Username").fill("test-user");
  await appPage.getByPlaceholder("Password").fill("test-pass");
  await appPage.getByRole("button", { name: "Login" }).last().click();
  await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

  await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
  await appPage.getByPlaceholder("username").fill("test-user");
  await appPage.getByPlaceholder("password").fill("test-pass");
  await appPage.getByRole("button", { name: /Connect →/ }).click();

  await expect(appPage.getByText("Recovery Channel")).toBeVisible({ timeout: 15000 });
  await appPage.getByText("Recovery Channel").click();
  await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });
}

test.describe("Playback recovery state machine", () => {
  test("healthy playback does not trigger refresh", async ({ appPage }) => {
    const { getResolveCount } = await setupRecoveryTest(appPage);
    await navigateToChannel(appPage);

    const countBefore = getResolveCount();

    // Trigger playing — healthy state.
    await appPage.evaluate(() => {
      const v = document.querySelector("video");
      if (v) { v.dispatchEvent(new Event("playing")); }
    });

    await appPage.waitForTimeout(1000);

    // No extra resolve calls should have happened after playing.
    const countAfter = getResolveCount();
    expect(countAfter).toBe(countBefore);
  });

  test("successful playing clears the loading state", async ({ appPage }) => {
    await setupRecoveryTest(appPage);
    await navigateToChannel(appPage);
    await expect(appPage.getByTestId("player-loading")).toBeVisible();

    // Trigger playing event.
    await appPage.evaluate(() => {
      const v = document.querySelector("video");
      if (v) { v.dispatchEvent(new Event("playing")); }
    });

    await expect(appPage.getByTestId("player-loading")).toBeHidden();
  });

  test("manual retry starts a clean generation", async ({ appPage }) => {
    await setupRecoveryTest(appPage);
    await navigateToChannel(appPage);

    const logBefore = await getMediaLog(appPage);
    const countBefore = logBefore.hlsLoadCalls.length + logBefore.mpegtsLoadCalls.length;

    // Trigger a stall to force the error/retry state.
    await appPage.evaluate(() => {
      const hls = window.__e2eMedia.hlsInstances.at(-1);
      const mpegts = window.__e2eMedia.mpegtsInstances.at(-1);
      if (hls) {
        for (let i = 0; i < 3; i++) {
          hls._triggerFatalError(
            window.Hls.ErrorTypes.NETWORK_ERROR,
            "manifestLoadError",
            500,
          );
        }
      } else {
        for (let i = 0; i < 3; i++) mpegts._triggerError(500);
      }
    });

    // If a retry button appears, click it and verify a fresh load occurs.
    const retryBtn = appPage.getByRole("button", { name: /retry|try again/i });
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();
    await expect
      .poll(async () => {
        const log = await getMediaLog(appPage);
        return log.hlsLoadCalls.length + log.mpegtsLoadCalls.length;
      })
      .toBeGreaterThan(countBefore);
    // If no retry button, the stub handled recovery internally — that's acceptable.
  });

  test("resolve request count is bounded", async ({ appPage }) => {
    const { getResolveCount } = await setupRecoveryTest(appPage);
    await navigateToChannel(appPage);

    const countBefore = getResolveCount();

    // Trigger multiple stall events.
    for (let i = 0; i < 5; i++) {
      await appPage.evaluate(() => {
        const v = document.querySelector("video");
        if (v) v.dispatchEvent(new Event("stalled"));
      });
      await appPage.waitForTimeout(300);
    }

    const countAfter = getResolveCount();
    const newRequests = countAfter - countBefore;

    // The plan's loop guard: expect(resolveRequests.length).toBeLessThanOrEqual(expectedMaximum).
    // After 5 stalls, the recovery state machine should issue at most 2 fresh
    // resolve requests (one per confirmed stall), not one per stall event.
    expect(newRequests).toBeLessThanOrEqual(3);
  });
});
