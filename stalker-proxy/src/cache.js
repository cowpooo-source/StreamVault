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
    // Test DB is valid
    db.exec("SELECT 1");
  } catch (e) {
    console.warn("Cache DB corrupted or missing, creating fresh:", e.message);
    // Delete corrupt file
    try { fs.unlinkSync(DB_PATH); } catch {}
    try { fs.unlinkSync(DB_PATH + ".tmp"); } catch {}
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires)");
  save();
  return db;
}

function save() {
  if (!db) return;
  try {
    // Write to temp file then rename — atomic, prevents corruption on kill
    const tmp = DB_PATH + ".tmp";
    fs.writeFileSync(tmp, Buffer.from(db.export()));
    fs.renameSync(tmp, DB_PATH);
  } catch {}
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

// ── Request & visitor tracking ──
let cacheHits = 0, cacheMisses = 0;

function trackCacheHit() { cacheHits++; }
function trackCacheMiss() { cacheMisses++; }

function trackRequest(type) {
  if (!db) return;
  const today = new Date().toISOString().slice(0, 10);
  db.run(`INSERT INTO requests (date, type, count) VALUES (?, ?, 1)
    ON CONFLICT(date, type) DO UPDATE SET count = count + 1`, [today, type]);
  dirty = true;
}

function trackVisitor(ip) {
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);
  db.run(`INSERT INTO visitors (ip, first_seen, last_seen, hits) VALUES (?, ?, ?, 1)
    ON CONFLICT(ip) DO UPDATE SET last_seen = ?, hits = hits + 1`, [ip, now, now, now]);
  dirty = true;
}

function trackPortal(portal, mac, type) {
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);
  const key = `${portal}|${mac}`;
  db.run(`INSERT INTO portals (key, portal, mac, type, first_seen, last_seen, hits) VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET last_seen = ?, hits = hits + 1, type = ?`, [key, portal, mac, type, now, now, now, type]);
  dirty = true;
}

function getStats() {
  if (!db) return {};
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const today = new Date().toISOString().slice(0, 10);

  // Cache stats
  const cacheTotal = db.exec("SELECT COUNT(*) FROM cache")[0]?.values[0][0] || 0;
  const cacheValid = db.exec("SELECT COUNT(*) FROM cache WHERE expires > " + now)[0]?.values[0][0] || 0;
  const cacheSize = db.exec("SELECT COALESCE(SUM(LENGTH(value)),0) FROM cache")[0]?.values[0][0] || 0;

  // Today's requests
  const todayRows = db.exec("SELECT type, count FROM requests WHERE date = '" + today + "'");
  const todayReqs = {};
  if (todayRows[0]) todayRows[0].values.forEach(([type, count]) => { todayReqs[type] = count; });

  // Last 7 days
  const d7 = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
  const weeklyRows = db.exec("SELECT date, type, count FROM requests WHERE date >= '" + d7 + "' ORDER BY date");
  const daily = {};
  if (weeklyRows[0]) weeklyRows[0].values.forEach(([date, type, count]) => {
    if (!daily[date]) daily[date] = {};
    daily[date][type] = count;
  });

  // Cache breakdown
  const cacheBreakdown = {};
  const bkRows = db.exec("SELECT key FROM cache WHERE expires > " + now);
  if (bkRows[0]) bkRows[0].values.forEach(([key]) => {
    const endpoint = key.split("|")[2] || "other";
    cacheBreakdown[endpoint] = (cacheBreakdown[endpoint] || 0) + 1;
  });

  // Visitor stats
  const totalVisitors = db.exec("SELECT COUNT(*) FROM visitors")[0]?.values[0][0] || 0;
  const active1h = db.exec("SELECT COUNT(*) FROM visitors WHERE last_seen >= " + (nowSec - 3600))[0]?.values[0][0] || 0;
  const active24h = db.exec("SELECT COUNT(*) FROM visitors WHERE last_seen >= " + (nowSec - 86400))[0]?.values[0][0] || 0;
  const active7d = db.exec("SELECT COUNT(*) FROM visitors WHERE last_seen >= " + (nowSec - 7 * 86400))[0]?.values[0][0] || 0;

  // Recent visitors
  const recentRows = db.exec("SELECT ip, first_seen, last_seen, hits FROM visitors ORDER BY last_seen DESC LIMIT 15");
  const recentVisitors = (recentRows[0]?.values || []).map(([ip, first, last, hits]) => ({
    ip: ip.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, '$1.$2.***.$4'), // partially mask
    first_seen: first, last_seen: last, hits,
  }));

  // Portal stats
  const portalRows = db.exec("SELECT portal, mac, type, first_seen, last_seen, hits FROM portals ORDER BY last_seen DESC LIMIT 20");
  const portals = (portalRows[0]?.values || []).map(([portal, mac, type, first, last, hits]) => ({
    portal, mac: mac.substring(0, 8) + ":**:**:**", type, first_seen: first, last_seen: last, hits,
  }));
  const portalsByType = {};
  const ptRows = db.exec("SELECT type, COUNT(*) FROM portals GROUP BY type");
  if (ptRows[0]) ptRows[0].values.forEach(([t, c]) => { portalsByType[t] = c; });

  // Guest/user stats
  const totalGuests = db.exec("SELECT COUNT(*) FROM guests")[0]?.values[0][0] || 0;
  const recentGuestRows = db.exec("SELECT guest_id, ip, created_at, last_seen, connections, favorites, history FROM guests ORDER BY last_seen DESC LIMIT 20");
  const recentGuests = (recentGuestRows[0]?.values || []).map(([gid, ip, created, last, conn, favs, hist]) => ({
    guest_id: gid?.substring(0, 8) + "...", ip: ip?.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, '$1.$2.***.$4') || "",
    created_at: created, last_seen: last, connections: conn || 0, favorites: favs || 0, history: hist || 0,
  }));

  // Most watched
  const watchedRows = db.exec("SELECT name, type, plays FROM watch_log ORDER BY plays DESC LIMIT 15");
  const mostWatched = (watchedRows[0]?.values || []).map(([name, type, plays]) => ({ name, type, plays }));

  return {
    cacheTotal, cacheValid, cacheSizeMB: Math.round(cacheSize / 1024 / 1024 * 100) / 100,
    cacheHits, cacheMisses, cacheHitRate: cacheHits + cacheMisses > 0 ? Math.round(cacheHits / (cacheHits + cacheMisses) * 100) : 0,
    todayReqs, daily, cacheBreakdown,
    visitors: { total: totalVisitors, active_1h: active1h, active_24h: active24h, active_7d: active7d },
    recentVisitors, portals, portalsByType,
    guests: { total: totalGuests }, recentGuests, mostWatched,
  };
}

