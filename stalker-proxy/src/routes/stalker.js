const express = require("express");
const { Transform } = require("stream");

function createStalkerRouter(deps) {
  const { cache, auth, fetch, isUrlAllowed, getSession, portalFetchRetry, safeError, buildStalkerStreamHeaders, summarizeUpstreamHeaders } = deps;
  const router = express.Router();
  const STREAM_CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Range, Content-Type", "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type" };

  router.post("/handshake", async (req, res) => {
    const { portal, mac, serial } = req.body;
    if (!portal || !mac) return res.status(400).end();
    try {
      const session = await getSession(portal, mac, { serial });
      res.json({ token: session.token });
    } catch (e) { res.status(502).json({ error: safeError(e) }); }
  });

  router.get("/channels", async (req, res) => {
    const { portal, mac, refresh, serial } = req.query;
    if (!portal || !mac) return res.status(400).end();
    const ck = `portal-channels:${portal}`;
    if (!refresh) { const cached = cache.get(ck); if (cached) return res.json(cached); }
    try {
      const session = await getSession(portal, mac, { serial });
      const genreData = await portalFetchRetry(session, { type: "itv", action: "get_genres" });
      const chData = await portalFetchRetry(session, { type: "itv", action: "get_all_channels" });
      const genres = genreData?.js || [];
      const genreMap = Object.fromEntries(genres.map(g => [g.id, g.title]));
      const channels = (chData?.js?.data || []).map(ch => ({
        id: ch.id, name: ch.name, num: ch.number, logo: ch.logo || ch.icon || null,
        group: genreMap[ch.tv_genre_id] || "Other", url: ch.cmd || null, epgId: ch.xmltv_id || null, type: "live"
      }));
      const data = { channels, total: channels.length, refreshed_at: Date.now() };
      cache.set(ck, data, 86400000);
      res.json(data);
    } catch (e) { res.status(502).json({ error: safeError(e) }); }
  });

  async function fetchAllPages(session, type, category, maxItems = 500) {
    let data;
    try { data = await portalFetchRetry(session, { type, action: "get_ordered_list", category, page: 1, p: 1 }); } catch { return []; }
    const items = data?.js?.data || [];
    if (!items.length) return [];
    const all = [...items];
    const totalPages = parseInt(data.js.total_pages || 1);
    for (let p = 2; p <= totalPages && all.length < maxItems; p++) {
      const r = await portalFetchRetry(session, { type, action: "get_ordered_list", category, page: p, p }).catch(() => null);
      if (r?.js?.data) all.push(...r.js.data);
    }
    return all.slice(0, maxItems);
  }

  router.get("/vod/categories", async (req, res) => {
    const { portal, mac, serial } = req.query;
    try {
      const session = await getSession(portal, mac, { serial });
      const catData = await portalFetchRetry(session, { type: "vod", action: "get_categories" });
      res.json({ categories: (catData?.js || []).map(c => ({ id: String(c.id), title: c.title, count: parseInt(c.count || 0) })) });
    } catch (e) { res.status(502).json({ error: safeError(e) }); }
  });

  router.get("/vod", async (req, res) => {
    const { portal, mac, cat, serial } = req.query;
    try {
      const session = await getSession(portal, mac, { serial });
      const raw = await fetchAllPages(session, "vod", cat);
      res.json({ items: raw.map(v => ({ id: v.id, name: v.name, logo: v.screenshot_uri || v.cover || null, year: v.year, rating: v.rating_imdb || null, type: "vod" })), total: raw.length });
    } catch (e) { res.status(502).json({ error: safeError(e) }); }
  });

  router.get("/play", async (req, res) => {
    const { portal, mac, cmd, content_type, start, end, serial } = req.query;
    try {
      const session = await getSession(portal, mac, { serial });
      const data = await portalFetchRetry(session, { type: (content_type === "vod" || content_type === "series") ? "vod" : "itv", action: "create_link", cmd, start, end });
      const streamUrl = data?.js?.cmd?.replace(/^ffmpeg\s+/, "").trim();
      if (!streamUrl) throw new Error("No URL");
      if (!(await isUrlAllowed(streamUrl))) return res.status(403).end();
      if (req.query.resolve === "1") return res.json({ url: streamUrl });
      
      const fetchHeaders = buildStalkerStreamHeaders(session, req.headers);
      const upstream = await fetch(streamUrl, { headers: fetchHeaders, redirect: "follow" });
      Object.entries(STREAM_CORS).forEach(([k, v]) => res.set(k, v));
      upstream.body.pipe(res);
    } catch (e) { res.status(502).json({ error: safeError(e) }); }
  });

  router.get("/epg", async (req, res) => {
    const { portal, mac, period = 4, serial } = req.query;
    try {
      const session = await getSession(portal, mac, { serial });
      const data = await portalFetchRetry(session, { type: "itv", action: "get_epg_info", period });
      const programs = {};
      for (const [id, shows] of Object.entries(data?.js?.data || {})) {
        if (Array.isArray(shows)) programs[id] = shows.map(s => ({ title: s.name || s.title, start: (s.start_timestamp || 0) * 1000, stop: (s.stop_timestamp || 0) * 1000 }));
      }
      res.json({ programs, refreshed_at: Date.now() });
    } catch (e) { res.status(502).json({ error: safeError(e) }); }
  });

  return router;
}

module.exports = { createStalkerRouter };