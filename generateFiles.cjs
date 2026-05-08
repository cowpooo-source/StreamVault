const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'stalker-proxy', 'src');
const lines = fs.readFileSync(path.join(srcDir, 'index.js'), 'utf8').split('\n');

let apiCode = `const express = require("express");
const fetch = require("node-fetch");
const { Transform } = require("stream");
const cache = require("../cache");
const auth = require("../auth");
const { isUrlAllowed, transferTimeout, safeCompare, agentFor, buildStalkerStreamHeaders, summarizeUpstreamHeaders } = require("../utils/proxyHelpers");

const router = express.Router();
`;

let stalkerCode = `const express = require("express");
const fetch = require("node-fetch");
const cache = require("../cache");
const { isUrlAllowed, getSession, portalFetchRetry, safeError, fetchAllPages, agentFor, buildStalkerStreamHeaders, summarizeUpstreamHeaders, STREAM_CORS } = require("../utils/proxyHelpers");

const router = express.Router();
`;

let helpersCode = `const fetch = require("node-fetch");
const dns = require("dns");
const { promisify } = require("util");
const dnsLookup = promisify(dns.lookup);
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveAgentHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });
const agentFor = (url) => url.startsWith("https") ? keepAliveAgentHttps : keepAliveAgent;

function transferTimeout(ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

function isPrivateIP(ip) {
  if (!ip) return true;
  if (ip === "::1" || ip === "[::1]" || ip.startsWith("fe80") || ip.startsWith("fc00") || ip.startsWith("fd")) return true;
  const v4match = ip.match(/^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$/i);
  const v4 = v4match ? v4match[1] : ip;
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return !v4match;
  if (parts[0] === 127 || parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 0) return true;
  return false;
}

function isUrlAllowedSync(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "[::1]") return false;
    if (/^[\\d.]+$/.test(host) || host.includes(":")) {
      if (isPrivateIP(host)) return false;
    }
    return true;
  } catch { return false; }
}

async function isUrlAllowed(urlStr) {
  if (!isUrlAllowedSync(urlStr)) return false;
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^\\[|\\]$/g, "");
    const { address } = await dnsLookup(host);
    if (isPrivateIP(address)) return false;
    return true;
  } catch { return false; }
}

function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const pathCache = new Map();
const PATH_CACHE_MAX = 500;
const sessionCache = new Map();
const inFlightSessions = new Map();
const portalCooldowns = new Map();
const SESSION_TTL_MS = 30 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

function setPathCache(key, value) {
  if (pathCache.size >= PATH_CACHE_MAX) {
    const oldest = pathCache.keys().next().value;
    pathCache.delete(oldest);
  }
  pathCache.set(key, value);
}

const SAFE_PREFIXES = ["Portal", "No stream", "Stream server", "Invalid", "portal and mac"];
function safeError(e) {
  const msg = e?.message || "Unknown error";
  if (SAFE_PREFIXES.some(p => msg.startsWith(p))) return msg;
  console.error("Internal error:", msg);
  return "Request failed";
}

function cacheKey(portal, mac) {
  return \`\${portal.replace(/\\/+$/, "")}|\${mac}\`;
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
  return \`\${cacheKey(portal, mac)}|\${normalized.serial || ""}\`;
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

const API_PATHS = [
  "server/load.php",
  "portal.php",
  "stalker_portal/server/load.php",
];

function stalkerHeaders(mac, token = "", portalUrl = "", opts = {}) {
  const referer = portalUrl
    ? portalUrl.replace(/\\/+$/, "").replace(/\\/c$/, "") + "/c/"
    : "http://localhost/";
  const headers = {
    "User-Agent":    "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
    "Accept":        "*/*",
    "Content-Type":  "application/x-www-form-urlencoded; charset=UTF-8",
    "X-User-Agent":  "Model: MAG250; Link: WiFi",
    "Authorization": token ? \`Bearer \${token}\` : "Bearer ",
    "Cookie":        \`mac=\${encodeURIComponent(mac)}; stb_lang=en; timezone=Europe%2FParis\`,
    "Referer":       referer,
  };
  if (opts.serial) headers["Cookie"] += \`; sn=\${opts.serial}\`;
  return headers;
}

async function extractApiPath(portalUrl, mac) {
  const base = portalUrl.replace(/\\/+$/, "");
  const clientUrl = base.endsWith("/c") ? base : base + "/c";
  const url = \`\${clientUrl}/xpcom.common.js\`;
  try {
    const res = await fetch(url, {
      headers: stalkerHeaders(mac, "", portalUrl),
      timeout: 8000,
      agent: agentFor(url),
    });
    if (!res.ok) return null;
    const js = await res.text();

    let m = js.match(/this\\.ajax_loader\\s*=\\s*this\\.portal_protocol\\s*\\+\\s*"[^"]*"\\s*\\+\\s*this\\.portal_ip\\s*\\+\\s*"\\/"\\s*\\+\\s*this\\.portal_path\\s*\\+\\s*"\\/([^"]+)"/);
    if (m) return m[1];

    m = js.match(/this\\.ajax_loader\\s*=\\s*[^"]*"[^"]*\\/([^"]+\\.php)"/);
    if (m) return m[1];

    m = js.match(/this\\.ajax_loader\\s*=\\s*"\\/([^"]+\\.php)"/);
    if (m) return m[1];
  } catch { }
  return null;
}

async function tryHandshake(base, apiPath, mac, portalUrl, opts = {}) {
  const qs = \`type=stb&action=handshake&prehash=0&token=&JsHttpRequest=1-xml\`;
  const url = \`\${base}\${apiPath}?\${qs}\`;
  const headers = stalkerHeaders(mac, "", portalUrl, normalizeStalkerOpts(opts));

  try {
    const res = await fetch(url, { headers, timeout: 8000, agent: agentFor(url) });
    if (res.status === 429) { throw Object.assign(new Error("rate limited"), {code:"RATE_LIMITED"}); }
    if (res.status === 404) return null;
    if (res.ok) {
      const data = await res.json();
      const token = data?.js?.token;
      if (token) return { token, base, apiPath };
    }
  } catch(e) { if (e.code === "RATE_LIMITED") throw e; }
  return null;
}

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
    throw new Error(\`Portal rate limited (429). Cooldown active for \${waitSeconds}s.\`);
  }

  if (!config.forceRefresh && inFlightSessions.has(sessionKey)) {
    return inFlightSessions.get(sessionKey);
  }

  const loader = (async () => {
    let sawRateLimit = false;

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

    const stripped = portal.replace(/\\/+$/, "");
    const bases = [stripped + "/"];
    if (stripped.endsWith("/c")) {
      bases.push(stripped.replace(/\\/c$/, "") + "/");
      const root = stripped.replace(/\\/[^/]+\\/c$/, "");
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

async function portalFetchRetry(session, params, timeout) {
  let result = await portalFetch(session, params, timeout);
  if (result === null) {
    const fresh = await session.refresh();
    Object.assign(session, fresh);
    result = await portalFetch(session, params, timeout);
  }
  if (result === null) throw new Error(\`Authorization failed for \${params.action || "unknown"}\`);
  return result;
}

async function portalFetch(session, params, timeout = 12000) {
  const qs = new URLSearchParams({ ...params, JsHttpRequest: "1-xml" }).toString();
  const url = \`\${session.base}\${session.apiPath}?\${qs}\`;

  function parseResponse(text, res) {
    if (text.includes("Authorization failed") || text.includes("Device not found") || text.includes("Access denied")) return null;
    try {
      return JSON.parse(text);
    } catch {
      const status = res?.status || "unknown";
      const preview = text.replace(/<[^>]*>/g, "").trim().slice(0, 100);
      throw new Error(\`Portal returned non-JSON (HTTP \${status}): \${preview || "empty response"}\`);
    }
  }

  try {
    const res = await fetch(url, { headers: session.headers, timeout, agent: agentFor(url) });
    if (res.ok) {
      const text = await res.text();
      return parseResponse(text, res);
    }
    if (res.status === 429) throw new Error("Portal rate limited (429). Try again in a minute.");
    if (res.status >= 500) throw new Error(\`Portal server error (\${res.status})\`);
  } catch (e) {
    if (e.message.includes("Portal")) throw e;
  }

  try {
    const res = await fetch(url, { method: "POST", headers: session.headers, body: qs, timeout, agent: agentFor(url) });
    if (res.ok) {
      const text = await res.text();
      return parseResponse(text, res);
    }
    if (res.status === 429) throw new Error("Portal rate limited (429). Try again in a minute.");
  } catch (e) {
    if (e.message.includes("Portal")) throw e;
  }

  throw new Error(\`Portal request failed: \${params.action || "unknown"}\`);
}

async function fetchAllPages(session, type, category, maxItems = 500) {
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

module.exports = {
  isPrivateIP, isUrlAllowedSync, isUrlAllowed, transferTimeout, safeCompare, agentFor,
  safeError, cacheKey, normalizeStalkerOpts, sessionCacheKey, getCachedSession,
  storeSession, setPortalCooldown, getPortalCooldown, buildStalkerStreamHeaders,
  summarizeUpstreamHeaders, stalkerHeaders, extractApiPath, tryHandshake, getSession,
  portalFetchRetry, portalFetch, fetchAllPages, STREAM_CORS: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type",
  }
};
`;

