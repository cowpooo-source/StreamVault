const Database = require('better-sqlite3');
const db = new Database('stalker-proxy/data/users.db');
const now = Date.now();
const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);

const row = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE last_login > ?").get(twentyFourHoursAgo);
console.log('Users logged in last 24h:', row.cnt);

const visitorsDb = new Database('stalker-proxy/data/cache.db');
const nowSec = Math.floor(now / 1000);
const active24h = visitorsDb.prepare("SELECT COUNT(*) AS cnt FROM visitors WHERE last_seen >= ?").get(nowSec - 86400).cnt;
const active24h_ago = visitorsDb.prepare("SELECT COUNT(*) AS cnt FROM visitors WHERE last_seen >= ? AND last_seen < ?").get(nowSec - 172800, nowSec - 86400).cnt;
console.log('Visitors (IPs) active last 24h:', active24h);
console.log('Visitors (IPs) active yesterday (24-48h ago):', active24h_ago);
