require("dotenv").config();
const express     = require("express");
const fetch       = require("node-fetch");
const cors        = require("cors");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const cache       = require("./cache");
const auth        = require("./auth");
const email       = require("./email");
const { Transform } = require("stream");
const os          = require("os");
const { execSync } = require("child_process");

const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");

const dns   = require("dns");
const { promisify } = require("util");
const dnsLookup = promisify(dns.lookup);
const http  = require("http");
const https = require("https");
const keepAliveAgent      = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveAgentHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });
const agentFor = (url) => url.startsWith("https") ? keepAliveAgentHttps : keepAliveAgent;

// Total transfer timeout (prevents slow-loris). Returns { signal, clear }.
function transferTimeout(ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

const app  = express();
if (process.env.TRUST_PROXY !== "false") app.set("trust proxy", 1); // trust nginx X-Forwarded-For (disable with TRUST_PROXY=false)
const PORT = process.env.PORT || 3001;

// Block SSRF: validate proxy URLs with DNS resolution to prevent rebinding
function isPrivateIP(ip) {
  if (!ip) return true;
  // IPv6 loopback/link-local
  if (ip === "::1" || ip === "[::1]" || ip.startsWith("fe80") || ip.startsWith("fc00") || ip.startsWith("fd")) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1)
  const v4match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const v4 = v4match ? v4match[1] : ip;
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return !v4match; // non-IPv4 without ffff prefix = allow
  if (parts[0] === 127) return true; // 127.x.x.x
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 169 && parts[1] === 254) return true; // cloud metadata
  if (parts[0] === 0) return true;
  return false;
}

function isUrlAllowedSync(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "[::1]") return false;
    // Only check isPrivateIP for IP addresses (not hostnames — DNS is checked async)
    if (/^[\d.]+$/.test(host) || host.includes(":")) {
      if (isPrivateIP(host)) return false;
    }
    return true;
  } catch { return false; }
}

async function isUrlAllowed(urlStr) {
  if (!isUrlAllowedSync(urlStr)) return false;
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    // Resolve DNS to catch rebinding (hostname pointing to private IP)
    const { address } = await dnsLookup(host);
    if (isPrivateIP(address)) return false;
    return true;
  } catch { return false; }
}

app.use(cookieParser());

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const allowedOrigins = ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(",").map(s => s.trim()) : false;
app.use(cors({
  origin: allowedOrigins || false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
}));

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// Rate limiting
app.use("/api/auth/login", rateLimit({ windowMs: 15 * 60000, max: 10, message: { error: "Too many login attempts. Try again in 15 minutes." } }));
app.use("/api/auth/register", rateLimit({ windowMs: 60 * 60000, max: 5, message: { error: "Too many registrations. Try again later." } }));
app.use("/api/auth/forgot-password", rateLimit({ windowMs: 60 * 60000, max: 3, message: { error: "Too many reset requests. Try again in an hour." } }));
app.use("/api/auth/reset-password", rateLimit({ windowMs: 60 * 60000, max: 5, message: { error: "Too many reset attempts. Try again later." } }));
app.use("/api/feedback", rateLimit({ windowMs: 60000, max: 10, message: { error: "Too many feedback submissions" } }));
app.use("/api/", rateLimit({ windowMs: 60000, max: 60, message: { error: "Too many requests" } }));
app.use("/stalker/", rateLimit({ windowMs: 60000, max: 600, message: { error: "Too many requests" } }));

// Fix 5: Reduce default JSON body limit
app.use("/api/sync", express.json({ limit: "5mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(compression());

// Admin password for analytics (set in .env)
const crypto = require("crypto");
const ADMIN_PASS = process.env.ADMIN_PASS;
function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Track requests, visitors, guests, and portals
app.use((req, res, next) => {
  const p = req.path;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (p !== "/health" && p !== "/analytics" && p !== "/api/analytics") {
      let type = "other";
      if (p.startsWith("/stalker/")) type = "stalker";
      else if (p === "/stream") type = "stream";
      else if (p === "/proxy") type = "proxy";
      
      cache.trackRequest(type, res.statusCode, duration);
      cache.trackVisitor(ip, req.headers["user-agent"]);
      
      const guestId = req.headers["x-guest-id"];
      if (guestId) {
        let role = 'guest';
        const token = req.headers.authorization?.slice(7) || req.cookies?.sv_auth;
        if (token) {
          const user = auth.verifyToken(token);
          if (user) role = user.role;
        }
        cache.trackGuest(guestId, ip, role);
      }
    }
  });

  // Track portal usage (pre-extraction)
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
  if (!safeCompare(token, ADMIN_PASS)) return res.status(401).json({ error: "Unauthorized" });
  res.json({ feedback: cache.getFeedback() });
});

// ── GET /api/vast?url=... — same-origin VAST XML proxy for preroll ad tags
app.get("/api/vast", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });
  if (!(await isUrlAllowed(url))) return res.status(403).json({ error: "URL not allowed" });

  try {
    const upstream = await fetch(url, {
      timeout: 5000,
      redirect: "follow",
      headers: {
        "Accept": "application/xml,text/xml,*/*;q=0.8",
        "User-Agent": req.headers["user-agent"] || "StreamVault/1.0",
      },
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: "VAST request failed" });

    const contentLength = Number(upstream.headers.get("content-length") || 0);
    if (contentLength > 1024 * 1024) return res.status(413).json({ error: "VAST response too large" });

    const xml = await upstream.text();
    if (xml.length > 1024 * 1024) return res.status(413).json({ error: "VAST response too large" });

    res.set("Content-Type", upstream.headers.get("content-type") || "application/xml; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.send(xml);
  } catch (e) {
    console.error("VAST proxy error:", e.message);
    res.status(502).json({ error: "VAST request failed" });
  }
});

