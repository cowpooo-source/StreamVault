// SQLite cache with TTL — stores channels, categories, VOD/series items
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.CACHE_DB || path.join(__dirname, "../data/cache.db");

// Ensure data directory exists
const fs = require("fs");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

// Create table
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires INTEGER NOT NULL
  )
`);

// Prepared statements (reused for performance)
const stmtGet = db.prepare("SELECT value FROM cache WHERE key = ? AND expires > ?");
const stmtSet = db.prepare("INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)");
const stmtDel = db.prepare("DELETE FROM cache WHERE key = ?");
const stmtCleanup = db.prepare("DELETE FROM cache WHERE expires <= ?");

const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function get(key) {
  const row = stmtGet.get(key, Date.now());
  return row ? JSON.parse(row.value) : null;
}

function set(key, value, ttl = DEFAULT_TTL) {
  stmtSet.run(key, JSON.stringify(value), Date.now() + ttl);
}

function del(key) {
  stmtDel.run(key);
}

function cleanup() {
  const result = stmtCleanup.run(Date.now());
  if (result.changes > 0) console.log(`Cache cleanup: removed ${result.changes} expired entries`);
}

// Build cache key from portal+mac+endpoint+params
function cacheKey(portal, mac, endpoint, extra = "") {
  return `${portal}|${mac}|${endpoint}${extra ? "|" + extra : ""}`;
}

// Cleanup expired entries every hour
setInterval(cleanup, 60 * 60 * 1000);
cleanup(); // Run once on startup

module.exports = { get, set, del, cleanup, cacheKey };
