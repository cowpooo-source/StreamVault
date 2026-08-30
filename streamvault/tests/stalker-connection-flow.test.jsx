import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const harness = vi.hoisted(() => {
  const hiddenCats = { live: [], vod: [], series: [] };
  return {
    requests: [],
    fetch: vi.fn(),
    hiddenCats,
    db: {
      get: vi.fn(async (key, fallback = null) => key === "sv-hiddenCats" ? hiddenCats : fallback),
      set: vi.fn(async () => {}),
    },
    streamVaultState: {
      connections: [],
      activeConnId: null,
      favorites: { live: {}, vod: {}, series: {} },
      history: [],
      hydrated: true,
    },
    streamVaultActions: {
      setConnections: vi.fn(),
      setActiveConnId: vi.fn(),
      setFavorites: vi.fn(),
      setHistory: vi.fn(),
      addConnection: vi.fn(),
      removeConnection: vi.fn(),
      updateConnection: vi.fn(),
      toggleFavorite: vi.fn(),
      addHistory: vi.fn(),
    },
    connection: {
    id: "stalker-1",
    type: "stalker",
    label: "Test Stalker",
    color: "#4a90d9",
    config: {
      type: "stalker",
      server: "http://portal.example/c",
      mac: "00:11:22:33:44:55",
      serial: "SERIAL-1",
      deviceId: "DEVICE-1",
      deviceId2: "DEVICE-2",
    },
    },
  };
});

harness.streamVaultState.connections = [harness.connection];
harness.streamVaultState.activeConnId = harness.connection.id;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function catalogResponse(url) {
  const parsed = new URL(url, "http://test.local");
  if (parsed.pathname.endsWith("/categories")) {
    const kind = parsed.searchParams.get("kind");
    if (!kind && parsed.pathname.endsWith("/stalker/vod/categories")) {
      return jsonResponse({
        categories: [
          { id: "all", title: "All" },
          { id: "vod-20", title: "Movies" },
        ],
      });
    }
    if (!kind && parsed.pathname.endsWith("/stalker/series/categories")) {
      return jsonResponse({
        categories: [
          { id: "all", title: "All" },
          { id: "series-20", title: "Shows" },
        ],
      });
    }
    return jsonResponse({
      kind,
      categories: [
        { id: "all", title: "All", count: null },
        { id: kind === "vod" ? "vod-1" : "series-1", title: kind === "vod" ? "Movies" : "Shows", count: 1 },
        { id: kind === "vod" ? "vod-2" : "series-2", title: kind === "vod" ? "Archive" : "Classics", count: 1 },
      ],
    });
  }
  return jsonResponse({
    kind: parsed.searchParams.get("kind"),
    category: parsed.searchParams.get("category"),
    page: 1,
    pageSize: 100,
    items: [{ id: "live-1", name: "Test Channel", cmd: "http://stream.example/live.ts" }],
    hasMore: false,
    nextPage: null,
    total: 1,
    totalKnown: true,
    complete: true,
  });
}

function requestUrls() {
  return [
    ...harness.requests,
    ...harness.fetch.mock.calls.map(([url]) => String(url)),
  ];
}

function isCatalogItemsRequest(url, kind) {
  const parsed = new URL(url, "http://test.local");
  return parsed.pathname.endsWith("/items") && parsed.searchParams.get("kind") === kind;
}

function isLegacyItemsRequest(url, kind) {
  const parsed = new URL(url, "http://test.local");
  return parsed.pathname.endsWith(`/stalker/${kind}`) && parsed.searchParams.has("cat");
}

vi.mock("../src/app-runtime.js", () => ({
  GUEST_ID: "guest-test",
  authHeaders: (headers = {}) => headers,
  authFetch: (url, options) => {
    harness.requests.push(String(url));
    return harness.fetch(url, options);
  },
  track: vi.fn(),
  db: harness.db,
  proxyFetch: vi.fn(),
  safeJsonFetch: async response => response.json(),
  makeXtreamAPI: vi.fn(),
}));

vi.mock("../src/app-session.js", () => ({
  hydrateContentSession: vi.fn(async () => ({ connection: harness.connection })),
}));

