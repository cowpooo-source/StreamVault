import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { API, validateM3UChunk, trackAnalytics } from '../utils.js';
import { db, makeXtreamAPI, track, GUEST_ID } from '../app-runtime.js';
import { XtreamForm } from './setup/XtreamForm.jsx';
import { StalkerForm } from './setup/StalkerForm.jsx';
import { M3UForm } from './setup/M3UForm.jsx';
import { ImportForm } from './setup/ImportForm.jsx';
import { ConnectionManagerList } from './setup/ConnectionManagerList.jsx';
import { ConnectionList } from './setup/ConnectionList.jsx';
import { detectFromText } from './setup/setup-utils.js';
import { JellyfinConnectStep } from './setup/JellyfinConnectStep.jsx';
import { JellyfinAdapter } from '../adapters/jellyfin-adapter.js';
import { PlexAdapter } from '../adapters/plex-adapter.js';
import { getConnectionLifecycle, lifecycleFailureMessage } from '../connection-lifecycle.js';
import SettingsView from './SettingsView.jsx';

const CONN_ICONS = { xtream:"📡", stalker:"📺", m3u:"📋", hls:"🔗" };

export default function Setup({ onConnect, onImportMultiple, onImportFull, connections = [], onReconnect, onRemoveConn, onEdit, authUser, isGuest, onLogout, onAuth, themeName, themeOptions, onThemeChange, language, languageOptions, onLanguageChange, onFeedback, onOpenSecureSettings, onOpenAccountSettings, maxConnections, autoLoadMore, setAutoLoadMore, t: st }) {
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
  const pendingDisclaimerActionRef = useRef(null);
  const [diagResults, setDiagResults] = useState({});
  const [diagLoading, setDiagLoading] = useState({});
  const [showSettings, setShowSettings] = useState(false);
  const set = (k,v) => setF(p => ({...p,[k]:v}));

  function reportConnectionValidation(providerType, stage, success, startedAt, error = null) {
    trackAnalytics("connection_validation", {
      provider_type: providerType || "unknown",
      validation_stage: stage,
      success,
      latency_ms: Date.now() - startedAt,
      error_code: error,
    });
  }

  function runWithDisclaimer(action) {
    if (disclaimerAccepted) return action();

    return new Promise((resolve, reject) => {
      pendingDisclaimerActionRef.current = { action, resolve, reject };
      setShowDisclaimer(true);
    });
  }

  function handleImportFull(data) {
    return runWithDisclaimer(() => onImportFull(data));
  }

  function handleImportMultiple(items) {
    const result = runWithDisclaimer(() => onImportMultiple(items));
    // Child import forms do not await this callback, so surface deferred errors here.
    if (result?.catch) result.catch(e => setErr(e.message || "Import failed"));
    return result;
  }

  const handleFileImport = (e) => {
    setErr("");
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        await runWithDisclaimer(async () => {
          const resultMsg = await onImportFull(data);
          alert(`Imported: ${resultMsg}. Refresh to see all changes.`);
          return resultMsg;
        });
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

      reportConnectionValidation(c.type, "diagnose", Boolean(data.reachable), startTime,
        data.reachable ? null : data.details?.status || data.details?.error || "unknown");
    } catch (e) {
      setDiagResults(p => ({ ...p, [c.id]: { reachable: false, details: { error: e.message } } }));
      reportConnectionValidation(c.type, "diagnose", false, startTime, e);
    }
    setDiagLoading(p => ({ ...p, [c.id]: false }));
  }

  async function validateAndReconnect(conn) {
    setLoading(true);
    setErr("");
    const startTime = Date.now();
    const showValidationFailure = (reason, validation = {}) => {
      setExpiredPrompt({ conn, validation: { ...validation, status: "failed", reason } });
      reportConnectionValidation(conn.type, "reconnect", false, startTime, reason || "validation_failed");
    };

    try {
      const lifecycleFailure = lifecycleFailureMessage(conn);
      if (lifecycleFailure) {
        showValidationFailure(lifecycleFailure, getConnectionLifecycle(conn));
        return;
      }
      if (conn.type === "xtream") {
        const cfg = conn.config || {};
        const server = (cfg.server || "").trim().replace(/\/$/, "");
        if (!server || !cfg.user || !cfg.pass) throw new Error("Missing Xtream server or credentials");
        const data = await makeXtreamAPI(server, cfg.user, cfg.pass).auth();
        const status = String(data?.user_info?.status ?? "").trim().toLowerCase();
        if (data?.user_info?.auth !== 1 || ["disabled", "expired", "blocked", "suspended", "0"].includes(status)) {
          showValidationFailure("Invalid credentials or disabled account", data?.user_info || {});
          return;
        }
        reportConnectionValidation(conn.type, "reconnect", true, startTime);
        onReconnect(conn.id);
        return;
      }

      if (conn.type !== "stalker") {
        reportConnectionValidation(conn.type, "reconnect", true, startTime);
        onReconnect(conn.id);
        return;
      }

      const cfg = conn.config || {};
      const vRes = await fetch(`${API}/stalker/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Guest-Id": GUEST_ID },
        body: JSON.stringify({ portal: cfg.server, mac: cfg.mac, serial: cfg.serial, deviceId: cfg.deviceId, deviceId2: cfg.deviceId2 }),
      });
      const v = await vRes.json();
      if (!v.portalReachable) {
        showValidationFailure(v.error || "Portal unreachable", v);
        return;
      }
      if (["expired", "blocked", "suspended", "unregistered"].includes(v.status)) {
        const reason = v.status === "expired"
          ? `Account expired${v.expiry ? ` on ${v.expiry}` : ""}. Contact your provider.`
          : v.status === "blocked" ? "Account is blocked. Contact your provider."
          : v.status === "suspended" ? "Account is suspended. Contact your provider."
          : "MAC address is not registered with this portal.";
        showValidationFailure(reason, v);
        return;
      }
      reportConnectionValidation(conn.type, "reconnect", true, startTime);
      onReconnect(conn.id);
    } catch (e) {
      showValidationFailure(e.message || "Connection validation failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const connList = await db.get("sv-connections", []);
        if (!cancelled && connList?.length) {
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
    })();
    return () => { cancelled = true; };
  }, []);

  function handleConnectClick() {
    runWithDisclaimer(connect);
  }

  function acceptDisclaimer() {
    setDisclaimerAccepted(true);
    localStorage.setItem("sv-disclaimer-accepted", "1");
    setShowDisclaimer(false);
    const pending = pendingDisclaimerActionRef.current;
    pendingDisclaimerActionRef.current = null;
    if (!pending) {
      connect();
      return;
    }
    Promise.resolve()
      .then(pending.action)
      .then(pending.resolve, pending.reject);
  }

  function cancelDisclaimer() {
    const pending = pendingDisclaimerActionRef.current;
    pendingDisclaimerActionRef.current = null;
    pending?.resolve(null);
    setShowDisclaimer(false);
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
        const status = String(data?.user_info?.status ?? "").trim().toLowerCase();
        if (data?.user_info?.auth !== 1 || ["disabled", "expired", "blocked", "suspended", "0"].includes(status)) throw new Error("Invalid credentials or disabled account");

        reportConnectionValidation(type, "create", true, startTime);
        onConnect({ type, server, user:f.user, pass:f.pass, info:data?.user_info });
      } else if (type === "m3u") {
        if (!f.url) throw new Error("Playlist URL required");
        const validation = await validateM3UChunk(f.url.trim());
        if (!validation.ok) throw new Error(validation.reason || "Playlist validation failed");

        reportConnectionValidation(type, "create", true, startTime);
        onConnect({ type, url: f.url });
      } else if (type === "stalker") {
        if (!f.server||!f.mac) throw new Error("Portal URL and MAC required");
        const server = f.server.trim().replace(/\/$/,"");
        const macTrimmed = f.mac.trim();
        const serialTrimmed = f.serial?.trim() || undefined;
        const deviceIdTrimmed = f.deviceId?.trim() || undefined;
        const deviceId2Trimmed = (f.deviceId2?.trim() || f.deviceId?.trim()) || undefined;

        if (skipValidation) {
          track("connect");
          reportConnectionValidation(type, "create", true, startTime);
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
          reportConnectionValidation(type, "create", true, startTime);
          onConnect({
            type, server, mac: macTrimmed,
            serial: v.serial || serialTrimmed, deviceId: v.deviceId || deviceIdTrimmed,
            deviceId2: v.deviceId2 || deviceId2Trimmed,
            accountInfo: { status: v.status, expiry: v.expiry, daysLeft: v.daysLeft, tariff: v.tariff, maxConnections: v.maxConnections }
          });
        }
      } else if (type === "jellyfin") {
        const baseUrl = (f.server || "").trim().replace(/\/$/, "");
        const username = f.user || "";
        const password = f.pass || "";
        if (!baseUrl || !username || !password) throw new Error("Server URL, username, and password required");
        const { userId, accessToken } = await JellyfinAdapter.authenticate(baseUrl, username, password);
        if (!userId) throw new Error("Jellyfin authentication failed");
        reportConnectionValidation(type, "create", true, startTime);
        onConnect({ type, server: baseUrl, user: username, token: accessToken, userId });
      } else if (type === "plex") {
        throw new Error("Plex connection requires PIN pairing. Use the Plex setup screen.");
      } else if (type === "hls") {
        reportConnectionValidation(type, "create", true, startTime);
        onConnect({ type:"hls" });
      } else {
        throw new Error(`Unsupported connection type: ${type || "unknown"}`);
      }
    } catch(e) {
      setErr(e.message||"Connection failed");
      reportConnectionValidation(type, "create", false, startTime, e);
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

  const TYPES = [
    ["import", "\u21e9", t("import")],
    ["xtream", "\u25a3", t("xtreamCodes")],
    ["m3u", "\u2637", t("m3uPlaylist")],
    ["stalker", "\u25c9", t("stalkerPortal")],
    ["hls", "\u25b6", t("directHLS")],
  ];

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
              <button type="button" onClick={() => setShowSettings(true)} aria-label="Open settings"
                style={{background:"none",border:"1px solid var(--b2)",borderRadius:6,cursor:"pointer",
                  fontSize:".8rem",color:"var(--t3)",padding:".25rem .5rem",transition:"all .2s"}}>
                {"\u2699"}
              </button>
            )}
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

        {showSettings && createPortal(
          <div role="dialog" aria-modal="true" aria-label="Settings"
            style={{position:"fixed",inset:0,zIndex:99999,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
            onClick={e => { if (e.target === e.currentTarget) setShowSettings(false); }}>
            <div style={{position:"relative",background:"var(--s1,#0f0f1c)",border:"1px solid var(--b2)",borderRadius:14,padding:"1.5rem",width:"100%",maxWidth:620,maxHeight:"85vh",overflowY:"auto",boxShadow:"0 8px 32px rgba(0,0,0,.5)"}}>
              <button type="button" onClick={() => setShowSettings(false)} aria-label="Close settings"
                style={{position:"absolute",top:10,right:10,background:"none",border:"none",color:"var(--t2)",fontSize:"1.2rem",cursor:"pointer"}}>{"\u00d7"}</button>
              <SettingsView connections={connections} authUser={authUser} activeConnId={null}
                onAuth={onAuth} onImportFull={handleImportFull} autoLoadMore={autoLoadMore} setAutoLoadMore={setAutoLoadMore}
                onOpenSecureSettings={onOpenSecureSettings}
                onOpenAccountSettings={(tab) => { setShowSettings(false); onOpenAccountSettings?.(tab); }}
                themeName={themeName} themeOptions={themeOptions} onThemeChange={onThemeChange}
                language={language} languageOptions={languageOptions} onLanguageChange={onLanguageChange}
                onFeedback={() => { setShowSettings(false); onFeedback?.(); }}
                onLogout={() => { setShowSettings(false); onLogout?.(); }} maxConnections={maxConnections} />
            </div>
          </div>, document.body
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
          {TYPES.map(([k, icon, label]) => (
            <button key={k} className={`tab ${type===k?"on":""}`} onClick={() => {setType(k);setErr("")}}>
              <span aria-hidden="true" style={{ marginRight: ".35rem", fontSize: ".9em" }}>{icon}</span>
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
            onImportMultiple={handleImportMultiple}
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
            onImportMultiple={handleImportMultiple}
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
              <div style={{fontSize:"1.05rem",fontWeight:700,textAlign:"center",marginBottom:".4rem",color:"var(--t1,#dde0f5)"}}>
                Import Issues Found
              </div>
              <div style={{textAlign:"center",fontSize:".8rem",opacity:.7,marginBottom:"1rem"}}>
                1 of 1 connection failed validation
              </div>
              <div style={{padding:".6rem .7rem",background:"rgba(255,45,85,0.08)",border:"1px solid rgba(255,45,85,0.3)",borderRadius:8,fontSize:".8rem",marginBottom:"1rem"}}>
                <div style={{fontWeight:600,marginBottom:".25rem",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  {expiredPrompt.conn.label}
                </div>
                <div style={{color:"var(--err,#ff2d55)",fontSize:".78rem"}}>
                  ⚠ {expiredPrompt.validation.reason || (expiredPrompt.validation.expiry ? `Account expired on ${expiredPrompt.validation.expiry}.` : "Connection validation failed")}
                </div>
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
                <button onClick={cancelDisclaimer}
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
