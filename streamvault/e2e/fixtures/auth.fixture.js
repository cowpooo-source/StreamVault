/**
 * Deterministic auth fixtures for Playwright browser tests.
 *
 * All endpoints are mocked via page.route() — no real auth provider is called.
 */

export const FAKE_USER = {
  id: 9001,
  username: "e2e-user",
  role: "regular",
  maxConnections: 5,
  limits: { maxConnections: 5 },
};

export const FAKE_GUEST = {
  id: 9002,
  username: "guest",
  role: "guest",
  maxConnections: 2,
  limits: { maxConnections: 2 },
};

/**
 * Mock GET /api/auth/me to return an authenticated user.
 */
export async function mockAuthenticatedUser(page, overrides = {}) {
  const user = { ...FAKE_USER, ...overrides };
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(user),
    }),
  );
  return user;
}

/**
 * Mock GET /api/auth/me to return a guest user (via localStorage flag).
 */
export async function mockGuestUser(page) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ status: 401, body: "{}" }),
  );
  // The app checks localStorage on mount for guest mode.
  await page.addInitScript(() => {
    localStorage.setItem("sv-guest-mode", "1");
  });
}

/**
 * Mock GET /api/auth/me to return 401 (logged out).
 */
export async function mockLoggedOutUser(page) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ status: 401, body: "{}" }),
  );
}

/**
 * Mock POST /api/auth/login to succeed with a user.
 */
export async function mockLoginSuccess(page, overrides = {}) {
  const user = { ...FAKE_USER, ...overrides };
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user }),
    }),
  );
  return user;
}

/**
 * Mock POST /api/auth/login to fail.
 */
export async function mockLoginFailure(page, message = "Invalid credentials") {
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: message }),
    }),
  );
}

/**
 * Mock POST /api/auth/register and retain the submitted request body.
 */
export async function mockRegistrationSuccess(page, overrides = {}) {
  const user = {
    ...FAKE_USER,
    id: 9003,
    username: "new-e2e-user",
    email: "new-user@example.test",
    role: "free",
    maxConnections: 2,
    limits: { maxConnections: 2 },
    emailVerified: false,
    ...overrides,
  };
  const requests = [];

  await page.route("**/api/auth/register", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user }),
    });
  });

  return { user, requests };
}

/**
 * Mock POST /api/auth/register to return a readable validation error.
 */
export async function mockRegistrationFailure(page, message = "Email already registered") {
  const requests = [];

  await page.route("**/api/auth/register", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: message }),
    });
  });

  return { requests };
}

/**
 * Mock POST /api/auth/guest to succeed.
 */
export async function mockGuestLoginSuccess(page) {
  const requests = [];
  await page.route("**/api/auth/guest", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  return { requests };
}

/**
 * Mock POST /api/auth/logout to succeed.
 */
export async function mockLogoutSuccess(page) {
  await page.route("**/api/auth/logout", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );
}

/**
 * Mock POST /api/auth/reset-password to succeed.
 */
export async function mockResetPasswordSuccess(page) {
  await page.route("**/api/auth/reset-password", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "Password reset successfully" }),
    }),
  );
}

/**
 * Stub the Cloudflare Turnstile widget so it never loads the real script.
 * Injects a minimal mock that calls the success callback immediately.
 */
export async function mockTurnstile(page) {
  await page.addInitScript(() => {
    window.turnstile = {
      render: () => "e2e-widget-id",
      reset: () => {},
      remove: () => {},
    };
  });
}

/**
 * Stub backend API routes so the mocked suite never hits a real backend.
 *
 * Only covers routes that auth fixtures do NOT handle:
 * /api/sync, /api/content-session, /api/play-token, /api/track.
 *
 * Playwright matches routes newest-first so no generic catch-all is added —
 * that would override the auth mocks registered before this call.
 */
export async function mockAppBackend(page, overrides = {}) {
  const { contentToken = "e2e-content-token" } = overrides;
  let activeConnection = null;

  // ── Sync ──────────────────────────────────────────────────────────────
  await page.route("**/api/sync/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );

  // ── Content session ──────────────────────────────────────────────────
  // Use a predicate so both /api/content-session (POST create) and
  // /api/content-session/* (GET validate, etc.) are matched.
  await page.route((url) => url.pathname.startsWith("/api/content-session"), (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return route.fulfill({ status: 204 });
    if (method === "POST") {
      const payload = route.request().postDataJSON();
      activeConnection = payload?.connection || null;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          token: contentToken,
          contentUrl: `/content?token=${contentToken}`,
          expiresAt: Date.now() + 30 * 60_000,
        }),
      });
    }
    if (method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          token: contentToken,
          valid: true,
          connection: activeConnection,
          expiresAt: Date.now() + 30 * 60_000,
        }),
      });
    }
    if (method === "DELETE") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  // ── Play token ───────────────────────────────────────────────────────
  await page.route("**/api/play-token*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "e2e-play-token" }) }),
  );

  // ── Track / analytics ────────────────────────────────────────────────
  await page.route("**/api/track*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );

  await page.route("**/api/playback/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );
}