vi.mock("../src/direct-content-session.js", () => ({
  clearContentSessionToken: vi.fn(),
  contentSessionToken: () => "content-token",
  getAppHomeUrl: () => "http://secure.test/app",
  isHttpContentMode: () => true,
  maybeOpenDirectContentSession: vi.fn(),
  navigateToAppHome: vi.fn(),
  refreshContentSession: vi.fn(),
  shouldUseTokenPlayerForItem: () => false,
}));

vi.mock("../src/useStreamVault.js", () => ({
  useStreamVault: () => ({
    state: harness.streamVaultState,
    actions: harness.streamVaultActions,
  }),
}));

vi.mock("../src/stalker-catalog-cache.js", () => ({
  createStalkerCatalogCache: vi.fn(async () => ({
    scope: "test-scope",
    getCategories: vi.fn(async () => null),
    putCategories: vi.fn(async () => {}),
    getPage: vi.fn(async () => null),
    putPage: vi.fn(async () => {}),
    invalidateScope: vi.fn(async () => {}),
    clearOwner: vi.fn(async () => {}),
    clearConnection: vi.fn(async () => {}),
  })),
}));

vi.mock("../src/stalker-catalog-identity.js", () => ({
  stalkerCatalogConnectionFingerprint: vi.fn(async () => "connection-fingerprint"),
}));

vi.mock("../src/components/Player.jsx", () => ({ default: () => null }));
vi.mock("../src/components/PlaybackLoadingOverlay.jsx", () => ({ default: () => null }));
vi.mock("../src/components/DirectHLSView.jsx", () => ({ default: () => null }));
vi.mock("../src/components/TimelineGrid.jsx", () => ({ default: () => null }));
vi.mock("../src/components/VirtualGrid.jsx", () => ({ default: () => null }));
vi.mock("../src/components/AuthScreen.jsx", () => ({ default: () => null }));
vi.mock("../src/components/SettingsView.jsx", () => ({ default: () => null }));
vi.mock("../src/components/DiscoverView.jsx", () => ({ default: () => null }));
vi.mock("../src/components/Setup.jsx", () => ({ default: () => null }));
vi.mock("../src/components/AccountSettingsModal.jsx", () => ({ default: () => null }));
vi.mock("../src/components/ComparePlansDialog.jsx", () => ({ default: () => null }));

