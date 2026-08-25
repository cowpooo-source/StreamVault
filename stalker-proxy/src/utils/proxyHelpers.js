const http = require("http");
const https = require("https");
const dns = require("dns");
const util = require("util");
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { pick } = require("stream-json/filters/Pick");
const { streamArray } = require("stream-json/streamers/StreamArray");
const { sanitizeStalkerUrl } = require("../services/stalkerSecurity");
const dnsLookup = util.promisify(dns.lookup);

// ── Pure URL utility functions (no closure dependencies) ──────────────────
function resolveUrl(urlStr, baseStr) {
  try {
    if (!urlStr) return baseStr;
    if (/^https?:\/\//i.test(urlStr)) return urlStr;
    if (urlStr.startsWith("//")) return (baseStr.startsWith("https") ? "https" : "http") + ":" + urlStr;
    if (urlStr.startsWith("/")) {
      const base = new URL(baseStr);
      return `${base.protocol}//${base.host}${urlStr}`;
    }
    return new URL(urlStr, baseStr).toString();
  } catch { return urlStr; }
}

const SAFE_SCHEMES = new Set(["data", "blob", "about"]);
function rewriteMediaUrl(url, token) {
  if (!url || SAFE_SCHEMES.has(url.split(":")[0])) return url;
  const encoded = encodeURIComponent(url);
  return `/stream?url=${encoded}&token=${encodeURIComponent(token)}`;
}

function rewriteM3u8(content, baseUrl, token) {
  const lines = content.split(/\r?\n/);
  return lines.map(l => {
    const trimmed = l.trim();
    const resolved = (trimmed.endsWith(".m3u8") || trimmed.endsWith(".ts") || trimmed.endsWith(".mp4") || trimmed.endsWith(".aac"))
      ? resolveUrl(trimmed, baseUrl)
      : l;
    if (!/^https?:\/\//i.test(resolved)) return resolved;
    return rewriteMediaUrl(resolved, token);
  }).join("\n");
}

// ── Proxy helper factory ──────────────────────────────────────────────────
function stalkerMetadataLimit(action) {
  const isChannelCatalog = action === "get_all_channels";
  const envName = isChannelCatalog ? "STALKER_CHANNELS_MAX_BYTES" : "STALKER_METADATA_MAX_BYTES";
  const configured = Number.parseInt(process.env[envName] || "", 10);
  const defaultLimit = isChannelCatalog ? 16 * 1024 * 1024 : 20 * 1024 * 1024;
  const maximumLimit = isChannelCatalog ? 50 * 1024 * 1024 : 50 * 1024 * 1024;
  return Number.isFinite(configured)
    ? Math.min(maximumLimit, Math.max(64 * 1024, configured))
    : defaultLimit;
}

const EMPTY_CATALOG_ACTIONS = new Set([
  'get_all_channels',
  'get_categories',
  'get_genres',
  'get_ichannels_via_api',
  'get_ordered_list',
]);

async function readBoundedText(response, action) {
  const limit = stalkerMetadataLimit(action);
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > limit) throw new Error(`Portal metadata response exceeds ${limit} bytes`);
  if (!response.body?.[Symbol.asyncIterator]) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error(`Portal metadata response exceeds ${limit} bytes`);
    return text;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) {
      response.body.destroy?.();
      throw new Error(`Portal metadata response exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function buildStalkerProfileParams(session, opts = {}) {
  const crypto = require("crypto");
  const metrics = JSON.stringify({
    mac: session.mac, sn: opts.serial || "", type: opts.stbType || "STB",
    model: opts.model || "MAG250", uid: opts.uid || "", random: session.random || "",
  });
  const params = {
    type: "stb", action: "get_profile", sn: opts.serial || "",
    stb_type: opts.stbType || "MAG250", client_type: opts.clientType || "STB",
    image_version: opts.imageVersion || "0.2.18-r23-254", video_out: opts.videoOut || "hdmi",
    device_id: opts.deviceId || "", device_id2: opts.deviceId2 || opts.deviceId || "",
    signature: opts.signature || session.signature || "", auth_second_step: 1,
    hw_version: opts.hwVersion || "1.7-BD-00",
    hw_version_2: opts.hwVersion2 || crypto.createHash("sha1").update(metrics).digest("hex"),
    not_valid_token: opts.notValidToken || session.notValidToken || 0, metrics,
    timestamp: opts.timestamp || Math.floor(Date.now() / 1000),
    ver: opts.version || "ImageDescription: 0.2.18-r23-254;", num_banks: opts.numBanks || 2,
    JsHttpRequest: "1-xml",
  };
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "" && value !== null && value !== undefined));
}

function createProxyHelpers(deps) {
  const { fetch, isUrlAllowed: suppliedUrlPolicy } = deps;

  const keepAliveAgent      = new http.Agent({ keepAlive: true, maxSockets: 50 });
  const keepAliveAgentHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });
  const agentFor = (url) => url.startsWith("https") ? keepAliveAgentHttps : keepAliveAgent;

  // Total transfer timeout (prevents slow-loris). Returns { signal, clear, abort }.
  function transferTimeout(ms) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    return { signal: ac.signal, clear: () => clearTimeout(timer), abort: () => ac.abort() };
  }

  // Block SSRF: validate proxy URLs with DNS resolution to prevent rebinding
  function isPrivateIP(ip) {
    if (!ip) return true;
    if (ip === "::1" || ip === "[::1]" || ip.startsWith("fe80") || ip.startsWith("fc00") || ip.startsWith("fd")) return true;
    const v4match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    const v4 = v4match ? v4match[1] : ip;
    const parts = v4.split(".").map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p))) return !v4match; 
    if (parts[0] === 127) return true; 
    if (parts[0] === 10) return true;
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
      if (/^[\d.]+$/.test(host) || host.includes(":")) {
        if (isPrivateIP(host)) return false;
      }
      return true;
    } catch { return false; }
  }

  async function defaultIsUrlAllowed(urlStr) {
    if (!isUrlAllowedSync(urlStr)) return false;
    try {
      const u = new URL(urlStr);
      const host = u.hostname.replace(/^\[|\]$/g, "");
      const { address } = await dnsLookup(host);
      if (isPrivateIP(address)) return false;
      return true;
    } catch { return false; }
  }

  const isUrlAllowed = suppliedUrlPolicy || defaultIsUrlAllowed;

  // Follow redirects only after validating every destination. Automatic
  // redirect following would allow a public URL to redirect into a private
  // network or cloud metadata endpoint.
  async function fetchWithRedirectCheck(urlStr, options = {}, maxRedirects = 5) {
    const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
    let currentUrl = urlStr;
    let redirectHeaders = { ...(options.headers || {}) };
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (!(await isUrlAllowed(currentUrl))) {
        const error = new Error("Redirect target is not allowed");
        error.code = "URL_NOT_ALLOWED";
        throw error;
      }
      const response = await fetch(currentUrl, { ...options, headers: redirectHeaders, redirect: "manual" });
      if (!REDIRECT_STATUSES.has(response.status)) {
        return { response, url: currentUrl, redirected: currentUrl !== urlStr };
      }
      const location = response.headers?.get?.("location") || response.headers?.get?.("Location");
      // node-fetch uses Node streams; discard each redirect response before
      // opening the next hop so redirect probes cannot retain sockets.
      try {
        if (typeof response.body?.destroy === "function") response.body.destroy();
        else await response.body?.cancel?.();
      } catch {}
      if (!location) {
        const error = new Error("Redirect response missing Location header");
        error.code = "INVALID_REDIRECT";
        throw error;
      }
      const nextUrl = new URL(location, currentUrl).toString();
      if (new URL(nextUrl).host !== new URL(currentUrl).host) {
        redirectHeaders = Object.fromEntries(Object.entries(redirectHeaders).filter(([name]) =>
          !["authorization", "cookie", "proxy-authorization", "referer", "x-user-agent"].includes(name.toLowerCase())));
      }
      currentUrl = nextUrl;
    }
    const error = new Error("Too many redirects");
    error.code = "TOO_MANY_REDIRECTS";
    throw error;
  }
  // Safe error messages: only expose portal/user-facing errors, not internal stack details
  const SAFE_PREFIXES = ["Portal", "No stream", "Stream server", "Invalid", "portal and mac"];
  function safeError(e) {
    const msg = e?.message || "Unknown error";
    if (SAFE_PREFIXES.some(p => msg.startsWith(p))) return msg;
    console.error("Internal error:", sanitizeStalkerUrl(msg));
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

  // ── Cache: path resolution cached long-term, tokens are never cached (portals invalidate on re-handshake)
  const pathCache = new Map();
  const PATH_CACHE_MAX = 500;
  const sessionCache = new Map();
  const inFlightSessions = new Map();
  const inFlightMetadataRequests = new Map();
  const inFlightCatalogRequests = new Map();
  const portalCooldowns = new Map();
  const providerCooldowns = new Map();
  const providerFailureStates = new Map();
  const activeMetadataRequests = new Map();
  const handshakeFailureCache = new Map();
  const HANDSHAKE_FAILURE_CACHE_MAX = 500;
  const COOLDOWN_CACHE_MAX = 500;
  const SESSION_TTL_MS = 30 * 1000;
  function boundedEnvInt(name, fallback, min, max) {
    const configured = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(configured)
      ? Math.min(max, Math.max(min, configured))
      : fallback;
  }

  function rateLimitCooldownMs() {
    return boundedEnvInt('STALKER_PROVIDER_COOLDOWN_MS', 60 * 1000, 5 * 1000, 5 * 60 * 1000);
  }

  function providerFailureThreshold() {
    return boundedEnvInt('STALKER_PROVIDER_FAILURE_THRESHOLD', 3, 2, 10);
  }

  function providerFailureWindowMs() {
    return boundedEnvInt('STALKER_PROVIDER_FAILURE_WINDOW_MS', 60 * 1000, 10 * 1000, 10 * 60 * 1000);
  }

  function providerFailureCooldownMs() {
    return boundedEnvInt('STALKER_PROVIDER_FAILURE_COOLDOWN_MS', 2 * 60 * 1000, 30 * 1000, 10 * 60 * 1000);
  }

  function providerKey(portal) {
    try {
      return new URL(portal).host.toLowerCase();
    } catch {
      return String(portal || '').replace(/\/+$/, '').toLowerCase();
    }
  }
  const HANDSHAKE_FAILURE_COOLDOWN_MS = 90 * 1000; // 90s — prevents cascade when portal is down

  function setPathCache(key, value) {
    if (pathCache.size >= PATH_CACHE_MAX) {
      const oldest = pathCache.keys().next().value;
      pathCache.delete(oldest);
    }
    pathCache.set(key, { ...value, expiresAt: Date.now() + 24 * 60 * 60_000 });
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
      random: cached.random || null,
      notValidToken: cached.notValidToken ?? null,
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
      random: result.random || null,
      notValidToken: result.notValidToken ?? null,
      base: result.base,
      apiPath: result.apiPath,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return {
      token: result.token,
      random: result.random || null,
      notValidToken: result.notValidToken ?? null,
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
    const expiresAt = Date.now() + rateLimitCooldownMs();
    const sessionKey = sessionCacheKey(portal, mac, opts);
    const provider = providerKey(portal);
    if (portalCooldowns.size >= COOLDOWN_CACHE_MAX && !portalCooldowns.has(sessionKey)) {
      portalCooldowns.delete(portalCooldowns.keys().next().value);
    }
    if (providerCooldowns.size >= COOLDOWN_CACHE_MAX && !providerCooldowns.has(provider)) {
      providerCooldowns.delete(providerCooldowns.keys().next().value);
    }
    portalCooldowns.set(sessionKey, expiresAt);
    providerCooldowns.set(provider, expiresAt);
  }

  function recordProviderFailure(portal, error) {
    const message = String(error?.message || 'provider failure');
    if (!/(authorization|auth failed|device not found|access denied|handshake failed|could not obtain token|server error \(5\d\d\))/i.test(message)) return null;
    const provider = providerKey(portal);
    const now = Date.now();
    const previous = providerFailureStates.get(provider);
    const state = previous && previous.expiresAt > now
      ? previous
      : { count: 0, expiresAt: now + providerFailureWindowMs() };
    state.count += 1;
    state.expiresAt = now + providerFailureWindowMs();
    providerFailureStates.set(provider, state);
    if (state.count < providerFailureThreshold()) return null;

    const expiresAt = now + providerFailureCooldownMs();
    providerCooldowns.set(provider, expiresAt);
    return Object.assign(
      new Error(`Provider temporarily blocked after repeated failures. Retry in ${Math.ceil((expiresAt - now) / 1000)}s.`),
      { code: 'PROVIDER_COOLDOWN', retryAfterMs: expiresAt - now },
    );
  }

  function getPortalCooldown(portal, mac, opts = {}) {
    const key = sessionCacheKey(portal, mac, opts);
    const provider = providerKey(portal);
    const sessionExpiresAt = portalCooldowns.get(key) || 0;
    const providerExpiresAt = providerCooldowns.get(provider) || 0;
    const now = Date.now();
    if (sessionExpiresAt && sessionExpiresAt <= now) {
      portalCooldowns.delete(key);
    }
    if (providerExpiresAt && providerExpiresAt <= now) {
      providerCooldowns.delete(provider);
    }
    return Math.max(
      sessionExpiresAt > now ? sessionExpiresAt : 0,
      providerExpiresAt > now ? providerExpiresAt : 0,
    );
  }

  // ── Handshake failure cache: prevent hammering a portal that's down ──
  function getHandshakeFailure(portal, mac, opts = {}) {
    const key = sessionCacheKey(portal, mac, opts);
    const entry = handshakeFailureCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      handshakeFailureCache.delete(key);
      return null;
    }
    return entry;
  }

  function setHandshakeFailure(portal, mac, opts, errorMsg) {
    const key = sessionCacheKey(portal, mac, opts);
    if (handshakeFailureCache.size >= HANDSHAKE_FAILURE_CACHE_MAX) {
      const oldest = handshakeFailureCache.keys().next().value;
      handshakeFailureCache.delete(oldest);
    }
    handshakeFailureCache.set(key, {
      error: errorMsg,
      expiresAt: Date.now() + HANDSHAKE_FAILURE_COOLDOWN_MS,
    });
  }

  function clearHandshakeFailure(portal, mac, opts = {}) {
    const key = sessionCacheKey(portal, mac, opts);
    handshakeFailureCache.delete(key);
  }

  function buildStalkerStreamHeaders(session, reqHeaders = {}) {
    // MAG devices hand the resolved media URL to FFmpeg. Portal API
    // Authorization/Cookie headers must not leak to the media host.
    const headers = {
      "User-Agent": "Lavf53.32.100",
      "Accept": "*/*",
      "Connection": "close",
      "Icy-MetaData": "1",
    };
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
      const js = await readBoundedText(res);

      let m = js.match(/this\.ajax_loader\s*=\s*this\.portal_protocol\s*\+\s*"[^"]*"\s*\+\s*this\.portal_ip\s*\+\s*"\/"\s*\+\s*this\.portal_path\s*\+\s*"\/([^"]+)"/);
      if (m) return m[1];

      m = js.match(/this\.ajax_loader\s*=\s*[^"]*"[^"]*\/([^"]+\.php)"/);
      if (m) return m[1];

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

    // Some portals reject GET handshakes with 405/404 and only accept the
    // MAG client's POST form. Try GET first for legacy portals, then mirror
    // the client request before abandoning this candidate path.
    const attempts = [
      { headers, timeout: 8000, agent: agentFor(url) },
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: qs,
        timeout: 8000,
        agent: agentFor(url),
      },
    ];
    for (const options of attempts) {
      try {
        const res = await fetch(url, options);
        if (res.status === 429) { console.log(`  ${base}${apiPath} → 429 rate limited`); throw Object.assign(new Error("rate limited"), {code:"RATE_LIMITED"}); }
        if (res.status === 404) continue;
        if (res.ok) {
          const data = await res.json();
          const token = data?.js?.token;
          const random = data?.js?.random || null;
          const notValidToken = data?.js?.not_valid_token ?? null;
          if (token) return { token, random, notValidToken, base, apiPath };
        }
      } catch(e) { if (e.code === "RATE_LIMITED") throw e; /* try the next method/path */ }
    }
    return null;
  }

  // Complete the portal device-auth step required by newer Stalker portals.
  // Some portals reject catalog requests until metrics and hw_version_2 are posted.
  async function completeDeviceAuth(session, opts = {}, requestOptions = {}) {
    try {
      const params = buildStalkerProfileParams(session, opts);
      const qs = new URLSearchParams(params).toString();
      const url = `${session.base}${session.apiPath}?JsHttpRequest=1-xml`;
      const headers = { ...session.headers, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" };
      const response = await fetch(url, { method: "POST", headers, body: qs, timeout: 8000, signal: requestOptions.signal, agent: agentFor(url) });
      if (response.status === 429) {
        throw Object.assign(new Error('Portal rate limited (429). Try again later.'), { code: 'RATE_LIMITED' });
      }
      const body = await readBoundedText(response);
      if (!response.ok || /Authorization failed|Device not found|Access denied|not supported|missing metrics/i.test(body)) {
        console.warn("Stalker device authentication was rejected");
        return false;
      }
      return true;
    } catch (error) {
      if (requestOptions.signal?.aborted) throw error;
      if (error?.code === 'RATE_LIMITED') throw error;
      console.warn("Stalker device authentication failed:", sanitizeStalkerUrl(error.message));
      return false;
    }
  }
  // Get a session with a valid token — does exactly ONE handshake
  // Path resolution is cached; token is always fresh
  async function getSession(portal, mac, opts = {}, config = {}) {
    const normalized = normalizeStalkerOpts(opts);
    const key = cacheKey(portal, mac);
    const sessionKey = sessionCacheKey(portal, mac, normalized);
    let cached = pathCache.get(key);
    if (cached?.expiresAt <= Date.now()) { pathCache.delete(key); cached = null; }

    if (config.forceRefresh) {
      sessionCache.delete(sessionKey);
      clearHandshakeFailure(portal, mac, normalized);
    } else {
      const cachedSession = getCachedSession(portal, mac, normalized);
      if (cachedSession) return cachedSession;

      // Check failure cache — skip handshake if this combo recently failed
      const recentFailure = getHandshakeFailure(portal, mac, normalized);
      if (recentFailure) {
        const waitSeconds = Math.max(1, Math.ceil((recentFailure.expiresAt - Date.now()) / 1000));
        throw new Error(`Portal handshake recently failed. Retry in ${waitSeconds}s. (${recentFailure.error})`);
      }
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

      // If path is known, do a single handshake on the known path
      if (cached) {
        try {
          const result = await tryHandshake(cached.base, cached.apiPath, mac, portal, normalized);
          if (result) {
            const session = storeSession(portal, mac, normalized, {
              token: result.token,
              random: result.random,
              notValidToken: result.notValidToken,
              base: cached.base,
              apiPath: cached.apiPath,
            });
            return session;
          }
          // Path may have changed — clear cache and re-discover
          pathCache.delete(key);
        } catch (e) {
          if (e.code === "RATE_LIMITED") {
            setPortalCooldown(portal, mac, normalized);
            throw Object.assign(new Error('Portal rate limited (429). Try again later.'), { code: 'RATE_LIMITED' });
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
              const session = storeSession(portal, mac, normalized, {
                token: result.token,
                random: result.random,
                notValidToken: result.notValidToken,
                base,
                apiPath: path,
              });
              return session;
            }
          } catch(e) {
            if (e.code === "RATE_LIMITED") {
              setPortalCooldown(portal, mac, normalized);
              throw Object.assign(new Error('Portal rate limited (429). Try again later.'), { code: 'RATE_LIMITED' });
            }
            throw e;
          }
        }
      }
      throw new Error("Handshake failed: could not obtain token from portal");
    })();

    if (!config.forceRefresh) inFlightSessions.set(sessionKey, loader);
    try {
      const result = await loader;
      clearHandshakeFailure(portal, mac, normalized); // success — clear any prior failure
      return result;
    } catch (e) {
      // Cache non-rate-limit failures to prevent cascade (e.g. 350 users hammering a dead portal)
      if (e.message?.includes("could not obtain token") || e.message?.includes("Handshake failed")) {
        setHandshakeFailure(portal, mac, normalized, e.message);
      }
      const blocked = recordProviderFailure(portal, e);
      if (blocked) throw blocked;
      throw e;
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

  function metadataRequestKey(session, params) {
    const sortedParams = Object.fromEntries(
      Object.entries(params || {}).sort(([left], [right]) => left.localeCompare(right)),
    );
    return JSON.stringify([
      String(session.base || session.portal || '').replace(/\/+$/, ''),
      session.apiPath || '',
      session.mac || '',
      session.opts?.serial || '',
      sortedParams,
    ]);
  }

  async function portalFetchRetryInternal(session, params, timeout, requestOptions) {
    const cooldownUntil = getPortalCooldown(session.portal || session.base, session.mac, session.opts);
    if (cooldownUntil) {
      const waitSeconds = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000));
      throw Object.assign(new Error(`Portal cooldown active. Retry in ${waitSeconds}s.`), {
        code: 'PROVIDER_COOLDOWN',
        retryAfterMs: cooldownUntil - Date.now(),
      });
    }

    let result = await portalFetch(session, params, timeout, requestOptions);
    const maxRecoveries = boundedEnvInt('STALKER_METADATA_MAX_AUTH_RECOVERIES', 2, 0, 2);
    if (result === null && maxRecoveries >= 1) {
      // Authenticate lazily because some legacy portals invalidate an otherwise
      // valid handshake token when they receive the optional second step.
      const authenticated = await completeDeviceAuth(session, session.opts || {}, requestOptions);
      if (authenticated) result = await portalFetch(session, params, timeout, requestOptions);
    }
    if (result === null && maxRecoveries >= 2) {
      // Restore a clean token if optional device authentication was rejected.
      const fresh = await session.refresh();
      Object.assign(session, fresh);
      result = await portalFetch(session, params, timeout, requestOptions);
    }
    if (result === null) throw new Error(`Authorization failed for ${params.action || "unknown"}`);
    return result;
  }

  // Deduplicate identical catalog requests. The shared request deliberately
  // does not inherit one browser's abort signal, which could cancel work still
  // needed by other callers; the upstream timeout remains the hard bound.
  async function portalFetchRetry(session, params, timeout, requestOptions = {}) {
    const key = metadataRequestKey(session, params);
    const existing = inFlightMetadataRequests.get(key);
    if (existing) return existing;

    const sharedOptions = { ...requestOptions };
    delete sharedOptions.signal;
    const request = portalFetchRetryInternal(session, params, timeout, sharedOptions)
      .catch(error => {
        if (error?.code === 'RATE_LIMITED' || /\b429\b|rate limited/i.test(error?.message || '')) {
          setPortalCooldown(session.portal || session.base, session.mac, session.opts);
        } else {
          const blocked = recordProviderFailure(session.portal || session.base, error);
          if (blocked) throw blocked;
        }
        throw error;
      })
      .finally(() => inFlightMetadataRequests.delete(key));
    inFlightMetadataRequests.set(key, request);
    return request;
  }

  // Make an API call using the resolved session
  async function portalFetch(session, params, timeout = 12000, requestOptions = {}) {
    const qs = new URLSearchParams({ ...params, JsHttpRequest: "1-xml" }).toString();
    const url = `${session.base}${session.apiPath}?${qs}`;
    const metadataProviderKey = providerKey(session.base);
    const active = activeMetadataRequests.get(metadataProviderKey) || 0;
    const maxConcurrent = boundedEnvInt('STALKER_METADATA_MAX_CONCURRENCY', 6, 1, 20);
    if (active >= maxConcurrent) throw new Error("Portal metadata concurrency limit reached");
    activeMetadataRequests.set(metadataProviderKey, active + 1);
    try {

    function parseResponse(text, res) {
      if (!text.trim() && EMPTY_CATALOG_ACTIONS.has(String(params.action || ''))) return { js: [] };
      if (text.includes("Authorization failed") || text.includes("Device not found") || text.includes("Access denied")) return null; // token/auth expired or invalid
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
      const res = await fetch(url, { headers: session.headers, timeout, signal: requestOptions.signal, agent: agentFor(url) });
      if (res.ok) {
        const text = await readBoundedText(res, params.action);
        return parseResponse(text, res);
      }
      if (res.status === 429) throw Object.assign(new Error('Portal rate limited (429). Try again later.'), { code: 'RATE_LIMITED' });
      if (res.status >= 500) throw new Error(`Portal server error (${res.status})`);
    } catch (e) {
      if (requestOptions.signal?.aborted || e.message.includes("Portal")) throw e; // re-throw aborts and our own errors
    }

    // Try POST as fallback
    try {
      const res = await fetch(url, { method: "POST", headers: session.headers, body: qs, timeout, signal: requestOptions.signal, agent: agentFor(url) });
      if (res.ok) {
        const text = await readBoundedText(res, params.action);
        return parseResponse(text, res);
      }
      if (res.status === 429) throw Object.assign(new Error('Portal rate limited (429). Try again later.'), { code: 'RATE_LIMITED' });
    } catch (e) {
      if (requestOptions.signal?.aborted || e.message.includes("Portal")) throw e;
    }

    throw new Error(`Portal request failed: ${params.action || "unknown"}`);
    } finally {
      const remaining = (activeMetadataRequests.get(metadataProviderKey) || 1) - 1;
      if (remaining > 0) activeMetadataRequests.set(metadataProviderKey, remaining); else activeMetadataRequests.delete(metadataProviderKey);
    }
  }

  async function portalFetchChannelCatalog(session, maxItems, timeout = 12000, requestOptions = {}) {
    const parsedLimit = Number.parseInt(maxItems, 10);
    const limit = maxItems === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.min(50_000, Math.max(1, parsedLimit || 1));
    const filterKey = String(requestOptions.filterKey || 'all');
    const requestKey = `${metadataRequestKey(session, { type: 'itv', action: 'get_all_channels' })}|limit:${limit}|filter:${filterKey}`;
    const existing = inFlightCatalogRequests.get(requestKey);
    if (existing) return existing;
    const cooldownUntil = getPortalCooldown(session.portal || session.base, session.mac, session.opts);
    if (cooldownUntil) {
      throw Object.assign(new Error(`Portal cooldown active. Retry in ${Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000))}s.`), {
        code: 'PROVIDER_COOLDOWN',
        retryAfterMs: cooldownUntil - Date.now(),
      });
    }
    const metadataProviderKey = providerKey(session.base);
    const active = activeMetadataRequests.get(metadataProviderKey) || 0;
    const maxConcurrent = boundedEnvInt('STALKER_METADATA_MAX_CONCURRENCY', 6, 1, 20);
    if (active >= maxConcurrent) throw new Error('Portal metadata concurrency limit reached');
    activeMetadataRequests.set(metadataProviderKey, active + 1);
    const request = (async () => {
    const qs = new URLSearchParams({
      type: "itv",
      action: "get_all_channels",
      JsHttpRequest: "1-xml",
    }).toString();
    const url = `${session.base}${session.apiPath}?${qs}`;
    const response = await fetch(url, {
      headers: session.headers,
      timeout,
      signal: requestOptions.signal,
      agent: agentFor(url),
    });
    if (!response.ok) {
      if (response.status === 429) {
        throw Object.assign(new Error("Portal rate limited (429). Try again later."), { code: "RATE_LIMITED" });
      }
      throw new Error(`Portal server error (${response.status})`);
    }
    if (!response.body?.pipe) throw new Error("Portal channel catalog is not streamable");

    const catalogStream = chain([
      parser(),
      pick({ filter: "js.data" }),
      streamArray(),
    ]);
    const forwardSourceError = error => catalogStream.destroy(error);
    response.body.once("error", forwardSourceError);
    response.body.pipe(catalogStream);

    const channels = [];
    const onItem = typeof requestOptions.onItem === 'function' ? requestOptions.onItem : null;
    const filterItem = typeof requestOptions.filterItem === 'function' ? requestOptions.filterItem : null;
    let itemCount = 0;
    try {
      for await (const entry of catalogStream) {
        if (filterItem && !filterItem(entry.value)) continue;
        itemCount += 1;
        if (onItem) await onItem(entry.value, itemCount);
        else channels.push(entry.value);
        if (itemCount >= limit) break;
      }
    } finally {
      response.body.removeListener("error", forwardSourceError);
      response.body.unpipe(catalogStream);
      if (!response.body.destroyed) response.body.destroy();
      if (!catalogStream.destroyed) catalogStream.destroy();
    }
    return onItem ? itemCount : channels;
    })().catch(error => {
      if (error?.code === 'RATE_LIMITED' || /\b429\b|rate limited/i.test(error?.message || '')) {
        setPortalCooldown(session.portal || session.base, session.mac, session.opts);
      } else {
        const blocked = recordProviderFailure(session.portal || session.base, error);
        if (blocked) throw blocked;
      }
      throw error;
    }).finally(() => {
      inFlightCatalogRequests.delete(requestKey);
      const remaining = (activeMetadataRequests.get(metadataProviderKey) || 1) - 1;
      if (remaining > 0) activeMetadataRequests.set(metadataProviderKey, remaining);
      else activeMetadataRequests.delete(metadataProviderKey);
    });
    inFlightCatalogRequests.set(requestKey, request);
    return request;
  }

  async function portalFetchChannelCatalogPage(session, options = {}, timeout = 12000, requestOptions = {}) {
    const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
    const pageSize = Math.min(250, Math.max(1, Number.parseInt(options.pageSize, 10) || 100));
    const category = String(options.category ?? 'all').trim();
    const offset = (page - 1) * pageSize;
    const pageItems = [];
    const maxMatches = offset + pageSize + 1;
    const categoryMatches = category === '' || category === '*' || category.toLowerCase() === 'all'
      ? () => true
      : item => [item?.tv_genre_id, item?.genre_id, item?.category_id, item?.group_id]
        .some(value => value !== null && value !== undefined && String(value) === category);
    const result = await portalFetchChannelCatalog(session, maxMatches, timeout, {
      ...requestOptions,
      filterKey: category || 'all',
      filterItem: categoryMatches,
      onItem: (item, matchIndex) => {
        if (matchIndex > offset && pageItems.length < pageSize) pageItems.push(item);
      },
    });
    const matchedCount = Number(result) || 0;
    const hasMore = matchedCount > offset + pageSize;
    const body = {
      data: pageItems,
      max_page_items: pageSize,
    };
    if (!hasMore) {
      body.total_items = offset + pageItems.length;
      body.total_pages = page;
    }
    return { js: body };
  }

  function resetProxyHelperStateForTests() {
    pathCache.clear();
    sessionCache.clear();
    inFlightSessions.clear();
    inFlightMetadataRequests.clear();
    inFlightCatalogRequests.clear();
    portalCooldowns.clear();
    providerCooldowns.clear();
    providerFailureStates.clear();
    activeMetadataRequests.clear();
    handshakeFailureCache.clear();
  }

  // ── URL resolution ──────────────────────────────────────────────────────────
  // Resolve a URL against a base (handles absolute, relative, protocol-relative)
  function resolveUrl(urlStr, baseStr) {
    try {
      if (!urlStr) return baseStr;
      // Absolute URL — return as-is
      if (/^https?:\/\//i.test(urlStr)) return urlStr;
      // Protocol-relative //host/path
      if (urlStr.startsWith("//")) return (baseStr.startsWith("https") ? "https" : "http") + ":" + urlStr;
      // Absolute path /path — replace base path
      if (urlStr.startsWith("/")) {
        const base = new URL(baseStr);
        return `${base.protocol}//${base.host}${urlStr}`;
      }
      // Relative path — resolve against base
      return new URL(urlStr, baseStr).toString();
    } catch { return urlStr; }
  }

  // ── Media URL rewriting ────────────────────────────────────────────────────
  const SAFE_SCHEMES = new Set(["data:", "blob:", "about:"]);
  function rewriteMediaUrl(url, token) {
    if (!url || SAFE_SCHEMES.has(url.split(":")[0])) return url;
    const encoded = encodeURIComponent(url);
    return `/stream?url=${encoded}&token=${encodeURIComponent(token)}`;
  }

  function rewriteM3u8(content, baseUrl, token) {
    const lines = content.split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.endsWith(".m3u8") || trimmed.endsWith(".ts") || trimmed.endsWith(".mp4") || trimmed.endsWith(".aac")) {
        out.push(resolveUrl(trimmed, baseUrl));
      } else {
        out.push(line);
      }
    }
    return out.map(l => {
      if (!/^https?:\/\//i.test(l)) return l;
      return rewriteMediaUrl(l, token);
    }).join("\n");
  }

  return {
    transferTimeout,
    agentFor,
    isPrivateIP,
    isUrlAllowedSync,
    isUrlAllowed,
    fetchWithRedirectCheck,
    cacheKey,
    summarizeUpstreamHeaders,
    buildStalkerStreamHeaders,
    buildStalkerProfileParams,
    safeError,
    getSession,
    portalFetchRetry,
    portalFetchChannelCatalog,
    portalFetchChannelCatalogPage,
    resetProxyHelperStateForTests,
    resolveUrl,
    rewriteMediaUrl,
    rewriteM3u8,
  };
}

module.exports = { createProxyHelpers };
module.exports.buildStalkerProfileParams = buildStalkerProfileParams;
module.exports.resolveUrl     = resolveUrl;
module.exports.rewriteMediaUrl = rewriteMediaUrl;
module.exports.rewriteM3u8   = rewriteM3u8;
