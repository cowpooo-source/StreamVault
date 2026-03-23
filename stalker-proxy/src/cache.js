// SQLite cache with TTL — stores channels, categories, VOD/series items
// Uses sql.js (pure JS, no native compilation needed)
const initSqlJs = require("sql.js");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.CACHE_DB || path.join(__dirname, "../data/cache.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db = null;
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

async function init() {
  if (db) return db;
  const SQL = await initSqlJs();
  try {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } catch {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL
  )`);
  save();
  return db;
}

function save() {
  if (!db) return;
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch {}
}

// Save to disk periodically (every 30s) and on process exit
let dirty = false;
setInterval(() => { if (dirty) { save(); dirty = false; } }, 30000);
process.on("exit", save);
process.on("SIGINT", () => { save(); process.exit(); });
process.on("SIGTERM", () => { save(); process.exit(); });

function get(key) {
  if (!db) return null;
  const stmt = db.prepare("SELECT value FROM cache WHERE key = ? AND expires > ?");
  stmt.bind([key, Date.now()]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return JSON.parse(row.value);
  }
  stmt.free();
  return null;
}

function set(key, value, ttl = DEFAULT_TTL) {
  if (!db) return;
  db.run("INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)",
    [key, JSON.stringify(value), Date.now() + ttl]);
  dirty = true;
}

function del(key) {
  if (!db) return;
  db.run("DELETE FROM cache WHERE key = ?", [key]);
  dirty = true;
}

function cleanup() {
  if (!db) return;
  const result = db.run("DELETE FROM cache WHERE expires <= ?", [Date.now()]);
  if (db.getRowsModified() > 0) {
    console.log(`Cache cleanup: removed ${db.getRowsModified()} expired entries`);
    dirty = true;
  }
}

function cacheKey(portal, mac, endpoint, extra = "") {
  return `${portal}|${mac}|${endpoint}${extra ? "|" + extra : ""}`;
}

// Cleanup expired entries every hour
setInterval(cleanup, 60 * 60 * 1000);

// Initialize on load
const ready = init().then(() => { cleanup(); });

module.exports = { get, set, del, cleanup, cacheKey, ready };
