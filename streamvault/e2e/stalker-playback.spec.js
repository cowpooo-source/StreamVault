import { test, expect } from "./fixtures/app.fixture.js";
import { mockAuthenticatedUser, mockTurnstile, mockAppBackend } from "./fixtures/auth.fixture.js";
import { installStalkerMock } from "./fixtures/provider-mocks.js";
import { stubHls, stubMpegts, stubNativeMedia, getMediaLog } from "./fixtures/media-stubs.js";
import { assertNoCredentialsInStorage } from "./fixtures/storage.fixture.js";

/**
 * Helper: set up a Stalker connection with mocks.
 */
async function setupStalkerTest(appPage, options = {}) {
  // Authenticate at the fixture boundary. These tests cover Stalker setup and
  // playback; the login flow has dedicated coverage and would add unrelated
  // sync/encryption setup to every provider test.
  await mockAuthenticatedUser(appPage);
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  await stubHls(appPage);
  await stubMpegts(appPage);
  await stubNativeMedia(appPage);
  await appPage.addInitScript(() => {
    localStorage.setItem("sv-disclaimer-accepted", "1");
    localStorage.setItem("sv-analytics-consent", "denied");
  });

  // Mock the Stalker validate endpoint.
  await appPage.route("**/stalker/validate", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ portalReachable: true, status: "active", maxConnections: 2 }),
    }),
  );

  installStalkerMock(appPage, options);
}

