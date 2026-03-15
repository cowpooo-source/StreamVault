require("dotenv").config();
const express = require("express");
const fetch   = require("node-fetch");
const cors    = require("cors");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Allow requests from your StreamVault frontend
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  methods: ["GET", "POST"],
}));
app.use(express.json());

// ── In-memory token cache: { `${portalUrl}|${mac}` : { token, expires } }
const tokenCache = new Map();

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function cacheKey(portal, mac) {
  return `${portal}|${mac}`;
}

function normalizePortal(url) {
  // Strip trailing slashes, ensure it ends with /
  return url.replace(/\/+$/, "") + "/";
}

// Build Stalker-style headers
function stalkerHeaders(mac, token = "") {
  return {
    "User-Agent":   "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stb mainpage Safari/533.3",
    "Accept":       "*/*",
    "X-User-Agent": "Model: MAG250; Link: WiFi",
    "Authorization":token ? `Bearer ${token}` : "Bearer ",
    "Cookie":       `mac=${mac}; stb_lang=en; timezone=America/Toronto`,
    "Referer":      "http://localhost/",
  };
}

// Fetch a token from the portal (handshake)
// Tries the given base first, then falls back to base + "c/" for portals
// that use /c/ as their Stalker path
async function fetchToken(portalBase, mac) {
  const key = cacheKey(portalBase, mac);
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.token;

  const qs = "server/load.php?type=stb&action=handshake&prehash=0&token=&JsHttpRequest=1-xml";
  const headers = stalkerHeaders(mac);
  const stripped = portalBase.replace(/\/+$/, "");
  const bases = [portalBase];
  // Try with /c/ appended or removed to handle both portal styles
  if (stripped.endsWith("/c")) bases.push(stripped.replace(/\/c$/, "") + "/");
  else bases.push(stripped + "/c/");

  for (const base of bases) {
    try {
      const res = await fetch(`${base}${qs}`, { headers, timeout: 8000 });
      if (!res.ok) continue;
      const data = await res.json();
      const token = data?.js?.token;
      if (!token) continue;
      // Cache for 4 hours, remembering the working base
      tokenCache.set(key, { token, base, expires: Date.now() + 4 * 60 * 60 * 1000 });
      return token;
    } catch { continue; }
  }
  throw new Error("Handshake failed: could not obtain token from portal");
}

// Get the resolved base URL for a portal (uses cached result from handshake)
function resolvedBase(portal, mac) {
  const cached = tokenCache.get(cacheKey(normalizePortal(portal), mac));
  return cached?.base || normalizePortal(portal);
}

// ─────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ── POST /stalker/handshake
// Returns a token for the given portal + MAC
app.post("/stalker/handshake", async (req, res) => {
  const { portal, mac } = req.body;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const portalBase = normalizePortal(portal);
    const token = await fetchToken(portalBase, mac);
    res.json({ token });
  } catch (e) {
    console.error("Handshake error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/api?portal=...&mac=...&type=...&action=...&[extra params]
// Proxies any Stalker portal API call, auto-injecting token
app.get("/stalker/api", async (req, res) => {
  const { portal, mac, ...apiParams } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const portalBase = normalizePortal(portal);
    const token      = await fetchToken(portalBase, mac);
    const base       = resolvedBase(portal, mac);

    // Build the upstream URL
    const qs  = new URLSearchParams({ ...apiParams, JsHttpRequest: "1-xml" }).toString();
    const url = `${base}server/load.php?${qs}`;

    const upstream = await fetch(url, {
      headers: stalkerHeaders(mac, token),
      timeout: 12000,
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
    }

    const data = await upstream.json();
    res.json(data);
  } catch (e) {
    console.error("API proxy error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/channels?portal=...&mac=...
// Convenience: fetch all channels with category info merged
app.get("/stalker/channels", async (req, res) => {
  const { portal, mac } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const portalBase = normalizePortal(portal);
    const token      = await fetchToken(portalBase, mac);
    const base       = resolvedBase(portal, mac);
    const headers    = stalkerHeaders(mac, token);

    // 1. Get genre list
    const genreURL = `${base}server/load.php?type=itv&action=get_genres&JsHttpRequest=1-xml`;
    const genreRes = await fetch(genreURL, { headers, timeout: 10000 });
    const genreData = await genreRes.json();
    const genres = genreData?.js || [];
    const genreMap = Object.fromEntries(genres.map(g => [g.id, g.title]));

    // 2. Get all channels (page 1, large limit)
    const chURL = `${base}server/load.php?type=itv&action=get_all_channels&JsHttpRequest=1-xml`;
    const chRes  = await fetch(chURL, { headers, timeout: 15000 });
    const chData = await chRes.json();
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

// ── GET /stalker/vod?portal=...&mac=...&page=1
app.get("/stalker/vod", async (req, res) => {
  const { portal, mac, page = 1, category = "*" } = req.query;
  if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

  try {
    const portalBase = normalizePortal(portal);
    const token      = await fetchToken(portalBase, mac);
    const base       = resolvedBase(portal, mac);
    const headers    = stalkerHeaders(mac, token);

    const url = `${base}server/load.php?type=vod&action=get_ordered_list&category=${category}&page=${page}&p=${page}&JsHttpRequest=1-xml`;
    const upstream = await fetch(url, { headers, timeout: 12000 });
    const data = await upstream.json();

    const items = (data?.js?.data || []).map(v => ({
      id:    v.id,
      name:  v.name,
      logo:  v.screenshot_uri || v.cover || null,
      year:  v.year,
      rating: v.rating_imdb || v.rating || null,
      url:   v.cmd || null,
      group: v.category_id || "Other",
      type:  "vod",
    }));

    res.json({ items, total: data?.js?.total_items, page: data?.js?.cur_page });
  } catch (e) {
    console.error("VOD error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /stalker/stream?portal=...&mac=...&cmd=...
// Resolves a Stalker stream cmd to a playable URL
app.get("/stalker/stream", async (req, res) => {
  const { portal, mac, cmd } = req.query;
  if (!portal || !mac || !cmd) return res.status(400).json({ error: "portal, mac and cmd required" });

  try {
    const portalBase = normalizePortal(portal);
    const token      = await fetchToken(portalBase, mac);
    const base       = resolvedBase(portal, mac);
    const headers    = stalkerHeaders(mac, token);

    const url = `${base}server/load.php?type=itv&action=create_link&cmd=${encodeURIComponent(cmd)}&series=0&forced_storage=0&disable_ad=0&download=0&force_ch_link_check=0&JsHttpRequest=1-xml`;
    const upstream = await fetch(url, { headers, timeout: 10000 });
    const data = await upstream.json();

    const streamUrl = data?.js?.cmd;
    if (!streamUrl) throw new Error("No stream URL returned");

    // Strip "ffmpeg " prefix some portals add
    const cleanUrl = streamUrl.replace(/^ffmpeg\s+/, "").trim();
    res.json({ url: cleanUrl });
  } catch (e) {
    console.error("Stream resolve error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Stalker proxy running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
