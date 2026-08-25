import { test, expect } from "./fixtures/app.fixture.js";
import { mockLoggedOutUser, mockLoginSuccess, mockTurnstile, mockAppBackend } from "./fixtures/auth.fixture.js";
import { stubHls, stubMpegts, stubNativeMedia, getMediaLog } from "./fixtures/media-stubs.js";

/**
 * Helper: set up an authenticated session with MPEG-TS content ready.
 */
async function setupMpegtsPlayback(appPage) {
  await mockLoggedOutUser(appPage);
  await mockLoginSuccess(appPage);
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  await stubHls(appPage, { autoManifest: false });
  await stubMpegts(appPage);
  await stubNativeMedia(appPage);
  await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));

  // Mock Xtream proxy to return TS streams.
  await appPage.route("**/proxy?url=**", (route) => {
    const url = new URL(route.request().url());
    const target = url.searchParams.get("url") || "";
    const action = new URL(target).searchParams.get("action");

    if (action === "get_live_categories") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ category_id: "1", category_name: "News" }]) });
    }
    if (action === "get_live_streams") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
        { stream_id: 201, name: "TS Channel", category_id: "1", stream_icon: "" },
      ]) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user_info: { auth: 1, status: "Active" } }) });
  });
}

async function triggerXtreamTsFallback(appPage) {
  await expect.poll(async () => (await getMediaLog(appPage)).hlsInstances.length).toBeGreaterThan(0);
  await appPage.evaluate(() => {
    const instances = window.__e2eMedia.hlsInstances;
    instances[instances.length - 1]._triggerFatalError("networkError", "manifestLoadError", 404);
  });
  await expect.poll(async () => (await getMediaLog(appPage)).mpegtsAttachCalls.length).toBeGreaterThan(0);
}

test.describe("MPEG-TS playback", () => {
  test(".ts URL falls back from an unavailable HLS candidate to MPEG-TS", async ({ appPage }) => {
    await setupMpegtsPlayback(appPage);

    await appPage.goto("/app");
    await appPage.getByPlaceholder("Username").fill("test-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("test-user");
    await appPage.getByPlaceholder("password").fill("test-pass");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText("TS Channel")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("TS Channel").click();

    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });
    await triggerXtreamTsFallback(appPage);

    // Verify MPEG-TS engine was used.
    const log = await getMediaLog(appPage);
    expect(log.mpegtsAttachCalls.length).toBeGreaterThan(0);
  });

  test("load and play are called once per stream", async ({ appPage }) => {
    await setupMpegtsPlayback(appPage);

    await appPage.goto("/app");
    await appPage.getByPlaceholder("Username").fill("test-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("test-user");
    await appPage.getByPlaceholder("password").fill("test-pass");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText("TS Channel")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("TS Channel").click();
    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });
    await triggerXtreamTsFallback(appPage);

    const log = await getMediaLog(appPage);
    expect(log.mpegtsLoadCalls.length).toBe(1);
  });

  test("channel switch destroys the previous player", async ({ appPage }) => {
    await setupMpegtsPlayback(appPage);

    // Add a second channel.
    await appPage.route("**/proxy?url=**", (route) => {
      const url = new URL(route.request().url());
      const target = url.searchParams.get("url") || "";
      const action = new URL(target).searchParams.get("action");

      if (action === "get_live_categories") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ category_id: "1", category_name: "News" }]) });
      }
      if (action === "get_live_streams") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
          { stream_id: 201, name: "TS Channel A", category_id: "1", stream_icon: "" },
          { stream_id: 202, name: "TS Channel B", category_id: "1", stream_icon: "" },
        ]) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user_info: { auth: 1, status: "Active" } }) });
    });

    await appPage.goto("/app");
    await appPage.getByPlaceholder("Username").fill("test-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("test-user");
    await appPage.getByPlaceholder("password").fill("test-pass");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText("TS Channel A")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("TS Channel A").click();
    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });
    await triggerXtreamTsFallback(appPage);

    // Switch within the player; the overlay intentionally blocks the catalog.
    await appPage.getByRole("button", { name: /Next/ }).click();
    await triggerXtreamTsFallback(appPage);

    const log = await getMediaLog(appPage);
    // Destroy should have been called when switching channels.
    expect(log.mpegtsDestroyCalls.length).toBeGreaterThanOrEqual(1);
  });
});