// Extract actual routes from index.js
const routeLines = lines.slice(173, 1610); // Between app.post("/api/track" and trackDailyBandwidth

let currentBlock = [];
let target = null;
let braceCount = 0;
let inRoute = false;

const ADMIN_PASS = "const ADMIN_PASS = process.env.ADMIN_PASS;";
const TMDB_KEY = "const TMDB_KEY = process.env.TMDB_API_KEY || \"\";";
apiCode += `\n${ADMIN_PASS}\n${TMDB_KEY}\n`;
apiCode += `function syncId(req) {\n  if (req.user) return \`user:\${req.user.id}\`;\n  return req.headers["x-guest-id"] ? \`guest:\${req.headers["x-guest-id"]}\` : null;\n}\n\n`;

for (let i = 0; i < routeLines.length; i++) {
  const line = routeLines[i];
  
  if (!inRoute && (line.startsWith("app.get") || line.startsWith("app.post") || line.startsWith("app.put") || line.startsWith("app.delete") || line.startsWith("app.use(\"/stalker\"") || line.startsWith("app.options") || line.startsWith("app.head") || line.startsWith("// ──"))) {
    // Determine target based on path
    if (line.includes('"/api/') || line.includes('"/proxy') || line.includes('"/stream') || line.includes('"/img')) {
      target = "api";
    } else if (line.includes('"/stalker') || line.includes("MAC_RE")) {
      target = "stalker";
    }
  }

  if (target === "api") {
    apiCode += line.replace(/^app\./, 'router.') + '\n';
  } else if (target === "stalker") {
    stalkerCode += line.replace(/^app\./, 'router.') + '\n';
  }
}

apiCode += `\nmodule.exports = router;\n`;
stalkerCode += `\nmodule.exports = router;\n`;

fs.writeFileSync(path.join(srcDir, 'utils', 'proxyHelpers.js'), helpersCode);
fs.writeFileSync(path.join(srcDir, 'routes', 'api.js'), apiCode);
fs.writeFileSync(path.join(srcDir, 'routes', 'stalker.js'), stalkerCode);

console.log('Files generated successfully.');
