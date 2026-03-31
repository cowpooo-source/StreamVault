require("dotenv").config();
const express     = require("express");
const fetch       = require("node-fetch");
const cors        = require("cors");
const compression = require("compression");
const cache       = require("./cache");
const { Transform } = require("stream");

const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");

const http  = require("http");
const https = require("https");
const keepAliveAgent      = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveAgentHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });
const agentFor = (url) => url.startsWith("https") ? keepAliveAgentHttps : keepAliveAgent;

const app  = express();
const PORT = process.env.PORT || 3001;

// Block SSRF: validate proxy URLs
function isUrlAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    // Only allow http and https
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    // Block localhost
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return false;
    // Block private IPs
    const parts = host.split(".").map(Number);
    if (parts.length === 4) {
      if (parts[0] === 10) return false; // 10.x.x.x
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false; // 172.16-31.x.x
      if (parts[0] === 192 && parts[1] === 168) return false; // 192.168.x.x
      if (parts[0] === 169 && parts[1] === 254) return false; // 169.254.x.x (cloud metadata)
      if (parts[0] === 0) return false; // 0.x.x.x
    }
    return true;
  } catch { return false; }
}

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({
  origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(",").map(s => s.trim()),
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
}));

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // too restrictive for our inline scripts
  crossOriginEmbedderPolicy: false,
}));

// Rate limiting
app.use("/api/feedback", rateLimit({ windowMs: 60000, max: 10, message: { error: "Too many feedback submissions" } }));
app.use("/api/", rateLimit({ windowMs: 60000, max: 60, message: { error: "Too many requests" } }));
app.use("/stalker/", rateLimit({ windowMs: 60000, max: 600, message: { error: "Too many requests" } }));

// Fix 5: Reduce default JSON body limit
app.use("/api/sync", express.json({ limit: "5mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(compression());

// Admin password for analytics (set in .env or defaults to "admin")
const ADMIN_PASS = process.env.ADMIN_PASS;

// Track requests, visitors, guests, and portals
app.use((req, res, next) => {
  const p = req.path;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  if (p !== "/health" && p !== "/analytics" && p !== "/api/analytics") {
    if (p.startsWith("/stalker/")) cache.trackRequest("stalker");
    else if (p === "/stream") cache.trackRequest("stream");
    else if (p === "/proxy") cache.trackRequest("proxy");
    else cache.trackRequest("other");
    cache.trackVisitor(ip);
    // Track guest
    const guestId = req.headers["x-guest-id"];
    if (guestId) cache.trackGuest(guestId, ip);
  }
  // Track portal usage
  if (p.startsWith("/stalker/") && req.query.portal && req.query.mac) {
    const type = p.includes("/vod") ? "vod" : p.includes("/series") ? "series" : p.includes("/epg") ? "epg" : "live";
    cache.trackPortal(req.query.portal, req.query.mac, type);
  }
  next();
});

// ── POST /api/track — track watch events from frontend
app.post("/api/track", express.json(), (req, res) => {
  const { name, type, guestId, event } = req.body;
  if (event === "play" && name) cache.trackWatch(name, type);
  if (guestId && event === "connect") cache.trackGuestActivity(guestId, "connections");
  if (guestId && event === "favorite") cache.trackGuestActivity(guestId, "favorites");
  if (guestId && event === "history") cache.trackGuestActivity(guestId, "history");
  res.json({ ok: true });
});

// ── POST /api/feedback — submit user feedback
app.post("/api/feedback", express.json(), (req, res) => {
  const { message, guestId, timestamp, userAgent } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: "Message is required" });
  if (message.length > 2000) return res.status(400).json({ error: "Message too long (max 2000 chars)" });
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  cache.saveFeedback(message.trim(), guestId, userAgent, ip);
  res.json({ ok: true });
});

// ── GET /api/feedback — admin-only, returns all feedback
app.get("/api/feedback", (req, res) => {
  if (!ADMIN_PASS) return res.status(503).json({ error: "ADMIN_PASS not configured" });
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_PASS) return res.status(401).json({ error: "Unauthorized" });
  res.json({ feedback: cache.getFeedback() });
});

