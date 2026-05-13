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

  router.get("/api", async (req, res) => {
    const { portal, mac, serial, deviceId, deviceId2, ...apiParams } = req.query;
    if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const data = await portalFetchRetry(session, apiParams);
      res.json(data);
    } catch (e) {
      console.error("API error:", e.message);
      res.status(502).json({ error: safeError(e) });
    }
  });

  router.post("/validate", async (req, res) => {
    const { portal, mac, serial, deviceId, deviceId2 } = req.body;
    if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
    const start = Date.now();
    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 }, { forceRefresh: true });
      res.json({ valid: true, token: session.token, latency: Date.now() - start });
    } catch (e) {
      console.error("Validate error:", e.message);
      res.json({ valid: false, error: safeError(e), latency: Date.now() - start });
    }
  });

  router.get("/stream", async (req, res) => {
    const { portal, mac, cmd, content_type, serial, deviceId, deviceId2 } = req.query;
    if (!portal || !mac || !cmd) return res.status(400).json({ error: "portal, mac and cmd required" });
    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const data = await portalFetchRetry(session, {
        type: (content_type === "vod" || content_type === "series") ? "vod" : "itv",
        action: "create_link", cmd
      });
      const streamUrl = data?.js?.cmd;
      if (!streamUrl) throw new Error("No stream URL returned");
      const cleanUrl = streamUrl.replace(/^ffmpeg\s+/, "").trim();
      res.json({ url: cleanUrl });
    } catch (e) {
      console.error("Stream error:", e.message);
      res.status(502).json({ error: safeError(e) });
    }
  });

  router.get("/series/seasons", async (req, res) => {
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

  router.get("/series/categories", async (req, res) => {
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

  router.get("/series", async (req, res) => {
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

  router.get("/series/episode/stream", async (req, res) => {
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

  router.get("/series/:seriesId/seasons", async (req, res) => {
    const { portal, mac, serial, deviceId, deviceId2 } = req.query;
    const { seriesId } = req.params;
    if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
    if (!seriesId)       return res.status(400).json({ error: "seriesId required" });

    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
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

  router.get("/profile", async (req, res) => {
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

  router.get("/account", async (req, res) => {
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

  router.get("/", async (req, res) => {
    const { portal, mac, action, ...params } = req.query;
    if (!portal || !mac) return res.status(400).json({ error: "Portal and MAC required" });
    const start = Date.now();

    try {
      const session = await getSession(portal, mac);
      const data = await portalFetchRetry(session, { action, ...params });
      const duration = Date.now() - start;
      cache.trackRequest("stalker", 200, duration);
      res.json(data);
    } catch (e) {
      const duration = Date.now() - start;
      cache.trackRequest("stalker", 502, duration);
      res.status(502).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createStalkerRouter };