// Sync key: prefer user_id from JWT, fallback to guest_id
function syncId(req) {
  if (req.user) return `user:${req.user.id}`;
  return req.headers["x-guest-id"] ? `guest:${req.headers["x-guest-id"]}` : null;
}

// ── PUT /api/sync/:type — save favorites, history, or connections
app.put("/api/sync/:type", auth.optionalAuth, express.json(), (req, res) => {
  const { type } = req.params;
  if (!["favorites","history","connections"].includes(type)) return res.status(400).json({ error: "Invalid type" });
  const sid = syncId(req);
  if (!sid) return res.status(400).json({ error: "Authentication or X-Guest-Id required" });
  const { connId, data } = req.body;
  // connections sync uses "_all" as connId
  const cid = type === "connections" ? "_all" : connId;
  if (!cid || data === undefined) return res.status(400).json({ error: "connId and data required" });
  cache.saveGuestData(sid, cid, type, data);
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const guestId = req.headers["x-guest-id"];
  if (guestId) {
    const role = req.user ? req.user.role : 'guest';
    cache.trackGuest(guestId, ip, role);
  }
  res.json({ ok: true });
});

// ── GET /api/sync/:type — restore favorites, history, or connections
app.get("/api/sync/:type", auth.optionalAuth, (req, res) => {
  const { type } = req.params;
  if (!["favorites","history","connections"].includes(type)) return res.status(400).json({ error: "Invalid type" });
  const sid = syncId(req);
  if (!sid) return res.status(400).json({ error: "Authentication or X-Guest-Id required" });
  const connId = type === "connections" ? "_all" : req.query.connId;
  if (!connId) return res.status(400).json({ error: "connId required" });
  const data = cache.getGuestData(sid, connId, type);
  res.json({ data });
});

// ── POST /api/sync/migrate-guest — link guest data to authenticated user
app.post("/api/sync/migrate-guest", auth.requireAuth, express.json(), (req, res) => {
  const { guestId } = req.body;
  if (!guestId) return res.status(400).json({ error: "guestId required" });
  // Ownership: only allow migration if the request includes the matching guest ID header
  if (req.headers["x-guest-id"] !== guestId) return res.status(403).json({ error: "Guest ID mismatch" });
  const userId = `user:${req.user.id}`;
  const guestKey = `guest:${guestId}`;
  // Copy all guest data rows to user
  const rows = cache.db.prepare("SELECT conn_id, type, data, updated_at FROM guest_data WHERE guest_id = ?").all(guestKey);
  for (const row of rows) {
    // Only copy if user doesn't already have this data
    const existing = cache.getGuestData(userId, row.conn_id, row.type);
    if (!existing) {
      cache.saveGuestData(userId, row.conn_id, row.type, JSON.parse(row.data));
    }
  }
  res.json({ migrated: rows.length });
});

// ── DELETE /api/sync — delete all data for a connection
app.delete("/api/sync", auth.optionalAuth, (req, res) => {
  const sid = syncId(req);
  if (!sid) return res.status(401).json({ error: "Authentication or X-Guest-Id required" });
  const connId = req.query.connId;
  if (!connId) return res.status(400).json({ error: "connId required" });
  cache.deleteGuestData(sid, connId);
  res.json({ ok: true });
});

// ── DELETE /api/cache — delete cached data for a connection (channels, VOD, EPG, etc.)
app.delete("/api/cache", auth.optionalAuth, (req, res) => {
  const sid = syncId(req);
  if (!sid) return res.status(401).json({ error: "Authentication or X-Guest-Id required" });
  const connId = req.query.connId;
  if (connId) cache.deleteByPrefix(connId);
  res.json({ ok: true });
});

