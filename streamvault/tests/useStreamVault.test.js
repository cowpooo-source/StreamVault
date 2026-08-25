import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStreamVault } from "../src/useStreamVault.js";
import { activeConnectionStorageKey } from "../src/connection-lifecycle.js";

const mockDb = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
};

const mockSyncToServer = vi.fn();
const mockSyncConnectionsToServer = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/app-runtime.js", () => ({
  db: mockDb,
  track: vi.fn(),
  authFetch: vi.fn(),
  encryptConnections: vi.fn(),
  decryptConnections: vi.fn(),
  GUEST_ID: "guest-123",
}));

describe("useStreamVault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDb.get.mockResolvedValue(null);
    mockDb.set.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const opts = () => ({ db: mockDb, syncToServer: mockSyncToServer, syncConnectionsToServer: mockSyncConnectionsToServer, authUser: null, isGuest: false });
  const authOpts = () => ({ db: mockDb, syncToServer: mockSyncToServer, syncConnectionsToServer: mockSyncConnectionsToServer, authUser: { id: "u1" }, isGuest: false });

  it("initializes with empty state", () => {
    const { result } = renderHook(() => useStreamVault(opts()));
    expect(result.current.state.connections).toEqual([]);
    expect(result.current.state.activeConnId).toBeNull();
    expect(result.current.state.favorites).toEqual({ live: {}, vod: {}, series: {} });
    expect(result.current.state.history).toEqual([]);
  });

  it("loads connections from db on mount", async () => {
    const storedConns = [{ id: "c1", label: "Stored", type: "xtream", color: "#ff0000", config: {} }];
    mockDb.get.mockResolvedValue(storedConns);

    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(result.current.state.connections).toEqual(storedConns);
  });

  it("loads activeConnId from db on mount", async () => {
    mockDb.get
      .mockResolvedValueOnce([{ id: "c1", label: "Stored", type: "xtream", config: {} }])
      .mockResolvedValueOnce("c1");

    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(result.current.state.activeConnId).toBe("c1");
  });

  it("loads favs/history when activeConnId is set", async () => {
    const storedFavs = { live: { ch1: { id: "ch1", name: "Ch", url: "", logo: "", group: "", type: "live" } }, vod: {}, series: {} };
    const storedHist = [{ id: "m1", name: "Movie", url: "", type: "vod", timestamp: 123 }];

    mockDb.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("c1")
      .mockResolvedValueOnce(storedFavs)
      .mockResolvedValueOnce(storedHist);

    const { result } = renderHook(() => useStreamVault(opts()));

    await act(async () => {
      result.current.actions.setActiveConnId("c1");
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(mockDb.get).toHaveBeenCalledWith("sv-favs-c1", { live: {}, vod: {}, series: {} });
    expect(mockDb.get).toHaveBeenCalledWith("sv-history-c1", []);
  });

  it("addConnection dispatches ADD_CONNECTION and persists", async () => {
    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => {
      result.current.actions.addConnection({ id: "c1", type: "xtream", label: "Test", color: "#ff0000", config: {} });
    });

    expect(result.current.state.connections).toHaveLength(1);
    expect(mockDb.set).toHaveBeenCalledWith("sv-connections", expect.any(Array));
    await expect(activeConnectionStorageKey("c1")).resolves.toEqual(expect.stringMatching(/^sv-active-v2:/));
    expect(mockDb.set).toHaveBeenCalledWith("sv-activeConn", expect.stringMatching(/^sv-active-v2:/));
  });

  it("removeConnection dispatches REMOVE_CONNECTION and persists", async () => {
    mockDb.get.mockResolvedValue([{ id: "c1", type: "xtream", label: "Test", color: "#ff0000", config: {} }]);

    const { result } = renderHook(() => useStreamVault(authOpts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => { result.current.actions.removeConnection("c1"); });

    expect(result.current.state.connections).toHaveLength(0);
    expect(mockDb.set).toHaveBeenCalledWith("sv-connections", []);
    expect(mockSyncConnectionsToServer).toHaveBeenCalledWith([], {
      allowEmpty: true,
      reason: "user_removed_last_connection",
    });
  });

  it("setActiveConnId persists to db", async () => {
    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => { result.current.actions.setActiveConnId("c1"); });

    expect(mockDb.set).toHaveBeenCalledWith("sv-activeConn", expect.stringMatching(/^sv-active-v2:/));
  });

  it("setActiveConnId skips persistence when requested", async () => {
    const transientOpts = () => ({ ...opts(), persistActiveConnId: false });
    const { result } = renderHook(() => useStreamVault(transientOpts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => { result.current.actions.setActiveConnId("c1"); });

    expect(result.current.state.activeConnId).toBe("c1");
    expect(mockDb.set).not.toHaveBeenCalledWith("sv-activeConn", "c1");
  });

  it("toggleFavorite persists and syncs to server for authed users", async () => {
    const { result } = renderHook(() => useStreamVault(authOpts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => {
      result.current.actions.setActiveConnId("c1");
      await vi.advanceTimersByTimeAsync(10);
    });

    await act(async () => {
      result.current.actions.toggleFavorite({ id: "ch1", name: "Channel", url: "http://x", type: "live", logo: "", group: "" });
    });

    expect(mockDb.set).toHaveBeenCalledWith("sv-favs-c1", expect.any(Object));
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockSyncToServer).toHaveBeenCalledWith("favorites", "c1", expect.any(Object));
  });

  it("addHistory persists and syncs to server for authed users", async () => {
    const { result } = renderHook(() => useStreamVault(authOpts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => {
      result.current.actions.setActiveConnId("c1");
      await vi.advanceTimersByTimeAsync(10);
    });

    await act(async () => {
      result.current.actions.addHistory({ id: "m1", name: "Movie", url: "http://x", type: "vod", logo: "", group: "" });
    });

    expect(mockDb.set).toHaveBeenCalledWith("sv-history-c1", expect.any(Array));
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockSyncToServer).toHaveBeenCalledWith("history", "c1", expect.any(Array));
  });

  it("returns state + actions", () => {
    const { result } = renderHook(() => useStreamVault(opts()));

    expect(result.current.state).toBeDefined();
    expect(result.current.actions).toBeDefined();
    expect(typeof result.current.actions.addConnection).toBe("function");
    expect(typeof result.current.actions.removeConnection).toBe("function");
    expect(typeof result.current.actions.setActiveConnId).toBe("function");
    expect(typeof result.current.actions.toggleFavorite).toBe("function");
    expect(typeof result.current.actions.addHistory).toBe("function");
    expect(typeof result.current.actions.setConnections).toBe("function");
    expect(typeof result.current.actions.setFavorites).toBe("function");
    expect(typeof result.current.actions.setHistory).toBe("function");
  });

  it("selectActiveConnection returns the active connection", async () => {
    mockDb.get.mockResolvedValue([{ id: "c1", label: "Test", type: "xtream", color: "#ff0000", config: {} }]);

    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    act(() => { result.current.actions.setActiveConnId("c1"); });

    expect(result.current.selectActiveConnection()).toEqual({ id: "c1", label: "Test", type: "xtream", color: "#ff0000", config: {} });
  });

  it("selectFavItems returns flattened favs", async () => {
    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    act(() => {
      result.current.actions.toggleFavorite({ id: "ch1", name: "Channel", url: "", type: "live", logo: "", group: "" });
      result.current.actions.toggleFavorite({ id: "m1", name: "Movie", url: "", type: "vod", logo: "", group: "" });
    });

    const items = result.current.selectFavItems();
    expect(items).toHaveLength(2);
  });

  it("setConnections replaces connections and persists", async () => {
    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => {
      result.current.actions.setConnections([{ id: "c1", label: "New", type: "xtream", color: "#ff0000", config: {} }]);
    });

    expect(result.current.state.connections).toHaveLength(1);
    expect(mockDb.set).toHaveBeenCalledWith("sv-connections", expect.any(Array));
  });

  it("can clear connections locally without synchronizing an empty snapshot", async () => {
    const { result } = renderHook(() => useStreamVault(authOpts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    act(() => {
      result.current.actions.setConnections([], { sync: false });
    });

    expect(mockDb.set).toHaveBeenCalledWith("sv-connections", []);
    expect(mockSyncConnectionsToServer).not.toHaveBeenCalled();
  });

  it("waits for the account encryption key before hydrating connections", async () => {
    const { result, rerender } = renderHook(
      ({ hydrationKey }) => useStreamVault({ ...opts(), connectionHydrationKey: hydrationKey }),
      { initialProps: { hydrationKey: null } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(mockDb.get).not.toHaveBeenCalled();
    expect(result.current.state.hydrated).toBe(false);

    rerender({ hydrationKey: "user:u1" });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(mockDb.get).toHaveBeenCalledWith("sv-connections", []);
    expect(result.current.state.hydrated).toBe(true);
  });

  it("updateConnection updates an existing connection", async () => {
    mockDb.get.mockResolvedValue([{ id: "c1", label: "Old", type: "xtream", color: "#ff0000", config: {} }]);

    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => {
      result.current.actions.updateConnection({ id: "c1", label: "Updated", type: "xtream", color: "#00ff00", config: { new: true } });
    });

    expect(result.current.state.connections[0].label).toBe("Updated");
    expect(mockDb.set).toHaveBeenCalled();
  });

  it("setFavorites persists favorites to db", async () => {
    mockDb.get.mockResolvedValue(null);

    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => {
      result.current.actions.setActiveConnId("c1");
      await vi.advanceTimersByTimeAsync(10);
    });

    await act(async () => {
      result.current.actions.setFavorites({ live: {}, vod: {}, series: {} });
    });

    expect(mockDb.set).toHaveBeenCalledWith("sv-favs-c1", { live: {}, vod: {}, series: {} });
  });

  it("setHistory persists history to db", async () => {
    mockDb.get.mockResolvedValue(null);

    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => {
      result.current.actions.setActiveConnId("c1");
      await vi.advanceTimersByTimeAsync(10);
    });

    const hist = [{ id: "m1", name: "Movie", url: "", type: "vod", timestamp: 123 }];
    await act(async () => { result.current.actions.setHistory(hist); });

    expect(mockDb.set).toHaveBeenCalledWith("sv-history-c1", hist);
  });

  // â”€â”€ Stale closure tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("addConnection uses latest state (not stale closure) on rapid successive calls", async () => {
    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    // Simulate rapid successive calls â€” each should see the result of the previous
    await act(async () => {
      result.current.actions.addConnection({ id: "c1", type: "xtream", label: "C1", color: "#ff0000", config: {} });
    });
    await act(async () => {
      result.current.actions.addConnection({ id: "c2", type: "xtream", label: "C2", color: "#00ff00", config: {} });
    });

    // Both connections should be persisted, not just the last one
    const connsCalls = mockDb.set.mock.calls.filter(([k]) => k === "sv-connections");
    expect(connsCalls).toHaveLength(2);
    expect(connsCalls[0][1]).toHaveLength(1); // first call has c1
    expect(connsCalls[1][1]).toHaveLength(2); // second call has c1 AND c2
    expect(result.current.state.connections).toHaveLength(2);
  });

  it("removeConnection uses latest state on rapid successive calls", async () => {
    mockDb.get.mockResolvedValue([
      { id: "c1", type: "xtream", label: "C1", color: "#ff0000", config: {} },
      { id: "c2", type: "xtream", label: "C2", color: "#00ff00", config: {} },
    ]);

    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => { result.current.actions.removeConnection("c1"); });
    await act(async () => { result.current.actions.removeConnection("c2"); });

    const connsCalls = mockDb.set.mock.calls.filter(([k]) => k === "sv-connections");
    expect(connsCalls[0][1]).toHaveLength(1); // after removing c1, c2 remains
    expect(connsCalls[1][1]).toHaveLength(0); // after removing c2, none remain
    expect(result.current.state.connections).toHaveLength(0);
  });

  it("updateConnection uses latest state on rapid successive calls", async () => {
    mockDb.get.mockResolvedValue([
      { id: "c1", type: "xtream", label: "C1", color: "#ff0000", config: {} },
      { id: "c2", type: "xtream", label: "C2", color: "#00ff00", config: {} },
    ]);

    const { result } = renderHook(() => useStreamVault(opts()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await act(async () => {
      result.current.actions.updateConnection({ id: "c1", type: "xtream", label: "C1 Updated", color: "#ff0000", config: {} });
    });
    await act(async () => {
      result.current.actions.updateConnection({ id: "c2", type: "xtream", label: "C2 Updated", color: "#00ff00", config: {} });
    });

    const connsCalls = mockDb.set.mock.calls.filter(([k]) => k === "sv-connections");
    expect(connsCalls[0][1][0].label).toBe("C1 Updated"); // first update persisted
    expect(connsCalls[1][1][1].label).toBe("C2 Updated"); // second update persisted
    expect(result.current.state.connections[0].label).toBe("C1 Updated");
    expect(result.current.state.connections[1].label).toBe("C2 Updated");
  });
});
