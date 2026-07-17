const express = require("express");
const { Transform } = require("stream");
const crypto = require('crypto');
const { decryptToken } = require('../middleware/encrypt');
const { createContentSessionStore } = require('../services/contentSessionStore');

const fallbackSessionStore = createContentSessionStore();
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const directPlayEnabled = () => process.env.STALKER_DIRECT_PLAY_ENABLED !== "false";
const contentSessionTtlMs = () => {
  const parsed = Number.parseInt(process.env.CONTENT_SESSION_TTL_MINUTES || '', 10);
  const minutes = Number.isFinite(parsed) ? Math.min(120, Math.max(5, parsed)) : 30;
  return minutes * 60_000;
};

function createStalkerRouter(deps) {
  const { cache, auth, fetch, isUrlAllowed, fetchWithRedirectCheck, getSession, portalFetchRetry, safeError, buildStalkerStreamHeaders, summarizeUpstreamHeaders } = deps;
  const sessionStore = deps.contentSessionStore || (deps.cache?.db && typeof deps.cache.db.exec === 'function' ? createContentSessionStore({ db: deps.cache.db }) : fallbackSessionStore);
  const router = express.Router();
  const STREAM_CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Range, Content-Type", "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type" };

  // Resolve stalker credentials from a content-session token or from direct query params.
  // When a contentToken is present, portal+mac are resolved server-side from the encrypted session.
  // When portal+mac are passed directly, they're only accepted if authenticated (not guest).
  function resolveStalkerCreds(req) {
    const contentToken = String(req.query.contentToken || req.body?.contentToken || '');
    const portal = req.body?.portal || req.query?.portal;
    const mac = req.body?.mac || req.query?.mac;
    if (contentToken) return { mode: 'content-session', contentToken, portal: null, mac: null };
    return { mode: 'direct', contentToken: null, portal: portal || null, mac: mac || null };
  }

  // Middleware: only allow stalker content-session requests or authenticated direct requests.
  async function requireStalkerAuth(req, res, next) {
    const creds = resolveStalkerCreds(req);
    req._stalkerCreds = creds;

    if (creds.mode === 'content-session') {
      try {
        const hash = tokenHash(creds.contentToken);
        const session = await sessionStore.findByTokenHash(hash);
        if (!session) return res.status(401).json({ error: 'Content session invalid', code: 'unauthorized' });
        if (session.expiresAt <= Date.now()) {
          await sessionStore.deleteByTokenHash(hash);
          return res.status(410).json({ error: 'Content session expired', code: 'expired' });
        }
        let connection;
        try { connection = JSON.parse(decryptToken(session.encryptedConnection)); }
        catch { return res.status(401).json({ error: 'Content session corrupted', code: 'unauthorized' }); }
        if (connection.type !== 'stalker') return res.status(400).json({ error: 'Connection is not a Stalker portal', code: 'invalid_connection' });
        req._stalkerConfig = connection.config;

        // Extend active sessions atomically near expiry. Deleting and recreating
        // the row here creates intermittent 401s under concurrent requests.
        const ttlMs = contentSessionTtlMs();
        const now = Date.now();
        if (session.expiresAt - now < ttlMs / 2 && typeof sessionStore.extendByTokenHash === 'function') {
          await sessionStore.extendByTokenHash(hash, now + ttlMs, now);
        }

        if (req.query && connection.config) {
          req.query.portal = connection.config.portal || connection.config.server;
          req.query.mac = connection.config.mac;
          if (connection.config.serial) req.query.serial = connection.config.serial;
          if (connection.config.deviceId) req.query.deviceId = connection.config.deviceId;
          if (connection.config.deviceId2) req.query.deviceId2 = connection.config.deviceId2;
        }
        return next();
      } catch (e) {
        if (e.code) return res.status(e.status || 500).json({ error: e.message, code: e.code });
        return res.status(502).json({ error: 'Failed to verify content session', code: 'server_failure' });
      }
    }

    // Unit consumers may omit auth. The real app always provides verifyToken.
    if (typeof auth?.verifyToken !== 'function') return next();
    const header = req.headers.authorization || '';
    const token = req.cookies?.sv_auth || (header.startsWith('Bearer ') ? header.slice(7) : null);
    const user = token ? auth.verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Authentication required', code: 'unauthorized' });
    req.user = user;
    return next();
  }
  function normalizeResolvedUrl(streamUrl, portal) {
    if (!streamUrl) return streamUrl;
    let cleanUrl = String(streamUrl).replace(/^ffmpeg\s+/, "").trim();
    if (cleanUrl.includes("localhost") || cleanUrl.includes("127.0.0.1")) {
      try {
        const portalHost = new URL(portal).host;
        cleanUrl = cleanUrl.replace(/localhost(:\d+)?/g, portalHost).replace(/127\.0\.0\.1(:\d+)?/g, portalHost);
      } catch {}
    }
    return cleanUrl;
  }

  function classifyStreamKind(streamUrl, contentType = "live") {
    const value = String(streamUrl || "").toLowerCase();
    const path = value.split("?")[0];
    const query = value.includes("?") ? value.slice(value.indexOf("?") + 1) : "";
    const params = new URLSearchParams(query);
    const extension = path.split("/").pop()?.split(".").pop() || "";
    if (path.endsWith(".m3u8")) return "hls";
    if (path.endsWith(".ts") || params.get("extension") === "ts") return "ts";
    if (["mp4", "mkv", "mpg", "mpeg", "avi", "mov", "webm", "mp3", "aac"].includes(extension)) return "file";
    if (params.get("extension") === "mp4") return "file";
    if (contentType === "live" || path.includes("/live/")) return "ts";
    if (contentType === "file" || contentType === "vod" || contentType === "series") return "file";
    return "unknown";
  }
  async function createStalkerLink(session, { cmd, contentType, episode, start, end }) {
    const requestLink = candidate => portalFetchRetry(session, {
      type: (contentType === "vod" || contentType === "series") ? "vod" : "itv",
      action: "create_link",
      cmd: candidate,
      series: episode || 0,
      forced_storage: 0,
      disable_ad: 0,
      download: 0,
      force_ch_link_check: 0,
      start,
      end,
    });

    const numericMedia = contentType === "vod"
      ? String(cmd || "").trim().match(/^\/media\/(\d+)\.[a-z0-9]+$/i)
      : null;

    // The numeric catalog ID is not necessarily the provider's storage ID.
    // Match MAG/STB behavior by loading the selected movie before create_link.
    if (numericMedia) {
      const movieId = numericMedia[1];
      const details = await portalFetchRetry(session, {
        type: "vod",
        action: "get_ordered_list",
        category: 0,
        movie_id: movieId,
        season_id: 0,
        episode_id: 0,
        force_ch_link_check: "",
        fav: 0,
        sortby: "added",
        hd: 0,
        not_ended: 0,
        page: 1,
        p: 1,
        from_ch_id: 0,
      });
      const detailItems = Array.isArray(details?.js?.data) ? details.js.data : [];
      const selected = detailItems.find(item => String(item.id) === movieId) || detailItems[0];
      if (selected?.cmd) {
        const selectedData = await requestLink(selected.cmd);
        if (selectedData?.js?.cmd) return selectedData;
      }
    }

    let data = await requestLink(cmd);
    const isVod = contentType === "vod" || contentType === "series";
    if (data?.js?.cmd || !isVod) return data;

    // Some MAG portals return catalog paths such as /media/123.mpg but only
    // accept the traditional ffmpeg-prefixed command in create_link.
    const normalized = String(cmd || "").trim();
    if (normalized && !/^ffmpeg\s+/i.test(normalized)) {
      data = await requestLink(`ffmpeg ${normalized}`);
    }
    return data;
  }

  router.post("/handshake", async (req, res) => {
    const { portal, mac, serial } = req.body;
    if (!portal || !mac) return res.status(400).end();
    try {
      const session = await getSession(portal, mac, { serial });
      res.json({ token: session.token });
    } catch (e) { res.status(502).json({ error: safeError(e) }); }
  });

  router.get("/channels", requireStalkerAuth, async (req, res) => {
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

  router.get("/vod/categories", requireStalkerAuth, async (req, res) => {
    const { portal, mac, serial } = req.query;
    try {
      const session = await getSession(portal, mac, { serial });
      const catData = await portalFetchRetry(session, { type: "vod", action: "get_categories" });
      res.json({ categories: (catData?.js || []).map(c => ({ id: String(c.id), title: c.title, count: parseInt(c.count || 0) })) });
    } catch (e) { res.status(502).json({ error: safeError(e) }); }
  });

  router.get("/vod", requireStalkerAuth, async (req, res) => {
    const { portal, mac, cat, serial } = req.query;
    try {
      const session = await getSession(portal, mac, { serial });
      const raw = await fetchAllPages(session, "vod", cat);
      res.json({
        items: raw.map(v => ({
          id: v.id,
          name: v.name,
          logo: v.screenshot_uri || v.cover || null,
          year: v.year,
          rating: v.rating_imdb || null,
          url: v.cmd || null,
          type: "vod",
        })),
        total: raw.length,
      });
    } catch (e) { res.status(502).json({ error: safeError(e) }); }
  });

  router.get("/play", requireStalkerAuth, async (req, res) => {
    const resolved = req._stalkerCreds || resolveStalkerCreds(req);
    const { portal, mac, serial, deviceId, deviceId2 } = resolved.mode === 'content-session' && req._stalkerConfig
      ? {
          portal: req._stalkerConfig.portal || req._stalkerConfig.server,
          mac: req._stalkerConfig.mac,
          serial: req._stalkerConfig.serial,
          deviceId: req._stalkerConfig.deviceId,
          deviceId2: req._stalkerConfig.deviceId2,
        }
      : { portal: resolved.portal, mac: resolved.mac, serial: req.query.serial, deviceId: req.query.deviceId, deviceId2: req.query.deviceId2 };
    if (!portal || !mac) return res.status(400).json({ error: 'portal and mac required', code: 'malformed' });

    const { cmd, content_type, episode, start, end } = req.query;
    const directEnabled = directPlayEnabled();

    const fallbackUrl = (() => {
      const params = new URLSearchParams({ cmd });
      if (content_type) params.set("content_type", content_type);
      if (episode) params.set("episode", episode);
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      if (resolved.mode === 'content-session') {
        params.set("contentToken", resolved.contentToken);
      } else {
        params.set("portal", portal);
        params.set("mac", mac);
        if (serial) params.set("serial", serial);
        if (deviceId) params.set("deviceId", deviceId);
        if (deviceId2) params.set("deviceId2", deviceId2);
      }
      return `/stalker/play?${params.toString()}`;
    })();

    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const data = await createStalkerLink(session, {
        cmd, contentType: content_type, episode, start, end,
      });
      const streamUrl = normalizeResolvedUrl(data?.js?.cmd, portal);
      if (!streamUrl) throw new Error("No URL");
      if (!(await isUrlAllowed(streamUrl))) return res.status(403).end();
      const streamKind = classifyStreamKind(streamUrl, content_type === "vod" || content_type === "series" ? "file" : "live");
      if (req.query.resolve === "1") {
        return res.json({ url: streamUrl, streamKind, direct: directEnabled, fallbackUrl, expiresAt: null });
      }

      const watchName = req.query.name || cmd || "Unknown";
      cache.trackWatch(watchName, content_type === "vod" ? "vod" : content_type === "series" ? "series" : "live");

      const fetchHeaders = buildStalkerStreamHeaders(session, req.headers);
      const controller = new AbortController();
      const abortUpstream = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", abortUpstream);
      const { response: upstream, url: upstreamUrl } = await fetchWithRedirectCheck(streamUrl, {
        headers: fetchHeaders,
        signal: controller.signal,
      });
      const upstreamSummary = summarizeUpstreamHeaders(upstream.headers);
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status).json({ error: `Stream server returned ${upstream.status}`, status: upstream.status, upstreamHeaders: upstreamSummary });
      }
      Object.entries(STREAM_CORS).forEach(([k, v]) => res.set(k, v));
      res.set("Accept-Ranges", "bytes");
      const ct = upstream.headers.get("content-type") || "";
      if (upstream.status === 206) {
        res.status(206);
        const cr = upstream.headers.get("content-range");
        if (cr) res.set("Content-Range", cr);
      }
      const isPlaylist = ct.includes("mpegurl") || ct.includes("m3u") || upstreamUrl.endsWith(".m3u8");
      if (isPlaylist) {
        const parsedStreamUrl = new URL(upstreamUrl);
        const playOrigin = parsedStreamUrl.origin;
        const playBaseDir = upstreamUrl.substring(0, upstreamUrl.lastIndexOf("/") + 1);
        const selfBase = `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host")}`;
        res.set("Content-Type", ct || "application/vnd.apple.mpegurl");
        let leftover = "";
        const rewriter = new Transform({
          transform(chunk, enc, cb) {
            const text = leftover + chunk.toString();
            const lines = text.split("\n");
            leftover = lines.pop();
            const rewritten = lines.map(line => {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("#")) return line;
              if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return `${selfBase}/stream?url=${encodeURIComponent(trimmed)}`;
              if (trimmed.startsWith("/")) return `${selfBase}/stream?url=${encodeURIComponent(playOrigin + trimmed)}`;
              return `${selfBase}/stream?url=${encodeURIComponent(playBaseDir + trimmed)}`;
            }).join("\n") + "\n";
            cb(null, rewritten);
          },
          flush(cb) {
            if (leftover.trim()) {
              const trimmed = leftover.trim();
              if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) cb(null, `${selfBase}/stream?url=${encodeURIComponent(trimmed)}`);
              else if (trimmed.startsWith("/")) cb(null, `${selfBase}/stream?url=${encodeURIComponent(playOrigin + trimmed)}`);
              else if (!trimmed.startsWith("#")) cb(null, `${selfBase}/stream?url=${encodeURIComponent(playBaseDir + trimmed)}`);
              else cb(null, leftover);
            } else {
              cb();
            }
          }
        });
        upstream.body.pipe(rewriter).pipe(res);
      } else {
        if (ct) res.set("Content-Type", ct);
        const cl = upstream.headers.get("content-length");
        if (cl) res.set("Content-Length", cl);
        upstream.body.pipe(res);
      }
    } catch (e) {
      if (res.headersSent || res.destroyed) return;
      if (/authorization|auth failed|device not found|access denied/i.test(e.message || '')) return res.status(403).json({ error: safeError(e), code: 'authorization_failure' });
      if (/rate limit|too many request/i.test(e.message || '')) return res.status(429).json({ error: safeError(e), code: 'rate_limited' });
      if (/expired|invalid token/i.test(e.message || '')) return res.status(410).json({ error: safeError(e), code: 'expired' });
      res.status(502).json({ error: safeError(e), code: 'server_failure' });
    }
  });

  router.get("/epg", requireStalkerAuth, async (req, res) => {
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

  router.get("/api", requireStalkerAuth, async (req, res) => {
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

    function parseExpiryDate(expiryStr) {
      if (!expiryStr || expiryStr === "0000-00-00" || expiryStr === "0000-00-00 00:00:00") return null;
      let expDate = null;
      const m1 = expiryStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m1) expDate = new Date(parseInt(m1[1]), parseInt(m1[2]) - 1, parseInt(m1[3]));
      if (!expDate) {
        const m2 = expiryStr.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        if (m2) expDate = new Date(parseInt(m2[3]), parseInt(m2[1]) - 1, parseInt(m2[2]));
      }
      if (!expDate) expDate = new Date(expiryStr);
      return expDate && !isNaN(expDate.getTime()) ? expDate : null;
    }

    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 }, { forceRefresh: true });
      result.portalReachable = true;

      try {
        const profileParams = {
          type: "stb",
          action: "get_profile",
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

      try {
        const account = await portalFetchRetry(session, { type: "account_info", action: "get_main_info" });
        const a = account?.js || {};
        const statusVal = a.status !== undefined ? parseFloat(a.status) : 0;
        if (statusVal === 0) result.status = "active";
        else if (statusVal === 1) result.status = "unregistered";
        else if (statusVal === 2) result.status = "suspended";
        else if (statusVal === 3) result.status = "expired";
        else if (statusVal === 4) result.status = "blocked";
        else result.status = `status:${statusVal}`;
        result.statusCode = statusVal;

        const expiryStr = a.expire_billing_date || a.expired_date || a.expire_date || null;
        const expDate = parseExpiryDate(expiryStr);
        if (expDate) {
          result.expiry = expDate.toISOString().slice(0, 10);
          result.daysLeft = Math.ceil((expDate.getTime() - Date.now()) / 86400000);
          if (result.daysLeft < 0) result.status = "expired";
        }

        result.tariff = a.tariff_plan || a.tariff || null;
        result.phone = a.phone || null;
        result.maxConnections = a.max_cur || a.max_connections || null;

        if (Object.keys(a).length === 0) {
          result.status = "blocked";
          result.error = "Account returned empty info - may be blocked";
        }

        const hasValidId = a.id || a.login || a.user_id || a.account_number || a.mac;
        if (!hasValidId && result.status === "active") {
          result.status = "unregistered";
          result.valid = false;
          result.error = "No valid user ID found - MAC may not be registered";
        }
      } catch (e) {
        result.error = "Could not fetch account info: " + e.message;
      }

      result.valid = (result.status === "active" && (result.daysLeft === null || result.daysLeft > 0));
      result.token = session.token;
      result.latency = Date.now() - start;
      res.json(result);
    } catch (e) {
      console.error("Validate error:", e.message);
      result.error = safeError(e);
      result.latency = Date.now() - start;
      res.json(result);
    }
  });

  router.get("/stream", requireStalkerAuth, async (req, res) => {
    const { portal, mac, cmd, content_type, serial, deviceId, deviceId2 } = req.query;
    if (!portal || !mac || !cmd) return res.status(400).json({ error: "portal, mac and cmd required" });
    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const data = await portalFetchRetry(session, {
        type: (content_type === "vod" || content_type === "series") ? "vod" : "itv",
        action: "create_link",
        cmd,
        series: 0,
        forced_storage: 0,
        disable_ad: 0,
        download: 0,
        force_ch_link_check: 0,
      });
      const streamUrl = normalizeResolvedUrl(data?.js?.cmd, portal);
      if (!streamUrl) throw new Error("No stream URL returned");
      res.json({ url: streamUrl });
    } catch (e) {
      console.error("Stream error:", e.message);
      res.status(502).json({ error: safeError(e) });
    }
  });

  router.get("/series/seasons", requireStalkerAuth, async (req, res) => {
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

  router.get("/series/categories", requireStalkerAuth, async (req, res) => {
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

  router.get("/series", requireStalkerAuth, async (req, res) => {
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

  router.get("/series/episode/stream", requireStalkerAuth, async (req, res) => {
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

  router.get("/series/:seriesId/seasons", requireStalkerAuth, async (req, res) => {
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

  router.get("/profile", requireStalkerAuth, async (req, res) => {
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
