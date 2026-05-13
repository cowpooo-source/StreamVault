const express = require("express");
const router = express.Router();
const os = require("os");
const path = require("path");
const cache = require("../cache");
const auth = require("../auth");
const { getNetworkStats, getDiskUsage, getLastNetStat, setLastNetStat } = require("../services/system");

const ADMIN_PASS = process.env.ADMIN_PASS;
const crypto = require("crypto");
const ANALYTICS_CACHE_TTL_MS = 15000;
let analyticsCache = { expiresAt: 0, payload: null };

function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── GET /api/analytics — JSON stats (requires auth token)
router.get("/api/analytics", (req, res) => {
  if (!ADMIN_PASS) return res.status(503).json({ error: "ADMIN_PASS not configured" });
  const token = req.headers["x-admin-token"];
  if (!safeCompare(token, ADMIN_PASS)) return res.status(401).json({ error: "Unauthorized" });

  const now = Date.now();
  if (analyticsCache.payload && analyticsCache.expiresAt > now) {
    res.set("Cache-Control", "no-store");
    return res.json(analyticsCache.payload);
  }

  const stats = cache.getStats();
  const mem = process.memoryUsage();
  const net = getNetworkStats();

  // Calculate today's bandwidth
  const today = new Date().toISOString().slice(0, 10);
  const bwStart = cache.get(`bw:${today}:start`);
  let todayBw = null;
  if (net && bwStart) {
    todayBw = {
      rx_gb: Math.round((net.rx_bytes - bwStart.rx) / 1073741824 * 100) / 100,
      tx_gb: Math.round((net.tx_bytes - bwStart.tx) / 1073741824 * 100) / 100,
    };
    todayBw.total_gb = Math.round((todayBw.rx_gb + todayBw.tx_gb) * 100) / 100;
  }

  // Real-time network speed (Mbps)
  let networkSpeed = { rx_mbps: 0, tx_mbps: 0 };
  const lastNetStat = getLastNetStat();
  if (net && lastNetStat) {
    const dt = (now - lastNetStat.ts) / 1000; // seconds
    if (dt > 0) {
      const rxDiff = net.rx_bytes - lastNetStat.rx;
      const txDiff = net.tx_bytes - lastNetStat.tx;
      // bytes -> bits / 1,000,000
      networkSpeed.rx_mbps = Math.round((rxDiff * 8 / 1000000 / dt) * 10) / 10;
      networkSpeed.tx_mbps = Math.round((txDiff * 8 / 1000000 / dt) * 10) / 10;
    }
  }
  setLastNetStat({ rx: net?.rx_bytes || 0, tx: net?.tx_bytes || 0, ts: now });

  // Calculate monthly bandwidth
  let monthlyBw = { rx_gb: 0, tx_gb: 0, total_gb: 0 };
  const allBwKeys = cache.db.prepare("SELECT key, value FROM cache WHERE key LIKE 'bw:%:start'").all();
  allBwKeys.forEach(k => {
    const dayStart = JSON.parse(k.value);
    const dateStr = k.key.split(":")[1];
    const dayCurrent = cache.get(`bw:${dateStr}:current`) || dayStart;
    monthlyBw.rx_gb += (dayCurrent.rx - dayStart.rx) / 1073741824;
    monthlyBw.tx_gb += (dayCurrent.tx - dayStart.tx) / 1073741824;
  });
  monthlyBw.rx_gb = Math.round(monthlyBw.rx_gb * 100) / 100;
  monthlyBw.tx_gb = Math.round(monthlyBw.tx_gb * 100) / 100;
  monthlyBw.total_gb = Math.round((monthlyBw.rx_gb + monthlyBw.tx_gb) * 100) / 100;

  const payload = {
    activeNow: stats.activeNow,
    health: stats.health,
    security: auth.getAuthStats(),
    hardware: {
      cpu_load: os.loadavg(),
      cpu_cores: os.cpus().length,
      ram: {
        total_gb: Math.round(os.totalmem() / 1073741824 * 10) / 10,
        free_gb: Math.round(os.freemem() / 1073741824 * 10) / 10,
        used_gb: Math.round((os.totalmem() - os.freemem()) / 1073741824 * 10) / 10,
        percent: Math.round((os.totalmem() - os.freemem()) / os.totalmem() * 100),
      },
      disk: getDiskUsage(),
      network_speed: networkSpeed,
    },
    server: {
      uptime_hours: Math.round(process.uptime() / 3600 * 10) / 10,
      memory_mb: Math.round(mem.rss / 1024 / 1024),
      heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
      node: process.version,
      platform: process.platform,
    },
    bandwidth: {
      total: net ? { rx_gb: net.rx_gb, tx_gb: net.tx_gb, total_gb: Math.round((net.rx_gb + net.tx_gb) * 100) / 100 } : null,
      today: todayBw,
      monthly: monthlyBw,
    },
    visitors: stats.visitors,
    recent_visitors: stats.recentVisitors,
    guests: stats.guests,
    recent_guests: stats.recentGuests,
    most_watched: stats.mostWatched,
    playbackBreakdown: stats.playbackBreakdown,
    portals: { connections: stats.portals, by_type: stats.portalsByType },
    engagement: stats.engagement,
    cache: {
      total_entries: stats.cacheTotal,
      valid_entries: stats.cacheValid,
      size_mb: stats.cacheSizeMB,
      hit_rate: stats.cacheHitRate,
      hits: stats.cacheHits,
      misses: stats.cacheMisses,
      breakdown: stats.cacheBreakdown,
    },
    requests: {
      today: stats.todayReqs,
      daily: stats.daily,
    },
    feedback: cache.getFeedback(),
    generated_at: new Date().toISOString(),
  };

  analyticsCache = { expiresAt: now + ANALYTICS_CACHE_TTL_MS, payload };
  res.set("Cache-Control", "no-store");
  res.json(payload);
});

// ── GET /analytics — HTML dashboard (with login)
router.get("/analytics", (req, res) => {
  res.sendFile(path.join(__dirname, "../analytics.html"));
});

module.exports = router;