test.describe("Stalker playback", () => {
  test("handshake and profile load successfully", async ({ appPage }) => {
    await setupStalkerTest(appPage, { handshake: "valid" });

    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible({ timeout: 10000 });

    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:00:00:01");
    await appPage.getByRole("button", { name: /Connect →/ }).click();
    await appPage.locator(".sidebar .nav", { hasText: "Live TV" }).click();

    // Should load channel categories.
    await expect(appPage.getByText("Stalker News")).toBeVisible({ timeout: 15000 });
  });

  test("live item calls create_link and attempts direct HLS", async ({ appPage }) => {
    await setupStalkerTest(appPage, { handshake: "valid", createLink: "direct-hls" });

    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible({ timeout: 10000 });

    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:00:00:01");
    await appPage.getByRole("button", { name: /Connect →/ }).click();
    await appPage.locator(".sidebar .nav", { hasText: "Live TV" }).click();

    await expect(appPage.getByText("Stalker News")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("Stalker News").click();

    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });

    // Verify HLS engine was used for the direct URL.
    const log = await getMediaLog(appPage);
    expect(log.hlsLoadCalls.some(u => u.includes("stream.m3u8"))).toBe(true);
  });

  test("shows loading feedback while Stalker playback is resolving", async ({ appPage }) => {
    await setupStalkerTest(appPage, { handshake: "valid", createLink: "direct-hls", playDelayMs: 500 });

    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible({ timeout: 10000 });
    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:00:00:01");
    await appPage.getByRole("button", { name: /Connect .*→/ }).click();
    await appPage.locator(".sidebar .nav", { hasText: "Live TV" }).click();
    await expect(appPage.getByText("Stalker News")).toBeVisible({ timeout: 15000 });

    await appPage.getByText("Stalker News").click();
    await expect(appPage.getByTestId("playback-loading")).toBeVisible();
    await expect(appPage.getByTestId("playback-loading")).toContainText("Connecting to Stalker News");
    await expect(appPage.getByTestId("playback-loading")).toBeHidden({ timeout: 5000 });
  });

  test("cancels a slow Stalker resolution without opening Player", async ({ appPage }) => {
    await setupStalkerTest(appPage, { handshake: "valid", createLink: "direct-hls", playDelayMs: 120_000 });

    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible({ timeout: 10000 });
    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:00:00:01");
    await appPage.getByRole("button", { name: /Connect .*→/ }).click();
    await appPage.locator(".sidebar .nav", { hasText: "Live TV" }).click();
    await expect(appPage.getByText("Stalker News")).toBeVisible({ timeout: 15000 });

    await appPage.getByText("Stalker News").click();
    await expect(appPage.getByTestId("playback-loading")).toBeVisible();
    await appPage.getByRole("button", { name: "Cancel loading" }).click();
    await expect(appPage.getByTestId("playback-loading")).toHaveCount(0);
    await expect(appPage.locator(".player-ov")).toHaveCount(0);
    await expect(appPage.getByText("Stalker News")).toBeVisible();
  });

  test("removes pending feedback and reports a failed Stalker resolution", async ({ appPage, allowBrowserError }) => {
    await setupStalkerTest(appPage, { handshake: "valid", createLink: "failure" });
    await allowBrowserError(/Stalker direct playback unavailable: Error: Stream not available/);
    await allowBrowserError(/400 GET .*\/stalker\/play/);

    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible({ timeout: 10000 });
    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:00:00:01");
    await appPage.getByRole("button", { name: /Connect .*→/ }).click();
    await appPage.locator(".sidebar .nav", { hasText: "Live TV" }).click();
    await expect(appPage.getByText("Stalker News")).toBeVisible({ timeout: 15000 });

    await appPage.getByText("Stalker News").click();
    await expect(appPage.getByTestId("playback-loading")).toHaveCount(0);
    await expect(appPage.getByText("Stream not available")).toBeVisible();
    await expect(appPage.locator(".player-ov")).toHaveCount(0);
  });

  test("shows feedback while Stalker catch-up resolves", async ({ appPage }) => {
    await setupStalkerTest(appPage, { handshake: "valid", playDelayMs: 1000, epg: "past-catchup" });

    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible({ timeout: 10000 });
    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:00:00:01");
    await appPage.getByRole("button", { name: /Connect/ }).click();
    await appPage.locator(".sidebar .nav", { hasText: "TV Guide" }).click();

    const pastProgram = appPage.locator("[data-prog-idx]").filter({ hasText: "Past News" });
    await expect(pastProgram).toBeVisible({ timeout: 15000 });
    await pastProgram.click();
    await expect(appPage.getByTestId("playback-loading")).toContainText("Stalker News - Past News");
    await expect(appPage.getByTestId("playback-loading")).toBeHidden({ timeout: 5000 });
  });

  test("shows feedback while a Stalker series episode resolves", async ({ appPage }) => {
    await setupStalkerTest(appPage, { handshake: "valid", playDelayMs: 1000, series: "one-episode" });

    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible({ timeout: 10000 });
    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:00:00:01");
    await appPage.getByRole("button", { name: /Connect/ }).click();
    await appPage.locator(".sidebar .nav", { hasText: "Series" }).click();

    await expect(appPage.getByText("Stalker Series", { exact: true })).toBeVisible({ timeout: 15000 });
    await appPage.getByText("Stalker Series", { exact: true }).click();
    await expect(appPage.getByText("Episode 1", { exact: true })).toBeVisible({ timeout: 10000 });
    await appPage.getByText("Episode 1", { exact: true }).click();
    await expect(appPage.getByTestId("playback-loading")).toContainText("Stalker Series - Season 1 E1");
    await expect(appPage.getByTestId("playback-loading")).toBeHidden({ timeout: 5000 });
  });

  test("direct TS URL is attempted first for TS content", async ({ appPage }) => {
    await setupStalkerTest(appPage, { handshake: "valid", createLink: "direct-ts" });

    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible({ timeout: 10000 });

    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:00:00:01");
    await appPage.getByRole("button", { name: /Connect →/ }).click();
    await appPage.locator(".sidebar .nav", { hasText: "Live TV" }).click();

    await expect(appPage.getByText("Stalker News")).toBeVisible({ timeout: 15000 });
    await appPage.getByText("Stalker News").click();

    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });

    const log = await getMediaLog(appPage);
    expect(log.mpegtsAttachCalls.length + log.nativePlayCalls.length).toBeGreaterThan(0);
  });

  test("VOD lookup resolves the clicked movie", async ({ appPage }) => {
    await setupStalkerTest(appPage, { handshake: "valid", createLink: "direct-file" });

    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible({ timeout: 10000 });

    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:00:00:01");
    await appPage.getByRole("button", { name: /Connect →/ }).click();
    await appPage.locator(".sidebar .nav", { hasText: "Live TV" }).click();

    await appPage.locator(".sidebar .nav", { hasText: "Movies" }).click();
    const movieItem = appPage.getByText("Stalker Movie");
    await expect(movieItem).toBeVisible({ timeout: 10000 });
    await movieItem.click();
    await expect(appPage.locator("video")).toBeVisible({ timeout: 10000 });
  });

  test("credentials do not appear in browser storage", async ({ appPage }) => {
    await setupStalkerTest(appPage, { handshake: "valid" });

    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible({ timeout: 10000 });

    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:00:00:01");
    await appPage.getByRole("button", { name: /Connect →/ }).click();
    await appPage.locator(".sidebar .nav", { hasText: "Live TV" }).click();

    await expect(appPage.getByText("Stalker News")).toBeVisible({ timeout: 15000 });

    // The MAC address should not appear in browser storage.
    await assertNoCredentialsInStorage(appPage, ["00:1A:79:00:00:01"]);
  });
});
