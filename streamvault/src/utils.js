// Utility functions for StreamVault

export const API = import.meta.env.VITE_API_URL || ""; // Proxy URL for API calls, empty for relative paths
export const VAST_URL = import.meta.env.VITE_VAST_URL || "";
export const VAST_FETCH_TIMEOUT_MS = 3500;

export function vastProxyUrl(url) {
  return `${API}/api/vast?url=${encodeURIComponent(url)}`;
}

export function streamProxy(u) {
  return (u?.startsWith('/') || u?.startsWith(API)) ? u : `${API}/stream?url=${encodeURIComponent(u)}`;
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
  } catch {}
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

// Parse M3U playlist text into array of {name, url} objects
export function parseM3U(text) {
  if (!text) return [];
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const items = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("#EXTINF")) {
      const nameMatch = line.match(/#EXTINF:-?\d+(?:[^,]*),(.+)/);
      current = { name: nameMatch ? nameMatch[1].trim() : "Unknown" };
    } else if (line && !line.startsWith("#")) {
      if (current) {
        current.url = line;
        items.push(current);
        current = null;
      }
    }
  }
  return items;
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
