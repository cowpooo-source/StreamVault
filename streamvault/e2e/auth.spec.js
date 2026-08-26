import { test, expect } from "./fixtures/app.fixture.js";
import {
  mockAuthenticatedUser,
  mockLoggedOutUser,
  mockLoginSuccess,
  mockLoginFailure,
  mockRegistrationSuccess,
  mockRegistrationFailure,
  mockGuestLoginSuccess,
  mockLogoutSuccess,
  mockResetPasswordSuccess,
  mockTurnstile,
  mockAppBackend,
} from "./fixtures/auth.fixture.js";
import { installXtreamMock } from "./fixtures/provider-mocks.js";

test.describe("Authentication flows", () => {
  test("displays login when /api/auth/me returns 401", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await appPage.goto("/app");
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible();
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
    await expect(appPage.getByText("Portal Heaven", { exact: true })).toBeVisible({ timeout: 10000 });
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

  test("new user registration sends email data and receives the user response", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    const registration = await mockRegistrationSuccess(appPage, {
      username: "registered-user",
      email: "registered@example.test",
    });
    await mockTurnstile(appPage);
    await appPage.goto("/app");

    await appPage.getByRole("button", { name: "Register" }).click();
    await appPage.getByPlaceholder("Username").fill("registered-user");
    await appPage.getByPlaceholder("email@example.com").fill("registered@example.test");
    await appPage.getByPlaceholder("Password").fill("correct-horse-battery-staple");
    await appPage.getByRole("button", { name: "Create Account" }).click();

    await expect(appPage.getByText("Xtream Codes")).toBeVisible({ timeout: 10000 });
    await expect(appPage.getByText(/free.*0\/2 connections/i)).toBeVisible();
    expect(registration.user.role).toBe("free");
    expect(registration.requests).toHaveLength(1);
    expect(registration.requests[0]).toMatchObject({
      username: "registered-user",
      email: "registered@example.test",
      password: "correct-horse-battery-staple",
    });
  });

  test("registration displays a duplicate-email response", async ({ appPage, allowBrowserError }) => {
    allowBrowserError(/^400 POST https?:\/\/[^/]+\/api\/auth\/register$/);
    await mockLoggedOutUser(appPage);
    const registration = await mockRegistrationFailure(appPage);
    await mockTurnstile(appPage);
    await appPage.goto("/app");

    await appPage.getByRole("button", { name: "Register" }).click();
    await appPage.getByPlaceholder("Username").fill("duplicate-user");
    await appPage.getByPlaceholder("email@example.com").fill("existing@example.test");
    await appPage.getByPlaceholder("Password").fill("correct-horse-battery-staple");
    await appPage.getByRole("button", { name: "Create Account" }).click();

    await expect(appPage.getByText("Email already registered")).toBeVisible();
    expect(registration.requests).toHaveLength(1);
    await expect(appPage.getByRole("button", { name: "Create Account" })).toBeVisible();
  });

  test("guest can enter setup, connect, and send a stable guest ID", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    const guestLogin = await mockGuestLoginSuccess(appPage);
    await mockTurnstile(appPage);
    await mockAppBackend(appPage);
    installXtreamMock(appPage, { auth: "valid" });
    await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));

    let contentSessionGuestId = null;
    appPage.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/content-session") {
        contentSessionGuestId = request.headers()["x-guest-id"] || null;
      }
    });

    await appPage.goto("/app");
    await appPage.getByRole("button", { name: /guest/i }).click();
    await expect(appPage.getByText("Xtream Codes")).toBeVisible({ timeout: 10000 });
    expect(guestLogin.requests).toEqual([{}]);

    const guestState = await appPage.evaluate(() => ({
      mode: localStorage.getItem("sv-guest-mode"),
      id: localStorage.getItem("sv-guest-id"),
    }));
    expect(guestState.mode).toBe("1");
    expect(guestState.id).toBeTruthy();

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("guest-provider-user");
    await appPage.getByPlaceholder("password").fill("guest-provider-pass");
    await appPage.getByRole("button", { name: /Connect/ }).click();

    await expect(appPage.getByText("News Channel")).toBeVisible({ timeout: 15000 });
    expect(contentSessionGuestId).toBe(guestState.id);
  });

  test("guest mode survives a page reload without another guest login request", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    const guestLogin = await mockGuestLoginSuccess(appPage);
    await mockTurnstile(appPage);
    await appPage.goto("/app");

    await appPage.getByRole("button", { name: /guest/i }).click();
    await expect(appPage.getByText("Xtream Codes")).toBeVisible({ timeout: 10000 });
    const guestId = await appPage.evaluate(() => localStorage.getItem("sv-guest-id"));

    await appPage.reload();

    await expect(appPage.getByText("Xtream Codes")).toBeVisible({ timeout: 10000 });
    expect(guestLogin.requests).toHaveLength(1);
    expect(await appPage.evaluate(() => localStorage.getItem("sv-guest-mode"))).toBe("1");
    expect(await appPage.evaluate(() => localStorage.getItem("sv-guest-id"))).toBe(guestId);
  });

  test("guest logout clears guest mode and returns to login", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await mockGuestLoginSuccess(appPage);
    await mockTurnstile(appPage);
    await mockLogoutSuccess(appPage);
    await appPage.goto("/app");

    await appPage.getByRole("button", { name: /guest/i }).click();
    await expect(appPage.getByText("Xtream Codes")).toBeVisible({ timeout: 10000 });
    await appPage.getByRole("button", { name: "Logout", exact: true }).click();

    await expect(appPage.getByPlaceholder("Username")).toBeVisible({ timeout: 10000 });
    expect(await appPage.evaluate(() => localStorage.getItem("sv-guest-mode"))).toBeNull();
  });

  test("guest remains on setup when provider validation fails", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await mockGuestLoginSuccess(appPage);
    await mockTurnstile(appPage);
    installXtreamMock(appPage, { auth: "invalid" });
    await appPage.addInitScript(() => localStorage.setItem("sv-disclaimer-accepted", "1"));
    await appPage.goto("/app");

    await appPage.getByRole("button", { name: /guest/i }).click();
    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("invalid-guest");
    await appPage.getByPlaceholder("password").fill("invalid-password");
    await appPage.getByRole("button", { name: /Connect/ }).click();

    await expect(appPage.getByText(/account is disabled/i)).toBeVisible({ timeout: 10000 });
    await expect(appPage.getByRole("button", { name: /Connect/ })).toBeVisible();
    expect(await appPage.evaluate(() => localStorage.getItem("sv-guest-mode"))).toBe("1");
  });

  test("guest cannot save more than two connections", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await mockGuestLoginSuccess(appPage);
    await mockTurnstile(appPage);
    installXtreamMock(appPage, { auth: "valid" });
    await appPage.addInitScript(() => {
      localStorage.setItem("sv-disclaimer-accepted", "1");
      const connections = [
        {
          id: "xtream:http://one.provider.test:user-one",
          type: "xtream",
          label: "Provider One",
          config: { type: "xtream", server: "http://one.provider.test", user: "user-one", pass: "pass-one" },
        },
        {
          id: "xtream:http://two.provider.test:user-two",
          type: "xtream",
          label: "Provider Two",
          config: { type: "xtream", server: "http://two.provider.test", user: "user-two", pass: "pass-two" },
        },
      ];
      localStorage.setItem("sv-connections", JSON.stringify(connections));
    });
    await appPage.goto("/app");

    await appPage.getByRole("button", { name: /guest/i }).click();
    await expect(appPage.getByText("Provider One")).toBeVisible({ timeout: 10000 });
    await expect(appPage.getByText("Provider Two")).toBeVisible();

    await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
    await appPage.getByPlaceholder("username").fill("third-user");
    await appPage.getByPlaceholder("password").fill("third-password");
    const limitDialog = new Promise((resolve) => {
      appPage.once("dialog", async (dialog) => {
        const message = dialog.message();
        await dialog.accept();
        resolve(message);
      });
    });
    await appPage.getByRole("button", { name: /Connect/ }).click();
    const dialogMessage = await limitDialog;

    expect(dialogMessage).toContain("Connection limit reached (2)");
    await expect(appPage.getByText("News Channel")).not.toBeVisible();
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
