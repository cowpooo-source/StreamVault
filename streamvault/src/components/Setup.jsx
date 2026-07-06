import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { API, parseM3U, trackAnalytics } from '../utils.js';
import { proxyFetch, makeXtreamAPI, track, GUEST_ID } from '../app-runtime.js';
import { XtreamForm } from './setup/XtreamForm.jsx';
import { StalkerForm } from './setup/StalkerForm.jsx';
import { M3UForm } from './setup/M3UForm.jsx';
import { ImportForm } from './setup/ImportForm.jsx';
import { ConnectionManagerList } from './setup/ConnectionManagerList.jsx';
import { ConnectionList } from './setup/ConnectionList.jsx';
import { detectFromText } from './setup/setup-utils.js';
import { JellyfinConnectStep } from './setup/JellyfinConnectStep.jsx';

const CONN_ICONS = { xtream:"📡", stalker:"📺", m3u:"📋", hls:"🔗" };

export default function Setup({ onConnect, onImportMultiple, onImportFull, connections = [], onReconnect, onRemoveConn, onEdit, authUser, isGuest, onLogout, t: st }) {
  const t = st || ((k) => k);
  const [type, setType]     = useState("xtream");
  const [f, setF]           = useState({ server:"", user:"", pass:"", mac:"", url:"", serial:"", deviceId:"", deviceId2:"" });
  const [rawText, setRawText] = useState("");
  const [detected, setDetected] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr]       = useState("");
  const [expiredPrompt, setExpiredPrompt] = useState(null);
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
        onReconnect(conn.id);
        return;
      }
      trackAnalytics("portal_connect", { provider_type: "stalker", success: "true", latency_ms: Date.now() - startTime, error_code: null });
      onReconnect(conn.id);
    } catch (e) {
      console.warn("Validation failed, reconnecting anyway:", e.message);
      trackAnalytics("portal_connect", { provider_type: "stalker", success: "false", latency_ms: Date.now() - startTime, error_code: String(e.message || "unknown").slice(0,50) });
      onReconnect(conn.id);
    }
    finally { setLoading(false); }
  }

  useEffect(() => {
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

  const handleRawTextChange = (text) => {
    setRawText(text);
    const d = detectFromText(text);
    setDetected(d);
    setSelected(new Set());
  };

  const handleFillSingle = (d) => {
    if (d.type === "stalker") { setType("stalker"); set("server", d.server || ""); set("mac", d.mac || ""); if (d.serial) { set("serial", d.serial); } if (d.deviceId) { set("deviceId", d.deviceId); } if (d.deviceId2) { set("deviceId2", d.deviceId2); } else if (d.deviceId) { set("deviceId2", d.deviceId); } }
    else if (d.type === "xtream") { setType("xtream"); set("server", d.server || ""); set("user", d.user || ""); set("pass", d.pass || ""); }
    else if (d.type === "m3u") { setType("m3u"); set("url", d.url || ""); }
  };

  const TYPES = [["import",t("import")],["xtream",t("xtreamCodes")],["m3u",t("m3uPlaylist")],["stalker",t("stalkerPortal")],["hls",t("directHLS")],["jellyfin","Jellyfin"]];

  return (
    <div className="setup">
      <div className="card">
        <div className="logo">Portal Heaven</div>
        <div className="tagline">{t("tagline")}</div>

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

        {connections.length > 0 && (
          <ConnectionManagerList
            connections={connections}
            activeConnId={null}
            diagResults={diagResults}
            diagLoading={diagLoading}
            onReconnect={(id) => {
              const conn = connections.find(c => c.id === id);
              if (conn) validateAndReconnect(conn);
            }}
            onEdit={onEdit}
            onRemoveConn={onRemoveConn}
            onDiagnose={diagnose}
          />
        )}

        {err && <div className="err">⚠ {err}</div>}
        <div className="tabs">
          {TYPES.map(([k,label]) => (
            <button key={k} className={`tab ${type===k?"on":""}`} onClick={() => {setType(k);setErr("")}}>
              {label}
            </button>
          ))}
        </div>
        {type==="xtream" && (
          <XtreamForm form={f} setForm={set} loading={loading} err={err} onSubmit={handleConnectClick} />
        )}
        {type==="m3u" && (
          <M3UForm
            form={f}
            setForm={set}
            rawText={rawText}
            setRawText={handleRawTextChange}
            loading={loading}
            err={err}
            detected={detected}
            selected={selected}
            setSelected={setSelected}
            onSubmit={handleConnectClick}
            onFileImport={handleFileImport}
            onImportMultiple={onImportMultiple}
          />
        )}
        {type==="stalker" && (
          <StalkerForm
            form={f}
            setForm={set}
            loading={loading}
            err={err}
            skipValidation={skipValidation}
            setSkipValidation={setSkipValidation}
            onSubmit={handleConnectClick}
            onValidate={null}
          />
        )}
        {type==="hls" && (
          <div style={{padding:"1rem 0",color:"var(--t2)",fontSize:".86rem",lineHeight:1.7}}>
            {t("hlsPlayNote")}
          </div>
        )}
        {type==="jellyfin" && (
          <JellyfinConnectStep onConnected={() => onConnect({ type: 'jellyfin' })} />
        )}
        {type==="import" && (
          <ImportForm
            rawText={rawText}
            setRawText={handleRawTextChange}
            detected={detected}
            selected={selected}
            setSelected={setSelected}
            onFileImport={handleFileImport}
            onImportMultiple={onImportMultiple}
            onFillSingle={handleFillSingle}
          />
        )}
        <button className="btn-primary" onClick={handleConnectClick} disabled={loading || type==="import"} style={type==="import"?{display:"none"}:{}}>
          {loading ? t("connecting") : t("connectArrow")}
        </button>

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