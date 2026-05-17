// SQLite cache with TTL — stores channels, categories, VOD/series items
// Uses better-sqlite3 (native bindings, writes directly to disk)
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const os = require("os");

const DB_PATH = process.env.CACHE_DB || path.join(__dirname, "../data/cache.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Initialize database ──
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// ── Create tables ──
db.exec(`CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires)");
db.exec(`CREATE TABLE IF NOT EXISTS requests (
  date TEXT NOT NULL, type TEXT NOT NULL, count INTEGER DEFAULT 0,
  PRIMARY KEY (date, type)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS visitors (
  ip TEXT PRIMARY KEY, country TEXT DEFAULT 'Unknown', device TEXT DEFAULT 'Unknown',
  first_seen INTEGER, last_seen INTEGER, hits INTEGER DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS guests (
  guest_id TEXT PRIMARY KEY, ip TEXT, created_at INTEGER, last_seen INTEGER,
  connections INTEGER DEFAULT 0, favorites INTEGER DEFAULT 0, history INTEGER DEFAULT 0,
  role TEXT DEFAULT 'guest'
)`);
db.exec(`CREATE TABLE IF NOT EXISTS watch_log (
  name TEXT NOT NULL, type TEXT NOT NULL, plays INTEGER DEFAULT 0,
  PRIMARY KEY (name, type)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS portals (
  key TEXT PRIMARY KEY, portal TEXT, mac TEXT, type TEXT,
  first_seen INTEGER, last_seen INTEGER, hits INTEGER DEFAULT 0,
  avg_latency INTEGER DEFAULT 0, errors INTEGER DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS ip_cache (
  ip TEXT PRIMARY KEY, country TEXT, expires INTEGER
)`);

// Add columns if upgrading
try { db.exec("ALTER TABLE visitors ADD COLUMN country TEXT DEFAULT 'Unknown'"); } catch {}
try { db.exec("ALTER TABLE visitors ADD COLUMN device TEXT DEFAULT 'Unknown'"); } catch {}
try { db.exec("ALTER TABLE portals ADD COLUMN avg_latency INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE portals ADD COLUMN errors INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE watch_log ADD COLUMN last_watched INTEGER"); } catch {}
try { db.exec("ALTER TABLE guests ADD COLUMN role TEXT DEFAULT 'guest'"); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT, guest_id TEXT,
  user_agent TEXT, ip TEXT, created_at INTEGER
)`);
db.exec(`CREATE TABLE IF NOT EXISTS guest_data (
  guest_id TEXT NOT NULL, conn_id TEXT NOT NULL, type TEXT NOT NULL,
  data TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (guest_id, conn_id, type)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS playback_sessions (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER,
  guest_id TEXT,
  connection_id TEXT,
  item_id TEXT,
  item_type TEXT,
  item_name TEXT,
  group_name TEXT,
  started_at INTEGER,
  last_seen_at INTEGER,
  ended_at INTEGER,
  watched_seconds INTEGER DEFAULT 0,
  media_duration INTEGER,
  position INTEGER,
  completed BOOLEAN DEFAULT 0,
  device_id TEXT
)`);
db.exec("CREATE TABLE IF NOT EXISTS health_logs (ts INTEGER, type TEXT, status INTEGER, duration INTEGER)");
db.exec("CREATE INDEX IF NOT EXISTS idx_health_ts ON health_logs(ts)");

// ── Prepared statements (reusable, much faster than parsing each time) ──
const stmtGet = db.prepare("SELECT value FROM cache WHERE key = ? AND expires > ?");
const stmtSet = db.prepare("INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)");
const stmtDel = db.prepare("DELETE FROM cache WHERE key = ?");
const stmtCleanup = db.prepare("DELETE FROM cache WHERE expires <= ?");
const stmtTrackRequest = db.prepare(`INSERT INTO requests (date, type, count) VALUES (?, ?, 1)
  ON CONFLICT(date, type) DO UPDATE SET count = count + 1`);
const stmtTrackVisitor = db.prepare(`INSERT INTO visitors (ip, country, device, first_seen, last_seen, hits) VALUES (?, ?, ?, ?, ?, 1)
  ON CONFLICT(ip) DO UPDATE SET last_seen = ?, hits = hits + 1,
    country = CASE WHEN excluded.country != 'Unknown' THEN excluded.country ELSE country END,
    device = CASE WHEN excluded.device != 'Unknown' THEN excluded.device ELSE device END`);
const stmtTrackPortal = db.prepare(`INSERT INTO portals (key, portal, mac, type, first_seen, last_seen, hits, avg_latency, errors) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  ON CONFLICT(key) DO UPDATE SET last_seen = ?, hits = hits + 1, type = excluded.type,
    avg_latency = (avg_latency * hits + excluded.avg_latency) / (hits + 1),
    errors = errors + excluded.errors`);
const stmtTrackGuest = db.prepare(`INSERT INTO guests (guest_id, ip, created_at, last_seen, role) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(guest_id) DO UPDATE SET last_seen = ?, ip = ?, role = CASE WHEN excluded.role != 'guest' THEN excluded.role ELSE role END`);
const stmtTrackWatch = db.prepare(`INSERT INTO watch_log (name, type, plays) VALUES (?, ?, 1)
  ON CONFLICT(name, type) DO UPDATE SET plays = plays + 1`);

const stmtGetIpCache = db.prepare("SELECT country FROM ip_cache WHERE ip = ? AND expires > ?");
const stmtSetIpCache = db.prepare("INSERT OR REPLACE INTO ip_cache (ip, country, expires) VALUES (?, ?, ?)");
const stmtSaveFeedback = db.prepare("INSERT INTO feedback (message, guest_id, user_agent, ip, created_at) VALUES (?, ?, ?, ?, ?)");
const stmtGetFeedback = db.prepare("SELECT id, message, guest_id, user_agent, ip, created_at FROM feedback ORDER BY created_at DESC LIMIT 100");
const stmtSaveGuestData = db.prepare("INSERT OR REPLACE INTO guest_data (guest_id, conn_id, type, data, updated_at) VALUES (?, ?, ?, ?, ?)");
const stmtGetGuestData = db.prepare("SELECT data FROM guest_data WHERE guest_id = ? AND conn_id = ? AND type = ?");
const stmtDeleteGuestData = db.prepare("DELETE FROM guest_data WHERE guest_id = ? AND conn_id = ?");
const stmtCleanupGuestData = db.prepare("DELETE FROM guest_data WHERE updated_at < ?");
const stmtCleanupGuests = db.prepare("DELETE FROM guests WHERE last_seen < ?");

// ── Cache operations ──
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

function deleteByPrefix(connId) {
  // connId format: "stalker:http://portal:port/c:00:1A:79:XX:XX:XX"
  const match = connId.match(/^stalker:(.+):([0-9A-Fa-f:]{17})$/);
  if (match) {
    db.prepare("DELETE FROM cache WHERE key LIKE ?").run(`${match[1]}|${match[2]}|%`);
  }
}

function cleanup() {
  const result = stmtCleanup.run(Date.now());
  if (result.changes > 0) {
    console.log(`Cache cleanup: removed ${result.changes} expired entries`);
  }
}

function cacheKey(portal, mac, endpoint, extra = "") {
  return `${portal}|${mac}|${endpoint}${extra ? "|" + extra : ""}`;
}

// ── Request & visitor tracking ──
let cacheHits = 0, cacheMisses = 0;
const activeUsers = new Map(); // guestId -> lastSeen

function trackCacheHit() { cacheHits++; }
function trackCacheMiss() { cacheMisses++; }

function trackRequest(type, status = 200, duration = 0) {
  const today = new Date().toISOString().slice(0, 10);
  // Detailed logs for the last 30 days
  db.prepare(`INSERT INTO requests (date, type, count) VALUES (?, ?, 1)
    ON CONFLICT(date, type) DO UPDATE SET count = count + 1`).run(today, type);
  
  // Track errors and latency in a separate small table for health monitoring
  db.prepare("INSERT INTO health_logs (ts, type, status, duration) VALUES (?, ?, ?, ?)").run(Math.floor(Date.now()/1000), type, status, duration);
}

function maskIp(ip) {
  if (!ip) return "unknown";
  const v4 = ip.match(/^(\d+\.\d+)\.\d+\.\d+$/);
  if (v4) return `${v4[1]}.0.0`;
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::";
  return "unknown";
}

function parseDevice(ua) {
  if (!ua) return "Unknown";
  const lowUA = ua.toLowerCase();
  if (lowUA.includes("smarttv") || lowUA.includes("smart-tv") || lowUA.includes("hbbtv") || lowUA.includes("appletv") || lowUA.includes("aftt") || lowUA.includes("aftb") || lowUA.includes("googletv")) return "Smart TV";
  if (lowUA.includes("mag250") || lowUA.includes("mag254") || lowUA.includes("stbapp")) return "STB";
  if (lowUA.includes("android") && !lowUA.includes("mobile")) return "Smart TV/Box";
  if (lowUA.includes("iphone") || lowUA.includes("android") || lowUA.includes("mobile")) return "Mobile";
  if (lowUA.includes("ipad") || lowUA.includes("tablet")) return "Tablet";
  if (lowUA.includes("windows") || lowUA.includes("macintosh") || lowUA.includes("linux")) return "Desktop";
  return "Other";
}

async function resolveCountry(ip) {
  if (!ip || ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.")) return "Internal";
  
  const now = Math.floor(Date.now() / 1000);
  const cached = stmtGetIpCache.get(ip, now);
  if (cached) return cached.country;

  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode`, { timeout: 3000 });
    const data = await res.json();
    const country = data.countryCode || "Unknown";
    stmtSetIpCache.run(ip, country, now + 7 * 86400); // cache 7 days
    return country;
  } catch {
    return "Unknown";
  }
}

async function trackVisitor(ip, ua) {
  const now = Math.floor(Date.now() / 1000);
  const country = await resolveCountry(ip);
  const device = parseDevice(ua);
  stmtTrackVisitor.run(maskIp(ip), country, device, now, now, now);
}

function trackPortal(portal, mac, type, latency = 0, status = 200) {
  const now = Math.floor(Date.now() / 1000);
  const key = `${portal}|${mac}`;
  const errors = status >= 400 ? 1 : 0;
  stmtTrackPortal.run(key, portal, mac, type, now, now, latency, errors, now);
}

function trackPortalHealth(portal, latency = 0, status = 200) {
  const now = Math.floor(Date.now() / 1000);
  const errors = status >= 400 ? 1 : 0;
  // We use a dummy mac to update global portal stats if mac is unknown
  const key = `${portal}|global`;
  stmtTrackPortal.run(key, portal, "global", "api", now, now, latency, errors, now);
  
  try {
    const ga = require("./services/ga");
    ga.trackPortalHealth(portal, latency, status);
  } catch (e) {
    // ignore if ga is missing
  }
}

function getStats() {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const today = new Date().toISOString().slice(0, 10);

  // Active Now (last 5 mins)
  let activeCount = 0;
  for (const [gid, lastSeen] of activeUsers.entries()) {
    if (now - lastSeen < 5 * 60000) activeCount++;
    else activeUsers.delete(gid);
  }

  // Health stats (last 24h)
  const health = db.prepare("SELECT COALESCE(AVG(duration), 0) as avg_lat, COUNT(*) filter (where status >= 400) as errs, COUNT(*) as total FROM health_logs WHERE ts > ?").get(nowSec - 86400);

  // Cache stats
  const cacheTotal = db.prepare("SELECT COUNT(*) AS cnt FROM cache").get().cnt;
  const cacheValid = db.prepare("SELECT COUNT(*) AS cnt FROM cache WHERE expires > ?").get(now).cnt;
  const cacheSize = db.prepare("SELECT COALESCE(SUM(LENGTH(value)),0) AS sz FROM cache").get().sz;

  // Today's requests
  const todayRows = db.prepare("SELECT type, count FROM requests WHERE date = ?").all(today);
  const todayReqs = {};
  todayRows.forEach(({ type, count }) => { todayReqs[type] = count; });

  // Last 7 days
  const d7 = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
  const weeklyRows = db.prepare("SELECT date, type, count FROM requests WHERE date >= ? ORDER BY date").all(d7);
  const daily = {};
  weeklyRows.forEach(({ date, type, count }) => {
    if (!daily[date]) daily[date] = {};
    daily[date][type] = count;
  });

  // Cache breakdown
  const bkRows = db.prepare(`SELECT
    CASE
      WHEN key LIKE '%|channels%' THEN 'channels'
      WHEN key LIKE '%|vod%' THEN 'vod'
      WHEN key LIKE '%|series%' THEN 'series'
      WHEN key LIKE '%|epg%' THEN 'epg'
      WHEN key LIKE '%|seasons%' THEN 'seasons'
      ELSE 'other'
    END as endpoint, COUNT(*) as cnt
    FROM cache WHERE expires > ? GROUP BY endpoint`).all(now);
  const cacheBreakdown = {};
  bkRows.forEach(({ endpoint, cnt }) => { cacheBreakdown[endpoint] = cnt; });

  // Visitor stats (last 24h/48h)
  const active24h = db.prepare("SELECT COUNT(*) AS cnt FROM guests WHERE last_seen >= ?").get(nowSec - 86400).cnt;
  const active24h_ago = db.prepare("SELECT COUNT(*) AS cnt FROM guests WHERE last_seen >= ? AND last_seen < ?").get(nowSec - 172800, nowSec - 86400).cnt;
  const active7d = db.prepare("SELECT COUNT(*) AS cnt FROM guests WHERE last_seen >= ?").get(nowSec - 7 * 86400).cnt;

  // Registered vs Guest breakdown (last 24h)
  const reg24h = db.prepare("SELECT COUNT(*) AS cnt FROM guests WHERE last_seen >= ? AND role != 'guest'").get(nowSec - 86400).cnt;

  // Recent visitors
  const recentRows = db.prepare("SELECT ip, country, device, first_seen, last_seen, hits FROM visitors ORDER BY last_seen DESC LIMIT 15").all();
  const recentVisitors = recentRows.map(({ ip, country, device, first_seen, last_seen, hits }) => ({
    ip: ip.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, '$1.$2.***.$4'),
    country, device, first_seen, last_seen, hits,
  }));

  // Engagement stats
  const geoDist = db.prepare("SELECT country, COUNT(*) as cnt FROM visitors GROUP BY country ORDER BY cnt DESC LIMIT 10").all();
  const deviceDist = db.prepare("SELECT device, COUNT(*) as cnt FROM visitors GROUP BY device ORDER BY cnt DESC").all();

  // Portal health leaderboard
  const portalRows = db.prepare("SELECT portal, mac, type, first_seen, last_seen, hits, avg_latency, errors FROM portals ORDER BY avg_latency ASC LIMIT 50").all();
  const portals = portalRows.map(({ portal, mac, type, first_seen, last_seen, hits, avg_latency, errors }) => ({
    portal, mac: mac.substring(0, 8) + ":**:**:**", type, first_seen, last_seen, hits,
    avg_latency: Math.round(avg_latency),
    error_rate: hits > 0 ? Math.round((errors / hits) * 100) : 0,
  }));
  const portalsByType = {};
  const ptRows = db.prepare("SELECT type, COUNT(*) AS cnt FROM portals GROUP BY type").all();
  ptRows.forEach(({ type, cnt }) => { portalsByType[type] = cnt; });

  // Guest/user stats
  const totalGuests = db.prepare("SELECT COUNT(*) AS cnt FROM guests").get().cnt;
  const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
  
  const recentGuestRows = db.prepare(`
    SELECT g.*, 
           COALESCE(SUM(ps.watched_seconds), 0) as watch_time,
           COALESCE(SUM(CASE WHEN ps.started_at >= ? THEN ps.watched_seconds ELSE 0 END), 0) as watch_time_today
    FROM guests g
    LEFT JOIN playback_sessions ps ON g.guest_id = ps.guest_id
    GROUP BY g.guest_id
    ORDER BY g.last_seen DESC LIMIT 20
  `).all(todayStart);

  const recentGuests = recentGuestRows.map(({ guest_id, ip, created_at, last_seen, connections, favorites, history, role, watch_time, watch_time_today }) => ({
    guest_id: guest_id?.substring(0, 8) + "...", ip: ip?.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, '$1.$2.***.$4') || "",
    created_at, last_seen, connections: connections || 0, favorites: favorites || 0, history: history || 0,
    role: role || 'guest', watch_time: watch_time || 0, watch_time_today: watch_time_today || 0
  }));

  // Playback breakdown
  const playbackBreakdownRows = db.prepare(`
    SELECT item_type, SUM(watched_seconds) as seconds 
    FROM playback_sessions 
    GROUP BY item_type
  `).all();
  const playbackBreakdown = {};
  playbackBreakdownRows.forEach(r => {
    if (r.item_type) playbackBreakdown[r.item_type] = r.seconds;
  });

  // Most watched
  const watchedRows = db.prepare("SELECT name, type, plays FROM watch_log ORDER BY plays DESC LIMIT 15").all();
  const mostWatched = watchedRows.map(({ name, type, plays }) => ({ name, type, plays }));

  return {
    cacheTotal, cacheValid, cacheSizeMB: Math.round(cacheSize / 1024 / 1024 * 100) / 100,
    cacheHits, cacheMisses, cacheHitRate: cacheHits + cacheMisses > 0 ? Math.round(cacheHits / (cacheHits + cacheMisses) * 100) : 0,
    todayReqs, daily, cacheBreakdown, activeNow: activeCount,
    health: { avg_latency: Math.round(health.avg_lat || 0), error_rate: health.total ? Math.round(health.errs / health.total * 100) : 0 },
    visitors: { total: totalVisitors, active_24h: active24h, registered_24h: reg24h, previous_24h: active24h_ago, active_7d: active7d },
    recent_visitors: recentVisitors, portals, portalsByType,
    guests: { total: totalGuests }, recent_guests: recentGuests, most_watched: mostWatched,
    playbackBreakdown,
    engagement: {
      geo: Object.fromEntries(geoDist.map(r => [r.country, r.cnt])),
      devices: Object.fromEntries(deviceDist.map(r => [r.device, r.cnt])),
    }
  };
}

function trackGuest(guestId, ip, role = 'guest') {
  if (!guestId) return;
  const now = Date.now();
  activeUsers.set(guestId, now); // In-memory update
  const nowSec = Math.floor(now / 1000);
  const masked = maskIp(ip);
  stmtTrackGuest.run(guestId, masked, nowSec, nowSec, role, nowSec, masked);
}

const GUEST_ACTIVITY_FIELDS = new Set(["connections", "favorites", "history"]);
function trackGuestActivity(guestId, field) {
  if (!guestId || !GUEST_ACTIVITY_FIELDS.has(field)) return;
  activeUsers.set(guestId, Date.now());
  db.prepare(`UPDATE guests SET ${field} = ${field} + 1, last_seen = ? WHERE guest_id = ?`)
    .run(Math.floor(Date.now() / 1000), guestId);
}

function trackWatch(name, type) {
  if (!name) return;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO watch_log (name, type, plays, last_watched) VALUES (?, ?, 1, ?)
    ON CONFLICT(name, type) DO UPDATE SET plays = plays + 1, last_watched = ?`).run(name, type || "live", now, now);
}

function trackPlaybackHeartbeat(payload) {
  if (!payload || !payload.session_id) return;
  const { session_id, user_id, guest_id, connection_id, item_id, item_type, item_name, group_name, position, media_duration, completed, device_id } = payload;
  const now = Math.floor(Date.now() / 1000);
  
  db.prepare(`INSERT INTO playback_sessions 
    (session_id, user_id, guest_id, connection_id, item_id, item_type, item_name, group_name, started_at, last_seen_at, position, media_duration, completed, device_id, watched_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 60)
    ON CONFLICT(session_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      position = excluded.position,
      completed = CASE WHEN excluded.completed = 1 THEN 1 ELSE completed END,
      watched_seconds = watched_seconds + 60
  `).run(
    session_id, user_id || null, guest_id || null, connection_id || null, 
    item_id || null, item_type || null, item_name || null, group_name || null, 
    now, now, position || null, media_duration || null, completed ? 1 : 0, device_id || null
  );
}

function getPlaybackSummary(userId, guestId, range) {
  let timeFilter = 0;
  const now = Math.floor(Date.now() / 1000);
  if (range === 'today') timeFilter = now - 86400;
  else if (range === 'week') timeFilter = now - 7 * 86400;
  else if (range === 'month') timeFilter = now - 30 * 86400;

  let query = `SELECT 
    COALESCE(SUM(watched_seconds), 0) as total_seconds,
    COALESCE(SUM(CASE WHEN item_type = 'live' THEN watched_seconds ELSE 0 END), 0) as live_seconds,
    COALESCE(SUM(CASE WHEN item_type = 'vod' THEN watched_seconds ELSE 0 END), 0) as vod_seconds,
    COALESCE(SUM(CASE WHEN item_type = 'series' THEN watched_seconds ELSE 0 END), 0) as series_seconds,
    COALESCE(SUM(CASE WHEN item_type = 'catchup' THEN watched_seconds ELSE 0 END), 0) as catchup_seconds
    FROM playback_sessions 
    WHERE started_at >= ? AND `;
    
  let params = [timeFilter];

  if (userId) {
    query += "user_id = ?";
    params.push(userId);
  } else if (guestId) {
    query += "guest_id = ?";
    params.push(guestId);
  } else {
    return null;
  }

  return db.prepare(query).get(...params);
}

function saveFeedback(message, guestId, userAgent, ip) {
  if (!message) return;
  const now = Math.floor(Date.now() / 1000);
  stmtSaveFeedback.run(message, guestId || null, userAgent || null, maskIp(ip), now);
}

function getFeedback() {
  return stmtGetFeedback.all();
}

function saveGuestData(guestId, connId, type, data) {
  if (!guestId || !connId) return;
  activeUsers.set(guestId, Date.now());
  const now = Math.floor(Date.now() / 1000);
  stmtSaveGuestData.run(guestId, connId, type, JSON.stringify(data), now);
}

function getGuestData(guestId, connId, type) {
  const row = stmtGetGuestData.get(guestId, connId, type);
  return row ? JSON.parse(row.data) : null;
}

function deleteGuestData(guestId, connId) {
  stmtDeleteGuestData.run(guestId, connId);
}

function cleanupGuestData() {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  stmtCleanupGuestData.run(cutoff);
  stmtCleanupGuests.run(cutoff);
}

function cleanupDetailedLogs() {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  db.prepare("DELETE FROM health_logs WHERE ts < ?").run(cutoff);
  // Keep daily totals in 'requests' but delete detailed rows from potential future audit tables
}

// Cleanup expired entries every hour
setInterval(() => { cleanup(); cleanupGuestData(); cleanupDetailedLogs(); }, 60 * 60 * 1000);

// Run initial cleanup
cleanup();

// Backward-compatible ready export (sync init, but consumers may still .then() on it)
const ready = Promise.resolve();

module.exports = { db, get, set, del, deleteByPrefix, cleanup, cacheKey, ready, trackRequest, trackVisitor, trackPortal, trackPortalHealth, trackCacheHit, trackCacheMiss, trackGuest, trackGuestActivity, trackWatch, trackPlaybackHeartbeat, getPlaybackSummary, getStats, saveFeedback, getFeedback, saveGuestData, getGuestData, deleteGuestData, cleanupGuestData };
