const fs = require("fs");
const { execSync } = require("child_process");
const cache = require("../cache");

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
  // Store current cumulative values — diff is calculated at read time
  cache.set(`bw:${today}:current`, { rx: net.rx_bytes, tx: net.tx_bytes }, 30 * 24 * 60 * 60 * 1000);
  // Store start-of-day snapshot if not exists
  const startKey = `bw:${today}:start`;
  if (!cache.get(startKey)) cache.set(startKey, { rx: net.rx_bytes, tx: net.tx_bytes }, 30 * 24 * 60 * 60 * 1000);
}

function getLastNetStat() {
  return lastNetStat;
}

function setLastNetStat(stat) {
  lastNetStat = stat;
}

module.exports = {
  getNetworkStats,
  getDiskUsage,
  trackDailyBandwidth,
  getLastNetStat,
  setLastNetStat
};
