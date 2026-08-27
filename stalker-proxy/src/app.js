const express = require("express");
const cors = require("cors");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const passport = require("passport");
const path = require("path");

const { createProxyHelpers } = require("./utils/proxyHelpers");
const { createOperationalMetrics } = require("./services/operationalMetrics");

function createApp(deps) {
  const { cache, auth, fetch, system, email, pool } = deps;
  const app = express();
  const operationalMetrics = createOperationalMetrics();

  const helpers = createProxyHelpers({ fetch, isUrlAllowed: deps.isUrlAllowed });
  const { 
    transferTimeout, agentFor, isUrlAllowed, fetchWithRedirectCheck, 
    summarizeUpstreamHeaders, buildStalkerStreamHeaders, safeError, 
    getSession, portalFetchRetry, portalFetchChannelCatalog, portalFetchChannelCatalogPage
  } = helpers;

  if (process.env.TRUST_PROXY !== "false") app.set("trust proxy", 1);

  app.use(cookieParser());

  const validateCors = cors({ origin: "*", methods: ["GET", "OPTIONS"], maxAge: 600 });
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
  const allowedOrigins = ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(",").map(s => s.trim()) : false;
  app.use((req, res, next) => {
    if (req.path === "/api/validate-token") return validateCors(req, res, next);
    if (allowedOrigins) {
      cors({ origin: allowedOrigins, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] })(req, res, next);
    } else {
      cors({ origin: false })(req, res, next);
    }
  });

  app.use(passport.initialize());

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://challenges.cloudflare.com", "https://cdn.jsdelivr.net", "https://www.googletagmanager.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        mediaSrc: ["*", "blob:"],
        connectSrc: ["'self'", "https:", "https://cdn.jsdelivr.net", "https://www.google-analytics.com", "https://portalheaven.stream"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        scriptSrcAttr: ["'unsafe-inline'"],
      },
      upgradeInsecureRequests: null,
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    strictTransportSecurity: false,
  }));

  // Rate limiting
  const apiLimit = rateLimit({ windowMs: 60000, max: 60, message: { error: "Too many requests" } });
  const stalkerLimit = rateLimit({ windowMs: 60000, max: 600, message: { error: "Too many requests" } });

  // Mount Stripe Webhook with raw body parser BEFORE global express.json
  const { createStripeWebhookRouter } = require("./routes/stripeWebhook");
  const { createStripeEventProcessor } = require("./services/stripeEventProcessor");
  const { createBillingCatalog } = require("./services/billingCatalog");
  const { createStripeGateway } = require("./services/stripeGateway");

  const billingCatalog = deps.billingCatalog || createBillingCatalog();
  const billingStore = deps.store || (auth?.getBillingStore ? auth.getBillingStore() : null);
  const entitlementService = deps.entitlementService || (auth?.getEntitlementService ? auth.getEntitlementService() : null);

  const stripeGateway = deps.stripeGateway || (billingCatalog?.enabled && deps.stripe ? createStripeGateway({
    stripe: deps.stripe,
    catalog: billingCatalog,
    appUrl: billingCatalog.appUrl,
  }) : null);

  const stripeEventProcessor = deps.stripeEventProcessor || (billingStore && entitlementService ? createStripeEventProcessor({
    store: billingStore,
    entitlementService,
    catalog: billingCatalog,
    stripeGateway,
  }) : null);

  if (stripeEventProcessor) {
    app.use("/api/billing/webhook", createStripeWebhookRouter({
      stripe: deps.stripe,
      processor: stripeEventProcessor,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    }));
  }

  app.use("/api/sync", express.json({ limit: "5mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(compression());

  // Global Tracking Middleware
  app.use((req, res, next) => {
    const p = req.path;
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const start = Date.now();
    const shouldTrack = p !== "/health" && p !== "/analytics" && p !== "/api/analytics";
    let type = "other";
    if (p.startsWith("/stalker/")) type = "stalker";
    else if (p === "/stream") type = "stream";
    else if (p === "/proxy") type = "proxy";
    const route = p.startsWith("/stalker/")
      ? p.slice("/stalker/".length).split("/")[0] || "root"
      : type;
    let operationalFinished = false;
    if (shouldTrack) operationalMetrics.begin();
    const finishOperational = status => {
      if (!shouldTrack || operationalFinished) return;
      operationalFinished = true;
      operationalMetrics.finish(type, status, Date.now() - start, route);
    };

    res.on("finish", () => {
      const duration = Date.now() - start;
      finishOperational(res.statusCode);
      if (shouldTrack) {
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
    res.on("close", () => {
      if (!res.writableEnded) finishOperational(499);
    });

    if (p.startsWith("/stalker/") && req.query.portal && req.query.mac) {
      const type = p.includes("/vod") ? "vod" : p.includes("/series") ? "series" : p.includes("/epg") ? "epg" : "live";
      cache.trackPortal(req.query.portal, req.query.mac, type);
    }
    next();
  });

  app.get("/health", (req, res) => res.json({
    status: "ok",
    uptime: process.uptime(),
    requests: operationalMetrics.snapshot(),
    memory: { rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
  }));

  // SSRF Protection for Stalker
  const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
  app.use("/stalker", async (req, res, next) => {
    const portal = req.body?.portal || req.query?.portal;
    const mac = req.body?.mac || req.query?.mac;
    if (portal && !(await isUrlAllowed(portal))) return res.status(403).json({ error: "Portal URL not allowed", code: "url_not_allowed" });
    if (mac && !MAC_RE.test(mac)) return res.status(400).json({ error: "Invalid MAC format" });
    next();
  });

  // -- MOUNT MODULAR ROUTES --

  const { createAuthRouter } = require("./routes/auth");
  const { createSSORouter } = require("./routes/sso");
  const { createSyncRouter } = require("./routes/sync");
  const { createAnalyticsRouter } = require("./routes/analytics");
  const { createApiRouter } = require("./routes/api");
  const { createStalkerRouter } = require("./routes/stalker");
  const { createContentSessionRouter } = require("./routes/contentSession");
  const { createPlayerRouter } = require("./routes/player");
  const { createAccountConnectionsRouter } = require("./routes/accountConnections");
  const { createConnectionAccessService } = require("./services/connectionAccessService");

  const connectionAccessService = deps.connectionAccessService || (billingStore && entitlementService ? createConnectionAccessService({
    store: billingStore,
    entitlementService,
    identityHmacKey: process.env.CONNECTION_IDENTITY_HMAC_KEY || process.env.TOKEN_MASTER_KEY || "",
  }) : null);

  const routerDeps = { cache, auth, fetch, system, email, pool, contentSessionStore: deps.contentSessionStore, connectionAccessService, isUrlAllowed: deps.isUrlAllowed || isUrlAllowed, fetchWithRedirectCheck, transferTimeout, summarizeUpstreamHeaders, buildStalkerStreamHeaders, safeError, getSession, portalFetchRetry, portalFetchChannelCatalog, portalFetchChannelCatalogPage, agentFor };

  app.use("/api", apiLimit);
  app.use("/api", createAuthRouter(routerDeps));
  app.use("/api", createSSORouter(routerDeps));
  if (pool) app.use("/api", createSyncRouter(pool));
  app.use("/stalker", stalkerLimit, createStalkerRouter(routerDeps));
  app.use("/api", createApiRouter(routerDeps));
  app.use("/", createAnalyticsRouter(routerDeps));
  if (connectionAccessService) {
    app.use("/api/account/connections", createAccountConnectionsRouter({ auth, connectionAccessService }));
  }
  app.use("/api", createContentSessionRouter(routerDeps));
  app.use("/api", createPlayerRouter(routerDeps));

  // -- TOKEN-GATED PLAYER PAGE --
  app.get("/player", (req, res) => {
    res.set("Content-Type", "text/html; charset=utf-8");
    // Permissive CSP — stream URLs are HTTP, hls.js uses blob: for MSE
    res.set("Content-Security-Policy", "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Play - StreamVault</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script src="https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body,#player{width:100%;height:100%;background:#000;overflow:hidden}
#player{display:block;object-fit:contain}
#error{display:none;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-family:sans-serif;text-align:center;font-size:14px;line-height:1.6;padding:20px}
#loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#888;font-family:sans-serif;font-size:13px}
</style>
</head>
<body>
<div id="loading">Loading player…</div>
<div id="error"></div>
<video id="player" autoplay controls playsinline></video>
<script>
(function(){
  var p=document.getElementById('player');
  var e=document.getElementById('error');
  var l=document.getElementById('loading');

  var playbackId=null;
  var streamType='direct';
  var hlsInstance=null;
  var mpegtsInstance=null;
  var refreshPending=false;

  function showError(title, body){
    l.style.display='none';
    e.style.display='block';
    e.innerHTML='<strong>'+escapeHtml(title||'Playback Error')+'</strong><br>'+escapeHtml(body||'Playback failed');
  }

  function escapeHtml(value){
    return String(value).replace(/[&<>"']/g,function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
    });
  }

  function getToken(){
    var m=location.search.match(/[?&]token=([^&]+)/);
    return m?decodeURIComponent(m[1]):null;
  }

  function destroyPlayers(){
    if(hlsInstance){hlsInstance.destroy();hlsInstance=null}
    if(mpegtsInstance){mpegtsInstance.destroy();mpegtsInstance=null}
    p.removeAttribute('src');
    try{p.load()}catch(_err){}
  }

  function statusMessage(code, fallback){
    if(code===404)return ['Stream Not Found (404)','The stream URL returned 404. The channel may be offline, or its URL may have changed.'];
    if(code===401||code===403)return ['Access Denied ('+code+')','The stream server rejected the request. Your IP may be blocked or your credentials lack access.'];
    if(code===429)return ['Rate Limited (429)','Too many requests to the provider. Please wait a minute before trying again.'];
    if(code===456)return ['Account Blocked (456)',"The provider rejected the stream. Your account may be expired, in use elsewhere, or your IP is blocked by the provider's firewall."];
    if(code===459||code===462)return ['Token Expired ('+code+')','The stream token has expired or was rejected. Click play again to get a fresh token.'];
    if(code>=500)return ['Server Error ('+code+')','The stream server returned an error. It may be overloaded or temporarily down.'];
    return ['Playback Error',fallback||'Playback failed'];
  }

  p.onerror=function(){
    if(hlsInstance||mpegtsInstance)return;
    var code=p.error&&p.error.code;
    var msgs={1:'Playback aborted',2:'Network error - could not load stream',3:'Decode error - stream format not supported',4:'Source not supported - the stream format or URL is invalid'};
    showError('Playback Error',msgs[code]||'Unknown video error');
  };

  function shouldRefresh(data){
    var status=(data&&data.response&&data.response.code)||0;
    var details=data&&data.details;
    return status===403||status===404||status===410||status===459||status===462||
      data.type===Hls.ErrorTypes.NETWORK_ERROR||
      details===Hls.ErrorDetails.MANIFEST_LOAD_ERROR||
      details===Hls.ErrorDetails.LEVEL_LOAD_ERROR||
      details===Hls.ErrorDetails.FRAG_LOAD_ERROR;
  }

  function hlsSourceFor(url){
    var wrapper=['#EXTM3U','#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.4d401f,mp4a.40.5"',url,''].join(String.fromCharCode(10));
    return URL.createObjectURL(new Blob([wrapper],{type:'application/vnd.apple.mpegurl'}));
  }

  function isTsUrl(url){
    return /\\.ts(?:\\?|$)/i.test(url)||url.indexOf('extension=ts')!==-1||url.indexOf('/live/')!==-1;
  }

  function startHls(url){
    if(typeof Hls==='undefined'||!Hls.isSupported()){
      p.src=url;
      p.play().catch(function(){});
      return;
    }
    hlsInstance=new Hls({enableWorker:false,fragLoadingMaxRetry:2});
    hlsInstance.loadSource(hlsSourceFor(url));
    hlsInstance.attachMedia(p);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED,function(){p.play().catch(function(){})});
    hlsInstance.on(Hls.Events.ERROR,function(_ev,data){
      if(shouldRefresh(data)){
        refreshStream();
        return;
      }
      if(!data.fatal)return;
      var code=data.response&&data.response.code;
      var msg=statusMessage(code,data.type===Hls.ErrorTypes.NETWORK_ERROR?'Could not reach the stream server. Check your connection or try again.':'HLS error: '+data.details);
      showError(msg[0],msg[1]);
      destroyPlayers();
    });
  }

  function fallbackToNative(url){
    destroyPlayers();
    p.src=url;
    p.play().catch(function(){});
  }

  function startMpegts(url){
    if(typeof mpegts==='undefined'||!mpegts.isSupported()){
      fallbackToNative(url);
      return;
    }
    mpegtsInstance=mpegts.createPlayer({type:'mpegts',isLive:true,url:url},{enableWorker:false,lazyLoadMaxDuration:180,seekType:'range'});
    mpegtsInstance.on(mpegts.Events.ERROR,function(errType,errDetail,errInfo){
      var reason=[errType,errDetail,(errInfo&&errInfo.msg)||''].join(' ');
      if(/FormatUnsupported|Unsupported media|unsupported/i.test(reason)){
        fallbackToNative(url);
        return;
      }
      var code=errInfo&&errInfo.code;
      var msg=statusMessage(code,errType==='NetworkError'?'Could not load the stream. '+((errInfo&&errInfo.msg)||'Check your connection or try again.'):errType+': '+(errDetail||'Unknown error'));
      showError(msg[0],msg[1]);
      destroyPlayers();
    });
    mpegtsInstance.attachMediaElement(p);
    mpegtsInstance.load();
    mpegtsInstance.play().catch(function(){});
  }

  function playUrl(rawUrl){
    var url=rawUrl;
    destroyPlayers();
    l.style.display='none';
    e.style.display='none';
    if(streamType==='hls'||/\\.m3u8(?:\\?|$)/i.test(url)){
      startHls(url);
    }else if(streamType==='ts'||isTsUrl(url)){
      startMpegts(url);
    }else{
      p.src=url;
      p.play().catch(function(){});
    }
  }

  function refreshStream(){
    if(refreshPending)return;
    if(!playbackId){showError('Playback Error','Missing playback session');return}
    refreshPending=true;
    fetch('/api/refresh-playback?playbackId='+encodeURIComponent(playbackId))
      .then(function(r){
        if(!r.ok)return r.json().then(function(d){throw new Error(d.error||'Refresh failed')});
        return r.json();
      })
      .then(function(data){
        refreshPending=false;
        if(!data.url)throw new Error('No stream URL');
        if(data.type)streamType=data.type;
        playUrl(data.url);
      })
      .catch(function(err){
        refreshPending=false;
        showError('Playback Error',err.message);
      });
  }

  var token=getToken();
  if(!token){showError('Playback Error','Missing play token');return}

  fetch('/api/validate-token?token='+encodeURIComponent(token))
    .then(function(r){
      if(!r.ok)return r.json().then(function(d){throw new Error(d.error||'Validation failed')});
      return r.json();
    })
    .then(function(data){
      if(!data.url)throw new Error('No stream URL');
      playbackId=data.playbackId||null;
      streamType=data.type||'direct';
      playUrl(data.url);
    })
    .catch(function(err){
      showError('Playback Error',err.message);
    });
})();
</script>
</body>
</html>`);
  });

  // -- MEDIA PROXY ROUTES (Legacy support or shared) --
  // These could also be moved into api.js if desired.

  app.get("/stream", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required', code: 'malformed' });
    if (!(await isUrlAllowed(url))) return res.status(403).json({ error: 'Stream URL not allowed', code: 'url_not_allowed' });
    try {
      const headers = { "User-Agent": req.headers["user-agent"] || "StreamVault/1.0" };
      if (req.headers.range) headers["Range"] = req.headers.range;
      // Forward Referer/Origin so stream server sees a legitimate HLS session
      if (req.headers.referer) headers["Referer"] = req.headers.referer;
      if (req.headers.origin) headers["Origin"] = req.headers.origin;
      try { headers["Referer"] = headers["Referer"] || new URL(url).origin + "/"; } catch {}
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      const { response: upstream, url: resolvedUrl } = await fetchWithRedirectCheck(url, { headers, signal: controller.signal });
      
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
      if (ct.includes("mpegurl") || ct.includes("m3u") || resolvedUrl.endsWith(".m3u8")) {
        const { Transform } = require("stream");
        const baseDir = resolvedUrl.substring(0, resolvedUrl.lastIndexOf("/") + 1);
        const serverRoot = new URL(resolvedUrl).origin + "/";
        let leftover = "";
        const rewriter = new Transform({
          transform(chunk, enc, cb) {
            const text = leftover + chunk.toString();
            const lines = text.split("\n");
            leftover = lines.pop();
            const rewritten = lines.map(line => {
              const t = line.trim();
              if (!t || t.startsWith("#")) return line;
              let abs;
              if (t.startsWith("http")) {
                abs = t;
              } else if (t.startsWith("/")) {
                // Absolute path — resolve against server root, not M3U8 directory
                abs = serverRoot + t.replace(/^\//, "");
              } else {
                abs = baseDir + t;
              }
              return `/stream?url=${encodeURIComponent(abs)}`;
            }).join("\n") + "\n";
            cb(null, rewritten);
          },
          flush(cb) { cb(null, leftover); }
        });
        upstream.body.pipe(rewriter).pipe(res);
      } else {
        upstream.body.pipe(res);
      }
    } catch { res.status(502).json({ error: 'Stream relay failed', code: 'provider_failure' }); }
  });

  app.get("/img", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Image URL required', code: 'malformed' });
    if (!(await isUrlAllowed(url))) return res.status(403).json({ error: 'Image URL not allowed', code: 'url_not_allowed' });
    try {
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      const { response: upstream } = await fetchWithRedirectCheck(url, { timeout: 10000, signal: controller.signal });
      if (!upstream || !upstream.ok) return res.status(upstream?.status || 502).end();
      res.set("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
      res.set("Cache-Control", "public, max-age=86400");
      upstream.body.pipe(res);
    } catch { res.status(502).json({ error: 'Stream relay failed', code: 'provider_failure' }); }
  });

  app.get("/proxy", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required', code: 'malformed' });
    if (!(await isUrlAllowed(url))) return res.status(403).json({ error: 'Proxy URL not allowed', code: 'url_not_allowed' });
    let tt;
    try {
      // Catalog/XMLTV responses can be large, but a stalled provider must not
      // retain an upstream socket indefinitely on the small VPS.
      const configuredTimeout = Number.parseInt(process.env.PROXY_TRANSFER_TIMEOUT_MS || "", 10);
      const timeoutMs = Number.isFinite(configuredTimeout)
        ? Math.min(90000, Math.max(15000, configuredTimeout))
        : 60000;
      tt = transferTimeout(timeoutMs);
      const cancelTransfer = () => tt.abort();
      const clearTransfer = () => tt.clear();
      req.once("close", cancelTransfer);
      res.once("finish", clearTransfer);
      res.once("close", clearTransfer);
      const { response: r } = await fetchWithRedirectCheck(url, { signal: tt.signal });
      
      const ct = r.headers.get("content-type") || "application/json";
      res.set("Content-Type", ct);



      // Forward the upstream status code
      res.status(r.status);

      // Handle 304 edge case (though no-cache headers above should prevent it)
      if (r.status === 304) {
        return res.json([]);
      }

      // Always pipe the stream to avoid buffering 100MB+ strings in memory.
      // Explicitly close the client response if the upstream aborts after
      // headers were sent; otherwise browsers wait forever for EOF.
      r.body.on("error", (error) => {
        clearTransfer();
        if (!res.writableEnded) res.destroy(error);
      });
      r.body.once("end", clearTransfer);
      r.body.pipe(res);
    } catch (e) {
      tt?.clear?.();
      if (!res.headersSent) res.status(502).end();
      else if (!res.writableEnded) res.destroy(e);
    }
  });

  return app;
}

module.exports = { createApp };