// ── Cache: path resolution cached long-term, tokens are never cached (portals invalidate on re-handshake)
const pathCache = new Map();
const PATH_CACHE_MAX = 500;
const sessionCache = new Map();
const inFlightSessions = new Map();
const portalCooldowns = new Map();
const SESSION_TTL_MS = 30 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
function setPathCache(key, value) {
  if (pathCache.size >= PATH_CACHE_MAX) {
    // Evict oldest entry (first inserted) instead of clearing all
    const oldest = pathCache.keys().next().value;
    pathCache.delete(oldest);
  }
  pathCache.set(key, value);
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

// Safe error messages: only expose portal/user-facing errors, not internal stack details
const SAFE_PREFIXES = ["Portal", "No stream", "Stream server", "Invalid", "portal and mac"];
function safeError(e) {
  const msg = e?.message || "Unknown error";
  if (SAFE_PREFIXES.some(p => msg.startsWith(p))) return msg;
  console.error("Internal error:", msg);
  return "Request failed";
}

function cacheKey(portal, mac) {
  return `${portal.replace(/\/+$/, "")}|${mac}`;
}

function normalizeStalkerOpts(opts = {}) {
  return {
    serial: opts.serial || null,
    deviceId: opts.deviceId || null,
    deviceId2: opts.deviceId2 || null,
  };
}

function sessionCacheKey(portal, mac, opts = {}) {
  const normalized = normalizeStalkerOpts(opts);
  return `${cacheKey(portal, mac)}|${normalized.serial || ""}`;
}

function getCachedSession(portal, mac, opts = {}) {
  const key = sessionCacheKey(portal, mac, opts);
  const cached = sessionCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    sessionCache.delete(key);
    return null;
  }
  const normalized = normalizeStalkerOpts(opts);
  return {
    token: cached.token,
    base: cached.base,
    apiPath: cached.apiPath,
    portal,
    mac,
    opts: normalized,
    headers: stalkerHeaders(mac, cached.token, portal, normalized),
    async refresh() { return getSession(portal, mac, normalized, { forceRefresh: true }); },
  };
}

function storeSession(portal, mac, opts, result) {
  const normalized = normalizeStalkerOpts(opts);
  sessionCache.set(sessionCacheKey(portal, mac, normalized), {
    token: result.token,
    base: result.base,
    apiPath: result.apiPath,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return {
    token: result.token,
    base: result.base,
    apiPath: result.apiPath,
    portal,
    mac,
    opts: normalized,
    headers: stalkerHeaders(mac, result.token, portal, normalized),
    async refresh() { return getSession(portal, mac, normalized, { forceRefresh: true }); },
  };
}

function setPortalCooldown(portal, mac, opts = {}) {
  portalCooldowns.set(sessionCacheKey(portal, mac, opts), Date.now() + RATE_LIMIT_COOLDOWN_MS);
}

function getPortalCooldown(portal, mac, opts = {}) {
  const key = sessionCacheKey(portal, mac, opts);
  const expiresAt = portalCooldowns.get(key);
  if (!expiresAt) return 0;
  if (expiresAt <= Date.now()) {
    portalCooldowns.delete(key);
    return 0;
  }
  return expiresAt;
}

function buildStalkerStreamHeaders(session, reqHeaders = {}) {
  const headers = {
    ...session.headers,
    "Accept": "*/*",
    "Connection": "keep-alive",
  };
  delete headers["Content-Type"];
  if (reqHeaders.range) headers["Range"] = reqHeaders.range;
  return headers;
}

function summarizeUpstreamHeaders(headers) {
  return {
    contentType: headers.get("content-type") || null,
    contentLength: headers.get("content-length") || null,
    location: headers.get("location") || null,
    wwwAuthenticate: headers.get("www-authenticate") || null,
    proxyAuthenticate: headers.get("proxy-authenticate") || null,
    server: headers.get("server") || null,
  };
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
async function tryHandshake(base, apiPath, mac, portalUrl, opts = {}) {
  const qs = `type=stb&action=handshake&prehash=0&token=&JsHttpRequest=1-xml`;
  const url = `${base}${apiPath}?${qs}`;
  const headers = stalkerHeaders(mac, "", portalUrl, normalizeStalkerOpts(opts));

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
async function getSession(portal, mac, opts = {}, config = {}) {
  const normalized = normalizeStalkerOpts(opts);
  const key = cacheKey(portal, mac);
  const sessionKey = sessionCacheKey(portal, mac, normalized);
  const cached = pathCache.get(key);

  if (config.forceRefresh) {
    sessionCache.delete(sessionKey);
  } else {
    const cachedSession = getCachedSession(portal, mac, normalized);
    if (cachedSession) return cachedSession;
  }

  const cooldownUntil = getPortalCooldown(portal, mac, normalized);
  if (cooldownUntil) {
    const waitSeconds = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000));
    throw new Error(`Portal rate limited (429). Cooldown active for ${waitSeconds}s.`);
  }

  if (!config.forceRefresh && inFlightSessions.has(sessionKey)) {
    return inFlightSessions.get(sessionKey);
  }

  const loader = (async () => {
  let sawRateLimit = false;

  // If path is known, do a single handshake on the known path
  if (cached) {
    try {
    const result = await tryHandshake(cached.base, cached.apiPath, mac, portal, normalized);
    if (result) {
      return storeSession(portal, mac, normalized, {
        token: result.token,
        base: cached.base,
        apiPath: cached.apiPath,
      });
    }
    // Path may have changed — clear cache and re-discover
    pathCache.delete(key);
    } catch (e) {
      if (e.code === "RATE_LIMITED") {
        sawRateLimit = true;
        pathCache.delete(key);
      } else {
        throw e;
      }
    }
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
        const result = await tryHandshake(base, path, mac, portal, normalized);
        if (result) {
          setPathCache(key, { base, apiPath: path });
          console.log(`✓ Path resolved: ${base}${path}`);
          return storeSession(portal, mac, normalized, { token: result.token, base, apiPath: path });
        }
      } catch(e) {
        if (e.code === "RATE_LIMITED") {
          sawRateLimit = true;
          continue;
        }
        throw e;
      }
    }
  }
  if (sawRateLimit) {
    setPortalCooldown(portal, mac, normalized);
    throw new Error("Portal rate limited (429). Try again in a minute.");
  }
  throw new Error("Handshake failed: could not obtain token from portal");
  })();

  if (!config.forceRefresh) inFlightSessions.set(sessionKey, loader);
  try {
    return await loader;
  } finally {
    const cooldownUntil = getPortalCooldown(portal, mac, normalized);
    const deleteDelay = cooldownUntil ? 1000 : 0;
    if (deleteDelay > 0) {
      setTimeout(() => inFlightSessions.delete(sessionKey), deleteDelay);
    } else {
      inFlightSessions.delete(sessionKey);
    }
  }
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

  function parseResponse(text, res) {
    if (text.includes("Authorization failed")) return null; // token expired, signal retry
    try {
      return JSON.parse(text);
    } catch {
      // Portal returned non-JSON (HTML error page, maintenance page, etc.)
      const status = res?.status || "unknown";
      const preview = text.replace(/<[^>]*>/g, "").trim().slice(0, 100);
      throw new Error(`Portal returned non-JSON (HTTP ${status}): ${preview || "empty response"}`);
    }
  }

  try {
    const res = await fetch(url, { headers: session.headers, timeout, agent: agentFor(url) });
    if (res.ok) {
      const text = await res.text();
      return parseResponse(text, res);
    }
    if (res.status === 429) throw new Error("Portal rate limited (429). Try again in a minute.");
    if (res.status >= 500) throw new Error(`Portal server error (${res.status})`);
  } catch (e) {
    if (e.message.includes("Portal")) throw e; // re-throw our own errors
    /* network error — fall through to POST */
  }

  // Try POST as fallback
  try {
    const res = await fetch(url, { method: "POST", headers: session.headers, body: qs, timeout, agent: agentFor(url) });
    if (res.ok) {
      const text = await res.text();
      return parseResponse(text, res);
    }
    if (res.status === 429) throw new Error("Portal rate limited (429). Try again in a minute.");
  } catch (e) {
    if (e.message.includes("Portal")) throw e;
    /* network error */
  }

  throw new Error(`Portal request failed: ${params.action || "unknown"}`);
}

