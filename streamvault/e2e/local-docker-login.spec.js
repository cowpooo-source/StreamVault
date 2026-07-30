/* global process */
import { test, expect } from "@playwright/test";

const dockerTestEnabled = process.env.E2E_DOCKER === "1";
const username = process.env.E2E_LOCAL_USERNAME || "admin";
const password = process.env.E2E_LOCAL_PASSWORD || "Mango!123";

test.describe("Local Docker authentication", () => {
  test.skip(!dockerTestEnabled, "Run with E2E_DOCKER=1 against the local feature Docker stack");

  test("seeded admin can log in through the Docker gateway", async ({ page, context }) => {
    const baseUrl = new URL(test.info().project.use.baseURL || "");
    expect(baseUrl.hostname).toBe("127.0.0.1");
    expect(baseUrl.port).toBe("3201");

    await page.goto("/app");
    await expect(page.getByPlaceholder("Username")).toBeVisible();

    const loginResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/login"
    ));

    await page.getByPlaceholder("Username").fill(username);
    await page.getByPlaceholder("Password").fill(password);
    await page.getByRole("button", { name: "Login" }).last().click();

    await expect((await loginResponse).status()).toBe(200);

    const cookies = await context.cookies(baseUrl.origin);
    expect(cookies.some((cookie) => cookie.name === "sv_auth")).toBe(true);

    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/me", { credentials: "include" });
      return { status: response.status, body: await response.json() };
    });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ username, role: "admin" });

    await expect(page.getByText("Xtream Codes")).toBeVisible({ timeout: 10000 });
  });

  test("logout does not synchronize an empty connection snapshot", async ({ page }) => {
    await page.goto("/app");
    await page.getByPlaceholder("Username").fill(username);
    await page.getByPlaceholder("Password").fill(password);
    await page.getByRole("button", { name: "Login" }).last().click();
    await expect(page.getByText("Xtream Codes")).toBeVisible({ timeout: 10000 });

    const connectionSyncs = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/sync/connections") {
        connectionSyncs.push(request.postDataJSON());
      }
    });

    const logoutResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/logout"
    ));
    await page.getByRole("button", { name: "Logout" }).click();
    await expect((await logoutResponse).status()).toBe(200);
    await expect(page.getByPlaceholder("Username")).toBeVisible();
    await page.waitForTimeout(500);

    expect(connectionSyncs).toEqual([]);
  });
});
