import { useState, useEffect, useRef, useCallback, useMemo } from "react";

const PROXY = import.meta.env.VITE_PROXY_URL || "http://localhost:3001";
const STREAM_PROXY = import.meta.env.VITE_STREAM_PROXY_URL || PROXY;

// ══════════════════════════════════════════════════════════════════
// THEMES (OTT Navigator style multi-theme)
// ══════════════════════════════════════════════════════════════════
const THEMES = {
  Dark:   { bg:"#07070f", s1:"#0f0f1c", s2:"#16162a", s3:"#1d1d35", accent:"#00d4ff", accent2:"#7c3aed", t1:"#dde0f5", t2:"#8080aa", t3:"#44445a" },
  Navy:   { bg:"#030b1a", s1:"#061228", s2:"#0d1f3c", s3:"#152850", accent:"#4da6ff", accent2:"#6c63ff", t1:"#d0e8ff", t2:"#6090b8", t3:"#304560" },
  AMOLED: { bg:"#000000", s1:"#0d0d0d", s2:"#181818", s3:"#222222", accent:"#ff6b35", accent2:"#ff2d55", t1:"#f0f0f0", t2:"#888888", t3:"#444444" },
  Forest: { bg:"#050f0a", s1:"#0a1f14", s2:"#112a1c", s3:"#1a3828", accent:"#00e896", accent2:"#00b4d8", t1:"#d0ffe8", t2:"#5a9070", t3:"#2a5038" },
};
const THEME_NAMES = Object.keys(THEMES);
const PROFILE_COLORS = ["#00d4ff","#ff6b35","#00e896","#ff2d55","#a78bfa","#fbbf24"];

// ══════════════════════════════════════════════════════════════════
// STORAGE + GUEST SESSION
// ══════════════════════════════════════════════════════════════════
function getGuestId() {
  let id = localStorage.getItem("sv-guest-id");
  if (!id) { id = crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("sv-guest-id", id); }
  return id;
}
const GUEST_ID = getGuestId();

let _syncTimer = null;
function scheduleCloudSync() {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    try {
      const keys = ["sv-theme","sv-profiles","sv-activeProfile","sv-history","sv-hiddenCats","sv-epgURL","sv-lastConn"];
      const data = {};
      for (const k of keys) { const v = localStorage.getItem(k); if (v !== null) data[k] = JSON.parse(v); }
      // Also save per-profile favorites
      const profiles = data["sv-profiles"] || [];
      for (const p of profiles) { const fk = `sv-favs-${p.id}`; const v = localStorage.getItem(fk); if (v !== null) data[fk] = JSON.parse(v); }
      await fetch("/api/session", { method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ guestId: GUEST_ID, data }) }).catch(() => {});
    } catch {}
  }, 5000);
}