// ─────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ── SSRF: validate portal URL + MAC format on all stalker routes
const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
app.use("/stalker", async (req, res, next) => {
  const portal = req.body?.portal || req.query?.portal;
  const mac = req.body?.mac || req.query?.mac;
  if (portal && !(await isUrlAllowed(portal))) return res.status(403).json({ error: "Portal URL not allowed" });
  if (mac && !MAC_RE.test(mac)) return res.status(400).json({ error: "Invalid MAC format" });
  next();
});

// ── POST /api/diagnose — test connection health (latency, reachability, stream support)
app.post("/api/diagnose", express.json(), async (req, res) => {
  const { type, server, portal, mac, user, pass, url: m3uUrl } = req.body;
  const result = { latency: null, reachable: false, details: {} };

  try {
    if (type === "stalker" && portal) {
      // Stalker: skip reachability ping, go straight to handshake (portals reject HEAD/bare GET)
      if (mac) {
        const start = Date.now();
        try {
          const session = await getSession(portal, mac);
          result.latency = Date.now() - start;
          result.reachable = true;
          result.details.handshake = "ok";
          result.details.token = session.token ? "received" : "none";
        } catch (e) {
          result.latency = Date.now() - start;
          result.details.handshake = e.message?.slice(0, 80);
          // Still reachable if we got a portal error (not a network error)
          result.reachable = e.message?.startsWith("Portal") || false;
          result.details.status = result.reachable ? "portal error" : "unreachable";
        }
      } else {
        result.details.status = "MAC required for stalker diagnosis";
      }
    } else if (type === "xtream" && server) {
      const start = Date.now();
      const apiUrl = `${server}/player_api.php?username=${encodeURIComponent(user || "")}&password=${encodeURIComponent(pass || "")}`;
      const r = await fetch(apiUrl, { timeout: 8000, agent: agentFor(server) }).catch(() => null);
      result.latency = Date.now() - start;
      if (r) {
        result.reachable = true;
        result.details.httpStatus = r.status;
        if (r.ok) {
          try {
            const data = await r.json();
            result.details.auth = data?.user_info?.auth === 1 ? "ok" : "failed";
            result.details.status = data?.user_info?.status || "—";
            result.details.maxConnections = data?.user_info?.max_connections || "—";
            result.details.activeCons = data?.user_info?.active_cons || "—";
            result.details.expDate = data?.user_info?.exp_date ? new Date(data.user_info.exp_date * 1000).toLocaleDateString() : "—";
          } catch { result.details.parse = "non-JSON response"; }
        }
      } else { result.details.status = "unreachable"; }
    } else if (type === "m3u" && m3uUrl) {
      const start = Date.now();
      const r = await fetch(m3uUrl, { timeout: 8000, redirect: "follow", agent: agentFor(m3uUrl) }).catch(() => null);
      result.latency = Date.now() - start;
      result.reachable = r?.ok || false;
      result.details.status = r?.status || "unreachable";
      result.details.contentType = r?.headers?.get("content-type") || "—";
    }
  } catch (e) {
    result.details.error = e.message?.slice(0, 100);
  }

  res.json(result);
});

