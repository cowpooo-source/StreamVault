require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { createApp } = require("./app");
const cache = require("./cache");
const auth = require("./auth");
const fetch = require("node-fetch");
const system = require("./services/system");
const email = require("./email");
const { Pool } = require("pg");

let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
}

const PORT = process.env.PORT || 3001;

// Direct-content configuration validation and startup logging
function logDirectContentConfig() {
  const nodeEnv = process.env.NODE_ENV || "development";
  const isProd = nodeEnv === "production";
  const contentBase = process.env.CONTENT_BASE_URL || process.env.PLAYER_BASE || "";
  const rawTtl = Number.parseInt(process.env.CONTENT_SESSION_TTL_MINUTES || "", 10);
  const rawMaxPerUser = Number.parseInt(process.env.CONTENT_SESSION_MAX_PER_USER || "", 10);
  const ttl = Number.isFinite(rawTtl) ? Math.min(120, Math.max(5, rawTtl)) : 30;
  const maxPerUser = Number.isFinite(rawMaxPerUser) ? Math.min(50, Math.max(1, rawMaxPerUser)) : 5;

  if (contentBase) {
    try {
      const url = new URL(contentBase);
      if (!["http:", "https:"].includes(url.protocol)) {
        console.warn(`[direct-content] CONTENT_BASE_URL has invalid scheme "${url.protocol}"; expected http or https`);
      } else {
        console.log(`[direct-content] content origin: ${url.origin}`);
      }
    } catch {
      console.warn(`[direct-content] CONTENT_BASE_URL "${contentBase}" is not a valid URL`);
    }
  } else if (isProd) {
    console.warn("[direct-content] CONTENT_BASE_URL not set; direct content sessions will fail in production");
  } else {
    console.log("[direct-content] content origin: http://localhost:3201 (development default)");
  }

  if (Number.isFinite(rawTtl) && rawTtl !== ttl) {
    console.warn(`[direct-content] CONTENT_SESSION_TTL_MINUTES ${rawTtl} out of range; clamped to ${ttl}`);
  }
  if (Number.isFinite(rawMaxPerUser) && rawMaxPerUser !== maxPerUser) {
    console.warn(`[direct-content] CONTENT_SESSION_MAX_PER_USER ${rawMaxPerUser} out of range; clamped to ${maxPerUser}`);
  }
  if (!process.env.TOKEN_MASTER_KEY) {
    console.warn("[direct-content] TOKEN_MASTER_KEY not set; session creation will fail");
  }
  const store = pool ? "postgres" : cache.db ? "sqlite" : "memory";
  console.log(`[direct-content] session ttl: ${ttl}m, max per user: ${maxPerUser}, store: ${store}`);
}
logDirectContentConfig();

// Safety nets
// unhandledRejection: log and survive (process state is still valid)
// uncaughtException: log and exit; PM2 restarts a clean process
process.on("unhandledRejection", (reason, promise) => {
  console.error("[unhandledRejection]", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.message);
  process.exit(1); // PM2 restarts; staying alive risks undefined process state
});

// Initialize auth with database
auth.init(cache.db);

// Create the application with dependencies
const app = createApp({ cache, auth, fetch, system, email, pool });

let server;
if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`Stalker proxy running on http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Cache: SQLite/better-sqlite3 (7-day TTL, WAL mode)`);
    console.log(`   Auth: ${auth.listUsers().length} users, JWT auto-secret`);
  });

  // Background tasks
  setInterval(system.trackDailyBandwidth, 60000); // every minute
  setInterval(() => auth.cleanupSessions(), 60 * 60 * 1000); // every hour

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received; shutting down gracefully`);
  if (server) {
    server.close(() => {
      try { cache.db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
      try { cache.db.close(); } catch {}
      console.log("Shutdown complete.");
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
  setTimeout(() => { console.error("Forced shutdown after timeout"); process.exit(1); }, 10000);
}

module.exports = app;
