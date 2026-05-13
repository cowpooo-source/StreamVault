require("dotenv").config();
const { createApp } = require("./app");
const cache = require("./cache");
const auth = require("./auth");
const fetch = require("node-fetch");
const system = require("./services/system");
const email = require("./email");

const PORT = process.env.PORT || 3001;

// Initialize auth with database
auth.init(cache.db);

// Create the application with dependencies
const app = createApp({ cache, auth, fetch, system, email });

let server;
if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`✅ Stalker proxy running on http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Cache: SQLite/better-sqlite3 (7-day TTL, WAL mode)`);
    console.log(`   Auth: ${auth.listUsers().length} users, JWT auto-secret`);
  });

  // ── Background Tasks ──
  setInterval(system.trackDailyBandwidth, 60000); // every minute
  setInterval(() => auth.cleanupSessions(), 60 * 60 * 1000); // every hour

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully…`);
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