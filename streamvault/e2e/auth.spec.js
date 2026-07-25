import { test, expect } from "./fixtures/app.fixture.js";
import {
  mockAuthenticatedUser,
  mockLoggedOutUser,
  mockLoginSuccess,
  mockLoginFailure,
  mockGuestLoginSuccess,
  mockLogoutSuccess,
  mockResetPasswordSuccess,
  mockTurnstile,
} from "./fixtures/auth.fixture.js";

test.describe("Authentication flows", () => {
  test("displays login when /api/auth/me returns 401", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven")).toBeVisible();
    await expect(appPage.getByPlaceholder("Username")).toBeVisible();
    await expect(appPage.getByPlaceholder("Password")).toBeVisible();
  });

  test("valid login reaches the setup screen", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await mockLoginSuccess(appPage);
    await mockTurnstile(appPage);
    await appPage.goto("/app");

    await appPage.getByPlaceholder("Username").fill("e2e-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();

    // After login the Setup screen loads with connection options.
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });
    await expect(appPage.getByText("Xtream Codes")).toBeVisible();
  });

  test("invalid login shows a readable error", async ({ appPage, allowBrowserError }) => {
    allowBrowserError(/^401 POST https?:\/\/[^/]+\/api\/auth\/login$/);
    await mockLoggedOutUser(appPage);
    await mockLoginFailure(appPage, "Invalid credentials");
    await mockTurnstile(appPage);
    await appPage.goto("/app");

    await appPage.getByPlaceholder("Username").fill("bad-user");
    await appPage.getByPlaceholder("Password").fill("bad-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();

    await expect(appPage.getByText("Invalid credentials")).toBeVisible();
  });

  test("guest login reaches the setup screen", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await mockGuestLoginSuccess(appPage);
    await appPage.goto("/app");

    // The Guest button is below the login form.
    await appPage.getByRole("button", { name: /guest/i }).click();

    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });
  });

  test("logout returns to /app login screen", async ({ appPage }) => {
    await mockAuthenticatedUser(appPage);
    await mockLogoutSuccess(appPage);
    await appPage.goto("/app");

    // Should see the setup screen first.
    await expect(appPage.getByText("Portal Heaven")).toBeVisible({ timeout: 10000 });

    // Trigger logout — the app has a logout button in the settings/tools area.
    // Look for any logout mechanism. The header or tools menu should have it.
    const logoutBtn = appPage.getByRole("button", { name: /logout|sign out/i });
    await expect(logoutBtn).toBeVisible();
    await logoutBtn.click();

    // Should return to login screen.
    await expect(appPage.getByPlaceholder("Username")).toBeVisible({ timeout: 10000 });
  });

  test("?error=sso_failed displays the SSO error and cleans the URL", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await appPage.goto("/app?error=sso_failed");

    await expect(appPage.getByText("Single Sign-On failed")).toBeVisible();
    // The URL should have the error param removed.
    await expect(appPage).toHaveURL(/\/app(\?|$)/);
    await expect(appPage).not.toHaveURL(/error=/);
  });

  test("?error=email_exists displays the account-linking message", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await appPage.goto("/app?error=email_exists&provider=Google");

    await expect(
      appPage.getByText(/already registered.*link.*Google/i),
    ).toBeVisible();
    await expect(appPage).not.toHaveURL(/error=/);
  });

  test("?action=reset-password&token=test-token displays reset behavior", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await mockResetPasswordSuccess(appPage);
    await appPage.goto("/app?action=reset-password&token=test-token");

    // The reset password modal should appear.
    await expect(appPage.getByText("Reset Password")).toBeVisible({ timeout: 10000 });

    // Fill and submit the form.
    await appPage.getByPlaceholder("New Password").fill("new-secure-pass");
    await appPage.getByPlaceholder("Confirm Password").fill("new-secure-pass");
    await appPage.getByRole("button", { name: "Reset" }).click();

    await expect(appPage.getByText("Password successfully reset")).toBeVisible();
  });

  test("turnstile unavailable shows expected UI and does not throw", async ({ appPage, allowBrowserError }) => {
    await mockLoggedOutUser(appPage);

    // Block the Cloudflare Turnstile script so the "unavailable" path is deterministic.
    await appPage.route("**/challenges.cloudflare.com/**", (route) => route.abort("connectionrefused"));
    // The Turnstile script failure produces a console error we expect.
    await allowBrowserError(/challenges.cloudflare.com/);
    await allowBrowserError("Failed to load resource: net::ERR_CONNECTION_REFUSED");

    await appPage.goto("/app");

    // The auth screen should still render without crashing.
    await expect(appPage.getByPlaceholder("Username")).toBeVisible();
    // The turnstile unavailable message should eventually appear.
    await expect(
      appPage.getByText(/verification.*unavailable/i),
    ).toBeVisible({ timeout: 8000 });
  });
});