// ── PUT /api/sync/:type — save favorites or history
app.put("/api/sync/:type", express.json(), (req, res) => {
  const { type } = req.params;
  if (type !== "favorites" && type !== "history") return res.status(400).json({ error: "Invalid type" });
  const guestId = req.headers["x-guest-id"];
  if (!guestId) return res.status(400).json({ error: "X-Guest-Id required" });
  const { connId, data } = req.body;
  if (!connId || !data) return res.status(400).json({ error: "connId and data required" });
  cache.saveGuestData(guestId, connId, type, data);
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  cache.trackGuest(guestId, ip);
  res.json({ ok: true });
});

// ── GET /api/sync/:type — restore favorites or history
app.get("/api/sync/:type", (req, res) => {
  const { type } = req.params;
  if (type !== "favorites" && type !== "history") return res.status(400).json({ error: "Invalid type" });
  const guestId = req.headers["x-guest-id"];
  if (!guestId) return res.status(400).json({ error: "X-Guest-Id required" });
  const connId = req.query.connId;
  if (!connId) return res.status(400).json({ error: "connId required" });
  const data = cache.getGuestData(guestId, connId, type);
  res.json({ data });
});

// ── DELETE /api/sync — delete all data for a connection
app.delete("/api/sync", (req, res) => {
  const guestId = req.headers["x-guest-id"];
  const connId = req.query.connId;
  if (guestId && connId) cache.deleteGuestData(guestId, connId);
  res.json({ ok: true });
});

