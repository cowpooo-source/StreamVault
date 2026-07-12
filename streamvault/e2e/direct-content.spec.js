import { expect, test } from "@playwright/test";

test.describe("Direct content session", () => {
  test("validates an HTTP session without persisting provider credentials", async ({ page }) => {
    const providerRequests = [];

    await page.route("**/api/content-session/validate?token=direct-session", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          connection: {
            id: "direct-xtream",
            type: "xtream",
            label: "Direct provider",
            config: {
              type: "xtream",
              server: "http://provider.test",
              user: "direct-user",
              pass: "direct-password",
            },
          },
          expiresAt: Date.now() + 60_000,
        }),
      });
    });

    await page.route("**/proxy?url=**", async (route) => {
      const proxiedUrl = new URL(route.request().url());
      const requestUrl = new URL(proxiedUrl.searchParams.get("url"));
      providerRequests.push(requestUrl.toString());
      const action = requestUrl.searchParams.get("action");
      const body = action === "get_live_categories"
        ? [{ category_id: "1", category_name: "News" }]
        : action === "get_live_streams"
          ? [{ stream_id: 101, name: "Direct Channel", category_id: "1", stream_icon: "" }]
          : { user_info: { auth: 1 } };
      await route.fulfill({
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(body),
      });
    });

    await page.goto("/content?token=direct-session");

    await expect(page).toHaveURL(/\/content$/);
    await expect(page.getByText("Direct Channel", { exact: false })).toBeVisible();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("sv-content-session-token"))).toBe("direct-session");

    const persisted = await page.evaluate(() => ({
      localStorage: Object.values(localStorage),
      sessionStorage: Object.entries(sessionStorage).filter(([key]) => key !== "sv-content-session-token"),
    }));
    const persistedText = JSON.stringify(persisted);

    expect(persistedText).not.toContain("direct-user");
    expect(persistedText).not.toContain("direct-password");
    expect(providerRequests.some((url) => url.includes("player_api.php"))).toBe(true);
  });
});
