import { test, expect } from "./fixtures/app.fixture.js";
import { mockLoggedOutUser, mockLoginSuccess, mockTurnstile, mockAppBackend } from "./fixtures/auth.fixture.js";
import { installXtreamMock, installM3UMock, installStalkerMock } from "./fixtures/provider-mocks.js";

/**
 * Helper: log in and reach the setup screen.
 */
async function reachSetup(appPage) {
  await mockLoggedOutUser(appPage);
  await mockLoginSuccess(appPage);
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  // Pre-accept the disclaimer so it doesn't block connects.
  await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));
  await appPage.goto("/app");
  await appPage.getByPlaceholder("Username").fill("e2e-user");
  await appPage.getByPlaceholder("Password").fill("test-pass");
  await appPage.getByRole("button", { name: "Login" }).last().click();
  await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });
}

test.describe("Xtream connection setup", () => {
  test("adds a valid Xtream connection", async ({ appPage }) => {
    await reachSetup(appPage);
    installXtreamMock(appPage, { auth: "valid" });

    // Xtream Codes tab should be selected by default.
    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("test-user");
    await appPage.getByPlaceholder("password").fill("test-pass");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    // Should navigate past setup to the content view.
    await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });
  });

  test("invalid credentials show validation failure", async ({ appPage }) => {
    await reachSetup(appPage);
    installXtreamMock(appPage, { auth: "invalid" });

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("bad-user");
    await appPage.getByPlaceholder("password").fill("bad-pass");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText(/account is disabled/i)).toBeVisible({ timeout: 10000 });
  });

  test("expired account does not enter content", async ({ appPage }) => {
    await reachSetup(appPage);
    installXtreamMock(appPage, { auth: "expired" });

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("expired-user");
    await appPage.getByPlaceholder("password").fill("expired-pass");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText(/account has expired/i)).toBeVisible({ timeout: 10000 });
  });
});

test.describe("M3U connection setup", () => {
  test("adds a URL playlist", async ({ appPage }) => {
    await reachSetup(appPage);
    installM3UMock(appPage, { variant: "basic" });

    await appPage.getByRole("button", { name: "M3U Playlist" }).click();
    await appPage.getByPlaceholder("http://example.com/playlist.m3u").fill("http://provider.test/playlist.m3u");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText("News HD")).toBeVisible({ timeout: 15000 });
  });

  test("malformed M3U shows an error", async ({ appPage }) => {
    await reachSetup(appPage);
    installM3UMock(appPage, { variant: "malformed" });

    await appPage.getByRole("button", { name: "M3U Playlist" }).click();
    await appPage.getByPlaceholder("http://example.com/playlist.m3u").fill("http://provider.test/playlist.m3u");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText(/not a valid M3U playlist/i)).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Stalker connection setup", () => {
  test("adds a valid Stalker portal and MAC", async ({ appPage }) => {
    await reachSetup(appPage);
    installStalkerMock(appPage, { handshake: "valid" });

    // Mock the Stalker validate endpoint.
    await appPage.route("**/stalker/validate", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          portalReachable: true,
          status: "active",
          maxConnections: 2,
        }),
      }),
    );

    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:00:00:01");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    // Should load channels.
    await expect(appPage.getByText("Stalker News")).toBeVisible({ timeout: 15000 });
  });

  test("failed handshake shows validation failure", async ({ appPage }) => {
    await reachSetup(appPage);
    installStalkerMock(appPage, { handshake: "unauthorized" });

    await appPage.route("**/stalker/validate", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          portalReachable: true,
          status: "unregistered",
          error: "MAC address is not registered",
        }),
      }),
    );

    await appPage.getByRole("button", { name: "Stalker Portal" }).click();
    await appPage.getByPlaceholder("http://server/stalker_portal/c/").fill("http://portal.test");
    await appPage.getByPlaceholder("00:1A:79:XX:XX:XX").fill("00:1A:79:FF:FF:FF");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    await expect(appPage.getByText(/not registered|unauthorized|unreachable/i)).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Connection import", () => {
  test("import one valid connection via raw text", async ({ appPage }) => {
    await reachSetup(appPage);
    installXtreamMock(appPage, { auth: "valid" });

    await appPage.getByRole("button", { name: "Import" }).click();

    // Paste raw Xtream connection text.
    const textarea = appPage.getByPlaceholder(/Paste any text/);
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await textarea.fill("http://provider.test:8080 get user=test-user pass=test-pass");

    // The import form should detect at least one connection.
    await expect(appPage.getByText(/http:\/\/provider.test/)).toBeVisible({ timeout: 5000 });
  });
});
