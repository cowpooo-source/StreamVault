import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { API, parseM3U, trackAnalytics } from '../utils.js';
import { proxyFetch, makeXtreamAPI, track, GUEST_ID } from '../app-runtime.js';

const CONN_ICONS = { xtream:"📡", stalker:"📺", m3u:"📋", hls:"🔗" };

export default function Setup({ onConnect, onImportMultiple, onImportFull, connections = [], onReconnect, onRemoveConn, onEdit, authUser, isGuest, onLogout, t: st }) {
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

  const handleFileImport = (e) => {
    setErr("");
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const resultMsg = await onImportFull(data);
        alert(`Imported: ${resultMsg}. Refresh to see all changes.`);
      } catch (err) {
        setErr(err.message || "Import failed");
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  };

  async function diagnose(c) {
    setDiagLoading(p => ({ ...p, [c.id]: true }));
    setDiagResults(p => ({ ...p, [c.id]: null }));
    const startTime = Date.now();
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

      trackAnalytics("portal_connect", {
        provider_type: c.type,
        success: data.reachable ? "true" : "false",
        latency_ms: Date.now() - startTime,
        error_code: String(data.details?.status || data.details?.error || "unknown").slice(0, 50)
      });
    } catch (e) {
      setDiagResults(p => ({ ...p, [c.id]: { reachable: false, details: { error: e.message } } }));
      trackAnalytics("portal_connect", {
        provider_type: c.type,
        success: "false",
        latency_ms: Date.now() - startTime,
        error_code: String(e.message || "unknown").slice(0, 50)
      });
    }
    setDiagLoading(p => ({ ...p, [c.id]: false }));
  }

  // Validate saved connection before reconnecting
  async function validateAndReconnect(conn) {
    if (conn.type !== "stalker") { onReconnect(conn.id); return; }
    setLoading(true); setErr("");
    const startTime = Date.now();
    try {
      const cfg = conn.config || {};
      const vRes = await fetch(`${API}/stalker/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portal: cfg.server, mac: cfg.mac, serial: cfg.serial, deviceId: cfg.deviceId, deviceId2: cfg.deviceId2 }),
      });
      const v = await vRes.json();
      if (!v.portalReachable) {
        setErr("Portal unreachable. Connecting anyway...");
        trackAnalytics("portal_connect", { provider_type: "stalker", success: "false", latency_ms: Date.now() - startTime, error_code: String(v.error || "unreachable").slice(0,50) });
        onReconnect(conn.id);
        return;
      }
      if (v.status === "expired" || v.status === "blocked" || v.status === "suspended" || v.status === "unregistered") {
        setExpiredPrompt({ conn, validation: v });
        trackAnalytics("portal_connect", { provider_type: "stalker", success: "false", latency_ms: Date.now() - startTime, error_code: String(v.status).slice(0,50) });
        // Still allow reconnection despite status issues
        onReconnect(conn.id);
        return;
      }
      trackAnalytics("portal_connect", { provider_type: "stalker", success: "true", latency_ms: Date.now() - startTime, error_code: null });
      onReconnect(conn.id);
    } catch (e) {
      console.warn("Validation failed, reconnecting anyway:", e.message);
      trackAnalytics("portal_connect", { provider_type: "stalker", success: "false", latency_ms: Date.now() - startTime, error_code: String(e.message || "unknown").slice(0,50) });
      onReconnect(conn.id); // Proceed with reconnection even if validation fails
    }
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
    } catch (e) { console.warn("IDB/localStorage error:", e.message); }
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
    const startTime = Date.now();
    try {
      if (type === "xtream") {
        if (!f.server||!f.user||!f.pass) throw new Error("All fields required");
        const server = f.server.trim().replace(/\/$/,"");
        const api = makeXtreamAPI(server, f.user, f.pass);
        const data = await api.auth();
        if (data?.user_info?.auth === 0) throw new Error("Invalid credentials");

        trackAnalytics("portal_connect", { provider_type: type, success: "true", latency_ms: Date.now() - startTime, error_code: null });
        onConnect({ type, server, user:f.user, pass:f.pass, info:data?.user_info });
      } else if (type === "m3u") {
        if (!f.url) throw new Error("Playlist URL required");
        const res = await proxyFetch(f.url.trim());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text.includes("#EXTM3U")) throw new Error("Not a valid M3U playlist");
        const channels = parseM3U(text);
        if (!channels.length) throw new Error("No channels found");

        trackAnalytics("portal_connect", { provider_type: type, success: "true", latency_ms: Date.now() - startTime, error_code: null });
        onConnect({ type, url:f.url, channels, epgUrl: channels.epgUrl, epgUrls: channels.epgUrls });
      } else if (type === "stalker") {
        if (!f.server||!f.mac) throw new Error("Portal URL and MAC required");
        const server = f.server.trim().replace(/\/$/,"");
        const macTrimmed = f.mac.trim();
        const serialTrimmed = f.serial?.trim() || undefined;
        const deviceIdTrimmed = f.deviceId?.trim() || undefined;
        const deviceId2Trimmed = (f.deviceId2?.trim() || f.deviceId?.trim()) || undefined;

        if (skipValidation) {
          track("connect");
          trackAnalytics("portal_connect", { provider_type: type, success: "true", latency_ms: Date.now() - startTime, error_code: null });
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
          trackAnalytics("portal_connect", { provider_type: type, success: "true", latency_ms: Date.now() - startTime, error_code: null });
          onConnect({
            type, server, mac: macTrimmed,
            serial: v.serial || serialTrimmed, deviceId: v.deviceId || deviceIdTrimmed,
            deviceId2: v.deviceId2 || deviceId2Trimmed,
            accountInfo: { status: v.status, expiry: v.expiry, daysLeft: v.daysLeft, tariff: v.tariff, maxConnections: v.maxConnections }
          });
        }
      } else {
        trackAnalytics("portal_connect", { provider_type: type, success: "true", latency_ms: Date.now() - startTime, error_code: null });
        onConnect({ type:"hls" });
      }
    } catch(e) {
      setErr(e.message||"Connection failed");
      trackAnalytics("portal_connect", { provider_type: type, success: "false", latency_ms: Date.now() - startTime, error_code: e.message || "failed" });
    }
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
      .replace(/[➩➜➔→►⇒⟹]/g, ':')
      // Strip box-drawing characters
      .replace(/[╠╣║╗╔╚╝╬╩╦├┤│┐┘└┌┬┴┼─═]/g, '')
      // Strip enclosed alphanumerics (regional/circled letters used as decorators)
      .replace(/[\u{1F150}-\u{1F169}\u{1F170}-\u{1F18F}\u{1F190}-\u{1F1AC}]/gu, '')
      // Strip keycap digit sequences (e.g., 1️⃣) and decorators like ❖
      .replace(/[\d]️?⃣/gu, '')
      .replace(/[❖]/g, '');
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

        {/* SSO Linking */}
        {authUser && (
          <div style={{ display: "flex", gap: ".5rem", marginBottom: "1.2rem" }}>
            <button type="button" onClick={() => window.location.href = `${API}/api/auth/google`}
              style={{ flex: 1, padding: ".4rem", background: "transparent", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "var(--t2)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: ".4rem", fontSize: ".75rem", transition: "all .2s" }}
              onMouseEnter={e => {e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color="var(--t1)"}}
              onMouseLeave={e => {e.currentTarget.style.background = "transparent"; e.currentTarget.style.color="var(--t2)"}}>
              <svg viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
              Link Google
            </button>
            <button type="button" onClick={() => window.location.href = `${API}/api/auth/github`}
              style={{ flex: 1, padding: ".4rem", background: "transparent", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "var(--t2)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: ".4rem", fontSize: ".75rem", transition: "all .2s" }}
              onMouseEnter={e => {e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color="var(--t1)"}}
              onMouseLeave={e => {e.currentTarget.style.background = "transparent"; e.currentTarget.style.color="var(--t2)"}}>
              <svg viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.26.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.93 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
              Link GitHub
            </button>
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

            <div style={{margin:"1rem 0", display:"flex", alignItems:"center", gap:".8rem"}}>
              <div style={{height:"1px", flex:1, background:"var(--b2)"}}></div>
              <div style={{fontSize:".65rem", color:"var(--t3)", textTransform:"uppercase", fontWeight:600}}>OR</div>
              <div style={{height:"1px", flex:1, background:"var(--b2)"}}></div>
            </div>

            <div className="fg">
              <label className="fl">Import from Backup File</label>
              <div style={{display:"flex", gap:".5rem", marginTop:".4rem"}}>
                <input type="file" accept=".json" onChange={handleFileImport}
                  style={{fontSize:".8rem", color:"var(--t2)", flex:1}} />
              </div>
              <div className="fhint">Select a .json file exported from Portal Heaven Settings.</div>
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