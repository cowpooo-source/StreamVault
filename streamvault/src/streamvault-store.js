// Pure state module for StreamVault — no side effects, no fetch, no DOM
// Phase A state: connections, activeConnId, favorites, history

import { normalizeConnections } from "./connection-lifecycle.js";

export function createInitialStoreState() {
  return {
    connections: [],
    activeConnId: null,
    favorites: { live: {}, vod: {}, series: {} },
    history: [],
    hydrated: false,
  };
}

export function streamvaultReducer(state, action) {
  switch (action.type) {
    case "SET_CONNECTIONS":
      return { ...state, connections: normalizeConnections(action.payload) };

    case "SET_HYDRATED":
      return { ...state, hydrated: Boolean(action.payload) };

    case "SET_ACTIVE_CONN_ID":
      return { ...state, activeConnId: action.payload };

    case "SET_FAVORITES":
      return { ...state, favorites: (action.payload && typeof action.payload === "object" && !Array.isArray(action.payload)) ? action.payload : { live: {}, vod: {}, series: {} } };

    case "SET_HISTORY":
      return { ...state, history: Array.isArray(action.payload) ? action.payload : [] };

    case "ADD_CONNECTION": {
      const conn = action.payload;
      if (!Array.isArray(state.connections)) return state;
      if (state.connections.some(c => c.id === conn.id)) return state;
      return { ...state, connections: [...state.connections, conn] };
    }

    case "REMOVE_CONNECTION":
      return { ...state, connections: Array.isArray(state.connections) ? state.connections.filter(c => c.id !== action.payload) : [] };

    case "UPDATE_CONNECTION":
      return {
        ...state,
        connections: Array.isArray(state.connections) ? state.connections.map(c => c.id === action.payload.id ? action.payload : c) : [],
      };

    case "TOGGLE_FAVORITE": {
      const item = action.payload;
      const type = item.type || "live";
      const key = item.id || item.url;
      const favs = state.favorites || { live: {}, vod: {}, series: {} };
      const prevTypeFavs = favs[type] || {};
      const updatedTypeFavs = prevTypeFavs[key]
        ? Object.fromEntries(Object.entries(prevTypeFavs).filter(([k]) => k !== key))
        : { ...prevTypeFavs, [key]: { id: item.id, name: item.name, url: item.url, logo: item.logo, group: item.group, type } };
      return { ...state, favorites: { ...favs, [type]: updatedTypeFavs } };
    }

    case "ADD_TO_HISTORY": {
      const item = action.payload;
      const entry = { ...item, timestamp: Date.now(), position: 0 };
      const hist = state.history || [];
      const withoutDup = hist.filter(h => (h.id || h.url) !== (item.id || item.url));
      return { ...state, history: [entry, ...withoutDup].slice(0, 60) };
    }

    default:
      return state;
  }
}

// ── selectors ─────────────────────────────────────────────────────────────────

export function selectActiveConnection(state) {
  if (!state.activeConnId) return undefined;
  return state.connections.find(c => c.id === state.activeConnId);
}

export function selectFavItems(state) {
  const { live = {}, vod = {}, series = {} } = state.favorites || {};
  return [...Object.values(live), ...Object.values(vod), ...Object.values(series)];
}