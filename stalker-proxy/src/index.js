require("dotenv").config();
const express = require("express");
const fetch   = require("node-fetch");
const cors    = require("cors");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  methods: ["GET", "POST"],
}));
app.use(express.json());

// ── Cache: { `${portalUrl}|${mac}` : { token, base, apiPath, expires } }
const tokenCache = new Map();

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
function stalkerHeaders(mac, token = "", portalUrl = "") {
  // Use the portal's own URL as Referer (extractstb pattern)
  const referer = portalUrl
    ? portalUrl.replace(/\/+$/, "").replace(/\/c$/, "") + "/c/"
    : "http://localhost/";
  return {
    "User-Agent":    "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
    "Accept":        "*/*",
    "Content-Type":  "application/x-www-form-urlencoded; charset=UTF-8",
    "X-User-Agent":  "Model: MAG250; Link: WiFi",
    "Authorization": token ? `Bearer ${token}` : "Bearer ",
    "Cookie":        `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=Europe%2FParis`,
    "Referer":       referer,
  };
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

  // Try GET first, then POST (extractstb pattern)
  for (const method of ["GET", "POST"]) {
    try {
      const opts = { headers, timeout: 8000 };
      if (method === "POST") {
        opts.method = "POST";
        opts.body = qs;
      }
      const res = await fetch(url, opts);
      if (!res.ok) continue;
      const data = await res.json();
      const token = data?.js?.token;
      if (token) return { token, base, apiPath };
    } catch { continue; }
  }
  return null;
}

// Full handshake flow: xpcom extraction → fallback paths → /c/ toggle
async function fetchToken(portalUrl, mac) {
  const key = cacheKey(portalUrl, mac);
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now()) return cached;

  const stripped = portalUrl.replace(/\/+$/, "");

  // Build base URLs to try (with and without /c/)
  const bases = [stripped + "/"];
  if (stripped.endsWith("/c")) bases.push(stripped.replace(/\/c$/, "") + "/");
  else bases.push(stripped + "/c/");

  // Step 1: Try to extract API path from xpcom.common.js
  const extractedPath = await extractApiPath(portalUrl, mac);

  // Step 2: Build ordered list of API paths to try
  const pathsToTry = extractedPath
    ? [extractedPath, ...API_PATHS.filter(p => p !== extractedPath)]
    : [...API_PATHS];

  // Step 3: Try each base × path combination
  for (const base of bases) {
    for (const apiPath of pathsToTry) {
      const result = await tryHandshake(base, apiPath, mac, portalUrl);
      if (result) {
        const entry = { ...result, expires: Date.now() + 4 * 60 * 60 * 1000 };
        tokenCache.set(key, entry);
        console.log(`✓ Handshake OK: ${base}${apiPath}`);
        return entry;
      }
    }
  }

  throw new Error("Handshake failed: could not obtain token from portal");
}

// Get a valid token + resolved base + apiPath for a portal
async function getSession(portal, mac) {
  const session = await fetchToken(portal, mac);
  return {
    token:   session.token,
    base:    session.base,
    apiPath: session.apiPath,
    headers: stalkerHeaders(mac, session.token, portal),
  };
}

// Make an API call using the resolved session (tries GET then POST)
async function portalFetch(session, params, timeout = 12000) {
  const qs = new URLSearchParams({ ...params, JsHttpRequest: "1-xml" }).toString();
  const url = `${session.base}${session.apiPath}?${qs}`;

  for (const method of ["GET", "POST"]) {
    try {
      const opts = { headers: session.headers, timeout };
      if (method === "POST") {
        opts.method = "POST";
        opts.body = qs;
      }
      const res = await fetch(url, opts);
      if (!res.ok) continue;
      return await res.json();
    } catch { continue; }
  }
  throw new Error(`Portal request failed: ${params.action || "unknown"}`);
}

// ─────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ── POST /stalker/handshake
app.post("/stalker/handshake", async (req, res) => {
  const { portal, mac } = req.body;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const session = await getSession(portal, mac);
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
    const data = await portalFetch(session, apiParams);
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

    const [genreData, chData] = await Promise.all([
      portalFetch(session, { type: "itv", action: "get_genres" }, 10000),
      portalFetch(session, { type: "itv", action: "get_all_channels" }, 15000),
    ]);

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

// ── GET /stalker/vod
app.get("/stalker/vod", async (req, res) => {
  const { portal, mac, page = 1, category = "*" } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const session = await getSession(portal, mac);
    const [catData, data] = await Promise.all([
      portalFetch(session, { type: "vod", action: "get_categories" }, 10000),
      portalFetch(session, { type: "vod", action: "get_ordered_list", category, page, p: page }),
    ]);

    const cats = catData?.js || [];
    const catMap = Object.fromEntries(cats.map(c => [c.id, c.title]));

    const items = (data?.js?.data || []).map(v => ({
      id:    v.id,
      name:  v.name,
      logo:  v.screenshot_uri || v.cover || null,
      year:  v.year,
      rating: v.rating_imdb || v.rating || null,
      url:   v.cmd || null,
      group: catMap[v.category_id] || "Other",
      type:  "vod",
    }));

    res.json({ items, total: data?.js?.total_items, page: data?.js?.cur_page });
  } catch (e) {
    console.error("VOD error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/stream
app.get("/stalker/stream", async (req, res) => {
  const { portal, mac, cmd } = req.query;
  if (!portal || !mac || !cmd) return res.status(400).json({ error: "portal, mac and cmd required" });

  try {
    const session = await getSession(portal, mac);
    const data = await portalFetch(session, {
      type: "itv", action: "create_link",
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

// ── GET /stalker/profile (new — from extractstb)
app.get("/stalker/profile", async (req, res) => {
  const { portal, mac } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const session = await getSession(portal, mac);
    const data = await portalFetch(session, {
      type: "stb", action: "get_profile",
      auth_second_step: 1,
      hw_version_2: "8b80dfaa8cf83485567849b7202a79360fc988e3",
    });
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
    const data = await portalFetch(session, {
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
    const data = await portalFetch(session, {
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

// ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Stalker proxy running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
