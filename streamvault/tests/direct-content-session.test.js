import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contentSessionPayload,
  contentSessionToken,
  isDirectContentConnection,
  isHttpContentMode,
  maybeOpenDirectContentSession,
  openDirectContentSession,
  shouldUseTokenPlayerForItem,
  validateContentSession,
} from "../src/direct-content-session.js";

describe("direct-content-session helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects direct content connections for xtream and m3u only", () => {
    expect(isDirectContentConnection({ type: "xtream" })).toBe(true);
    expect(isDirectContentConnection({ type: "m3u" })).toBe(true);
    expect(isDirectContentConnection({ type: "stalker" })).toBe(false);
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

  it("detects /content mode and extracts the token", () => {
    expect(isHttpContentMode({ pathname: "/content", search: "?token=abc123" })).toBe(true);
    expect(contentSessionToken({ pathname: "/content", search: "?token=abc123" })).toBe("abc123");
    expect(isHttpContentMode({ pathname: "/content/", search: "?token=abc123" })).toBe(true);
    expect(contentSessionToken({ pathname: "/content/", search: "?token=abc123" })).toBe("abc123");
    expect(isHttpContentMode({ pathname: "/app", search: "?token=abc123" })).toBe(false);
    expect(contentSessionToken({ pathname: "/app", search: "?token=abc123" })).toBe(null);
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contentUrl: "/content?token=session-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
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
        { type: "stalker", id: "conn-2" },
        { location: { pathname: "/app", search: "" } },
      ),
    ).resolves.toBe(false);

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


