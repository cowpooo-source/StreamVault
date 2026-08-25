import { test, expect } from "./fixtures/app.fixture.js";
import { mockAuthenticatedUser, mockTurnstile, mockAppBackend } from "./fixtures/auth.fixture.js";

async function setupLazyStalker(appPage, { unsupportedLive = false } = {}) {
  await mockAuthenticatedUser(appPage);
  await mockTurnstile(appPage);
  await mockAppBackend(appPage);
  await appPage.route("**/api/tmdb/**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ results: [] }),
  }));
  await appPage.addInitScript(() => {
    localStorage.setItem("sv-disclaimer-accepted", "1");
    localStorage.setItem("sv-analytics-consent", "denied");
  });
  await appPage.route("**/stalker/validate", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ portalReachable: true, status: "active", maxConnections: 2 }),
  }));
  await appPage.route("**/stalker/epg**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ programs: [] }),
  }));
  const connection = {
    id: "stalker:http://portal.test:00:1A:79:00:00:01",
    type: "stalker",
    label: "Test Stalker",
    config: { type: "stalker", server: "http://portal.test", mac: "00:1A:79:00:00:01" },
  };
  await appPage.route(url => url.pathname.startsWith("/api/content-session"), route => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ valid: true, connection, expiresAt: Date.now() + 1_800_000 }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "e2e-content-token", connection, contentUrl: "/content?token=e2e-content-token", expiresAt: Date.now() + 1_800_000 }) });
  });

  const requests = [];
  await appPage.route("**/stalker/catalog/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const kind = url.searchParams.get("kind");
    const category = url.searchParams.get("category") || "all";
    const page = Number(url.searchParams.get("page") || 1);
    requests.push({ path: url.pathname, kind, category, page });

    if (url.pathname.endsWith("/categories")) {
      const categories = kind === "live"
        ? ["live-10", "live-11", "live-12"].map((id, index) => ({ id, title: `Live Group ${index + 1}` }))
        : kind === "vod"
        ? ["10", "11", "12", "13", "14"].map((id, index) => ({ id, title: `Movies ${index + 1}` }))
        : ["20", "21", "22", "23", "24"].map((id, index) => ({ id, title: `Series ${index + 1}` }));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ kind, categories, capabilities: { pagination: "supported", search: "unknown" } }),
      });
    }

    if (url.pathname.endsWith("/items")) {
      const id = kind === "live" ? `live-${page}` : `${kind}-${category}-${page}`;
      const itemCount = kind === "live" && page === 1 ? 50 : 1;
      const items = Array.from({ length: itemCount }, (_, index) => ({
        id: `${id}-${index + 1}`,
        name: kind === "live" ? `Lazy Live ${page}-${index + 1}` : `${kind === "vod" ? "Movie" : "Series"} ${category} ${page}`,
        type: kind,
        url: kind === "live" ? "http://provider.test/live.ts" : "http://provider.test/content.mp4",
      }));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kind,
          category,
          page,
          pageSize: 100,
          items,
          hasMore: !unsupportedLive && page === 1,
          nextPage: !unsupportedLive && page === 1 ? 2 : null,
          total: unsupportedLive && kind === "live" ? itemCount : 2,
          totalKnown: true,
          complete: unsupportedLive && kind === "live" ? true : page !== 1,
          capabilities: unsupportedLive && kind === "live"
            ? { pagination: "unsupported", mode: "bounded_live_snapshot", search: "unknown" }
            : { pagination: "supported", search: "unknown" },
        }),
      });
    }

    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unexpected catalog route" }) });
  });

  return requests;
}

async function connectStalker(appPage) {
  await appPage.goto("/content?token=e2e-content-token");
  await expect(appPage.locator(".sidebar .nav", { hasText: "Live TV" })).toBeVisible({ timeout: 10000 });
}

test.describe("Stalker lazy catalog", () => {
  test("loads categories sequentially and fetches another page only on demand", async ({ appPage }) => {
    const requests = await setupLazyStalker(appPage);
    await connectStalker(appPage);

    await appPage.locator(".sidebar .nav", { hasText: "Live TV" }).click();
    await expect(appPage.getByText("Lazy Live 1-1", { exact: true })).toBeVisible({ timeout: 15000 });
    expect(requests.filter(request => request.path.endsWith("/categories")).map(request => request.kind)).toEqual(["live", "vod", "series"]);
    expect(requests.filter(request => request.path.endsWith("/items") && request.kind === "live").map(request => request.category)).toEqual(["live-10"]);
    expect(requests.filter(request => request.path.endsWith("/items")).map(request => request.kind)).toEqual(["live", "vod", "series"]);

    await appPage.getByText("Live Group 2", { exact: true }).click();
    await expect.poll(() => requests.filter(request => request.kind === "live" && request.category === "live-11" && request.page === 1).length).toBe(1);
    await appPage.locator(".epg-ch-cell:has(.c-btn)").click();
    await expect.poll(() => requests.filter(request => request.kind === "live" && request.category === "live-11" && request.page === 2).length).toBe(1);
    await expect(appPage.getByText("Lazy Live 2-1", { exact: true })).toBeVisible();

    await appPage.locator(".sidebar .nav", { hasText: "Movies" }).click();
    await expect(appPage.getByText("Movie 10 1")).toBeVisible({ timeout: 15000 });
    expect(requests.filter(request => request.path.endsWith("/items") && request.kind === "vod" && request.page === 2)).toHaveLength(0);

    await appPage.getByRole("button", { name: "Load more" }).click();
    await expect.poll(() => requests.filter(request => request.kind === "vod" && request.page === 2).length).toBe(1);
  });

  test("discovery samples a bounded number of categories", async ({ appPage }) => {
    const requests = await setupLazyStalker(appPage);
    await connectStalker(appPage);
    await appPage.locator(".sidebar .nav", { hasText: "Discover" }).click();

    await expect(appPage.getByTestId("stalker-discovery")).toBeVisible({ timeout: 15000 });
    await expect(appPage.getByText("Suggestions from your provider")).toBeVisible();
    await expect.poll(() => requests.filter(request => request.path.endsWith("/items") && ["vod", "series"].includes(request.kind)).length).toBeLessThanOrEqual(9);
    expect(requests.filter(request => request.path.endsWith("/items") && request.kind === "vod").length).toBeLessThanOrEqual(4);
    expect(requests.filter(request => request.path.endsWith("/items") && request.kind === "series").length).toBeLessThanOrEqual(4);
  });

  test("does not probe provider search while capability is unknown", async ({ appPage }) => {
    const requests = await setupLazyStalker(appPage);
    await connectStalker(appPage);
    await appPage.locator(".sidebar .nav", { hasText: "Global Search" }).click();
    await appPage.getByPlaceholder(/Search everything/i).fill("movie");

    await expect.poll(() => requests.filter(request => request.path.endsWith("/search")).length, { timeout: 2000 }).toBe(0);
  });

  test("shows bounded snapshot loading state for an unsupported live portal", async ({ appPage }) => {
    const requests = await setupLazyStalker(appPage, { unsupportedLive: true });
    await connectStalker(appPage);

    await appPage.locator(".sidebar .nav", { hasText: "Live TV" }).click();
    await expect(appPage.getByText("Lazy Live 1-1", { exact: true })).toBeVisible({ timeout: 15000 });
    expect(requests.find(request => request.kind === "live" && request.page === 1)).toMatchObject({ kind: "live", page: 1 });
    expect(requests.filter(request => request.path.endsWith("/items") && request.kind === "live" && request.page > 1)).toHaveLength(0);
  });
});