// ── POST /stalker/handshake
app.post("/stalker/handshake", async (req, res) => {
  const { portal, mac, serial, deviceId, deviceId2 } = req.body;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  const start = Date.now();
  try {
    const session = await getSession(portal, mac, { serial });
    cache.trackPortalHealth(portal, Date.now() - start, 200);
    res.json({ token: session.token });
  } catch (e) {
    cache.trackPortalHealth(portal, Date.now() - start, 502);
    console.error("Handshake error:", e.message);
    res.status(502).json({ error: safeError(e) });
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
  const { portal, mac, serial, deviceId, deviceId2, ...apiParams } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
    const data = await portalFetchRetry(session, apiParams);
    res.json(data);
  } catch (e) {
    console.error("API proxy error:", e.message);
    res.status(502).json({ error: safeError(e) });
  }
});

// ── GET /stalker/channels
app.get("/stalker/channels", async (req, res) => {
  const { portal, mac, refresh, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  // Use portal-level cache (MAC independent)
  const ck = `portal-channels:${portal}`;
  if (!refresh) {
    const cached = cache.get(ck);
    if (cached) return res.json(cached);
  }

  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });

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

    const data = { channels: result, total: result.length, refreshed_at: Date.now() };
    cache.set(ck, data, 24 * 60 * 60 * 1000);
    res.json(data);
  } catch (e) {
    console.error("Channels error:", e.message);
    res.status(502).json({ error: safeError(e) });
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
  const { portal, mac, refresh, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  const ck = cache.cacheKey(portal, mac, "vod-cats");
  if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(cached); } } cache.trackCacheMiss();

  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
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
    res.status(502).json({ error: safeError(e) });
  }
});

// ── GET /stalker/vod?cat=ID  — returns items for one category (lazy load)
app.get("/stalker/vod", async (req, res) => {
  const { portal, mac, cat, refresh, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
  if (!cat)            return res.status(400).json({ error: "cat (category id) required" });

  const ck = cache.cacheKey(portal, mac, "vod", cat);
  if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(cached); } } cache.trackCacheMiss();

  try {
    const session  = await getSession(portal, mac, { serial, deviceId, deviceId2 });
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
    res.status(502).json({ error: safeError(e) });
  }
});

// ── GET /stalker/stream
// content_type: "live" (default) uses type=itv, "vod" uses type=vod, "series" uses type=vod
app.get("/stalker/stream", async (req, res) => {
  const { portal, mac, cmd, content_type, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac || !cmd) return res.status(400).json({ error: "portal, mac and cmd required" });

  // Map content_type to the correct Stalker API type parameter
  const stalkerType = (content_type === "vod" || content_type === "series") ? "vod" : "itv";

  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
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
    if (!(await isUrlAllowed(cleanUrl))) return res.status(403).json({ error: "Stream URL not allowed" });
    res.json({ url: cleanUrl });
  } catch (e) {
    console.error("Stream resolve error:", e.message);
    res.status(502).json({ error: safeError(e) });
  }
});

