import { describe, it, expect } from "vitest";
import { createInitialStoreState, streamvaultReducer, selectActiveConnection, selectFavItems } from "../src/streamvault-store.js";

describe("streamvaultStore", () => {
  describe("createInitialStoreState", () => {
    it("returns expected shape", () => {
      const state = createInitialStoreState();
      expect(state).toEqual({
        connections: [],
        activeConnId: null,
        favorites: { live: {}, vod: {}, series: {} },
        history: [],
      });
    });

    it("can be called multiple times without shared state", () => {
      const s1 = createInitialStoreState();
      const s2 = createInitialStoreState();
      s1.connections.push({ id: "test" });
      expect(s2.connections).toEqual([]);
    });
  });

  describe("streamvaultReducer", () => {
    it("SET_CONNECTIONS replaces the connections array", () => {
      const initial = createInitialStoreState();
      const conn = { id: "c1", type: "xtream", label: "Test", color: "#ff0000", config: {} };
      const next = streamvaultReducer(initial, { type: "SET_CONNECTIONS", payload: [conn] });
      expect(next.connections).toEqual([conn]);
      expect(next.activeConnId).toBeNull();
    });

    it("SET_ACTIVE_CONN_ID updates activeConnId", () => {
      const initial = createInitialStoreState();
      const next = streamvaultReducer(initial, { type: "SET_ACTIVE_CONN_ID", payload: "c1" });
      expect(next.activeConnId).toBe("c1");
    });

    it("SET_ACTIVE_CONN_ID with null clears active", () => {
      const initial = { ...createInitialStoreState(), activeConnId: "c1" };
      const next = streamvaultReducer(initial, { type: "SET_ACTIVE_CONN_ID", payload: null });
      expect(next.activeConnId).toBeNull();
    });

    it("SET_FAVORITES replaces the favorites object", () => {
      const initial = createInitialStoreState();
      const favs = { live: { "ch1": { id: "ch1", name: "Channel 1", url: "http://x", logo: "", group: "", type: "live" } }, vod: {}, series: {} };
      const next = streamvaultReducer(initial, { type: "SET_FAVORITES", payload: favs });
      expect(next.favorites.live.ch1.name).toBe("Channel 1");
    });

    it("SET_HISTORY replaces the history array", () => {
      const initial = createInitialStoreState();
      const hist = [{ id: "m1", name: "Movie 1", url: "http://x", type: "vod", timestamp: 123456 }];
      const next = streamvaultReducer(initial, { type: "SET_HISTORY", payload: hist });
      expect(next.history).toEqual(hist);
    });

    it("TOGGLE_FAVORITE adds an item to favorites", () => {
      const initial = { ...createInitialStoreState(), favorites: { live: {}, vod: {}, series: {} } };
      const item = { id: "ch1", name: "Channel 1", url: "http://x", type: "live", logo: "", group: "" };
      const next = streamvaultReducer(initial, { type: "TOGGLE_FAVORITE", payload: item });
      expect(next.favorites.live.ch1).toEqual(expect.objectContaining({ id: "ch1", name: "Channel 1" }));
    });

    it("TOGGLE_FAVORITE removes an item if already present", () => {
      const item = { id: "ch1", name: "Channel 1", url: "http://x", type: "live", logo: "", group: "" };
      const initial = {
        ...createInitialStoreState(),
        favorites: {
          live: { ch1: { id: "ch1", name: "Channel 1", url: "http://x", type: "live", logo: "", group: "" } },
          vod: {},
          series: {},
        },
      };
      const next = streamvaultReducer(initial, { type: "TOGGLE_FAVORITE", payload: item });
      expect(next.favorites.live.ch1).toBeUndefined();
    });

    it("TOGGLE_FAVORITE defaults to live type if item.type is missing", () => {
      const initial = { ...createInitialStoreState(), favorites: { live: {}, vod: {}, series: {} } };
      const item = { id: "ch1", name: "Channel 1", url: "http://x", logo: "", group: "" };
      const next = streamvaultReducer(initial, { type: "TOGGLE_FAVORITE", payload: item });
      expect(next.favorites.live.ch1).toBeDefined();
    });

    it("ADD_TO_HISTORY prepends entry and dedupes by id/url, capped at 60", () => {
      const initial = createInitialStoreState();
      const item1 = { id: "m1", name: "Movie 1", url: "", type: "vod", logo: "", group: "" };
      const item2 = { id: "m2", name: "Movie 2", url: "", type: "vod", logo: "", group: "" };
      const itemDup = { id: "m1", name: "Movie 1 Updated", url: "", type: "vod", logo: "", group: "" };

      let state = streamvaultReducer(initial, { type: "ADD_TO_HISTORY", payload: item1 });
      state = streamvaultReducer(state, { type: "ADD_TO_HISTORY", payload: item2 });
      state = streamvaultReducer(state, { type: "ADD_TO_HISTORY", payload: itemDup });

      expect(state.history[0].id).toBe("m1");
      expect(state.history[0].name).toBe("Movie 1 Updated"); // newer version
      expect(state.history[1].id).toBe("m2");
      expect(state.history.length).toBe(2);
    });

    it("ADD_TO_HISTORY caps history at 60 entries", () => {
      const initial = createInitialStoreState();
      let state = initial;
      for (let i = 0; i < 65; i++) {
        state = streamvaultReducer(state, { type: "ADD_TO_HISTORY", payload: { id: `m${i}`, name: `Movie ${i}`, url: "", type: "vod", logo: "", group: "" } });
      }
      expect(state.history.length).toBe(60);
      expect(state.history[0].id).toBe("m64");
    });

    it("ADD_CONNECTION appends a new connection", () => {
      const initial = createInitialStoreState();
      const conn = { id: "c1", type: "xtream", label: "Conn 1", color: "#ff0000", config: {} };
      const next = streamvaultReducer(initial, { type: "ADD_CONNECTION", payload: conn });
      expect(next.connections).toEqual([conn]);
    });

    it("ADD_CONNECTION does not duplicate if id already exists", () => {
      const conn = { id: "c1", type: "xtream", label: "Conn 1", color: "#ff0000", config: {} };
      const initial = { ...createInitialStoreState(), connections: [conn] };
      const next = streamvaultReducer(initial, { type: "ADD_CONNECTION", payload: conn });
      expect(next.connections.length).toBe(1);
    });

    it("REMOVE_CONNECTION removes by id", () => {
      const conn1 = { id: "c1", type: "xtream", label: "C1", color: "#ff0000", config: {} };
      const conn2 = { id: "c2", type: "xtream", label: "C2", color: "#00ff00", config: {} };
      const initial = { ...createInitialStoreState(), connections: [conn1, conn2] };
      const next = streamvaultReducer(initial, { type: "REMOVE_CONNECTION", payload: "c1" });
      expect(next.connections).toEqual([conn2]);
    });

    it("UPDATE_CONNECTION replaces existing connection by id", () => {
      const conn1 = { id: "c1", type: "xtream", label: "Old", color: "#ff0000", config: {} };
      const updated = { id: "c1", type: "xtream", label: "New", color: "#ff0000", config: { new: true } };
      const initial = { ...createInitialStoreState(), connections: [conn1] };
      const next = streamvaultReducer(initial, { type: "UPDATE_CONNECTION", payload: updated });
      expect(next.connections[0].label).toBe("New");
      expect(next.connections[0].config.new).toBe(true);
    });

    it("returns state unchanged for unknown action type", () => {
      const initial = createInitialStoreState();
      const next = streamvaultReducer(initial, { type: "UNKNOWN_ACTION", payload: {} });
      expect(next).toBe(initial);
    });

    it("does not mutate the original state", () => {
      const initial = createInitialStoreState();
      const originalFavs = initial.favorites;
      streamvaultReducer(initial, { type: "TOGGLE_FAVORITE", payload: { id: "ch1", name: "Ch", url: "", type: "live", logo: "", group: "" } });
      expect(initial.favorites).toBe(originalFavs);
      expect(initial.favorites.live).toEqual({});
    });
  });

  describe("selectActiveConnection", () => {
    it("returns the connection matching activeConnId", () => {
      const conn1 = { id: "c1", label: "Conn 1" };
      const conn2 = { id: "c2", label: "Conn 2" };
      const state = { connections: [conn1, conn2], activeConnId: "c2", favorites: { live: {}, vod: {}, series: {} }, history: [] };
      expect(selectActiveConnection(state)).toEqual(conn2);
    });

    it("returns undefined if no activeConnId", () => {
      const state = { connections: [], activeConnId: null, favorites: { live: {}, vod: {}, series: {} }, history: [] };
      expect(selectActiveConnection(state)).toBeUndefined();
    });

    it("returns undefined if activeConnId not found", () => {
      const state = { connections: [{ id: "c1" }], activeConnId: "c99", favorites: { live: {}, vod: {}, series: {} }, history: [] };
      expect(selectActiveConnection(state)).toBeUndefined();
    });
  });

  describe("selectFavItems", () => {
    it("returns all fav items flattened across all types", () => {
      const state = {
        connections: [],
        activeConnId: null,
        favorites: {
          live: { ch1: { id: "ch1", type: "live" } },
          vod: { m1: { id: "m1", type: "vod" } },
          series: { s1: { id: "s1", type: "series" } },
        },
        history: [],
      };
      const items = selectFavItems(state);
      expect(items).toHaveLength(3);
      expect(items.map(i => i.id)).toEqual(["ch1", "m1", "s1"]);
    });

    it("returns empty array when no favorites", () => {
      const state = { connections: [], activeConnId: null, favorites: { live: {}, vod: {}, series: {} }, history: [] };
      expect(selectFavItems(state)).toEqual([]);
    });
  });
});
