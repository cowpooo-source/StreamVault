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

/**
 * Helper: log in and reach the setup screen with a disclaimer pre-accepted.
 */
async function reachSetup(appPage) {
  await mockLoggedOutUser(appPage);
  await mockLoginSuccess(appPage);
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));
  await appPage.goto("/app");
  await appPage.getByPlaceholder("Username").fill("e2e-user");
  await appPage.getByPlaceholder("Password").fill("test-pass");
  await appPage.getByRole("button", { name: "Login" }).last().click();
  await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });
}

test.describe("Connection lifecycle", () => {
  test("open connection from setup navigates to content", async ({ appPage }) => {
    await reachSetup(appPage);
    installXtreamMock(appPage, { auth: "valid" });

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("test-user");
    await appPage.getByPlaceholder("password").fill("test-pass");
    await appPage.getByRole("button", { name: /Connect →/ }).click();

    // Should load channels — meaning we've left setup.
    await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });
  });

  test("disconnecting a newly opened connection returns to setup", async ({ appPage }) => {
    await reachSetup(appPage);
    await appPage.unroute("**/api/auth/me");
    await mockAuthenticatedUser(appPage);
    installXtreamMock(appPage, { auth: "valid" });

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("new-user");
    await appPage.getByPlaceholder("password").fill("new-pass");
    await appPage.getByRole("button", { name: /Connect/ }).click();

    await expect(appPage).toHaveURL(/\/content\?token=e2e-content-token/);
    await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });

    await appPage.getByRole("button", { name: /disconnect/i }).click();
    await expect(appPage).toHaveURL(/\/app/);
    await expect(appPage.getByRole("button", { name: /Xtream Codes/i })).toBeVisible({ timeout: 10000 });
  });

  test("disconnect returns to /app", async ({ appPage }) => {
    // Start authenticated so we go straight to setup.
    await mockAuthenticatedUser(appPage);
    await mockAppBackend(appPage);
    await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));

    // Pre-populate a saved connection so the app enters content mode.
    await appPage.addInitScript(() => {
      const conn = {
        id: "test-conn-1",
        type: "xtream",
        label: "Test Xtream",
        config: { type: "xtream", server: "http://provider.test", user: "test-user", pass: "test-pass" },
      };
      localStorage.setItem("sv-connections", JSON.stringify([conn]));
      localStorage.setItem("sv-activeConn", JSON.stringify("test-conn-1"));
    });

    installXtreamMock(appPage, { auth: "valid" });
    await appPage.goto("/app");

    // Wait for content to load.
    await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });

    // Find and click the disconnect button.
    const disconnectBtn = appPage.getByRole("button", { name: /disconnect/i });
    await expect(disconnectBtn).toBeVisible();
    await disconnectBtn.click();

    // After disconnect, the URL should be /app (local assertion).
    await expect(appPage).toHaveURL(/\/app/);
  });

  test("logout returns to /app login screen", async ({ appPage }) => {
    await mockAuthenticatedUser(appPage);
    await mockLogoutSuccess(appPage);
    await mockAppBackend(appPage);
    await appPage.goto("/app");

    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    // Find logout.
    const logoutBtn = appPage.getByRole("button", { name: /logout|sign out/i });
    await expect(logoutBtn).toBeVisible();
    await logoutBtn.click();

    // Should return to login screen.
    await expect(appPage.getByPlaceholder("Username")).toBeVisible({ timeout: 10000 });
    await expect(appPage).toHaveURL(/\/app/);
  });

  test("switch connection shows saved connections list", async ({ appPage }) => {
    await mockAuthenticatedUser(appPage);
    await mockAppBackend(appPage);
    await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));

    // Pre-populate multiple connections.
    await appPage.addInitScript(() => {
      const conns = [
        { id: "conn-1", type: "xtream", label: "Xtream One", config: { type: "xtream", server: "http://provider.test", user: "user1", pass: "pass1" } },
        { id: "conn-2", type: "xtream", label: "Xtream Two", config: { type: "xtream", server: "http://provider.test", user: "user2", pass: "pass2" } },
      ];
      localStorage.setItem("sv-connections", JSON.stringify(conns));
      localStorage.setItem("sv-activeConn", JSON.stringify("conn-1"));
    });

    installXtreamMock(appPage, { auth: "valid" });
    await appPage.goto("/app");

    await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });

    // Find the saved connections / switch button.
    const switchBtn = appPage.locator(".conn-card").filter({
      has: appPage.locator(".conn-card-switch"),
    });
    await expect(switchBtn).toBeVisible();
    await switchBtn.click();
    const manager = appPage.locator(".modal");
    await expect(manager.getByText("Xtream One", { exact: true })).toBeVisible();
    await expect(manager.getByText("Xtream Two", { exact: true })).toBeVisible();
  });
});