// ── GET /stalker/play — resolve create_link + stream in one request (same IP)
app.get("/stalker/play", async (req, res) => {
  const { portal, mac, cmd, content_type, episode, start, end, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac || !cmd) return res.status(400).json({ error: "portal, mac and cmd required" });
  const stalkerType = (content_type === "vod" || content_type === "series") ? "vod" : "itv";
  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
    const linkParams = {
      type: stalkerType, action: "create_link", cmd,
      series: episode || 0, forced_storage: 0,
      disable_ad: 0, download: 0, force_ch_link_check: 0,
    };
    // Catchup/timeshift: pass start/end timestamps to portal
    if (start) linkParams.start = start;
    if (end) linkParams.end = end;
    const data = await portalFetchRetry(session, linkParams);
    cache.trackPortalHealth(portal, Date.now() - start, 200);
    const streamUrl = data?.js?.cmd;
    if (!streamUrl) throw new Error("No stream URL returned");
    let cleanUrl = streamUrl.replace(/^ffmpeg\s+/, "").trim();
    if (cleanUrl.includes("localhost") || cleanUrl.includes("127.0.0.1")) {
      try { const h = new URL(portal).host; cleanUrl = cleanUrl.replace(/localhost(:\d+)?/g, h).replace(/127\.0\.0\.1(:\d+)?/g, h); } catch {}
    }
    // SSRF: validate the stream URL returned by the portal
    if (!(await isUrlAllowed(cleanUrl))) return res.status(403).json({ error: "Stream URL not allowed" });
    // resolve=1 → return the resolved stream URL as JSON (frontend will use /stream to play)
    if (req.query.resolve === "1") {
      return res.json({ url: cleanUrl });
    }
    // Track what's being watched
    const watchName = req.query.name || cmd || "Unknown";
    cache.trackWatch(watchName, content_type === "vod" ? "vod" : content_type === "series" ? "series" : "live");

    // Try to pipe the stream (same IP as create_link) with the same Stalker session context
    const fetchHeaders = buildStalkerStreamHeaders(session, req.headers);
    const upstream = await fetch(cleanUrl, { headers: fetchHeaders, redirect: "follow" });
    const upstreamSummary = summarizeUpstreamHeaders(upstream.headers);
    if (!upstream.ok && upstream.status !== 206) {
      console.warn("Stalker play upstream rejected stream", {
        portal,
        mac,
        cleanUrl,
        status: upstream.status,
        headers: upstreamSummary,
      });
      return res.status(upstream.status).json({
        error: `Stream server returned ${upstream.status}`,
        status: upstream.status,
        upstreamHeaders: upstreamSummary,
      });
    }
    console.log("Stalker play upstream stream ok", {
      portal,
      mac,
      cleanUrl,
      status: upstream.status,
      headers: upstreamSummary,
    });
    const ct = upstream.headers.get("content-type") || "";
    Object.entries(STREAM_CORS).forEach(([k, v]) => res.set(k, v));
    res.set("Accept-Ranges", "bytes");
    if (upstream.status === 206) { res.status(206); const cr = upstream.headers.get("content-range"); if (cr) res.set("Content-Range", cr); }
    const cl = upstream.headers.get("content-length"); if (cl) res.set("Content-Length", cl);
    if (ct.includes("mpegurl") || ct.includes("m3u") || cleanUrl.endsWith(".m3u8")) {
      const parsedCleanUrl = new URL(cleanUrl);
      const playOrigin = parsedCleanUrl.origin;
      const playBaseDir = cleanUrl.substring(0, cleanUrl.lastIndexOf("/") + 1);
      const proto = req.get("x-forwarded-proto") || req.protocol;
      const selfBase = `${proto}://${req.get("host")}`;
      res.set("Content-Type", ct);
      let leftover = "";
      const rewriter = new Transform({
        transform(chunk, enc, cb) {
          const text = leftover + chunk.toString();
          const lines = text.split("\n");
          leftover = lines.pop();
          const rewritten = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return line;
            if (trimmed.startsWith("http://") || trimmed.startsWith("https://"))
              return `${selfBase}/stream?url=${encodeURIComponent(trimmed)}`;
            if (trimmed.startsWith("/"))
              return `${selfBase}/stream?url=${encodeURIComponent(playOrigin + trimmed)}`;
            return `${selfBase}/stream?url=${encodeURIComponent(playBaseDir + trimmed)}`;
          }).join("\n") + "\n";
          cb(null, rewritten);
        },
        flush(cb) {
          if (leftover.trim()) {
            const t = leftover.trim();
            if (t.startsWith("http://") || t.startsWith("https://"))
              cb(null, `${selfBase}/stream?url=${encodeURIComponent(t)}`);
            else if (t.startsWith("/"))
              cb(null, `${selfBase}/stream?url=${encodeURIComponent(playOrigin + t)}`);
            else if (!t.startsWith("#"))
              cb(null, `${selfBase}/stream?url=${encodeURIComponent(playBaseDir + t)}`);
            else cb(null, leftover);
          } else cb();
        }
      });
      upstream.body.pipe(rewriter).pipe(res);
    } else {
      if (ct) res.set("Content-Type", ct);
      upstream.body.pipe(res);
    }
  } catch (e) {
    console.error("Play error:", e.message);
    res.status(502).json({ error: safeError(e) });
  }
});

// ── GET /stalker/series/seasons (query-param version)
app.get("/stalker/series/seasons", async (req, res) => {
  const { portal, mac, seriesId, refresh, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac || !seriesId) return res.status(400).json({ error: "portal, mac and seriesId required" });

  const ck = cache.cacheKey(portal, mac, "seasons", seriesId);
  if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(cached); } } cache.trackCacheMiss();

  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
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
    res.status(502).json({ error: safeError(e) });
  }
});

