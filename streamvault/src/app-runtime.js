// Shared app-level helpers — used by App.jsx and extractable view components
import { API } from "./utils.js";

// Guest ID for analytics tracking
export const GUEST_ID = (() => { let id = localStorage.getItem("sv-guest-id"); if (!id) { id = crypto.randomUUID?.() || Math.random().toString(36).slice(2); localStorage.setItem("sv-guest-id", id); } return id; })();

// Auth: relies solely on httpOnly cookies (no localStorage token fallback to prevent XSS theft)
export function authHeaders(extra = {}) { return { ...extra, "X-Guest-Id": GUEST_ID }; }
export function authFetch(url, opts = {}) { opts.headers = authHeaders(opts.headers || {}); opts.credentials = "same-origin"; return fetch(url, opts); }
export function track(event, data = {}) { fetch(`${API}/api/track`, { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ ...data, guestId: GUEST_ID, event }) }).catch(() => {}); }

// Lightweight key/value store (wraps window.storage/IDB or falls back to localStorage)
export const db = {
  async get(key, fallback = null) {
    try {
      if (window.storage) { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : fallback; }
      const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  async set(key, value) {
    try {
      if (window.storage) { await window.storage.set(key, JSON.stringify(value)); }
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { console.warn("IDB/localStorage error:", e.message); }
  },
};

export function proxyFetch(url) {
  return fetch(`${API}/proxy?url=${encodeURIComponent(url)}`);
}

export async function safeJsonFetch(res) {
  const text = await res.text();
  if (!res.ok) {
    try {
      const errData = JSON.parse(text);
      if (errData.error) throw new Error(errData.error);
    } catch (e) {
      if (e.message.startsWith("Server returned")) throw e;
    }
    throw new Error(`Server error (HTTP ${res.status})`);
  }
  try {
    const data = JSON.parse(text);
    // Xtream: auth 0 means invalid/expired credentials
    if (data?.user_info?.auth === 0) {
      throw new Error("Xtream authentication failed. Check your username and password.");
    }
    return data;
  } catch (e) {
    if (e.message.startsWith("Xtream")) throw e;
    if (text.trim().startsWith("<")) {
      throw new Error("Server returned HTML/XML instead of JSON. Check if your URL and credentials are correct.");
    }
    throw new Error("Invalid response from server (Not JSON)");
  }
}

export function makeXtreamAPI(server, user, pass) {
  const base = `${server}/player_api.php?username=${user}&password=${pass}`;

  const fetchJson = async (url) => {
    const res = await proxyFetch(url);
    return safeJsonFetch(res);
  };

  return {
    auth: () => fetchJson(base),
    getLiveCategories: () => fetchJson(`${base}&action=get_live_categories`),
    getLive: () => fetchJson(`${base}&action=get_live_streams`),
    getVODCategories: () => fetchJson(`${base}&action=get_vod_categories`),
    getVOD: () => fetchJson(`${base}&action=get_vod_streams`),
    getSeriesCategories: () => fetchJson(`${base}&action=get_series_categories`),
    getSeries: () => fetchJson(`${base}&action=get_series`),
    getSeriesInfo: (id) => fetchJson(`${base}&action=get_series_info&series_id=${id}`),
    liveURL: id => `${server}/live/${user}/${pass}/${id}.ts`,
    vodURL: (id, ext = "mp4") => `${server}/movie/${user}/${pass}/${id}.${ext}`,
    seriesStreamURL: (id, ext = "mp4") => `${server}/series/${user}/${pass}/${id}.${ext}`,
  };
}