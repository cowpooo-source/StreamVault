require("dotenv").config();
const express = require("express");
const fetch   = require("node-fetch");
const cors    = require("cors");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(",").map(s => s.trim()) : "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
}));
app.use(express.json());

// ── Cache: path resolution cached long-term, tokens are never cached (portals invalidate on re-handshake)
const pathCache = new Map();

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function cacheKey(portal, mac) {
  return `${portal.replace(/\/+$/, "")}|${mac}`;
}

// Fallback API paths to try (from extractstb PortalValidator)
const API_PATHS = [
  "server/load.php",
  "portal.php",
  "stalker_portal/server/load.php",
];

// Build Stalker-style headers (improved from extractstb)
function stalkerHeaders(mac, token = "", portalUrl = "", opts = {}) {
  const referer = portalUrl
    ? portalUrl.replace(/\/+$/, "").replace(/\/c$/, "") + "/c/"
    : "http://localhost/";
  const headers = {
    "User-Agent":    "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
    "Accept":        "*/*",
    "Content-Type":  "application/x-www-form-urlencoded; charset=UTF-8",
    "X-User-Agent":  "Model: MAG250; Link: WiFi",
    "Authorization": token ? `Bearer ${token}` : "Bearer ",
    "Cookie":        `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=Europe%2FParis`,
    "Referer":       referer,
  };
  if (opts.serial) headers["Cookie"] += `; sn=${opts.serial}`;
  return headers;
}