// ── GET /stalker/series/categories
app.get("/stalker/series/categories", async (req, res) => {
  const { portal, mac, refresh, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  const ck = cache.cacheKey(portal, mac, "series-cats");
  if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(cached); } } cache.trackCacheMiss();

  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
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
    res.status(502).json({ error: safeError(e) });
  }
});

// ── GET /stalker/series?cat=ID
app.get("/stalker/series", async (req, res) => {
  const { portal, mac, cat, refresh, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
  if (!cat)            return res.status(400).json({ error: "cat (category id) required" });

  const ck = cache.cacheKey(portal, mac, "series", cat);
  if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(cached); } } cache.trackCacheMiss();

  try {
    const session  = await getSession(portal, mac, { serial, deviceId, deviceId2 });
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
    res.status(502).json({ error: safeError(e) });
  }
});

// ── GET /stalker/series/episode/stream — resolve a playable URL for a series episode
// NOTE: This static route must be registered BEFORE the parameterized :seriesId route
app.get("/stalker/series/episode/stream", async (req, res) => {
  const { portal, mac, cmd, episode, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac || !cmd || !episode) {
    return res.status(400).json({ error: "portal, mac, cmd and episode required" });
  }

  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
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
    res.status(502).json({ error: safeError(e) });
  }
});

// ── GET /stalker/series/:seriesId/seasons — returns seasons with episode lists
app.get("/stalker/series/:seriesId/seasons", async (req, res) => {
  const { portal, mac, serial, deviceId, deviceId2 } = req.query;
  const { seriesId } = req.params;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
  if (!seriesId)       return res.status(400).json({ error: "seriesId required" });

  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
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
    res.status(502).json({ error: safeError(e) });
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
    res.status(502).json({ error: safeError(e) });
  }
});

// ── GET /stalker/account (new — from extractstb)
app.get("/stalker/account", async (req, res) => {
  const { portal, mac, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
    const data = await portalFetchRetry(session, {
      type: "account_info", action: "get_main_info",
    });
    res.json(data?.js || {});
  } catch (e) {
    console.error("Account error:", e.message);
    res.status(502).json({ error: safeError(e) });
  }
});

// ── GET /stalker/epg?portal=...&mac=...&period=N
// Fetches EPG data for all channels (period in hours, default 4)
app.get("/stalker/epg", async (req, res) => {
  const { portal, mac, period = 4, refresh, serial, deviceId, deviceId2 } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  // Use portal-level cache (MAC independent)
  const ck = `portal-epg:${portal}`;
  if (!refresh) {
    const cached = cache.get(ck);
    if (cached) return res.json(cached);
  }

  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
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

    const result = { programs, refreshed_at: Date.now() };
    cache.set(ck, result, 24 * 60 * 60 * 1000); // 24h TTL
    res.json(result);
  } catch (e) {
    console.error("EPG error:", e.message);
    res.status(502).json({ error: safeError(e) });
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
  if (!(await isUrlAllowed(url))) return res.status(403).end();
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
  if (!(await isUrlAllowed(url))) return res.status(403).json({ error: "URL not allowed" });
  try {
    const headers = { "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" };
    if (req.headers.range) headers["Range"] = req.headers.range;

    const upstream = await fetch(url, { headers, redirect: "follow" });
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
      const parsedUrl = new URL(url);
      const origin = parsedUrl.origin;
      const baseDir = url.substring(0, url.lastIndexOf("/") + 1); // for relative URLs
      const proto = req.get("x-forwarded-proto") || req.protocol;
      const selfBase = `${proto}://${req.get("host")}`;
      res.set("Content-Type", ct);
      let leftover = ""; // buffer incomplete lines across chunks
      const rewriter = new Transform({
        transform(chunk, enc, cb) {
          const text = leftover + chunk.toString();
          const lines = text.split("\n");
          leftover = lines.pop(); // last element may be incomplete
          const rewritten = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return line;
            // Absolute http(s) URLs
            if (trimmed.startsWith("http://") || trimmed.startsWith("https://"))
              return `${selfBase}/stream?url=${encodeURIComponent(trimmed)}`;
            // Root-relative URLs
            if (trimmed.startsWith("/"))
              return `${selfBase}/stream?url=${encodeURIComponent(origin + trimmed)}`;
            // Relative URLs (e.g. "segment001.ts")
            return `${selfBase}/stream?url=${encodeURIComponent(baseDir + trimmed)}`;
          }).join("\n") + "\n";
          cb(null, rewritten);
        },
        flush(cb) {
          if (leftover.trim()) {
            const trimmed = leftover.trim();
            if (trimmed.startsWith("http://") || trimmed.startsWith("https://"))
              cb(null, `${selfBase}/stream?url=${encodeURIComponent(trimmed)}`);
            else if (trimmed.startsWith("/"))
              cb(null, `${selfBase}/stream?url=${encodeURIComponent(origin + trimmed)}`);
            else if (!trimmed.startsWith("#"))
              cb(null, `${selfBase}/stream?url=${encodeURIComponent(baseDir + trimmed)}`);
            else cb(null, leftover);
          } else cb();
        }
      });
      upstream.body.pipe(rewriter).pipe(res);
    } else {
      if (ct) res.set("Content-Type", ct);
      upstream.body.pipe(res);
    }
  } catch (e) {
    console.error("Stream proxy error:", e.message);
    if (!res.headersSent) res.status(502).json({ error: "Stream request failed" });
  }
});

