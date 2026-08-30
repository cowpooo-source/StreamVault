import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  hydrateContentSession,
  disconnectContentSession,
  decideLeaveContentForConnection,
  resetRegularConnectionState,
  resolveActiveConnection,
  isNavigationAllowed,
} from "../src/app-session.js";

// Mock all external dependencies
vi.mock("../src/direct-content-session.js", () => ({
  clearContentSessionToken: vi.fn(),
  contentSessionToken: vi.fn(),
  navigateToAppHome: vi.fn(),
  persistContentSessionToken: vi.fn(),
  validateContentSession: vi.fn(),
}));

vi.mock("../src/app-runtime.js", () => ({
  db: { set: vi.fn() },
}));

import {
  clearContentSessionToken,
  contentSessionToken,
  navigateToAppHome,
  persistContentSessionToken,
  validateContentSession,
} from "../src/direct-content-session.js";

import { db } from "../src/app-runtime.js";

const fakeLocation = { pathname: "/content", search: "?token=abc", href: "http://localhost/content?token=abc" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: fakeLocation, history: { replaceState: vi.fn() } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hydrateContentSession", () => {
  it("returns error when no token is present", async () => {
    contentSessionToken.mockReturnValue(null);

    const result = await hydrateContentSession();

    expect(result).toEqual({ error: "session_auth_failure" });
    expect(clearContentSessionToken).toHaveBeenCalled();
    expect(navigateToAppHome).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "auth" }),
    );
  });

  it("persists token and cleans URL params on success", async () => {
    contentSessionToken.mockReturnValue("valid-token");
    validateContentSession.mockResolvedValue({
      connection: { id: "conn-1", type: "xtream", config: { server: "http://p.com", user: "u", pass: "p" } },
    });

    const result = await hydrateContentSession();

    expect(persistContentSessionToken).toHaveBeenCalledWith("valid-token");
    expect(window.history.replaceState).toHaveBeenCalled();
    expect(result.connection).toBeDefined();
    expect(result.connection.id).toBe("conn-1");
    expect(result.connection.config).toBeDefined();
    expect(result.adEligible).toBe(false);
  });

  it("preserves the server-derived ad eligibility for HTTP content mode", async () => {
    contentSessionToken.mockReturnValue("valid-token");
    validateContentSession.mockResolvedValue({
      connection: { id: "conn-1", type: "xtream" },
      adEligible: true,
    });

    const result = await hydrateContentSession();

    expect(result.adEligible).toBe(true);
  });

  it("returns normalized connection with defaults when config is missing", async () => {
    contentSessionToken.mockReturnValue("valid-token");
    validateContentSession.mockResolvedValue({
      connection: { id: "bare-conn" },
    });

    const result = await hydrateContentSession();

    expect(result.connection.type).toBe("xtream");
    expect(result.connection.label).toBe("bare-conn");
    expect(result.connection.config).toEqual({ id: "bare-conn" });
  });

  it("redirects to app home on 401 code", async () => {
    contentSessionToken.mockReturnValue("valid-token");
    validateContentSession.mockRejectedValue({ code: "unauthorized" });

    const result = await hydrateContentSession();

    expect(clearContentSessionToken).toHaveBeenCalled();
    expect(navigateToAppHome).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "auth" }),
    );
    expect(result.error).toBe("session_auth_failure");
  });

  it("redirects to app home on 403 code", async () => {
    contentSessionToken.mockReturnValue("valid-token");
    validateContentSession.mockRejectedValue({ code: 403 });

    const result = await hydrateContentSession();

    expect(clearContentSessionToken).toHaveBeenCalled();
    expect(navigateToAppHome).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "auth" }),
    );
    expect(result.error).toBe("session_auth_failure");
  });

  it("returns error message for non-auth failures", async () => {
    contentSessionToken.mockReturnValue("valid-token");
    validateContentSession.mockRejectedValue(new Error("Network error"));

    const result = await hydrateContentSession();

    expect(clearContentSessionToken).not.toHaveBeenCalled();
    expect(result.error).toBe("Network error");
  });

  it("respects an aborted signal after validation", async () => {
    contentSessionToken.mockReturnValue("valid-token");
    validateContentSession.mockResolvedValue({
      connection: { id: "conn-1", type: "xtream" },
    });

    const controller = new AbortController();
    controller.abort();
    const result = await hydrateContentSession({ signal: controller.signal });

    expect(result.error).toBe("cancelled");
  });

  it("returns error when connection has no id", async () => {
    contentSessionToken.mockReturnValue("valid-token");
    validateContentSession.mockResolvedValue({ connection: {} });

    const result = await hydrateContentSession();

    expect(result.error).toBe("Missing content session connection");
  });
});

describe("disconnectContentSession", () => {
  it("clears token and navigates home", () => {
    disconnectContentSession();

    expect(clearContentSessionToken).toHaveBeenCalled();
    expect(navigateToAppHome).toHaveBeenCalled();
  });
});

describe("decideLeaveContentForConnection", () => {
  it("returns show_manager when not in content mode", () => {
    expect(decideLeaveContentForConnection(false)).toBe("show_manager");
  });

  it("returns navigate_home when in content mode", () => {
    expect(decideLeaveContentForConnection(true)).toBe("navigate_home");
  });
});

describe("resetRegularConnectionState", () => {
  it("returns clean default state", () => {
    const state = resetRegularConnectionState(null);

    expect(state.conn).toBeNull();
    expect(state.channels).toEqual([]);
    expect(state.section).toBe("live");
    expect(state.activeConnId).toBeNull();
  });

  it("calls db.set with sv-activeConn null when dbSet provided", () => {
    resetRegularConnectionState(db.set);

    expect(db.set).toHaveBeenCalledWith("sv-activeConn", null);
  });
});

describe("resolveActiveConnection", () => {
  it("returns ephemeral connection when present", () => {
    const ephemeral = { id: "eph", type: "xtream" };
    const connections = [{ id: "c1", type: "xtream" }, { id: "c2", type: "m3u" }];

    expect(resolveActiveConnection(ephemeral, connections, "c1")).toBe(ephemeral);
  });

  it("returns the matching persistent connection when no ephemeral", () => {
    const connections = [{ id: "c1", type: "xtream" }, { id: "c2", type: "m3u" }];

    const result = resolveActiveConnection(null, connections, "c2");

    expect(result).toEqual({ id: "c2", type: "m3u" });
  });

  it("returns null when no match found", () => {
    const connections = [{ id: "c1", type: "xtream" }];

    expect(resolveActiveConnection(null, connections, "missing")).toBeNull();
  });
});

describe("isNavigationAllowed", () => {
  it("allows authenticated user with connection", () => {
    expect(isNavigationAllowed({ id: 1 }, false, true)).toBe(true);
  });

  it("allows guest with connection", () => {
    expect(isNavigationAllowed(null, true, true)).toBe(true);
  });

  it("denies unauthenticated user without guest mode", () => {
    expect(isNavigationAllowed(null, false, true)).toBe(false);
  });

  it("denies authenticated user without connection", () => {
    expect(isNavigationAllowed({ id: 1 }, false, false)).toBe(false);
  });

  it("denies guest without connection", () => {
    expect(isNavigationAllowed(null, true, false)).toBe(false);
  });
});
