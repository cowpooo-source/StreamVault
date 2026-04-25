import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import "./app.css";

const API = ""; // Force relative path for production
const EXOCLICK_VAST_URL = import.meta.env.VITE_EXOCLICK_VAST_URL || "https://s.magsrv.com/v1/vast.php?idzone=5903402";

// Proxy portal images to avoid mixed-content / broken SSL cert issues
// Skip proxying for known-good HTTPS domains (TMDB, etc.)
function imgSrc(url) {
  if (!url) return null;
  if (url.includes("image.tmdb.org") || url.includes("themoviedb.org")) return url;
  return `${API}/img?url=${encodeURIComponent(url)}`;
}

// Guest ID for analytics tracking
const GUEST_ID = (() => { let id = localStorage.getItem("sv-guest-id"); if (!id) { id = crypto.randomUUID?.() || Math.random().toString(36).slice(2); localStorage.setItem("sv-guest-id", id); } return id; })();
// Auth: httpOnly cookie is primary, localStorage Bearer is fallback for backward compat
function getAuthToken() { return localStorage.getItem("sv-auth-token"); }
function authHeaders(extra = {}) { const t = getAuthToken(); return { ...extra, ...(t ? { "Authorization": `Bearer ${t}` } : {}), "X-Guest-Id": GUEST_ID }; }
function authFetch(url, opts = {}) { opts.headers = authHeaders(opts.headers || {}); opts.credentials = "same-origin"; return fetch(url, opts); }
function track(event, data = {}) { fetch(`${API}/api/track`, { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ ...data, guestId: GUEST_ID, event }) }).catch(() => {}); }

function resolveUrl(raw, base) {
  if (!raw) return "";
  try { return new URL(String(raw).trim(), base).toString(); } catch { return ""; }
}

