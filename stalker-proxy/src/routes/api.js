const express = require("express");
const { Transform } = require("stream");

function createApiRouter(deps) {
  const { cache, auth, fetch, isUrlAllowed, fetchWithRedirectCheck, transferTimeout, summarizeUpstreamHeaders, safeError, agentFor, getSession } = deps;
  const router = express.Router();
  const TMDB_KEY = process.env.TMDB_API_KEY || "";
  const ADMIN_PASS = process.env.ADMIN_PASS;

  function isEmptyConnectionSnapshot(data, count) {
    if (count === 0 || (Array.isArray(data) && data.length === 0) || data === "[]") return true;
    if (typeof data !== "string") return false;
    // AES-GCM encryption of "[]" is always a 12-byte IV plus an 18-byte
    // ciphertext/tag, encoded by the frontend as 16 base64 chars + "." + 24.
    return /^[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{24}$/.test(data);
  }

  function safeCompare(a, b) {
    if (!a || !b) return false;
    const crypto = require("crypto");
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  router.post("/diagnose", async (req, res) => {
    const { type, server, portal, mac, user, pass, url: m3uUrl } = req.body;
    const result = { latency: null, reachable: false, details: {} };
    try {
      if (type === "stalker" && portal) {
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
            result.reachable = e.message?.startsWith("Portal") || false;
            result.details.status = result.reachable ? "portal error" : "unreachable";
          }
        } else { result.details.status = "MAC required"; }
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
              const ui = data?.user_info;
              const status = String(ui?.status ?? "").trim().toLowerCase();
              const disabled = ["disabled", "expired", "blocked", "suspended", "0"].includes(status);
              result.valid = ui?.auth === 1 && !disabled;
              result.details.auth = ui?.auth === 1 ? "ok" : "failed";
              result.details.status = ui?.status || "unknown";
              result.details.maxCons = ui?.max_connections ?? "unknown";
              result.details.activeConns = ui?.active_cons ?? "unknown";
              if (!result.valid) result.details.error = disabled ? "Account disabled or expired" : "Authentication failed";
            } catch { result.valid = false; result.details.parse = "non-JSON"; }
          }
        } else { result.details.status = "unreachable"; }
      } else if (type === "m3u" && m3uUrl) {
        const start = Date.now();
        const fetched = await fetchWithRedirectCheck(m3uUrl, { timeout: 8000, agent: agentFor(m3uUrl) }).catch(() => null);
        const r = fetched?.response;
        result.latency = Date.now() - start;
        result.reachable = r?.ok || false;
        result.details.status = r?.status || "unreachable";
      }
    } catch (e) { result.details.error = e.message?.slice(0, 100); }
    res.json(result);
  });

  router.post("/track", express.json(), (req, res) => {
    const { name, type, guestId, event } = req.body;
    if (event === "play" && name) cache.trackWatch(name, type);
    if (guestId && event === "connect") cache.trackGuestActivity(guestId, "connections");
    if (guestId && event === "favorite") cache.trackGuestActivity(guestId, "favorites");
    if (guestId && event === "history") cache.trackGuestActivity(guestId, "history");
    res.json({ ok: true });
  });

  router.post("/playback/heartbeat", express.json(), (req, res) => {
    const payload = req.body;
    let userId = null;
    const token = req.cookies?.sv_auth || (req.headers.authorization ? req.headers.authorization.slice(7) : null);
    if (token) { try { const user = auth.verifyToken(token); if (user) userId = user.id; } catch {} }
    if (!userId && !payload.guest_id) return res.status(400).json({ error: "Missing ID" });
    cache.trackPlaybackHeartbeat({ ...payload, user_id: userId });
    res.json({ ok: true });
  });

  router.get("/playback/summary", (req, res) => {
    let userId = null;
    const token = req.cookies?.sv_auth || (req.headers.authorization ? req.headers.authorization.slice(7) : null);
    if (token) { try { const user = auth.verifyToken(token); if (user) userId = user.id; } catch {} }
    const guestId = req.query.guest_id;
    if (!userId && !guestId) return res.status(401).json({ error: "Unauthorized" });
    res.json({ data: cache.getPlaybackSummary(userId, guestId, req.query.range || "today") });
  });

  router.post("/feedback", express.json(), (req, res) => {
    const { message, guestId, userAgent } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: "Required" });
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    cache.saveFeedback(message.trim(), guestId, userAgent, ip);
    res.json({ ok: true });
  });

  router.get("/feedback", (req, res) => {
    if (!ADMIN_PASS) return res.status(503).json({ error: "Not configured" });
    if (!safeCompare(req.headers["x-admin-token"], ADMIN_PASS)) return res.status(401).json({ error: "Unauthorized" });
    res.json({ feedback: cache.getFeedback() });
  });

  router.get("/vast", async (req, res) => {
    const { url } = req.query;
    if (!url || !(await isUrlAllowed(url))) return res.status(400).end();
    try {
      const { response: upstream } = await fetchWithRedirectCheck(url, { timeout: 5000, headers: { "Accept": "application/xml", "User-Agent": "StreamVault/1.0" } });
      if (!upstream.ok) return res.status(upstream.status).end();
      res.set("Content-Type", upstream.headers.get("content-type") || "application/xml");
      res.send(await upstream.text());
    } catch { res.status(502).end(); }
  });

  const syncId = (req) => req.user ? `user:${req.user.id}` : req.headers["x-guest-id"] ? `guest:${req.headers["x-guest-id"]}` : null;

  router.put("/sync/:type", auth.optionalAuth, (req, res) => {
    const { type } = req.params;
    const sid = syncId(req);
    if (!sid || !["favorites","history","connections"].includes(type)) return res.status(400).end();
    if (type === "connections" && isEmptyConnectionSnapshot(req.body.data, req.body.count)) {
      const confirmed = req.body.allowEmpty === true && req.body.reason === "user_removed_last_connection";
      if (!confirmed) {
        return res.status(409).json({
          error: "Empty connection snapshot rejected",
          code: "empty_connections_rejected",
        });
      }
    }
    cache.saveGuestData(sid, type === "connections" ? "_all" : req.body.connId, type, req.body.data);
    res.json({ ok: true });
  });

  router.get("/sync/:type", auth.optionalAuth, (req, res) => {
    const sid = syncId(req);
    if (!sid) return res.status(400).end();
    res.json({ data: cache.getGuestData(sid, req.params.type === "connections" ? "_all" : req.query.connId, req.params.type) });
  });

  router.post("/sync/migrate-guest", auth.requireAuth, (req, res) => {
    const { guestId } = req.body;
    if (!guestId || req.headers["x-guest-id"] !== guestId) return res.status(403).end();
    // Connection ciphertext is bound to the guest encryption key and cannot
    // be copied into a registered account. The frontend decrypts and re-saves
    // those connections using the authenticated user's key.
    const rows = cache.db.prepare("SELECT conn_id, type, data FROM guest_data WHERE guest_id = ? AND type != 'connections'").all(`guest:${guestId}`);
    for (const row of rows) {
      if (!cache.getGuestData(`user:${req.user.id}`, row.conn_id, row.type)) {
        cache.saveGuestData(`user:${req.user.id}`, row.conn_id, row.type, JSON.parse(row.data));
      }
    }
    res.json({ migrated: rows.length });
  });

  router.delete("/sync", auth.optionalAuth, (req, res) => {
    const sid = syncId(req);
    if (!sid || !req.query.connId) return res.status(400).end();
    cache.deleteGuestData(sid, req.query.connId);
    res.json({ ok: true });
  });

  router.delete("/cache", auth.optionalAuth, (req, res) => {
    if (!syncId(req)) return res.status(401).end();
    if (req.query.connId) cache.deleteByPrefix(req.query.connId);
    res.json({ ok: true });
  });

  router.get("/tmdb/*", async (req, res) => {
    if (!TMDB_KEY) return res.status(503).json({ error: "Server TMDB key not configured" });
    const qs = new URLSearchParams(req.query);
    qs.set("api_key", TMDB_KEY);
    try {
      const r = await fetch(`https://api.themoviedb.org/3/${req.params[0]}?${qs}`);
      res.json(await r.json());
    } catch { res.status(502).json({ error: "Failed to connect to TMDB" }); }
  });

  return router;
}

module.exports = { createApiRouter };
