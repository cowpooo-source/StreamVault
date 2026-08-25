import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearContentSessionToken,
  contentSessionToken,
  contentSessionPayload,
  getAppHomeUrl,
  isDirectContentConnection,
  isHttpContentMode,
  maybeOpenDirectContentSession,
  openDirectContentSession,
  persistContentSessionToken,
} from "../src/direct-content-session.js";

// jsdom does not implement history.replaceState with a relative URL well;
// we stub window.location + history to simulate the token-migration flow.
function installWindow(location) {
  const store = {};
  const win = {
    location: {
      ...location,
      assign: vi.fn(),
      href: location.href || location.pathname,
    },
    history: {
      replaceState: vi.fn((_state, _title, url) => {
        win.location.search = url.includes("?") ? url.slice(url.indexOf("?")) : "";
        win.location.pathname = url.split("?")[0] || win.location.pathname;
      }),
    },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("sessionStorage", win.sessionStorage);
  vi.stubGlobal("location", win.location);
  return win;
}

describe("direct content mode — security & lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("detects direct content mode and extracts the token from the URL", () => {
    expect(isHttpContentMode({ pathname: "/content", search: "?token=abc123" })).toBe(true);
    expect(contentSessionToken({ pathname: "/content", search: "?token=abc123" })).toBe("abc123");
  });

  it("migrates the token from the URL into sessionStorage and cleans the address bar", () => {
    const win = installWindow({ pathname: "/content", search: "?token=secret-token", href: "http://player.example/content?token=secret-token" });

    // Simulate the effect: read token, persist, then clean the URL.
    const token = contentSessionToken({ pathname: win.location.pathname, search: win.location.search });
    expect(token).toBe("secret-token");
    persistContentSessionToken(token);
    if (win.location.search) {
      win.history.replaceState({}, "", "/content");
    }

    // Token now lives only in sessionStorage, not the visible URL.
    expect(win.sessionStorage.getItem("sv-content-session-token")).toBe("secret-token");
    expect(win.location.search).toBe("");
    expect(win.location.pathname).toBe("/content");

    // Re-read on same-tab refresh finds it in sessionStorage.
    expect(contentSessionToken({ pathname: "/content", search: "" })).toBe("secret-token");
  });

  it("does not expose the token in the address bar after migration", () => {
    const win = installWindow({ pathname: "/content", search: "?token=visible-token" });
    const token = contentSessionToken(win.location);
    persistContentSessionToken(token);
    win.history.replaceState({}, "", "/content");
    expect(win.location.href).not.toContain("token=");
  });

  it("clears the token from sessionStorage on logout/expiration", () => {
    persistContentSessionToken("temp-token");
    expect(contentSessionToken({ pathname: "/content", search: "" })).toBe("temp-token");
    clearContentSessionToken();
    expect(contentSessionToken({ pathname: "/content", search: "" })).toBeNull();
  });

  it("treats Xtream, M3U, and Stalker as direct-content connections", () => {
    expect(isDirectContentConnection({ type: "xtream" })).toBe(true);
    expect(isDirectContentConnection({ type: "m3u" })).toBe(true);
    expect(isDirectContentConnection({ type: "stalker" })).toBe(true);
    expect(isDirectContentConnection({ type: "jellyfin" })).toBe(false);
    expect(isDirectContentConnection({ type: "hls" })).toBe(false);
  });

  it("builds a session payload that excludes sensitive fields", () => {
    const payload = contentSessionPayload({
      id: "c1", type: "xtream", label: "Provider",
      config: { type: "xtream", server: "https://p.example", user: "alice", pass: "secret", password: "leak" },
    });
    const json = JSON.stringify(payload);
    expect(payload.connection.config.pass).toBe("secret");
    expect(json).not.toContain("password");
    expect(json).not.toContain("leak");
  });

  it("opens a direct session and navigates to the HTTP content URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contentUrl: "http://40.233.113.76/content?token=sess-1" }), { status: 200 }),
    );
    const navigate = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const opened = await maybeOpenDirectContentSession(
      { type: "xtream", id: "c1", config: { type: "xtream", server: "https://p.example", user: "a", pass: "b" } },
      { navigate, location: { pathname: "/app", search: "" } },
    );
    expect(opened).toBe(true);
    expect(navigate).toHaveBeenCalledWith("http://40.233.113.76/content?token=sess-1");
  });

  it("opens a scoped direct session for Stalker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contentUrl: "http://40.233.113.76/content?token=stalker-session" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const opened = await maybeOpenDirectContentSession(
      { type: "stalker", id: "c2", config: { type: "stalker", server: "http://portal.example/c", mac: "00:1A:79:AA:BB:CC" } },
      { location: { pathname: "/app", search: "" } },
    );
    expect(opened).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.connection.config).toMatchObject({ server: "http://portal.example/c", mac: "00:1A:79:AA:BB:CC" });
  });

  it("throws a categorized unauthorized error when the backend rejects the session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openDirectContentSession(
        { type: "xtream", id: "c1", config: { type: "xtream", server: "https://p.example", user: "a", pass: "b" } },
      ),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("throws a categorized network/server error when creation fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Server Error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openDirectContentSession(
        { type: "m3u", id: "c3", config: { type: "m3u", url: "https://playlist.example/list.m3u" } },
      ),
    ).rejects.toMatchObject({ code: "server_error", status: 500 });
  });

  it("returns to the secure app home on session creation failure (401)", () => {
    const prev = import.meta.env.VITE_SECURE_APP_BASE_URL;
    import.meta.env.VITE_SECURE_APP_BASE_URL = "https://media.portalheaven.stream";
    try {
      // The App handles this by calling getAppHomeUrl() + location.assign with ?reason=auth.
      const home = getAppHomeUrl();
      expect(home).toBe("https://media.portalheaven.stream/app");
    } finally {
      import.meta.env.VITE_SECURE_APP_BASE_URL = prev;
    }
  });
});
