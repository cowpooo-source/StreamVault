// useStreamVault — React hook that wires streamvault-store.js to persistence and side effects
import { useReducer, useEffect, useCallback, useMemo, useRef } from "react";
import { createInitialStoreState, streamvaultReducer, selectActiveConnection, selectFavItems } from "./streamvault-store.js";
import { normalizeConnections } from "./connection-lifecycle.js";

// Debounce helper for server sync
const _syncTimers = {};
function debouncedSync(type, connId, data, syncFn, delay = 2000) {
  const key = `${type}:${connId}`;
  clearTimeout(_syncTimers[key]);
  _syncTimers[key] = setTimeout(() => {
    syncFn(type, connId, data);
  }, delay);
}

function syncConnectionsSafely(syncFn, conns, options = {}) {
  Promise.resolve(syncFn(conns, options)).catch(error => {
    console.warn("Connection sync failed:", error?.message || error);
  });
}

export function useStreamVault({
  db,
  syncToServer,
  syncConnectionsToServer,
  authUser,
  isGuest,
  persistActiveConnId = true,
  connectionHydrationKey = "default",
}) {
  const [state, dispatch] = useReducer(streamvaultReducer, null, createInitialStoreState);

  // Refs to avoid stale closures when computing derived values for persistence
  const connectionsRef = useRef([]);
  const favoritesRef = useRef({ live: {}, vod: {}, series: {} });
  const historyRef = useRef([]);

  useEffect(() => {
    connectionsRef.current = state.connections;
  }, [state.connections]);

  useEffect(() => {
    favoritesRef.current = state.favorites;
  }, [state.favorites]);

  useEffect(() => {
    historyRef.current = state.history;
  }, [state.history]);

  // Load connections + activeConnId on mount
  useEffect(() => {
    if (!connectionHydrationKey) return;
    let cancelled = false;
    dispatch({ type: "SET_HYDRATED", payload: false });
    (async () => {
      const storedConns = normalizeConnections(await db.get("sv-connections", []));
      if (cancelled) return;
      dispatch({ type: "SET_CONNECTIONS", payload: storedConns || [] });

      const storedActiveConnId = await db.get("sv-activeConn", null);
      if (cancelled) return;
      if (storedActiveConnId && storedConns.some((connection) => connection.id === storedActiveConnId)) {
        dispatch({ type: "SET_ACTIVE_CONN_ID", payload: storedActiveConnId });
      } else if (storedActiveConnId) {
        await db.set("sv-activeConn", null);
      }
      dispatch({ type: "SET_HYDRATED", payload: true });
    })();
    return () => { cancelled = true; };
  }, [connectionHydrationKey, db]);

  // Load favorites + history whenever activeConnId changes
  useEffect(() => {
    if (!state.activeConnId) return;
    let cancelled = false;

    (async () => {
      const storedFavs = await db.get(`sv-favs-${state.activeConnId}`, { live: {}, vod: {}, series: {} });
      if (cancelled) return;
      dispatch({ type: "SET_FAVORITES", payload: storedFavs });

      const storedHist = await db.get(`sv-history-${state.activeConnId}`, []);
      if (cancelled) return;
      dispatch({ type: "SET_HISTORY", payload: storedHist });
    })();

    return () => { cancelled = true; };
  }, [state.activeConnId, db]);

  // ── actions ─────────────────────────────────────────────────────────

  const setConnections = useCallback((conns, options = {}) => {
    dispatch({ type: "SET_CONNECTIONS", payload: conns });
    db.set("sv-connections", conns);
    if (options.sync !== false && (authUser || isGuest)) {
      syncConnectionsSafely(syncConnectionsToServer, conns, options);
    }
  }, [authUser, db, isGuest, syncConnectionsToServer]);

  const setActiveConnId = useCallback((id) => {
    dispatch({ type: "SET_ACTIVE_CONN_ID", payload: id });
    if (persistActiveConnId) {
      db.set("sv-activeConn", id);
    }
  }, [db, persistActiveConnId]);

  const setFavorites = useCallback((favs) => {
    dispatch({ type: "SET_FAVORITES", payload: favs });
    if (state.activeConnId) db.set(`sv-favs-${state.activeConnId}`, favs);
  }, [db, state.activeConnId]);

  const setHistory = useCallback((hist) => {
    dispatch({ type: "SET_HISTORY", payload: hist });
    if (state.activeConnId) db.set(`sv-history-${state.activeConnId}`, hist);
  }, [db, state.activeConnId]);

  const addConnection = useCallback((conn) => {
    const updatedConns = [...connectionsRef.current, conn];
    dispatch({ type: "ADD_CONNECTION", payload: conn });
    db.set("sv-connections", updatedConns);
    if (persistActiveConnId) {
      db.set("sv-activeConn", conn.id);
    }
    if (authUser || isGuest) syncConnectionsSafely(syncConnectionsToServer, updatedConns);
  }, [authUser, db, isGuest, persistActiveConnId, syncConnectionsToServer]);

  const removeConnection = useCallback((id) => {
    const updatedConns = connectionsRef.current.filter(c => c.id !== id);
    dispatch({ type: "REMOVE_CONNECTION", payload: id });
    db.set("sv-connections", updatedConns);
    if (authUser || isGuest) {
      syncConnectionsSafely(syncConnectionsToServer, updatedConns, updatedConns.length === 0
        ? { allowEmpty: true, reason: "user_removed_last_connection" }
        : {});
    }
  }, [authUser, db, isGuest, syncConnectionsToServer]);

  const updateConnection = useCallback((conn) => {
    const updatedConns = connectionsRef.current.map(c => c.id === conn.id ? conn : c);
    dispatch({ type: "UPDATE_CONNECTION", payload: conn });
    db.set("sv-connections", updatedConns);
    if (authUser || isGuest) syncConnectionsSafely(syncConnectionsToServer, updatedConns);
  }, [authUser, db, isGuest, syncConnectionsToServer]);

  const toggleFavorite = useCallback((item) => {
    const type = item.type || "live";
    const key = item.id || item.url;
    const favs = favoritesRef.current || { live: {}, vod: {}, series: {} };
    const prevTypeFavs = favs[type] || {};
    const newFavs = prevTypeFavs[key]
      ? { ...favs, [type]: Object.fromEntries(Object.entries(prevTypeFavs).filter(([k]) => k !== key)) }
      : { ...favs, [type]: { ...prevTypeFavs, [key]: { id: item.id, name: item.name, url: item.url, logo: item.logo, group: item.group, type } } };

    dispatch({ type: "TOGGLE_FAVORITE", payload: item });
    if (state.activeConnId) {
      db.set(`sv-favs-${state.activeConnId}`, newFavs);
      if (authUser || isGuest) debouncedSync("favorites", state.activeConnId, newFavs, syncToServer);
    }
  }, [authUser, db, isGuest, state.activeConnId, syncToServer]);

  const addHistory = useCallback((item) => {
    const entry = { ...item, timestamp: Date.now(), position: 0 };
    const hist = historyRef.current || [];
    const withoutDup = hist.filter(h => (h.id || h.url) !== (item.id || item.url));
    const newHist = [entry, ...withoutDup].slice(0, 60);

    dispatch({ type: "ADD_TO_HISTORY", payload: item });
    if (state.activeConnId) {
      db.set(`sv-history-${state.activeConnId}`, newHist);
      if (authUser || isGuest) debouncedSync("history", state.activeConnId, newHist, syncToServer);
    }
  }, [authUser, db, isGuest, state.activeConnId, syncToServer]);

  const actions = useMemo(() => ({
    setConnections,
    setActiveConnId,
    setFavorites,
    setHistory,
    addConnection,
    removeConnection,
    updateConnection,
    toggleFavorite,
    addHistory,
  }), [
    setConnections,
    setActiveConnId,
    setFavorites,
    setHistory,
    addConnection,
    removeConnection,
    updateConnection,
    toggleFavorite,
    addHistory,
  ]);

  return {
    state,
    actions,
    selectActiveConnection: () => selectActiveConnection(state),
    selectFavItems: () => selectFavItems(state),
  };
}