// ── GET /img?url=... — image proxy (fixes mixed-content + broken SSL certs on portal image servers)
app.get("/img", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  if (!(await isUrlAllowed(url))) return res.status(403).end();
  try {
    // Try original URL first, fallback to HTTP for portals with broken HTTPS certs
    let fetchUrl = url;
    let upstream = await fetch(fetchUrl, {
      timeout: 10000, headers: { "User-Agent": "StreamVault/1.0" }
    }).catch(() => null);
    if (!upstream && url.startsWith("https:")) {
      fetchUrl = url.replace(/^https:/, "http:");
      upstream = await fetch(fetchUrl, {
        timeout: 10000, headers: { "User-Agent": "StreamVault/1.0" }
      });
    }
    if (!upstream || !upstream.ok) return res.status(upstream?.status || 502).end();
    const ct = upstream.headers.get("content-type") || "image/jpeg";
    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=86400"); // cache 24h
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    upstream.body.pipe(res);
  } catch {
    res.status(502).end();
  }
});

// ── GET /api/tmdb/* — proxy TMDB API requests (keeps API key server-side)
const TMDB_KEY = process.env.TMDB_API_KEY || "";
app.get("/api/tmdb/*", async (req, res) => {
  if (!TMDB_KEY) return res.status(503).json({ error: "TMDB API key not configured" });
  const tmdbPath = req.params[0]; // everything after /api/tmdb/
  const qs = new URLSearchParams(req.query);
  qs.set("api_key", TMDB_KEY);
  try {
    const upstream = await fetch(`https://api.themoviedb.org/3/${tmdbPath}?${qs}`, {
      timeout: 10000, headers: { "User-Agent": "StreamVault/1.0" }
    });
    const data = await upstream.json();
    res.set("Cache-Control", "public, max-age=3600");
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "TMDB request failed" });
  }
});

// ── GET /proxy?url=... — generic CORS proxy for Xtream API and M3U fetches
app.get("/proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });
  if (!(await isUrlAllowed(url))) return res.status(403).json({ error: "URL not allowed" });

  const start = Date.now();
  const tt = transferTimeout(60000); // 60s total transfer limit
  try {
    const upstream = await fetch(url, { timeout: 30000, signal: tt.signal, headers: { "User-Agent": "StreamVault/1.0" } });
    const duration = Date.now() - start;
    cache.trackRequest("proxy", upstream.status, duration);
    cache.trackPortalHealth(url, duration, upstream.status);

    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.includes("json")) {
      const data = await upstream.json();
      tt.clear();
      res.json(data);
    } else {
      res.set("Content-Type", contentType || "text/plain");
      upstream.body.on("end", tt.clear).on("error", tt.clear).pipe(res);
    }
  } catch (e) {
    const duration = Date.now() - start;
    cache.trackRequest("proxy", 502, duration);
    console.error("Proxy error:", e.message);
    res.status(502).json({ error: "Proxy request failed" });
  }
});

// ── GET /stalker — proxy Stalker API requests
app.get("/stalker", async (req, res) => {
  const { portal, mac, action, ...params } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "Portal and MAC required" });
  const start = Date.now();

  try {
    const data = await doStalkerHandshake(portal, mac, action, params);
    const duration = Date.now() - start;
    cache.trackRequest("stalker", 200, duration);
    res.json(data);
  } catch (e) {
    const duration = Date.now() - start;
    cache.trackRequest("stalker", 502, duration);
    res.status(502).json({ error: e.message });
  }
});

const { trackDailyBandwidth } = require("./services/system");
setInterval(trackDailyBandwidth, 60000); // every minute

const analyticsRoutes = require("./routes/analytics");
app.use("/", analyticsRoutes);

// ── AUTH: Initialize ──
auth.init(cache.db);

const authRoutes = require("./routes/auth");
app.use("/api", authRoutes);

// ── Cleanup expired sessions alongside cache cleanup ──
setInterval(() => auth.cleanupSessions(), 60 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`✅ Stalker proxy running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Cache: SQLite/better-sqlite3 (7-day TTL, WAL mode)`);
});

// Graceful shutdown: close server, checkpoint WAL, then exit
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully…`);
  server.close(() => {
    try { cache.db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    try { cache.db.close(); } catch {}
    console.log("Shutdown complete.");
    process.exit(0);
  });
  // Force exit after 10s if connections don't close
  setTimeout(() => { console.error("Forced shutdown after timeout"); process.exit(1); }, 10000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