// ── Cache: path resolution cached long-term, tokens are never cached (portals invalidate on re-handshake)
const pathCache = new Map();
function setPathCache(key, value) {
  if (pathCache.size > 500) pathCache.clear();
  pathCache.set(key, value);
}

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
      agent: agentFor(url),
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
    const res = await fetch(url, { headers, timeout: 8000, agent: agentFor(url) });
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
          setPathCache(key, { base, apiPath: path });
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
    const res = await fetch(url, { headers: session.headers, timeout, agent: agentFor(url) });
    if (res.ok) {
      const text = await res.text();
      if (text.includes("Authorization failed")) return null; // token expired, signal retry
      return JSON.parse(text);
    }
  } catch { /* network error */ }

  // Try POST as fallback
  try {
    const res = await fetch(url, { method: "POST", headers: session.headers, body: qs, timeout, agent: agentFor(url) });
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

// ── POST /stalker/validate — comprehensive connection check
app.post("/stalker/validate", async (req, res) => {
  const { portal, mac, serial, deviceId, deviceId2 } = req.body;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  const result = {
    valid: false,
    status: "unknown",
    statusCode: null,
    expiry: null,
    daysLeft: null,
    serial: null,
    deviceId: null,
    deviceId2: null,
    maxConnections: null,
    tariff: null,
    phone: null,
    portalReachable: false,
    error: null,
  };

  try {
    // Step 1: Handshake (validates portal is reachable + MAC is recognized)
    const session = await getSession(portal, mac, { serial });
    result.portalReachable = true;

    // Step 2: Get Profile (extract device info)
    try {
      const profileParams = {
        type: "stb", action: "get_profile",
        auth_second_step: 1,
        hw_version_2: "8b80dfaa8cf83485567849b7202a79360fc988e3",
      };
      if (serial) profileParams.sn = serial;
      if (deviceId) profileParams.device_id = deviceId;
      if (deviceId2 || deviceId) profileParams.device_id2 = deviceId2 || deviceId;
      const profile = await portalFetchRetry(session, profileParams);
      const p = profile?.js || {};
      result.serial = p.serial_number || p.sn || serial || null;
      result.deviceId = p.device_id || deviceId || null;
      result.deviceId2 = p.device_id2 || deviceId2 || deviceId || null;
    } catch {}

    // Step 3: Get Account Info (status, expiry, tariff)
    try {
      const account = await portalFetchRetry(session, {
        type: "account_info", action: "get_main_info",
      });
      const a = account?.js || {};

      // Status interpretation
      const statusVal = a.status !== undefined ? parseFloat(a.status) : 0;
      if (statusVal === 0) result.status = "active";
      else if (statusVal === 1) result.status = "unregistered";
      else if (statusVal === 2) result.status = "suspended";
      else if (statusVal === 3) result.status = "expired";
      else if (statusVal === 4) result.status = "blocked";
      else result.status = `status:${statusVal}`;
      result.statusCode = statusVal;

      // Expiry date parsing (try multiple fields and formats)
      const expiryStr = a.expire_billing_date || a.expired_date || a.expire_date || null;
      if (expiryStr && expiryStr !== "0000-00-00" && expiryStr !== "0000-00-00 00:00:00") {
        // Try parsing various date formats
        let expDate = null;
        const formats = [
          /^(\d{4})-(\d{2})-(\d{2})/, // yyyy-MM-dd
          /^(\d{2})\/(\d{2})\/(\d{4})/, // MM/dd/yyyy or dd/MM/yyyy
        ];
        const m1 = expiryStr.match(formats[0]);
        if (m1) expDate = new Date(parseInt(m1[1]), parseInt(m1[2])-1, parseInt(m1[3]));
        if (!expDate) {
          const m2 = expiryStr.match(formats[1]);
          if (m2) expDate = new Date(parseInt(m2[3]), parseInt(m2[1])-1, parseInt(m2[2]));
        }
        if (!expDate) expDate = new Date(expiryStr); // fallback to native parser

        if (expDate && !isNaN(expDate.getTime())) {
          result.expiry = expDate.toISOString().slice(0, 10);
          result.daysLeft = Math.ceil((expDate.getTime() - Date.now()) / 86400000);
          if (result.daysLeft < 0) result.status = "expired";
        }
      }

      result.tariff = a.tariff_plan || a.tariff || null;
      result.phone = a.phone || null;
      result.maxConnections = a.max_cur || a.max_connections || null;

      // Check if account info was empty (blocked/invalid)
      if (Object.keys(a).length === 0) {
        result.status = "blocked";
        result.error = "Account returned empty info — may be blocked";
      }
    } catch (e) {
      result.error = "Could not fetch account info: " + e.message;
    }

    result.valid = (result.status === "active" && (result.daysLeft === null || result.daysLeft > 0));
    res.json(result);
  } catch (e) {
    result.error = e.message;
    if (e.message.includes("Handshake failed")) result.error = "Portal unreachable or MAC not recognized";
    if (e.message.includes("rate limited") || e.message.includes("429")) result.error = "Portal rate limited — try again later";
    res.json(result);
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
  const { portal, mac, refresh } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  const ck = cache.cacheKey(portal, mac, "channels");
  if (!refresh) {
    const cached = cache.get(ck);
    if (cached) return res.json(cached);
  }

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

    const data = { channels: result, total: result.length };
    cache.set(ck, data);
    res.json(data);
  } catch (e) {
    console.error("Channels error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── Fetch all paginated items for a given Stalker type (vod/series)
// Fetches first page to get total, then remaining pages in parallel batches of 3.
async function fetchAllPages(session, type, category, maxItems = 500) {
  // First page to get total
  let data;
  try {
    data = await portalFetchRetry(session, { type, action: "get_ordered_list", category, page: 1, p: 1 }, 20000);
  } catch { return []; }

  const items = data?.js?.data || [];
  if (!items.length) return [];

  const all = [...items];
  const totalPages = parseInt(data.js.total_pages || data.js.pages_count || 1);
  const declaredTotal = parseInt(data.js.total_items || data.js.results_num || 0);

  if (totalPages <= 1 || (declaredTotal > 0 && all.length >= declaredTotal)) return all.slice(0, maxItems);

  // Fetch remaining pages in parallel batches of 3
  const CONCURRENCY = 3;
  for (let start = 2; start <= totalPages && all.length < maxItems; start += CONCURRENCY) {
    const batch = [];
    for (let p = start; p < start + CONCURRENCY && p <= totalPages; p++) batch.push(p);
    const results = await Promise.all(batch.map(p =>
      portalFetchRetry(session, { type, action: "get_ordered_list", category, page: p, p }, 20000).catch(() => null)
    ));
    for (const r of results) {
      const pageItems = r?.js?.data;
      if (pageItems?.length) all.push(...pageItems);
    }
  }

  return all.slice(0, maxItems);
}

// ── GET /stalker/vod/categories  — returns category list only (fast, single request)
app.get("/stalker/vod/categories", async (req, res) => {
  const { portal, mac, refresh } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  const ck = cache.cacheKey(portal, mac, "vod-cats");
  if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(cached); } } cache.trackCacheMiss();

  try {
    const session = await getSession(portal, mac);
    const catData = await portalFetchRetry(session, { type: "vod", action: "get_categories" }, 10000);
    const categories = (catData?.js || []).map(c => ({
      id:    String(c.id),
      title: c.title,
      count: parseInt(c.count || c.videos_count || c.censored_count || 0),
    }));
    const data = { categories };
    cache.set(ck, data);
    res.json(data);
  } catch (e) {
    console.error("VOD categories error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/vod?cat=ID  — returns items for one category (lazy load)
app.get("/stalker/vod", async (req, res) => {
  const { portal, mac, cat, refresh } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
  if (!cat)            return res.status(400).json({ error: "cat (category id) required" });

  const ck = cache.cacheKey(portal, mac, "vod", cat);
  if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(cached); } } cache.trackCacheMiss();

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
      plot:   v.description || v.plot || null,
      genre:  v.genre_str || v.genres_str || null,
      director: v.director || null,
      actors: v.actors || v.cast || null,
      duration: v.duration || v.time || null,
      age:    v.age || v.age_group || null,
      country: v.country || null,
    }));

    const data = { items, total: items.length };
    cache.set(ck, data);
    res.json(data);
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

    let cleanUrl = streamUrl.replace(/^ffmpeg\s+/, "").trim();
    // Some portals return localhost URLs — replace with portal hostname
    if (cleanUrl.includes("localhost") || cleanUrl.includes("127.0.0.1")) {
      try {
        const portalHost = new URL(portal).host;
        cleanUrl = cleanUrl.replace(/localhost(:\d+)?/g, portalHost).replace(/127\.0\.0\.1(:\d+)?/g, portalHost);
      } catch {}
    }
    res.json({ url: cleanUrl });
  } catch (e) {
    console.error("Stream resolve error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/play — resolve create_link + stream in one request (same IP)
app.get("/stalker/play", async (req, res) => {
  const { portal, mac, cmd, content_type, episode, start, end } = req.query;
  if (!portal || !mac || !cmd) return res.status(400).json({ error: "portal, mac and cmd required" });
  const stalkerType = (content_type === "vod" || content_type === "series") ? "vod" : "itv";
  try {
    const session = await getSession(portal, mac);
    const linkParams = {
      type: stalkerType, action: "create_link", cmd,
      series: episode || 0, forced_storage: 0,
      disable_ad: 0, download: 0, force_ch_link_check: 0,
    };
    // Catchup/timeshift: pass start/end timestamps to portal
    if (start) linkParams.start = start;
    if (end) linkParams.end = end;
    const data = await portalFetchRetry(session, linkParams);
    const streamUrl = data?.js?.cmd;
    if (!streamUrl) throw new Error("No stream URL returned");
    let cleanUrl = streamUrl.replace(/^ffmpeg\s+/, "").trim();
    if (cleanUrl.includes("localhost") || cleanUrl.includes("127.0.0.1")) {
      try { const h = new URL(portal).host; cleanUrl = cleanUrl.replace(/localhost(:\d+)?/g, h).replace(/127\.0\.0\.1(:\d+)?/g, h); } catch {}
    }
    // Try to pipe the stream (same IP as create_link), forward Range for seeking
    const fetchHeaders = { "User-Agent": "StreamVault/1.0" };
    if (req.headers.range) fetchHeaders["Range"] = req.headers.range;
    const upstream = await fetch(cleanUrl, { headers: fetchHeaders, redirect: "follow", agent: agentFor(cleanUrl) });
    if (!upstream.ok && upstream.status !== 206) return res.json({ url: cleanUrl });
    const ct = upstream.headers.get("content-type") || "";
    Object.entries(STREAM_CORS).forEach(([k, v]) => res.set(k, v));
    res.set("Accept-Ranges", "bytes");
    if (upstream.status === 206) { res.status(206); const cr = upstream.headers.get("content-range"); if (cr) res.set("Content-Range", cr); }
    const cl = upstream.headers.get("content-length"); if (cl) res.set("Content-Length", cl);
    if (ct.includes("mpegurl") || ct.includes("m3u") || cleanUrl.endsWith(".m3u8")) {
      const origin = new URL(cleanUrl).origin;
      const proto = req.get("x-forwarded-proto") || req.protocol;
      const selfBase = `${proto}://${req.get("host")}`;
      res.set("Content-Type", ct);
      const rewriter = new Transform({
        transform(chunk, enc, cb) {
          const rewritten = chunk.toString().split("\n").map(line => {
            const trimmed = line.trim();
            if (trimmed.startsWith("/") && (trimmed.includes(".ts") || trimmed.includes(".m3u8")))
              return `${selfBase}/stream?url=${encodeURIComponent(origin + trimmed)}`;
            return line;
          }).join("\n");
          cb(null, rewritten);
        }
      });
      upstream.body.pipe(rewriter).pipe(res);
    } else {
      if (ct) res.set("Content-Type", ct);
      upstream.body.pipe(res);
    }
  } catch (e) {
    console.error("Play error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/series/seasons (query-param version)
app.get("/stalker/series/seasons", async (req, res) => {
  const { portal, mac, seriesId, refresh } = req.query;
  if (!portal || !mac || !seriesId) return res.status(400).json({ error: "portal, mac and seriesId required" });

  const ck = cache.cacheKey(portal, mac, "seasons", seriesId);
  if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(cached); } } cache.trackCacheMiss();

  try {
    const session = await getSession(portal, mac);
    const movieId = seriesId.split(":")[0];
    const data = await portalFetchRetry(session, {
      type: "series", action: "get_ordered_list",
      movie_id: movieId, page: 1, p: 1,
    }, 20000);
    const rawSeasons = data?.js?.data || [];
    const seasons = rawSeasons.map(s => ({
      id: s.id, name: s.name, cmd: s.cmd || "",
      episodes: Array.isArray(s.series) ? s.series : [],
      logo: s.screenshot_uri || s.cover || null,
    }));
    const result = { seasons };
    cache.set(ck, result);
    res.json(result);
  } catch (e) {
    console.error("Series seasons error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/series/categories
app.get("/stalker/series/categories", async (req, res) => {
  const { portal, mac, refresh } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  const ck = cache.cacheKey(portal, mac, "series-cats");
  if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(cached); } } cache.trackCacheMiss();

  try {
    const session = await getSession(portal, mac);
    const catData = await portalFetchRetry(session, { type: "series", action: "get_categories" }, 10000);
    const categories = (catData?.js || []).map(c => ({
      id:    String(c.id),
      title: c.title,
      count: parseInt(c.count || c.videos_count || c.censored_count || 0),
    }));
    const data = { categories };
    cache.set(ck, data);
    res.json(data);
  } catch (e) {
    console.error("Series categories error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/series?cat=ID
app.get("/stalker/series", async (req, res) => {
  const { portal, mac, cat, refresh } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
  if (!cat)            return res.status(400).json({ error: "cat (category id) required" });

  const ck = cache.cacheKey(portal, mac, "series", cat);
  if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(cached); } } cache.trackCacheMiss();

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
      plot:   s.description || s.plot || null,
      genre:  s.genre_str || s.genres_str || null,
      director: s.director || null,
      actors: s.actors || s.cast || null,
      duration: s.duration || s.time || null,
      age:    s.age || s.age_group || null,
      country: s.country || null,
    }));

    const data = { items, total: items.length };
    cache.set(ck, data);
    res.json(data);
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
  const { portal, mac, period = 4, refresh } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  // EPG cached for 4 hours (not 7 days — program data changes frequently)
  const EPG_TTL = 4 * 60 * 60 * 1000;
  const ck = cache.cacheKey(portal, mac, "epg");
  if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(cached); } } cache.trackCacheMiss();

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

    const result = { programs };
    cache.set(ck, result, EPG_TTL);
    res.json(result);
  } catch (e) {
    console.error("EPG error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── /stream?url=... — streaming proxy with Range support for VOD seeking
const STREAM_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type",
};

app.options("/stream", (req, res) => {
  Object.entries(STREAM_CORS).forEach(([k, v]) => res.set(k, v));
  res.set("Access-Control-Max-Age", "86400");
  res.status(204).end();
});

app.head("/stream", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  if (!isUrlAllowed(url)) return res.status(403).end();
  try {
    const upstream = await fetch(url, { method: "HEAD", headers: { "User-Agent": "StreamVault/1.0" }, redirect: "follow", agent: agentFor(url) });
    Object.entries(STREAM_CORS).forEach(([k, v]) => res.set(k, v));
    res.set("Accept-Ranges", "bytes");
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
  if (!isUrlAllowed(url)) return res.status(403).json({ error: "URL not allowed" });
  try {
    const headers = { "User-Agent": "StreamVault/1.0" };
    if (req.headers.range) headers["Range"] = req.headers.range;

    const upstream = await fetch(url, { headers, redirect: "follow", agent: agentFor(url) });
    if (!upstream.ok && upstream.status !== 206) return res.status(upstream.status).end();

    const ct = upstream.headers.get("content-type") || "";
    Object.entries(STREAM_CORS).forEach(([k, v]) => res.set(k, v));
    res.set("Accept-Ranges", "bytes");

    if (upstream.status === 206) {
      res.status(206);
      const cr = upstream.headers.get("content-range");
      if (cr) res.set("Content-Range", cr);
    }
    const cl = upstream.headers.get("content-length");
    if (cl) res.set("Content-Length", cl);

    // HLS manifests: rewrite segment URLs via streaming Transform
    if (ct.includes("mpegurl") || ct.includes("m3u") || url.endsWith(".m3u8")) {
      const origin = new URL(url).origin;
      const proto = req.get("x-forwarded-proto") || req.protocol;
      const selfBase = `${proto}://${req.get("host")}`;
      res.set("Content-Type", ct);
      const rewriter = new Transform({
        transform(chunk, enc, cb) {
          const rewritten = chunk.toString().split("\n").map(line => {
            const trimmed = line.trim();
            if (trimmed.startsWith("/") && (trimmed.includes(".ts") || trimmed.includes(".m3u8")))
              return `${selfBase}/stream?url=${encodeURIComponent(origin + trimmed)}`;
            return line;
          }).join("\n");
          cb(null, rewritten);
        }
      });
      upstream.body.pipe(rewriter).pipe(res);
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
  if (!isUrlAllowed(url)) return res.status(403).json({ error: "URL not allowed" });

  try {
    const upstream = await fetch(url, { timeout: 30000, headers: { "User-Agent": "StreamVault/1.0" }, agent: agentFor(url) });
    const contentType = upstream.headers.get("content-type") || "";

    if (contentType.includes("json")) {
      const data = await upstream.json();
      res.json(data);
    } else {
      res.set("Content-Type", contentType || "text/plain");
      upstream.body.pipe(res);
    }
  } catch (e) {
    console.error("Proxy error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// Read network bandwidth from /proc/net/dev (Linux only)
function getNetworkStats() {
  try {
    const fs = require("fs");
    const data = fs.readFileSync("/proc/net/dev", "utf8");
    const lines = data.split("\n");
    let totalRx = 0, totalTx = 0;
    for (const line of lines) {
      // Skip loopback and header lines
      if (line.includes("lo:") || !line.includes(":")) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 10) {
        totalRx += parseInt(parts[1]) || 0;
        totalTx += parseInt(parts[9]) || 0;
      }
    }
    return { rx_bytes: totalRx, tx_bytes: totalTx, rx_gb: Math.round(totalRx / 1073741824 * 100) / 100, tx_gb: Math.round(totalTx / 1073741824 * 100) / 100 };
  } catch { return null; }
}

// Track bandwidth per day in SQLite
function trackDailyBandwidth() {
  const net = getNetworkStats();
  if (!net) return;
  const today = new Date().toISOString().slice(0, 10);
  // Store current cumulative values — diff is calculated at read time
  cache.set(`bw:${today}:current`, { rx: net.rx_bytes, tx: net.tx_bytes }, 30 * 24 * 60 * 60 * 1000);
  // Store start-of-day snapshot if not exists
  const startKey = `bw:${today}:start`;
  if (!cache.get(startKey)) cache.set(startKey, { rx: net.rx_bytes, tx: net.tx_bytes }, 30 * 24 * 60 * 60 * 1000);
}
setInterval(trackDailyBandwidth, 60000); // every minute

// ── GET /api/analytics — JSON stats (requires auth token)
app.get("/api/analytics", (req, res) => {
  if (!ADMIN_PASS) return res.status(503).json({ error: "ADMIN_PASS not configured" });
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_PASS) return res.status(401).json({ error: "Unauthorized" });

  const stats = cache.getStats();
  const mem = process.memoryUsage();
  const net = getNetworkStats();

  // Calculate today's bandwidth
  const today = new Date().toISOString().slice(0, 10);
  const bwStart = cache.get(`bw:${today}:start`);
  let todayBw = null;
  if (net && bwStart) {
    todayBw = {
      rx_gb: Math.round((net.rx_bytes - bwStart.rx) / 1073741824 * 100) / 100,
      tx_gb: Math.round((net.tx_bytes - bwStart.tx) / 1073741824 * 100) / 100,
    };
    todayBw.total_gb = Math.round((todayBw.rx_gb + todayBw.tx_gb) * 100) / 100;
  }

  trackDailyBandwidth(); // ensure current snapshot

  res.json({
    server: {
      uptime_hours: Math.round(process.uptime() / 3600 * 10) / 10,
      memory_mb: Math.round(mem.rss / 1024 / 1024),
      heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
      node: process.version,
      platform: process.platform,
    },
    bandwidth: {
      total: net ? { rx_gb: net.rx_gb, tx_gb: net.tx_gb, total_gb: Math.round((net.rx_gb + net.tx_gb) * 100) / 100 } : null,
      today: todayBw,
    },
    visitors: stats.visitors,
    recent_visitors: stats.recentVisitors,
    guests: stats.guests,
    recent_guests: stats.recentGuests,
    most_watched: stats.mostWatched,
    portals: { connections: stats.portals, by_type: stats.portalsByType },
    cache: {
      total_entries: stats.cacheTotal,
      valid_entries: stats.cacheValid,
      size_mb: stats.cacheSizeMB,
      hit_rate: stats.cacheHitRate,
      hits: stats.cacheHits,
      misses: stats.cacheMisses,
      breakdown: stats.cacheBreakdown,
    },
    requests: {
      today: stats.todayReqs,
      daily: stats.daily,
    },
    feedback: cache.getFeedback(),
    generated_at: new Date().toISOString(),
  });
});

// ── GET /analytics — HTML dashboard (with login)
app.get("/analytics", (req, res) => {
  res.sendFile(require("path").join(__dirname, "analytics.html"));
});

// ─────────────────────────────────────────────────────────────────
cache.ready.then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Stalker proxy running on http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Cache: SQLite (7-day TTL)`);
  });
});
