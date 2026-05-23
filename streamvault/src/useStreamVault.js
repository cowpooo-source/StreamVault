// useStreamVault — React hook that wires streamvault-store.js to persistence and side effects
import { useReducer, useEffect, useCallback, useMemo, useRef } from "react";
import { createInitialStoreState, streamvaultReducer, selectActiveConnection, selectFavItems } from "./streamvault-store.js";

// Debounce helper for server sync
const _syncTimers = {};
function debouncedSync(type, connId, data, syncFn, delay = 2000) {
  const key = `${type}:${connId}`;
  clearTimeout(_syncTimers[key]);
  _syncTimers[key] = setTimeout(() => {
    syncFn(type, connId, data);
  }, delay);
}

export function useStreamVault({ db, syncToServer, syncConnectionsToServer, authUser, isGuest }) {
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
    let cancelled = false;
    (async () => {
      const storedConns = await db.get("sv-connections", []);
      if (cancelled) return;
      dispatch({ type: "SET_CONNECTIONS", payload: storedConns || [] });

      const storedActiveConnId = await db.get("sv-activeConn", null);
      if (cancelled) return;
      if (storedActiveConnId) dispatch({ type: "SET_ACTIVE_CONN_ID", payload: storedActiveConnId });
    })();
    return () => { cancelled = true; };
  }, []);

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
  }, [state.activeConnId]);

  // ── actions ─────────────────────────────────────────────────────────────────

  const setConnections = useCallback((conns) => {
    dispatch({ type: "SET_CONNECTIONS", payload: conns });
    db.set("sv-connections", conns);
    if (authUser || isGuest) syncConnectionsToServer(conns);
  }, [authUser, isGuest]);

  const setActiveConnId = useCallback((id) => {
    dispatch({ type: "SET_ACTIVE_CONN_ID", payload: id });
    db.set("sv-activeConn", id);
  }, []);

  const setFavorites = useCallback((favs) => {
    dispatch({ type: "SET_FAVORITES", payload: favs });
    if (state.activeConnId) db.set(`sv-favs-${state.activeConnId}`, favs);
  }, [state.activeConnId]);

  const setHistory = useCallback((hist) => {
    dispatch({ type: "SET_HISTORY", payload: hist });
    if (state.activeConnId) db.set(`sv-history-${state.activeConnId}`, hist);
  }, [state.activeConnId]);

  const addConnection = useCallback((conn) => {
    const updatedConns = [...connectionsRef.current, conn];
    dispatch({ type: "ADD_CONNECTION", payload: conn });
    db.set("sv-connections", updatedConns);
    db.set("sv-activeConn", conn.id);
    if (authUser || isGuest) syncConnectionsToServer(updatedConns);
  }, [authUser, isGuest]);

  const removeConnection = useCallback((id) => {
    const updatedConns = connectionsRef.current.filter(c => c.id !== id);
    dispatch({ type: "REMOVE_CONNECTION", payload: id });
    db.set("sv-connections", updatedConns);
    if (authUser || isGuest) syncConnectionsToServer(updatedConns);
  }, [authUser, isGuest]);

  const updateConnection = useCallback((conn) => {
    const updatedConns = connectionsRef.current.map(c => c.id === conn.id ? conn : c);
    dispatch({ type: "UPDATE_CONNECTION", payload: conn });
    db.set("sv-connections", updatedConns);
    if (authUser || isGuest) syncConnectionsToServer(updatedConns);
  }, [authUser, isGuest]);

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
  }, [state.activeConnId, authUser, isGuest]);

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
  }, [state.activeConnId, authUser, isGuest]);

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