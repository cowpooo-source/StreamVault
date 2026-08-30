import { test, expect } from "./fixtures/app.fixture.js";
import { mockAuthenticatedUser, mockTurnstile, mockAppBackend } from "./fixtures/auth.fixture.js";

test("lazy activation requests one live category and no aggregate catalog", async ({ appPage }) => {
  await mockAuthenticatedUser(appPage);
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  await appPage.addInitScript(() => {
    localStorage.setItem("sv-disclaimer-accepted", "1");
    localStorage.setItem("sv-analytics-consent", "denied");
  });

  const connection = {
    id: "stalker:http://portal.test:00:1A:79:00:00:01",
    type: "stalker",
    label: "Lazy test portal",
    config: { type: "stalker", server: "http://portal.test", mac: "00:1A:79:00:00:01" },
  };
  const requests = [];
  const forbidden = [];

  await appPage.route((url) => url.pathname.startsWith("/api/content-session"), (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ valid: true, connection, expiresAt: Date.now() + 1_800_000 }),
  }));
  await appPage.route("**/stalker/validate", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ portalReachable: true, status: "active", maxConnections: 2 }),
  }));
  await appPage.route("**/stalker/epg**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ programs: [] }),
  }));
  await appPage.route("**/stalker/catalog/v1/**", (route) => {
    const url = new URL(route.request().url());
    const kind = url.searchParams.get("kind");
    const category = url.searchParams.get("category") || "all";
    const page = Number(url.searchParams.get("page") || 1);
    const mode = route.request().headers()["x-streamvault-catalog-mode"];
    requests.push({ path: url.pathname, kind, category, page, mode });

    if (url.pathname.endsWith("/categories")) {
      const categories = kind === "live"
        ? [{ id: "live-1", title: "Live News" }]
        : [{ id: `${kind}-1`, title: kind === "vod" ? "Movies" : "Series" }];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ kind, categories, capabilities: { pagination: "supported", search: "unknown" } }),
      });
    }

    if (url.pathname.endsWith("/items")) {
      const aggregate = ["all", "*"].includes(String(category).toLowerCase());
      if (aggregate || !["live-1"].includes(category)) forbidden.push(url.pathname + url.search);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kind,
          category,
          page,
          pageSize: 100,
          items: kind === "live" && category === "live-1" ? [{ id: "channel-1", name: "Live News", type: "live", url: "http://provider.test/live.ts" }] : [],
          hasMore: false,
          nextPage: null,
          total: 1,
          totalKnown: true,
          complete: true,
          capabilities: { pagination: "supported", search: "unknown" },
        }),
      });
    }

    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unexpected catalog route" }) });
  });

  await appPage.goto("/content?token=e2e-content-token");
  await expect(appPage.locator(".sidebar .nav", { hasText: "Live TV" })).toBeVisible({ timeout: 15000 });
  await appPage.locator(".sidebar .nav", { hasText: "Live TV" }).click();
  await expect(appPage.getByText("Live News", { exact: true })).toBeVisible({ timeout: 15000 });

  expect(requests.filter((request) => request.path.endsWith("/categories")).every((request) => request.mode === "lazy-v1")).toBe(true);
  expect(requests.filter((request) => request.path.endsWith("/items")).map((request) => [request.kind, request.category])).toEqual([["live", "live-1"]]);
  expect(forbidden).toEqual([]);
});
