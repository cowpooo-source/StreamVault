import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearContentSessionToken,
  contentSessionPayload,
  contentSessionToken,
  getAppHomeUrl,
  isDirectContentConnection,
  isHttpContentMode,
  maybeOpenDirectContentSession,
  navigateToAppHome,
  openDirectContentSession,
  shouldUseTokenPlayerForItem,
  refreshContentSession,
  validateContentSession,
} from "../src/direct-content-session.js";

describe("direct-content-session helpers", () => {
  const setSecureBase = (value) => { import.meta.env.VITE_SECURE_APP_BASE_URL = value; };
  const clearSecureBase = () => { delete import.meta.env.VITE_SECURE_APP_BASE_URL; };

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSecureBase();
  });

  it("detects direct content connections for Xtream, M3U, and Stalker", () => {
    expect(isDirectContentConnection({ type: "xtream" })).toBe(true);
    expect(isDirectContentConnection({ type: "m3u" })).toBe(true);
    expect(isDirectContentConnection({ type: "stalker" })).toBe(true);
    expect(isDirectContentConnection({ type: "hls" })).toBe(false);
    expect(isDirectContentConnection(null)).toBe(false);
  });

  it("builds a safe content-session payload with nested config", () => {
    const payload = contentSessionPayload({
      id: "conn-1",
      type: "xtream",
      label: "Provider",
      config: {
        type: "xtream",
        server: "https://portal.example",
        user: "alice",
        pass: "secret",
        password: "also-secret",
      },
    });

    expect(payload).toEqual({
      connection: {
        id: "conn-1",
        type: "xtream",
        label: "Provider",
        config: {
          type: "xtream",
          server: "https://portal.example",
          user: "alice",
          pass: "secret",
        },
      },
    });
    expect(JSON.stringify(payload)).not.toContain("password");
  });

  it("builds a scoped Stalker payload without unrelated fields", () => {
    const payload = contentSessionPayload({
      id: "stalker-1",
      type: "stalker",
      label: "Portal",
      config: {
        type: "stalker",
        server: "http://portal.example/c",
        mac: "00:1A:79:AA:BB:CC",
        serial: "SN1",
        deviceId: "D1",
        deviceId2: "D2",
        token: "must-not-leak",
      },
    });

    expect(payload.connection.config).toEqual({
      type: "stalker",
      server: "http://portal.example/c",
      mac: "00:1A:79:AA:BB:CC",
      serial: "SN1",
      deviceId: "D1",
      deviceId2: "D2",
    });
    expect(JSON.stringify(payload)).not.toContain("must-not-leak");
  });
  it("detects /content mode and extracts the token", () => {
    expect(isHttpContentMode({ pathname: "/content", search: "?token=abc123" })).toBe(true);
    expect(contentSessionToken({ pathname: "/content", search: "?token=abc123" })).toBe("abc123");
    expect(isHttpContentMode({ pathname: "/content/", search: "?token=abc123" })).toBe(true);
    expect(contentSessionToken({ pathname: "/content/", search: "?token=abc123" })).toBe("abc123");
    expect(isHttpContentMode({ pathname: "/app", search: "?token=abc123" })).toBe(false);
    expect(contentSessionToken({ pathname: "/app", search: "?token=abc123" })).toBe(null);
  });

  it("stores and restores the content session token from sessionStorage", () => {
    sessionStorage.setItem("sv-content-session-token", "persisted-token");

    expect(contentSessionToken({ pathname: "/content", search: "" })).toBe("persisted-token");
    clearContentSessionToken();
    expect(contentSessionToken({ pathname: "/content", search: "" })).toBeNull();
  });

  it("builds the HTTPS app home URL from the configured secure origin", () => {
    setSecureBase("https://media.portalheaven.stream");
    expect(getAppHomeUrl()).toBe("https://media.portalheaven.stream/app");
    expect(getAppHomeUrl({ baseUrl: "https://portal.example/app/" })).toBe("https://portal.example/app");
  });

  it("rejects an invalid secure app origin", () => {
    expect(() => getAppHomeUrl({ baseUrl: "javascript:alert(1)" })).toThrow("Secure app URL");
  });

  it("falls back to the current origin when no secure origin is configured", () => {
    clearSecureBase();
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    expect(getAppHomeUrl()).toBe(`${origin}/app`);
  });

  it("navigates back to the HTTPS app home through a callback or window.location", () => {
    setSecureBase("https://media.portalheaven.stream");
    const navigate = vi.fn();
    expect(navigateToAppHome({ navigate })).toBe("https://media.portalheaven.stream/app");
    expect(navigate).toHaveBeenCalledWith("https://media.portalheaven.stream/app");

    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    expect(navigateToAppHome({ location: window.location, baseUrl: "https://portal.example/content?token=abc123" })).toBe("https://portal.example/app");
    expect(assign).toHaveBeenCalledWith("https://portal.example/app");
  });

  it("includes the authentication reason when returning from an invalid content session", () => {
    const navigate = vi.fn();
    expect(navigateToAppHome({
      baseUrl: "https://media.portalheaven.stream/app",
      reason: "auth",
      navigate,
    })).toBe("https://media.portalheaven.stream/app?reason=auth");
    expect(navigate).toHaveBeenCalledWith("https://media.portalheaven.stream/app?reason=auth");
  });

  it("rejects missing content session tokens", async () => {
    await expect(validateContentSession(null)).rejects.toThrow("Missing content session token");
  });

  it("validates a content-session token against the backend route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ connection: { id: "conn-1" }, expiresAt: 123 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateContentSession("token-1")).resolves.toEqual({ connection: { id: "conn-1" }, expiresAt: 123 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/content-session/validate?token=token-1");
  });

  it("rejects expired or invalid content sessions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Content session expired or invalid" }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateContentSession("token-2")).rejects.toThrow("Content session expired or invalid");
  });

  it("refreshes an active content session without exposing connection data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ expiresAt: 456 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshContentSession("token-3")).resolves.toEqual({ expiresAt: 456 });
    expect(fetchMock).toHaveBeenCalledWith("/api/content-session/refresh", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ token: "token-3" }),
    }));
  });

  it("opens a direct content session and navigates via the supplied callback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contentUrl: "/content?token=session-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const navigate = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openDirectContentSession(
        { type: "xtream", id: "conn-1", label: "Provider", config: { type: "xtream", server: "https://portal.example", user: "alice", pass: "secret" } },
        { navigate },
      ),
    ).resolves.toEqual({ contentUrl: "/content?token=session-123" });
    expect(navigate).toHaveBeenCalledWith("/content?token=session-123");
    expect(fetchMock.mock.calls[0][1].headers["Content-Type"]).toBe("application/json");

  });
  it("falls back to window.location when no navigate callback is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contentUrl: "/content?token=session-456" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const assign = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { assign } });

    await expect(
      openDirectContentSession(
        { type: "m3u", id: "conn-2", label: "Playlist", config: { type: "m3u", url: "https://playlist.example/list.m3u" } },
      ),
    ).resolves.toEqual({ contentUrl: "/content?token=session-456" });
    expect(assign).toHaveBeenCalledWith("/content?token=session-456");
  });

  it("maybeOpenDirectContentSession only opens for direct connections outside /content mode", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ contentUrl: "/content?token=session-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    const navigate = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      maybeOpenDirectContentSession(
        { type: "xtream", id: "conn-1", config: { type: "xtream", server: "https://portal.example", user: "alice", pass: "secret" } },
        { navigate, location: { pathname: "/app", search: "" } },
      ),
    ).resolves.toBe(true);

    await expect(
      maybeOpenDirectContentSession(
        { type: "stalker", id: "conn-2", config: { type: "stalker", server: "http://portal.example/c", mac: "00:11:22:33:44:55" } },
        { navigate, location: { pathname: "/app", search: "" } },
      ),
    ).resolves.toBe(true);

    await expect(
      maybeOpenDirectContentSession(
        { type: "xtream", id: "conn-3", config: { type: "xtream", server: "https://portal.example", user: "alice", pass: "secret" } },
        { location: { pathname: "/content", search: "?token=session-123" } },
      ),
    ).resolves.toBe(false);
  });

  it("uses the token player only outside /content mode for direct connections", () => {
    expect(
      shouldUseTokenPlayerForItem(
        { type: "xtream", id: "conn-1" },
        { id: "item-1" },
        { pathname: "/content", search: "?token=session-123" },
      ),
    ).toBe(false);

    expect(
      shouldUseTokenPlayerForItem(
        { type: "xtream", id: "conn-1" },
        { id: "item-1" },
        { pathname: "/app", search: "" },
      ),
    ).toBe(true);

    expect(
      shouldUseTokenPlayerForItem(
        { type: "stalker", id: "conn-2" },
        { id: "item-2" },
        { pathname: "/content", search: "?token=session-123" },
      ),
    ).toBe(false);
  });
});