// Try to extract the real API path from the portal's xpcom.common.js
// (extractstb PortalValidator step 1)
async function extractApiPath(portalUrl, mac) {
  const base = portalUrl.replace(/\/+$/, "");
  const clientUrl = base.endsWith("/c") ? base : base + "/c";
  const url = `${clientUrl}/xpcom.common.js`;
  try {
    const res = await fetch(url, {
      headers: stalkerHeaders(mac, "", portalUrl),
      timeout: 8000,
    });
    if (!res.ok) return null;
    const js = await res.text();

    // Pattern 1: dynamic portal path
    let m = js.match(/this\.ajax_loader\s*=\s*this\.portal_protocol\s*\+\s*"[^"]*"\s*\+\s*this\.portal_ip\s*\+\s*"\/"\s*\+\s*this\.portal_path\s*\+\s*"\/([^"]+)"/);
    if (m) return m[1];

    // Pattern 2: simplified dynamic
    m = js.match(/this\.ajax_loader\s*=\s*[^"]*"[^"]*\/([^"]+\.php)"/);
    if (m) return m[1];

    // Pattern 3: static path
    m = js.match(/this\.ajax_loader\s*=\s*"\/([^"]+\.php)"/);
    if (m) return m[1];
  } catch { /* ignore */ }
  return null;
}

// Try a handshake with a specific base + apiPath combo, using both GET and POST
async function tryHandshake(base, apiPath, mac, portalUrl) {
  const qs = `type=stb&action=handshake&prehash=0&token=&JsHttpRequest=1-xml`;
  const url = `${base}${apiPath}?${qs}`;
  const headers = stalkerHeaders(mac, "", portalUrl);

  try {
    const res = await fetch(url, { headers, timeout: 8000 });
    if (res.status === 429) { console.log(`  ${base}${apiPath} → 429 rate limited`); throw Object.assign(new Error("rate limited"), {code:"RATE_LIMITED"}); }
    if (res.status === 404) return null;
    if (res.ok) {
      const data = await res.json();
      const token = data?.js?.token;
      if (token) return { token, base, apiPath };
    }
  } catch(e) { if (e.code === "RATE_LIMITED") throw e; /* other errors: skip */ }
  return null;
}

// Get a session with a valid token — does exactly ONE handshake
// Path resolution is cached; token is always fresh
async function getSession(portal, mac, opts = {}) {
  const key = cacheKey(portal, mac);
  const cached = pathCache.get(key);

  // If path is known, do a single handshake on the known path
  if (cached) {
    const result = await tryHandshake(cached.base, cached.apiPath, mac, portal);
    if (result) {
      return {
        token: result.token, base: cached.base, apiPath: cached.apiPath, portal, mac, opts,
        headers: stalkerHeaders(mac, result.token, portal, opts),
        async refresh() { return getSession(portal, mac, opts); },
      };
    }
    // Path may have changed — clear cache and re-discover
    pathCache.delete(key);
  }

  // Discover path: try each base+path combo (each attempt is a handshake)
  const stripped = portal.replace(/\/+$/, "");
  const bases = [stripped + "/"];
  if (stripped.endsWith("/c")) {
    bases.push(stripped.replace(/\/c$/, "") + "/");
    const root = stripped.replace(/\/[^/]+\/c$/, "");
    if (root !== stripped) bases.push(root + "/");
  } else {
    bases.push(stripped + "/c/");
  }

  for (const base of bases) {
    for (const path of API_PATHS) {
      try {
        const result = await tryHandshake(base, path, mac, portal);
        if (result) {
          pathCache.set(key, { base, apiPath: path });
          console.log(`✓ Path resolved: ${base}${path}`);
          return {
            token: result.token, base, apiPath: path, portal, mac, opts,
            headers: stalkerHeaders(mac, result.token, portal, opts),
            async refresh() { return getSession(portal, mac, opts); },
          };
        }
      } catch(e) {
        if (e.code === "RATE_LIMITED") throw new Error("Portal rate limited (429). Try again in a minute.");
        throw e;
      }
    }
  }
  throw new Error("Handshake failed: could not obtain token from portal");
}

// portalFetch with automatic token refresh on auth failure
async function portalFetchRetry(session, params, timeout) {
  let result = await portalFetch(session, params, timeout);
  if (result === null) {
    const fresh = await session.refresh();
    Object.assign(session, fresh);
    result = await portalFetch(session, params, timeout);
  }
  if (result === null) throw new Error(`Authorization failed for ${params.action || "unknown"}`);
  return result;
}

// Make an API call using the resolved session
async function portalFetch(session, params, timeout = 12000) {
  const qs = new URLSearchParams({ ...params, JsHttpRequest: "1-xml" }).toString();
  const url = `${session.base}${session.apiPath}?${qs}`;

  try {
    const res = await fetch(url, { headers: session.headers, timeout });
    if (res.ok) {
      const text = await res.text();
      if (text.includes("Authorization failed")) return null; // token expired, signal retry
      return JSON.parse(text);
    }
  } catch { /* network error */ }

  // Try POST as fallback
  try {
    const res = await fetch(url, { method: "POST", headers: session.headers, body: qs, timeout });
    if (res.ok) {
      const text = await res.text();
      if (text.includes("Authorization failed")) return null;
      return JSON.parse(text);
    }
  } catch { /* network error */ }

  throw new Error(`Portal request failed: ${params.action || "unknown"}`);
}

// ─────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ── POST /stalker/handshake
app.post("/stalker/handshake", async (req, res) => {
  const { portal, mac, serial, deviceId, deviceId2 } = req.body;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const session = await getSession(portal, mac, { serial });
    res.json({ token: session.token });
  } catch (e) {
    console.error("Handshake error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/api (generic passthrough)
app.get("/stalker/api", async (req, res) => {
  const { portal, mac, ...apiParams } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const session = await getSession(portal, mac);
    const data = await portalFetchRetry(session, apiParams);
    res.json(data);
  } catch (e) {
    console.error("API proxy error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/channels
app.get("/stalker/channels", async (req, res) => {
  const { portal, mac } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const session = await getSession(portal, mac);

    const genreData = await portalFetchRetry(session, { type: "itv", action: "get_genres" }, 10000);
    const chData = await portalFetchRetry(session, { type: "itv", action: "get_all_channels" }, 15000);

    const genres = genreData?.js || [];
    const genreMap = Object.fromEntries(genres.map(g => [g.id, g.title]));
    const channels = chData?.js?.data || [];

    const result = channels.map(ch => ({
      id:    ch.id,
      name:  ch.name,
      num:   ch.number,
      logo:  ch.logo || ch.icon || null,
      group: genreMap[ch.tv_genre_id] || "Other",
      url:   ch.cmd || null,
      epgId: ch.xmltv_id || null,
      type:  "live",
    }));

    res.json({ channels: result, total: result.length });
  } catch (e) {
    console.error("Channels error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── Fetch all paginated items for a given Stalker type (vod/series)
// Fetch all pages for a specific category (sequential, safe, stops on empty page).
async function fetchAllPages(session, type, category, maxItems = 500) {
  const all = [];

  for (let page = 1; all.length < maxItems; page++) {
    let data;
    try {
      data = await portalFetchRetry(session,
        { type, action: "get_ordered_list", category, page, p: page }, 20000);
    } catch (e) {
      console.warn(`fetchAllPages ${type} cat=${category} page=${page}: ${e.message}`);
      break;
    }

    const items = data?.js?.data;
    if (!items || !items.length) break;

    all.push(...items);

    const declaredTotal = parseInt(data.js.total_items || data.js.results_num || 0);
    if (declaredTotal > 0 && all.length >= declaredTotal) break;

    const declaredPages = parseInt(data.js.total_pages || data.js.pages_count || 0);
    if (declaredPages > 0 && page >= declaredPages) break;
  }

  return all;
}

// ── GET /stalker/vod/categories  — returns category list only (fast, single request)
app.get("/stalker/vod/categories", async (req, res) => {
  const { portal, mac } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
  try {
    const session = await getSession(portal, mac);
    const catData = await portalFetchRetry(session, { type: "vod", action: "get_categories" }, 10000);
    const categories = (catData?.js || []).map(c => ({
      id:    String(c.id),
      title: c.title,
      count: parseInt(c.count || c.videos_count || c.censored_count || 0),
    }));
    res.json({ categories });
  } catch (e) {
    console.error("VOD categories error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/vod?cat=ID  — returns items for one category (lazy load)
app.get("/stalker/vod", async (req, res) => {
  const { portal, mac, cat } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
  if (!cat)            return res.status(400).json({ error: "cat (category id) required" });

  try {
    const session  = await getSession(portal, mac);
    const rawItems = await fetchAllPages(session, "vod", cat);

    const items = rawItems.map(v => ({
      id:     v.id,
      name:   v.name,
      logo:   v.screenshot_uri || v.cover || null,
      year:   v.year,
      rating: v.rating_imdb || v.rating || null,
      url:    v.cmd || null,
      type:   "vod",
    }));

    console.log(`VOD cat=${cat} loaded: ${items.length} items`);
    res.json({ items, total: items.length });
  } catch (e) {
    console.error("VOD error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/stream
// content_type: "live" (default) uses type=itv, "vod" uses type=vod, "series" uses type=vod
app.get("/stalker/stream", async (req, res) => {
  const { portal, mac, cmd, content_type } = req.query;
  if (!portal || !mac || !cmd) return res.status(400).json({ error: "portal, mac and cmd required" });

  // Map content_type to the correct Stalker API type parameter
  const stalkerType = (content_type === "vod" || content_type === "series") ? "vod" : "itv";

  try {
    const session = await getSession(portal, mac);
    const data = await portalFetchRetry(session, {
      type: stalkerType, action: "create_link",
      cmd, series: 0, forced_storage: 0,
      disable_ad: 0, download: 0, force_ch_link_check: 0,
    });

    const streamUrl = data?.js?.cmd;
    if (!streamUrl) throw new Error("No stream URL returned");

    const cleanUrl = streamUrl.replace(/^ffmpeg\s+/, "").trim();
    res.json({ url: cleanUrl });
  } catch (e) {
    console.error("Stream resolve error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/series/categories
app.get("/stalker/series/categories", async (req, res) => {
  const { portal, mac } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
  try {
    const session = await getSession(portal, mac);
    const catData = await portalFetchRetry(session, { type: "series", action: "get_categories" }, 10000);
    const categories = (catData?.js || []).map(c => ({
      id:    String(c.id),
      title: c.title,
      count: parseInt(c.count || c.videos_count || c.censored_count || 0),
    }));
    res.json({ categories });
  } catch (e) {
    console.error("Series categories error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/series?cat=ID
app.get("/stalker/series", async (req, res) => {
  const { portal, mac, cat } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
  if (!cat)            return res.status(400).json({ error: "cat (category id) required" });

  try {
    const session  = await getSession(portal, mac);
    const rawItems = await fetchAllPages(session, "series", cat);

    const items = rawItems.map(s => ({
      id:     s.id,
      name:   s.name,
      logo:   s.screenshot_uri || s.cover || null,
      year:   s.year,
      rating: s.rating_imdb || s.rating || null,
      type:   "series",
    }));

    console.log(`Series cat=${cat} loaded: ${items.length} items`);
    res.json({ items, total: items.length });
  } catch (e) {
    console.error("Series error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/series/episode/stream — resolve a playable URL for a series episode
// NOTE: This static route must be registered BEFORE the parameterized :seriesId route
app.get("/stalker/series/episode/stream", async (req, res) => {
  const { portal, mac, cmd, episode } = req.query;
  if (!portal || !mac || !cmd || !episode) {
    return res.status(400).json({ error: "portal, mac, cmd and episode required" });
  }

  try {
    const session = await getSession(portal, mac);
    const data = await portalFetchRetry(session, {
      type: "vod", action: "create_link",
      cmd, series: episode, forced_storage: 0,
      disable_ad: 0, download: 0, force_ch_link_check: 0,
    });

    const streamUrl = data?.js?.cmd;
    if (!streamUrl) throw new Error("No stream URL returned for episode");

    const cleanUrl = streamUrl.replace(/^ffmpeg\s+/, "").trim();
    console.log(`Series episode stream resolved: ep=${episode}`);
    res.json({ url: cleanUrl });
  } catch (e) {
    console.error("Series episode stream error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/series/:seriesId/seasons — returns seasons with episode lists
app.get("/stalker/series/:seriesId/seasons", async (req, res) => {
  const { portal, mac } = req.query;
  const { seriesId } = req.params;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
  if (!seriesId)       return res.status(400).json({ error: "seriesId required" });

  try {
    const session = await getSession(portal, mac);
    // movie_id is the numeric part of the series id (e.g. "646" from "646:646")
    const movieId = seriesId.split(":")[0];
    const data = await portalFetchRetry(session, {
      type: "series", action: "get_ordered_list",
      movie_id: movieId, page: 1, p: 1,
    }, 20000);

    const rawSeasons = data?.js?.data || [];
    const seasons = rawSeasons.map(s => ({
      id:       s.id,
      name:     s.name,
      cmd:      s.cmd || "",
      episodes: Array.isArray(s.series) ? s.series : [],
      logo:     s.screenshot_uri || s.cover || null,
    }));

    console.log(`Series ${seriesId} seasons: ${seasons.length} (episodes: ${seasons.map(s => s.episodes.length).join(",")})`);
    res.json({ seasons });
  } catch (e) {
    console.error("Series seasons error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/profile (new — from extractstb)
app.get("/stalker/profile", async (req, res) => {
  const { portal, mac, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const session = await getSession(portal, mac, { serial });
    const params = {
      type: "stb", action: "get_profile",
      auth_second_step: 1,
      hw_version_2: "8b80dfaa8cf83485567849b7202a79360fc988e3",
    };
    if (serial) params.sn = serial;
    if (deviceId) params.device_id = deviceId;
    if (deviceId2 || deviceId) params.device_id2 = deviceId2 || deviceId;
    const data = await portalFetchRetry(session, params);
    res.json(data?.js || {});
  } catch (e) {
    console.error("Profile error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/account (new — from extractstb)
app.get("/stalker/account", async (req, res) => {
  const { portal, mac } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const session = await getSession(portal, mac);
    const data = await portalFetchRetry(session, {
      type: "account_info", action: "get_main_info",
    });
    res.json(data?.js || {});
  } catch (e) {
    console.error("Account error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/epg?portal=...&mac=...&period=N
// Fetches EPG data for all channels (period in hours, default 4)
app.get("/stalker/epg", async (req, res) => {
  const { portal, mac, period = 4 } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const session = await getSession(portal, mac);
    const data = await portalFetchRetry(session, {
      type: "itv", action: "get_epg_info", period,
    }, 20000);

    const programs = {};
    const epgData = data?.js?.data || data?.js || {};
    for (const [channelId, shows] of Object.entries(epgData)) {
      if (!Array.isArray(shows)) continue;
      programs[channelId] = shows.map(s => ({
        title: s.name || s.title || "",
        start: (s.start_timestamp || s.start || 0) * 1000,
        stop:  (s.stop_timestamp || s.stop || 0) * 1000,
      }));
    }

    res.json({ programs });
  } catch (e) {
    console.error("EPG error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── /stream?url=... — streaming proxy for live IPTV streams (pipes body, preserves IP-bound tokens)
// Handles GET (stream data), HEAD (check availability), and OPTIONS (CORS preflight)
app.options("/stream", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Range, Content-Type");
  res.set("Access-Control-Max-Age", "86400");
  res.status(204).end();
});

app.head("/stream", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  try {
    const upstream = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "StreamVault/1.0" },
      redirect: "follow",
    });
    res.set("Access-Control-Allow-Origin", "*");
    const ct = upstream.headers.get("content-type");
    if (ct) res.set("Content-Type", ct);
    const cl = upstream.headers.get("content-length");
    if (cl) res.set("Content-Length", cl);
    res.status(upstream.status).end();
  } catch (e) {
    console.error("Stream HEAD error:", e.message);
    if (!res.headersSent) res.status(502).end();
  }
});

app.get("/stream", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "StreamVault/1.0" },
      redirect: "follow",
    });
    if (!upstream.ok) return res.status(upstream.status).end();
    const ct = upstream.headers.get("content-type") || "";
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Range, Content-Type");

    // For HLS manifests: rewrite relative segment URLs to proxy through /stream
    // This ensures segments are fetched from the same IP that got the manifest
    if (ct.includes("mpegurl") || ct.includes("m3u") || url.endsWith(".m3u8")) {
      const text = await upstream.text();
      const origin = new URL(url).origin;
      const selfBase = `${req.protocol}://${req.get("host")}`;
      const rewritten = text.replace(/^(\/[^\s]+\.ts[^\s]*)$/gm, (match) => {
        return `${selfBase}/stream?url=${encodeURIComponent(origin + match)}`;
      }).replace(/^(\/[^\s]+\.m3u8[^\s]*)$/gm, (match) => {
        return `${selfBase}/stream?url=${encodeURIComponent(origin + match)}`;
      });
      res.set("Content-Type", ct);
      res.send(rewritten);
    } else {
      if (ct) res.set("Content-Type", ct);
      upstream.body.pipe(res);
    }
  } catch (e) {
    console.error("Stream proxy error:", e.message);
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

// ── GET /proxy?url=... — generic CORS proxy for Xtream API and M3U fetches
app.get("/proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });

  try {
    const upstream = await fetch(url, { timeout: 30000, headers: { "User-Agent": "StreamVault/1.0" } });
    const contentType = upstream.headers.get("content-type") || "";

    if (contentType.includes("json")) {
      const data = await upstream.json();
      res.json(data);
    } else {
      const text = await upstream.text();
      res.set("Content-Type", contentType || "text/plain");
      res.send(text);
    }
  } catch (e) {
    console.error("Proxy error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Stalker proxy running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