function trackGuest(guestId, ip) {
  if (!db || !guestId) return;
  const now = Math.floor(Date.now() / 1000);
  db.run(`INSERT INTO guests (guest_id, ip, created_at, last_seen) VALUES (?, ?, ?, ?)
    ON CONFLICT(guest_id) DO UPDATE SET last_seen = ?, ip = ?`, [guestId, ip, now, now, now, ip]);
  dirty = true;
}

function trackGuestActivity(guestId, field) {
  if (!db || !guestId) return;
  db.run(`UPDATE guests SET ${field} = ${field} + 1, last_seen = ? WHERE guest_id = ?`,
    [Math.floor(Date.now() / 1000), guestId]);
  dirty = true;
}

function trackWatch(name, type) {
  if (!db || !name) return;
  db.run(`INSERT INTO watch_log (name, type, plays) VALUES (?, ?, 1)
    ON CONFLICT(name, type) DO UPDATE SET plays = plays + 1`, [name, type || "live"]);
  dirty = true;
}

function saveFeedback(message, guestId, userAgent, ip) {
  if (!db || !message) return;
  const now = Math.floor(Date.now() / 1000);
  db.run("INSERT INTO feedback (message, guest_id, user_agent, ip, created_at) VALUES (?, ?, ?, ?, ?)",
    [message, guestId || null, userAgent || null, ip || null, now]);
  dirty = true;
}

function getFeedback() {
  if (!db) return [];
  const rows = db.exec("SELECT id, message, guest_id, user_agent, ip, created_at FROM feedback ORDER BY created_at DESC LIMIT 100");
  if (!rows[0]) return [];
  return rows[0].values.map(([id, message, guest_id, user_agent, ip, created_at]) => ({
    id, message, guest_id, user_agent, ip, created_at,
  }));
}

function saveGuestData(guestId, connId, type, data) {
  if (!db || !guestId || !connId) return;
  const now = Math.floor(Date.now() / 1000);
  db.run("INSERT OR REPLACE INTO guest_data (guest_id, conn_id, type, data, updated_at) VALUES (?, ?, ?, ?, ?)",
    [guestId, connId, type, JSON.stringify(data), now]);
  dirty = true;
}

function getGuestData(guestId, connId, type) {
  if (!db) return null;
  const stmt = db.prepare("SELECT data FROM guest_data WHERE guest_id = ? AND conn_id = ? AND type = ?");
  stmt.bind([guestId, connId, type]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return JSON.parse(row.data); }
  stmt.free();
  return null;
}

function deleteGuestData(guestId, connId) {
  if (!db) return;
  db.run("DELETE FROM guest_data WHERE guest_id = ? AND conn_id = ?", [guestId, connId]);
  dirty = true;
}

function cleanupGuestData() {
  if (!db) return;
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  db.run("DELETE FROM guest_data WHERE updated_at < ?", [cutoff]);
  db.run("DELETE FROM guests WHERE last_seen < ?", [cutoff]);
  dirty = true;
}

// Cleanup expired entries every hour
setInterval(() => { cleanup(); cleanupGuestData(); }, 60 * 60 * 1000);

// Initialize on load
const ready = init().then(() => {
  db.run(`CREATE TABLE IF NOT EXISTS requests (
    date TEXT NOT NULL, type TEXT NOT NULL, count INTEGER DEFAULT 0,
    PRIMARY KEY (date, type)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS visitors (
    ip TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, hits INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS guests (
    guest_id TEXT PRIMARY KEY, ip TEXT, created_at INTEGER, last_seen INTEGER,
    connections INTEGER DEFAULT 0, favorites INTEGER DEFAULT 0, history INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS watch_log (
    name TEXT NOT NULL, type TEXT NOT NULL, plays INTEGER DEFAULT 0,
    PRIMARY KEY (name, type)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS portals (
    key TEXT PRIMARY KEY, portal TEXT, mac TEXT, type TEXT,
    first_seen INTEGER, last_seen INTEGER, hits INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT, guest_id TEXT,
    user_agent TEXT, ip TEXT, created_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS guest_data (
    guest_id TEXT NOT NULL, conn_id TEXT NOT NULL, type TEXT NOT NULL,
    data TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (guest_id, conn_id, type)
  )`);
  cleanup();
});

module.exports = { get, set, del, cleanup, cacheKey, ready, trackRequest, trackVisitor, trackPortal, trackCacheHit, trackCacheMiss, trackGuest, trackGuestActivity, trackWatch, getStats, saveFeedback, getFeedback, saveGuestData, getGuestData, deleteGuestData, cleanupGuestData };
