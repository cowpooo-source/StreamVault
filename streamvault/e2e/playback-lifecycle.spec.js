import { test, expect } from "./fixtures/app.fixture.js";
import {
  mockAuthenticatedUser,
  mockLoggedOutUser,
  mockLoginSuccess,
  mockLogoutSuccess,
  mockTurnstile,
  mockAppBackend,
} from "./fixtures/auth.fixture.js";
import { installXtreamMock } from "./fixtures/provider-mocks.js";
import { stubHls, stubMpegts, stubNativeMedia, getMediaLog } from "./fixtures/media-stubs.js";

async function connect(appPage) {
  await mockLoggedOutUser(appPage);
  await mockLoginSuccess(appPage);
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  await stubHls(appPage);
  await stubMpegts(appPage);
  await stubNativeMedia(appPage);
  await appPage.route("http://provider.test/movie/**", route => route.fulfill({
    status: 200,
    contentType: "video/mp4",
    body: "",
  }));
  await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));
  installXtreamMock(appPage, { auth: "valid" });

  await appPage.goto("/app");
  await appPage.getByPlaceholder("Username").fill("e2e-user");
  await appPage.getByPlaceholder("Password").fill("test-pass");
  await appPage.getByRole("button", { name: "Login" }).last().click();
  await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

  await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
  await appPage.getByPlaceholder("username").fill("test-user");
  await appPage.getByPlaceholder("password").fill("test-pass");
  await appPage.getByRole("button", { name: /Connect/ }).click();
  await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });
}

function mediaLoadCount(log) {
  return (log.hlsLoadCalls?.length || 0)
    + (log.mpegtsLoadCalls?.length || 0)
    + (log.nativePlayCalls?.length || 0);
}

test.describe("Playback lifecycle", () => {
  test("channel switching changes content without closing the player", async ({ appPage }) => {
    await connect(appPage);
    await appPage.getByText("News Channel").click();
    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });
    const before = await getMediaLog(appPage);

    await appPage.keyboard.press("ArrowDown");
    await expect(appPage.locator(".qch-n").getByText("Sports Channel", { exact: true })).toBeVisible();

    await expect.poll(async () => mediaLoadCount(await getMediaLog(appPage)))
      .toBeGreaterThan(mediaLoadCount(before));
    await expect(appPage.locator("video")).toBeVisible();
  });

  test("terminal provider errors stop recovery and permit manual retry", async ({ appPage }) => {
    await connect(appPage);
    await appPage.getByText("News Channel").click();
    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });
    const before = await getMediaLog(appPage);

    await appPage.evaluate(() => {
      const media = window.__e2eMedia || {};
      const mpegts = (media.mpegtsInstances || []).at(-1);
      const hls = (media.hlsInstances || []).at(-1);
      if (mpegts) mpegts._triggerError(456);
      else if (hls) hls._triggerFatalError(window.Hls.ErrorTypes.NETWORK_ERROR, "manifestLoadError", 456);
    });

    await expect(appPage.getByText("Account Blocked (456)")).toBeVisible();
    const retry = appPage.getByRole("button", { name: "Try Again" });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect.poll(async () => mediaLoadCount(await getMediaLog(appPage)))
      .toBeGreaterThan(mediaLoadCount(before));
  });

  test("disconnect during playback exits and destroys the player", async ({ appPage }) => {
    await connect(appPage);
    await appPage.getByText("News Channel").click();
    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });

    await appPage.locator("button").filter({ hasText: "Disconnect" }).evaluateAll((buttons) => {
      const visible = buttons.find(button => button.offsetParent !== null);
      visible?.click();
    });

    await expect(appPage.locator("video")).toHaveCount(0);
    await expect(appPage).toHaveURL(/\/app/, { timeout: 10000 });
  });

  test("VOD item starts native playback and accepts seeking", async ({ appPage }) => {
    await connect(appPage);
    const movies = appPage.locator("span:visible").filter({ hasText: /^Movies$/ }).first();
    await expect(movies).toBeVisible({ timeout: 5000 });
    await movies.click();
    await expect(appPage.getByText("Test Movie")).toBeVisible({ timeout: 10000 });
    await appPage.getByText("Test Movie").click();
    await expect(appPage.locator("video")).toBeVisible({ timeout: 15000 });

    await appPage.locator("video").evaluate((video) => {
      video.currentTime = 42;
      video.dispatchEvent(new Event("timeupdate"));
    });
    await expect.poll(() => appPage.locator("video").evaluate(video => video.currentTime))
      .toBeGreaterThanOrEqual(42);
  });

  test("logout during playback destroys the active player", async ({ appPage }) => {
    await mockAuthenticatedUser(appPage);
    await mockLogoutSuccess(appPage);
    await mockAppBackend(appPage);
    await stubHls(appPage);
    await stubMpegts(appPage);
    await stubNativeMedia(appPage);
    await appPage.addInitScript(() => {
      localStorage.setItem("sv-disclaimer-accepted", "1");
      const connection = {
        id: "test-conn-1",
        type: "xtream",
        label: "Test Xtream",
        config: { type: "xtream", server: "http://provider.test", user: "test-user", pass: "test-pass" },
      };
      localStorage.setItem("sv-connections", JSON.stringify([connection]));
      localStorage.setItem("sv-activeConn", JSON.stringify(connection.id));
    });
    installXtreamMock(appPage, { auth: "valid" });
    await appPage.goto("/app");
    await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });
    await appPage.locator("span:visible").filter({ hasText: /^Direct Play$/ }).first().click();
    await appPage.getByPlaceholder("https://your-stream.com/live/stream.m3u8")
      .fill("http://media.test/logout-test.m3u8");
    await appPage.getByRole("button", { name: /Play/ }).click();
    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });

    const logoutRequest = appPage.waitForRequest(request => (
      request.method() === "POST" && new URL(request.url()).pathname === "/api/auth/logout"
    ));
    await appPage.locator("button").filter({ hasText: "Logout" }).evaluateAll((buttons) => {
      const visible = buttons.find(button => button.offsetParent !== null);
      visible?.click();
    });
    await logoutRequest;

    await expect(appPage.locator("video")).toHaveCount(0);
    await expect(appPage.getByRole("button", { name: "Login" }).last()).toBeVisible();
  });
});
