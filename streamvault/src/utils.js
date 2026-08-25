// Utility functions for StreamVault
export {
  analyticsPlaybackRoute,
  categorizeAnalyticsError,
  trackAnalytics,
  trackAnalyticsScreen,
} from "./analytics.js";

export const API = import.meta.env.VITE_API_URL || ""; // Proxy URL for API calls, empty for relative paths
export const VAST_URL = import.meta.env.VITE_VAST_URL || "";
export const ADSTERRA_URL = import.meta.env.VITE_ADSTERRA_URL || "https://pl29160027.profitablecpmratenetwork.com/fe/df/06/fedf067b01378386e9c4bc061ffa1edb.js";
export const VAST_FETCH_TIMEOUT_MS = 3500;

// Feature Flags
export const ENABLE_VAST = import.meta.env.VITE_ENABLE_VAST === "true";
export const ENABLE_ADSTERRA = import.meta.env.VITE_ENABLE_ADSTERRA === "true";
export const ENABLE_HILLTOP = import.meta.env.VITE_ENABLE_HILLTOP === "true";

export function vastProxyUrl(url) {
  return `${API}/api/vast?url=${encodeURIComponent(url)}`;
}

export function streamProxy(u) {
  const isInternal = u?.startsWith('/') || (API && u?.startsWith(API)) || u?.startsWith(location.origin);
  return isInternal ? u : `${API}/stream?url=${encodeURIComponent(u)}`;
}

export async function fetchTextWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return "";
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

export function imgSrc(url) {
  if (!url) return null;
  if (url.includes("image.tmdb.org") || url.includes("themoviedb.org")) return url;
  return `${API}/img?url=${encodeURIComponent(url)}`;
}

export function resolveUrl(raw, base) {
  if (!raw) return "";
  try {
    const url = new URL(String(raw).trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch { return ""; }
}

export function parseVastTime(value) {
  if (!value) return 0;
  const text = String(value).trim();
  if (!text) return 0;
  if (text.includes(":")) {
    const parts = text.split(":").map(Number);
    if (parts.some(Number.isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

export function pingUrl(url) {
  if (!url) return;
  try {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.src = url;
  } catch (e) { console.warn("Tracking pixel load failed:", e.message); }
}

export function pingUrls(urls = []) {
  urls.forEach(pingUrl);
}

export function mergeTrackers(...sets) {
  const merged = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [event, urls] of Object.entries(set)) {
      if (!urls?.length) continue;
      (merged[event] ||= []).push(...urls);
    }
  }
  for (const [event, urls] of Object.entries(merged)) {
    merged[event] = [...new Set(urls.filter(Boolean))];
  }
  return merged;
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function fmtTime(sec) {
  if (!sec || !isFinite(sec)) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`;
}

// Validate an M3U playlist with a bounded initial response (default 64 KB).
// Returns { ok, reason } without downloading the full playlist.
export async function validateM3UChunk(url, { signal, maxBytes = 64 * 1024, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const byteLimit = Math.min(256 * 1024, Math.max(1024, Number(maxBytes) || 64 * 1024));
  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;
  const abortSignal = controller.signal;
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const res = await fetch(`${API}/proxy?url=${encodeURIComponent(url)}`, {
      method: "GET",
      signal: abortSignal,
    });

    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }

    // Read at most maxBytes from the response body.
    const reader = res.body?.getReader?.();
    if (!reader) return { ok: false, reason: "Playlist response does not support bounded validation" };

    let received = 0;
    let chunk = "";
    while (received < byteLimit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = byteLimit - received;
      const boundedValue = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      received += boundedValue.byteLength;
      chunk += new TextDecoder().decode(boundedValue, { stream: true });
    }
    // Cancel the remaining stream to avoid downloading the rest.
    try { await reader.cancel(); } catch { /* ignore */ }

    return validateM3UText(chunk);
  } catch (e) {
    if (e.name === "AbortError" || abortSignal.aborted) {
      return { ok: false, reason: timedOut ? "Playlist validation timed out" : "Playlist validation cancelled" };
    }
    return { ok: false, reason: e?.message || "Validation failed" };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

function validateM3UText(text) {
  if (!text || !text.includes("#EXTM3U")) {
    return { ok: false, reason: "Not a valid M3U playlist" };
  }
  if (!text.includes("#EXTINF")) {
    return { ok: false, reason: "Playlist contains no channels" };
  }
  return { ok: true, reason: null };
}

export function parseM3U(text) {
  if (!text) return [];
  const lines = text.split("\n"); const out = [];
  let cur = null;
  let epgUrls = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXTM3U")) {
      const match = line.match(/(?:url-tvg|x-tvg-url)="([^"]+)"/i);
      if (match) {
        epgUrls = match[1].split(/[,|]/).map(u => u.trim()).filter(Boolean);
      }
    } else if (line.startsWith("#EXTINF")) {
      const name   = (line.match(/,(.+)$/) || [])[1]?.trim() || "Unknown";
      const logo   = (line.match(/tvg-logo="([^"]+)"/) || [])[1] || null;
      const group  = (line.match(/group-title="([^"]+)"/) || [])[1] || "Uncategorized";
      const epgId  = (line.match(/tvg-id="([^"]+)"/) || [])[1] || null;
      const num    = parseInt((line.match(/tvg-chno="([^"]+)"/) || [])[1]) || null;
      cur = { name, logo, group, epgId, num, type:"live" };
    } else if (line && !line.startsWith("#") && cur) {
      cur.url = line; cur.id = cur.url;
      if (line.includes("/movie/")) cur.type = "vod";
      else if (line.includes("/series/")) cur.type = "series";
      out.push(cur); cur = null;
    }
  }
  out.epgUrls = epgUrls;
  return out;
}

export function debounce(func, wait) {
  let timeout;
  return function(...args) {
    const context = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), wait);
  };
}

// Generate CSS variables from theme object
export function genCSS(t) {
  if (!t) return "";
  const isLight = t.bg === "#ffffff" || t.bg === "#f8f9fc";
  const b1 = isLight ? "rgba(0,0,0,0.07)" : "rgba(255,255,255,0.06)";
  const b2 = isLight ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.11)";
  return `
:root{
  --bg:${t.bg};--s1:${t.s1};--s2:${t.s2};--s3:${t.s3};
  --b1:${b1};--b2:${b2};
  --accent:${t.accent};--accent2:${t.accent2};
  --glow:${t.accent}28;
  --accent-10:${t.accent}10;--accent-12:${t.accent}12;--accent-14:${t.accent}14;--accent-15:${t.accent}15;
  --accent-18:${t.accent}18;--accent-22:${t.accent}22;--accent-30:${t.accent}30;--accent-40:${t.accent}40;--accent-50:${t.accent}50;
  --accent2-22:${t.accent2}22;
  --t1:${t.t1};--t2:${t.t2};--t3:${t.t3};
  --danger:#ff4466;--ok:#00cc88;
  --shadow:${isLight ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.5)"};
  --hover-bg:${isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.03)"};
}`;
}
