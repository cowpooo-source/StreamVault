import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { render, waitFor } from "@testing-library/react";

const harness = vi.hoisted(() => ({
  requests: [],
  fetch: vi.fn(),
  db: {
    get: vi.fn(async (_key, fallback = null) => fallback),
    set: vi.fn(async () => {}),
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
}));

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
    return jsonResponse({
      kind,
      categories: [
        { id: "all", title: "All", count: null },
        { id: kind === "vod" ? "vod-1" : "series-1", title: kind === "vod" ? "Movies" : "Shows", count: 1 },
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
    state: {
      connections: [harness.connection],
      activeConnId: harness.connection.id,
      favorites: { live: {}, vod: {}, series: {} },
      history: [],
      hydrated: true,
    },
    actions: {
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
  }),
}));

vi.mock("../src/stalker-catalog-cache.js", () => ({
  createStalkerCatalogCache: vi.fn(async () => ({
    scope: "test-scope",
    getCategories: vi.fn(async () => null),
    putCategories: vi.fn(async () => {}),
    getPage: vi.fn(async () => null),
    putPage: vi.fn(async () => {}),
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
      expect(harness.requests.some(url => url.includes("kind=live"))).toBe(true);
      expect(harness.requests.some(url => url.includes("kind=vod") && url.includes("/categories"))).toBe(true);
      expect(harness.requests.some(url => url.includes("kind=series") && url.includes("/categories"))).toBe(true);
    });

    expect(harness.requests).toContainEqual(expect.stringContaining("kind=live"));
    expect(harness.requests).not.toContainEqual(expect.stringMatching(/\/items\?.*kind=vod&category=/));
    expect(harness.requests).not.toContainEqual(expect.stringMatching(/\/items\?.*kind=series&category=/));
  });
});
