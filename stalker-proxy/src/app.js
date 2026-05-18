const express = require("express");
const cors = require("cors");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const passport = require("passport");
const path = require("path");

const { createProxyHelpers } = require("./utils/proxyHelpers");

function createApp(deps) {
  const { cache, auth, fetch, system, email } = deps;
  const app = express();

  const helpers = createProxyHelpers({ fetch });
  const { 
    transferTimeout, agentFor, isUrlAllowed, 
    summarizeUpstreamHeaders, buildStalkerStreamHeaders, safeError, 
    getSession, portalFetchRetry 
  } = helpers;

  if (process.env.TRUST_PROXY !== "false") app.set("trust proxy", 1);

  app.use(cookieParser());

  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
  const allowedOrigins = ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(",").map(s => s.trim()) : false;
  app.use(cors({
    origin: allowedOrigins || false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  }));

  app.use(passport.initialize());

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://challenges.cloudflare.com", "https://cdn.jsdelivr.net", "https://www.googletagmanager.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://cdn.jsdelivr.net", "https://www.google-analytics.com"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        scriptSrcAttr: ["'unsafe-inline'"],
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }));

  // Rate limiting
  const apiLimit = rateLimit({ windowMs: 60000, max: 60, message: { error: "Too many requests" } });
  const stalkerLimit = rateLimit({ windowMs: 60000, max: 600, message: { error: "Too many requests" } });

  app.use("/api/sync", express.json({ limit: "5mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(compression());

  // Global Tracking Middleware
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
            try { const user = auth.verifyToken(token); if (user) role = user.role; } catch {}
          }
          cache.trackGuest(guestId, ip, role);
        }
      }
    });

    if (p.startsWith("/stalker/") && req.query.portal && req.query.mac) {
      const type = p.includes("/vod") ? "vod" : p.includes("/series") ? "series" : p.includes("/epg") ? "epg" : "live";
      cache.trackPortal(req.query.portal, req.query.mac, type);
    }
    next();
  });

  app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

  // SSRF Protection for Stalker
  const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
  app.use("/stalker", async (req, res, next) => {
    const portal = req.body?.portal || req.query?.portal;
    const mac = req.body?.mac || req.query?.mac;
    if (portal && !(await isUrlAllowed(portal))) return res.status(403).json({ error: "Portal URL not allowed" });
    if (mac && !MAC_RE.test(mac)) return res.status(400).json({ error: "Invalid MAC format" });
    next();
  });

  // ── MOUNT MODULAR ROUTES ──

  const { createAuthRouter } = require("./routes/auth");
  const { createSSORouter } = require("./routes/sso");
  const { createAnalyticsRouter } = require("./routes/analytics");
  const { createApiRouter } = require("./routes/api");
  const { createStalkerRouter } = require("./routes/stalker");

  const routerDeps = { cache, auth, fetch, system, email, isUrlAllowed, transferTimeout, summarizeUpstreamHeaders, buildStalkerStreamHeaders, safeError, getSession, portalFetchRetry, agentFor };

  app.use("/api", apiLimit);
  app.use("/api", createAuthRouter(routerDeps));
  app.use("/api", createSSORouter(routerDeps));
  app.use("/stalker", stalkerLimit, createStalkerRouter(routerDeps));
  app.use("/api", createApiRouter(routerDeps));
  app.use("/", createAnalyticsRouter(routerDeps));

  // ── MEDIA PROXY ROUTES (Legacy support or shared) ──
  // These could also be moved into api.js if desired.

  app.get("/stream", async (req, res) => {
    const { url } = req.query;
    if (!url || !(await isUrlAllowed(url))) return res.status(400).end();
    try {
      const headers = { "User-Agent": req.headers["user-agent"] || "StreamVault/1.0" };
      if (req.headers.range) headers["Range"] = req.headers.range;
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      const upstream = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
      
      const STREAM_CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Range, Content-Type", "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type" };
      Object.entries(STREAM_CORS).forEach(([k, v]) => res.set(k, v));
      
      res.set("Accept-Ranges", "bytes");
      if (upstream.status === 206) {
        res.status(206);
        const cr = upstream.headers.get("content-range");
        if (cr) res.set("Content-Range", cr);
      } else if (!upstream.ok) {
        return res.status(upstream.status).end();
      }

      const cl = upstream.headers.get("content-length");
      if (cl) res.set("Content-Length", cl);
      
      const ct = upstream.headers.get("content-type") || "";
      if (ct.includes("mpegurl") || ct.includes("m3u") || url.endsWith(".m3u8")) {
        const { Transform } = require("stream");
        const baseDir = url.substring(0, url.lastIndexOf("/") + 1);
        const selfBase = `${req.protocol}://${req.get("host")}`;
        let leftover = "";
        const rewriter = new Transform({
          transform(chunk, enc, cb) {
            const text = leftover + chunk.toString();
            const lines = text.split("\n");
            leftover = lines.pop();
            const rewritten = lines.map(line => {
              const t = line.trim();
              if (!t || t.startsWith("#")) return line;
              const abs = t.startsWith("http") ? t : baseDir + t;
              return `${selfBase}/stream?url=${encodeURIComponent(abs)}`;
            }).join("\n") + "\n";
            cb(null, rewritten);
          },
          flush(cb) { cb(null, leftover); }
        });
        upstream.body.pipe(rewriter).pipe(res);
      } else {
        upstream.body.pipe(res);
      }
    } catch { res.status(502).end(); }
  });

  app.get("/img", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).end();
    if (!(await isUrlAllowed(url))) return res.status(403).end();
    try {
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      const upstream = await fetch(url, { timeout: 10000, signal: controller.signal });
      if (!upstream || !upstream.ok) return res.status(upstream?.status || 502).end();
      res.set("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
      res.set("Cache-Control", "public, max-age=86400");
      upstream.body.pipe(res);
    } catch { res.status(502).end(); }
  });

  app.get("/proxy", async (req, res) => {
    const { url } = req.query;
    if (!url || !(await isUrlAllowed(url))) return res.status(400).end();
    try {
      const tt = transferTimeout(60000);
      req.on("close", () => tt.abort());
      const r = await fetch(url, { timeout: 60000, signal: tt.signal });
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("json")) res.json(await r.json());
      else { res.set("Content-Type", ct || "text/plain"); r.body.pipe(res); }
    } catch { res.status(502).end(); }
  });

  return app;
}

module.exports = { createApp };