describe("Stalker connection activation", () => {
  it("does not request VOD or Series item pages during activation", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_STALKER_LAZY_CATALOG_ENABLED", "true");
    vi.stubGlobal("fetch", harness.fetch);
    harness.requests.length = 0;
    harness.fetch.mockReset();
    harness.fetch.mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/stalker/catalog/v1/")) return catalogResponse(requestUrl);
      if (requestUrl.includes("/stalker/epg")) return jsonResponse({ programs: {} });
      return jsonResponse({});
    });
    window.history.pushState({}, "", "/content?token=content-token");

    const { default: App } = await import("../src/App.jsx");
    render(<App />);

    await waitFor(() => {
      const urls = requestUrls();
      expect(urls.some(url => url.includes("kind=live"))).toBe(true);
      expect(urls.some(url => url.includes("kind=vod") && url.includes("/categories"))).toBe(true);
      expect(urls.some(url => url.includes("kind=series") && url.includes("/categories"))).toBe(true);
    });

    const urls = requestUrls();
    expect(urls).toContainEqual(expect.stringContaining("kind=live"));
    expect(urls.some(url => isCatalogItemsRequest(url, "vod"))).toBe(false);
    expect(urls.some(url => isCatalogItemsRequest(url, "series"))).toBe(false);
  });

  it("keeps the existing background catalog behavior when lazy loading is disabled", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_STALKER_LAZY_CATALOG_ENABLED", "false");
    vi.stubGlobal("fetch", harness.fetch);
    harness.requests.length = 0;
    harness.fetch.mockReset();
    harness.fetch.mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/stalker/catalog/v1/")) return catalogResponse(requestUrl);
      if (requestUrl.includes("/stalker/epg")) return jsonResponse({ programs: {} });
      return jsonResponse({});
    });
    window.history.pushState({}, "", "/content?token=content-token");

    const { default: App } = await import("../src/App.jsx");
    render(<App />);

    await waitFor(() => {
      const urls = requestUrls();
      expect(urls.some(url => new URL(url, "http://test.local").pathname.endsWith("/stalker/channels"))).toBe(true);
      expect(urls.some(url => new URL(url, "http://test.local").pathname.endsWith("/stalker/vod/categories"))).toBe(true);
      expect(urls.some(url => new URL(url, "http://test.local").pathname.endsWith("/stalker/series/categories"))).toBe(true);
    });

    const urls = requestUrls();
    expect(urls.some(url => isCatalogItemsRequest(url, "vod"))).toBe(false);
    expect(urls.some(url => isCatalogItemsRequest(url, "series"))).toBe(false);
    expect(urls.some(url => isLegacyItemsRequest(url, "vod"))).toBe(false);
    expect(urls.some(url => isLegacyItemsRequest(url, "series"))).toBe(false);
  });

  it("loads the selected legacy VOD category when lazy loading is disabled", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_STALKER_LAZY_CATALOG_ENABLED", "false");
    vi.stubGlobal("fetch", harness.fetch);
    harness.requests.length = 0;
    harness.fetch.mockReset();
    harness.fetch.mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/stalker/")) return catalogResponse(requestUrl);
      return jsonResponse({});
    });
    window.history.pushState({}, "", "/content?token=content-token");

    const { default: App } = await import("../src/App.jsx");
    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText("Movies").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText("Movies")[0]);

    await waitFor(() => {
      expect(document.querySelector('.cats .cat[title="Movies"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('.cats .cat[title="Movies"]'));

    await waitFor(() => {
      expect(requestUrls().some(url => {
        const parsed = new URL(url, "http://test.local");
        return parsed.pathname.endsWith("/stalker/vod")
          && parsed.searchParams.get("cat") === "vod-20";
      })).toBe(true);
    });
  });

  it("refreshes only the selected lazy category without clearing the category panel", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_STALKER_LAZY_CATALOG_ENABLED", "true");
    vi.stubGlobal("fetch", harness.fetch);
    harness.requests.length = 0;
    harness.fetch.mockReset();
    harness.fetch.mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/stalker/catalog/v1/")) return catalogResponse(requestUrl);
      if (requestUrl.includes("/stalker/epg")) return jsonResponse({ programs: {} });
      return jsonResponse({});
    });
    window.history.pushState({}, "", "/content?token=content-token");

    const { default: App } = await import("../src/App.jsx");
    render(<App />);

    await waitFor(() => expect(screen.getAllByText("Movies").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("Movies")[0]);
    await waitFor(() => expect(document.querySelector('.cats .cat[title="Movies"]')).not.toBeNull());
    fireEvent.click(document.querySelector('.cats .cat[title="Archive"]'));

    await waitFor(() => expect(requestUrls().some(url => {
      const parsed = new URL(url, "http://test.local");
      return isCatalogItemsRequest(url, "vod") && parsed.searchParams.get("category") === "vod-2";
    })).toBe(true));

    const refreshButton = screen.getByTitle("Reload from portal");
    fireEvent.click(refreshButton);

    await waitFor(() => expect(requestUrls().some(url => {
      const parsed = new URL(url, "http://test.local");
      return isCatalogItemsRequest(url, "vod")
        && parsed.searchParams.get("category") === "vod-2"
        && parsed.searchParams.get("refresh") === "1";
    })).toBe(true));

    const refreshedUrls = requestUrls().filter(url => new URL(url, "http://test.local").searchParams.get("refresh") === "1");
    expect(refreshedUrls.some(url => {
      const parsed = new URL(url, "http://test.local");
      return isCatalogItemsRequest(url, "vod") && parsed.searchParams.get("category") === "vod-1";
    })).toBe(false);
    expect(document.querySelector('.cats .cat[title="Archive"]')?.classList.contains("on")).toBe(true);
  });
});