const db = {
  async get(key, fallback = null) {
    try {
      if (window.storage) { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : fallback; }
      const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  async set(key, value) {
    try {
      if (window.storage) { await window.storage.set(key, JSON.stringify(value)); }
      else localStorage.setItem(key, JSON.stringify(value));
      scheduleCloudSync();
    } catch {}
  },
};

// IndexedDB cache for large stalker data (avoids localStorage 5MB limit)
const idbCache = (() => {
  let dbP;
  function open() {
    if (dbP) return dbP;
    dbP = new Promise(r => {
      const req = indexedDB.open("sv-stalker-cache", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("c");
      req.onsuccess = () => r(req.result);
      req.onerror = () => r(null);
    });
    return dbP;
  }
  return {
    async get(key) {
      const d = await open(); if (!d) return null;
      return new Promise(r => { const g = d.transaction("c","readonly").objectStore("c").get(key); g.onsuccess = () => r(g.result ?? null); g.onerror = () => r(null); });
    },
    async set(key, val) {
      const d = await open(); if (!d) return;
      return new Promise(r => { const tx = d.transaction("c","readwrite"); tx.objectStore("c").put(val, key); tx.oncomplete = () => r(); tx.onerror = () => r(); });
    },
  };
})();

// Deterministic connection ID for IDB/D1 keying
function connId(c) {
  if (!c) return null;
  if (c.type === "stalker") return `stalker:${c.server}:${c.mac}`;
  if (c.type === "xtream") return `xtream:${c.server}:${c.user}`;
  if (c.type === "m3u") return `m3u:${c.url}`;
  return "hls";
}

// D1 catalog API helper (fire-and-forget background sync)
function catalogAPI(path, opts = {}) {
  const { method = "GET", body } = opts;
  const headers = { "X-Guest-Id": GUEST_ID };
  if (body) headers["Content-Type"] = "application/json";
  return fetch(`${PROXY}/api/catalog/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json()).catch(() => null);
}

function syncContentToD1(connectionId, type, items) {
  catalogAPI("content", { method: "PUT", body: { connectionId, type, items: items.map(i => ({
    id: i.id, name: i.name, logo: i.logo, group: i.group, url: i.url,
    num: i.num, epgId: i.epgId, year: i.year, rating: i.rating,
    stalkerCmd: i._stalkerCmd || i.stalkerCmd,
  })) } });
}

function syncCategoriesToD1(connectionId, section, categories) {
  catalogAPI("categories", { method: "PUT", body: { connectionId, section, categories } });
}

function syncConnectionToD1(id, type, config) {
  catalogAPI("connections", { method: "PUT", body: { id, type, config } });
}

function syncFavoritesToD1(profileId, favorites) {
  catalogAPI("favorites", { method: "PUT", body: { profileId, favorites } });
}

function syncHistoryToD1(history) {
  catalogAPI("history", { method: "PUT", body: { history } });
}

function syncPreferencesToD1(prefs) {
  catalogAPI("preferences", { method: "PUT", body: { preferences: prefs } });
}

// Migrate old idbCache/localStorage data to new permanent IDB keys
async function migrateOldCache() {
  try {
    const migrated = await idbCache.get("sv-migrated-v2");
    if (migrated) return;
    // Migrate old stalker category caches from localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("sv-s-") && key.includes("cats-")) {
        try {
          const { cats } = JSON.parse(localStorage.getItem(key));
          if (cats) {
            // Extract server from key: sv-s-{section}cats-{server}
            const match = key.match(/^sv-s-(vod|series)cats-(.+)$/);
            if (match) await idbCache.set(`cats-ls:${match[2]}:${match[1]}`, cats);
          }
        } catch {}
      }
    }
    // Migrate old stalker channel caches (stored via db.set → localStorage)
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("sv-stalker-channels-")) {
        try {
          const channels = JSON.parse(localStorage.getItem(key));
          if (channels) {
            const server = key.replace("sv-stalker-channels-", "");
            await idbCache.set(`channels-ls:${server}`, channels);
          }
        } catch {}
      }
    }
    await idbCache.set("sv-migrated-v2", true);
  } catch {}
}
migrateOldCache();

// On first load, try to restore from cloud if localStorage is empty
(async () => {
  try {
    if (localStorage.getItem("sv-theme")) return; // already have local data
    const res = await fetch(`/api/session?id=${GUEST_ID}`);
    const { data } = await res.json();
    if (!data) return;
    for (const [k, v] of Object.entries(data)) { localStorage.setItem(k, JSON.stringify(v)); }
    window.location.reload(); // reload to pick up restored data
  } catch {}
})();

// ══════════════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════════════
function parseM3U(text) {
  const lines = text.split("\n"); const out = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF")) {
      const name   = (line.match(/,(.+)$/) || [])[1]?.trim() || "Unknown";
      const logo   = (line.match(/tvg-logo="([^"]+)"/) || [])[1] || null;
      const group  = (line.match(/group-title="([^"]+)"/) || [])[1] || "Uncategorized";
      const epgId  = (line.match(/tvg-id="([^"]+)"/) || [])[1] || null;
      const num    = parseInt((line.match(/tvg-chno="([^"]+)"/) || [])[1]) || null;
      cur = { name, logo, group, epgId, num, type:"live" };
    } else if (line && !line.startsWith("#") && cur) {
      cur.url = line; cur.id = cur.url; out.push(cur); cur = null;
    }
  }
  return out;
}

function parseXMLTV(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const programs = {};
  doc.querySelectorAll("programme").forEach(p => {
    const ch = p.getAttribute("channel")?.toLowerCase().trim();
    if (!ch) return;
    const start = parseEPGDate(p.getAttribute("start"));
    const stop  = parseEPGDate(p.getAttribute("stop"));
    if (!programs[ch]) programs[ch] = [];
    programs[ch].push({ title: p.querySelector("title")?.textContent || "", start, stop });
  });
  return programs;
}

function parseEPGDate(s) {
  if (!s) return 0;
  const m = s.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return 0;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
}

function getEPGNow(programs, epgId) {
  if (!programs || !epgId) return null;
  const key = epgId.toLowerCase().trim();
  const list = programs[key] || programs[epgId] || [];
  const now = Date.now();
  return list.find(p => p.start <= now && p.stop > now) || null;
}

function epgLookup(epgData, ch) {
  if (!epgData) return null;
  // Try normalized epgId (xmltv_id), then raw, then channel numeric id
  const norm = ch.epgId?.toLowerCase().trim();
  return (norm && epgData[norm]) || (ch.epgId && epgData[ch.epgId]) || (ch.id && epgData[ch.id]) || null;
}

function fmtTime(sec) {
  if (!sec) return "0:00";
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60);
  return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`;
}

function proxyFetch(url) {
  return fetch(`${PROXY}/proxy?url=${encodeURIComponent(url)}`);
}

function makeXtreamAPI(server, user, pass) {
  const base = `${server}/player_api.php?username=${user}&password=${pass}`;
  return {
    auth: () => proxyFetch(base).then(r => r.json()),
    getLiveCategories: () => proxyFetch(`${base}&action=get_live_categories`).then(r => r.json()),
    getLive: () => proxyFetch(`${base}&action=get_live_streams`).then(r => r.json()),
    getVODCategories: () => proxyFetch(`${base}&action=get_vod_categories`).then(r => r.json()),
    getVOD: () => proxyFetch(`${base}&action=get_vod_streams`).then(r => r.json()),
    getSeriesCategories: () => proxyFetch(`${base}&action=get_series_categories`).then(r => r.json()),
    getSeries: () => proxyFetch(`${base}&action=get_series`).then(r => r.json()),
    getSeriesInfo: (id) => proxyFetch(`${base}&action=get_series_info&series_id=${id}`).then(r => r.json()),
    liveURL: id => `${server}/live/${user}/${pass}/${id}.m3u8`,
    vodURL: (id, ext="mp4") => `${server}/movie/${user}/${pass}/${id}.${ext}`,
    seriesStreamURL: (id, ext="mp4") => `${server}/series/${user}/${pass}/${id}.${ext}`,
  };
}

function uid() { return Math.random().toString(36).slice(2,10); }

// ══════════════════════════════════════════════════════════════════
// CSS GENERATOR
// ══════════════════════════════════════════════════════════════════
function genCSS(t) {
  return `
@import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:${t.bg};--s1:${t.s1};--s2:${t.s2};--s3:${t.s3};
  --b1:rgba(255,255,255,0.06);--b2:rgba(255,255,255,0.11);
  --accent:${t.accent};--accent2:${t.accent2};
  --glow:${t.accent}28;
  --t1:${t.t1};--t2:${t.t2};--t3:${t.t3};
  --danger:#ff4466;--ok:#00cc88;
}
body{background:var(--bg);font-family:'DM Sans',sans-serif;color:var(--t1);overflow:hidden}
.app{display:flex;height:100vh;overflow:hidden;background:var(--bg)}

/* SETUP */
.setup{min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at 20% 70%,${t.accent2}22 0%,transparent 55%),
             radial-gradient(ellipse at 80% 20%,${t.accent}18 0%,transparent 50%),var(--bg);padding:2rem}
.card{background:var(--s1);border:1px solid var(--b2);border-radius:18px;padding:2.5rem;
  width:100%;max-width:500px;box-shadow:0 48px 96px #00000080}
.logo{font-family:'Rajdhani',sans-serif;font-size:2.2rem;font-weight:700;letter-spacing:.12em;
  background:linear-gradient(135deg,${t.accent},${t.accent2});-webkit-background-clip:text;
  -webkit-text-fill-color:transparent;background-clip:text;margin-bottom:.2rem}
.tagline{color:var(--t2);font-size:.82rem;margin-bottom:2rem}
.tabs{display:flex;gap:.3rem;background:var(--s2);padding:4px;border-radius:10px;margin-bottom:1.5rem}
.tab{flex:1;padding:.42rem .2rem;background:none;border:none;border-radius:7px;color:var(--t2);
  font-family:'DM Sans',sans-serif;font-size:.7rem;font-weight:500;cursor:pointer;transition:all .2s;text-align:center;white-space:nowrap}
.tab.on{background:var(--s3);color:var(--accent);box-shadow:0 2px 8px #00000040}
.fg{margin-bottom:1rem}
.fl{display:block;font-size:.7rem;font-weight:600;color:var(--t2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.4rem}
.fi{width:100%;background:var(--s2);border:1px solid var(--b2);border-radius:8px;
  padding:.62rem .9rem;color:var(--t1);font-family:'DM Sans',sans-serif;font-size:.88rem;outline:none;transition:border-color .2s}
.fi:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--glow)}
.fhint{font-size:.7rem;color:var(--t3);margin-top:.3rem}
.btn-primary{width:100%;padding:.75rem;background:linear-gradient(135deg,var(--accent),var(--accent2));
  border:none;border-radius:9px;color:#fff;font-family:'Rajdhani',sans-serif;font-size:1rem;
  font-weight:700;letter-spacing:.06em;cursor:pointer;transition:opacity .2s;margin-top:.5rem}
.btn-primary:hover{opacity:.88}
.btn-primary:disabled{opacity:.45;cursor:not-allowed}
.err{background:#ff446612;border:1px solid #ff446630;border-radius:8px;padding:.6rem .9rem;color:var(--danger);font-size:.82rem;margin-bottom:1rem}

/* SIDEBAR */
.sidebar{width:215px;flex-shrink:0;background:var(--s1);border-right:1px solid var(--b1);
  display:flex;flex-direction:column;padding:1.2rem 0;overflow-y:auto;overflow-x:hidden}
.s-logo{font-family:'Rajdhani',sans-serif;font-size:1.3rem;font-weight:700;letter-spacing:.12em;
  background:linear-gradient(135deg,${t.accent},${t.accent2});-webkit-background-clip:text;
  -webkit-text-fill-color:transparent;background-clip:text;padding:0 1rem;margin-bottom:1.2rem}
.s-sect{font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.14em;
  color:var(--t3);padding:0 1rem;margin:.9rem 0 .35rem}
.nav{display:flex;align-items:center;gap:.55rem;padding:.5rem 1rem;color:var(--t2);
  font-size:.82rem;font-weight:500;cursor:pointer;transition:all .15s;border-left:2px solid transparent;
  position:relative}
.nav:hover{color:var(--t1);background:rgba(255,255,255,0.03)}
.nav.on{color:var(--accent);background:${t.accent}12;border-left-color:var(--accent)}
.nav-icon{font-size:.9rem;width:17px;text-align:center;flex-shrink:0}
.nav-badge{margin-left:auto;background:var(--accent2);color:#fff;font-size:.58rem;font-weight:700;
  padding:.1rem .35rem;border-radius:10px}
.s-bottom{margin-top:auto;padding:.85rem 1rem 0;border-top:1px solid var(--b1);display:flex;flex-direction:column;gap:.4rem}
.s-conn{font-size:.68rem;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.s-row{display:flex;gap:.4rem}
.btn-sm{flex:1;padding:.38rem .5rem;background:var(--b1);border:1px solid var(--b2);border-radius:6px;
  color:var(--t2);font-family:'DM Sans',sans-serif;font-size:.7rem;cursor:pointer;transition:all .2s;text-align:center}
.btn-sm:hover{background:var(--b2);color:var(--t1)}
.btn-sm.danger{color:var(--danger);border-color:#ff446620}
.btn-sm.danger:hover{background:#ff446612}

/* PROFILES */
.profiles-row{display:flex;align-items:center;gap:.4rem;padding:0 1rem;margin-bottom:.6rem;flex-wrap:wrap}
.profile-dot{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:.65rem;font-weight:700;cursor:pointer;border:2px solid transparent;transition:all .2s;color:#000;flex-shrink:0}
.profile-dot.active{border-color:var(--t1);transform:scale(1.1)}
.profile-dot.add{background:var(--s3) !important;color:var(--t2);font-size:1rem;border-color:var(--b2)}
.profile-name{font-size:.68rem;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 1rem;margin-bottom:.2rem}

/* CONTENT */
.content{flex:1;display:flex;flex-direction:column;overflow:hidden}
.c-header{padding:1rem 1.4rem;border-bottom:1px solid var(--b1);display:flex;align-items:center;gap:.75rem;flex-shrink:0}
.c-title{font-family:'Rajdhani',sans-serif;font-size:1.4rem;font-weight:700;letter-spacing:.05em;margin-right:auto}
.c-count{font-size:.72rem;color:var(--t3);margin-left:.4rem}
.c-search-wrap{position:relative;display:flex;align-items:center}
.c-search{background:var(--s2);border:1px solid var(--b2);border-radius:8px;padding:.4rem .875rem .4rem 2rem;
  color:var(--t1);font-family:'DM Sans',sans-serif;font-size:.82rem;outline:none;width:200px;transition:all .2s}
.c-search:focus{border-color:var(--accent);width:240px}
.c-search-icon{position:absolute;left:.6rem;color:var(--t3);font-size:.78rem;pointer-events:none}
.c-btn{padding:.38rem .75rem;background:var(--s2);border:1px solid var(--b2);border-radius:7px;
  color:var(--t2);font-family:'DM Sans',sans-serif;font-size:.75rem;cursor:pointer;transition:all .2s;white-space:nowrap}
.c-btn:hover{color:var(--t1);border-color:var(--b2)}
.c-btn.active{color:var(--accent);border-color:${t.accent}40;background:${t.accent}10}
.c-body{flex:1;overflow-y:auto;padding:1.1rem 1.4rem;display:flex;gap:1.1rem}

/* CATEGORIES */
.cats{width:150px;flex-shrink:0}
.cat{padding:.4rem .65rem;border-radius:7px;font-size:.75rem;color:var(--t2);cursor:pointer;
  transition:all .15s;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  display:flex;align-items:center;gap:.4rem}
.cat:hover{background:var(--s2);color:var(--t1)}
.cat.on{background:${t.accent}14;color:var(--accent)}
.cat-hidden{opacity:.3}

/* CARDS */
.ch-grid{flex:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:.6rem;align-content:start}
.ch-card{background:var(--s1);border:1px solid var(--b1);border-radius:10px;padding:.8rem .7rem;
  cursor:pointer;transition:all .2s;display:flex;flex-direction:column;align-items:center;gap:.5rem;text-align:center;position:relative}
.ch-card:hover{border-color:var(--b2);background:var(--s2);transform:translateY(-2px);box-shadow:0 8px 24px #00000040}
.ch-card.playing{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),0 8px 24px var(--glow)}
.ch-logo{width:42px;height:42px;object-fit:contain;border-radius:6px;background:var(--s2)}
.ch-logo-ph{width:42px;height:42px;background:var(--s3);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1.1rem}
.ch-name{font-size:.72rem;font-weight:500;line-height:1.3;overflow:hidden;text-overflow:ellipsis;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ch-meta{font-size:.62rem;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.ch-num{font-size:.62rem;color:var(--t3)}
.fav-btn{position:absolute;top:.4rem;right:.4rem;background:none;border:none;cursor:pointer;
  font-size:.85rem;opacity:.35;transition:all .2s;line-height:1;padding:.15rem}
.fav-btn:hover{opacity:1;transform:scale(1.2)}
.fav-btn.on{opacity:1}
.live-dot{width:5px;height:5px;border-radius:50%;background:var(--danger);display:inline-block;margin-right:3px;animation:blink 1.5s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.vod-grid{flex:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:.75rem;align-content:start}
.vod-card{background:var(--s1);border:1px solid var(--b1);border-radius:10px;overflow:hidden;cursor:pointer;
  transition:all .2s;position:relative}
.vod-card:hover{border-color:var(--b2);transform:translateY(-2px);box-shadow:0 14px 32px #00000050}
.vod-poster{width:100%;aspect-ratio:2/3;object-fit:cover;background:var(--s2);display:block}
.vod-ph{width:100%;aspect-ratio:2/3;background:var(--s2);display:flex;align-items:center;justify-content:center;font-size:2rem}
.vod-info{padding:.55rem .65rem}
.vod-title{font-size:.72rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vod-meta{font-size:.62rem;color:var(--t3);margin-top:.18rem}
.vod-fav{position:absolute;top:.4rem;right:.4rem;background:var(--bg)88;backdrop-filter:blur(4px);
  border:none;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;font-size:.72rem;opacity:.5;transition:all .2s}
.vod-fav:hover{opacity:1;transform:scale(1.15)}
.vod-fav.on{opacity:1}
.resume-bar{position:absolute;bottom:0;left:0;right:0;height:3px;background:var(--s3)}
.resume-fill{height:100%;background:var(--accent);transition:width .3s}
.badge{display:inline-block;padding:.1rem .32rem;background:${t.accent}18;border:1px solid ${t.accent}30;
  border-radius:4px;font-size:.6rem;color:var(--accent);font-weight:700;letter-spacing:.05em;text-transform:uppercase;margin-left:.35rem}

/* CONTINUE WATCHING */
.cw-row{display:flex;gap:.75rem;overflow-x:auto;padding-bottom:.5rem;flex:1}
.cw-row::-webkit-scrollbar{height:4px}
.cw-item{flex-shrink:0;width:130px;background:var(--s1);border:1px solid var(--b1);border-radius:9px;overflow:hidden;cursor:pointer;transition:all .2s;position:relative}
.cw-item:hover{border-color:var(--b2);transform:translateY(-2px)}
.cw-poster{width:100%;aspect-ratio:16/9;background:var(--s2);display:flex;align-items:center;justify-content:center;font-size:1.8rem;object-fit:cover}
.cw-info{padding:.45rem .55rem}
.cw-name{font-size:.68rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cw-time{font-size:.6rem;color:var(--t3);margin-top:.15rem}
.cw-prog-bar{height:2px;background:var(--s3);position:relative}
.cw-prog-fill{height:100%;background:var(--accent)}
.section-block{flex:1;min-height:0}
.section-label{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--t3);margin-bottom:.7rem;display:flex;align-items:center;gap:.5rem}
.section-label::after{content:'';flex:1;height:1px;background:var(--b1)}

/* PLAYER */
.player-ov{position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:300;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(12px)}
.player-wrap{width:92%;max-width:1080px;background:#000;border-radius:12px;overflow:hidden;
  box-shadow:0 48px 96px #000000c0;position:relative;animation:fadeUp .2s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
.player-video{width:100%;aspect-ratio:16/9;display:block;background:#000}
.player-bar{background:var(--s1);padding:.7rem 1.1rem;display:flex;align-items:center;gap:.75rem;border-top:1px solid var(--b1)}
.player-title{font-family:'Rajdhani',sans-serif;font-size:1.1rem;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.player-epg{font-size:.72rem;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
.player-ctrl{padding:.28rem .7rem;background:var(--s2);border:1px solid var(--b2);border-radius:6px;
  color:var(--t2);font-family:'DM Sans',sans-serif;font-size:.72rem;cursor:pointer;transition:all .2s;white-space:nowrap}
.player-ctrl:hover{color:var(--t1);border-color:var(--b2)}
.player-close{padding:.28rem .7rem;background:#ff446612;border:1px solid #ff446622;border-radius:6px;
  color:var(--danger);font-family:'DM Sans',sans-serif;font-size:.72rem;cursor:pointer;transition:all .2s}
.player-close:hover{background:#ff446622}
.kbd-hint{font-size:.6rem;color:var(--t3);display:flex;gap:.5rem;flex-wrap:wrap;padding:.4rem 1.1rem;background:var(--bg);border-top:1px solid var(--b1)}
.kbd{display:inline-block;background:var(--s2);border:1px solid var(--b2);border-radius:3px;padding:.05rem .3rem;font-size:.58rem;color:var(--t2);margin-right:.2rem}

/* OSD */
.osd{position:absolute;top:1rem;left:1rem;background:rgba(0,0,0,.82);backdrop-filter:blur(16px);
  border:1px solid var(--b2);border-radius:10px;padding:.65rem 1rem;display:flex;align-items:center;gap:.75rem;
  max-width:340px;animation:fadeIn .2s ease;pointer-events:none}
@keyframes fadeIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:none}}
.osd-logo{width:36px;height:36px;object-fit:contain;border-radius:5px;background:var(--s2);flex-shrink:0}
.osd-logo-ph{width:36px;height:36px;background:var(--s3);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:.95rem;flex-shrink:0}
.osd-name{font-family:'Rajdhani',sans-serif;font-weight:600;font-size:1.05rem;line-height:1.2}
.osd-epg{font-size:.7rem;color:var(--t2);margin-top:.1rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.osd-num{font-size:.65rem;color:var(--accent);font-weight:600}

/* QUICK CH */
.qch{position:absolute;left:1rem;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:.3rem;animation:fadeIn .2s ease;pointer-events:none}
.qch-item{background:rgba(0,0,0,.75);backdrop-filter:blur(10px);border:1px solid var(--b2);border-radius:8px;
  padding:.45rem .7rem;display:flex;align-items:center;gap:.5rem;min-width:160px;transition:all .2s}
.qch-item.active{background:${t.accent}22;border-color:var(--accent)}
.qch-thumb{width:26px;height:26px;border-radius:4px;object-fit:contain;background:var(--s2)}
.qch-thumb-ph{width:26px;height:26px;border-radius:4px;background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:.7rem;flex-shrink:0}
.qch-n{font-size:.72rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qch-num{font-size:.6rem;color:var(--t3);margin-left:auto}

/* EPG GRID */
.epg-outer{flex:1;overflow:auto}
.epg-top{padding:.75rem 1.4rem;display:flex;align-items:center;gap:.75rem;flex-shrink:0;border-bottom:1px solid var(--b1)}
.epg-table{min-width:max-content}
.epg-head-row{display:flex;position:sticky;top:0;z-index:10;background:var(--bg)}
.epg-ch-col{width:160px;flex-shrink:0;border-right:1px solid var(--b1);background:var(--bg)}
.epg-time-slot{width:180px;flex-shrink:0;font-size:.63rem;color:var(--t3);padding:.4rem .65rem;font-weight:600;letter-spacing:.04em;border-right:1px solid var(--b1)}
.epg-row{display:flex;border-bottom:1px solid var(--b1)}
.epg-ch-cell{width:160px;flex-shrink:0;padding:.55rem .75rem;font-size:.73rem;font-weight:500;
  border-right:1px solid var(--b1);display:flex;align-items:center;gap:.5rem;overflow:hidden}
.epg-ch-logo{width:22px;height:22px;object-fit:contain;border-radius:3px;flex-shrink:0}
.epg-ch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.epg-prog{background:var(--s1);border-right:1px solid var(--b1);padding:.45rem .65rem;width:180px;flex-shrink:0;
  cursor:pointer;transition:background .15s;overflow:hidden}
.epg-prog:hover{background:var(--s2)}
.epg-prog.now{background:${t.accent}10;border-top:2px solid var(--accent)}
.epg-prog-t{font-size:.7rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.epg-prog-s{font-size:.62rem;color:var(--t3);margin-top:2px}

/* GLOBAL SEARCH RESULTS */
.gsearch{flex:1;overflow-y:auto;padding:1rem 1.4rem;display:flex;flex-direction:column;gap:1.5rem}
.gsearch-section{display:flex;flex-direction:column;gap:.6rem}
.gsearch-row{display:flex;align-items:center;gap:.75rem;padding:.55rem .75rem;background:var(--s1);border:1px solid var(--b1);
  border-radius:9px;cursor:pointer;transition:all .2s}
.gsearch-row:hover{border-color:var(--b2);background:var(--s2)}
.gsearch-logo{width:34px;height:34px;object-fit:contain;border-radius:5px;background:var(--s2);flex-shrink:0}
.gsearch-logo-ph{width:34px;height:34px;background:var(--s3);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0}
.gsearch-name{font-size:.84rem;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gsearch-group{font-size:.68rem;color:var(--t3);margin-left:auto;flex-shrink:0}

/* DIRECT HLS */
.hls-body{padding:1.4rem;display:flex;flex-direction:column;gap:1rem;flex:1}
.hls-row{display:flex;gap:.65rem}
.btn-go{padding:.62rem 1.1rem;background:var(--accent);border:none;border-radius:8px;color:#000;
  font-family:'Rajdhani',sans-serif;font-weight:700;font-size:.95rem;cursor:pointer;transition:opacity .2s;white-space:nowrap}
.btn-go:hover{opacity:.82}

/* CONTEXT MENU */
.ctx-menu{position:fixed;background:var(--s2);border:1px solid var(--b2);border-radius:9px;
  padding:.35rem;z-index:500;box-shadow:0 12px 32px #00000060;min-width:140px;animation:fadeIn .12s ease}
.ctx-item{padding:.42rem .75rem;font-size:.78rem;color:var(--t1);cursor:pointer;border-radius:6px;transition:all .15s;display:flex;align-items:center;gap:.5rem}
.ctx-item:hover{background:var(--b2)}
.ctx-item.red{color:var(--danger)}

/* THEME PICKER */
.theme-row{display:flex;gap:.4rem;padding:0 1rem;margin-bottom:.5rem;flex-wrap:wrap}
.theme-swatch{width:18px;height:18px;border-radius:50%;cursor:pointer;border:2px solid transparent;transition:all .2s;flex-shrink:0}
.theme-swatch.on{border-color:var(--t1);transform:scale(1.2)}

/* STATES */
.loading{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.875rem;color:var(--t2)}
.spinner{width:32px;height:32px;border:3px solid var(--b2);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.6rem;color:var(--t2);text-align:center}
.empty-icon{font-size:2.5rem;opacity:.25}
.empty-t{font-size:.92rem;font-weight:500}
.empty-s{font-size:.75rem;color:var(--t3);max-width:260px;line-height:1.5}

/* SCROLLBAR */
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--s3);border-radius:3px}

/* MODAL */
.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:400;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
.modal{background:var(--s1);border:1px solid var(--b2);border-radius:14px;padding:1.5rem;width:100%;max-width:360px;box-shadow:0 24px 60px #000000a0}
.modal-title{font-family:'Rajdhani',sans-serif;font-size:1.2rem;font-weight:700;margin-bottom:1.2rem}
.profile-edit-row{display:flex;gap:.5rem;margin-bottom:1rem;align-items:center}
.profile-color-pick{display:flex;gap:.35rem;flex-wrap:wrap;margin-bottom:1rem}
.pcp{width:20px;height:20px;border-radius:50%;cursor:pointer;border:2px solid transparent;transition:all .2s;flex-shrink:0}
.pcp.on{border-color:var(--t1);transform:scale(1.15)}
.modal-btns{display:flex;gap:.5rem;justify-content:flex-end}
.btn-cancel{padding:.45rem .9rem;background:var(--s2);border:1px solid var(--b2);border-radius:7px;
  color:var(--t2);font-family:'DM Sans',sans-serif;font-size:.8rem;cursor:pointer}
.btn-confirm{padding:.45rem .9rem;background:var(--accent);border:none;border-radius:7px;
  color:#000;font-family:'Rajdhani',sans-serif;font-size:.88rem;font-weight:700;cursor:pointer}

/* DISCOVER */
.discover-body{flex:1;overflow-y:auto;padding:1.2rem 1.4rem}
.disc-hero{background:var(--s1);border:1px solid var(--b1);border-radius:14px;padding:1.6rem;margin-bottom:1.6rem;
  display:flex;align-items:flex-end;gap:1.2rem;min-height:180px;position:relative;overflow:hidden;cursor:pointer;transition:border-color .2s}
.disc-hero:hover{border-color:var(--b2)}
.disc-hero-bg{position:absolute;inset:0;object-fit:cover;width:100%;height:100%;opacity:.2;pointer-events:none}
.disc-hero-info{position:relative;z-index:1;max-width:600px}
.disc-hero-title{font-family:'Rajdhani',sans-serif;font-size:1.8rem;font-weight:700;line-height:1.1;
  text-shadow:0 2px 12px rgba(0,0,0,.8)}
.disc-hero-meta{font-size:.78rem;color:var(--t2);margin:.3rem 0 .7rem;text-shadow:0 1px 6px rgba(0,0,0,.8)}
.disc-hero-overview{font-size:.8rem;color:var(--t2);line-height:1.55;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;
  text-shadow:0 1px 6px rgba(0,0,0,.8)}
.disc-hero-avail{margin-top:.7rem;font-size:.75rem;color:var(--accent);font-weight:600}
.disc-section{margin-bottom:1.6rem}
.disc-row{display:flex;gap:.65rem;overflow-x:auto;padding-bottom:.4rem}
.disc-row::-webkit-scrollbar{height:3px}
.disc-card{flex-shrink:0;width:112px;cursor:pointer;transition:transform .2s;position:relative}
.disc-card:hover{transform:translateY(-3px)}
.disc-poster{width:112px;aspect-ratio:2/3;object-fit:cover;border-radius:9px;background:var(--s2);display:block;
  border:1px solid var(--b1)}
.disc-poster-ph{width:112px;aspect-ratio:2/3;background:var(--s2);border-radius:9px;border:1px solid var(--b1);
  display:flex;align-items:center;justify-content:center;font-size:2rem}
.disc-card-title{font-size:.68rem;font-weight:500;margin-top:.38rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.disc-card-meta{font-size:.6rem;color:var(--t3);margin-top:.1rem}
.disc-rating{position:absolute;top:.4rem;left:.4rem;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);
  padding:.15rem .38rem;border-radius:4px;font-size:.6rem;font-weight:700;color:var(--accent)}
.disc-in-lib{position:absolute;bottom:.45rem;right:.45rem;background:var(--accent);border-radius:50%;
  width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;color:#000}
.disc-key-prompt{display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:1rem;flex:1;text-align:center;padding:2rem}

/* SERIES DETAIL MODAL */
.series-modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:400;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px)}
.series-modal{background:var(--s1);border:1px solid var(--b2);border-radius:16px;width:100%;max-width:640px;max-height:85vh;
  box-shadow:0 32px 80px #000000b0;display:flex;flex-direction:column;overflow:hidden;animation:fadeUp .2s ease}
.series-modal-header{display:flex;align-items:flex-start;gap:1rem;padding:1.4rem 1.4rem .8rem;flex-shrink:0}
.series-modal-poster{width:90px;aspect-ratio:2/3;object-fit:cover;border-radius:10px;background:var(--s2);flex-shrink:0}
.series-modal-poster-ph{width:90px;aspect-ratio:2/3;background:var(--s2);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:2.2rem;flex-shrink:0}
.series-modal-info{flex:1;min-width:0}
.series-modal-title{font-family:'Rajdhani',sans-serif;font-size:1.4rem;font-weight:700;line-height:1.2;margin-bottom:.25rem}
.series-modal-meta{font-size:.78rem;color:var(--t2);margin-bottom:.35rem}
.series-modal-desc{font-size:.76rem;color:var(--t2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.series-modal-close{background:none;border:none;color:var(--t2);font-size:1.3rem;cursor:pointer;padding:.2rem .4rem;margin-left:auto;flex-shrink:0;transition:color .15s;line-height:1}
.series-modal-close:hover{color:var(--danger)}
.series-modal-body{flex:1;overflow-y:auto;padding:0 1.4rem 1.4rem}
.series-seasons-tabs{display:flex;gap:.3rem;background:var(--s2);padding:4px;border-radius:10px;margin-bottom:1rem;flex-wrap:wrap}
.series-season-tab{padding:.4rem .75rem;background:none;border:none;border-radius:7px;color:var(--t2);
  font-family:'DM Sans',sans-serif;font-size:.75rem;font-weight:500;cursor:pointer;transition:all .2s;white-space:nowrap}
.series-season-tab.on{background:var(--s3);color:var(--accent);box-shadow:0 2px 8px #00000040}
.series-ep-list{display:flex;flex-direction:column;gap:.4rem}
.series-ep-item{display:flex;align-items:center;gap:.75rem;padding:.6rem .8rem;background:var(--s2);border:1px solid var(--b1);
  border-radius:9px;cursor:pointer;transition:all .15s}
.series-ep-item:hover{border-color:var(--b2);background:var(--s3)}
.series-ep-item.loading{opacity:.6;pointer-events:none}
.series-ep-num{width:28px;height:28px;border-radius:50%;background:${t.accent}18;color:var(--accent);font-size:.72rem;font-weight:700;
  display:flex;align-items:center;justify-content:center;flex-shrink:0}
.series-ep-name{font-size:.82rem;font-weight:500;flex:1}
.series-ep-play{font-size:.85rem;opacity:.5;transition:opacity .15s;flex-shrink:0}
.series-ep-item:hover .series-ep-play{opacity:1}
.series-loading{display:flex;align-items:center;justify-content:center;gap:.65rem;padding:2rem;color:var(--t2);font-size:.85rem}
`;
}

// ══════════════════════════════════════════════════════════════════
// PLAYER COMPONENT (TiviMate-level keyboard + OSD + PiP + quick-ch)
// ══════════════════════════════════════════════════════════════════
function Player({ item, channelList, epgData, onClose, onFav, isFav, connType }) {
  const videoRef   = useRef(null);
  const hlsRef     = useRef(null);
  const mpegtsRef  = useRef(null);
  const osdTimer   = useRef(null);
  const [osd, setOsd]         = useState(true);
  const [showQCH, setShowQCH] = useState(false);
  const [qchTimer, setQchTimer] = useState(null);
  const [chIdx, setChIdx]     = useState(() => {
    if (!channelList) return -1;
    return channelList.findIndex(c => c.id === item.id || c.url === item.url);
  });
  const [current, setCurrent] = useState(item);

  const showOSD = useCallback(() => {
    setOsd(true);
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(false), 3500);
  }, []);

  function destroyPlayers() {
    if (hlsRef.current)    { hlsRef.current.destroy();  hlsRef.current = null; }
    if (mpegtsRef.current) { mpegtsRef.current.destroy(); mpegtsRef.current = null; }
  }

  const [streamErr, setStreamErr] = useState(null);

  const isMixed = location.protocol === "https:" ? (u) => u?.startsWith("http://") : () => false;
  // Proxy streams through STREAM_PROXY (may differ from API proxy) — skip if already proxied
  const streamProxy = (u) => (u?.startsWith(PROXY) || u?.startsWith(STREAM_PROXY)) ? u : `${STREAM_PROXY}/stream?url=${encodeURIComponent(u)}`;

  function initPlayer(url) {
    const video = videoRef.current;
    if (!video || !url) return;
    setStreamErr(null);
    destroyPlayers();
    video.removeAttribute("src");

    function startHls(u) {
      if (window.Hls?.isSupported()) {
        const opts = { enableWorker: false, fragLoadingMaxRetry: 2 };
        // On HTTPS pages, proxy HTTP streams through Cloudflare Worker
        if (isMixed(u)) {
          u = streamProxy(u);
          opts.xhrSetup = (xhr, xhrUrl) => {
            if (xhrUrl.startsWith("http://")) xhr.open("GET", streamProxy(xhrUrl));
          };
        }
        const hls = new window.Hls(opts);
        hlsRef.current = hls;
        hls.loadSource(u);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(()=>{}));
        hls.on(window.Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return;
          const code = data.response?.code;
          let title = "Playback Error";
          let body;
          if (code === 404) {
            title = "Stream Not Found (404)";
            body = "The stream URL returned 404. The channel may be offline, or its URL may have changed. Try reconnecting to refresh the channel list.";
          } else if (code === 403) {
            title = "Access Denied (403)";
            body = "The stream server rejected the request. Your credentials may not have access to this channel.";
          } else if (code >= 500) {
            title = `Server Error (${code})`;
            body = "The stream server returned an error. It may be overloaded or temporarily down.";
          } else if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            title = "Network Error";
            body = "Could not reach the stream server. Check your connection or try again.";
          } else {
            body = `HLS error: ${data.details}${code ? ` (HTTP ${code})` : ""}`;
          }
          setStreamErr({ icon: "⚠️", title, body });
          destroyPlayers();
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = isMixed(u) ? streamProxy(u) : u; video.play().catch(()=>{});
      }
    }

    function startMpegts(u) {
      // Proxy HTTP streams through Cloudflare Worker when on HTTPS
      if (isMixed(u)) u = streamProxy(u);
      if (!window.mpegts?.isSupported()) {
        video.src = u; video.play().catch(()=>{}); return;
      }
      const player = window.mpegts.createPlayer({ type: "mpegts", isLive: true, url: u },
        { enableWorker: false, lazyLoadMaxDuration: 3 * 60, seekType: "range" });
      mpegtsRef.current = player;
      player.attachMediaElement(video);
      player.load();
      player.play().catch(()=>{});
    }

    function loadScript(src, cb) {
      if (document.querySelector(`script[src="${src}"]`)) { cb(); return; }
      const s = document.createElement("script");
      s.src = src; s.onload = cb; document.head.appendChild(s);
    }

    // Detect Xtream VOD URLs: /movie/user/pass/id.ext (should use HLS, not mpegts)
    const xtreamVodMatch = url.match(/^(https?:\/\/[^/]+\/)movie\/([^/]+\/[^/]+\/\d+)\.\w+$/);
    if (xtreamVodMatch) {
      // Rewrite VOD URL to .m3u8 — Xtream servers support HLS for VOD
      const hlsUrl = xtreamVodMatch[1] + "movie/" + xtreamVodMatch[2] + ".m3u8";
      if (window.Hls) startHls(hlsUrl);
      else loadScript("https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.12/hls.min.js",
                      () => startHls(hlsUrl));
      return;
    }

    // Stalker VOD/series items are direct video files (MKV, MP4, etc.) served by the portal.
    // They should NOT use mpegts.js (which is for live TS streams). Play them via the
    // <video> element directly, or via HLS if the URL ends in .m3u8.
    const isStalkerVod = (current.type === "vod" || current.type === "series")
      && (url.includes("/play/movie.php") || url.includes("/play/live.php") || url.includes("play_token="));
    if (isStalkerVod) {
      if (url.includes(".m3u8")) {
        if (window.Hls) startHls(url);
        else loadScript("https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.12/hls.min.js",
                        () => startHls(url));
      } else {
        // Direct video file — proxy if needed for mixed content, let <video> handle it
        video.src = isMixed(url) ? streamProxy(url) : url; video.play().catch(()=>{});
      }
      return;
    }

    const needTs  = url.includes("extension=ts") || /\.ts(\?|$)/.test(url)
      || (current.type === "live" && !url.includes(".m3u8"));
    const needHls = !needTs && (url.includes(".m3u8") || url.includes("/live/") || url.includes("/movie/"));

    // For Xtream live streams on HTTPS, prefer HLS (.m3u8) over raw TS since we can proxy HLS segments
    const xtreamBase = url.match(/^(https?:\/\/[^/]+\/)[^/]+\/[^/]+\/(\d+)$/);
    if (needTs && isMixed(url) && xtreamBase) {
      // Rewrite to .m3u8 — Xtream servers support both formats
      const hlsUrl = xtreamBase[1] + url.split("/").slice(3).join("/") + ".m3u8";
      if (window.Hls) startHls(hlsUrl);
      else loadScript("https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.12/hls.min.js",
                      () => startHls(hlsUrl));
      return;
    }

    if (needTs) {
      if (window.mpegts) startMpegts(url);
      else loadScript("https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js",
                      () => startMpegts(url));
    } else if (needHls) {
      if (window.Hls) startHls(url);
      else loadScript("https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.12/hls.min.js",
                      () => startHls(url));
    } else {
      video.src = isMixed(url) ? streamProxy(url) : url; video.play().catch(()=>{});
    }
  }

  useEffect(() => {
    initPlayer(current.url);
    showOSD();
    return () => {
      destroyPlayers();
      clearTimeout(osdTimer.current);
    };
  }, [current.url]);

  // Keyboard shortcuts (TiviMate + SFVIP style)
  useEffect(() => {
    function onKey(e) {
      const v = videoRef.current;
      if (!v) return;
      if (e.target.tagName === "INPUT") return;
      switch(e.key) {
        case " ":
        case "k":
          e.preventDefault();
          v.paused ? v.play() : v.pause();
          showOSD(); break;
        case "f":
        case "F":
          document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen?.();
          break;
        case "m":
        case "M":
          v.muted = !v.muted; showOSD(); break;
        case "ArrowLeft":
          e.preventDefault();
          if (current.type === "live") prevChannel();
          else { v.currentTime = Math.max(0, v.currentTime - 10); showOSD(); }
          break;
        case "ArrowRight":
          e.preventDefault();
          if (current.type === "live") nextChannel();
          else { v.currentTime = Math.min(v.duration||0, v.currentTime + 10); showOSD(); }
          break;
        case "ArrowUp":
          e.preventDefault();
          if (current.type === "live") prevChannel();
          else { v.volume = Math.min(1, v.volume + 0.1); showOSD(); }
          break;
        case "ArrowDown":
          e.preventDefault();
          if (current.type === "live") nextChannel();
          else { v.volume = Math.max(0, v.volume - 0.1); showOSD(); }
          break;
        case "Escape":
          onClose(); break;
        case "p":
        case "P":
          pip(); break;
        default: break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, chIdx]);

  function prevChannel() {
    if (!channelList || channelList.length === 0) return;
    const i = Math.max(0, (chIdx < 0 ? 0 : chIdx) - 1);
    setChIdx(i); setCurrent(channelList[i]);
    setShowQCH(true);
    clearTimeout(qchTimer);
    setQchTimer(setTimeout(() => setShowQCH(false), 2500));
    showOSD();
  }

  function nextChannel() {
    if (!channelList || channelList.length === 0) return;
    const max = channelList.length - 1;
    const i = Math.min(max, (chIdx < 0 ? 0 : chIdx) + 1);
    setChIdx(i); setCurrent(channelList[i]);
    setShowQCH(true);
    clearTimeout(qchTimer);
    setQchTimer(setTimeout(() => setShowQCH(false), 2500));
    showOSD();
  }

  async function pip() {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture?.();
    } catch {}
  }

  const epgNow = getEPGNow(epgData, current.epgId);
  const qchChannels = channelList && chIdx >= 0
    ? channelList.slice(Math.max(0, chIdx-2), Math.min(channelList.length, chIdx+3))
    : [];

  return (
    <div className="player-ov" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="player-wrap">
        <div style={{ position:"relative" }}>
          <video ref={videoRef} className="player-video" controls playsInline />
          {streamErr && (
            <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",
              background:"rgba(0,0,0,.88)",padding:"2rem",textAlign:"center"}}>
              <div style={{maxWidth:"400px"}}>
                <div style={{fontSize:"2.2rem",marginBottom:".75rem"}}>{streamErr.icon}</div>
                <div style={{fontSize:".9rem",color:"var(--t1)",fontWeight:600,marginBottom:".5rem"}}>{streamErr.title}</div>
                <div style={{fontSize:".78rem",color:"var(--t2)",lineHeight:1.6}}>{streamErr.body}</div>
              </div>
            </div>
          )}
          {/* OSD */}
          {osd && (
            <div className="osd" onClick={showOSD}>
              {current.logo
                ? <img className="osd-logo" src={current.logo} alt="" onError={e => e.target.style.display="none"} />
                : <div className="osd-logo-ph">{current.type==="live"?"📺":"🎬"}</div>}
              <div>
                {current.num && <div className="osd-num">CH {current.num}</div>}
                <div className="osd-name">{current.name}</div>
                {epgNow && <div className="osd-epg">▶ {epgNow.title}</div>}
              </div>
            </div>
          )}
          {/* Quick channel switcher */}
          {showQCH && channelList && (
            <div className="qch">
              {qchChannels.map((ch, i) => {
                const isActive = ch.id === current.id || ch.url === current.url;
                return (
                  <div key={ch.id||i} className={`qch-item ${isActive?"active":""}`}>
                    {ch.logo
                      ? <img className="qch-thumb" src={ch.logo} alt="" onError={e => e.target.style.display="none"} />
                      : <div className="qch-thumb-ph">📺</div>}
                    <div className="qch-n">{ch.name}</div>
                    {ch.num && <div className="qch-num">{ch.num}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="player-bar">
          <div style={{flex:1,overflow:"hidden"}}>
            <div className="player-title">
              {current.name}
              {current.group && <span className="badge">{current.group}</span>}
            </div>
            {epgNow && <div className="player-epg">▶ {epgNow.title}</div>}
          </div>
          {channelList && current.type === "live" && (
            <>
              <button className="player-ctrl" onClick={prevChannel}>◀ Prev</button>
              <button className="player-ctrl" onClick={nextChannel}>Next ▶</button>
            </>
          )}
          <button className="player-ctrl" onClick={pip} title="Picture in Picture">⧉ PiP</button>
          <button className="player-ctrl" onClick={() => { onFav?.(current); showOSD(); }} title="Favorite">
            {isFav?.(current) ? "♥ Fav" : "♡ Fav"}
          </button>
          <button className="player-close" onClick={onClose}>✕ Close</button>
        </div>
        <div className="kbd-hint">
          <span><span className="kbd">Space</span>Play/Pause</span>
          <span><span className="kbd">F</span>Fullscreen</span>
          <span><span className="kbd">M</span>Mute</span>
          <span><span className="kbd">←→</span>{current.type==="live"?"Channels":"±10s"}</span>
          <span><span className="kbd">↑↓</span>{current.type==="live"?"Channels":"Volume"}</span>
          <span><span className="kbd">P</span>PiP</span>
          <span><span className="kbd">Esc</span>Close</span>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════════
function Setup({ onConnect }) {
  const [type, setType]     = useState("xtream");
  const [f, setF]           = useState({ server:"", user:"", pass:"", mac:"", url:"", serial:"", deviceId:"", deviceId2:"" });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rawText, setRawText] = useState("");
  const [detected, setDetected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr]       = useState("");
  const set = (k,v) => setF(p => ({...p,[k]:v}));

  useEffect(() => {
    const saved = localStorage.getItem("sv-lastConn");
    if (saved) {
      try {
        const c = JSON.parse(saved);
        if (c.type) setType(c.type);
        if (c.server) set("server", c.server);
        if (c.user) set("user", c.user);
        if (c.pass) set("pass", c.pass);
        if (c.mac) set("mac", c.mac);
        if (c.url) set("url", c.url);
        if (c.serial) set("serial", c.serial);
        if (c.deviceId) set("deviceId", c.deviceId);
        if (c.deviceId2) set("deviceId2", c.deviceId2);
      } catch {}
    }
  }, []);

  async function connect() {
    setErr(""); setLoading(true);
    try {
      if (type === "xtream") {
        if (!f.server||!f.user||!f.pass) throw new Error("All fields required");
        const server = f.server.trim().replace(/\/$/,"");
        const api = makeXtreamAPI(server, f.user, f.pass);
        const data = await api.auth();
        if (data?.user_info?.auth === 0) throw new Error("Invalid credentials");
        localStorage.setItem("sv-lastConn", JSON.stringify({ type, ...f }));
        onConnect({ type, server, user:f.user, pass:f.pass, info:data?.user_info });
      } else if (type === "m3u") {
        if (!f.url) throw new Error("Playlist URL required");
        const res = await proxyFetch(f.url.trim());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text.includes("#EXTM3U")) throw new Error("Not a valid M3U playlist");
        const channels = parseM3U(text);
        if (!channels.length) throw new Error("No channels found");
        localStorage.setItem("sv-lastConn", JSON.stringify({ type, ...f }));
        onConnect({ type, url:f.url, channels });
      } else if (type === "stalker") {
        if (!f.server||!f.mac) throw new Error("Portal URL and MAC required");
        const server = f.server.trim().replace(/\/$/,"");
        const hs = await fetch(`${PROXY}/stalker/handshake`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ portal: server, mac: f.mac.trim(), serial:f.serial?.trim()||undefined, deviceId:f.deviceId?.trim()||undefined, deviceId2:(f.deviceId2?.trim()||f.deviceId?.trim())||undefined })
        });
        const hsData = await hs.json();
        if (!hs.ok || hsData.error) throw new Error(hsData.error || "Stalker handshake failed");
        localStorage.setItem("sv-lastConn", JSON.stringify({ type, ...f }));
        onConnect({ type, server, mac:f.mac.trim(), serial:f.serial.trim()||undefined, deviceId:f.deviceId.trim()||undefined, deviceId2:(f.deviceId2.trim()||f.deviceId.trim())||undefined });
      } else {
        localStorage.setItem("sv-lastConn", JSON.stringify({ type, ...f }));
        onConnect({ type:"hls" });
      }
    } catch(e) { setErr(e.message||"Connection failed"); }
    finally { setLoading(false); }
  }

  function normalizeUnicode(t) {
    return t
      // Mathematical Monospace A-Z (U+1D670-U+1D689) and a-z (U+1D68A-U+1D6A3)
      .replace(/[\u{1D670}-\u{1D689}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D670 + 0x41))
      .replace(/[\u{1D68A}-\u{1D6A3}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D68A + 0x61))
      // Mathematical Bold A-Z (U+1D400-U+1D419) and a-z (U+1D41A-U+1D433)
      .replace(/[\u{1D400}-\u{1D419}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D400 + 0x41))
      .replace(/[\u{1D41A}-\u{1D433}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D41A + 0x61))
      // Mathematical Bold Italic A-Z (U+1D468-U+1D481) and a-z (U+1D482-U+1D49B)
      .replace(/[\u{1D468}-\u{1D481}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D468 + 0x41))
      .replace(/[\u{1D482}-\u{1D49B}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D482 + 0x61))
      // Mathematical Sans-Serif A-Z (U+1D5A0-U+1D5B9) and a-z (U+1D5BA-U+1D5D3)
      .replace(/[\u{1D5A0}-\u{1D5B9}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D5A0 + 0x41))
      .replace(/[\u{1D5BA}-\u{1D5D3}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D5BA + 0x61))
      // Mathematical Sans-Serif Bold A-Z (U+1D5D4-U+1D5ED) and a-z (U+1D5EE-U+1D607)
      .replace(/[\u{1D5D4}-\u{1D5ED}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D5D4 + 0x41))
      .replace(/[\u{1D5EE}-\u{1D607}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D5EE + 0x61))
      // Mathematical Italic A-Z (U+1D434-U+1D44D) and a-z (U+1D44E-U+1D467)
      .replace(/[\u{1D434}-\u{1D44D}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D434 + 0x41))
      .replace(/[\u{1D44E}-\u{1D467}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D44E + 0x61))
      // Normalize arrow separators to colon
      .replace(/[\u27A9\u279C\u2794\u2192\u25BA\u21D2\u27F9]/g, ':')
      // Strip box-drawing characters
      .replace(/[\u2560\u2563\u2551\u2557\u2554\u255A\u255D\u256C\u2569\u2566\u251C\u2524\u2502\u2510\u2518\u2514\u250C\u252C\u2534\u253C\u2500\u2550]/g, '')
      // Strip enclosed alphanumerics (regional/circled letters used as decorators)
      .replace(/[\u{1F150}-\u{1F169}\u{1F170}-\u{1F18F}\u{1F190}-\u{1F1AC}]/gu, '')
      // Strip keycap digit sequences (e.g., 1️⃣) and decorators like ❖
      .replace(/[\d]\uFE0F?\u20E3/gu, '')
      .replace(/[\u2756]/g, '');
  }

  function detectFromText(text) {
    // Normalize Unicode-decorated text to plain ASCII before parsing
    text = normalizeUnicode(text);
    const results = [];

    // Detect Stalker portals + MACs + serial + deviceId + deviceId2 by proximity in text
    const portalPattern = /https?:\/\/[^\s"'<>]+\/(?:stalker_portal\/)?c\/?/gi;
    const macPattern = /([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/g;

    // Split text into blocks (by double newline or portal URL) and pair within each block
    const lines = text.split("\n");
    let blocks = [], cur = [];
    const portalTestRe = /https?:\/\/[^\s"'<>]+\/(?:stalker_portal\/)?c\/?/i;
    for (const line of lines) {
      if (portalTestRe.test(line) && cur.length > 0) { blocks.push(cur.join("\n")); cur = []; }
      cur.push(line);
    }
    if (cur.length) blocks.push(cur.join("\n"));
    if (blocks.length <= 1) blocks = [text]; // fallback: treat as single block

    const usedMacs = new Set();
    for (const block of blocks) {
      const bp = block.match(portalPattern) || [];
      portalPattern.lastIndex = 0;
      const bm = block.match(macPattern) || [];
      macPattern.lastIndex = 0;

      // Extract serial: look for "serial", "sn", "s/n" labels followed by value
      const serialMatch = block.match(/(?:serial(?:\s*(?:number|num|#))?|s\/n|sn)\s*[:=\s]\s*([A-Za-z0-9_-]+)/i);
      const serial = serialMatch ? serialMatch[1] : "";

      // Extract deviceId2: look for "device id 2", "deviceid2", "device_id_2" labels (check this BEFORE deviceId)
      const deviceId2Match = block.match(/(?:device[\s_-]*id[\s_-]*2|deviceid2|device_id_2)\s*[:=\s]\s*([A-Za-z0-9_-]+)/i);
      let deviceId2 = deviceId2Match ? deviceId2Match[1] : "";

      // Extract deviceId: look for "device id", "deviceid", "device_id" labels (excluding "device id 2" variants)
      const deviceIdMatch = block.match(/(?:device[\s_-]*id|deviceid|device_id)(?![\s_-]*2)\s*[:=\s]\s*([A-Za-z0-9_-]+)/i);
      const deviceId = deviceIdMatch ? deviceIdMatch[1] : "";

      // If only one device ID is found, use it for both (common in decorated text where one value is shared)
      if (deviceId && !deviceId2) deviceId2 = deviceId;

      if (bp.length && bm.length) {
        const portal = bp[0].replace(/\/+$/,"");
        const mac = bm[0];
        if (!usedMacs.has(mac)) {
          usedMacs.add(mac);
          results.push({ type:"stalker", server:portal, mac, serial, deviceId, deviceId2, label:`Stalker · ${mac.slice(-5)}` });
        }
      } else if (bm.length) {
        bm.forEach(mac => { if (!usedMacs.has(mac)) { usedMacs.add(mac); results.push({ type:"stalker", server:"", mac, serial, deviceId, deviceId2, label:`MAC · ${mac}` }); } });
      }
    }

    // Detect Xtream: http://host:port with username/password patterns
    const xtreamPattern = /https?:\/\/[^\s"'<>:]+:\d+\/get\.php\?username=([^&]+)&password=([^&\s]+)/gi;
    let xm;
    while ((xm = xtreamPattern.exec(text)) !== null) {
      const url = new URL(xm[0]);
      results.push({ type:"xtream", server:`${url.protocol}//${url.host}`, user:xm[1], pass:xm[2], label:`Xtream · ${xm[1]}` });
    }

    // Also detect Xtream from player_api.php URLs
    const xtreamApi = /https?:\/\/[^\s"'<>:]+:\d+\/player_api\.php\?username=([^&]+)&password=([^&\s]+)/gi;
    while ((xm = xtreamApi.exec(text)) !== null) {
      const url = new URL(xm[0]);
      if (!results.find(r => r.type==="xtream" && r.server===`${url.protocol}//${url.host}` && r.user===xm[1])) {
        results.push({ type:"xtream", server:`${url.protocol}//${url.host}`, user:xm[1], pass:xm[2], label:`Xtream · ${xm[1]}` });
      }
    }

    // Also detect bare Xtream format: host:port/username/password
    const bareXtream = /https?:\/\/([^\s"'<>:]+:\d+)\/live\/([^/\s]+)\/([^/\s]+)/gi;
    while ((xm = bareXtream.exec(text)) !== null) {
      const server = `http://${xm[1]}`;
      if (!results.find(r => r.type==="xtream" && r.user===xm[2])) {
        results.push({ type:"xtream", server, user:xm[2], pass:xm[3], label:`Xtream · ${xm[2]}` });
      }
    }

    // Detect M3U URLs
    const m3uPattern = /https?:\/\/[^\s"'<>]+\.m3u8?(?:\?[^\s"'<>]*)?/gi;
    const m3us = text.match(m3uPattern) || [];
    m3us.forEach(url => {
      if (!results.find(r => r.type==="m3u" && r.url===url)) {
        results.push({ type:"m3u", url, label:`M3U · ${url.split("/").pop()?.slice(0,20)}` });
      }
    });

    // Also detect M3U from get.php type URLs (these are often Xtream m3u output)
    const m3uGet = /https?:\/\/[^\s"'<>]+\/get\.php\?[^\s"'<>]*/gi;
    const m3uGets = text.match(m3uGet) || [];
    m3uGets.forEach(url => {
      if (!results.find(r => r.url===url)) {
        results.push({ type:"m3u", url, label:`M3U · get.php` });
      }
    });

    return results;
  }

  const TYPES = [["import","Import"],["xtream","Xtream Codes"],["m3u","M3U Playlist"],["stalker","Stalker Portal"],["hls","Direct HLS"]];

  return (
    <div className="setup">
      <div className="card">
        <div className="logo">STREAMVAULT</div>
        <div className="tagline">Your personal IPTV client · Connect your own legal service</div>
        {err && <div className="err">⚠ {err}</div>}
        <div className="tabs">
          {TYPES.map(([k,label]) => (
            <button key={k} className={`tab ${type===k?"on":""}`} onClick={() => {setType(k);setErr("")}}>
              {label}
            </button>
          ))}
        </div>
        {type==="xtream" && (<>
          <div className="fg"><label className="fl">Server URL</label>
            <input className="fi" placeholder="http://server.com:8080" value={f.server} onChange={e=>set("server",e.target.value)} /></div>
          <div className="fg"><label className="fl">Username</label>
            <input className="fi" placeholder="username" value={f.user} onChange={e=>set("user",e.target.value)} /></div>
          <div className="fg"><label className="fl">Password</label>
            <input className="fi" type="password" placeholder="password" value={f.pass} onChange={e=>set("pass",e.target.value)} /></div>
        </>)}
        {type==="m3u" && (
          <div className="fg"><label className="fl">M3U Playlist URL</label>
            <input className="fi" placeholder="http://example.com/playlist.m3u" value={f.url} onChange={e=>set("url",e.target.value)} />
            <div className="fhint">Supports .m3u and .m3u8 playlist files</div></div>
        )}
        {type==="stalker" && (<>
          <div className="fg"><label className="fl">Portal URL</label>
            <input className="fi" placeholder="http://server/stalker_portal/c/" value={f.server} onChange={e=>set("server",e.target.value)} /></div>
          <div className="fg"><label className="fl">MAC Address</label>
            <input className="fi" placeholder="00:1A:79:XX:XX:XX" value={f.mac} onChange={e=>set("mac",e.target.value)} />
            <div className="fhint">The MAC address registered with your IPTV provider</div></div>
          <div style={{marginTop:".5rem"}}>
            <button type="button" style={{background:"none",border:"none",color:"var(--accent)",fontSize:".72rem",cursor:"pointer",padding:0,fontFamily:"'DM Sans',sans-serif"}}
              onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? "▾ Hide advanced" : "▸ Advanced options"}
            </button>
          </div>
          {showAdvanced && (<>
            <div className="fg"><label className="fl">Serial Number</label>
              <input className="fi" placeholder="Optional — leave blank for auto" value={f.serial} onChange={e=>set("serial",e.target.value)} />
              <div className="fhint">Device serial number (if required by provider)</div></div>
            <div className="fg"><label className="fl">Device ID</label>
              <input className="fi" placeholder="Optional — used for both ID1 and ID2 if ID2 is blank" value={f.deviceId} onChange={e=>set("deviceId",e.target.value)} />
              <div className="fhint">Primary device identifier</div></div>
            <div className="fg"><label className="fl">Device ID 2</label>
              <input className="fi" placeholder="Optional — defaults to Device ID above" value={f.deviceId2} onChange={e=>set("deviceId2",e.target.value)} />
              <div className="fhint">Secondary device identifier (some providers use same value for both)</div></div>
          </>)}
        </>)}
        {type==="hls" && (
          <div style={{padding:"1rem 0",color:"var(--t2)",fontSize:".86rem",lineHeight:1.7}}>
            Play any HLS stream, M3U8 URL, or direct media URL instantly — no account needed.
          </div>
        )}
        {type==="import" && (
          <div>
            <div className="fg">
              <label className="fl">Paste raw text, URLs, or config</label>
              <textarea className="fi" style={{minHeight:"120px",resize:"vertical",fontFamily:"monospace",fontSize:".75rem"}}
                placeholder={"Paste any text containing:\n• Stalker portal URLs + MAC addresses\n• Xtream Codes URLs with username/password\n• M3U/M3U8 playlist URLs\n\nAuto-detects all connection types."}
                value={rawText}
                onChange={e => { setRawText(e.target.value); setDetected(detectFromText(e.target.value)); }}
              />
            </div>
            {detected.length > 0 && (
              <div style={{display:"flex",flexDirection:"column",gap:".4rem",marginBottom:"1rem"}}>
                <div className="fl">Detected ({detected.length})</div>
                {detected.map((d, i) => (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:".5rem",padding:".45rem .65rem",
                    background:"var(--s2)",border:"1px solid var(--b2)",borderRadius:"8px",cursor:"pointer",transition:"all .2s"}}
                    onClick={() => {
                      if (d.type==="stalker") { setType("stalker"); set("server",d.server); set("mac",d.mac); if(d.serial){set("serial",d.serial);setShowAdvanced(true);} if(d.deviceId){set("deviceId",d.deviceId);setShowAdvanced(true);} if(d.deviceId2){set("deviceId2",d.deviceId2);setShowAdvanced(true);} else if(d.deviceId){set("deviceId2",d.deviceId);} }
                      else if (d.type==="xtream") { setType("xtream"); set("server",d.server); set("user",d.user); set("pass",d.pass); }
                      else if (d.type==="m3u") { setType("m3u"); set("url",d.url); }
                    }}
                    onMouseEnter={e=>e.currentTarget.style.borderColor="var(--accent)"}
                    onMouseLeave={e=>e.currentTarget.style.borderColor="var(--b2)"}>
                    <span style={{fontSize:".7rem",fontWeight:700,color:"var(--accent)",textTransform:"uppercase",minWidth:"50px"}}>{d.type}</span>
                    <span style={{fontSize:".78rem",color:"var(--t1)",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.label}</span>
                    <span style={{fontSize:".65rem",color:"var(--t3)"}}>Click to fill →</span>
                  </div>
                ))}
              </div>
            )}
            {rawText && detected.length === 0 && (
              <div style={{fontSize:".78rem",color:"var(--t3)",padding:".5rem 0"}}>No connections detected in the pasted text.</div>
            )}
          </div>
        )}
        <button className="btn-primary" onClick={connect} disabled={loading || type==="import"} style={type==="import"?{display:"none"}:{}}>
          {loading ? "Connecting…" : "Connect →"}
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PROFILE MODAL
// ══════════════════════════════════════════════════════════════════
function ProfileModal({ onSave, onCancel }) {
  const [name, setName]   = useState("Profile");
  const [color, setColor] = useState(PROFILE_COLORS[0]);
  return (
    <div className="modal-ov" onClick={e => e.target===e.currentTarget && onCancel()}>
      <div className="modal">
        <div className="modal-title">New Profile</div>
        <div className="profile-edit-row">
          <input className="fi" style={{flex:1}} placeholder="Profile name" value={name} onChange={e=>setName(e.target.value)} />
        </div>
        <div style={{fontSize:".7rem",color:"var(--t3)",marginBottom:".5rem",textTransform:"uppercase",letterSpacing:".08em",fontWeight:600}}>Colour</div>
        <div className="profile-color-pick">
          {PROFILE_COLORS.map(c => (
            <div key={c} className={`pcp ${color===c?"on":""}`} style={{background:c}} onClick={() => setColor(c)} />
          ))}
        </div>
        <div className="modal-btns">
          <button className="btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="btn-confirm" onClick={() => onSave({id:uid(), name:name||"Profile", color})}>Create</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// CARD HELPERS
// ══════════════════════════════════════════════════════════════════
function FavBtn({ on, onClick, style={} }) {
  return (
    <button className={`fav-btn ${on?"on":""}`} style={style} title={on?"Remove from favorites":"Add to favorites"}
      onClick={e => { e.stopPropagation(); onClick(); }}>
      {on ? "♥" : "♡"}
    </button>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════
const NAV = [
  { key:"discover",  icon:"✨", label:"Discover",          section:"Watch" },
  { key:"live",      icon:"📺", label:"Live TV",          section:"Watch" },
  { key:"vod",       icon:"🎬", label:"Movies",            section:"Watch" },
  { key:"series",    icon:"📽", label:"Series",            section:"Watch" },
  { key:"favs",      icon:"♥",  label:"Favorites",         section:"Watch" },
  { key:"continue",  icon:"⏯",  label:"Continue Watching", section:"Watch" },
  { key:"epg",       icon:"📋", label:"TV Guide",          section:"Tools" },
  { key:"search",    icon:"🔍", label:"Global Search",     section:"Tools" },
  { key:"hls",       icon:"▶",  label:"Direct Play",       section:"Tools" },
];

export default function App() {
  // ── connection & data
  const [conn, setConn]       = useState(null);
  const [channels, setChannels] = useState([]);
  const [vod, setVod]         = useState([]);
  const [series, setSeries]   = useState([]);
  const [loading, setLoading] = useState(false);

  // ── series detail modal
  const [seriesDetail, setSeriesDetail] = useState(null); // {item, seasons, activeSeason}
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [episodeLoading, setEpisodeLoading] = useState(null); // episode number being loaded

  // ── ui state
  const [section, setSection] = useState("live");
  const [cat, setCat]         = useState("All");
  const [search, setSearch]   = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;
  const [globalQ, setGlobalQ] = useState("");
  const [playing, setPlaying] = useState(null);
  const [ctx, setCtx]         = useState(null); // context menu {x,y,catName}

  // ── theme
  const [themeName, setThemeName] = useState("Dark");

  // ── profiles
  const [profiles, setProfiles]   = useState([{id:"default",name:"Me",color:PROFILE_COLORS[0]}]);
  const [activeProfile, setActiveProfile] = useState("default");
  const [showProfileModal, setShowProfileModal] = useState(false);

  // ── favorites {live:{}, vod:{}, series:{}}
  const [favs, setFavs] = useState({live:{}, vod:{}, series:{}});

  // ── history [{id,name,url,type,logo,group,position,timestamp}]
  const [history, setHistory] = useState([]);

  // ── hidden cats per section
  const [hiddenCats, setHiddenCats] = useState({live:[], vod:[], series:[]});

  // ── EPG
  const [epgURL, setEpgURL]   = useState("");
  const [epgData, setEpgData] = useState(null);
  const [epgLoading, setEpgLoading] = useState(false);

  // ── Stalker lazy-load
  const [stalkerVodCats,    setStalkerVodCats]    = useState([]); // [{id,title,count}]
  const [stalkerSeriesCats, setStalkerSeriesCats] = useState([]); // [{id,title,count}]
  const [loadedCatIds,      setLoadedCatIds]      = useState({ vod: new Set(), series: new Set() });
  const [catLoading,        setCatLoading]        = useState(false);
  const fetchingCatRef = useRef(new Set());  // tracks in-progress category fetches
  const [prefetchProgress, setPrefetchProgress] = useState(null); // {done,total} or null

  // ── last synced timestamps
  const [lastSynced, setLastSynced] = useState({}); // {live: timestamp, vod: timestamp, series: timestamp}
  const [autoConnected, setAutoConnected] = useState(false); // true if loaded from IDB cache

  // ── TMDB
  const [tmdbKey, setTmdbKey] = useState(() => localStorage.getItem("sv-tmdb-key") || "");

  // ── CSS injection
  useEffect(() => {
    const el = document.getElementById("sv-css") || (() => { const s = document.createElement("style"); s.id="sv-css"; document.head.appendChild(s); return s; })();
    el.textContent = genCSS(THEMES[themeName]);
  }, [themeName]);

  // ── load persisted data + auto-connect from IDB
  useEffect(() => {
    (async () => {
      const [th, pr, ap, fv, hi, hc, eq] = await Promise.all([
        db.get("sv-theme","Dark"),
        db.get("sv-profiles",[{id:"default",name:"Me",color:PROFILE_COLORS[0]}]),
        db.get("sv-activeProfile","default"),
        db.get("sv-favs-default",{live:{},vod:{},series:{}}),
        db.get("sv-history",[]),
        db.get("sv-hiddenCats",{live:[],vod:[],series:[]}),
        db.get("sv-epgURL",""),
      ]);
      if (THEME_NAMES.includes(th)) setThemeName(th);
      setProfiles(pr); setActiveProfile(ap);
      setFavs(fv); setHistory(hi); setHiddenCats(hc);
      if (eq) setEpgURL(eq);

      // Auto-connect: if we have a saved connection + cached content in IDB, skip Setup
      try {
        const saved = localStorage.getItem("sv-lastConn");
        if (saved) {
          const lastConn = JSON.parse(saved);
          const cId = connId(lastConn);
          if (cId) {
            const cachedChannels = await idbCache.get(`content:${cId}:live`);
            if (cachedChannels && cachedChannels.length) {
              setConn(lastConn);
              setChannels(cachedChannels);
              setAutoConnected(true);
              // Also load VOD, series, stalker categories from IDB
              const [cachedVod, cachedSeries] = await Promise.all([
                idbCache.get(`content:${cId}:vod`),
                idbCache.get(`content:${cId}:series`),
              ]);
              if (cachedVod) setVod(cachedVod);
              if (cachedSeries) setSeries(cachedSeries);
              if (lastConn.type === "stalker") {
                const [vc, sc] = await Promise.all([
                  idbCache.get(`cats:${cId}:vod`),
                  idbCache.get(`cats:${cId}:series`),
                ]);
                if (vc) setStalkerVodCats(vc);
                if (sc) setStalkerSeriesCats(sc);
              }
              // Load last-synced timestamps
              const syncTs = await idbCache.get(`sync:${cId}`);
              if (syncTs) setLastSynced(syncTs);
            }
          }
        }
      } catch {}
    })();
  }, []);

  // ── save theme
  useEffect(() => {
    db.set("sv-theme", themeName);
    syncPreferencesToD1({ theme: themeName });
  }, [themeName]);

  // ── load favs when profile changes
  useEffect(() => {
    db.get(`sv-favs-${activeProfile}`, {live:{},vod:{},series:{}}).then(setFavs);
  }, [activeProfile]);

  // ── connection
  useEffect(() => {
    if (!conn) return;
    // If auto-connected from IDB cache, skip fetching from provider
    if (autoConnected) {
      setAutoConnected(false);
      // Still load EPG (transient, not cached)
      if (conn.type === "stalker") loadStalkerEPG();
      else if (epgURL) loadEPG(epgURL);
      return;
    }
    if (conn.type === "m3u") {
      setChannels(conn.channels);
      // Save M3U channels to IDB for persistence
      const cId = connId(conn);
      if (cId && conn.channels?.length) {
        idbCache.set(`content:${cId}:live`, conn.channels);
        syncContentToD1(cId, "live", conn.channels);
        idbCache.set(`sync:${cId}`, { ...lastSynced, live: Date.now() });
        setLastSynced(prev => ({ ...prev, live: Date.now() }));
      }
      if (epgURL) loadEPG(epgURL);
    } else if (conn.type === "xtream") {
      fetchLive();
      // Pre-fetch VOD + series in background so they're ready when user switches tabs
      fetchVOD(false, true);
      fetchSeries(false, true);
      if (epgURL) loadEPG(epgURL);
    } else if (conn.type === "stalker") {
      fetchStalkerChannels();
      // Pre-fetch VOD + series categories + items in background
      loadStalkerCats("vod", false, true);
      loadStalkerCats("series", false, true);
      loadStalkerEPG();
    }
    // Save connection to D1
    const cId = connId(conn);
    if (cId) {
      syncConnectionToD1(cId, conn.type, conn);
    }
  }, [conn]);

  async function fetchLive(force = false) {
    if (!conn || conn.type !== "xtream") return;
    const cId = connId(conn);
    // Check IDB first (unless force refresh)
    if (!force && cId) {
      const cached = await idbCache.get(`content:${cId}:live`);
      if (cached && cached.length) { setChannels(cached); return; }
    }
    setLoading(true);
    try {
      const api = makeXtreamAPI(conn.server, conn.user, conn.pass);
      const [catData, sd] = await Promise.all([api.getLiveCategories(), api.getLive()]);
      const cm = Object.fromEntries(catData.map(c => [c.category_id, c.category_name]));
      const items = sd.map(s => ({ id:String(s.stream_id), name:s.name, logo:s.stream_icon,
        group:cm[s.category_id]||"Other", url:api.liveURL(s.stream_id), num:s.num, epgId:s.epg_channel_id, type:"live" }));
      setChannels(items);
      // Persist to IDB + D1
      if (cId) {
        idbCache.set(`content:${cId}:live`, items);
        syncContentToD1(cId, "live", items);
        const now = Date.now();
        setLastSynced(prev => { const n = { ...prev, live: now }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }

  async function fetchVOD(force = false, background = false) {
    if (!conn || conn.type !== "xtream") return;
    const cId = connId(conn);
    // Check IDB first (unless force refresh)
    if (!force && cId && !vod.length) {
      const cached = await idbCache.get(`content:${cId}:vod`);
      if (cached && cached.length) { setVod(cached); return; }
    }
    if (!force && vod.length) return;
    if (!background) setLoading(true);
    try {
      const api = makeXtreamAPI(conn.server, conn.user, conn.pass);
      const [catData, sd] = await Promise.all([api.getVODCategories(), api.getVOD()]);
      const cm = Object.fromEntries(catData.map(c => [c.category_id, c.category_name]));
      const items = sd.map(s => ({ id:String(s.stream_id), name:s.name, logo:s.stream_icon,
        group:cm[s.category_id]||"Other", url:api.vodURL(s.stream_id, s.container_extension||"mp4"),
        year:s.year, rating:s.rating, type:"vod" }));
      setVod(items);
      if (cId) {
        idbCache.set(`content:${cId}:vod`, items);
        syncContentToD1(cId, "vod", items);
        const now = Date.now();
        setLastSynced(prev => { const n = { ...prev, vod: now }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    } catch(e) { console.error(e); }
    finally { if (!background) setLoading(false); }
  }

  async function fetchSeries(force = false, background = false) {
    if (!conn || conn.type !== "xtream") return;
    const cId = connId(conn);
    if (!force && cId && !series.length) {
      const cached = await idbCache.get(`content:${cId}:series`);
      if (cached && cached.length) { setSeries(cached); return; }
    }
    if (!force && series.length) return;
    if (!background) setLoading(true);
    try {
      const api = makeXtreamAPI(conn.server, conn.user, conn.pass);
      const [catData, sd] = await Promise.all([api.getSeriesCategories(), api.getSeries()]);
      const cm = Object.fromEntries(catData.map(c => [c.category_id, c.category_name]));
      const items = sd.map(s => ({ id:String(s.series_id), name:s.name, logo:s.cover,
        group:cm[s.category_id]||"Other", year:s.releaseDate?.slice(0,4), rating:s.rating, type:"series" }));
      setSeries(items);
      if (cId) {
        idbCache.set(`content:${cId}:series`, items);
        syncContentToD1(cId, "series", items);
        const now = Date.now();
        setLastSynced(prev => { const n = { ...prev, series: now }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    } catch(e) { console.error(e); }
    finally { if (!background) setLoading(false); }
  }

  async function fetchStalkerChannels(force = false) {
    if (!conn || conn.type !== "stalker") return;
    const cId = connId(conn);
    const transformChannels = (list) => list.map(ch => {
      const raw = (ch.url || "").replace(/^ffmpeg\s+/, "").trim();
      const isDirect = raw.startsWith("http") && !raw.includes("localhost");
      return { ...ch, _stalkerCmd: ch.url, url: isDirect ? raw : null };
    });
    // Check IDB first (permanent, no TTL)
    if (!force && cId) {
      const cached = await idbCache.get(`content:${cId}:live`);
      if (cached && cached.length) { setChannels(cached); return; }
    }
    setLoading(true);
    try {
      const res = await fetch(`${PROXY}/stalker/channels?portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const items = transformChannels(data.channels || []);
      setChannels(items);
      // Persist to IDB (permanent) + D1
      if (cId) {
        idbCache.set(`content:${cId}:live`, items);
        syncContentToD1(cId, "live", items);
        const now = Date.now();
        setLastSynced(prev => { const n = { ...prev, live: now }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    } catch(e) { console.error("Stalker channels error:", e); }
    finally { setLoading(false); }
  }

  async function fetchStalkerVOD(force = false) {
    if (!conn || conn.type !== "stalker" || (!force && vod.length)) return;
    setLoading(true);
    try {
      const res = await fetch(`${PROXY}/stalker/vod?portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const items = (data.items || []).map(v => {
        const raw = (v.url || "").replace(/^ffmpeg\s+/, "").trim();
        const isDirect = raw.startsWith("http") && !raw.includes("localhost");
        const groupName = /^\d+$/.test(String(v.group)) ? "Movies" : (v.group || "Other");
        return { ...v, group: groupName, _stalkerCmd: v.url, url: isDirect ? raw : null };
      });
      setVod(items);
      const cId = connId(conn);
      if (cId) {
        idbCache.set(`content:${cId}:vod`, items);
        syncContentToD1(cId, "vod", items);
      }
    } catch(e) { console.error("Stalker VOD error:", e); }
    finally { setLoading(false); }
  }

  async function fetchStalkerSeries(force = false) {
    if (!conn || conn.type !== "stalker" || (!force && series.length)) return;
    setLoading(true);
    try {
      const res = await fetch(`${PROXY}/stalker/series?portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const items = (data.items || []).map(s => ({
        ...s,
        group: /^\d+$/.test(String(s.group)) ? "Series" : (s.group || "Other"),
      }));
      setSeries(items);
      const cId = connId(conn);
      if (cId) {
        idbCache.set(`content:${cId}:series`, items);
        syncContentToD1(cId, "series", items);
      }
    } catch(e) { console.error("Stalker series error:", e); }
    finally { setLoading(false); }
  }

  // ── Load category list for Stalker VOD / Series (permanent IDB cache, no TTL)
  // background=true: don't touch setCat/setLoading (used for pre-fetching on connect)
  async function loadStalkerCats(sec, force = false, background = false) {
    const cId = connId(conn);
    let cats = null;
    // Check IDB first (permanent, no TTL)
    if (!force && cId) {
      try { cats = await idbCache.get(`cats:${cId}:${sec}`); } catch {}
    }
    if (!cats) {
      if (!background) setLoading(true);
      try {
        const res  = await fetch(`${PROXY}/stalker/${sec}/categories?portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        cats = data.categories || [];
        // Save to IDB (permanent) + D1
        if (cId) {
          idbCache.set(`cats:${cId}:${sec}`, cats);
          syncCategoriesToD1(cId, sec, cats);
        }
      } catch(e) { console.error(`Stalker ${sec} cats:`, e); return; }
      finally { if (!background) setLoading(false); }
    }
    sec === "vod" ? setStalkerVodCats(cats) : setStalkerSeriesCats(cats);
    if (cats.length) {
      if (!background) {
        setCat(cats[0].title);
        loadStalkerCatItems(sec, cats[0].id, cats[0].title);
      }
      // Background prefetch all categories (silent)
      prefetchRemainingStalkerCats(sec, cats, force);
    }
  }

  // ── Load items for one Stalker category (permanent IndexedDB cache, no TTL)
  async function loadStalkerCatItems(sec, catId, catTitle, silent = false, force = false) {
    const refKey = `${sec}-${catId}`;
    if (fetchingCatRef.current.has(refKey)) return;
    fetchingCatRef.current.add(refKey);
    const cId = connId(conn);
    const CACHE_KEY = cId ? `catitems:${cId}:${sec}:${catId}` : `sv-s-${sec}item-${conn.server}-${catId}`;
    const applyItems = (items) => {
      const mapped = items.map(item => {
        // Skip transform if already transformed (loaded from IDB with _stalkerCmd)
        if (item._stalkerCmd !== undefined) return { ...item, group: catTitle };
        const raw = (item.url || "").replace(/^ffmpeg\s+/, "").trim();
        const isDirect = raw.startsWith("http") && !raw.includes("localhost");
        return { ...item, group: catTitle, _stalkerCmd: item.url, url: isDirect ? raw : null };
      });
      if (sec === "vod") setVod(prev => [...prev.filter(v => v.group !== catTitle), ...mapped]);
      else setSeries(prev => [...prev.filter(s => s.group !== catTitle), ...mapped]);
      setLoadedCatIds(prev => ({ ...prev, [sec]: new Set([...prev[sec], catId]) }));
    };
    if (!force) {
      try {
        const cached = await idbCache.get(CACHE_KEY);
        // No TTL — permanent cache
        if (cached) {
          const items = cached.items || cached;
          if (items.length) { applyItems(items); fetchingCatRef.current.delete(refKey); return; }
        }
      } catch {}
    }
    if (!silent) setCatLoading(true);
    try {
      const res  = await fetch(`${PROXY}/stalker/${sec}?portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}&cat=${catId}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const items = data.items || [];
      applyItems(items);
      // Save transformed items to IDB (permanent)
      const transformed = items.map(item => {
        const raw = (item.url || "").replace(/^ffmpeg\s+/, "").trim();
        const isDirect = raw.startsWith("http") && !raw.includes("localhost");
        return { ...item, _stalkerCmd: item.url, url: isDirect ? raw : null };
      });
      idbCache.set(CACHE_KEY, transformed);
    } catch(e) { console.error(`Stalker ${sec} cat items:`, e); }
    finally { if (!silent) setCatLoading(false); fetchingCatRef.current.delete(refKey); }
  }

  // ── Option F: background prefetch remaining categories sequentially
  async function prefetchRemainingStalkerCats(sec, cats, force = false) {
    setPrefetchProgress({ done: 0, total: cats.length });
    let done = 0;
    for (const cat of cats) {
      await loadStalkerCatItems(sec, cat.id, cat.title, true, force);
      done++;
      setPrefetchProgress({ done, total: cats.length });
    }
    setPrefetchProgress(null);
    // Full dataset save is handled by the debounced contentSaveEffect below
  }

  // ── Debounced save: persist vod/series to IDB + D1 when data stabilizes
  const contentSaveTimer = useRef(null);
  useEffect(() => {
    if (!conn) return;
    const cId = connId(conn);
    if (!cId) return;
    clearTimeout(contentSaveTimer.current);
    contentSaveTimer.current = setTimeout(() => {
      if (vod.length) {
        idbCache.set(`content:${cId}:vod`, vod);
        syncContentToD1(cId, "vod", vod);
        setLastSynced(prev => { const n = { ...prev, vod: Date.now() }; idbCache.set(`sync:${cId}`, n); return n; });
      }
      if (series.length) {
        idbCache.set(`content:${cId}:series`, series);
        syncContentToD1(cId, "series", series);
        setLastSynced(prev => { const n = { ...prev, series: Date.now() }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    }, 3000);
    return () => clearTimeout(contentSaveTimer.current);
  }, [vod, series, conn]);

  // Build /stalker/play URL — resolves token + streams in one CF Worker request (same IP)
  function stalkerPlayUrl(cmd, contentType = "live", episode = null) {
    let url = `${PROXY}/stalker/play?portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}&cmd=${encodeURIComponent(cmd)}&content_type=${encodeURIComponent(contentType)}`;
    if (episode) url += `&episode=${episode}`;
    return url;
  }

  async function resolveStalkerStream(item) {
    try {
      const contentType = item.type || "live";
      const playUrl = stalkerPlayUrl(item._stalkerCmd, contentType);
      // Try /stalker/play — if Worker can stream directly, use the play URL
      // If it returns JSON with fallback:true, the Worker couldn't stream (CF-to-CF block etc)
      // In that case, use the resolved URL through /stream proxy
      const res = await fetch(playUrl);
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        const data = await res.json();
        if (data.url) {
          const u = data.url;
          return (u.startsWith(PROXY) || u.startsWith(STREAM_PROXY)) ? u : `${STREAM_PROXY}/stream?url=${encodeURIComponent(u)}`;
        }
        if (data.error) throw new Error(data.error);
      }
      // Worker streamed successfully — use the play URL directly
      return playUrl;
    } catch(e) { console.error("Stream resolve error:", e); return null; }
  }

  async function loadEPG(url) {
    if (!url) return;
    setEpgLoading(true);
    try {
      const res = await proxyFetch(url);
      const text = await res.text();
      setEpgData(parseXMLTV(text));
      setEpgURL(url);
      db.set("sv-epgURL", url);
    } catch(e) { console.error("EPG error:", e); }
    finally { setEpgLoading(false); }
  }

  async function loadStalkerEPG() {
    if (!conn || conn.type !== "stalker") return;
    setEpgLoading(true);
    try {
      const res = await fetch(`${PROXY}/stalker/epg?portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}&period=4`);
      const data = await res.json();
      if (data.programs) setEpgData(data.programs);
    } catch(e) { console.error("Stalker EPG error:", e); }
    finally { setEpgLoading(false); }
  }

  function switchSection(s) {
    setSection(s); setSearch(""); setPage(1);
    if (s === "vod") {
      if (conn?.type === "stalker") { setCat(null); loadStalkerCats("vod"); }
      else { setCat("All"); fetchVOD(); }
    } else if (s === "series") {
      if (conn?.type === "stalker") { setCat(null); loadStalkerCats("series"); }
      else { setCat("All"); fetchSeries(); }
    } else {
      setCat("All");
    }
  }

  // ── favorites
  function toggleFav(item) {
    const type = item.type || "live";
    const newFavs = { ...favs, [type]: { ...favs[type] } };
    const key = item.id || item.url;
    if (newFavs[type][key]) delete newFavs[type][key];
    else newFavs[type][key] = { id:item.id, name:item.name, url:item.url, logo:item.logo, group:item.group, type };
    setFavs(newFavs);
    db.set(`sv-favs-${activeProfile}`, newFavs);
    syncFavoritesToD1(activeProfile, newFavs);
  }

  function isFav(item) {
    const type = item?.type || "live";
    return !!(item && favs[type]?.[item.id || item.url]);
  }

  // ── history / continue watching
  function addHistory(item) {
    const entry = { ...item, timestamp: Date.now(), position: 0 };
    const newH = [entry, ...history.filter(h => (h.id||h.url) !== (item.id||item.url))].slice(0, 60);
    setHistory(newH);
    db.set("sv-history", newH);
    syncHistoryToD1(newH);
  }

  async function playItem(item) {
    // If this is a series item, open the detail modal instead of playing
    if (item.type === "series") {
      openSeriesDetail(item);
      return;
    }
    if (conn?.type === "stalker" && item._stalkerCmd && !item.url) {
      const resolved = await resolveStalkerStream(item);
      if (!resolved) return;
      const resolved_item = { ...item, url: resolved };
      setPlaying(resolved_item);
      addHistory(resolved_item);
    } else {
      setPlaying(item);
      addHistory(item);
    }
  }

  // ── series detail (seasons/episodes)
  async function openSeriesDetail(item) {
    if (!item || item.type !== "series") return;
    setSeriesLoading(true);
    setSeriesDetail({ item, seasons: [], activeSeason: 0 });

    try {
      if (conn?.type === "stalker") {
        const res = await fetch(`${PROXY}/stalker/series/seasons?seriesId=${encodeURIComponent(item.id)}&portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const seasons = data.seasons || [];
        setSeriesDetail({ item, seasons, activeSeason: 0 });
      } else if (conn?.type === "xtream") {
        const api = makeXtreamAPI(conn.server, conn.user, conn.pass);
        const info = await api.getSeriesInfo(item.id);
        const seasonNums = Object.keys(info.episodes || {}).sort((a,b) => Number(a) - Number(b));
        const seasons = seasonNums.map(sn => ({
          id: `${item.id}:${sn}`,
          name: `Season ${sn}`,
          episodes: (info.episodes[sn] || []).map(ep => ({
            num: ep.episode_num,
            title: ep.title || `Episode ${ep.episode_num}`,
            id: ep.id,
            ext: ep.container_extension || "mp4",
          })),
        }));
        setSeriesDetail({ item, seasons, activeSeason: 0, xtreamInfo: info });
      }
    } catch(e) {
      console.error("Series detail error:", e);
      setSeriesDetail(null);
    } finally {
      setSeriesLoading(false);
    }
  }

  async function playSeriesEpisode(season, episodeNum) {
    if (!seriesDetail) return;
    setEpisodeLoading(episodeNum);
    try {
      if (conn?.type === "stalker") {
        // Resolve via /stalker/play — handles both direct streaming and fallback
        const playUrl = stalkerPlayUrl(season.cmd, "series", episodeNum);
        const res = await fetch(playUrl);
        const ct = res.headers.get("content-type") || "";
        let resolvedUrl = playUrl;
        if (ct.includes("json")) {
          const data = await res.json();
          if (data.url) resolvedUrl = (data.url.startsWith(PROXY) || data.url.startsWith(STREAM_PROXY)) ? data.url : `${STREAM_PROXY}/stream?url=${encodeURIComponent(data.url)}`;
        }
        const epItem = {
          id: `${seriesDetail.item.id}-s${seriesDetail.activeSeason}-e${episodeNum}`,
          name: `${seriesDetail.item.name} - ${season.name} E${episodeNum}`,
          url: resolvedUrl,
          logo: seriesDetail.item.logo,
          type: "vod",
          group: seriesDetail.item.group,
        };
        setPlaying(epItem);
        addHistory(epItem);
      } else if (conn?.type === "xtream") {
        const ep = season.episodes?.find(e => e.num == episodeNum || e.id == episodeNum);
        if (!ep) return;
        const api = makeXtreamAPI(conn.server, conn.user, conn.pass);
        const streamUrl = api.seriesStreamURL(ep.id, ep.ext || "mp4");
        const epItem = {
          id: `${seriesDetail.item.id}-e${ep.id}`,
          name: `${seriesDetail.item.name} - ${season.name} ${ep.title || `E${ep.num}`}`,
          url: streamUrl,
          logo: seriesDetail.item.logo,
          type: "vod",
          group: seriesDetail.item.group,
        };
        setPlaying(epItem);
        addHistory(epItem);
      }
    } catch(e) {
      console.error("Episode play error:", e);
    } finally {
      setEpisodeLoading(null);
    }
  }

  // ── profiles
  function addProfile(p) {
    const newP = [...profiles, p];
    setProfiles(newP);
    db.set("sv-profiles", newP);
    setActiveProfile(p.id);
    db.set("sv-activeProfile", p.id);
    setShowProfileModal(false);
  }

  function switchProfile(id) {
    setActiveProfile(id);
    db.set("sv-activeProfile", id);
  }

  // ── hidden cats
  function toggleHideCat(sec, catName) {
    const arr = hiddenCats[sec] || [];
    const newArr = arr.includes(catName) ? arr.filter(c=>c!==catName) : [...arr, catName];
    const newHc = { ...hiddenCats, [sec]: newArr };
    setHiddenCats(newHc);
    db.set("sv-hiddenCats", newHc);
  }

  function isCatHidden(sec, catName) {
    return (hiddenCats[sec]||[]).includes(catName);
  }

  // ── context menu close
  useEffect(() => {
    const close = () => setCtx(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  useEffect(() => { setPage(1); }, [cat, search, section]);

  function disconnect() {
    setConn(null); setChannels([]); setVod([]); setSeries([]);
    setStalkerVodCats([]); setStalkerSeriesCats([]);
    setLoadedCatIds({ vod: new Set(), series: new Set() });
    fetchingCatRef.current.clear(); setPrefetchProgress(null);
    setSection("live"); setPlaying(null); setCat("All");
  }

  // ── DERIVED DATA
  const getItems = useCallback((sec) => sec==="live"?channels : sec==="vod"?vod : series, [channels, vod, series]);

  const curCatsAll = useMemo(() => {
    if (conn?.type === "stalker" && (section === "vod" || section === "series")) {
      const apiCats = section === "vod" ? stalkerVodCats : stalkerSeriesCats;
      if (apiCats.length) return apiCats.map(c => c.title);
    }
    const items = getItems(section);
    return ["All", ...new Set(items.map(i=>i.group).filter(Boolean))];
  }, [conn, section, stalkerVodCats, stalkerSeriesCats, getItems]);

  const curItemsAll = useMemo(() => {
    if (!cat) return [];
    const items = getItems(section);
    return items.filter(item => {
      const catMatch = cat === "All" || item.group === cat;
      const searchMatch = !search || item.name?.toLowerCase().includes(search.toLowerCase());
      return catMatch && searchMatch;
    });
  }, [getItems, section, cat, search]);

  const favItems = useMemo(() => ({
    live: Object.values(favs.live||{}),
    vod:  Object.values(favs.vod||{}),
    series: Object.values(favs.series||{}),
  }), [favs]);
  const totalFavs = favItems.live.length + favItems.vod.length + favItems.series.length;

  const continueItems = useMemo(() =>
    history.filter(h => h.position > 5 && h.type !== "live").slice(0, 20),
  [history]);

  // ── global search
  const searchResults = useMemo(() => {
    if (globalQ.length <= 1) return [];
    const q = globalQ.toLowerCase();
    return [...channels, ...vod, ...series].filter(i => i.name?.toLowerCase().includes(q)).slice(0, 80);
  }, [globalQ, channels, vod, series]);

  if (!conn) return (
    <>
      <style>{genCSS(THEMES[themeName])}</style>
      <Setup onConnect={setConn} />
    </>
  );

  const LABEL = {discover:"Discover",live:"Live TV",vod:"Movies",series:"Series",favs:"Favorites",continue:"Continue Watching",epg:"TV Guide",search:"Global Search",hls:"Direct Play"};
  const activeProfile_obj = profiles.find(p=>p.id===activeProfile) || profiles[0];
  const curCats = ["live","vod","series"].includes(section) ? curCatsAll : [];
  const curItems = ["live","vod","series"].includes(section) ? curItemsAll : [];
  const totalPages = Math.ceil(curItems.length / PAGE_SIZE);
  const paginatedItems = curItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="app">
      {/* ── SIDEBAR ── */}
      <div className="sidebar">
        <div className="s-logo">STREAMVAULT</div>

        {/* Profiles */}
        <div className="profiles-row">
          {profiles.map(p => (
            <div key={p.id} className={`profile-dot ${p.id===activeProfile?"active":""}`}
              style={{background:p.color}} title={p.name}
              onClick={() => switchProfile(p.id)}>
              {p.name[0]?.toUpperCase()}
            </div>
          ))}
          {profiles.length < 4 && (
            <div className="profile-dot add" onClick={() => setShowProfileModal(true)} title="Add profile">+</div>
          )}
        </div>
        <div className="profile-name">{activeProfile_obj?.name}</div>

        {/* Themes */}
        <div className="theme-row">
          {THEME_NAMES.map(tn => (
            <div key={tn} className={`theme-swatch ${themeName===tn?"on":""}`}
              style={{background:THEMES[tn].accent}}
              title={tn}
              onClick={() => setThemeName(tn)} />
          ))}
        </div>

        {/* Nav */}
        {["Watch","Tools"].map(sec => (
          <div key={sec}>
            <div className="s-sect">{sec}</div>
            {NAV.filter(n=>n.section===sec).map(n => (
              <div key={n.key} className={`nav ${section===n.key?"on":""}`} onClick={() => switchSection(n.key)}>
                <span className="nav-icon">{n.icon}</span>
                <span>{n.label}</span>
                {n.key==="favs" && totalFavs > 0 && <span className="nav-badge">{totalFavs}</span>}
                {n.key==="continue" && continueItems.length > 0 && <span className="nav-badge">{continueItems.length}</span>}
              </div>
            ))}
          </div>
        ))}

        <div className="s-bottom">
          <div className="s-conn">
            {conn.type==="xtream" && `${conn.user} · Xtream`}
            {conn.type==="m3u" && `M3U · ${channels.length} channels`}
            {conn.type==="stalker" && conn.mac}
            {conn.type==="hls" && "Direct HLS"}
          </div>
          <div className="s-row">
            <button className="btn-sm danger" onClick={disconnect}>⏏ Disconnect</button>
          </div>
        </div>
      </div>

      {/* ── CONTENT ── */}
      <div className="content">
        {/* Header */}
        <div className="c-header">
          <span className="c-title">
            {LABEL[section]}
            {["live","vod","series"].includes(section) && curItems.length > 0 &&
              <span className="c-count">{curItems.length.toLocaleString()} items</span>}
          </span>
          {section==="live" && (
            <span style={{fontSize:".73rem"}}><span className="live-dot" />LIVE</span>
          )}
          {["live","vod","series"].includes(section) && (
            <>
              {conn?.type === "stalker" && (
                <>
                  <button className="c-btn" title="Reload from portal" onClick={() => {
                    if (section === "live") { setChannels([]); fetchStalkerChannels(true); }
                    else if (section === "vod" || section === "series") {
                      setVod(section === "vod" ? [] : vod);
                      setSeries(section === "series" ? [] : series);
                      if (section === "vod") setStalkerVodCats([]); else setStalkerSeriesCats([]);
                      setLoadedCatIds(prev => ({ ...prev, [section]: new Set() }));
                      fetchingCatRef.current.clear();
                      setCat(null);
                      loadStalkerCats(section, true);
                    }
                  }}>↺ Refresh</button>
                  {prefetchProgress && (
                    <span style={{fontSize:".68rem",color:"var(--t3)",whiteSpace:"nowrap"}}>
                      Loading {prefetchProgress.done}/{prefetchProgress.total} categories…
                    </span>
                  )}
                </>
              )}
              {conn?.type === "xtream" && (
                <button className="c-btn" title="Reload from provider" onClick={() => {
                  if (section === "live") { setChannels([]); fetchLive(true); }
                  else if (section === "vod") { setVod([]); fetchVOD(true); }
                  else if (section === "series") { setSeries([]); fetchSeries(true); }
                }}>↺ Refresh</button>
              )}
              {conn?.type === "m3u" && section === "live" && (
                <button className="c-btn" title="Re-fetch M3U playlist" onClick={async () => {
                  try {
                    setLoading(true);
                    const res = await proxyFetch(conn.url);
                    const text = await res.text();
                    const chs = parseM3U(text);
                    setChannels(chs);
                    const cId = connId(conn);
                    if (cId) {
                      idbCache.set(`content:${cId}:live`, chs);
                      syncContentToD1(cId, "live", chs);
                      setLastSynced(prev => ({ ...prev, live: Date.now() }));
                    }
                  } catch(e) { console.error("M3U refresh error:", e); }
                  finally { setLoading(false); }
                }}>↺ Refresh</button>
              )}
              {lastSynced[section] && (
                <span style={{fontSize:".62rem",color:"var(--t3)",whiteSpace:"nowrap"}} title={new Date(lastSynced[section]).toLocaleString()}>
                  Synced {(() => {
                    const mins = Math.floor((Date.now() - lastSynced[section]) / 60000);
                    if (mins < 1) return "just now";
                    if (mins < 60) return `${mins}m ago`;
                    const hrs = Math.floor(mins / 60);
                    if (hrs < 24) return `${hrs}h ago`;
                    return `${Math.floor(hrs / 24)}d ago`;
                  })()}
                </span>
              )}
              <div className="c-search-wrap">
                <span className="c-search-icon">🔍</span>
                <input className="c-search" placeholder={`Search ${LABEL[section]}…`}
                  value={search} onChange={e => setSearch(e.target.value)} />
              </div>
            </>
          )}
          {section==="search" && (
            <div className="c-search-wrap" style={{flex:1}}>
              <span className="c-search-icon">🔍</span>
              <input className="c-search" style={{width:"100%"}} placeholder="Search all content — Live, Movies, Series…"
                autoFocus
                value={globalQ} onChange={e => setGlobalQ(e.target.value)} />
            </div>
          )}
        </div>

        {/* Body */}
        {loading ? (
          <div className="loading"><div className="spinner" /><span>Loading {LABEL[section]}…</span></div>
        ) : section==="discover" ? (
          <DiscoverView tmdbKey={tmdbKey} setTmdbKey={setTmdbKey} vod={vod} series={series} onPlay={playItem} />
        ) : section==="hls" ? (
          <DirectHLSView />
        ) : section==="epg" ? (
          <EPGView channels={channels} epgData={epgData} epgURL={epgURL} setEpgURL={setEpgURL}
            epgLoading={epgLoading} loadEPG={loadEPG} onPlay={playItem} />
        ) : section==="search" ? (
          <GlobalSearch results={searchResults} query={globalQ} onPlay={playItem} toggleFav={toggleFav} isFav={isFav} />
        ) : section==="favs" ? (
          <FavsView favItems={favItems} onPlay={playItem} toggleFav={toggleFav} isFav={isFav} />
        ) : section==="continue" ? (
          <ContinueView items={continueItems} onPlay={playItem} history={history} />
        ) : (
          <div className="c-body">
            {/* Categories sidebar */}
            {curCats.length > 1 && (
              <div className="cats">
                {curCats.map(c => {
                  const hidden = c !== "All" && isCatHidden(section, c);
                  return (
                    <div key={c}
                      className={`cat ${cat===c?"on":""} ${hidden?"cat-hidden":""}`}
                      title={c}
                      onClick={() => {
                        if (hidden) return;
                        setCat(c);
                        if (conn?.type === "stalker" && (section === "vod" || section === "series")) {
                          const apiCats = section === "vod" ? stalkerVodCats : stalkerSeriesCats;
                          const catObj = apiCats.find(sc => sc.title === c);
                          if (catObj) loadStalkerCatItems(section, catObj.id, c);
                        }
                      }}
                      onContextMenu={e => {
                        e.preventDefault();
                        if (c !== "All") setCtx({x:e.clientX, y:e.clientY, sec:section, catName:c});
                      }}>
                      {c}
                    </div>
                  );
                })}
              </div>
            )}

            {cat === null && conn?.type === "stalker" && (section === "vod" || section === "series") ? (
              <div className="empty">
                <div className="empty-icon">📂</div>
                <div className="empty-t">Select a category</div>
                <div className="empty-s">Choose a category from the list above to load content.</div>
              </div>
            ) : catLoading && curItems.length === 0 ? (
              <div className="empty">
                <div className="empty-icon" style={{animation:"spin 1s linear infinite"}}>⏳</div>
                <div className="empty-t">Loading {cat}…</div>
                <div className="empty-s">Fetching items from portal.</div>
              </div>
            ) : curItems.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">{section==="live"?"📺":section==="vod"?"🎬":"📽"}</div>
                <div className="empty-t">No content found</div>
                <div className="empty-s">
                  {conn.type==="stalker" ? "Stalker portal browsing requires a backend proxy. Try Xtream Codes or M3U." : "Try a different category or clear your search."}
                </div>
              </div>
            ) : (
              <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"auto",minHeight:0}}>
                {section==="live" ? (
                  <div className="ch-grid">
                    {paginatedItems.map((ch,i) => {
                      const faved = isFav(ch);
                      const epgNow = getEPGNow(epgData, ch.epgId);
                      return (
                        <div key={ch.id||i} className={`ch-card ${playing?.id===ch.id?"playing":""}`}
                          onClick={() => playItem(ch)}>
                          {ch.logo
                            ? <img className="ch-logo" src={ch.logo} alt="" onError={e=>e.target.style.display="none"} />
                            : <div className="ch-logo-ph">📺</div>}
                          <div className="ch-name">{ch.name}</div>
                          {ch.num && <div className="ch-num">CH {ch.num}</div>}
                          {epgNow && <div className="ch-meta">▶ {epgNow.title}</div>}
                          <FavBtn on={faved} onClick={() => toggleFav(ch)} />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="vod-grid">
                    {paginatedItems.map((item,i) => {
                      const faved = isFav(item);
                      const hist = history.find(h=>(h.id||h.url)===(item.id||item.url));
                      const pct = hist?.position && hist?.duration ? Math.min(100, (hist.position/hist.duration)*100) : 0;
                      return (
                        <div key={item.id||i} className="vod-card" onClick={() => playItem(item)} title={item.name}>
                          {item.logo
                            ? <img className="vod-poster" src={item.logo} alt="" onError={e=>e.target.style.display="none"} />
                            : <div className="vod-ph">{section==="series"?"📽":"🎬"}</div>}
                          {pct > 2 && (
                            <div className="resume-bar"><div className="resume-fill" style={{width:`${pct}%`}} /></div>
                          )}
                          <div className="vod-info">
                            <div className="vod-title">{item.name}</div>
                            <div className="vod-meta">
                              {[item.year, item.rating && `★${parseFloat(item.rating||0).toFixed(1)}`].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                          <button className={`vod-fav ${faved?"on":""}`}
                            onClick={e=>{e.stopPropagation();toggleFav(item);}}>
                            {faved?"♥":"♡"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {totalPages > 1 && (
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:".5rem",padding:".75rem 0",width:"100%",flexShrink:0}}>
                    <button className="c-btn" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1}>← Prev</button>
                    <span style={{fontSize:".75rem",color:"var(--t2)"}}>Page {page} of {totalPages}</span>
                    <button className="c-btn" onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page===totalPages}>Next →</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── PLAYER ── */}
      {playing && (
        <Player item={playing}
          channelList={playing.type==="live" ? channels.filter(c=>c.group===playing.group||true) : null}
          epgData={epgData}
          onClose={() => setPlaying(null)}
          toggleFav={toggleFav}
          onFav={toggleFav}
          isFav={isFav}
          connType={conn?.type}
        />
      )}

      {/* ── CONTEXT MENU ── */}
      {ctx && (
        <div className="ctx-menu" style={{left:ctx.x, top:ctx.y}} onClick={e=>e.stopPropagation()}>
          <div className="ctx-item" onClick={() => {toggleHideCat(ctx.sec, ctx.catName);setCtx(null);}}>
            {isCatHidden(ctx.sec, ctx.catName) ? "👁 Show category" : "🙈 Hide category"}
          </div>
          <div className="ctx-item" onClick={() => {setCat(ctx.catName);setCtx(null);}}>
            📌 Filter to this
          </div>
        </div>
      )}

      {/* ── SERIES DETAIL MODAL ── */}
      {seriesDetail && (
        <div className="series-modal-ov" onClick={() => { if (!seriesLoading) setSeriesDetail(null); }}>
          <div className="series-modal" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="series-modal-header">
              {seriesDetail.item.logo
                ? <img className="series-modal-poster" src={seriesDetail.item.logo} alt="" onError={e => e.target.style.display="none"} />
                : <div className="series-modal-poster-ph">📽</div>}
              <div className="series-modal-info">
                <div className="series-modal-title">{seriesDetail.item.name}</div>
                <div className="series-modal-meta">
                  {[seriesDetail.item.year, seriesDetail.item.rating && `★${parseFloat(seriesDetail.item.rating||0).toFixed(1)}`].filter(Boolean).join(" · ")}
                  {seriesDetail.seasons.length > 0 && ` · ${seriesDetail.seasons.length} Season${seriesDetail.seasons.length > 1 ? "s" : ""}`}
                </div>
                {seriesDetail.item.description && (
                  <div className="series-modal-desc">{seriesDetail.item.description}</div>
                )}
              </div>
              <button className="series-modal-close" onClick={() => setSeriesDetail(null)} title="Close">✕</button>
            </div>
            {/* Body */}
            <div className="series-modal-body">
              {seriesLoading ? (
                <div className="series-loading">
                  <div className="spinner" />
                  <span>Loading seasons…</span>
                </div>
              ) : seriesDetail.seasons.length === 0 ? (
                <div style={{textAlign:"center",padding:"2rem",color:"var(--t2)",fontSize:".85rem"}}>
                  No seasons found for this series.
                </div>
              ) : (
                <>
                  {/* Season tabs */}
                  {seriesDetail.seasons.length > 1 && (
                    <div className="series-seasons-tabs">
                      {seriesDetail.seasons.map((s, idx) => (
                        <button key={s.id || idx}
                          className={`series-season-tab ${seriesDetail.activeSeason === idx ? "on" : ""}`}
                          onClick={() => setSeriesDetail(prev => ({ ...prev, activeSeason: idx }))}>
                          {s.name || `Season ${idx + 1}`}
                        </button>
                      ))}
                    </div>
                  )}
                  {seriesDetail.seasons.length === 1 && (
                    <div style={{fontSize:".8rem",fontWeight:600,color:"var(--t2)",marginBottom:".7rem"}}>
                      {seriesDetail.seasons[0].name || "Season 1"} — {seriesDetail.seasons[0].episodes.length} episode{seriesDetail.seasons[0].episodes.length !== 1 ? "s" : ""}
                    </div>
                  )}
                  {/* Episode list */}
                  <div className="series-ep-list">
                    {(() => {
                      const season = seriesDetail.seasons[seriesDetail.activeSeason];
                      if (!season) return null;
                      const episodes = conn?.type === "xtream"
                        ? season.episodes.map(ep => ({ num: ep.num || ep.id, label: ep.title || `Episode ${ep.num}` }))
                        : season.episodes.map(ep => ({ num: ep, label: `Episode ${ep}` }));
                      return episodes.map(ep => (
                        <div key={ep.num}
                          className={`series-ep-item ${episodeLoading === ep.num ? "loading" : ""}`}
                          onClick={() => playSeriesEpisode(season, ep.num)}>
                          <div className="series-ep-num">{ep.num}</div>
                          <div className="series-ep-name">{ep.label}</div>
                          {episodeLoading === ep.num
                            ? <div className="spinner" style={{width:16,height:16,borderWidth:2}} />
                            : <span className="series-ep-play">▶</span>}
                        </div>
                      ));
                    })()}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── PROFILE MODAL ── */}
      {showProfileModal && (
        <ProfileModal onSave={addProfile} onCancel={() => setShowProfileModal(false)} />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SUB-VIEWS
// ══════════════════════════════════════════════════════════════════
function FavsView({ favItems, onPlay, toggleFav, isFav }) {
  const all = [...favItems.live, ...favItems.vod, ...favItems.series];
  if (!all.length) return (
    <div className="empty">
      <div className="empty-icon">♡</div>
      <div className="empty-t">No favorites yet</div>
      <div className="empty-s">Click the ♡ icon on any channel or movie to add it here.</div>
    </div>
  );
  const groups = [["Live TV", favItems.live], ["Movies", favItems.vod], ["Series", favItems.series]];
  return (
    <div style={{flex:1,overflow:"auto",padding:"1.1rem 1.4rem",display:"flex",flexDirection:"column",gap:"1.5rem"}}>
      {groups.filter(([,items]) => items.length > 0).map(([label, items]) => (
        <div key={label} className="section-block">
          <div className="section-label">{label}</div>
          <div className={label==="Live TV" ? "ch-grid" : "vod-grid"}>
            {items.map((item,i) => label==="Live TV" ? (
              <div key={item.id||i} className="ch-card" onClick={() => onPlay(item)}>
                {item.logo ? <img className="ch-logo" src={item.logo} alt="" /> : <div className="ch-logo-ph">📺</div>}
                <div className="ch-name">{item.name}</div>
                <FavBtn on={true} onClick={() => toggleFav(item)} />
              </div>
            ) : (
              <div key={item.id||i} className="vod-card" onClick={() => onPlay(item)}>
                {item.logo ? <img className="vod-poster" src={item.logo} alt="" /> : <div className="vod-ph">🎬</div>}
                <div className="vod-info"><div className="vod-title">{item.name}</div></div>
                <button className="vod-fav on" onClick={e=>{e.stopPropagation();toggleFav(item);}}>♥</button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ContinueView({ items, onPlay, history }) {
  const recent = history.slice(0, 20);
  if (!recent.length) return (
    <div className="empty">
      <div className="empty-icon">⏯</div>
      <div className="empty-t">Nothing started yet</div>
      <div className="empty-s">Watch some content and it will appear here for easy resuming.</div>
    </div>
  );
  return (
    <div style={{flex:1,overflow:"auto",padding:"1.1rem 1.4rem",display:"flex",flexDirection:"column",gap:"1.5rem"}}>
      {items.length > 0 && (
        <div className="section-block">
          <div className="section-label">Resume Watching</div>
          <div className="cw-row">
            {items.map((item,i) => {
              const pct = item.duration ? Math.min(100,(item.position/item.duration)*100) : 0;
              return (
                <div key={item.id||i} className="cw-item" onClick={()=>onPlay(item)}>
                  {item.logo ? <img className="cw-poster" src={item.logo} alt="" style={{width:"100%",aspectRatio:"16/9",objectFit:"cover"}} /> : <div className="cw-poster">🎬</div>}
                  <div className="cw-prog-bar"><div className="cw-prog-fill" style={{width:`${pct}%`}} /></div>
                  <div className="cw-info">
                    <div className="cw-name">{item.name}</div>
                    <div className="cw-time">{fmtTime(item.position)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="section-block">
        <div className="section-label">Recently Watched</div>
        <div style={{display:"flex",flexDirection:"column",gap:".4rem"}}>
          {recent.map((item,i) => (
            <div key={item.id||i} style={{display:"flex",alignItems:"center",gap:".75rem",padding:".5rem .75rem",
              background:"var(--s1)",border:"1px solid var(--b1)",borderRadius:"9px",cursor:"pointer",transition:"all .2s"}}
              onClick={()=>onPlay(item)}
              onMouseEnter={e=>e.currentTarget.style.borderColor="var(--b2)"}
              onMouseLeave={e=>e.currentTarget.style.borderColor="var(--b1)"}>
              {item.logo ? <img style={{width:"30px",height:"30px",objectFit:"contain",borderRadius:"4px",background:"var(--s2)",flexShrink:0}} src={item.logo} alt="" /> : <div style={{width:"30px",height:"30px",background:"var(--s2)",borderRadius:"4px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:".75rem",flexShrink:0}}>{item.type==="live"?"📺":"🎬"}</div>}
              <div style={{flex:1,overflow:"hidden"}}>
                <div style={{fontSize:".8rem",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</div>
                <div style={{fontSize:".65rem",color:"var(--t3)"}}>{item.group} · {new Date(item.timestamp).toLocaleDateString()}</div>
              </div>
              <div style={{fontSize:".65rem",color:"var(--t3)",textTransform:"capitalize",flexShrink:0}}>{item.type}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GlobalSearch({ results, query, onPlay, toggleFav, isFav }) {
  if (!query || query.length < 2) return (
    <div className="empty">
      <div className="empty-icon">🔍</div>
      <div className="empty-t">Search everything</div>
      <div className="empty-s">Type above to search across Live TV, Movies, and Series simultaneously. Inspired by SFVIP's "All" category.</div>
    </div>
  );
  if (!results.length) return (
    <div className="empty"><div className="empty-icon">🔍</div><div className="empty-t">No results for "{query}"</div></div>
  );
  const byType = { live:results.filter(r=>r.type==="live"), vod:results.filter(r=>r.type==="vod"), series:results.filter(r=>r.type==="series") };
  const ICONS = {live:"📺",vod:"🎬",series:"📽"};
  const LABELS = {live:"Live TV",vod:"Movies",series:"Series"};
  return (
    <div className="gsearch">
      {Object.entries(byType).filter(([,items])=>items.length).map(([type,items]) => (
        <div key={type} className="gsearch-section">
          <div className="section-label">{LABELS[type]} <span style={{fontFamily:"'DM Sans'",fontWeight:400,color:"var(--t3)",textTransform:"none",letterSpacing:0}}>({items.length})</span></div>
          {items.map((item,i) => (
            <div key={item.id||i} className="gsearch-row" onClick={()=>onPlay(item)}>
              {item.logo ? <img className="gsearch-logo" src={item.logo} alt="" onError={e=>e.target.style.display="none"} /> : <div className="gsearch-logo-ph">{ICONS[type]}</div>}
              <div className="gsearch-name">{item.name}</div>
              <div className="gsearch-group">{item.group}</div>
              <button style={{background:"none",border:"none",cursor:"pointer",fontSize:".9rem",color:isFav(item)?"var(--accent)":"var(--t3)",padding:".1rem .2rem",transition:"color .2s"}}
                onClick={e=>{e.stopPropagation();toggleFav(item);}}>
                {isFav(item)?"♥":"♡"}
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function EPGView({ channels, epgData, epgURL, setEpgURL, epgLoading, loadEPG, onPlay }) {
  const [urlInput, setUrlInput] = useState(epgURL||"");
  const [search, setSearch] = useState("");

  // Build 8-slot time window centred on current hour
  const slots = useMemo(() => {
    const nowH = new Date().getHours();
    const startH = Math.max(0, nowH - 1);
    return Array.from({length:8}, (_,i) => {
      const h = startH + i;
      const base = new Date(); base.setHours(h, 0, 0, 0);
      return { label: `${String(h % 24).padStart(2,"0")}:00`, startMs: base.getTime(), endMs: base.getTime() + 3600000 };
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredChannels = useMemo(() => {
    if (!search) return channels;
    const q = search.toLowerCase();
    return channels.filter(ch => ch.name?.toLowerCase().includes(q));
  }, [channels, search]);

  return (
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div className="epg-top">
        <input className="fi" style={{flex:"1 1 260px",minWidth:0}} placeholder="XMLTV EPG URL (e.g. http://provider.com/epg.xml)" value={urlInput}
          onChange={e=>setUrlInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&loadEPG(urlInput)} />
        <button className="btn-go" onClick={()=>loadEPG(urlInput)} disabled={epgLoading} style={{padding:".4rem .9rem",fontSize:".82rem"}}>
          {epgLoading ? "Loading…" : "Load EPG"}
        </button>
        {channels.length > 0 && (
          <input className="fi" style={{width:"160px"}} placeholder="Filter channels…"
            value={search} onChange={e=>setSearch(e.target.value)} />
        )}
      </div>
      {!channels.length ? (
        <div className="empty"><div className="empty-icon">📋</div><div className="empty-t">No channels loaded</div><div className="empty-s">Connect via Xtream Codes or M3U to populate TV Guide.</div></div>
      ) : !epgData ? (
        <div className="empty">
          <div className="empty-icon">📅</div>
          <div className="empty-t">No EPG data</div>
          <div className="empty-s">Paste your XMLTV EPG URL above and click Load EPG.<br/>Your provider may supply one — check their portal or dashboard.</div>
        </div>
      ) : (
        <div className="epg-outer">
          <div className="epg-table">
            <div className="epg-head-row">
              <div className="epg-ch-col" style={{height:"32px"}} />
              {slots.map(s => <div key={s.label} className="epg-time-slot">{s.label}</div>)}
            </div>
            {filteredChannels.map((ch,i) => {
              const epgCh = epgLookup(epgData, ch);
              const now = Date.now();
              return (
                <div key={ch.id||i} className="epg-row">
                  <div className="epg-ch-cell" onClick={()=>onPlay(ch)} style={{cursor:"pointer"}}>
                    {ch.logo && <img className="epg-ch-logo" src={ch.logo} alt="" onError={e=>e.target.style.display="none"} />}
                    <span className="epg-ch-name" title={ch.name}>{ch.name}</span>
                  </div>
                  {slots.map((s, j) => {
                    const prog = epgCh?.find(p => p.start < s.endMs && p.stop > s.startMs);
                    const isNow = s.startMs <= now && s.endMs > now;
                    return (
                      <div key={j} className={`epg-prog ${isNow?"now":""}`} onClick={()=>onPlay(ch)}
                        title={prog ? `${prog.title}\n${new Date(prog.start).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})} – ${new Date(prog.stop).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}` : ""}>
                        <div className="epg-prog-t">{prog?.title || <span style={{opacity:.35}}>—</span>}</div>
                        <div className="epg-prog-s">{s.label}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function DirectHLSView() {
  const [url, setUrl] = useState("");
  const [playing, setPlaying] = useState(null);
  const EXAMPLES = [
    ["Apple HLS Bipbop (Adaptive)", "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8"],
    ["Big Buck Bunny (MP4)", "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"],
    ["Elephant Dream (MP4)", "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4"],
  ];
  return (
    <div className="hls-body">
      <div style={{fontSize:".84rem",color:"var(--t2)",lineHeight:1.6}}>
        Enter any HLS (.m3u8), DASH, or direct media URL. Great for testing your own streams.
      </div>
      <div className="hls-row">
        <input className="fi" placeholder="https://your-stream.com/live/stream.m3u8"
          value={url} onChange={e=>setUrl(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&url&&setPlaying({name:url.split("/").pop()||"Stream",url,type:"live",group:"Direct"})} />
        <button className="btn-go" onClick={()=>url&&setPlaying({name:url.split("/").pop()||"Stream",url,type:"live",group:"Direct"})}>▶ Play</button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:".35rem"}}>
        <div style={{fontSize:".7rem",color:"var(--t3)",textTransform:"uppercase",letterSpacing:".08em",fontWeight:600}}>Public test streams</div>
        {EXAMPLES.map(([label,href]) => (
          <div key={label} style={{fontSize:".75rem",color:"var(--accent)",cursor:"pointer",textDecoration:"underline"}}
            onClick={()=>{setUrl(href);setPlaying({name:label,url:href,type:"live",group:"Test"});}}>
            {label}
          </div>
        ))}
      </div>
      {playing && <Player item={playing} onClose={()=>setPlaying(null)} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// DISCOVER (TMDB)
// ══════════════════════════════════════════════════════════════════
const TMDB_IMG = "https://image.tmdb.org/t/p/";

function normalizeTitle(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function DiscoverView({ tmdbKey, setTmdbKey, vod, series, onPlay }) {
  const [keyInput, setKeyInput]           = useState(tmdbKey);
  const [trending, setTrending]           = useState([]);
  const [popularMovies, setPopularMovies] = useState([]);
  const [popularTV, setPopularTV]         = useState([]);
  const [loading, setLoading]             = useState(false);
  const [err, setErr]                     = useState("");
  const [picker, setPicker]               = useState(null); // { tmdbItem, matches[] }

  useEffect(() => { if (tmdbKey) loadAll(tmdbKey); }, [tmdbKey]);

  async function loadAll(key) {
    setLoading(true); setErr("");
    try {
      const base = "https://api.themoviedb.org/3";
      const [t, pm, ptv] = await Promise.all([
        fetch(`${base}/trending/all/week?api_key=${key}&language=en-US`).then(r => r.json()),
        fetch(`${base}/movie/popular?api_key=${key}&language=en-US`).then(r => r.json()),
        fetch(`${base}/tv/popular?api_key=${key}&language=en-US`).then(r => r.json()),
      ]);
      if (t.success === false) throw new Error(t.status_message || "Invalid API key");
      setTrending(t.results || []);
      setPopularMovies(pm.results || []);
      setPopularTV(ptv.results || []);
    } catch(e) {
      setErr(e.message);
      localStorage.removeItem("sv-tmdb-key");
      setTmdbKey("");
    } finally { setLoading(false); }
  }

  function saveKey() {
    const k = keyInput.trim();
    if (!k) return;
    localStorage.setItem("sv-tmdb-key", k);
    setTmdbKey(k);
  }

  // Return ALL library items that match the TMDB title
  const findAllInLibrary = useCallback((tmdbItem) => {
    const title = normalizeTitle(tmdbItem.title || tmdbItem.name);
    if (!title || title.length < 2) return [];
    return [...vod, ...series].filter(item => {
      const n = normalizeTitle(item.name);
      if (!n) return false;
      if (n === title) return true;
      // partial match only if both names are long enough to avoid false positives
      const minLen = Math.min(n.length, title.length);
      if (minLen >= 6 && (n.includes(title) || title.includes(n))) return true;
      return false;
    });
  }, [vod, series]);

  function handleCardClick(tmdbItem) {
    const matches = findAllInLibrary(tmdbItem);
    if (matches.length === 1) {
      onPlay(matches[0]);
    } else {
      // 0 matches → show "not found"; 2+ matches → show picker
      setPicker({ tmdbItem, matches });
    }
  }

  if (!tmdbKey) {
    return (
      <div className="disc-key-prompt">
        <div style={{fontSize:"2.5rem"}}>✨</div>
        <div style={{fontSize:"1rem",fontWeight:600}}>Discover Trending Content</div>
        <div style={{fontSize:".82rem",color:"var(--t2)",maxWidth:"360px",lineHeight:1.6}}>
          See what's trending on TMDB and find matches in your library.{" "}
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer"
            style={{color:"var(--accent)"}}>Get a free API key →</a>
        </div>
        {err && <div className="err" style={{maxWidth:"360px"}}>{err}</div>}
        <div style={{display:"flex",gap:".5rem",width:"100%",maxWidth:"380px"}}>
          <input className="fi" placeholder="Paste TMDB v3 API key…" value={keyInput}
            onChange={e=>setKeyInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&saveKey()} />
          <button className="btn-go" style={{padding:".62rem .9rem",fontSize:".84rem"}} onClick={saveKey}>Go</button>
        </div>
      </div>
    );
  }

  if (loading) return <div className="loading"><div className="spinner" /><span>Loading trending…</span></div>;

  const hero = trending[0];

  function TMDBCard({ item }) {
    const matches = findAllInLibrary(item);
    const inLib   = matches.length > 0;
    const poster  = item.poster_path ? `${TMDB_IMG}w185${item.poster_path}` : null;
    const year    = (item.release_date || item.first_air_date || "").slice(0, 4);
    const rating  = item.vote_average ? item.vote_average.toFixed(1) : null;
    const title   = item.title || item.name || "Unknown";
    return (
      <div className="disc-card" onClick={() => handleCardClick(item)} title={title}>
        {poster
          ? <img className="disc-poster" src={poster} alt={title} />
          : <div className="disc-poster-ph">{item.media_type === "tv" ? "📺" : "🎬"}</div>}
        {rating && <div className="disc-rating">★{rating}</div>}
        {inLib && <div className="disc-in-lib" title={`${matches.length} match${matches.length>1?"es":""} in library`}>
          {matches.length > 1 ? matches.length : "▶"}
        </div>}
        <div className="disc-card-title">{title}</div>
        <div className="disc-card-meta">{[year, item.media_type === "tv" ? "TV" : "Film"].filter(Boolean).join(" · ")}</div>
      </div>
    );
  }

  return (
    <div className="discover-body">
      {/* Hero */}
      {hero && (() => {
        const heroMatches = findAllInLibrary(hero);
        return (
          <div className="disc-hero" onClick={() => handleCardClick(hero)}>
            {hero.backdrop_path && (
              <img className="disc-hero-bg" src={`${TMDB_IMG}w1280${hero.backdrop_path}`} alt="" />
            )}
            <div className="disc-hero-info">
              <div className="disc-hero-title">{hero.title || hero.name}</div>
              <div className="disc-hero-meta">
                {[(hero.release_date||hero.first_air_date||"").slice(0,4),
                  hero.vote_average && `★ ${hero.vote_average.toFixed(1)}`,
                  hero.media_type === "tv" ? "TV Series" : "Movie"
                ].filter(Boolean).join(" · ")}
              </div>
              {hero.overview && <div className="disc-hero-overview">{hero.overview}</div>}
              {heroMatches.length > 0 && (
                <div className="disc-hero-avail">
                  {heroMatches.length === 1 ? "▶ In your library — click to play" : `▶ ${heroMatches.length} matches in your library — click to choose`}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Trending This Week */}
      <div className="disc-section">
        <div className="section-label">Trending This Week</div>
        <div className="disc-row">
          {trending.map((item, i) => <TMDBCard key={item.id || i} item={item} />)}
        </div>
      </div>

      {/* Popular Movies */}
      <div className="disc-section">
        <div className="section-label">Popular Movies</div>
        <div className="disc-row">
          {popularMovies.map((item, i) => <TMDBCard key={item.id || i} item={{...item, media_type:"movie"}} />)}
        </div>
      </div>

      {/* Popular TV */}
      <div className="disc-section">
        <div className="section-label">Popular TV Shows</div>
        <div className="disc-row">
          {popularTV.map((item, i) => <TMDBCard key={item.id || i} item={{...item, media_type:"tv"}} />)}
        </div>
      </div>

      <div style={{display:"flex",justifyContent:"flex-end",paddingTop:".4rem"}}>
        <button className="btn-sm" style={{width:"auto"}}
          onClick={() => { localStorage.removeItem("sv-tmdb-key"); setTmdbKey(""); setKeyInput(""); }}>
          Change API Key
        </button>
      </div>

      {/* Picker / Not-found modal */}
      {picker && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.82)",zIndex:600,
          display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}
          onClick={() => setPicker(null)}>
          <div style={{background:"var(--s1)",border:"1px solid var(--b2)",borderRadius:"14px",
            padding:"1.5rem",width:"100%",maxWidth:"420px",maxHeight:"72vh",overflow:"auto"}}
            onClick={e => e.stopPropagation()}>

            {/* TMDB title + meta */}
            <div style={{display:"flex",gap:"1rem",marginBottom:"1.2rem",alignItems:"flex-start"}}>
              {picker.tmdbItem.poster_path && (
                <img src={`${TMDB_IMG}w92${picker.tmdbItem.poster_path}`}
                  style={{width:54,borderRadius:7,flexShrink:0,border:"1px solid var(--b2)"}} alt="" />
              )}
              <div>
                <div style={{fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"1.15rem",lineHeight:1.2}}>
                  {picker.tmdbItem.title || picker.tmdbItem.name}
                </div>
                <div style={{fontSize:".72rem",color:"var(--t2)",marginTop:".25rem"}}>
                  {[(picker.tmdbItem.release_date||picker.tmdbItem.first_air_date||"").slice(0,4),
                    picker.tmdbItem.media_type==="tv" ? "TV Series" : "Movie"
                  ].filter(Boolean).join(" · ")}
                </div>
              </div>
            </div>

            {picker.matches.length === 0 ? (
              <div style={{textAlign:"center",padding:"1.4rem 0"}}>
                <div style={{fontSize:"2rem",marginBottom:".5rem"}}>🔍</div>
                <div style={{fontSize:".9rem",fontWeight:600}}>Not in your library</div>
                <div style={{fontSize:".78rem",color:"var(--t2)",marginTop:".4rem",lineHeight:1.55}}>
                  Load your Movies or Series first — connect via Xtream, M3U, or Stalker, then switch to the Movies/Series tab.
                </div>
              </div>
            ) : (
              <>
                <div style={{fontSize:".68rem",color:"var(--t3)",textTransform:"uppercase",
                  letterSpacing:".1em",fontWeight:700,marginBottom:".6rem"}}>
                  {picker.matches.length} match{picker.matches.length > 1 ? "es" : ""} in your library
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:".4rem"}}>
                  {picker.matches.map((item, i) => (
                    <div key={item.id || i}
                      style={{display:"flex",alignItems:"center",gap:".75rem",padding:".6rem .8rem",
                        background:"var(--s2)",border:"1px solid var(--b2)",borderRadius:"9px",
                        cursor:"pointer",transition:"border-color .15s"}}
                      onClick={() => { onPlay(item); setPicker(null); }}
                      onMouseEnter={e => e.currentTarget.style.borderColor="var(--accent)"}
                      onMouseLeave={e => e.currentTarget.style.borderColor="var(--b2)"}>
                      {item.logo
                        ? <img src={item.logo} style={{width:38,height:38,objectFit:"contain",
                            borderRadius:5,background:"var(--s3)",flexShrink:0}} alt="" />
                        : <div style={{width:38,height:38,background:"var(--s3)",borderRadius:5,
                            display:"flex",alignItems:"center",justifyContent:"center",
                            flexShrink:0,fontSize:".9rem"}}>
                            {item.type === "series" ? "📽" : "🎬"}
                          </div>}
                      <div style={{flex:1,overflow:"hidden"}}>
                        <div style={{fontSize:".82rem",fontWeight:500,overflow:"hidden",
                          textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</div>
                        <div style={{fontSize:".65rem",color:"var(--t3)",marginTop:".15rem"}}>
                          {item.group}{item.year ? ` · ${item.year}` : ""}
                        </div>
                      </div>
                      <div style={{fontSize:".8rem",color:"var(--accent)",flexShrink:0}}>▶</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div style={{marginTop:"1.1rem",textAlign:"right"}}>
              <button className="btn-cancel" onClick={() => setPicker(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
