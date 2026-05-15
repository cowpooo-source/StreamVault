const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const cache = require("../cache");
const ga = require("./ga");

let lastNetStat = { rx: 0, tx: 0, ts: Date.now() };

// Read network bandwidth from /proc/net/dev (Linux only)
function getNetworkStats() {
  try {
    const data = fs.readFileSync("/proc/net/dev", "utf8");
    const lines = data.split("\n");
    let totalRx = 0, totalTx = 0;
    for (const line of lines) {
      // Skip loopback and header lines
      if (line.includes("lo:") || !line.includes(":")) continue;
      const ifaceData = line.split(":")[1];
      if (!ifaceData) continue;
      const parts = ifaceData.trim().split(/\s+/);
      if (parts.length >= 8) {
        totalRx += parseInt(parts[0]) || 0;
        totalTx += parseInt(parts[8]) || 0;
      }
    }
    return { rx_bytes: totalRx, tx_bytes: totalTx, rx_gb: Math.round(totalRx / 1073741824 * 100) / 100, tx_gb: Math.round(totalTx / 1073741824 * 100) / 100 };
  } catch { return null; }
}

function getDiskUsage() {
  try {
    // df -k / outputs KB. Column 2: Total, 3: Used, 4: Available
    const out = execSync("df -k /").toString().split("\n")[1].trim().split(/\s+/);
    return {
      total_gb: Math.round(parseInt(out[1]) / 1024 / 1024),
      used_gb: Math.round(parseInt(out[2]) / 1024 / 1024),
      percent: parseInt(out[4].replace("%", ""))
    };
  } catch { return null; }
}

// Track bandwidth per day in SQLite
function trackDailyBandwidth() {
  const net = getNetworkStats();
  if (!net) return;
  const today = new Date().toISOString().slice(0, 10);
  
  // Calculate hourly diff for GA tracking (if start exists)
  const startKey = `bw:${today}:start`;
  const existingStart = cache.get(startKey);
  if (existingStart && (new Date().getMinutes() === 0)) { // rough hourly trigger
    const diffRxGb = (net.rx_bytes - existingStart.rx) / 1073741824;
    const diffTxGb = (net.tx_bytes - existingStart.tx) / 1073741824;
    // We send the day's total so far periodically
    ga.trackBandwidth(diffTxGb, diffRxGb); 
  }

  // Store current cumulative values — diff is calculated at read time
  cache.set(`bw:${today}:current`, { rx: net.rx_bytes, tx: net.tx_bytes }, 30 * 24 * 60 * 60 * 1000);
  // Store start-of-day snapshot if not exists
  if (!existingStart) cache.set(startKey, { rx: net.rx_bytes, tx: net.tx_bytes }, 30 * 24 * 60 * 60 * 1000);
}

function trackServerHeartbeat() {
  const metrics = getSystemMetrics();
  const disk = getDiskUsage() || { percent: 0 };
  ga.trackServerHeartbeat({
    cpu_percent: Math.round(metrics.cpu.load[0] * 100 / metrics.cpu.cores),
    ram_percent: metrics.mem.percent,
    disk_percent: disk.percent
  });
}

// Set up periodic tracking
if (process.env.NODE_ENV !== "test") {
  trackDailyBandwidth();
  const dailyBandwidthTimer = setInterval(trackDailyBandwidth, 60 * 1000);
  if (typeof dailyBandwidthTimer.unref === "function") dailyBandwidthTimer.unref();

  // Send GA server heartbeat every 15 mins
  const gaHeartbeatTimer = setInterval(trackServerHeartbeat, 15 * 60 * 1000);
  if (typeof gaHeartbeatTimer.unref === "function") gaHeartbeatTimer.unref();
}

function getLastNetStat() {
  return lastNetStat;
}

function setLastNetStat(stat) {
  lastNetStat = stat;
}

function getSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  let load = [0, 0, 0];
  try {
    const loadData = fs.readFileSync("/proc/loadavg", "utf8");
    load = loadData.split(/\s+/).slice(0, 3).map(parseFloat);
  } catch {
    load = os.loadavg();
  }

  return {
    cpu: {
      load: os.loadavg(),
      cores: os.cpus().length,
    },
    mem: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      percent: Math.round((usedMem / totalMem) * 100)
    },
    uptime: os.uptime(),
    load: load
  };
}

module.exports = {
  getNetworkStats,
  getDiskUsage,
  trackDailyBandwidth,
  getLastNetStat,
  setLastNetStat,
  getSystemMetrics
};