function parseVastTime(value) {
  if (!value) return 0;
  const text = String(value).trim();
  if (!text) return 0;
  if (text.includes(":")) {
    const parts = text.split(":").map(Number);
    if (parts.some(Number.isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

function pingUrl(url) {
  if (!url) return;
  try {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.src = url;
  } catch {}
}

function pingUrls(urls = []) {
  urls.forEach(pingUrl);
}

function mergeTrackers(...sets) {
  const merged = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [event, urls] of Object.entries(set)) {
      if (!urls?.length) continue;
      (merged[event] ||= []).push(...urls);
    }
  }
  for (const [event, urls] of Object.entries(merged)) {
    merged[event] = [...new Set(urls.filter(Boolean))];
  }
  return merged;
}

function collectVastTrackers(root) {
  const trackers = {};
  const push = (event, url) => {
    if (!event || !url) return;
    (trackers[event] ||= []).push(url);
  };
  root.querySelectorAll("Impression").forEach((node) => push("impression", node.textContent?.trim()));
  root.querySelectorAll("TrackingEvents Tracking").forEach((node) => push((node.getAttribute("event") || "").toLowerCase(), node.textContent?.trim()));
  return trackers;
}

async function fetchVastAd(vastUrl, videoEl, depth = 0, inheritedTrackers = {}) {
  if (!vastUrl || depth > 2) return null;
  try {
    const res = await fetch(vastUrl, { cache: "no-store", credentials: "omit", redirect: "follow" });
    if (!res.ok) return null;
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) return null;

    const wrapper = doc.querySelector("Wrapper");
    if (wrapper) {
      const nextUrl = resolveUrl(wrapper.querySelector("VASTAdTagURI")?.textContent, vastUrl);
      if (!nextUrl) return null;
      const wrapperTrackers = collectVastTrackers(wrapper);
      return await fetchVastAd(nextUrl, videoEl, depth + 1, mergeTrackers(inheritedTrackers, wrapperTrackers));
    }

    const inline = doc.querySelector("InLine");
    const linear = inline?.querySelector("Linear");
    if (!inline || !linear) return null;

    const mediaFiles = [...linear.querySelectorAll("MediaFile")]
      .map((node) => ({
        url: node.textContent?.trim(),
        type: node.getAttribute("type") || "",
      }))
      .filter((file) => file.url);

    if (!mediaFiles.length) return null;

    const media = mediaFiles.find((file) => file.type.startsWith("video/") && (!videoEl?.canPlayType || videoEl.canPlayType(file.type))) ||
      mediaFiles.find((file) => file.type.startsWith("video/")) ||
      mediaFiles[0];

    const trackers = mergeTrackers(inheritedTrackers, collectVastTrackers(inline));
    return {
      title: inline.querySelector("AdTitle")?.textContent?.trim() || "Sponsored",
      mediaUrl: resolveUrl(media.url, vastUrl),
      mediaType: media.type,
      clickThrough: resolveUrl(inline.querySelector("VideoClicks > ClickThrough")?.textContent, vastUrl),
      duration: parseVastTime(linear.querySelector("Duration")?.textContent),
      skipOffset: linear.getAttribute("skipoffset") ? parseVastTime(linear.getAttribute("skipoffset")) : null,
      trackers,
    };
  } catch {
    return null;
  }
}

// ── Adsterra Social Bar ──
const ADSTERRA_COOLDOWN_MS = 3 * 60 * 1000;
const ADSTERRA_STORAGE_KEY = "sv-adsterra-closed-at";

function AdsterraSocialBar({ onAllowedPage }) {
  useEffect(() => {
    if (!onAllowedPage) return;

    // ✅ Check cooldown BEFORE doing anything
    const closedAt = localStorage.getItem(ADSTERRA_STORAGE_KEY);
    if (closedAt && (Date.now() - parseInt(closedAt)) < ADSTERRA_COOLDOWN_MS) return;

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://pl29160027.profitablecpmratenetwork.com/fe/df/06/fedf067b01378386e9c4bc061ffa1edb.js";
    script.async = true;
    document.head.appendChild(script);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.removedNodes) {
          if (node.nodeType === 1) {
            const isAdBar =
              node.id?.startsWith("at_") ||
              node.className?.includes("adsterra") ||
              node.className?.includes("social-bar");

            if (isAdBar) {
              localStorage.setItem(ADSTERRA_STORAGE_KEY, Date.now().toString());
              observer.disconnect();
              // ✅ No setTicket — don't re-trigger the effect at all
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (document.head.contains(script)) {
        document.head.removeChild(script);
      }
    };
  }, [onAllowedPage]); // ✅ Only re-evaluate if the page eligibility changes

  return null;
}

// ── Adsterra Native Banner ──
function AdsterraNativeBanner({ enabled }) {
  useEffect(() => {
    if (!enabled) return;

    // Check if script already exists
    const existingScript = document.querySelector('script[src="https://pl29188175.profitablecpmratenetwork.com/3b0dde1ecede80099770260eafdfbd02/invoke.js"]');
    if (existingScript) return;

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://pl29188175.profitablecpmratenetwork.com/3b0dde1ecede80099770260eafdfbd02/invoke.js";
    script.async = true;
    script.setAttribute("data-cfasync", "false");
    document.head.appendChild(script);
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      id="container-3b0dde1ecede80099770260eafdfbd02"
      style={{ gridColumn: "1 / -1", width: "100%", minHeight: "50px" }}
    />
  );
}

// ── Reset Password Modal ──
function ResetPasswordModal({ token, onClose }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e) {
    e?.preventDefault();
    if (!password) return setErr("Password is required");
    if (password !== confirm) return setErr("Passwords do not match");
    setErr(""); setLoading(true);
    try {
      const res = await fetch(`${API}/api/auth/reset-password`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setDone(true);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="modal-ov">
      <div className="modal" style={{maxWidth:380}}>
        <div className="modal-title" style={{textAlign:"center",marginBottom:"1.5rem"}}>Reset Password</div>
        {done ? (
          <div style={{textAlign:"center"}}>
            <div style={{background:"rgba(0,212,255,0.1)",color:"var(--accent)",padding:".8rem",borderRadius:8,fontSize:".85rem",marginBottom:"1.5rem",border:"1px solid var(--accent-22)"}}>
              Password successfully reset! You can now log in with your new password.
            </div>
            <button className="btn-primary" onClick={onClose} style={{width:"100%"}}>Go to Login</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            {err && <div className="err" style={{marginBottom:".8rem"}}>⚠ {err}</div>}
            <div className="fg">
              <label className="fl">New Password</label>
              <input className="fi" type="password" placeholder="New Password" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
            </div>
            <div className="fg">
              <label className="fl">Confirm New Password</label>
              <input className="fi" type="password" placeholder="Confirm Password" value={confirm} onChange={e => setConfirm(e.target.value)} />
            </div>
            <div className="modal-btns" style={{marginTop:"1.5rem"}}>
              <button type="button" className="btn-cancel" onClick={onClose} disabled={loading} style={{flex:1}}>Cancel</button>
              <button type="submit" className="btn-confirm" disabled={loading} style={{flex:1}}>{loading ? "..." : "Reset"}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Auth Screen ──
function AuthScreen({ onAuth, onGuest }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  async function submit(e) {
    e?.preventDefault();
    setErr(""); setMsg(""); setLoading(true);
    try {
      if (mode === "forgot") {
        if (!emailInput) throw new Error("Email is required");
        const res = await fetch(`${API}/api/auth/forgot-password`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: emailInput }),
        });
        const data = await res.json();
        setMsg(data.message || "Reset link sent!");
        return;
      }

      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = { username, password };
      if (mode === "register") body.email = emailInput;

      const res = await fetch(`${API}${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      localStorage.setItem("sv-auth-token", data.token);
      onAuth(data.user);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="setup">
      <div className="card" style={{maxWidth:380}}>
        <div style={{textAlign:"center",marginBottom:"1.5rem"}}>
          <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:"2rem",fontWeight:700,letterSpacing:".12em",color:"var(--accent)"}}>Portal Heaven</div>
          <div style={{fontSize:".78rem",color:"var(--t3)"}}>Your personal IPTV client</div>
        </div>

        {mode !== "forgot" ? (
          <>
            <div className="tabs" style={{marginBottom:"1rem"}}>
              <button className={`tab ${mode==="login"?"on":""}`} onClick={() => {setMode("login");setErr("");setMsg("");}}>Login</button>
              <button className={`tab ${mode==="register"?"on":""}`} onClick={() => {setMode("register");setErr("");setMsg("");}}>Register</button>
            </div>
            {err && <div className="err" style={{marginBottom:".8rem"}}>⚠ {err}</div>}
            <form onSubmit={submit}>
              <div className="fg">
                <label className="fl">Username</label>
                <input className="fi" placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} autoFocus />
              </div>
              {mode === "register" && (
                <div className="fg">
                  <label className="fl">Email Address</label>
                  <input className="fi" type="email" placeholder="email@example.com" value={emailInput} onChange={e => setEmailInput(e.target.value)} />
                </div>
              )}
              <div className="fg">
                <label className="fl">Password</label>
                <input className="fi" type="password" placeholder="Password" value={password}
                  onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key==="Enter" && submit()} />
              </div>
              {mode === "login" && (
                <div style={{textAlign:"right",marginTop:"-0.5rem",marginBottom:"0.8rem"}}>
                  <button type="button" onClick={() => setMode("forgot")} style={{background:"none",border:"none",color:"var(--accent)",fontSize:".75rem",cursor:"pointer",padding:0}}>Forgot Password?</button>
                </div>
              )}
              <button type="submit" className="btn-primary" disabled={loading} style={{width:"100%"}}>
                {loading ? "..." : mode === "login" ? "Login" : "Create Account"}
              </button>
            </form>
          </>
        ) : (
          <>
            <div style={{fontSize:"1.1rem",fontWeight:600,marginBottom:"0.5rem",textAlign:"center"}}>Reset Password</div>
            <p style={{fontSize:".8rem",color:"var(--t2)",marginBottom:"1.2rem",textAlign:"center"}}>Enter your email address and we'll send you a link to reset your password.</p>
            {err && <div className="err" style={{marginBottom:".8rem"}}>⚠ {err}</div>}
            {msg && <div style={{background:"rgba(0,212,255,0.1)",color:"var(--accent)",padding:".8rem",borderRadius:8,fontSize:".8rem",marginBottom:"1rem",border:"1px solid var(--accent-22)"}}>{msg}</div>}
            <form onSubmit={submit}>
              <div className="fg">
                <label className="fl">Email Address</label>
                <input className="fi" type="email" placeholder="email@example.com" value={emailInput} onChange={e => setEmailInput(e.target.value)} autoFocus />
              </div>
              <button type="submit" className="btn-primary" disabled={loading || !!msg} style={{width:"100%",marginTop:".5rem"}}>
                {loading ? "..." : "Send Reset Link"}
              </button>
              <button type="button" onClick={() => setMode("login")} style={{width:"100%",background:"none",border:"1px solid var(--b2)",color:"var(--t2)",padding:".6rem",borderRadius:8,fontSize:".85rem",marginTop:".8rem",cursor:"pointer"}}>Back to Login</button>
            </form>
          </>
        )}

        <div style={{textAlign:"center",marginTop:"1.2rem"}}>
          <button onClick={onGuest} style={{width:"100%",padding:".65rem",background:"transparent",
            border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,color:"var(--t2)",cursor:"pointer",
            fontSize:".88rem",fontWeight:500,fontFamily:"'DM Sans',sans-serif",transition:"all .2s"}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--accent)";e.currentTarget.style.color="var(--accent)"}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.15)";e.currentTarget.style.color="var(--t2)"}}>
            Continue as Guest
          </button>
          <div style={{fontSize:".65rem",color:"var(--t3)",marginTop:".4rem"}}>No account needed — some features limited</div>
          {mode === "register" && (
            <div style={{fontSize:".65rem",color:"var(--accent)",marginTop:".5rem"}}>
              New accounts get Regular access (promo)
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Client-side encryption for credentials synced to server ──
const ENC_ALGO = "AES-GCM";
let _encKeySource = GUEST_ID; // default to guest ID, updated to user ID on login
function setEncKeySource(id) { _encKeySource = id; }
async function deriveKey() {
  const raw = new TextEncoder().encode(_encKeySource + ":sv-enc-key");
  const hash = await crypto.subtle.digest("SHA-256", raw);
  return crypto.subtle.importKey("raw", hash, ENC_ALGO, false, ["encrypt", "decrypt"]);
}
async function encryptData(plaintext) {
  try {
    const key = await deriveKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: ENC_ALGO, iv }, key, new TextEncoder().encode(plaintext));
    return btoa(String.fromCharCode(...iv)) + "." + btoa(String.fromCharCode(...new Uint8Array(enc)));
  } catch { return plaintext; }
}
async function decryptData(ciphertext) {
  try {
    if (!ciphertext || !ciphertext.includes(".")) return ciphertext;
    const [ivB64, dataB64] = ciphertext.split(".");
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const data = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0));
    const key = await deriveKey();
    const dec = await crypto.subtle.decrypt({ name: ENC_ALGO, iv }, key, data);
    return new TextDecoder().decode(dec);
  } catch { return ciphertext; }
}

// Strip sensitive fields before syncing, encrypt the rest
async function encryptConnections(conns) {
  const stripped = conns.map(c => {
    const safe = { ...c };
    // Remove plaintext credentials — encrypt them separately
    if (safe.type === "xtream" && safe.pass) { safe._encPass = true; delete safe.pass; }
    if (safe.type === "stalker" && safe.mac) { safe._encMac = true; }
    return safe;
  });
  return await encryptData(JSON.stringify(stripped));
}

async function decryptConnections(data) {
  if (!data) return null;
  // If data is already an array (stored unencrypted / pre-encryption), return directly
  if (Array.isArray(data)) return data;
  // Try to decrypt
  const json = await decryptData(typeof data === "string" ? data : JSON.stringify(data));
  try { return JSON.parse(json); } catch {}
  // Decryption failed — try parsing raw data as JSON (unencrypted fallback)
  if (typeof data === "string") { try { return JSON.parse(data); } catch {} }
  return typeof data === "object" ? data : null;
}

// Server sync — fire-and-forget with debounce (uses auth token if logged in)
const _syncTimers = {};
function syncToServer(type, connId, data) {
  const key = `${type}:${connId}`;
  clearTimeout(_syncTimers[key]);
  _syncTimers[key] = setTimeout(() => {
    authFetch(`${API}/api/sync/${type}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connId, data }),
    }).catch(() => {});
  }, 2000);
}

async function restoreFromServer(type, connId) {
  try {
    const res = await authFetch(`${API}/api/sync/${type}?connId=${encodeURIComponent(connId)}`);
    if (!res.ok) return null;
    const { data } = await res.json();
    return data;
  } catch { return null; }
}

// Sync connections list to server (encrypted)
async function syncConnectionsToServer(conns) {
  const encrypted = await encryptConnections(conns);
  syncToServer("connections", "_all", encrypted);
}

// Restore connections from server (decrypt)
async function restoreConnectionsFromServer() {
  const data = await restoreFromServer("connections", "_all");
  return decryptConnections(data);
}

// Migrate guest data to authenticated user
async function migrateGuestData() {
  try {
    await authFetch(`${API}/api/sync/migrate-guest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guestId: GUEST_ID }),
    });
  } catch {}
}

// ══════════════════════════════════════════════════════════════════
// THEMES (OTT Navigator style multi-theme)
// ══════════════════════════════════════════════════════════════════
const THEMES = {
  Dark:   { bg:"#07070f", s1:"#0f0f1c", s2:"#16162a", s3:"#1d1d35", accent:"#00d4ff", accent2:"#7c3aed", t1:"#dde0f5", t2:"#8080aa", t3:"#44445a" },
  Navy:   { bg:"#030b1a", s1:"#061228", s2:"#0d1f3c", s3:"#152850", accent:"#4da6ff", accent2:"#6c63ff", t1:"#d0e8ff", t2:"#6090b8", t3:"#304560" },
  AMOLED: { bg:"#000000", s1:"#0d0d0d", s2:"#181818", s3:"#222222", accent:"#ff6b35", accent2:"#ff2d55", t1:"#f0f0f0", t2:"#888888", t3:"#444444" },
  Forest: { bg:"#050f0a", s1:"#0a1f14", s2:"#112a1c", s3:"#1a3828", accent:"#00e896", accent2:"#00b4d8", t1:"#d0ffe8", t2:"#5a9070", t3:"#2a5038" },
  White:  { bg:"#ffffff", s1:"#f5f5f7", s2:"#ebebef", s3:"#dddde3", accent:"#0066ff", accent2:"#7c3aed", t1:"#1a1a2e", t2:"#5a5a72", t3:"#9a9ab0" },
  Bright: { bg:"#f8f9fc", s1:"#eef0f6", s2:"#e2e5ee", s3:"#d5d8e3", accent:"#e8364f", accent2:"#ff8c00", t1:"#1c1c28", t2:"#555568", t3:"#8888a0" },
};
const THEME_NAMES = Object.keys(THEMES);
const PROFILE_COLORS = ["#00d4ff","#ff6b35","#00e896","#ff2d55","#a78bfa","#fbbf24"];

// ══════════════════════════════════════════════════════════════════
// i18n — Multi-language support
// ══════════════════════════════════════════════════════════════════
const RTL_LANGS = ["ar","ur"];
const LANG_META = {en:"English",es:"Español",fr:"Français",ar:"العربية",pt:"Português",hi:"हिन्दी",ur:"اردو"};
const LANGS = {
  "en": {
    "discover": "Discover",
    "live": "Live TV",
    "movies": "Movies",
    "series": "Series",
    "favorites": "Favorites",
    "continueWatching": "Continue Watching",
    "tvGuide": "TV Guide",
    "globalSearch": "Global Search",
    "directPlay": "Direct Play",
    "watch": "Watch",
    "tools": "Tools",
    "savedConns": "Saved Connections",
    "orAddNew": "or add new",
    "connect": "Connect",
    "connectArrow": "Connect →",
    "disconnect": "Disconnect",
    "feedback": "Feedback",
    "send": "Send",
    "cancel": "Cancel",
    "close": "Close",
    "refresh": "Refresh",
    "search": "Search",
    "prev": "Prev",
    "next": "Next",
    "fav": "Fav",
    "pip": "PiP",
    "play": "Play",
    "go": "Go",
    "playPause": "Play/Pause",
    "fullscreen": "Fullscreen",
    "mute": "Mute",
    "channels": "Channels",
    "volume": "Volume",
    "portalURL": "Portal URL",
    "macAddress": "MAC Address",
    "serverURL": "Server URL",
    "username": "Username",
    "password": "Password",
    "playlistURL": "Playlist URL",
    "connFailed": "Connection failed",
    "connecting": "Connecting…",
    "import": "Import",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "M3U Playlist",
    "stalkerPortal": "Stalker Portal",
    "directHLS": "Direct HLS",
    "noChannels": "No channels found",
    "loading": "Loading…",
    "loadingSection": "Loading {0}…",
    "playbackErr": "Playback Error",
    "networkErr": "Network Error",
    "streamNotFound": "Stream Not Found",
    "accessDenied": "Access Denied",
    "serverErr": "Server Error",
    "noContent": "No content found",
    "selectCategory": "Select a category",
    "fetchingItems": "Fetching items from portal.",
    "tryDifferent": "Try a different category or clear your search.",
    "now": "Now",
    "loadEPG": "Load EPG",
    "noChannelsLoaded": "No channels loaded",
    "noEPGData": "No EPG data",
    "filterChannels": "Filter channels…",
    "sendFeedback": "Send Feedback",
    "thankYou": "Thank you!",
    "feedbackReceived": "Your feedback has been received.",
    "feedbackHint": "Bug reports, feature requests, or general comments",
    "feedbackPlaceholder": "What's on your mind?",
    "sending": "Sending...",
    "noFavsYet": "No favorites yet",
    "favHint": "Click the ♡ icon on any channel or movie to add it here.",
    "liveTV": "Live TV",
    "nothingStarted": "Nothing started yet",
    "resumeHint": "Watch some content and it will appear here for easy resuming.",
    "resumeWatching": "Resume Watching",
    "recentlyWatched": "Recently Watched",
    "searchEverything": "Search everything",
    "searchHint": "Movies, Series or Channels",
    "settings": "Settings"
  },
  "es": {
    "discover": "Descubrir",
    "live": "TV en Vivo",
    "movies": "Películas",
    "series": "Series",
    "favorites": "Favoritos",
    "continueWatching": "Seguir Viendo",
    "tvGuide": "Guía TV",
    "globalSearch": "Búsqueda Global",
    "directPlay": "Reproducción Directa",
    "watch": "Ver",
    "tools": "Herramientas",
    "savedConns": "Conexiones Guardadas",
    "orAddNew": "o agregar nueva",
    "connect": "Conectar",
    "connectArrow": "Conectar →",
    "disconnect": "Desconectar",
    "feedback": "Comentarios",
    "send": "Enviar",
    "cancel": "Cancelar",
    "close": "Cerrar",
    "refresh": "Actualizar",
    "search": "Buscar",
    "prev": "Anterior",
    "next": "Siguiente",
    "fav": "Fav",
    "pip": "PiP",
    "play": "Reproducir",
    "go": "Ir",
    "playPause": "Reproducir/Pausa",
    "fullscreen": "Pantalla Completa",
    "mute": "Silenciar",
    "channels": "Canales",
    "volume": "Volumen",
    "portalURL": "URL del Portal",
    "macAddress": "Dirección MAC",
    "serverURL": "URL del Servidor",
    "username": "Usuario",
    "password": "Contraseña",
    "playlistURL": "URL de Lista",
    "connFailed": "Conexión fallida",
    "connecting": "Conectando…",
    "import": "Importar",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "Lista M3U",
    "stalkerPortal": "Portal Stalker",
    "directHLS": "HLS Directo",
    "noChannels": "No se encontraron canales",
    "loading": "Cargando…",
    "loadingSection": "Cargando {0}…",
    "playbackErr": "Error de Reproducción",
    "networkErr": "Error de Red",
    "streamNotFound": "Transmissão No Encontrada",
    "accessDenied": "Acceso Denegado",
    "serverErr": "Error del Servidor",
    "noContent": "No se encontró contenido",
    "selectCategory": "Seleccionar categoría",
    "fetchingItems": "Obteniendo elementos del portal.",
    "tryDifferent": "Pruebe otra categoría o borre su búsqueda.",
    "now": "Ahora",
    "loadEPG": "Cargar EPG",
    "noChannelsLoaded": "No hay canales cargados",
    "noEPGData": "Sin datos EPG",
    "filterChannels": "Filtrar canales…",
    "sendFeedback": "Enviar Comentarios",
    "thankYou": "¡Gracias!",
    "feedbackReceived": "Su comentario ha sido recibido.",
    "feedbackHint": "Reportes de errores, solicitudes o comentarios generales",
    "feedbackPlaceholder": "¿Qué tienes en mente?",
    "sending": "Enviando...",
    "noFavsYet": "Aún no hay favoritos",
    "favHint": "Haga clic en el icono ♡ en cualquier canal o película para agregarlo aquí.",
    "liveTV": "TV en Vivo",
    "nothingStarted": "Nada iniciado aún",
    "resumeHint": "Asista a algún contenido y aparecerá aquí.",
    "resumeWatching": "Seguir viendo",
    "recentlyWatched": "Visto recientemente",
    "searchEverything": "Buscar en todo",
    "searchHint": "Películas, Series o Canales",
    "settings": "Configuraciones"
  },
  "fr": {
    "discover": "Découvrir",
    "live": "TV en Direct",
    "movies": "Films",
    "series": "Séries",
    "favorites": "Favoris",
    "continueWatching": "Continuer à Regarder",
    "tvGuide": "Guide TV",
    "globalSearch": "Recherche Globale",
    "directPlay": "Lecture Directe",
    "watch": "Regarder",
    "tools": "Outils",
    "savedConns": "Connexions Enregistrées",
    "orAddNew": "ou ajouter nouvelle",
    "connect": "Connecter",
    "connectArrow": "Connecter →",
    "disconnect": "Déconnecter",
    "feedback": "Commentaires",
    "send": "Envoyer",
    "cancel": "Annuler",
    "close": "Fermer",
    "refresh": "Actualiser",
    "search": "Rechercher",
    "prev": "Préc.",
    "next": "Suiv.",
    "fav": "Fav",
    "pip": "PiP",
    "play": "Lecture",
    "go": "Go",
    "playPause": "Lecture/Pause",
    "fullscreen": "Plein Écran",
    "mute": "Muet",
    "channels": "Chaînes",
    "volume": "Volume",
    "portalURL": "URL du Portail",
    "macAddress": "Adresse MAC",
    "serverURL": "URL du Serveur",
    "username": "Identifiant",
    "password": "Mot de passe",
    "playlistURL": "URL de la Playlist",
    "connFailed": "Échec de connexion",
    "connecting": "Connexion…",
    "import": "Importer",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "Playlist M3U",
    "stalkerPortal": "Portail Stalker",
    "directHLS": "HLS Direct",
    "noChannels": "Aucune chaîne trouvée",
    "loading": "Chargement…",
    "loadingSection": "Chargement de {0}…",
    "playbackErr": "Erreur de Lecture",
    "networkErr": "Erreur Réseau",
    "streamNotFound": "Flux Introuvable",
    "accessDenied": "Accès Refusé",
    "serverErr": "Erreur Serveur",
    "noContent": "Aucun contenu trouvé",
    "selectCategory": "Sélectionner une catégorie",
    "fetchingItems": "Récupération des éléments du portail.",
    "tryDifferent": "Essayez une autre catégorie ou effacez votre recherche.",
    "now": "Maintenant",
    "loadEPG": "Charger EPG",
    "noChannelsLoaded": "Aucune chaîne chargée",
    "noEPGData": "Pas de données EPG",
    "filterChannels": "Filtrer les chaînes…",
    "sendFeedback": "Envoyer un Commentaire",
    "thankYou": "Merci !",
    "feedbackReceived": "Votre commentaire a été reçu.",
    "feedbackHint": "Rapports de bugs, demandes de fonctionnalités ou commentaires généraux",
    "feedbackPlaceholder": "Qu'avez-vous en tête ?",
    "sending": "Envoi...",
    "noFavsYet": "Pas encore de favoris",
    "favHint": "Cliquez sur l'icône ♡ sur une chaîne ou un film pour l'ajouter ici.",
    "liveTV": "TV en Direct",
    "nothingStarted": "Rien n'a encore commencé",
    "resumeHint": "Regardez du contenu et il apparaîtra ici.",
    "resumeWatching": "Reprendre la lecture",
    "recentlyWatched": "Vus récemment",
    "searchEverything": "Tout rechercher",
    "searchHint": "Films, séries ou chaînes",
    "settings": "Paramètres"
  },
  "ar": {
    "discover": "اكتشف",
    "live": "البث المباشر",
    "movies": "أفلام",
    "series": "مسلسلات",
    "favorites": "المفضلة",
    "continueWatching": "متابعة المشاهدة",
    "tvGuide": "دليل التلفزيون",
    "globalSearch": "بحث شامل",
    "directPlay": "تشغيل مباشر",
    "watch": "مشاهدة",
    "tools": "أدوات",
    "savedConns": "الاتصالات المحفوظة",
    "orAddNew": "أو أضف جديد",
    "connect": "اتصال",
    "connectArrow": "← اتصال",
    "disconnect": "قطع الاتصال",
    "feedback": "ملاحظات",
    "send": "إرسال",
    "cancel": "إلغاء",
    "close": "إغلاق",
    "refresh": "تحديث",
    "search": "بحث",
    "prev": "السابق",
    "next": "التالي",
    "fav": "مفضلة",
    "pip": "صورة في صورة",
    "play": "تشغيل",
    "go": "انطلق",
    "playPause": "تشغيل/إيقاف",
    "fullscreen": "ملء الشاشة",
    "mute": "كتم الصوت",
    "channels": "القنوات",
    "volume": "الصوت",
    "portalURL": "رابط البوابة",
    "macAddress": "عنوان MAC",
    "serverURL": "رابط الخادم",
    "username": "اسم المستخدم",
    "password": "كلمة المرور",
    "playlistURL": "رابط قائمة التشغيل",
    "connFailed": "فشل الاتصال",
    "connecting": "جارٍ الاتصال…",
    "import": "استيراد",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "قائمة M3U",
    "stalkerPortal": "بوابة Stalker",
    "directHLS": "HLS مباشر",
    "noChannels": "لم يتم العثور على قنوات",
    "loading": "جارٍ التحميل…",
    "loadingSection": "جارٍ تحميل {0}…",
    "playbackErr": "خطأ في التشغيل",
    "networkErr": "خطأ في الشبكة",
    "streamNotFound": "البث غير موجود",
    "accessDenied": "الوصول مرفوض",
    "serverErr": "خطأ في الخادم",
    "noContent": "لم يتم العور على محتوى",
    "selectCategory": "اختر فئة",
    "fetchingItems": "جارٍ جلب العناصر من البوابة.",
    "tryDifferent": "جرّب فئة أخرى أو امسح البحث.",
    "now": "الآن",
    "loadEPG": "تحميل EPG",
    "noChannelsLoaded": "لا توجد قنوات محمّلة",
    "noEPGData": "لا توجد بيانات EPG",
    "filterChannels": "تصفية القنوات…",
    "sendFeedback": "إرسال ملاحظات",
    "thankYou": "شكراً لك!",
    "feedbackReceived": "تم استلام ملاحظاتك.",
    "feedbackHint": "تقارير الأخطاء أو طلبات الميزات أو التعليقات العامة",
    "feedbackPlaceholder": "ما الذي يدور في ذهنك؟",
    "sending": "جارٍ الإرسال...",
    "noFavsYet": "لا توجد مفضلات بعد",
    "favHint": "اضغط على أيقونة ♡ على أي قناة أو فيلم لإضافته هنا.",
    "liveTV": "البث المباشر",
    "nothingStarted": "لم تبدأ شيئاً بعد",
    "resumeHint": "شاهد بعض المحتوى وسيظهر هنا لاستئنافه بسهولة.",
    "resumeWatching": "استئناف المشاهدة",
    "recentlyWatched": "شوهد مؤخراً",
    "searchEverything": "بحث في كل شيء",
    "searchHint": "أفلام أو مسلسلات أو قنوات",
    "settings": "الإعدادات"
  },
  "pt": {
    "discover": "Descobrir",
    "live": "TV ao Vivo",
    "movies": "Filmes",
    "series": "Séries",
    "favorites": "Favoritos",
    "continueWatching": "Continuar Assistindo",
    "tvGuide": "Guia TV",
    "globalSearch": "Busca Global",
    "directPlay": "Reprodução Direta",
    "watch": "Assistir",
    "tools": "Ferramentas",
    "savedConns": "Conexiones Salvas",
    "orAddNew": "ou adicionar nova",
    "connect": "Conectar",
    "connectArrow": "Conectar →",
    "disconnect": "Desconectar",
    "feedback": "Feedback",
    "send": "Enviar",
    "cancel": "Cancelar",
    "close": "Fechar",
    "refresh": "Atualizar",
    "search": "Buscar",
    "prev": "Anterior",
    "next": "Próximo",
    "fav": "Fav",
    "pip": "PiP",
    "play": "Reproduzir",
    "go": "Ir",
    "playPause": "Reproduzir/Pausar",
    "fullscreen": "Tela Cheia",
    "mute": "Mudo",
    "channels": "Canais",
    "volume": "Volume",
    "portalURL": "URL do Portal",
    "macAddress": "Endereço MAC",
    "serverURL": "URL do Servidor",
    "username": "Usuário",
    "password": "Senha",
    "playlistURL": "URL da Playlist",
    "connFailed": "Falha na conexão",
    "connecting": "Conectando…",
    "import": "Importar",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "Playlist M3U",
    "stalkerPortal": "Portal Stalker",
    "directHLS": "HLS Direct",
    "noChannels": "Nenhum canal encontrado",
    "loading": "Carregando…",
    "loadingSection": "Carregando {0}…",
    "playbackErr": "Erro de Reprodução",
    "networkErr": "Erro de Rede",
    "streamNotFound": "Transmissão Não Encontrada",
    "accessDenied": "Acesso Negado",
    "serverErr": "Erro do Servidor",
    "noContent": "Nenhum conteúdo encontrado",
    "selectCategory": "Selecione uma categoria",
    "fetchingItems": "Buscando itens do portal.",
    "tryDifferent": "Tente outra categoria ou limpe sua busca.",
    "now": "Agora",
    "loadEPG": "Carregar EPG",
    "noChannelsLoaded": "Nenhum canal carregado",
    "noEPGData": "Sem dados EPG",
    "filterChannels": "Filtrar canais…",
    "sendFeedback": "Enviar Feedback",
    "thankYou": "Obrigado!",
    "feedbackReceived": "Seu feedback foi recebido.",
    "feedbackHint": "Relatos de bugs, solicitações de recursos ou comentários gerais",
    "feedbackPlaceholder": "O que está em sua mente?",
    "sending": "Enviando...",
    "noFavsYet": "Nenhum favorito ainda",
    "favHint": "Clique no ícone ♡ em qualquer canal ou filme para adicioná-lo aqui.",
    "liveTV": "TV ao Vivo",
    "nothingStarted": "Nada iniciado ainda",
    "resumeHint": "Assista a algum conteúdo e ele aparecerá aqui.",
    "resumeWatching": "Continuar assistindo",
    "recentlyWatched": "Visto recentemente",
    "searchEverything": "Pesquisar tudo",
    "searchHint": "Filmes, Séries ou Canais",
    "settings": "Configurações"
  },
  "hi": {
    "discover": "खोजें",
    "live": "लाइव टीवी",
    "movies": "फ़िल्में",
    "series": "सीरीज़",
    "favorites": "पसंदीदा",
    "continueWatching": "देखना जारी रखें",
    "tvGuide": "टीवी गाइड",
    "globalSearch": "वैश्विक खोज",
    "directPlay": "डायरेक्ट प्ले",
    "watch": "देखें",
    "tools": "उपकरण",
    "savedConns": "सहेजे गए कनेक्शन",
    "orAddNew": "या नया जोड़ें",
    "connect": "कनेक्ट",
    "connectArrow": "कनेक्ट →",
    "disconnect": "डिस्कनेक्ट",
    "feedback": "प्रतिक्रिया",
    "send": "भेजें",
    "cancel": "रद्द करें",
    "close": "बंद करें",
    "refresh": "रीफ़्रेश",
    "search": "खोजें",
    "prev": "पिछला",
    "next": "अगला",
    "fav": "पसंद",
    "pip": "PiP",
    "play": "चलाएँ",
    "go": "जाएँ",
    "playPause": "चलाएँ/रोकें",
    "fullscreen": "फ़ुलस्क्रीन",
    "mute": "म्यूट",
    "channels": "चैनल",
    "volume": "ध्वनि",
    "portalURL": "पोर्टل URL",
    "macAddress": "MAC पता",
    "serverURL": "सर्वर URL",
    "username": "उपयोगकर्ता",
    "password": "पासवर्ड",
    "playlistURL": "प्लेलिस्ट URL",
    "connFailed": "कनेक्शन विफल",
    "connecting": "कनेक्ट हो रहा है…",
    "import": "आयात",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "M3U प्लेलिस्ट",
    "stalkerPortal": "Stalker पोर्टल",
    "directHLS": "डायरेक्ट HLS",
    "noChannels": "कोई चैनल नहीं मिला",
    "loading": "लोड हो रहा है…",
    "loadingSection": "{0} लोड हो रहा है…",
    "playbackErr": "प्लेबैक त्रुटि",
    "networkErr": "नेटवर्क त्रुटि",
    "streamNotFound": "स्ट्रीम नहीं मिली",
    "accessDenied": "पहुँच अस्वीकृत",
    "serverErr": "सर्वर त्रुटि",
    "noContent": "कोई सामग्री नहीं मिली",
    "selectCategory": "एक श्रेणी चुनें",
    "fetchingItems": "पोर्टल से आइटम प्राप्त हो रहे हैं।",
    "tryDifferent": "कोई अन्य श्रेणी आज़माएँ या खोज साफ़ करें।",
    "now": "अभी",
    "loadEPG": "EPG लोड करें",
    "noChannelsLoaded": "कोई चैनल लोड नहीं हुआ",
    "noEPGData": "कोई EPG डेटा नहीं",
    "filterChannels": "चैनल फ़िल्टर करें…",
    "sendFeedback": "प्रतिक्रिया भेजें",
    "thankYou": "धन्यवाद!",
    "feedbackReceived": "आपकी प्रतिक्रिया प्राप्त हो गई है।",
    "feedbackHint": "बग रिपोर्ट, फ़ीचर अनुरोध, या सामान्य टिप्पणियाँ",
    "feedbackPlaceholder": "आपके मन में क्या है?",
    "sending": "भेजा जा रहा है...",
    "noFavsYet": "अभी तक कोई पसंदीदा नहीं",
    "favHint": "किसी भी चैनल या फ़िल्म पर ♡ आइकन पर क्लिक करें।",
    "liveTV": "लाइव टीवी",
    "nothingStarted": "अभी तक कुछ शुरू नहीं हुआ",
    "resumeHint": "कुछ सामग्री देखें और वह यहाँ दिखाई देगी।",
    "resumeWatching": "फिर से देखें",
    "recentlyWatched": "हाल ही में देखा गया",
    "searchEverything": "सब कुछ खोजें",
    "searchHint": "फ़िल्में, सीरीज़ या चैनल",
    "settings": "सेटिंग्स"
  },
  "ur": {
    "discover": "دریافت کریں",
    "live": "لائیو ٹی وی",
    "movies": "فلمیں",
    "series": "سیریز",
    "favorites": "پسندیدہ",
    "continueWatching": "دیکھنا جاری رکھیں",
    "tvGuide": "ٹی وی گائیڈ",
    "globalSearch": "عالمی تلاش",
    "directPlay": "براہ راست چلائیں",
    "watch": "دیکھیں",
    "tools": "ٹولز",
    "savedConns": "محفوظ کنکشنز",
    "orAddNew": "یا نیا شامل کریں",
    "connect": "جوڑیں",
    "connectArrow": "← جوڑیں",
    "disconnect": "منقطع کریں",
    "feedback": "رائے",
    "send": "بھیجیں",
    "cancel": "منسوخ",
    "close": "بند کریں",
    "refresh": "تازہ کریں",
    "search": "تلاش",
    "prev": "پچھلا",
    "next": "اگلا",
    "fav": "پسند",
    "pip": "PiP",
    "play": "چلائیں",
    "go": "جائیں",
    "playPause": "چلائیں/روکیں",
    "fullscreen": "فل سکرین",
    "mute": "خاموش",
    "channels": "چینلز",
    "volume": "آواز",
    "portalURL": "پورٹل URL",
    "macAddress": "MAC ایڈریس",
    "serverURL": "سرور URL",
    "username": "صارف نام",
    "password": "پاسورڈ",
    "playlistURL": "پلے لسٹ URL",
    "connFailed": "کنکشن ناکام",
    "connecting": "جوڑ رہے ہیں…",
    "import": "درآمد",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "M3U پلے لسٹ",
    "stalkerPortal": "Stalker پورٹل",
    "directHLS": "براہ راست HLS",
    "noChannels": "کوئی چینل نہیں ملا",
    "loading": "لوڈ ہو رہا ہے…",
    "loadingSection": "{0} لوڈ ہو رہا ہے…",
    "playbackErr": "پلے بیک خرابی",
    "networkErr": "نیٹ ورک خرابی",
    "streamNotFound": "سٹریم نہیں ملی",
    "accessDenied": "رسائی سے انکار",
    "serverErr": "سرور خرابی",
    "noContent": "کوئی مواد نہیں ملا",
    "selectCategory": "زمرہ منتخب کریں",
    "fetchingItems": "پورٹل سے آئٹمز حاصل ہو رہے ہیں۔",
    "tryDifferent": "دوسرا زمرہ آزمائیں یا تلاش صاف کریں۔",
    "now": "ابھی",
    "loadEPG": "EPG لوڈ کریں",
    "noChannelsLoaded": "کوئی چینل لوڈ نہیں ہوا",
    "noEPGData": "کوئی EPG ڈیٹا نہیں",
    "filterChannels": "چینلز فلٹر کریں…",
    "sendFeedback": "رائے بھیجیں",
    "thankYou": "شکریہ!",
    "feedbackReceived": "آپ کی رائے موصول ہو گئی ہے۔",
    "feedbackHint": "بگ رپورٹس، فیچر درخواستیں، یا عمومی تبصرے",
    "feedbackPlaceholder": "آپ کے ذہن میں کیا ہے؟",
    "sending": "بھیج رہے ہیں...",
    "noFavsYet": "ابھی تک کوئی پسندیدہ نہیں",
    "favHint": "کسی भी چینل یا فلم پر ♡ آئیکن پر کلك کریں۔",
    "liveTV": "لائیو ٹی وی",
    "nothingStarted": "ابھی تک کچھ شروع نہیں ہوا",
    "resumeHint": "کچھ مواد دیکھیں اور یہ یہاں دکھائی دے گا۔",
    "resumeWatching": "دوبارہ دیکھیں",
    "recentlyWatched": "حال ہی میں دیکھا گیا",
    "searchEverything": "سب تلاش کریں",
    "searchHint": "فلمیں، سیریز یا چینلز",
    "settings": "ترتیبات"
  }
};
function _t(lang, key, ...args) { const s = LANGS[lang]?.[key] ?? LANGS.en[key] ?? key; return args.length ? s.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? "") : s; }

// ══════════════════════════════════════════════════════════════════
// STORAGE + GUEST SESSION
// ══════════════════════════════════════════════════════════════════
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

// Cloud restore disabled — D1 catalog API handles persistence per-connection
// Future: restore connections list from D1 on first load

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
      cur.url = line; cur.id = cur.url;
      if (line.includes("/movie/")) cur.type = "vod";
      else if (line.includes("/series/")) cur.type = "series";
      out.push(cur); cur = null;
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
  return fetch(`${API}/proxy?url=${encodeURIComponent(url)}`);
}

async function safeJsonFetch(res) {
  const text = await res.text();
  if (!res.ok) {
    // Try to parse error message if it's JSON
    try {
      const errData = JSON.parse(text);
      if (errData.error) throw new Error(errData.error);
    } catch (e) {
      if (e.message.startsWith("Server returned")) throw e; // Already a good error
    }
    throw new Error(`Server error (HTTP ${res.status})`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    if (text.trim().startsWith("<")) {
      throw new Error("Server returned HTML/XML instead of JSON. Check if your URL and credentials are correct.");
    }
    throw new Error("Invalid response from server (Not JSON)");
  }
}

function makeXtreamAPI(server, user, pass) {
  const base = `${server}/player_api.php?username=${user}&password=${pass}`;
  
  const fetchJson = async (url) => {
    const res = await proxyFetch(url);
    return safeJsonFetch(res);
  };

  return {
    auth: () => fetchJson(base),
    getLiveCategories: () => fetchJson(`${base}&action=get_live_categories`),
    getLive: () => fetchJson(`${base}&action=get_live_streams`),
    getVODCategories: () => fetchJson(`${base}&action=get_vod_categories`),
    getVOD: () => fetchJson(`${base}&action=get_vod_streams`),
    getSeriesCategories: () => fetchJson(`${base}&action=get_series_categories`),
    getSeries: () => fetchJson(`${base}&action=get_series`),
    getSeriesInfo: (id) => fetchJson(`${base}&action=get_series_info&series_id=${id}`),
    liveURL: id => `${server}/live/${user}/${pass}/${id}.ts`,
    vodURL: (id, ext="mp4") => `${server}/movie/${user}/${pass}/${id}.${ext}`,
    seriesStreamURL: (id, ext="mp4") => `${server}/series/${user}/${pass}/${id}.${ext}`,
  };
}

function uid() { return Math.random().toString(36).slice(2,10); }

// Transform stalker item URL: extract direct HTTP URLs, store original as _stalkerCmd
function transformStalkerItem(item) {
  if (item._stalkerCmd !== undefined) return item;
  const raw = (item.url || "").replace(/^ffmpeg\s+/, "").trim();
  const isDirect = raw.startsWith("http") && !raw.includes("localhost");
  return { ...item, _stalkerCmd: item.url, url: isDirect ? raw : null };
}

// ══════════════════════════════════════════════════════════════════
// CSS GENERATOR
// ══════════════════════════════════════════════════════════════════
function genCSS(t) {
  const isLight = t.bg === "#ffffff" || t.bg === "#f8f9fc";
  const b1 = isLight ? "rgba(0,0,0,0.07)" : "rgba(255,255,255,0.06)";
  const b2 = isLight ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.11)";
  return `
:root{
  --bg:${t.bg};--s1:${t.s1};--s2:${t.s2};--s3:${t.s3};
  --b1:${b1};--b2:${b2};
  --accent:${t.accent};--accent2:${t.accent2};
  --glow:${t.accent}28;
  --accent-10:${t.accent}10;--accent-12:${t.accent}12;--accent-14:${t.accent}14;--accent-15:${t.accent}15;
  --accent-18:${t.accent}18;--accent-22:${t.accent}22;--accent-30:${t.accent}30;--accent-40:${t.accent}40;--accent-50:${t.accent}50;
  --accent2-22:${t.accent2}22;
  --t1:${t.t1};--t2:${t.t2};--t3:${t.t3};
  --danger:#ff4466;--ok:#00cc88;
  --shadow:${isLight ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.5)"};
  --hover-bg:${isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.03)"};
}`;
}


// ══════════════════════════════════════════════════════════════════
// PLAYER COMPONENT (TiviMate-level keyboard + OSD + PiP + quick-ch)
// ══════════════════════════════════════════════════════════════════
function Player({ item, channelList, epgData, onClose, onFav, isFav, connType, t: pt }) {
  const t = pt || ((k) => k);
  const videoRef   = useRef(null);
  const hlsRef     = useRef(null);
  const mpegtsRef  = useRef(null);
  const adPlayedRef = useRef(false);
  const adSessionRef = useRef(0);
  const adFinishRef = useRef(null);
  const osdTimer   = useRef(null);
  const [osd, setOsd]         = useState(true);
  const [showQCH, setShowQCH] = useState(false);
  const qchTimer = useRef(null);
  const [chIdx, setChIdx]     = useState(() => {
    if (!channelList) return -1;
    return channelList.findIndex(c => c.id === item.id || c.url === item.url);
  });
  const [current, setCurrent] = useState(item);
  const [adState, setAdState] = useState(null);

  const showOSD = useCallback(() => {
    setOsd(true);
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(false), 3500);
  }, []);

  function destroyPlayers() {
    if (hlsRef.current)    { hlsRef.current.destroy();  hlsRef.current = null; }
    if (mpegtsRef.current) { mpegtsRef.current.destroy(); mpegtsRef.current = null; }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }

  async function playVastPreroll(video, ad, isCancelled) {
    return new Promise((resolve) => {
      if (!video || !ad?.mediaUrl || isCancelled()) {
        resolve(false);
        return;
      }

      let done = false;
      let skipTimer = null;
      let impressionSent = false;
      const wasMuted = video.muted;
      const wasControls = video.controls;

      const cleanup = () => {
        video.removeEventListener("ended", onEnded);
        video.removeEventListener("error", onError);
        video.removeEventListener("timeupdate", onTimeUpdate);
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("click", onClick);
        if (skipTimer) clearInterval(skipTimer);
        video.muted = wasMuted;
        video.controls = wasControls;
        adFinishRef.current = null;
      };

      const finish = (result, eventName = null) => {
        if (done) return;
        done = true;
        if (eventName) pingUrls(ad.trackers?.[eventName]);
        cleanup();
        setAdState(null);
        resolve(result);
      };

      const updateOverlay = () => {
        if (isCancelled()) {
          finish(false);
          return;
        }
        const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const skipEnabled = ad.skipOffset !== null;
        const canSkip = !skipEnabled || ad.skipOffset <= 0 || currentTime >= ad.skipOffset;
        const remaining = skipEnabled && !canSkip ? Math.max(0, Math.ceil(ad.skipOffset - currentTime)) : 0;
        setAdState({
          active: true,
          title: ad.title,
          clickThrough: ad.clickThrough,
          skipEnabled,
          canSkip,
          skipRemaining: remaining,
          mediaType: ad.mediaType,
        });
      };

      const onEnded = () => finish(true, "complete");
      const onError = () => finish(false);
      const onPlaying = () => {
        if (impressionSent) return;
        impressionSent = true;
        pingUrls(ad.trackers?.impression);
      };
      const onClick = () => {
        if (!ad.clickThrough) return;
        window.open(ad.clickThrough, "_blank", "noopener,noreferrer");
      };
      const onTimeUpdate = () => updateOverlay();

      adFinishRef.current = (eventName = "complete") => finish(true, eventName);

      video.pause();
      video.removeAttribute("src");
      video.src = ad.mediaUrl;
      video.controls = true;
      video.playsInline = true;
      video.muted = true;
      video.load();

      video.addEventListener("ended", onEnded);
      video.addEventListener("error", onError);
      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("playing", onPlaying, { once: true });
      video.addEventListener("click", onClick);

      if (ad.skipOffset !== null && ad.skipOffset > 0) {
        skipTimer = setInterval(updateOverlay, 250);
      }

      updateOverlay();
      const playPromise = video.play();
      if (playPromise?.catch) {
        playPromise.catch(() => finish(false));
      }
    });
  }

  const [streamErr, setStreamErr] = useState(null);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState({});
  const statsInterval = useRef(null);

  useEffect(() => {
    if (!showStats) { clearInterval(statsInterval.current); return; }
    function collect() {
      const v = videoRef.current;
      if (!v) return;
      const s = {};
      s.resolution = v.videoWidth && v.videoHeight ? `${v.videoWidth}×${v.videoHeight}` : "—";
      s.currentTime = v.currentTime?.toFixed(1) || "0";
      s.duration = v.duration && isFinite(v.duration) ? v.duration.toFixed(1) : "Live";
      s.readyState = ["NOTHING","METADATA","CURRENT","FUTURE","ENOUGH"][v.readyState] || v.readyState;
      s.networkState = ["EMPTY","IDLE","LOADING","NO_SRC"][v.networkState] || v.networkState;
      s.paused = v.paused ? "Yes" : "No";
      s.volume = `${Math.round(v.volume * 100)}%${v.muted ? " (muted)" : ""}`;
      // Buffer info
      if (v.buffered.length > 0) {
        const end = v.buffered.end(v.buffered.length - 1);
        s.buffer = `${(end - v.currentTime).toFixed(1)}s ahead`;
      } else { s.buffer = "0s"; }
      // Dropped frames (Chrome/Edge)
      const q = v.getVideoPlaybackQuality?.();
      if (q) {
        s.droppedFrames = `${q.droppedVideoFrames}/${q.totalVideoFrames}`;
        s.fps = q.totalVideoFrames > 0 && v.currentTime > 1
          ? (q.totalVideoFrames / v.currentTime).toFixed(1) : "—";
      }
      // HLS.js stats
      const hls = hlsRef.current;
      if (hls?.levels?.[hls.currentLevel]) {
        const lvl = hls.levels[hls.currentLevel];
        s.bitrate = lvl.bitrate ? `${(lvl.bitrate / 1000).toFixed(0)} kbps` : "—";
        s.codec = [lvl.videoCodec, lvl.audioCodec].filter(Boolean).join(", ") || "—";
        s.hlsLevel = `${hls.currentLevel + 1}/${hls.levels.length}`;
      }
      s.url = current.url?.slice(0, 80) + (current.url?.length > 80 ? "…" : "");
      setStats(s);
    }
    collect();
    statsInterval.current = setInterval(collect, 1000);
    return () => clearInterval(statsInterval.current);
  }, [showStats, current.url]);

  const isMixed = location.protocol === "https:" ? (u) => u?.startsWith("http://") : () => false;
  // External IPTV servers don't send CORS headers — always proxy M3U/Xtream streams
  const origin = API || location.origin;
  const needsProxy = (u) => u && !u.startsWith('/') && !u.startsWith(origin) && !current?._direct;
  const streamProxy = (u) => (u?.startsWith('/') || u?.startsWith(origin)) ? u : `${API}/stream?url=${encodeURIComponent(u)}`;

  function initPlayer(url) {
    const video = videoRef.current;
    if (!video || !url) return;
    setStreamErr(null);
    destroyPlayers();
    video.removeAttribute("src");

    // Native <video> error handler (for direct src= playback)
    video.onerror = () => {
      // Skip if HLS.js or mpegts.js is handling (they have their own error handlers)
      if (hlsRef.current || mpegtsRef.current) return;
      const e = video.error;
      const msgs = { 1: "Playback aborted", 2: "Network error — could not load stream", 3: "Decode error — stream format not supported", 4: "Source not supported — the stream format or URL is invalid" };
      setStreamErr({ icon: "⚠️", title: "Playback Error", body: msgs[e?.code] || "Unknown video error" });
    };

    function startHls(u) {
      if (window.Hls?.isSupported()) {
        const opts = { enableWorker: false, fragLoadingMaxRetry: 2 };
        // On HTTPS pages, proxy HTTP streams through proxy
        // The proxy rewrites HLS manifests so segments also go through proxy (same IP)
        if (needsProxy(u)) {
          u = streamProxy(u);
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
          } else if (code === 459 || code === 462) {
            title = `Token Expired (${code})`;
            body = "The stream token has expired or was rejected. Click play again to get a fresh token.";
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
        video.src = needsProxy(u) ? streamProxy(u) : u; video.play().catch(()=>{});
      }
    }

    function startMpegts(u) {
      // Proxy HTTP streams through Cloudflare Worker when on HTTPS
      if (needsProxy(u)) u = streamProxy(u);
      if (!window.mpegts?.isSupported()) {
        video.src = u; video.play().catch(()=>{}); return;
      }
      const player = window.mpegts.createPlayer({ type: "mpegts", isLive: true, url: u },
        { enableWorker: false, lazyLoadMaxDuration: 3 * 60, seekType: "range" });
      mpegtsRef.current = player;
      player.on(window.mpegts.Events.ERROR, (errType, errDetail, errInfo) => {
        const code = errInfo?.code;
        let title = "Playback Error";
        let body;
        if (code === 404) {
          title = "Stream Not Found (404)";
          body = "The stream URL returned 404. The channel may be offline or the URL has changed.";
        } else if (code === 403) {
          title = "Access Denied (403)";
          body = "The stream server rejected the request. Your credentials may not have access.";
        } else if (code === 459 || code === 462) {
          title = `Token Expired (${code})`;
          body = "The stream token has expired or was rejected. Click play again to get a fresh token.";
        } else if (code >= 400 && code < 500) {
          title = `Client Error (${code})`;
          body = `The stream request was rejected with HTTP ${code}.`;
        } else if (code >= 500) {
          title = `Server Error (${code})`;
          body = "The stream server returned an error. It may be overloaded or temporarily down.";
        } else if (errType === "NetworkError") {
          title = "Network Error";
          body = `Could not load the stream. ${errInfo?.msg || "Check your connection or try again."}`;
        } else if (errDetail?.includes("Unsupported media type")) {
          // Fallback to native video if mpegts.js can't handle it
          console.warn("mpegts.js: Unsupported media type, falling back to native <video>");
          destroyPlayers();
          video.src = u;
          video.play().catch(()=>{});
          return;
        } else {
          body = `${errType}: ${errDetail || "Unknown error"}${code ? ` (HTTP ${code})` : ""}`;
        }
        setStreamErr({ icon: "⚠️", title, body });
        destroyPlayers();
      });
      player.attachMediaElement(video);
      player.load();
      player.play().catch(()=>{});
    }

    const SRI_HASHES = {
      "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.12/hls.min.js": "sha384-miJUhTuRucSoqFe3/VSB2sRghSMoev6wpPoEyj5fhF0PARehD+naPBsAkl5NqwPO",
      "https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js": "sha384-Z2H/TjKWDNZA/2luGOnjLx9pcva7cK4VSWC+hZn78Kr5uG8YbMpxdz+wWXBMO6N/",
    };
    function loadScript(src, cb) {
      if (document.querySelector(`script[src="${src}"]`)) { cb(); return; }
      const s = document.createElement("script");
      s.src = src;
      s.crossOrigin = "anonymous";
      if (SRI_HASHES[src]) s.integrity = SRI_HASHES[src];
      s.onload = cb;
      document.head.appendChild(s);
    }

    // Direct video files (MP4, MKV, AVI, etc.) — play natively, not via mpegts/HLS
    const fileExt = url.split(/[?#]/)[0].split(".").pop()?.toLowerCase();
    if (["mp4", "mkv", "avi", "mov", "webm", "mp3", "aac"].includes(fileExt)) {
      video.src = needsProxy(url) ? streamProxy(url) : url; video.play().catch(()=>{});
      return;
    }

    // Stalker VOD/series items are direct video files served by the portal.
    const isStalkerVod = (current.type === "vod" || current.type === "series")
      && (url.includes("/play/movie.php") || url.includes("/play/live.php") || url.includes("play_token="));
    if (isStalkerVod) {
      if (url.includes(".m3u8")) {
        if (window.Hls) startHls(url);
        else loadScript("https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.12/hls.min.js",
                        () => startHls(url));
      } else {
        video.src = needsProxy(url) ? streamProxy(url) : url; video.play().catch(()=>{});
      }
      return;
    }

    const needTs  = url.includes("extension=ts") || /\.ts(\?|$)/.test(url)
      || (current.type === "live" && !url.includes(".m3u8"));
    const needHls = !needTs && (url.includes(".m3u8") || url.includes("/live/") || url.includes("/movie/"));

    // For Xtream live streams on HTTPS, proxy raw TS through stream proxy
    // (HLS .m3u8 has IP-bound segment tokens that break with proxied manifests)
    if (needTs && needsProxy(url)) {
      const proxied = streamProxy(url);
      if (window.mpegts) startMpegts(proxied);
      else loadScript("https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js",
                      () => startMpegts(proxied));
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
      video.src = needsProxy(url) ? streamProxy(url) : url; video.play().catch(()=>{});
    }
  }

  useEffect(() => {
    let cancelled = false;
    const sessionId = ++adSessionRef.current;
    const video = videoRef.current;
    if (!video || !current.url) return;

    async function start() {
      setStreamErr(null);
      setAdState(null);
      destroyPlayers();

      if (!adPlayedRef.current) {
        adPlayedRef.current = true;
        const ad = await fetchVastAd(EXOCLICK_VAST_URL, video);
        if (cancelled || sessionId !== adSessionRef.current) return;
        if (ad?.mediaUrl) {
          const played = await playVastPreroll(video, ad, () => cancelled || sessionId !== adSessionRef.current);
          if (cancelled || sessionId !== adSessionRef.current) return;
          if (!played) {
            setAdState(null);
          }
        }
      }

      if (cancelled || sessionId !== adSessionRef.current) return;
      initPlayer(current.url);
      showOSD();
    }

    start();
    return () => {
      cancelled = true;
      adSessionRef.current += 1;
      adFinishRef.current = null;
      setAdState(null);
      destroyPlayers();
      clearTimeout(osdTimer.current);
      clearTimeout(qchTimer.current);
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
        case "s":
          e.preventDefault();
          setShowStats(prev => !prev); break;
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
    clearTimeout(qchTimer.current);
    qchTimer.current = setTimeout(() => setShowQCH(false), 2500);
    showOSD();
  }

  function nextChannel() {
    if (!channelList || channelList.length === 0) return;
    const max = channelList.length - 1;
    const i = Math.min(max, (chIdx < 0 ? 0 : chIdx) + 1);
    setChIdx(i); setCurrent(channelList[i]);
    setShowQCH(true);
    clearTimeout(qchTimer.current);
    qchTimer.current = setTimeout(() => setShowQCH(false), 2500);
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
          {adState?.active && (
            <div className="player-ad">
              <div className="player-ad-badge">ExoClick Ad</div>
              <div className="player-ad-title">{adState.title}</div>
              <div className="player-ad-meta">{adState.mediaType || "VAST preroll"}</div>
              <div className="player-ad-actions">
                {adState.clickThrough && (
                  <button className="player-ad-link" onClick={() => window.open(adState.clickThrough, "_blank", "noopener,noreferrer")}>
                    Learn More
                  </button>
                )}
                {adState.skipEnabled && (adState.canSkip ? (
                  <button className="player-ad-skip" onClick={() => adFinishRef.current?.("skip")}>
                    Skip Ad
                  </button>
                ) : (
                  <div className="player-ad-countdown">Skip in {adState.skipRemaining}s</div>
                ))}
              </div>
            </div>
          )}
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
                ? <img className="osd-logo" src={imgSrc(current.logo)} alt="" onError={e => e.target.style.display="none"} />
                : <div className="osd-logo-ph">{current.type==="live"?"📺":"🎬"}</div>}
              <div>
                {current.num && <div className="osd-num">CH {current.num}</div>}
                <div className="osd-name">{current.name}</div>
                {epgNow && <div className="osd-epg">▶ {epgNow.title}</div>}
              </div>
            </div>
          )}
          {/* Stream stats overlay */}
          {showStats && (
            <div style={{position:"absolute",top:8,right:8,background:"rgba(0,0,0,.82)",color:"#0f0",
              fontFamily:"monospace",fontSize:".68rem",padding:".6rem .8rem",borderRadius:6,lineHeight:1.7,
              zIndex:20,maxWidth:"320px",pointerEvents:"none"}}>
              <div style={{color:"#fff",fontWeight:700,marginBottom:4,fontSize:".72rem"}}>Stream Stats</div>
              {Object.entries(stats).map(([k, v]) => (
                <div key={k}><span style={{color:"#aaa"}}>{k}: </span>{v}</div>
              ))}
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
                      ? <img className="qch-thumb" src={imgSrc(ch.logo)} alt="" onError={e => e.target.style.display="none"} />
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
              <button className="player-ctrl" onClick={prevChannel}>◀ {t("prev")}</button>
              <button className="player-ctrl" onClick={nextChannel}>{t("next")} ▶</button>
            </>
          )}
          <button className="player-ctrl" onClick={pip} title="Picture in Picture">⧉ {t("pip")}</button>
          <button className={`player-ctrl${showStats?" on":""}`} onClick={() => setShowStats(s=>!s)} title="Stream Stats">📊</button>
          <button className="player-ctrl" onClick={() => { onFav?.(current); showOSD(); }} title={t("fav")}>
            {isFav?.(current) ? `♥ ${t("fav")}` : `♡ ${t("fav")}`}
          </button>
          <button className="player-close" onClick={onClose}>✕ {t("close")}</button>
        </div>
        <div className="kbd-hint">
          <span><span className="kbd">Space</span>{t("playPause")}</span>
          <span><span className="kbd">F</span>{t("fullscreen")}</span>
          <span><span className="kbd">M</span>{t("mute")}</span>
          <span><span className="kbd">←→</span>{current.type==="live"?t("channels"):"±10s"}</span>
          <span><span className="kbd">↑↓</span>{current.type==="live"?t("channels"):t("volume")}</span>
          <span><span className="kbd">P</span>{t("pip")}</span>
          <span><span className="kbd">S</span>Stats</span>
          <span><span className="kbd">Esc</span>Close</span>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════════
function Setup({ onConnect, onImportMultiple, connections = [], onReconnect, onRemoveConn, onEdit, authUser, isGuest, onLogout, t: st }) {
  const t = st || ((k) => k);
  const [type, setType]     = useState("xtream");
  const [f, setF]           = useState({ server:"", user:"", pass:"", mac:"", url:"", serial:"", deviceId:"", deviceId2:"" });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rawText, setRawText] = useState("");
  const [detected, setDetected] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr]       = useState("");
  const [expiredPrompt, setExpiredPrompt] = useState(null); // { conn, validation }
  const [skipValidation, setSkipValidation] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(() => localStorage.getItem("sv-disclaimer-accepted") === "1");
  const [diagResults, setDiagResults] = useState({});
  const [diagLoading, setDiagLoading] = useState({});
  const set = (k,v) => setF(p => ({...p,[k]:v}));

  async function diagnose(c) {
    setDiagLoading(p => ({ ...p, [c.id]: true }));
    setDiagResults(p => ({ ...p, [c.id]: null }));
    try {
      const cfg = c.config || c;
      const body = { type: c.type };
      if (c.type === "stalker") { body.portal = cfg.portal || cfg.server; body.mac = cfg.mac; }
      else if (c.type === "xtream") { body.server = cfg.server; body.user = cfg.user; body.pass = cfg.pass; }
      else if (c.type === "m3u") { body.url = cfg.url; }
      const res = await fetch(`${API}/api/diagnose`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      setDiagResults(p => ({ ...p, [c.id]: data }));
    } catch (e) {
      setDiagResults(p => ({ ...p, [c.id]: { reachable: false, details: { error: e.message } } }));
    }
    setDiagLoading(p => ({ ...p, [c.id]: false }));
  }

  // Validate saved connection before reconnecting
  async function validateAndReconnect(conn) {
    if (conn.type !== "stalker") { onReconnect(conn.id); return; }
    setLoading(true); setErr("");
    try {
      const cfg = conn.config || {};
      const vRes = await fetch(`${API}/stalker/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portal: cfg.server, mac: cfg.mac, serial: cfg.serial, deviceId: cfg.deviceId, deviceId2: cfg.deviceId2 }),
      });
      const v = await vRes.json();
      if (!v.portalReachable) { setErr("Portal unreachable. Check your connection."); return; }
      if (v.status === "expired" || v.status === "blocked" || v.status === "suspended" || v.status === "unregistered") {
        setExpiredPrompt({ conn, validation: v });
        return;
      }
      onReconnect(conn.id);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    // Pre-fill from last active connection (or most recent saved connection)
    try {
      const conns = localStorage.getItem("sv-connections");
      if (conns) {
        const connList = JSON.parse(conns);
        if (!connList?.length) return;
        const acId = localStorage.getItem("sv-activeConn");
        const activeId = acId ? JSON.parse(acId) : null;
        const active = (activeId && connList.find(c => c.id === activeId)) || connList[connList.length - 1];
        if (active?.config) {
          const c = active.config;
          if (c.type) setType(c.type);
          if (c.server) set("server", c.server);
          if (c.user) set("user", c.user);
          if (c.pass) set("pass", c.pass);
          if (c.mac) set("mac", c.mac);
          if (c.url) set("url", c.url);
          if (c.serial) set("serial", c.serial);
          if (c.deviceId) set("deviceId", c.deviceId);
          if (c.deviceId2) set("deviceId2", c.deviceId2);
        }
      }
    } catch {}
  }, []);

  function handleConnectClick() {
    if (!disclaimerAccepted) { setShowDisclaimer(true); return; }
    connect();
  }

  function acceptDisclaimer() {
    setDisclaimerAccepted(true);
    localStorage.setItem("sv-disclaimer-accepted", "1");
    setShowDisclaimer(false);
    connect();
  }

  async function connect() {
    setErr(""); setLoading(true);
    try {
      if (type === "xtream") {
        if (!f.server||!f.user||!f.pass) throw new Error("All fields required");
        const server = f.server.trim().replace(/\/$/,"");
        const api = makeXtreamAPI(server, f.user, f.pass);
        const data = await api.auth();
        if (data?.user_info?.auth === 0) throw new Error("Invalid credentials");
        // Connection saved by handleConnect in App
        onConnect({ type, server, user:f.user, pass:f.pass, info:data?.user_info });
      } else if (type === "m3u") {
        if (!f.url) throw new Error("Playlist URL required");
        const res = await proxyFetch(f.url.trim());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text.includes("#EXTM3U")) throw new Error("Not a valid M3U playlist");
        const channels = parseM3U(text);
        if (!channels.length) throw new Error("No channels found");
        // Connection saved by handleConnect in App
        onConnect({ type, url:f.url, channels });
      } else if (type === "stalker") {
        if (!f.server||!f.mac) throw new Error("Portal URL and MAC required");
        const server = f.server.trim().replace(/\/$/,"");
        const macTrimmed = f.mac.trim();
        const serialTrimmed = f.serial?.trim() || undefined;
        const deviceIdTrimmed = f.deviceId?.trim() || undefined;
        const deviceId2Trimmed = (f.deviceId2?.trim() || f.deviceId?.trim()) || undefined;

        if (skipValidation) {
          track("connect");
          onConnect({
            type, server, mac: macTrimmed,
            serial: serialTrimmed, deviceId: deviceIdTrimmed, deviceId2: deviceId2Trimmed,
          });
        } else {
          const validateBody = JSON.stringify({
            portal: server, mac: macTrimmed,
            serial: serialTrimmed, deviceId: deviceIdTrimmed, deviceId2: deviceId2Trimmed
          });

          const vRes = await fetch(`${API}/stalker/validate`, {
            method: "POST",
            headers: {"Content-Type":"application/json","X-Guest-Id":GUEST_ID},
            body: validateBody
          });
          const v = await vRes.json();

          if (v.error && !v.portalReachable) throw new Error(v.error);
          if (v.status === "expired") throw new Error(`Account expired${v.expiry ? ` on ${v.expiry}` : ""}. Contact your provider.`);
          if (v.status === "blocked") throw new Error("Account is blocked. Contact your provider.");
          if (v.status === "suspended") throw new Error("Account is suspended. Contact your provider.");
          if (v.status === "unregistered") throw new Error("MAC address is not registered with this portal.");

          if (v.daysLeft !== null && v.daysLeft <= 7 && v.daysLeft > 0) {
            console.warn(`Account expires in ${v.daysLeft} days (${v.expiry})`);
          }

          track("connect");
          onConnect({
            type, server, mac: macTrimmed,
            serial: v.serial || serialTrimmed, deviceId: v.deviceId || deviceIdTrimmed,
            deviceId2: v.deviceId2 || deviceId2Trimmed,
            accountInfo: { status: v.status, expiry: v.expiry, daysLeft: v.daysLeft, tariff: v.tariff, maxConnections: v.maxConnections }
          });
        }
      } else {
        // Connection saved by handleConnect in App
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

      // Extract serial: look for "serial", "seriel", "sn", "s/n" labels followed by value
      const serialMatch = block.match(/(?:seri[ae]l(?:\s*(?:number|num|#))?|s\/n|sn)\s*(?:=>|[:=\s])\s*([A-Za-z0-9_-]+)/i);
      const serial = serialMatch ? serialMatch[1] : "";

      // Extract deviceId2: look for "device id 2", "deviceid2", "device_id_2" labels (check this BEFORE deviceId)
      const deviceId2Match = block.match(/(?:device[\s_.-]*id[\s_.-]*2|deviceid2|device_id_2)\s*(?:=>|[:=\s])\s*([A-Za-z0-9_-]+)/i);
      let deviceId2 = deviceId2Match ? deviceId2Match[1] : "";

      // Extract deviceId: look for "device id" labels, grab the longest hex/alnum token (skip short decorator remnants like "12")
      const deviceIdLine = block.match(/(?:device[\s_.-]*id|deviceid|device_id)(?![\s_.-]*2)\s*(?:=>|[:=\s])\s*(.+)/i);
      let deviceId = "";
      if (deviceIdLine) {
        const tokens = deviceIdLine[1].trim().split(/\s+/);
        deviceId = tokens.reduce((best, t) => t.replace(/[^A-Za-z0-9]/g,"").length > best.length ? t.replace(/[^A-Za-z0-9]/g,"") : best, "");
      }

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

    // Detect Xtream from labeled key-value format (Host/Username/Password)
    const hostMatch = text.match(/(?:host|server|url|portal)\s*(?:=>|[:=])\s*(https?:\/\/[^\s,;]+)/gi);
    const userMatch = text.match(/(?:username|user|login)\s*(?:=>|[:=])\s*([^\s,;]+)/gi);
    const passMatch = text.match(/(?:password|pass)\s*(?:=>|[:=])\s*([^\s,;]+)/gi);
    if (hostMatch && userMatch && passMatch) {
      // Pair them by order (first host with first user/pass, etc.)
      const hosts = hostMatch.map(m => m.replace(/^[^:=]*[=:]\s*/i, "").trim());
      const users = userMatch.map(m => m.replace(/^[^:=]*[=:]\s*/i, "").trim());
      const passes = passMatch.map(m => m.replace(/^[^:=]*[=:]\s*/i, "").trim());
      const count = Math.min(hosts.length, users.length, passes.length);
      for (let i = 0; i < count; i++) {
        const server = hosts[i].replace(/\/+$/, "");
        if (!results.find(r => r.type === "xtream" && r.server === server && r.user === users[i])) {
          results.push({ type: "xtream", server, user: users[i], pass: passes[i], label: `Xtream · ${users[i]}` });
        }
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

  const TYPES = [["import",t("import")],["xtream",t("xtreamCodes")],["m3u",t("m3uPlaylist")],["stalker",t("stalkerPortal")],["hls",t("directHLS")]];

  return (
    <div className="setup">
      <div className="card">
        <div className="logo">Portal Heaven</div>
        <div className="tagline">{t("tagline")}</div>

        {/* Logged-in user info */}
        {(authUser || isGuest) && (
          <div style={{display:"flex",alignItems:"center",gap:".6rem",padding:".55rem .75rem",marginBottom:"1rem",
            background:"var(--s2)",border:"1px solid var(--b1)",borderRadius:"10px"}}>
            <div style={{width:34,height:34,borderRadius:"50%",background:"var(--accent-22)",
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:".9rem",fontWeight:700,
              color:"var(--accent)",flexShrink:0}}>
              {authUser ? authUser.username?.[0]?.toUpperCase() || "U" : "G"}
            </div>
            <div style={{flex:1,overflow:"hidden"}}>
              <div style={{fontSize:".82rem",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {authUser ? authUser.username : "Guest"}
              </div>
              <div style={{fontSize:".62rem",color:"var(--t3)"}}>
                {authUser ? `${authUser.role} · ${connections.length}/${authUser.maxConnections || authUser.limits?.maxConnections || "?"} connections` : "Guest mode · data stored locally"}
              </div>
            </div>
            {(authUser || isGuest) && (
              <button onClick={onLogout}
                style={{background:"none",border:"1px solid var(--b2)",borderRadius:6,cursor:"pointer",
                  fontSize:".65rem",color:"var(--t3)",padding:".25rem .6rem",transition:"all .2s"}}
                onMouseEnter={e => { e.currentTarget.style.borderColor="var(--danger)"; e.currentTarget.style.color="var(--danger)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor="var(--b2)"; e.currentTarget.style.color="var(--t3)"; }}>
                Logout
              </button>
            )}
          </div>
        )}

        {/* Saved connections — quick reconnect */}
        {connections.length > 0 && (
          <div style={{marginBottom:"1.2rem"}}>
            <div className="fl" style={{marginBottom:".5rem"}}>{t("savedConns")}</div>
            <div className="saved-conns">
              {connections.map(c => (
                <div key={c.id} className="saved-conn" style={{borderLeft:`3px solid ${c.color}`, flexDirection:"column", alignItems:"stretch"}}
                  onClick={() => validateAndReconnect(c)}
                  onMouseEnter={e => e.currentTarget.style.borderColor="var(--accent)"}
                  onMouseLeave={e => { e.currentTarget.style.borderColor="var(--b2)"; e.currentTarget.style.borderLeftColor=c.color; }}>
                  <div style={{display:"flex", alignItems:"center", gap:".6rem"}}>
                    <span style={{fontSize:"1.1rem"}}>{CONN_ICONS[c.type] || "📡"}</span>
                    <div style={{flex:1,overflow:"hidden"}}>
                      <div style={{fontSize:".82rem",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.label}</div>
                      <div style={{fontSize:".62rem",color:"var(--t3)",textTransform:"capitalize"}}>{c.type}</div>
                    </div>
                    <button style={{background:"none",border:"1px solid var(--b2)",borderRadius:4,cursor:"pointer",fontSize:".65rem",color:"var(--t2)",padding:".15rem .4rem"}}
                      title="Diagnose connection"
                      onClick={e => { e.stopPropagation(); diagnose(c); }}>
                      {diagLoading[c.id] ? "..." : "🩺"}
                    </button>
                    <span style={{fontSize:".7rem",color:"var(--accent)",fontWeight:600}}>{loading ? "..." : t("connectArrow")}</span>
                    <button onClick={e => { e.stopPropagation(); onEdit(c); }}
                      style={{background:"none",border:"none",color:"var(--t2)",cursor:"pointer",fontSize:".85rem",padding:"2px 6px",
                        borderRadius:"4px",lineHeight:1,flexShrink:0}}
                      title="Edit connection">✎</button>
                    <button onClick={e => { e.stopPropagation(); if(confirm(`Delete "${c.label}"?`)) onRemoveConn?.(c.id); }}
                      style={{background:"none",border:"none",color:"var(--t3)",cursor:"pointer",fontSize:".85rem",padding:"2px 6px",
                        borderRadius:"4px",lineHeight:1,flexShrink:0}}
                      onMouseEnter={e => e.currentTarget.style.color="#e74c3c"}
                      onMouseLeave={e => e.currentTarget.style.color="var(--t3)"}
                      title="Delete connection">✕</button>
                  </div>
                  {diagResults[c.id] && (
                    <div style={{marginTop:".4rem",padding:".35rem .5rem",background:"var(--s1)",borderRadius:6,fontSize:".65rem",lineHeight:1.6,fontFamily:"monospace"}}>
                      <span style={{color: diagResults[c.id].reachable ? "#4caf50" : "#f44336",fontWeight:700}}>
                        {diagResults[c.id].reachable ? "● Reachable" : "● Unreachable"}
                      </span>
                      {diagResults[c.id].latency != null && <span style={{color:"var(--t2)",marginLeft:".5rem"}}>{diagResults[c.id].latency}ms</span>}
                      {Object.entries(diagResults[c.id].details || {}).map(([k, v]) => (
                        <div key={k} style={{color:"var(--t3)"}}>{k}: <span style={{color:"var(--t2)"}}>{String(v)}</span></div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={{borderBottom:"1px solid var(--b2)",margin:"1rem 0 .2rem",position:"relative"}}>
              <span style={{position:"absolute",left:"50%",transform:"translate(-50%,-50%)",background:"var(--s1)",
                padding:"0 .6rem",fontSize:".65rem",color:"var(--t3)",textTransform:"uppercase",letterSpacing:".08em",fontWeight:600}}>
                {t("orAddNew")}
              </span>
            </div>
          </div>
        )}

        {err && <div className="err">⚠ {err}</div>}
        <div className="tabs">
          {TYPES.map(([k,label]) => (
            <button key={k} className={`tab ${type===k?"on":""}`} onClick={() => {setType(k);setErr("")}}>
              {label}
            </button>
          ))}
        </div>
        {type==="xtream" && (<>
          <div className="fg"><label className="fl">{t("serverURL")}</label>
            <input className="fi" placeholder="http://server.com:8080" value={f.server} onChange={e=>set("server",e.target.value)} /></div>
          <div className="fg"><label className="fl">{t("username")}</label>
            <input className="fi" placeholder="username" value={f.user} onChange={e=>set("user",e.target.value)} /></div>
          <div className="fg"><label className="fl">{t("password")}</label>
            <input className="fi" type="password" placeholder="password" value={f.pass} onChange={e=>set("pass",e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleConnectClick()} /></div>
        </>)}
        {type==="m3u" && (
          <div className="fg"><label className="fl">{t("playlistURL")}</label>
            <input className="fi" placeholder="http://example.com/playlist.m3u" value={f.url} onChange={e=>set("url",e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleConnectClick()} />
            <div className="fhint">Supports .m3u and .m3u8 playlist files</div></div>
        )}
        {type==="stalker" && (<>
          <div className="fg"><label className="fl">{t("portalURL")}</label>
            <input className="fi" placeholder="http://server/stalker_portal/c/" value={f.server} onChange={e=>set("server",e.target.value)} /></div>
          <div className="fg"><label className="fl">{t("macAddress")}</label>
            <input className="fi" placeholder="00:1A:79:XX:XX:XX" value={f.mac} onChange={e=>set("mac",e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleConnectClick()} />
            <div className="fhint">The MAC address registered with your IPTV provider</div></div>
          <label style={{display:"flex",alignItems:"center",gap:".4rem",marginTop:".5rem",cursor:"pointer",fontSize:".72rem",color:"var(--t2)"}}>
            <input type="checkbox" checked={skipValidation} onChange={e => setSkipValidation(e.target.checked)}
              style={{accentColor:"var(--accent)",cursor:"pointer"}} />
            Skip validation (connect without checking account status)
          </label>
          <div style={{marginTop:".5rem"}}>
            <button type="button" style={{background:"none",border:"none",color:"var(--accent)",fontSize:".72rem",cursor:"pointer",padding:0,fontFamily:"'DM Sans',sans-serif"}}
              onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? `▾ ${t("hideAdvanced")}` : `▸ ${t("advancedOpts")}`}
            </button>
          </div>
          {showAdvanced && (<>
            <div className="fg"><label className="fl">{t("serialNumber")}</label>
              <input className="fi" placeholder="Optional — leave blank for auto" value={f.serial} onChange={e=>set("serial",e.target.value)} />
              <div className="fhint">Device serial number (if required by provider)</div></div>
            <div className="fg"><label className="fl">{t("deviceId")}</label>
              <input className="fi" placeholder="Optional — used for both ID1 and ID2 if ID2 is blank" value={f.deviceId} onChange={e=>set("deviceId",e.target.value)} />
              <div className="fhint">Primary device identifier</div></div>
            <div className="fg"><label className="fl">{t("deviceId2")}</label>
              <input className="fi" placeholder="Optional — defaults to Device ID above" value={f.deviceId2} onChange={e=>set("deviceId2",e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleConnectClick()} />
              <div className="fhint">Secondary device identifier (some providers use same value for both)</div></div>
          </>)}
        </>)}
        {type==="hls" && (
          <div style={{padding:"1rem 0",color:"var(--t2)",fontSize:".86rem",lineHeight:1.7}}>
            {t("hlsPlayNote")}
          </div>
        )}
        {type==="import" && (
          <div>
            <div className="fg">
              <label className="fl">{t("pasteRaw")}</label>
              <textarea className="fi" style={{minHeight:"120px",resize:"vertical",fontFamily:"monospace",fontSize:".75rem"}}
                placeholder={"Paste any text containing:\n• Stalker portal URLs + MAC addresses\n• Xtream Codes URLs with username/password\n• M3U/M3U8 playlist URLs\n\nAuto-detects all connection types."}
                value={rawText}
                onChange={e => { setRawText(e.target.value); const d = detectFromText(e.target.value); setDetected(d); setSelected(new Set()); }}
              />
            </div>
            {detected.length > 0 && (
              <div style={{display:"flex",flexDirection:"column",gap:".4rem",marginBottom:"1rem"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <div className="fl">{t("detected")} ({detected.length})</div>
                  {detected.length > 1 && (
                    <label style={{fontSize:".65rem",color:"var(--t3)",cursor:"pointer",display:"flex",alignItems:"center",gap:".3rem"}}>
                      <input type="checkbox" checked={selected.size === detected.length}
                        onChange={e => setSelected(e.target.checked ? new Set(detected.map((_,i) => i)) : new Set())} />
                      Select all
                    </label>
                  )}
                </div>
                {detected.map((d, i) => (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:".5rem",padding:".45rem .65rem",
                    background: selected.has(i) ? "var(--accent-14)" : "var(--s2)",
                    border: `1px solid ${selected.has(i) ? "var(--accent)" : "var(--b2)"}`,
                    borderRadius:"8px",cursor:"pointer",transition:"all .2s"}}
                    onClick={() => {
                      if (detected.length > 1) {
                        setSelected(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
                      } else {
                        if (d.type==="stalker") { setType("stalker"); set("server",d.server); set("mac",d.mac); if(d.serial){set("serial",d.serial);setShowAdvanced(true);} if(d.deviceId){set("deviceId",d.deviceId);setShowAdvanced(true);} if(d.deviceId2){set("deviceId2",d.deviceId2);setShowAdvanced(true);} else if(d.deviceId){set("deviceId2",d.deviceId);} }
                        else if (d.type==="xtream") { setType("xtream"); set("server",d.server); set("user",d.user); set("pass",d.pass); }
                        else if (d.type==="m3u") { setType("m3u"); set("url",d.url); }
                      }
                    }}
                    onMouseEnter={e => { if (!selected.has(i)) e.currentTarget.style.borderColor="var(--accent)"; }}
                    onMouseLeave={e => { if (!selected.has(i)) e.currentTarget.style.borderColor="var(--b2)"; }}>
                    {detected.length > 1 && (
                      <input type="checkbox" checked={selected.has(i)} readOnly
                        style={{accentColor:"var(--accent)",cursor:"pointer"}} />
                    )}
                    <span style={{fontSize:".7rem",fontWeight:700,color:"var(--accent)",textTransform:"uppercase",minWidth:"50px"}}>{d.type}</span>
                    <span style={{fontSize:".78rem",color:"var(--t1)",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.label}</span>
                    {detected.length === 1 && <span style={{fontSize:".65rem",color:"var(--t3)"}}>{t("clickToFill")}</span>}
                  </div>
                ))}
                {selected.size > 0 && (
                  <button className="btn-primary" style={{marginTop:".4rem"}}
                    onClick={() => {
                      const items = [...selected].sort((a,b)=>a-b).map(i => detected[i]);
                      if (onImportMultiple) onImportMultiple(items);
                    }}>
                    Import {selected.size} connection{selected.size > 1 ? "s" : ""}
                  </button>
                )}
              </div>
            )}
            {rawText && detected.length === 0 && (
              <div style={{fontSize:".78rem",color:"var(--t3)",padding:".5rem 0"}}>{t("noConnsDetected")}</div>
            )}
          </div>
        )}
        <button className="btn-primary" onClick={handleConnectClick} disabled={loading || type==="import"} style={type==="import"?{display:"none"}:{}}>
          {loading ? t("connecting") : t("connectArrow")}
        </button>

        {/* Expired/blocked connection prompt */}
        {expiredPrompt && createPortal(
          <div style={{position:"fixed",inset:0,zIndex:99999,background:"rgba(0,0,0,0.6)",
            display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
            onClick={e => { if (e.target === e.currentTarget) setExpiredPrompt(null); }}>
            <div style={{background:"var(--s1,#0f0f1c)",border:"1px solid rgba(255,255,255,0.08)",
              borderRadius:14,padding:"1.5rem",width:"100%",maxWidth:400,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
              <div style={{fontSize:"2rem",textAlign:"center",marginBottom:".75rem"}}>
                {expiredPrompt.validation.status === "expired" ? "⏰" : "🚫"}
              </div>
              <div style={{fontSize:"1rem",fontWeight:600,textAlign:"center",marginBottom:".3rem",color:"var(--t1,#dde0f5)"}}>
                {expiredPrompt.validation.status === "expired" ? "Account Expired" :
                 expiredPrompt.validation.status === "blocked" ? "Account Blocked" :
                 expiredPrompt.validation.status === "suspended" ? "Account Suspended" :
                 "Account Unregistered"}
              </div>
              <div style={{fontSize:".78rem",color:"var(--t2,#8080aa)",textAlign:"center",marginBottom:"1rem",lineHeight:1.6}}>
                {expiredPrompt.validation.expiry && `Expired on ${expiredPrompt.validation.expiry}. `}
                {expiredPrompt.conn.label}
              </div>
              <div style={{display:"flex",gap:".5rem"}}>
                <button onClick={() => { onRemoveConn?.(expiredPrompt.conn.id); setExpiredPrompt(null); }}
                  style={{flex:1,padding:".55rem",background:"#ff446622",border:"1px solid #ff446650",borderRadius:8,
                    color:"#ff4466",fontSize:".8rem",fontWeight:600,cursor:"pointer"}}>
                  Delete
                </button>
                <button onClick={() => { setExpiredPrompt(null); onReconnect(expiredPrompt.conn.id); }}
                  style={{flex:1,padding:".55rem",background:"var(--s2,#16162a)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,
                    color:"var(--t2,#8080aa)",fontSize:".8rem",cursor:"pointer"}}>
                  Connect Anyway
                </button>
                <button onClick={() => setExpiredPrompt(null)}
                  style={{flex:1,padding:".55rem",background:"var(--s2,#16162a)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,
                    color:"var(--t1,#dde0f5)",fontSize:".8rem",cursor:"pointer"}}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        , document.body)}

        {showDisclaimer && createPortal(
          <div style={{position:"fixed",inset:0,zIndex:99999,background:"rgba(0,0,0,0.7)",
            display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
            onClick={e => { if (e.target === e.currentTarget) setShowDisclaimer(false); }}>
            <div style={{background:"var(--s1,#0f0f1c)",border:"1px solid rgba(255,255,255,0.08)",
              borderRadius:14,padding:"1.8rem",width:"100%",maxWidth:460,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
              <div style={{fontSize:"1.6rem",textAlign:"center",marginBottom:".6rem"}}>⚖️</div>
              <div style={{fontSize:"1.05rem",fontWeight:700,textAlign:"center",marginBottom:".8rem",color:"var(--t1,#dde0f5)"}}>
                Legal Disclaimer
              </div>
              <div style={{fontSize:".78rem",color:"var(--t2,#8080aa)",lineHeight:1.7,marginBottom:"1.2rem"}}>
                <p style={{marginBottom:".6rem"}}>Portal Heaven is a <strong>media player application</strong> only. It does not provide, host, or distribute any content, streams, or IPTV services.</p>
                <p style={{marginBottom:".6rem"}}>By connecting an external service, you confirm that:</p>
                <ul style={{paddingLeft:"1.2rem",margin:".4rem 0"}}>
                  <li>You have a <strong>valid, legal subscription</strong> from your IPTV provider.</li>
                  <li>You are <strong>solely responsible</strong> for the content you access.</li>
                  <li>You will <strong>not use this app</strong> to access pirated or unauthorized content.</li>
                  <li>Portal Heaven and its developers <strong>bear no responsibility</strong> for the content or legality of third-party services you connect to.</li>
                </ul>
                <p style={{marginTop:".6rem",fontSize:".72rem",color:"var(--t3)"}}>This disclaimer is shown once and your acceptance is stored locally.</p>
              </div>
              <div style={{display:"flex",gap:".5rem"}}>
                <button onClick={() => setShowDisclaimer(false)}
                  style={{flex:1,padding:".6rem",background:"var(--s2,#16162a)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,
                    color:"var(--t2,#8080aa)",fontSize:".82rem",cursor:"pointer"}}>
                  Cancel
                </button>
                <button onClick={acceptDisclaimer}
                  style={{flex:2,padding:".6rem",background:"var(--accent,#00d4ff)",border:"none",borderRadius:8,
                    color:"#000",fontSize:".82rem",fontWeight:700,cursor:"pointer"}}>
                  I Agree — Continue
                </button>
              </div>
            </div>
          </div>
        , document.body)}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// CONNECTION MANAGER MODAL
// ══════════════════════════════════════════════════════════════════
const CONN_ICONS = { xtream:"📡", stalker:"📺", m3u:"📋", hls:"🔗" };

const ConnectionManager = memo(function ConnectionManager({ connections, activeConnId, onSwitch, onRemove, onAddNew, onEdit, onClose, authUser, isGuest, onLogout, t: ct }) {
  const t = ct || ((k) => k);
  const [diagResults, setDiagResults] = useState({});
  const [diagLoading, setDiagLoading] = useState({});

  async function diagnose(c) {
    setDiagLoading(p => ({ ...p, [c.id]: true }));
    setDiagResults(p => ({ ...p, [c.id]: null }));
    try {
      const cfg = c.config || c;
      const body = { type: c.type };
      if (c.type === "stalker") { body.portal = cfg.portal || cfg.server; body.mac = cfg.mac; }
      else if (c.type === "xtream") { body.server = cfg.server; body.user = cfg.user; body.pass = cfg.pass; }
      else if (c.type === "m3u") { body.url = cfg.url; }
      const res = await fetch(`${API}/api/diagnose`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      setDiagResults(p => ({ ...p, [c.id]: data }));
    } catch (e) {
      setDiagResults(p => ({ ...p, [c.id]: { reachable: false, details: { error: e.message } } }));
    }
    setDiagLoading(p => ({ ...p, [c.id]: false }));
  }

  return (
    <div className="modal-ov" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="modal" style={{maxWidth:"440px"}}>
        <div className="modal-title">{t("connections")}</div>
        {/* Logged-in user info */}
        {(authUser || isGuest) && (
          <div style={{display:"flex",alignItems:"center",gap:".6rem",padding:".5rem .7rem",marginBottom:".6rem",
            background:"var(--s2)",border:"1px solid var(--b1)",borderRadius:"8px"}}>
            <div style={{width:32,height:32,borderRadius:"50%",background:"var(--accent-22)",
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:".85rem",flexShrink:0}}>
              {authUser ? authUser.username?.[0]?.toUpperCase() || "U" : "G"}
            </div>
            <div style={{flex:1,overflow:"hidden"}}>
              <div style={{fontSize:".8rem",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {authUser ? authUser.username : "Guest"}
              </div>
              <div style={{fontSize:".6rem",color:"var(--t3)",textTransform:"capitalize"}}>
                {authUser ? `${authUser.role} · ${connections.length}/${authUser.maxConnections || authUser.limits?.maxConnections || "?"} connections` : "Guest mode · No sync"}
              </div>
            </div>
            {authUser && (
              <button style={{background:"none",border:"1px solid var(--b2)",borderRadius:4,cursor:"pointer",
                fontSize:".6rem",color:"var(--t3)",padding:".2rem .5rem"}}
                onClick={e => { e.stopPropagation(); onLogout(); onClose(); }}>
                Logout
              </button>
            )}
          </div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:".4rem",marginBottom:"1rem",maxHeight:"400px",overflowY:"auto"}}>
          {connections.map(c => {
            const diag = diagResults[c.id];
            const loading = diagLoading[c.id];
            return (
              <div key={c.id} style={{padding:".55rem .7rem",
                background: c.id===activeConnId ? "var(--accent)10" : "var(--s2)",
                border: `1px solid ${c.id===activeConnId ? "var(--accent)" : "var(--b2)"}`,
                borderLeft: `3px solid ${c.color}`,
                borderRadius:"8px",transition:"all .2s"}}>
                <div style={{display:"flex",alignItems:"center",gap:".6rem",cursor:"pointer"}}
                  onClick={() => { if (c.id !== activeConnId) onSwitch(c.id); }}>
                  <span style={{fontSize:"1rem"}}>{CONN_ICONS[c.type] || "📡"}</span>
                  <div style={{flex:1,overflow:"hidden"}}>
                    <div style={{fontSize:".8rem",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.label}</div>
                    <div style={{fontSize:".65rem",color:"var(--t3)",textTransform:"capitalize"}}>{c.type}</div>
                  </div>
                  {c.id === activeConnId && <span style={{fontSize:".6rem",fontWeight:700,color:"var(--accent)",textTransform:"uppercase",letterSpacing:".05em"}}>{t("active")}</span>}
                  <button style={{background:"none",border:"1px solid var(--b2)",borderRadius:4,cursor:"pointer",fontSize:".65rem",color:"var(--t2)",padding:".15rem .4rem"}}
                    title="Diagnose connection"
                    onClick={e => { e.stopPropagation(); diagnose(c); }}>
                    {loading ? "..." : "🩺"}
                  </button>
                  {c.id !== activeConnId && (
                    <button onClick={e => { e.stopPropagation(); if(confirm(`Delete "${c.label}"?`)) onRemove(c.id); }}
                      style={{background:"none",border:"none",color:"var(--danger)",cursor:"pointer",fontSize:".75rem",padding:".2rem .3rem",
                        borderRadius:"4px",lineHeight:1,flexShrink:0}}
                      title={t("removeConn")}>✕</button>
                  )}
                </div>
                {diag && (
                  <div style={{marginTop:".4rem",padding:".35rem .5rem",background:"var(--s1)",borderRadius:6,fontSize:".65rem",lineHeight:1.6,fontFamily:"monospace"}}>
                    <span style={{color: diag.reachable ? "#4caf50" : "#f44336",fontWeight:700}}>
                      {diag.reachable ? "● Reachable" : "● Unreachable"}
                    </span>
                    {diag.latency != null && <span style={{color:"var(--t2)",marginLeft:".5rem"}}>{diag.latency}ms</span>}
                    {Object.entries(diag.details || {}).map(([k, v]) => (
                      <div key={k} style={{color:"var(--t3)"}}>{k}: <span style={{color:"var(--t2)"}}>{String(v)}</span></div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {connections.length === 0 && (
            <div style={{fontSize:".8rem",color:"var(--t3)",textAlign:"center",padding:"1rem"}}>{t("noSavedConns")}</div>
          )}
        </div>
        <div className="modal-btns">
          <button className="btn-cancel" onClick={onClose}>{t("close")}</button>
          <button className="btn-confirm" onClick={onAddNew}>{t("addConnection")}</button>
        </div>
      </div>
    </div>
  );
});

// ══════════════════════════════════════════════════════════════════
// EDIT CONNECTION MODAL
// ══════════════════════════════════════════════════════════════════
const EditConnectionModal = ({ conn, onClose, onSave, t }) => {
  const [type, setType] = useState(conn.type);
  const [label, setLabel] = useState(conn.label);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (conn.type === "stalker") {
      setForm({
        server: conn.config.server || "",
        mac: conn.config.mac || "",
        serial: conn.config.serial || "",
        deviceId: conn.config.deviceId || "",
        deviceId2: conn.config.deviceId2 || ""
      });
    } else if (conn.type === "xtream") {
      setForm({
        server: conn.config.server || "",
        user: conn.config.user || "",
        pass: conn.config.pass || ""
      });
    } else if (conn.type === "m3u") {
      setForm({
        url: conn.config.url || ""
      });
    }
  }, [conn]);

  const handleSave = async () => {
    setErr(""); setLoading(true);
    try {
      let finalConfig = {};
      if (type === "xtream") {
        if (!form.server || !form.user || !form.pass) throw new Error("All fields required");
        const server = form.server.trim().replace(/\/$/, "");
        const api = makeXtreamAPI(server, form.user, form.pass);
        const data = await api.auth();
        if (data?.user_info?.auth === 0) throw new Error("Invalid credentials");
        finalConfig = { type, server, user: form.user, pass: form.pass, info: data?.user_info };
      } else if (type === "m3u") {
        if (!form.url) throw new Error("Playlist URL required");
        const res = await proxyFetch(form.url.trim());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text.includes("#EXTM3U")) throw new Error("Not a valid M3U playlist");
        const channels = parseM3U(text);
        if (!channels.length) throw new Error("No channels found");
        finalConfig = { type, url: form.url, channels };
      } else if (type === "stalker") {
        if (!form.server || !form.mac) throw new Error("Portal URL and MAC required");
        const server = form.server.trim().replace(/\/$/, "");
        const macTrimmed = form.mac.trim();
        const serialTrimmed = form.serial?.trim() || undefined;
        const deviceIdTrimmed = form.deviceId?.trim() || undefined;
        const deviceId2Trimmed = (form.deviceId2?.trim() || form.deviceId?.trim()) || undefined;

        const validateBody = JSON.stringify({
          portal: server, mac: macTrimmed,
          serial: serialTrimmed, deviceId: deviceIdTrimmed, deviceId2: deviceId2Trimmed
        });

        const vRes = await fetch(`${API}/stalker/validate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Guest-Id": GUEST_ID },
          body: validateBody
        });
        const v = await vRes.json();

        if (v.error && !v.portalReachable) throw new Error(v.error);
        if (v.status === "expired") throw new Error(`Account expired${v.expiry ? ` on ${v.expiry}` : ""}. Contact your provider.`);
        if (v.status === "blocked") throw new Error("Account is blocked. Contact your provider.");
        if (v.status === "suspended") throw new Error("Account is suspended. Contact your provider.");
        if (v.status === "unregistered") throw new Error("MAC address is not registered with this portal.");

        finalConfig = {
          server: server, mac: macTrimmed,
          serial: serialTrimmed, deviceId: deviceIdTrimmed, deviceId2: deviceId2Trimmed,
          accountInfo: v
        };
      }

      const updatedConn = {
        ...conn,
        label: label,
        type: type,
        config: finalConfig
      };

      onSave(updatedConn);
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-ov" onClick={e => e.target === e.currentTarget && !loading && onClose()}>
      <div className="modal" style={{ maxWidth: "440px" }}>
        <div className="modal-title">{t("editConnection")}</div>
        {err && <div className="err" style={{ marginBottom: "1rem" }}>⚠ {err}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "1rem", opacity: loading ? 0.6 : 1, pointerEvents: loading ? "none" : "auto" }}>
          <div>
            <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>{t("connectionName")}</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              style={{
                width: "100%",
                padding: ".5rem",
                border: "1px solid var(--b2)",
                borderRadius: "6px",
                background: "var(--s2)",
                color: "var(--t1)",
                fontSize: ".8rem"
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>{t("connectionType")}</label>
            <select
              value={type}
              onChange={e => setType(e.target.value)}
              style={{
                width: "100%",
                padding: ".5rem",
                border: "1px solid var(--b2)",
                borderRadius: "6px",
                background: "var(--s2)",
                color: "var(--t1)",
                fontSize: ".8rem"
              }}
            >
              <option value="stalker">Stalker</option>
              <option value="xtream">Xtream</option>
              <option value="m3u">M3U</option>
            </select>
          </div>

          {type === "stalker" && (
            <>
              <div>
                <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Server URL</label>
                <input
                  type="text"
                  value={form.server}
                  onChange={e => setForm({ ...form, server: e.target.value })}
                  style={{
                    width: "100%",
                    padding: ".5rem",
                    border: "1px solid var(--b2)",
                    borderRadius: "6px",
                    background: "var(--s2)",
                    color: "var(--t1)",
                    fontSize: ".8rem"
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>MAC Address</label>
                <input
                  type="text"
                  value={form.mac}
                  onChange={e => setForm({ ...form, mac: e.target.value })}
                  style={{
                    width: "100%",
                    padding: ".5rem",
                    border: "1px solid var(--b2)",
                    borderRadius: "6px",
                    background: "var(--s2)",
                    color: "var(--t1)",
                    fontSize: ".8rem"
                  }}
                />
              </div>
              {(form.serial || form.deviceId || form.deviceId2) && (
                <>
                  <div>
                    <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Serial</label>
                    <input
                      type="text"
                      value={form.serial || ""}
                      onChange={e => setForm({ ...form, serial: e.target.value })}
                      style={{
                        width: "100%",
                        padding: ".5rem",
                        border: "1px solid var(--b2)",
                        borderRadius: "6px",
                        background: "var(--s2)",
                        color: "var(--t1)",
                        fontSize: ".8rem"
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Device ID</label>
                    <input
                      type="text"
                      value={form.deviceId || ""}
                      onChange={e => setForm({ ...form, deviceId: e.target.value })}
                      style={{
                        width: "100%",
                        padding: ".5rem",
                        border: "1px solid var(--b2)",
                        borderRadius: "6px",
                        background: "var(--s2)",
                        color: "var(--t1)",
                        fontSize: ".8rem"
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Device ID 2</label>
                    <input
                      type="text"
                      value={form.deviceId2 || ""}
                      onChange={e => setForm({ ...form, deviceId2: e.target.value })}
                      style={{
                        width: "100%",
                        padding: ".5rem",
                        border: "1px solid var(--b2)",
                        borderRadius: "6px",
                        background: "var(--s2)",
                        color: "var(--t1)",
                        fontSize: ".8rem"
                      }}
                    />
                  </div>
                </>
              )}
            </>
          )}

          {type === "xtream" && (
            <>
              <div>
                <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Server URL</label>
                <input
                  type="text"
                  value={form.server}
                  onChange={e => setForm({ ...form, server: e.target.value })}
                  style={{
                    width: "100%",
                    padding: ".5rem",
                    border: "1px solid var(--b2)",
                    borderRadius: "6px",
                    background: "var(--s2)",
                    color: "var(--t1)",
                    fontSize: ".8rem"
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Username</label>
                <input
                  type="text"
                  value={form.user}
                  onChange={e => setForm({ ...form, user: e.target.value })}
                  style={{
                    width: "100%",
                    padding: ".5rem",
                    border: "1px solid var(--b2)",
                    borderRadius: "6px",
                    background: "var(--s2)",
                    color: "var(--t1)",
                    fontSize: ".8rem"
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Password</label>
                <input
                  type="password"
                  value={form.pass}
                  onChange={e => setForm({ ...form, pass: e.target.value })}
                  style={{
                    width: "100%",
                    padding: ".5rem",
                    border: "1px solid var(--b2)",
                    borderRadius: "6px",
                    background: "var(--s2)",
                    color: "var(--t1)",
                    fontSize: ".8rem"
                  }}
                />
              </div>
            </>
          )}

          {type === "m3u" && (
            <div>
              <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>M3U URL</label>
              <input
                type="text"
                value={form.url}
                onChange={e => setForm({ ...form, url: e.target.value })}
                style={{
                  width: "100%",
                  padding: ".5rem",
                  border: "1px solid var(--b2)",
                  borderRadius: "6px",
                  background: "var(--s2)",
                  color: "var(--t1)",
                  fontSize: ".8rem"
                }}
              />
            </div>
          )}
        </div>
        <div className="modal-btns">
          <button className="btn-cancel" onClick={onClose} disabled={loading}>{t("cancel")}</button>
          <button className="btn-confirm" onClick={handleSave} disabled={loading}>{loading ? t("connecting") : t("apply")}</button>
        </div>
      </div>
    </div>
  );
};

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
  { key:"discover",  icon:"✨", tKey:"discover",          sKey:"watch" },
  { key:"live",      icon:"📺", tKey:"live",              sKey:"watch" },
  { key:"vod",       icon:"🎬", tKey:"movies",            sKey:"watch" },
  { key:"series",    icon:"📽", tKey:"series",            sKey:"watch" },
  { key:"favs",      icon:"♥",  tKey:"favorites",         sKey:"watch" },
  { key:"continue",  icon:"⏯",  tKey:"continueWatching",  sKey:"watch" },
  { key:"epg",       icon:"📋", tKey:"tvGuide",           sKey:"tools" },
  { key:"search",    icon:"🔍", tKey:"globalSearch",      sKey:"tools" },
  { key:"hls",       icon:"▶",  tKey:"directPlay",        sKey:"tools" },
  { key:"settings",  icon:"⚙",  tKey:"settings",          sKey:"tools" },
];

// ── MAIN APP ──
const TimelineGrid = memo(React.forwardRef(function TimelineGrid({ channels, epgData, nowMs, onPlay, onPlayCatchup }, outerRef) {
  const PX_PER_MIN = 3;
  const TOTAL_HOURS = 8;
  const TOTAL_MS = TOTAL_HOURS * 3600000;
  const TOTAL_PX = TOTAL_HOURS * 60 * PX_PER_MIN; // 1440px
  const CH_COL_W = 160;
  const ROW_H = 48;

  // Window start = 1 hour before now (recalculates with nowMs)
  const windowStart = useMemo(() => nowMs - 3600000, [nowMs]);
  const windowEnd = useMemo(() => windowStart + TOTAL_MS, [windowStart]);

  // Generate time labels every 30 minutes
  const timeLabels = useMemo(() => {
    const labels = [];
    const snapStart = new Date(windowStart);
    snapStart.setMinutes(snapStart.getMinutes() < 30 ? 0 : 30, 0, 0);
    let t = snapStart.getTime();
    if (t < windowStart) t += 1800000;
    while (t < windowEnd) {
      const offsetPx = ((t - windowStart) / 60000) * PX_PER_MIN;
      const d = new Date(t);
      labels.push({ ms: t, px: offsetPx, label: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
      t += 1800000;
    }
    return labels;
  }, [windowStart, windowEnd]);

  // Convert ms position to px offset within the grid
  const msToPx = useCallback((ms) => ((ms - windowStart) / 60000) * PX_PER_MIN, [windowStart]);

  const fmtT = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const nowLinePx = msToPx(nowMs);

  return (
    <div className="epg-outer" ref={outerRef}>
      <div className="epg-grid-wrap" style={{width:CH_COL_W+TOTAL_PX,minHeight:channels.length*ROW_H+32}}>
        {/* Sticky time header */}
        <div className="epg-time-header">
          <div className="epg-time-header-pad" />
          <div className="epg-time-header-track" style={{width:TOTAL_PX,position:"relative"}}>
            {timeLabels.map(tl => (
              <div key={tl.ms} className="epg-time-label" style={{left:tl.px}}>{tl.label}</div>
            ))}
          </div>
        </div>

        {/* Channel rows + program area */}
        <div className="epg-body">
          {/* Sticky channel column */}
          <div className="epg-ch-col">
            {channels.map((ch,i) => (
              <div key={ch.id||i} className="epg-ch-cell" onClick={()=>onPlay(ch)} title={ch.name}>
                {ch.logo && <img className="epg-ch-logo" loading="lazy" src={imgSrc(ch.logo)} alt="" onError={e=>{e.target.style.display="none";}} />}
                <span className="epg-ch-name">{ch.name}</span>
              </div>
            ))}
          </div>

          {/* Programs area (absolutely positioned blocks) */}
          <div className="epg-prog-area" style={{width:TOTAL_PX,position:"relative"}}>
            {channels.map((ch,rowIdx) => {
              const epgCh = epgLookup(epgData, ch);
              const progs = epgCh ? epgCh.filter(p => p.start < windowEnd && p.stop > windowStart) : [];
              return (
                <div key={ch.id||rowIdx} className="epg-prog-row">
                  {progs.map((p,pi) => {
                    const clampStart = Math.max(p.start, windowStart);
                    const clampEnd = Math.min(p.stop, windowEnd);
                    const leftPx = msToPx(clampStart);
                    const widthPx = ((clampEnd - clampStart) / 60000) * PX_PER_MIN;
                    if (widthPx < 2) return null;
                    const isNow = p.start <= nowMs && p.stop > nowMs;
                    const isPast = p.stop <= nowMs;
                    const cls = `epg-prog-block${isNow?" now":""}${isPast?" past":""}`;
                    return (
                      <div key={pi} className={cls}
                        style={{left:leftPx,width:widthPx}}
                        onClick={()=> isPast && onPlayCatchup ? onPlayCatchup(ch, p) : onPlay(ch)}
                        title={`${p.title}\n${fmtT(p.start)} \u2013 ${fmtT(p.stop)}${isPast ? "\nClick to play catchup" : ""}`}>
                        {widthPx > 50 && <div className="epg-prog-t">{isPast && <span className="epg-catchup-icon">↩</span>}{p.title}</div>}
                        {widthPx > 90 && <div className="epg-prog-s">{fmtT(p.start)} \u2013 {fmtT(p.stop)}</div>}
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {/* Current time red line */}
            {nowLinePx >= 0 && nowLinePx <= TOTAL_PX && (
              <div className="epg-now-line" style={{left:nowLinePx}} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}));
export default function App() {
  // ── auth state
  const [authUser, setAuthUser] = useState(null); // { id, username, role, limits }
  const [authLoading, setAuthLoading] = useState(true);
  const [isGuest, setIsGuest] = useState(false);
  const [resetToken, setResetToken] = useState(null);

  const liveGridRef = useRef(null);

  // Check stored token on mount
  useEffect(() => {
    // Check for query params (activation, reset-password)
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    const tokenParam = params.get("token");

    if (action === "reset-password" && tokenParam) {
      setResetToken(tokenParam);
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    const token = getAuthToken();
    const wasGuest = localStorage.getItem("sv-guest-mode") === "1";
    if (wasGuest && !token) { setIsGuest(true); setAuthLoading(false); return; }
    if (!token) { setAuthLoading(false); return; }
    fetch(`${API}/api/auth/me`, { headers: { "Authorization": `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(async u => {
        setAuthUser(u);
        setEncKeySource(`user:${u.id}`);
        // Restore this user's connections from server
        const serverConns = await restoreConnectionsFromServer();
        if (serverConns?.length) {
          setConnections(serverConns);
          db.set("sv-connections", serverConns);
        }
      })
      .catch(() => { localStorage.removeItem("sv-auth-token"); })
      .finally(() => setAuthLoading(false));
  }, []);

  async function handleAuth(user) {
    setAuthUser(user); setIsGuest(false); localStorage.removeItem("sv-guest-mode");
    // Use user ID for encryption key (consistent across devices)
    setEncKeySource(`user:${user.id}`);
    // Migrate guest data to new user account
    migrateGuestData();
    // Always restore this user's connections from server
    const serverConns = await restoreConnectionsFromServer();
    if (serverConns?.length) {
      setConnections(serverConns);
      db.set("sv-connections", serverConns);
    } else {
      // No server data — start fresh for this user
      setConnections([]);
      db.set("sv-connections", []);
    }
  }
  function handleGuest() { setIsGuest(true); localStorage.setItem("sv-guest-mode", "1"); }
  function handleLogout() {
    const token = getAuthToken();
    if (token) authFetch(`${API}/api/auth/logout`, { method: "POST" }).catch(() => {});
    localStorage.removeItem("sv-auth-token");
    localStorage.removeItem("sv-guest-mode");
    // Clear current user's connections from local state
    setConnections([]);
    setActiveConnId(null);
    setConn(null);
    db.set("sv-connections", []);
    db.set("sv-activeConn", null);
    setEncKeySource(GUEST_ID);
    setAuthUser(null); setIsGuest(false);
  }
  const userRole = authUser?.role || (isGuest ? "guest" : null);
  const userLimits = authUser?.limits || (isGuest ? { maxConnections: 2, maxVod: 500, epg: true, sync: false } : null);

  // Show upgrade prompt for free/guest users on login
  useEffect(() => {
    if (!authLoading && (userRole === "free" || userRole === "guest")) {
      // Small delay to let the UI settle
      const timer = setTimeout(() => {
        setShowUpgradePrompt(true);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [authLoading, userRole]);

  // ── connection & data
  const [conn, setConn]       = useState(null);
  const [channels, setChannels] = useState([]);
  const [vod, setVod]         = useState([]);
  const [series, setSeries]   = useState([]);
  const [loading, setLoading] = useState(false);

  // ── series detail modal
  const [seriesDetail, setSeriesDetail] = useState(null); // {item, seasons, activeSeason}
  const [seriesLoading, setSeriesLoading] = useState(false);

  // ── upgrade prompt for free/guest users
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const [episodeLoading, setEpisodeLoading] = useState(null); // episode number being loaded
  const [expandedItem, setExpandedItem] = useState(null); // inline detail expansion for vod/series card
  const [tmdbData, setTmdbData] = useState(null);
  const [showTrailer, setShowTrailer] = useState(false);

  // ── ui state
  const [section, setSection] = useState(() => {
    try { return localStorage.getItem("sv-lastSection") ? JSON.parse(localStorage.getItem("sv-lastSection")) : "live"; } catch { return "live"; }
  });
  const [cat, setCat]         = useState("All");
  const [search, setSearch]   = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  const [globalQ, setGlobalQ] = useState("");
  const [playing, setPlaying] = useState(null);
  const [visibleLimit, setVisibleLimit] = useState(20);
  const [ctx, setCtx]         = useState(null); // context menu {x,y,catName}
  const [now, setNow]         = useState(Date.now());

  useEffect(() => {
    setVisibleLimit(20);
  }, [cat, section]);

  // Update "now" every minute to refresh progress bars and EPG
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  // ── theme
  const [themeName, setThemeName] = useState("Dark");

  // ── language (i18n)
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem("sv-lang") || "en"; } catch { return "en"; }
  });
  const t = useCallback((key, ...args) => _t(lang, key, ...args), [lang]);
  const isRTL = RTL_LANGS.includes(lang);

  // ── connections (replaces profiles)
  const [connections, setConnections] = useState([]);
  const [activeConnId, setActiveConnId] = useState(null);
  const [showConnManager, setShowConnManager] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [editingConn, setEditingConn] = useState(null);

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
  const [catLoading,        setCatLoading]        = useState(false);
  const fetchingCatRef = useRef(new Set());  // tracks in-progress category fetches
  const [prefetchProgress, setPrefetchProgress] = useState(null); // {done,total} or null

  // ── last synced timestamps
  const [lastSynced, setLastSynced] = useState({}); // {live: timestamp, vod: timestamp, series: timestamp}
  const [autoConnected, setAutoConnected] = useState(false); // true if loaded from IDB cache

  // ── TMDB
  const [tmdbKey, setTmdbKey] = useState(() => localStorage.getItem("sv-tmdb-key") || "server");

  // ── Feedback widget
  const [fbOpen, setFbOpen] = useState(false);
  const [fbMsg, setFbMsg] = useState("");
  const [fbSending, setFbSending] = useState(false);
  const [fbDone, setFbDone] = useState(false);

  const sendFeedback = useCallback(async () => {
    if (!fbMsg.trim() || fbSending) return;
    setFbSending(true);
    try {
      await fetch(`${API}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Guest-Id": GUEST_ID },
        body: JSON.stringify({ message: fbMsg.trim(), guestId: GUEST_ID, timestamp: Date.now(), userAgent: navigator.userAgent }),
      });
    } catch {}
    setFbSending(false);
    setFbMsg("");
    setFbDone(true);
    setTimeout(() => { setFbDone(false); setFbOpen(false); }, 1800);
  }, [fbMsg, fbSending]);

  // ── CSS injection
  useEffect(() => {
    const el = document.getElementById("sv-css") || (() => { const s = document.createElement("style"); s.id="sv-css"; document.head.appendChild(s); return s; })();
    el.textContent = genCSS(THEMES[themeName]);
  }, [themeName]);

  // ── TMDB enrichment for detail modal
  function tmdbUrl(path, params = "") {
    if (tmdbKey === "server") return `${API}/api/tmdb/${path}?${params}`;
    return `https://api.themoviedb.org/3/${path}?api_key=${tmdbKey}&${params}`;
  }
  useEffect(() => {
    if (!expandedItem || !tmdbKey) { setTmdbData(null); setShowTrailer(false); return; }
    setTmdbData(null);
    setShowTrailer(false);
    const isMovie = expandedItem.type === "vod";
    const type = isMovie ? "movie" : "tv";
    const query = encodeURIComponent(expandedItem.name?.replace(/\s*\(\d{4}\)\s*$/, "").trim());
    const year = expandedItem.year ? `&year=${expandedItem.year}` : "";

    let cancelled = false;
    (async () => {
      try {
        const searchUrl = tmdbUrl(`search/${type}`, `query=${query}${year}&language=en-US`);
        const sr = await fetch(searchUrl).then(r => r.json());
        const match = sr.results?.[0];
        if (!match || cancelled) return;

        const [details, credits, videos] = await Promise.all([
          fetch(tmdbUrl(`${type}/${match.id}`, "language=en-US")).then(r => r.json()),
          fetch(tmdbUrl(`${type}/${match.id}/credits`)).then(r => r.json()).catch(() => null),
          fetch(tmdbUrl(`${type}/${match.id}/videos`, "language=en-US")).then(r => r.json()).catch(() => null),
        ]);
        if (cancelled) return;

        const trailer = videos?.results?.find(v => v.type === "Trailer" && v.site === "YouTube")
          || videos?.results?.find(v => v.site === "YouTube");

        setTmdbData({
          id: match.id,
          overview: details.overview || match.overview,
          poster: match.poster_path ? `https://image.tmdb.org/t/p/w342${match.poster_path}` : null,
          backdrop: match.backdrop_path ? `https://image.tmdb.org/t/p/w780${match.backdrop_path}` : null,
          genres: details.genres?.map(g => g.name) || [],
          runtime: details.runtime || (details.episode_run_time?.[0]) || null,
          tagline: details.tagline || null,
          voteAverage: details.vote_average || null,
          releaseDate: details.release_date || details.first_air_date || null,
          cast: credits?.cast?.slice(0, 6).map(c => ({
            name: c.name,
            character: c.character,
            photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
          })) || [],
          director: credits?.crew?.find(c => c.job === "Director")?.name || null,
          trailer: trailer ? `https://www.youtube.com/embed/${trailer.key}` : null,
          trailerKey: trailer?.key || null,
        });
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [expandedItem, tmdbKey]);

  // ── load persisted data + auto-connect from IDB
  useEffect(() => {
    (async () => {
      // Migrate old profile/lastConn data to new connection system
      await migrateToConnections();

      const [th, conns, acId, hc, eq] = await Promise.all([
        db.get("sv-theme","Dark"),
        db.get("sv-connections",[]),
        db.get("sv-activeConn",null),
        db.get("sv-hiddenCats",{live:[],vod:[],series:[]}),
        db.get("sv-epgURL",""),
      ]);
      if (THEME_NAMES.includes(th)) setThemeName(th);
      setConnections(conns);
      setActiveConnId(acId);
      setHiddenCats(hc);
      if (eq) setEpgURL(eq);

      // Load per-connection favs + history
      if (acId) {
        const [fv, hi] = await Promise.all([
          db.get(`sv-favs-${acId}`, {live:{},vod:{},series:{}}),
          db.get(`sv-history-${acId}`, []),
        ]);
        setFavs(fv);
        setHistory(hi);

        // Restore from server if local is empty
        const favsEmpty = !fv || (Object.keys(fv.live||{}).length === 0 && Object.keys(fv.vod||{}).length === 0 && Object.keys(fv.series||{}).length === 0);
        const histEmpty = !hi || hi.length === 0;
        if (favsEmpty || histEmpty) {
          const [serverFavs, serverHist] = await Promise.all([
            favsEmpty ? restoreFromServer("favorites", acId) : null,
            histEmpty ? restoreFromServer("history", acId) : null,
          ]);
          if (serverFavs && favsEmpty) { setFavs(serverFavs); db.set(`sv-favs-${acId}`, serverFavs); }
          if (serverHist && histEmpty) { setHistory(serverHist); db.set(`sv-history-${acId}`, serverHist); }
        }
      }

      // Auto-connect: if we have an active connection + cached content in IDB, skip Setup
      if (acId) {
        try {
          const connObj = conns.find(c => c.id === acId);
          if (connObj) await loadFromCache(acId, connObj);
        } catch {}
      }
    })();
  }, []);

  // ── load cached content from IDB for a connection
  async function loadFromCache(id, connObj) {
    const cachedChannels = await idbCache.get(`content:${id}:live`);
    if (cachedChannels && cachedChannels.length) {
      setAutoConnected(true);
      setConn(connObj.config);
      setChannels(cachedChannels);
      const [cachedVod, cachedSeries] = await Promise.all([
        idbCache.get(`content:${id}:vod`),
        idbCache.get(`content:${id}:series`),
      ]);
      if (cachedVod) setVod(cachedVod);
      if (cachedSeries) setSeries(cachedSeries);
      if (connObj.type === "stalker") {
        const [vc, sc] = await Promise.all([
          idbCache.get(`cats:${id}:vod`),
          idbCache.get(`cats:${id}:series`),
        ]);
        if (vc) setStalkerVodCats(vc);
        if (sc) setStalkerSeriesCats(sc);
      }
      const syncTs = await idbCache.get(`sync:${id}`);
      if (syncTs) setLastSynced(syncTs);
      return true;
    }
    return false;
  }

  // ── migrate old profile/lastConn data to connection system
  async function migrateToConnections() {
    try {
      if (localStorage.getItem("sv-connections")) return; // already migrated
      const saved = localStorage.getItem("sv-lastConn");
      if (!saved) return;
      const lastConn = JSON.parse(saved);
      const cId = connId(lastConn);
      if (!cId) return;
      const color = PROFILE_COLORS[0];
      const label = lastConn.type === "xtream" ? `${lastConn.user} · Xtream`
        : lastConn.type === "stalker" ? `Stalker · ${(lastConn.mac||"").slice(-5)}`
        : lastConn.type === "m3u" ? `M3U · ${(lastConn.url||"").split("/").pop()?.slice(0,20)||"playlist"}`
        : "Direct HLS";
      const connObj = { id: cId, type: lastConn.type, label, color, config: lastConn };
      db.set("sv-connections", [connObj]);
      db.set("sv-activeConn", cId);
      // Migrate favorites: try active profile first, then default
      const ap = localStorage.getItem("sv-activeProfile");
      const activeProfileId = ap ? JSON.parse(ap) : "default";
      const oldFavs = localStorage.getItem(`sv-favs-${activeProfileId}`);
      if (oldFavs) {
        db.set(`sv-favs-${cId}`, JSON.parse(oldFavs));
      } else {
        const defFavs = localStorage.getItem("sv-favs-default");
        if (defFavs) db.set(`sv-favs-${cId}`, JSON.parse(defFavs));
      }
      // Migrate global history to per-connection
      const oldHistory = localStorage.getItem("sv-history");
      if (oldHistory) db.set(`sv-history-${cId}`, JSON.parse(oldHistory));
      // Clean up old keys
      localStorage.removeItem("sv-profiles");
      localStorage.removeItem("sv-activeProfile");
      localStorage.removeItem("sv-lastConn");
      localStorage.removeItem("sv-history");
    } catch {}
  }

  // ── save theme
  useEffect(() => {
    db.set("sv-theme", themeName);
  }, [themeName]);

  // ── save language
  useEffect(() => {
    localStorage.setItem("sv-lang", lang);
  }, [lang]);

  // ── load favs + history when active connection changes
  useEffect(() => {
    if (!activeConnId) return;
    db.get(`sv-favs-${activeConnId}`, {live:{},vod:{},series:{}}).then(setFavs);
    db.get(`sv-history-${activeConnId}`, []).then(setHistory);
  }, [activeConnId]);

  // ── persist section to localStorage
  useEffect(() => {
    localStorage.setItem("sv-lastSection", JSON.stringify(section));
  }, [section]);

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
        year:s.year, rating:s.rating, type:"vod",
        plot:s.plot||s.description||null, genre:s.genre||null, director:s.director||null,
        actors:s.actors||s.cast||null, duration:s.duration||null, country:s.country||null }));
      setVod(items);
      if (cId) {
        idbCache.set(`content:${cId}:vod`, items);
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
        group:cm[s.category_id]||"Other", year:s.releaseDate?.slice(0,4), rating:s.rating, type:"series",
        plot:s.plot||s.description||null, genre:s.genre||null, director:s.director||null,
        actors:s.actors||s.cast||null, country:s.country||null }));
      setSeries(items);
      if (cId) {
        idbCache.set(`content:${cId}:series`, items);
        const now = Date.now();
        setLastSynced(prev => { const n = { ...prev, series: now }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    } catch(e) { console.error(e); }
    finally { if (!background) setLoading(false); }
  }

  async function fetchStalkerChannels(force = false) {
    if (!conn || conn.type !== "stalker") return;
    const cId = connId(conn);
    // Check IDB first (permanent, no TTL)
    if (!force && cId) {
      const cached = await idbCache.get(`content:${cId}:live`);
      if (cached && cached.length) { setChannels(cached); return; }
    }
    setLoading(true);
    try {
      const res = await fetch(`${API}/stalker/channels?portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const items = (data.channels || []).map(transformStalkerItem);
      setChannels(items);
      // Persist to IDB (permanent) + D1
      if (cId) {
        idbCache.set(`content:${cId}:live`, items);
        const now = Date.now();
        setLastSynced(prev => { const n = { ...prev, live: now }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    } catch(e) { console.error("Stalker channels error:", e); }
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
        const res  = await fetch(`${API}/stalker/${sec}/categories?portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        cats = data.categories || [];
        // Save to IDB (permanent) + D1
        if (cId) {
          idbCache.set(`cats:${cId}:${sec}`, cats);
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
      const mapped = items.map(item => ({ ...transformStalkerItem(item), group: catTitle }));
      if (sec === "vod") setVod(prev => [...prev.filter(v => v.group !== catTitle), ...mapped]);
      else setSeries(prev => [...prev.filter(s => s.group !== catTitle), ...mapped]);

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
      const res  = await fetch(`${API}/stalker/${sec}?portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}&cat=${catId}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const items = data.items || [];
      applyItems(items);
      // Save transformed items to IDB (permanent)
      idbCache.set(CACHE_KEY, items.map(transformStalkerItem));
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
        setLastSynced(prev => { const n = { ...prev, vod: Date.now() }; idbCache.set(`sync:${cId}`, n); return n; });
      }
      if (series.length) {
        idbCache.set(`content:${cId}:series`, series);
        setLastSynced(prev => { const n = { ...prev, series: Date.now() }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    }, 3000);
    return () => clearTimeout(contentSaveTimer.current);
  }, [vod, series, conn]);

  function stalkerPlayUrl(cmd, contentType = "live", episode = null) {
    const params = new URLSearchParams({
      portal: conn.server,
      mac: conn.mac,
      cmd,
      content_type: contentType,
    });
    if (conn.serial) params.set("serial", conn.serial);
    if (conn.deviceId) params.set("deviceId", conn.deviceId);
    if (conn.deviceId2) params.set("deviceId2", conn.deviceId2);
    let url = `${API}/stalker/play?${params.toString()}`;
    if (episode) url += `&episode=${episode}`;
    return url;
  }

  function resolveStalkerStream(item) {
    const contentType = item.type || "live";
    const cmd = item._stalkerCmd;
    // Use play endpoint directly — it does create_link + stream pipe in one request.
    // This preserves IP-bound and time-limited portal tokens.
    return stalkerPlayUrl(cmd, contentType);
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

  // ── load EPG when connection is active
  useEffect(() => {
    if (conn?.type === "stalker") loadStalkerEPG();
  }, [activeConnId]);

  async function loadStalkerEPG() {
    if (!conn || conn.type !== "stalker") return;
    setEpgLoading(true);
    try {
      const params = new URLSearchParams({
        portal: conn.server,
        mac: conn.mac,
        period: 24, // request 24 hours of data
      });
      if (conn.serial) params.set("serial", conn.serial);
      if (conn.deviceId) params.set("deviceId", conn.deviceId);
      if (conn.deviceId2) params.set("deviceId2", conn.deviceId2);
      
      const res = await fetch(`${API}/stalker/epg?${params.toString()}`);
      const data = await res.json();
      if (data.programs) setEpgData(data.programs);
    } catch(e) { console.error("Stalker EPG error:", e); }
    finally { setEpgLoading(false); }
  }

  function switchSection(s) {
    setSection(s); setSearch(""); setPage(1); setExpandedItem(null);
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
    else { newFavs[type][key] = { id:item.id, name:item.name, url:item.url, logo:item.logo, group:item.group, type }; track("favorite"); }
    setFavs(newFavs);
    if (activeConnId) {
      db.set(`sv-favs-${activeConnId}`, newFavs);
      if (activeConnId) syncToServer("favorites", activeConnId, newFavs);
    }
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
    if (activeConnId) {
      db.set(`sv-history-${activeConnId}`, newH);
      if (activeConnId) syncToServer("history", activeConnId, newH);
    }
  }

  async function playItem(item) {
    // If this is a series item, open the detail modal instead of playing
    if (item.type === "series") {
      openSeriesDetail(item);
      return;
    }
    track("play", { name: item.name, type: item.type || "live" });
    track("history");
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

  // ── catchup / timeshift playback for past EPG programs
  async function playCatchup(channel, program) {
    if (!program || !channel) return;
    const startUTC = Math.floor(program.start / 1000);
    const endUTC = Math.floor(program.stop / 1000);
    const durationMin = Math.round((program.stop - program.start) / 60000);
    const catchupItem = {
      ...channel,
      name: `${channel.name} - ${program.title}`,
      _catchupProgram: program.title,
      type: "vod", // treat catchup as VOD for seeking support
    };
    track("play", { name: catchupItem.name, type: "catchup" });
    track("history");

    try {
      if (conn?.type === "stalker" && channel._stalkerCmd) {
        // Stalker: use /stalker/play with start/end params
        const playUrl = `${stalkerPlayUrl(channel._stalkerCmd, "live")}&start=${startUTC}&end=${endUTC}`;
        const res = await fetch(playUrl);
        if (res.ok) {
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("json")) {
            const data = await res.json();
            if (data.url) { catchupItem.url = `${API}/stream?url=${encodeURIComponent(data.url)}`; }
            else if (!data.error) { catchupItem.url = playUrl; }
            else { console.warn("Catchup stalker error:", data.error); }
          } else {
            catchupItem.url = playUrl;
          }
        }
      } else if (conn?.type === "xtream" && channel.url) {
        // Xtream Codes: try timeshift URL formats
        const streamId = channel.id;
        const base = conn.server;
        // Format 1: /timeshift/{user}/{pass}/{duration}/{start}/{stream_id}.ts
        const startFmt = new Date(program.start).toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHmmss
        const tsUrl = `${base}/timeshift/${conn.user}/${conn.pass}/${durationMin}/${startFmt}/${streamId}.ts`;
        catchupItem.url = tsUrl;
      } else if (channel.url) {
        // M3U / generic: try appending ?utc=&lutc= params
        const sep = channel.url.includes("?") ? "&" : "?";
        catchupItem.url = `${channel.url}${sep}utc=${startUTC}&lutc=${endUTC}`;
      }
    } catch (e) {
      console.error("Catchup URL construction failed:", e);
    }

    // Fall back to normal live playback if no catchup URL resolved
    if (!catchupItem.url) {
      console.warn("Catchup not available, falling back to live stream");
      playItem(channel);
      return;
    }

    setPlaying(catchupItem);
    addHistory(catchupItem);
  }

  // ── series detail (seasons/episodes)
  async function openSeriesDetail(item) {
    if (!item || item.type !== "series") return;
    setSeriesLoading(true);
    setSeriesDetail({ item, seasons: [], activeSeason: 0 });

    try {
      if (conn?.type === "stalker") {
        const res = await fetch(`${API}/stalker/series/seasons?seriesId=${encodeURIComponent(item.id)}&portal=${encodeURIComponent(conn.server)}&mac=${encodeURIComponent(conn.mac)}`);
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
        // Resolve series episode stream — try CF Worker first, fall back to Koyeb
        let resolvedUrl = null;
        try {
          const playUrl = stalkerPlayUrl(season.cmd, "series", episodeNum);
          const res = await fetch(playUrl);
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("json")) {
            const data = await res.json();
            if (data.url) resolvedUrl = `${API}/stream?url=${encodeURIComponent(data.url)}`;
            else if (!data.error) resolvedUrl = playUrl;
          } else { resolvedUrl = playUrl; }
        } catch(e) { console.error("Episode play failed:", e.message); }
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

  // ── connection management
  function makeConnectionLabel(type, config) {
    if (type === "xtream") return `${config.user} · Xtream`;
    if (type === "stalker") { try { const host = new URL(config.server).hostname.replace(/^(www|portal)\./, ""); return `${host} · ${(config.mac||"").slice(-8)}`; } catch {} return `Stalker · ${(config.mac||"").slice(-8)}`; }
    if (type === "m3u") return `M3U · ${(config.url||"").split("/").pop()?.slice(0,20)||"playlist"}`;
    return "Direct HLS";
  }

  function saveConnection(connConfig) {
    const cId = connId(connConfig);
    if (!cId) return "Invalid connection";
    const existing = connections.find(c => c.id === cId);
    if (existing) {
      // Already saved — just activate
      setActiveConnId(cId);
      db.set("sv-activeConn", cId);
      return null;
    }
    // Enforce connection limit
    const maxConns = userLimits?.maxConnections ?? 5;
    if (connections.length >= maxConns) {
      return `Connection limit reached (${maxConns}). Remove a connection to add a new one.`;
    }
    const usedColors = new Set(connections.map(c => c.color));
    const color = PROFILE_COLORS.find(c => !usedColors.has(c)) || PROFILE_COLORS[connections.length % PROFILE_COLORS.length];
    const connObj = { id: cId, type: connConfig.type, label: makeConnectionLabel(connConfig.type, connConfig), color, config: connConfig };
    const newConns = [...connections, connObj];
    setConnections(newConns);
    setActiveConnId(cId);
    db.set("sv-connections", newConns);
    db.set("sv-activeConn", cId);
    if (authUser) syncConnectionsToServer(newConns);
    return null;
  }

  function switchConnection(id) {
    if (id === activeConnId) { setShowConnManager(false); return; }
    const target = connections.find(c => c.id === id);
    if (!target) return;
    setShowConnManager(false);
    // Clear current content
    setChannels([]); setVod([]); setSeries([]);
    setStalkerVodCats([]); setStalkerSeriesCats([]);

    fetchingCatRef.current.clear(); setPrefetchProgress(null);
    setPlaying(null); setCat("All");
    // Set active and load from IDB
    setActiveConnId(id);
    db.set("sv-activeConn", id);
    (async () => {
      const loaded = await loadFromCache(id, target);
      if (!loaded) setConn(target.config);
    })();
  }

  function removeConnection(id) {
    const newConns = connections.filter(c => c.id !== id);
    setConnections(newConns);
    db.set("sv-connections", newConns);
    if (authUser) syncConnectionsToServer(newConns);
    // Clean up localStorage
    localStorage.removeItem(`sv-favs-${id}`);
    localStorage.removeItem(`sv-history-${id}`);
    // Clean up IDB cache (content, categories, sync meta)
    for (const key of [`content:${id}:live`, `content:${id}:vod`, `content:${id}:series`,
      `cats:${id}:vod`, `cats:${id}:series`, `sync:${id}`]) {
      idbCache.set(key, null);
    }
    // Clean up IDB category items (catitems:{connId}:{section}:{catId})
    if (typeof indexedDB !== "undefined") {
      idbCache.get(`cats:${id}:vod`).then(vodCats => {
        (vodCats || []).forEach(c => idbCache.set(`catitems:${id}:vod:${c.id}`, null));
      }).catch(() => {});
      idbCache.get(`cats:${id}:series`).then(seriesCats => {
        (seriesCats || []).forEach(c => idbCache.set(`catitems:${id}:series:${c.id}`, null));
      }).catch(() => {});
    }
    // Clean up server-side sync + cache data
    authFetch(`${API}/api/sync?connId=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    authFetch(`${API}/api/cache?connId=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }

  function addNewConnection() {
    setShowConnManager(false);
    disconnect();
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

  function handleEditConnection(updatedConn) {
    // Update connections array
    const newConns = connections.map(c =>
      c.id === updatedConn.id ? updatedConn : c
    );
    setConnections(newConns);
    db.set("sv-connections", newConns);

    // If this is the active connection, update the current conn
    if (activeConnId === updatedConn.id) {
      setConn(updatedConn.config);
    }

    // Sync to server if logged in
    if (authUser) {
      syncConnectionsToServer(newConns);
    }

    // Only reload if we have a valid connection config
    if (updatedConn.type === "stalker" && updatedConn.config?.server && updatedConn.config?.mac) {
      setChannels([]);
      setVod([]);
      setSeries([]);
      setStalkerVodCats([]);
      setStalkerSeriesCats([]);
      fetchingCatRef.current.clear();
      setCat(null);

      // Reload Live TV
      fetchStalkerChannels(true);

      // Reload Movies
      loadStalkerCats("vod", true);

      // Reload Series
      loadStalkerCats("series", true);
    } else if (updatedConn.type === "xtream" && updatedConn.config?.server && updatedConn.config?.user) {
      // For Xtream, just clear data without reloading since the API will handle it
      setVod([]);
      setSeries([]);
      setStalkerVodCats([]);
      setStalkerSeriesCats([]);
      fetchingCatRef.current.clear();
      setCat(null);
    } else if (updatedConn.type === "m3u" && updatedConn.config?.url) {
      // For M3U, just clear data without reloading
      setVod([]);
      setSeries([]);
      setStalkerVodCats([]);
      setStalkerSeriesCats([]);
      fetchingCatRef.current.clear();
      setCat(null);
    }
  }

  function disconnect() {
    setConn(null); setChannels([]); setVod([]); setSeries([]);
    setStalkerVodCats([]); setStalkerSeriesCats([]);

    fetchingCatRef.current.clear(); setPrefetchProgress(null);
    setSection("live"); setPlaying(null); setCat("All");
    setActiveConnId(null);
    db.set("sv-activeConn", null);
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

  const historyMap = useMemo(() => {
    const m = new Map();
    for (const h of history) m.set(h.id || h.url, h);
    return m;
  }, [history]);

  // ── Smart recommendations: genre-based matching from watch history + favorites
  const recommendations = useMemo(() => {
    if (section !== "vod" && section !== "series") return [];
    const items = section === "vod" ? vod : series;
    if (items.length === 0) return [];
    // Collect genres from history + favorites
    const watchedIds = new Set();
    const genreCount = {};
    const sources = [...history.filter(h => h.type === section).slice(0, 20), ...Object.values(favs[section] || {})];
    for (const h of sources) {
      watchedIds.add(h.id || h.url);
      const genre = h.group || h.genre;
      if (genre && genre !== "All" && genre !== "Other" && genre !== "Uncategorized") {
        genreCount[genre] = (genreCount[genre] || 0) + 1;
      }
    }
    if (Object.keys(genreCount).length === 0) return [];
    // Rank genres by frequency
    const topGenres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(g => g[0]);
    // Find items in top genres that user hasn't watched, randomize & limit
    const candidates = items.filter(item => {
      if (watchedIds.has(item.id || item.url)) return false;
      return topGenres.includes(item.group);
    });
    // Shuffle and pick 20
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates.slice(0, 20);
  }, [section, vod, series, history, favs]);

  // ── global search
  const searchResults = useMemo(() => {
    if (globalQ.length <= 1) return [];
    const q = globalQ.toLowerCase();
    return [...channels, ...vod, ...series].filter(i => i.name?.toLowerCase().includes(q)).slice(0, 80);
  }, [globalQ, channels, vod, series]);

  function handleConnect(connConfig) {
    const err = saveConnection(connConfig);
    if (err) { alert(err); return; }
    setConn(connConfig);
  }

  function handleImportMultiple(items) {
    if (!items.length) return;
    // Build configs for all items
    const configs = items.map(d => {
      if (d.type === "stalker") return { type: d.type, server: d.server, mac: d.mac, serial: d.serial, deviceId: d.deviceId, deviceId2: d.deviceId2 };
      if (d.type === "xtream") return { type: d.type, server: d.server, user: d.user, pass: d.pass };
      return { type: d.type, url: d.url };
    });
    // Build all connection objects at once to avoid stale state
    const maxConns = userLimits?.maxConnections ?? 5;
    let newConns = [...connections];
    const usedColors = new Set(newConns.map(c => c.color));
    let added = 0;
    for (const cfg of configs) {
      if (newConns.length >= maxConns) break;
      const cId = connId(cfg);
      if (!cId || newConns.find(c => c.id === cId)) continue;
      const color = PROFILE_COLORS.find(c => !usedColors.has(c)) || PROFILE_COLORS[newConns.length % PROFILE_COLORS.length];
      usedColors.add(color);
      newConns.push({ id: cId, type: cfg.type, label: makeConnectionLabel(cfg.type, cfg), color, config: cfg });
      added++;
    }
    if (added < configs.length) {
      alert(`Imported ${added} of ${configs.length} connections (limit: ${maxConns}). Remove existing connections to add more.`);
    }
    // Single state update with all connections
    setConnections(newConns);
    db.set("sv-connections", newConns);
    if (authUser) syncConnectionsToServer(newConns);
    // Connect to the first imported one
    const firstCfg = configs[0];
    const firstId = connId(firstCfg);
    if (firstId) { setActiveConnId(firstId); db.set("sv-activeConn", firstId); }
    setConn(firstCfg);
  }

  // Auth gate: show login/register before anything else
  if (authLoading) return (<><style>{genCSS(THEMES[themeName])}</style><div className="setup"><div className="card" style={{textAlign:"center",padding:"3rem"}}><div className="spinner" /></div></div></>);
  if (!authUser && !isGuest) return (
    <>
      <style>{genCSS(THEMES[themeName])}</style>
      <AuthScreen onAuth={handleAuth} onGuest={handleGuest} />
      {resetToken && createPortal(<ResetPasswordModal token={resetToken} onClose={() => setResetToken(null)} />, document.body)}
    </>
  );

  if (!conn) return (
    <>
      <style>{genCSS(THEMES[themeName])}</style>
      <Setup onConnect={handleConnect} onImportMultiple={handleImportMultiple} connections={connections} onReconnect={switchConnection} onRemoveConn={removeConnection} onEdit={setEditingConn} authUser={authUser} isGuest={isGuest} onLogout={handleLogout} t={t} />
      {/* Feedback widget on Setup screen too */}
      <button onClick={() => setFbOpen(true)} title="Send feedback"
        style={{position:"fixed",bottom:18,right:18,zIndex:9998,width:42,height:42,borderRadius:"50%",
          background:"var(--s2,#16162a)",border:"1px solid rgba(255,255,255,0.1)",color:"var(--accent,#00d4ff)",
          cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
          boxShadow:"0 2px 12px rgba(0,0,0,0.4)"}}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
      {fbOpen && createPortal(
        <div style={{position:"fixed",inset:0,zIndex:99999,background:"rgba(0,0,0,0.6)",
          display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
          onClick={e => { if (e.target === e.currentTarget && !fbSending) { setFbOpen(false); setFbMsg(""); setFbDone(false); }}}>
          <div style={{background:"var(--s1,#0f0f1c)",border:"1px solid rgba(255,255,255,0.08)",
            borderRadius:14,padding:"1.5rem",width:"100%",maxWidth:420,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
            {fbDone ? (
              <div style={{textAlign:"center",padding:"2rem 0"}}>
                <div style={{fontSize:"1.5rem",marginBottom:".5rem"}}>{t("thankYou")}</div>
                <div style={{color:"var(--t2,#8080aa)",fontSize:".85rem"}}>{t("feedbackReceived")}</div>
              </div>
            ) : (
              <>
                <div style={{fontSize:"1.05rem",fontWeight:600,marginBottom:".2rem"}}>{t("sendFeedback")}</div>
                <div style={{fontSize:".75rem",color:"var(--t2,#8080aa)",marginBottom:"1rem"}}>{t("feedbackHint")}</div>
                <textarea value={fbMsg} onChange={e => setFbMsg(e.target.value)} placeholder={t("feedbackPlaceholder")} maxLength={2000}
                  style={{width:"100%",minHeight:120,background:"var(--s2,#16162a)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:".75rem",
                    color:"var(--t1,#dde0f5)",fontSize:".85rem",resize:"vertical",fontFamily:"inherit",outline:"none"}} autoFocus />
                <div style={{display:"flex",justifyContent:"flex-end",gap:".5rem",marginTop:".8rem"}}>
                  <button onClick={() => { setFbOpen(false); setFbMsg(""); }}
                    style={{padding:".45rem 1rem",background:"transparent",border:"1px solid rgba(255,255,255,0.1)",borderRadius:7,color:"var(--t2,#8080aa)",fontSize:".8rem",cursor:"pointer"}}>{t("cancel")}</button>
                  <button onClick={sendFeedback} disabled={!fbMsg.trim() || fbSending}
                    style={{padding:".45rem 1rem",background:!fbMsg.trim()||fbSending?"rgba(255,255,255,0.05)":"var(--accent,#00d4ff)",border:"none",borderRadius:7,
                      color:!fbMsg.trim()||fbSending?"var(--t3,#44445a)":"#fff",fontSize:".8rem",fontWeight:600,cursor:!fbMsg.trim()||fbSending?"default":"pointer"}}>
                    {fbSending ? t("sending") : t("send")}</button>
                </div>
              </>
            )}
          </div>
        </div>
      , document.body)}
      {editingConn && createPortal(
        <EditConnectionModal
          conn={editingConn}
          onClose={() => setEditingConn(null)}
          onSave={handleEditConnection}
          t={t}
        />
      , document.body)}
    </>
  );

  const onAllowedPage = (authUser || isGuest) && !!conn;
  const LABEL = {discover:t("discover"),live:t("live"),vod:t("movies"),series:t("series"),favs:t("favorites"),continue:t("continueWatching"),epg:t("tvGuide"),search:t("globalSearch"),hls:t("directPlay"),settings:t("settings")};
  const activeConnection = connections.find(c => c.id === activeConnId);
  const channelCount = channels.length + vod.length + series.length;
  const curCats = ["live","vod","series"].includes(section) ? curCatsAll : [];
  const curItems = ["live","vod","series"].includes(section) ? curItemsAll : [];
  const hasMore = page * PAGE_SIZE < curItems.length;
  const paginatedItems = curItems.slice(0, page * PAGE_SIZE);

  return (
    <div className="app" dir={isRTL ? "rtl" : "ltr"}>
      <AdsterraSocialBar onAllowedPage={onAllowedPage} />
      {/* ── MOBILE TOP BAR + DRAWER ── */}
      <div className="mob-topbar">
        <button className="mob-hamburger" onClick={() => setMobileMenuOpen(true)}>☰</button>
        <span className="mob-topbar-title">Portal Heaven</span>
        <span className="mob-topbar-section">{LABEL[section]}</span>
      </div>
      <div className={`mob-overlay ${mobileMenuOpen?"open":""}`} onClick={() => setMobileMenuOpen(false)} />
      <div className={`mob-drawer ${mobileMenuOpen?"open":""}`}>
        <div className="s-logo">Portal Heaven</div>
        {activeConnection && (
          <div className="conn-card" style={{borderLeftColor: activeConnection.color}}
            onClick={() => { setShowConnManager(true); setMobileMenuOpen(false); }}>
            <div className="conn-card-row">
              <span className="conn-card-icon">{CONN_ICONS[activeConnection.type] || "📡"}</span>
              <div className="conn-card-info">
                <div className="conn-card-label">{activeConnection.label}</div>
                <div className="conn-card-stats">{channelCount.toLocaleString()} items</div>
              </div>
            </div>
          </div>
        )}
        <div className="theme-row">
          {THEME_NAMES.map(tn => (
            <div key={tn} className={`theme-swatch ${themeName===tn?"on":""}`}
              style={{background:THEMES[tn].accent}} title={tn}
              onClick={() => setThemeName(tn)} />
          ))}
        </div>
        {["watch","tools"].map(sKey => (
          <div key={sKey}>
            <div className="s-sect">{t(sKey)}</div>
            {NAV.filter(n=>n.sKey===sKey).map(n => (
              <div key={n.key} className={`nav ${section===n.key?"on":""}`}
                onClick={() => { switchSection(n.key); setMobileMenuOpen(false); }}>
                <span className="nav-icon">{n.icon}</span>
                <span>{t(n.tKey)}</span>
                {n.key==="favs" && totalFavs > 0 && <span className="nav-badge">{totalFavs}</span>}
                {n.key==="continue" && continueItems.length > 0 && <span className="nav-badge">{continueItems.length}</span>}
              </div>
            ))}
          </div>
        ))}
        <div className="s-bottom">
          {authUser && (
            <div style={{fontSize:".72rem",color:"var(--t3)",padding:"0 0 .4rem",display:"flex",alignItems:"center",gap:".3rem"}}>
              <span style={{color:"var(--accent)"}}>●</span> {authUser.username} <span style={{textTransform:"capitalize",opacity:.7}}>({authUser.role})</span>
            </div>
          )}
          <div className="s-row">
            <button className="btn-sm" onClick={() => { setFbOpen(true); setMobileMenuOpen(false); }}>💬 {t("feedback")}</button>
            <button className="btn-sm danger" onClick={() => { disconnect(); setMobileMenuOpen(false); }}>⏏ {t("disconnect")}</button>
          </div>
          {(authUser || isGuest) && (
            <div style={{marginTop:".4rem"}}>
              <button className="btn-sm" style={{width:"100%",fontSize:".72rem"}} onClick={() => { disconnect(); handleLogout(); setMobileMenuOpen(false); }}>
                {authUser ? "🚪 Logout" : "🔑 Login"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── SIDEBAR (desktop only) ── */}
      <div className="sidebar">
        <div className="s-logo">Portal Heaven</div>

        {/* Connection Card */}
        {activeConnection && (
          <div className="conn-card" style={{borderLeftColor: activeConnection.color}}
            onClick={() => setShowConnManager(true)} title="Switch connection">
            <div className="conn-card-row">
              <span className="conn-card-icon">{CONN_ICONS[activeConnection.type] || "📡"}</span>
              <div className="conn-card-info">
                <div className="conn-card-label">{activeConnection.label}</div>
                <div className="conn-card-stats">{channelCount.toLocaleString()} items</div>
                {activeConnection?.config?.accountInfo?.daysLeft !== null && activeConnection?.config?.accountInfo?.daysLeft !== undefined && (
                  <div style={{fontSize:".62rem", color: activeConnection.config.accountInfo.daysLeft <= 7 ? "var(--danger)" : "var(--t3)", marginTop:".15rem"}}>
                    {activeConnection.config.accountInfo.status === "active"
                      ? `${activeConnection.config.accountInfo.daysLeft}d left${activeConnection.config.accountInfo.tariff ? ` · ${activeConnection.config.accountInfo.tariff}` : ""}`
                      : activeConnection.config.accountInfo.status}
                  </div>
                )}
              </div>
            </div>
            <div className="conn-card-switch">▼ {t("switchConn")}</div>
          </div>
        )}

        {/* Themes */}
        <div className="theme-row">
          {THEME_NAMES.map(tn => (
            <div key={tn} className={`theme-swatch ${themeName===tn?"on":""}`}
              style={{background:THEMES[tn].accent}}
              title={tn}
              onClick={() => setThemeName(tn)} />
          ))}
        </div>

        {/* Language Selector */}
        <div className="lang-sel">
          <div className="lang-sel-label">{t("language")}</div>
          <select value={lang} onChange={e => setLang(e.target.value)}>
            {Object.entries(LANG_META).map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
        </div>

        {/* Nav */}
        {["watch","tools"].map(sKey => (
          <div key={sKey}>
            <div className="s-sect">{t(sKey)}</div>
            {NAV.filter(n=>n.sKey===sKey).map(n => (
              <div key={n.key} className={`nav ${section===n.key?"on":""}`} onClick={() => switchSection(n.key)}>
                <span className="nav-icon">{n.icon}</span>
                <span>{t(n.tKey)}</span>
                {n.key==="favs" && totalFavs > 0 && <span className="nav-badge">{totalFavs}</span>}
                {n.key==="continue" && continueItems.length > 0 && <span className="nav-badge">{continueItems.length}</span>}
              </div>
            ))}
          </div>
        ))}

        <div className="s-bottom">
          {authUser && (
            <div style={{fontSize:".68rem",color:"var(--t3)",padding:"0 0 .4rem",display:"flex",alignItems:"center",gap:".3rem"}}>
              <span style={{color:"var(--accent)"}}>●</span> {authUser.username} <span style={{textTransform:"capitalize",opacity:.7}}>({authUser.role})</span>
            </div>
          )}
          {isGuest && (
            <div style={{fontSize:".68rem",color:"var(--t3)",padding:"0 0 .4rem"}}>
              <span style={{color:"var(--t3)"}}>●</span> Guest — <button onClick={() => { disconnect(); handleLogout(); }}
                style={{background:"none",border:"none",color:"var(--accent)",cursor:"pointer",fontSize:".68rem",padding:0,fontFamily:"inherit",textDecoration:"underline"}}>
                Login for more features</button>
            </div>
          )}
          <div className="s-row">
            <button className="btn-sm" onClick={() => setFbOpen(true)}>💬 {t("feedback")}</button>
            <button className="btn-sm danger" onClick={disconnect}>⏏ {t("disconnect")}</button>
          </div>
          {(authUser || isGuest) && (
            <div style={{marginTop:".4rem"}}>
              <button className="btn-sm" style={{width:"100%",fontSize:".68rem"}} onClick={() => { disconnect(); handleLogout(); }}>
                {authUser ? "🚪 Logout" : "🔑 Login"}
              </button>
            </div>
          )}
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
                      fetchingCatRef.current.clear();
                      setCat(null);
                      loadStalkerCats(section, true);
                    }
                  }}>↺ {t("refresh")}</button>
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
                }}>↺ {t("refresh")}</button>
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
                      setLastSynced(prev => ({ ...prev, live: Date.now() }));
                    }
                  } catch(e) { console.error("M3U refresh error:", e); }
                  finally { setLoading(false); }
                }}>↺ {t("refresh")}</button>
              )}
              {lastSynced[section] && (
                <span style={{fontSize:".62rem",color:"var(--t3)",whiteSpace:"nowrap"}} title={new Date(lastSynced[section]).toLocaleString()}>
                  {t("synced")} {(() => {
                    const mins = Math.floor((Date.now() - lastSynced[section]) / 60000);
                    if (mins < 1) return t("justNow");
                    if (mins < 60) return `${mins}m ago`;
                    const hrs = Math.floor(mins / 60);
                    if (hrs < 24) return `${hrs}h ago`;
                    return `${Math.floor(hrs / 24)}d ago`;
                  })()}
                </span>
              )}
              <div className="c-search-wrap">
                <span className="c-search-icon">🔍</span>
                <input className="c-search" placeholder={`${t("search")} ${LABEL[section]}…`}
                  value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
              </div>
            </>
          )}
          {section==="search" && (
            <div className="c-search-wrap" style={{flex:1}}>
              <span className="c-search-icon">🔍</span>
              <input className="c-search" style={{width:"100%"}} placeholder={t("searchAll")}
                autoFocus
                value={globalQ} onChange={e => setGlobalQ(e.target.value)} />
            </div>
          )}
        </div>

        {/* Body */}
        {loading ? (
          <div className="loading"><div className="spinner" /><span>{t("loadingSection", LABEL[section])}</span></div>
        ) : section==="discover" ? (
          <DiscoverView tmdbKey={tmdbKey} setTmdbKey={setTmdbKey} vod={vod} series={series} onPlay={playItem} />
        ) : section==="settings" ? (
          <SettingsView connections={connections} favs={favs} history={history}
            authUser={authUser} isGuest={isGuest} activeConnId={activeConnId} onAuth={handleAuth} t={t} />
        ) : section==="hls" ? (
          <DirectHLSView />
        ) : section==="epg" ? (
          <EPGView channels={channels} epgData={epgData} epgURL={epgURL} setEpgURL={setEpgURL}
            epgLoading={epgLoading} loadEPG={loadEPG} onPlay={playItem} onPlayCatchup={playCatchup} t={t} />
        ) : section==="search" ? (
          <GlobalSearch results={searchResults} query={globalQ} onPlay={playItem} toggleFav={toggleFav} isFav={isFav} t={t} />
        ) : section==="favs" ? (
          <FavsView favItems={favItems} onPlay={playItem} toggleFav={toggleFav} isFav={isFav} t={t} />
        ) : section==="continue" ? (
          <ContinueView items={continueItems} onPlay={playItem} history={history} t={t} />
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
                        setCat(c); setPage(1);
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
                <div className="empty-t">{t("selectCategory")}</div>
                <div className="empty-s">{t("chooseCategory")}</div>
              </div>
            ) : catLoading && curItems.length === 0 ? (
              <div className="empty">
                <div className="empty-icon" style={{animation:"spin 1s linear infinite"}}>⏳</div>
                <div className="empty-t">{t("loadingSection", cat)}</div>
                <div className="empty-s">{t("fetchingItems")}</div>
              </div>
            ) : curItems.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">{section==="live"?"📺":section==="vod"?"🎬":"📽"}</div>
                <div className="empty-t">{t("noContent")}</div>
                <div className="empty-s">
                  {conn.type==="stalker" ? t("stalkerHint") : t("tryDifferent")}
                </div>
              </div>
            ) : (
              <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"auto",minHeight:0}}>
                {/* Recommendations row */}
                {recommendations.length > 0 && !search && cat === "All" && (
                  <div style={{marginBottom:".8rem",flexShrink:0}}>
                    <div style={{fontSize:".78rem",fontWeight:600,color:"var(--t2)",marginBottom:".4rem",paddingLeft:".2rem"}}>
                      Recommended for you
                    </div>
                    <div style={{display:"flex",gap:".5rem",overflowX:"auto",paddingBottom:".4rem"}}>
                      {recommendations.map((item, i) => (
                        <div key={item.id||i} style={{flexShrink:0,width:110,cursor:"pointer"}} onClick={() => playItem(item)}>
                          {item.logo
                            ? <img src={imgSrc(item.logo)} alt="" style={{width:110,aspectRatio:"2/3",objectFit:"cover",borderRadius:8,background:"var(--s2)",display:"block"}} onError={e=>e.target.style.display="none"} />
                            : <div style={{width:110,aspectRatio:"2/3",background:"var(--s2)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.4rem"}}>{section==="series"?"📽":"🎬"}</div>}
                          <div style={{fontSize:".65rem",marginTop:".2rem",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--t2)"}}>{item.name}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {section==="live" ? (
                  <div className="live-timeline-wrapper" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <TimelineGrid 
                      ref={liveGridRef}
                      channels={paginatedItems.slice(0, visibleLimit)}
                      epgData={epgData}
                      nowMs={now}
                      onPlay={playItem}
                      onPlayCatchup={playCatchup}
                    />
                    {visibleLimit < paginatedItems.length && (
                      <div style={{display:"flex",justifyContent:"center",padding:"1.5rem 0", flexShrink: 0}}>
                        <button className="c-btn" onClick={()=>setVisibleLimit(prev=>prev+20)}>
                          {t("loadMore")} ({Math.min(visibleLimit, paginatedItems.length)}/{paginatedItems.length})
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="vod-grid">
                  <AdsterraNativeBanner enabled={section === "vod" || section === "series"} />
                    {paginatedItems.map((item,i) => {
                      const faved = isFav(item);
                      const hist = historyMap.get(item.id || item.url);
                      const pct = hist?.position && hist?.duration ? Math.min(100, (hist.position/hist.duration)*100) : 0;
                      return (
                        <div key={item.id||i} className="vod-card" onClick={() => playItem(item)} title={item.name}>
                          {item.logo
                            ? <img className="vod-poster" loading="lazy" src={imgSrc(item.logo)} alt="" onError={e=>e.target.style.display="none"} />
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
                          {(item.type==="vod"||item.type==="series") && (
                            <button className="vod-info-btn" onClick={e=>{e.stopPropagation();setExpandedItem(item);}} title="Details">ⓘ</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {hasMore && (
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:".75rem 0",width:"100%",flexShrink:0}}>
                    <button className="c-btn" onClick={()=>setPage(p=>p+1)}>{t("loadMore")} ({paginatedItems.length}/{curItems.length})</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── PLAYER ── */}
      {/* Detail popup modal */}
      {expandedItem && createPortal(
        <div style={{position:"fixed",inset:0,zIndex:99998,background:"rgba(0,0,0,0.65)",
          display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
          onClick={e => { if (e.target === e.currentTarget) { setExpandedItem(null); setShowTrailer(false); } }}>
          <div style={{background:"var(--s1,#0f0f1c)",border:"1px solid rgba(255,255,255,0.08)",
            borderRadius:16,padding:"1.5rem",boxShadow:"0 12px 48px rgba(0,0,0,0.6)",maxWidth:560,width:"100%",
            maxHeight:"90vh",overflowY:"auto"}}>
            <div className="detail-modal">
              {(tmdbData?.poster || expandedItem.logo)
                ? <img className="detail-poster" loading="lazy" src={tmdbData?.poster || imgSrc(expandedItem.logo)} alt="" onError={e=>e.target.style.display="none"} />
                : <div className="detail-poster-ph">{expandedItem.type==="series"?"📽":"🎬"}</div>}
              <div className="detail-body">
                <div className="detail-title">{expandedItem.name}</div>
                <div className="detail-meta">
                  {expandedItem.year && <span>{expandedItem.year}</span>}
                  {expandedItem.rating && <span>★ {parseFloat(expandedItem.rating||0).toFixed(1)}</span>}
                  {tmdbData?.voteAverage && !expandedItem.rating && <span className="detail-tmdb-rating">★ {tmdbData.voteAverage.toFixed(1)}</span>}
                  {tmdbData?.voteAverage && expandedItem.rating && <span className="detail-tmdb-rating">TMDB ★ {tmdbData.voteAverage.toFixed(1)}</span>}
                  {expandedItem.duration && <span>{expandedItem.duration}</span>}
                  {!expandedItem.duration && tmdbData?.runtime && <span>{tmdbData.runtime} min</span>}
                  {expandedItem.age && <span>{expandedItem.age}</span>}
                  {expandedItem.type && <span style={{textTransform:"uppercase"}}>{expandedItem.type}</span>}
                </div>
                {tmdbData?.tagline && <div className="detail-tagline">{tmdbData.tagline}</div>}
                {(expandedItem.plot || tmdbData?.overview) && <div className="detail-plot">{expandedItem.plot || tmdbData.overview}</div>}
                {tmdbData?.genres?.length > 0 && (
                  <div className="detail-genres">{tmdbData.genres.map(g => <span key={g}>{g}</span>)}</div>
                )}
                {!tmdbData?.genres?.length && expandedItem.genre && <div className="detail-row"><span className="detail-label">Genre</span><span className="detail-val">{expandedItem.genre}</span></div>}
                {(expandedItem.director || tmdbData?.director) && <div className="detail-row"><span className="detail-label">Director</span><span className="detail-val">{expandedItem.director || tmdbData.director}</span></div>}
                {!tmdbData?.cast?.length && expandedItem.actors && <div className="detail-row"><span className="detail-label">Cast</span><span className="detail-val">{expandedItem.actors}</span></div>}
                {expandedItem.country && <div className="detail-row"><span className="detail-label">Country</span><span className="detail-val">{expandedItem.country}</span></div>}
                {tmdbData?.cast?.length > 0 && (
                  <div className="detail-cast">
                    {tmdbData.cast.map((c, i) => (
                      <div className="detail-cast-item" key={i}>
                        {c.photo
                          ? <img className="detail-cast-photo" src={c.photo} alt={c.name} />
                          : <div className="detail-cast-photo-ph">👤</div>}
                        <div className="detail-cast-name">{c.name}</div>
                        {c.character && <div className="detail-cast-char">{c.character}</div>}
                      </div>
                    ))}
                  </div>
                )}
                {!tmdbData && tmdbKey && <div className="detail-loading">Loading TMDB...</div>}
                <div className="detail-actions">
                  <button className="detail-play" onClick={()=>{setExpandedItem(null);setShowTrailer(false);playItem(expandedItem);}}>▶ Play</button>
                  <button className="detail-fav" onClick={()=>toggleFav(expandedItem)}>
                    {isFav(expandedItem) ? "♥ Favorited" : "♡ Favorite"}
                  </button>
                  {tmdbData?.trailer && (
                    <button className="detail-trailer-btn" style={{padding:".5rem 1rem",borderRadius:8,fontSize:".82rem",cursor:"pointer",transition:"all .15s"}}
                      onClick={() => setShowTrailer(v => !v)}>
                      {showTrailer ? "✕ Close Trailer" : "▶ Trailer"}
                    </button>
                  )}
                </div>
                {showTrailer && tmdbData?.trailer && (
                  <iframe className="detail-trailer" src={`${tmdbData.trailer}?autoplay=1`}
                    allow="autoplay; encrypted-media" allowFullScreen title="Trailer" />
                )}
              </div>
            </div>
          </div>
        </div>
      , document.body)}

      {/* Feedback modal (connected view) */}
      {fbOpen && createPortal(
        <div style={{position:"fixed",inset:0,zIndex:99999,background:"rgba(0,0,0,0.6)",
          display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
          onClick={e => { if (e.target === e.currentTarget && !fbSending) { setFbOpen(false); setFbMsg(""); setFbDone(false); }}}>
          <div style={{background:"var(--s1,#0f0f1c)",border:"1px solid rgba(255,255,255,0.08)",
            borderRadius:14,padding:"1.5rem",width:"100%",maxWidth:420,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
            {fbDone ? (
              <div style={{textAlign:"center",padding:"2rem 0"}}>
                <div style={{fontSize:"1.5rem",marginBottom:".5rem"}}>{t("thankYou")}</div>
                <div style={{color:"var(--t2,#8080aa)",fontSize:".85rem"}}>{t("feedbackReceived")}</div>
              </div>
            ) : (<>
              <div style={{fontSize:"1.05rem",fontWeight:600,marginBottom:".2rem"}}>{t("sendFeedback")}</div>
              <div style={{fontSize:".75rem",color:"var(--t2,#8080aa)",marginBottom:"1rem"}}>{t("feedbackHint")}</div>
              <textarea value={fbMsg} onChange={e => setFbMsg(e.target.value)} placeholder={t("feedbackPlaceholder")} maxLength={2000}
                style={{width:"100%",minHeight:120,background:"var(--s2,#16162a)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:".75rem",
                  color:"var(--t1,#dde0f5)",fontSize:".85rem",resize:"vertical",fontFamily:"inherit",outline:"none"}} autoFocus />
              <div style={{display:"flex",justifyContent:"flex-end",gap:".5rem",marginTop:".8rem"}}>
                <button onClick={() => { setFbOpen(false); setFbMsg(""); }}
                  style={{padding:".45rem 1rem",background:"transparent",border:"1px solid rgba(255,255,255,0.1)",borderRadius:7,color:"var(--t2,#8080aa)",fontSize:".8rem",cursor:"pointer"}}>{t("cancel")}</button>
                <button onClick={sendFeedback} disabled={!fbMsg.trim() || fbSending}
                  style={{padding:".45rem 1rem",background:!fbMsg.trim()||fbSending?"rgba(255,255,255,0.05)":"var(--accent,#00d4ff)",border:"none",borderRadius:7,
                    color:!fbMsg.trim()||fbSending?"var(--t3,#44445a)":"#fff",fontSize:".8rem",fontWeight:600,cursor:!fbMsg.trim()||fbSending?"default":"pointer"}}>
                  {fbSending ? t("sending") : t("send")}</button>
              </div>
            </>)}
          </div>
        </div>
      , document.body)}

      {/* Upgrade prompt for free/guest users */}
      {showUpgradePrompt && createPortal(
        <div style={{position:"fixed",inset:0,zIndex:99999,background:"rgba(0,0,0,0.6)",
          display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
          onClick={e => { if (e.target === e.currentTarget) setShowUpgradePrompt(false); }}>
          <div style={{background:"var(--s1,#0f0f1c)",border:"1px solid rgba(255,255,255,0.08)",
            borderRadius:14,padding:"1.5rem",width:"100%",maxWidth:420,boxShadow:"0 8px 32px rgba(0,0,0,0.5)",position:"relative"}}>
            <button onClick={() => setShowUpgradePrompt(false)} style={{position:"absolute",top:".5rem",right:".5rem",background:"none",border:"none",color:"var(--t2)",fontSize:"1.2rem",cursor:"pointer"}}>×</button>
            <div style={{fontSize:"1.2rem",fontWeight:600,marginBottom:"1rem",color:"var(--accent)"}}>✨ Upgrade Your Account</div>
            <div style={{fontSize:".85rem",color:"var(--t2)",marginBottom:"1.5rem"}}>
              Unlock premium features and enhance your streaming experience:
            </div>
            <ul style={{margin:0,paddingLeft:"1.2rem",color:"var(--t1)",fontSize:".85rem",lineHeight:1.6}}>
              <li>No ads — enjoy uninterrupted streaming</li>
              <li>More simultaneous connections</li>
              <li>Unlimited VOD library access</li>
              <li>Sync across all your devices</li>
              <li>Priority support</li>
            </ul>
            <div style={{display:"flex",justifyContent:"flex-end",gap:".5rem",marginTop:"1.5rem"}}>
              <button onClick={() => setShowUpgradePrompt(false)}
                style={{padding:".5rem 1rem",background:"transparent",border:"1px solid rgba(255,255,255,0.1)",borderRadius:7,color:"var(--t2)",fontSize:".85rem",cursor:"pointer"}}>
                Maybe Later
              </button>
              <button onClick={() => { disconnect(); handleLogout(); setShowUpgradePrompt(false); }}
                style={{padding:".5rem 1.2rem",background:"var(--accent,#00d4ff)",border:"none",borderRadius:7,color:"#fff",fontSize:".85rem",fontWeight:600,cursor:"pointer"}}>
                Upgrade Now
              </button>
            </div>
          </div>
        </div>
      , document.body)}

      {playing && (
        <Player item={playing}
          channelList={playing.type==="live" ? channels : null}
          epgData={epgData}
          onClose={() => setPlaying(null)}
          toggleFav={toggleFav}
          onFav={toggleFav}
          isFav={isFav}
          connType={conn?.type}
          t={t}
        />
      )}

      {/* ── CONTEXT MENU ── */}
      {ctx && (
        <div className="ctx-menu" style={{left:ctx.x, top:ctx.y}} onClick={e=>e.stopPropagation()}>
          <div className="ctx-item" onClick={() => {toggleHideCat(ctx.sec, ctx.catName);setCtx(null);}}>
            {isCatHidden(ctx.sec, ctx.catName) ? `👁 ${t("showCategory")}` : `🙈 ${t("hideCategory")}`}
          </div>
          <div className="ctx-item" onClick={() => {setCat(ctx.catName);setCtx(null);}}>
            📌 {t("filterToThis")}
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
                ? <img className="series-modal-poster" loading="lazy" src={imgSrc(seriesDetail.item.logo)} alt="" onError={e => e.target.style.display="none"} />
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
                  <span>{t("loadingSeasons")}</span>
                </div>
              ) : seriesDetail.seasons.length === 0 ? (
                <div style={{textAlign:"center",padding:"2rem",color:"var(--t2)",fontSize:".85rem"}}>
                  {t("noSeasonsFound")}
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

      {/* ── CONNECTION MANAGER ── */}
      {showConnManager && (
        <ConnectionManager
          connections={connections}
          activeConnId={activeConnId}
          onSwitch={switchConnection}
          onRemove={removeConnection}
          onAddNew={addNewConnection}
          onEdit={setEditingConn}
          onClose={() => setShowConnManager(false)}
          authUser={authUser}
          isGuest={isGuest}
          onLogout={handleLogout}
          t={t}
        />
      )}

      {editingConn && (
        <EditConnectionModal
          conn={editingConn}
          onClose={() => setEditingConn(null)}
          onSave={handleEditConnection}
          t={t}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SUB-VIEWS
// ══════════════════════════════════════════════════════════════════
const FavsView = memo(function FavsView({ favItems, onPlay, toggleFav, isFav, t }) {
  const all = [...favItems.live, ...favItems.vod, ...favItems.series];
  if (!all.length) return (
    <div className="empty">
      <div className="empty-icon">♡</div>
      <div className="empty-t">{t("noFavsYet")}</div>
      <div className="empty-s">{t("favHint")}</div>
    </div>
  );
  const groups = [[t("liveTV"), favItems.live], [t("movies"), favItems.vod], [t("series"), favItems.series]];
  return (
    <div style={{flex:1,overflow:"auto",padding:"1.1rem 1.4rem",display:"flex",flexDirection:"column",gap:"1.5rem"}}>
      {groups.filter(([,items]) => items.length > 0).map(([label, items]) => (
        <div key={label} className="section-block">
          <div className="section-label">{label}</div>
          <div className={label==="Live TV" ? "ch-grid" : "vod-grid"}>
            {items.map((item,i) => label==="Live TV" ? (
              <div key={item.id||i} className="ch-card" onClick={() => onPlay(item)}>
                {item.logo ? <img className="ch-logo" loading="lazy" src={imgSrc(item.logo)} alt="" /> : <div className="ch-logo-ph">📺</div>}
                <div className="ch-name">{item.name}</div>
                <FavBtn on={true} onClick={() => toggleFav(item)} />
              </div>
            ) : (
              <div key={item.id||i} className="vod-card" onClick={() => onPlay(item)}>
                {item.logo ? <img className="vod-poster" loading="lazy" src={imgSrc(item.logo)} alt="" /> : <div className="vod-ph">🎬</div>}
                <div className="vod-info"><div className="vod-title">{item.name}</div></div>
                <button className="vod-fav on" onClick={e=>{e.stopPropagation();toggleFav(item);}}>♥</button>
              </div>
            ))}
            {label === t("movies") && <AdsterraNativeBanner enabled={true} />}
          </div>
        </div>
      ))}
    </div>
  );
});

const ContinueView = memo(function ContinueView({ items, onPlay, history, t }) {
  const recent = history.slice(0, 20);
  if (!recent.length) return (
    <div className="empty">
      <div className="empty-icon">⏯</div>
      <div className="empty-t">{t("nothingStarted")}</div>
      <div className="empty-s">{t("resumeHint")}</div>
    </div>
  );
  return (
    <div style={{flex:1,overflow:"auto",padding:"1.1rem 1.4rem",display:"flex",flexDirection:"column",gap:"1.5rem"}}>
      {items.length > 0 && (
        <div className="section-block">
          <div className="section-label">{t("resumeWatching")}</div>
          <div className="cw-row">
            {items.map((item,i) => {
              const pct = item.duration ? Math.min(100,(item.position/item.duration)*100) : 0;
              return (
                <div key={item.id||i} className="cw-item" onClick={()=>onPlay(item)}>
                  {item.logo ? <img className="cw-poster" loading="lazy" src={imgSrc(item.logo)} alt="" style={{width:"100%",aspectRatio:"16/9",objectFit:"cover"}} /> : <div className="cw-poster">🎬</div>}
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
        <div className="section-label">{t("recentlyWatched")}</div>
        <div style={{display:"flex",flexDirection:"column",gap:".4rem"}}>
          {recent.map((item,i) => (
            <div key={item.id||i} style={{display:"flex",alignItems:"center",gap:".75rem",padding:".5rem .75rem",
              background:"var(--s1)",border:"1px solid var(--b1)",borderRadius:"9px",cursor:"pointer",transition:"all .2s"}}
              onClick={()=>onPlay(item)}
              onMouseEnter={e=>e.currentTarget.style.borderColor="var(--b2)"}
              onMouseLeave={e=>e.currentTarget.style.borderColor="var(--b1)"}>
              {item.logo ? <img loading="lazy" style={{width:"30px",height:"30px",objectFit:"contain",borderRadius:"4px",background:"var(--s2)",flexShrink:0}} src={imgSrc(item.logo)} alt="" /> : <div style={{width:"30px",height:"30px",background:"var(--s2)",borderRadius:"4px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:".75rem",flexShrink:0}}>{item.type==="live"?"📺":"🎬"}</div>}
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
});

const GlobalSearch = memo(function GlobalSearch({ results, query, onPlay, toggleFav, isFav, t }) {
  if (!query || query.length < 2) return (
    <div className="empty">
      <div className="empty-icon">🔍</div>
      <div className="empty-t">{t("searchEverything")}</div>
      <div className="empty-s">{t("searchHint")}</div>
    </div>
  );
  if (!results.length) return (
    <div className="empty"><div className="empty-icon">🔍</div><div className="empty-t">{t("noResults", query)}</div></div>
  );
  const byType = { live:results.filter(r=>r.type==="live"), vod:results.filter(r=>r.type==="vod"), series:results.filter(r=>r.type==="series") };
  const ICONS = {live:"📺",vod:"🎬",series:"📽"};
  const LABELS = {live:t("liveTV"),vod:t("movies"),series:t("series")};
  return (
    <div className="gsearch">
      {Object.entries(byType).filter(([,items])=>items.length).map(([type,items]) => (
        <div key={type} className="gsearch-section">
          <div className="section-label">{LABELS[type]} <span style={{fontFamily:"'DM Sans'",fontWeight:400,color:"var(--t3)",textTransform:"none",letterSpacing:0}}>({items.length})</span></div>
          {items.map((item,i) => (
            <div key={item.id||i} className="gsearch-row" onClick={()=>onPlay(item)}>
              {item.logo ? <img className="gsearch-logo" loading="lazy" src={imgSrc(item.logo)} alt="" onError={e=>e.target.style.display="none"} /> : <div className="gsearch-logo-ph">{ICONS[type]}</div>}
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
});



const EPGView = memo(function EPGView({ channels, epgData, epgURL, setEpgURL, epgLoading, loadEPG, onPlay, onPlayCatchup, t }) {
  const PX_PER_MIN = 3;
  const CH_COL_W = 160;
  const MAX_CHANNELS = 200;

  const [urlInput, setUrlInput] = useState(epgURL || "");
  const [search, setSearch] = useState("");
  const [nowMs, setNowMs] = useState(Date.now());
  const outerRef = useRef(null);

  // Update current time every 30 seconds
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll to "now" on mount
  useEffect(() => {
    if (outerRef.current && epgData) {
      const nowOffset = 60 * PX_PER_MIN; // 1 hour in = 180px
      const viewW = outerRef.current.clientWidth;
      outerRef.current.scrollLeft = Math.max(0, CH_COL_W + nowOffset - viewW / 3);
    }
  }, [epgData]);

  const filteredChannels = useMemo(() => {
    let chs = channels;
    if (search) { const q = search.toLowerCase(); chs = chs.filter(ch => ch.name?.toLowerCase().includes(q)); }
    return chs.slice(0, MAX_CHANNELS);
  }, [channels, search]);

  const handleNow = useCallback(() => {
    const fresh = Date.now();
    setNowMs(fresh);
    setTimeout(() => {
      if (!outerRef.current) return;
      const nowOffset = 60 * PX_PER_MIN;
      const viewW = outerRef.current.clientWidth;
      outerRef.current.scrollTo({ left: Math.max(0, CH_COL_W + nowOffset - viewW / 3), behavior: "smooth" });
    }, 50);
  }, []);

  const handleShift = useCallback((deltaMs) => {
    if (!outerRef.current) return;
    outerRef.current.scrollBy({ left: (deltaMs / 60000) * PX_PER_MIN, behavior: "smooth" });
  }, []);

  return (
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {/* EPG URL bar */}
      <div className="epg-top">
        <input className="fi" style={{flex:"1 1 260px",minWidth:0}} placeholder="XMLTV EPG URL (e.g. http://provider.com/epg.xml)"
          value={urlInput} onChange={e=>setUrlInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&loadEPG(urlInput)} />
        <button className="btn-go" onClick={()=>loadEPG(urlInput)} disabled={epgLoading} style={{padding:".4rem .9rem",fontSize:".82rem"}}>
          {epgLoading ? t("loading") : t("loadEPG")}
        </button>
        {channels.length > 0 && (
          <input className="fi" style={{width:"160px"}} placeholder="Filter channels\u2026"
            value={search} onChange={e=>setSearch(e.target.value)} />
        )}
      </div>

      {/* Empty states */}
      {!channels.length ? (
        <div className="empty"><div className="empty-icon">📋</div><div className="empty-t">No channels loaded</div><div className="empty-s">Connect via Xtream Codes or M3U to populate TV Guide.</div></div>
      ) : !epgData ? (
        <div className="empty">
          <div className="empty-icon">📅</div>
          <div className="empty-t">No EPG data</div>
          <div className="empty-s">Paste your XMLTV EPG URL above and click Load EPG.<br/>Your provider may supply one — check their portal or dashboard.</div>
        </div>
      ) : (
        <>
          {/* Scrollable grid */}
          <TimelineGrid 
            ref={outerRef}
            channels={filteredChannels} 
            epgData={epgData} 
            nowMs={nowMs} 
            onPlay={onPlay} 
            onPlayCatchup={onPlayCatchup} 
          />

          {/* Navigation bar */}
          <div className="epg-nav">
            <button onClick={()=>handleShift(-7200000)}>{"\u2190"} 2hr</button>
            <button className="epg-nav-now" onClick={handleNow}>Now</button>
            <button onClick={()=>handleShift(7200000)}>2hr {"\u2192"}</button>
          </div>
        </>
      )}
    </div>
  );
});

// ── Settings View ──
function SettingsView({ connections, favs, history, authUser, isGuest, activeConnId, onAuth, t: st }) {
  const t = st || (k => k);
  const [tab, setTab] = useState("general");
  const [importErr, setImportErr] = useState("");
  const [importOk, setImportOk] = useState("");
  const [emailInput, setEmailInput] = useState(authUser?.email || "");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailMsg, setEmailMsg] = useState("");
  const fileRef = useRef(null);

  async function updateProfile() {
    setEmailMsg(""); setEmailLoading(true);
    try {
      const res = await fetch(`${API}/api/user/profile`, {
        method: "POST", headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${getAuthToken()}`
        },
        body: JSON.stringify({ email: emailInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setEmailMsg("Recovery email updated successfully!");
      if (onAuth) onAuth({ ...authUser, email: emailInput });
    } catch (e) {
      setEmailMsg(`⚠ ${e.message}`);
    } finally {
      setEmailLoading(false);
    }
  }

  async function exportData() {
    const data = {
      _portal_heaven_export: true,
      version: 1,
      exported_at: new Date().toISOString(),
      user: authUser ? { username: authUser.username, role: authUser.role } : { guest: true },
      connections: await db.get("sv-connections", []),
      theme: await db.get("sv-theme", "Dark"),
      language: localStorage.getItem("sv-lang") || "en",
      hiddenCats: await db.get("sv-hiddenCats", {}),
      epgURL: await db.get("sv-epgURL", ""),
      favorites: {},
      history: {},
    };
    // Export per-connection favorites and history
    for (const conn of data.connections) {
      const fv = await db.get(`sv-favs-${conn.id}`, null);
      const hi = await db.get(`sv-history-${conn.id}`, null);
      if (fv) data.favorites[conn.id] = fv;
      if (hi) data.history[conn.id] = hi;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Portal Heaven-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importData(e) {
    setImportErr(""); setImportOk("");
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data._portal_heaven_export) throw new Error("Not a valid Portal Heaven export file");

        // Import connections
        if (data.connections?.length) {
          const existing = await db.get("sv-connections", []);
          const existingIds = new Set(existing.map(c => c.id));
          const newConns = data.connections.filter(c => !existingIds.has(c.id));
          if (newConns.length) {
            const merged = [...existing, ...newConns];
            db.set("sv-connections", merged);
            if (authUser) syncConnectionsToServer(merged);
          }
        }

        // Import preferences
        if (data.theme) db.set("sv-theme", data.theme);
        if (data.language) localStorage.setItem("sv-lang", data.language);
        if (data.hiddenCats) db.set("sv-hiddenCats", data.hiddenCats);
        if (data.epgURL) db.set("sv-epgURL", data.epgURL);

        // Import per-connection favorites and history
        let favCount = 0, histCount = 0;
        if (data.favorites) {
          for (const [connId, fv] of Object.entries(data.favorites)) {
            const existing = await db.get(`sv-favs-${connId}`, null);
            if (!existing || (Object.keys(existing.live||{}).length === 0 && Object.keys(existing.vod||{}).length === 0)) {
              db.set(`sv-favs-${connId}`, fv);
              if (authUser) syncToServer("favorites", connId, fv);
              favCount++;
            }
          }
        }
        if (data.history) {
          for (const [connId, hi] of Object.entries(data.history)) {
            const existing = await db.get(`sv-history-${connId}`, null);
            if (!existing || existing.length === 0) {
              db.set(`sv-history-${connId}`, hi);
              if (authUser) syncToServer("history", connId, hi);
              histCount++;
            }
          }
        }

        const parts = [];
        if (data.connections?.length) parts.push(`${data.connections.length} connections`);
        if (favCount) parts.push(`${favCount} favorite sets`);
        if (histCount) parts.push(`${histCount} history sets`);
        if (data.theme) parts.push("theme");
        setImportOk(`Imported: ${parts.join(", ") || "preferences"}. Refresh to apply.`);
      } catch (err) {
        setImportErr(err.message || "Import failed");
      }
      if (fileRef.current) fileRef.current.value = "";
    };
    reader.readAsText(file);
  }

  return (
    <div className="c-body" style={{padding:"1.5rem",maxWidth:640}}>
        <div className="tabs-v">
          <button
            className={`tab ${tab === "general" ? "on" : ""}`}
             onClick={() => setTab("general")}
          >
            General
          </button>
          <button
            className={`tab ${tab === "account" ? "on" : ""}`}
            onClick={() => setTab("account")}
          >
            Account
          </button>
          <button
            className={`tab ${tab === "data" ? "on" : ""}`}
            onClick={() => setTab("data")}
          >
            Data
          </button>
        </div>

      {tab === "account" && (
        <div style={{display:"flex",flexDirection:"column",gap:"1.2rem"}}>
          <div style={{background:"var(--s2)",border:"1px solid var(--b2)",borderRadius:10,padding:"1.2rem"}}>
            <div style={{fontSize:".7rem",textTransform:"uppercase",letterSpacing:".08em",color:"var(--t3)",marginBottom:".8rem",fontWeight:600}}>Profile</div>
            {authUser ? (
              <div style={{display:"flex",alignItems:"center",gap:".8rem",marginBottom:"1.2rem"}}>
                <div style={{width:48,height:48,borderRadius:"50%",background:"var(--accent-22)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.2rem",color:"var(--accent)",fontWeight:700}}>
                  {authUser.username?.[0]?.toUpperCase()}
                </div>
                <div>
                  <div style={{fontWeight:600,fontSize:"1rem"}}>{authUser.username}</div>
                  <div style={{fontSize:".75rem",color:"var(--t3)",textTransform:"capitalize"}}>{authUser.role} account</div>
                </div>
              </div>
            ) : (
              <div style={{fontSize:".85rem",color:"var(--t2)",marginBottom:"1rem"}}>You are currently using Guest mode. Log in to enable cloud sync and password recovery.</div>
            )}

            <div className="fg">
              <label className="fl">Recovery Email</label>
              <div style={{display:"flex",gap:".5rem"}}>
                <input className="fi" type="email" placeholder="email@example.com" 
                  value={emailInput} onChange={e=>setEmailInput(e.target.value)} 
                  disabled={!authUser || emailLoading} />
                <button className="btn-go" onClick={updateProfile} disabled={!authUser || emailLoading || !emailInput} style={{padding:"0 1.2rem"}}>
                  {emailLoading ? "..." : "Save"}
                </button>
              </div>
              <div className="fhint">Used for password recovery and account security.</div>
            </div>
            {emailMsg && <div style={{marginTop:".8rem",fontSize:".8rem",color:emailMsg.includes("⚠")?"var(--danger)":"var(--accent)"}}>{emailMsg}</div>}
          </div>
        </div>
      )}

      {tab === "general" && (
        <div style={{color:"var(--t2)",fontSize:".9rem"}}>
          <p>Language and theme settings are available in the sidebar.</p>
          <div style={{marginTop:"1rem",padding:"1rem",background:"var(--s2)",borderRadius:10,border:"1px solid var(--b2)"}}>
            <div style={{fontSize:".7rem",textTransform:"uppercase",fontWeight:600,color:"var(--t3)",marginBottom:".5rem"}}>Active Connection</div>
            <div style={{fontSize:".85rem",color:"var(--t1)"}}>
              {connections.find(c=>c.id===activeConnId)?.label || "None"}
            </div>
          </div>
        </div>
      )}

      {tab === "data" && (
        <div style={{display:"flex",flexDirection:"column",gap:"1.2rem"}}>
          {/* Export */}
          <div style={{background:"var(--s2)",border:"1px solid var(--b2)",borderRadius:10,padding:"1rem"}}>
            <div style={{fontSize:".7rem",textTransform:"uppercase",letterSpacing:".08em",color:"var(--t3)",marginBottom:".5rem",fontWeight:600}}>Export Data</div>
            <div style={{fontSize:".78rem",color:"var(--t2)",marginBottom:".7rem"}}>
              Download all your data: connections, favorites, watch history, preferences.
            </div>
            <button className="btn-primary" style={{padding:".5rem 1.2rem",fontSize:".82rem"}} onClick={exportData}>
              Download Backup (.json)
            </button>
          </div>

          {/* Import */}
          <div style={{background:"var(--s2)",border:"1px solid var(--b2)",borderRadius:10,padding:"1rem"}}>
            <div style={{fontSize:".7rem",textTransform:"uppercase",letterSpacing:".08em",color:"var(--t3)",marginBottom:".5rem",fontWeight:600}}>Import Data</div>
            <div style={{fontSize:".78rem",color:"var(--t2)",marginBottom:".7rem"}}>
              Restore from a previous backup. Existing data is preserved — only missing items are added.
            </div>
            <input ref={fileRef} type="file" accept=".json" onChange={importData}
              style={{fontSize:".8rem",color:"var(--t2)"}} />
            {importErr && <div className="err" style={{marginTop:".5rem",fontSize:".78rem"}}>⚠ {importErr}</div>}
            {importOk && <div style={{marginTop:".5rem",fontSize:".78rem",color:"var(--accent)"}}>{importOk}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

const DirectHLSView = memo(function DirectHLSView() {
  const [url, setUrl] = useState("");
  const [playing, setPlaying] = useState(null);
  const EXAMPLES = [
    ["HLS — Tears of Steel (Adaptive)", "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8"],
    ["HLS — Apple Advanced (fMP4)", "https://devstreaming-cdn.apple.com/videos/streaming/examples/adv_dv_atmos/main.m3u8"],
    ["MP4 — Big Buck Bunny", "https://www3.cde.ca.gov/download/rod/big_buck_bunny.mp4"],
    ["MP4 — Sintel (Open Movie)", "https://media.w3.org/2010/05/sintel/trailer.mp4"],
    ["MP4 — Cosmos Laundromat", "https://media.w3.org/2010/05/bunny/trailer.mp4"],
    ["Live — Bloomberg TV", "https://www.bloomberg.com/media-manifest/streams/us.m3u8"],
  ];
  return (
    <div className="hls-body">
      <div style={{fontSize:".84rem",color:"var(--t2)",lineHeight:1.6}}>
        Enter any HLS (.m3u8), DASH, or direct media URL. Great for testing your own streams.
      </div>
      <div className="hls-row">
        <input className="fi" placeholder="https://your-stream.com/live/stream.m3u8"
          value={url} onChange={e=>setUrl(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&url&&setPlaying({name:url.split("/").pop()||"Stream",url,type:"live",group:"Direct",_direct:true})} />
        <button className="btn-go" onClick={()=>url&&setPlaying({name:url.split("/").pop()||"Stream",url,type:"live",group:"Direct",_direct:true})}>▶ Play</button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:".35rem"}}>
        <div style={{fontSize:".7rem",color:"var(--t3)",textTransform:"uppercase",letterSpacing:".08em",fontWeight:600}}>Public test streams</div>
        {EXAMPLES.map(([label,href]) => (
          <div key={label} style={{fontSize:".75rem",color:"var(--accent)",cursor:"pointer",textDecoration:"underline"}}
            onClick={()=>{setUrl(href);setPlaying({name:label,url:href,type:"live",group:"Test",_direct:true});}}>
            {label}
          </div>
        ))}
      </div>
      {playing && <Player item={playing} onClose={()=>setPlaying(null)} />}
    </div>
  );
});

// ══════════════════════════════════════════════════════════════════
// DISCOVER (TMDB)
// ══════════════════════════════════════════════════════════════════
const TMDB_IMG = "https://image.tmdb.org/t/p/";

function normalizeTitle(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

const DiscoverView = memo(function DiscoverView({ tmdbKey, setTmdbKey, vod, series, onPlay }) {
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
      const u = (path) => key === "server"
        ? `${API}/api/tmdb/${path}?language=en-US`
        : `https://api.themoviedb.org/3/${path}?api_key=${key}&language=en-US`;
      const [t, pm, ptv] = await Promise.all([
        fetch(u("trending/all/week")).then(r => r.json()),
        fetch(u("movie/popular")).then(r => r.json()),
        fetch(u("tv/popular")).then(r => r.json()),
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

  function renderTMDBCard(item, i) {
    const matches = findAllInLibrary(item);
    const inLib   = matches.length > 0;
    const poster  = item.poster_path ? `${TMDB_IMG}w185${item.poster_path}` : null;
    const year    = (item.release_date || item.first_air_date || "").slice(0, 4);
    const rating  = item.vote_average ? item.vote_average.toFixed(1) : null;
    const title   = item.title || item.name || "Unknown";
    return (
      <div key={item.id || i} className="disc-card" onClick={() => handleCardClick(item)} title={title}>
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
          {trending.map((item, i) => renderTMDBCard(item, i))}
        </div>
      </div>

      {/* Popular Movies */}
      <div className="disc-section">
        <div className="section-label">Popular Movies</div>
        <div className="disc-row">
          {popularMovies.map((item, i) => renderTMDBCard({...item, media_type:"movie"}, i))}
        </div>
      </div>

      {/* Popular TV */}
      <div className="disc-section">
        <div className="section-label">Popular TV Shows</div>
        <div className="disc-row">
          {popularTV.map((item, i) => renderTMDBCard({...item, media_type:"tv"}, i))}
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
                        ? <img loading="lazy" src={imgSrc(item.logo)} style={{width:38,height:38,objectFit:"contain",
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
});
