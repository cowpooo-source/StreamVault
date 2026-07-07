import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSafeContentSessionPayload,
  detectContentMode,
  isDirectContentConnection,
  maybeOpenDirectContentSession,
  openDirectContentSession,
  shouldUseTokenPlayerForItem,
  validateContentSessionToken,
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

  it("builds a safe content-session payload without secrets", () => {
    const payload = buildSafeContentSessionPayload(
      {
        id: "conn-1",
        type: "xtream",
        label: "Provider",
        server: "https://portal.example",
        user: "alice",
        pass: "secret",
        password: "also-secret",
      },
      {
        id: "item-1",
        name: "Channel",
        url: "https://stream.example/live/1",
        type: "live",
        logo: "https://img.example/logo.png",
      },
    );

    expect(payload).toEqual({
      connection: {
        id: "conn-1",
        type: "xtream",
        label: "Provider",
        server: "https://portal.example",
        user: "alice",
      },
      item: {
        id: "item-1",
        name: "Channel",
        url: "https://stream.example/live/1",
        type: "live",
        logo: "https://img.example/logo.png",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(JSON.stringify(payload)).not.toContain("password");
  });

  it("detects /content mode and extracts the token", () => {
    expect(detectContentMode({ pathname: "/content", search: "?token=abc123" })).toEqual({
      isContentMode: true,
      token: "abc123",
    });
    expect(detectContentMode({ pathname: "/app", search: "?token=abc123" })).toEqual({
      isContentMode: false,
      token: null,
    });
  });

  it("validates a content-session token against the backend route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateContentSessionToken("token-1")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/content-session/validate?token=token-1");
  });

  it("opens a direct content session and navigates to the returned contentUrl", async () => {
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
        { type: "xtream", id: "conn-1", label: "Provider", server: "https://portal.example", user: "alice", pass: "secret" },
        { id: "item-1", name: "Channel", url: "https://stream.example/live/1", type: "live" },
        { navigate },
      ),
    ).resolves.toEqual({ opened: true, contentUrl: "/content?token=session-123" });
    expect(navigate).toHaveBeenCalledWith("/content?token=session-123");
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
        { type: "xtream", id: "conn-1", server: "https://portal.example", user: "alice", pass: "secret" },
        { id: "item-1", url: "https://stream.example/live/1", type: "live" },
        { navigate, location: { pathname: "/app", search: "" } },
      ),
    ).resolves.toBe(true);

    await expect(
      maybeOpenDirectContentSession(
        { type: "stalker", id: "conn-2" },
        { id: "item-2", url: "https://stream.example/live/2", type: "live" },
        { navigate, location: { pathname: "/app", search: "" } },
      ),
    ).resolves.toBe(false);

    await expect(
      maybeOpenDirectContentSession(
        { type: "xtream", id: "conn-3", server: "https://portal.example", user: "alice", pass: "secret" },
        { id: "item-3", url: "https://stream.example/live/3", type: "live" },
        { navigate, location: { pathname: "/content", search: "?token=session-123" } },
      ),
    ).resolves.toBe(false);
  });

  it("uses the token player only in /content mode for direct connections", () => {
    expect(
      shouldUseTokenPlayerForItem(
        { type: "xtream", id: "conn-1" },
        { id: "item-1", type: "live" },
        { pathname: "/content", search: "?token=session-123" },
      ),
    ).toBe(true);

    expect(
      shouldUseTokenPlayerForItem(
        { type: "xtream", id: "conn-1" },
        { id: "item-1", type: "live" },
        { pathname: "/app", search: "" },
      ),
    ).toBe(false);

    expect(
      shouldUseTokenPlayerForItem(
        { type: "stalker", id: "conn-2" },
        { id: "item-2", type: "live" },
        { pathname: "/content", search: "?token=session-123" },
      ),
    ).toBe(false);
  });
});
