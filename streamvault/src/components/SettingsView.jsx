import React, { useState, useRef } from 'react';
import { API } from '../utils.js';
import { db } from '../app-runtime.js';
import { mergeConnectionSnapshots } from '../connection-lifecycle.js';
import {
  getAnalyticsConsent,
  isAnalyticsAvailable,
  setAnalyticsConsent,
  subscribeAnalyticsConsent,
} from '../analytics.js';

export default function SettingsView({ connections, authUser, activeConnId, onAuth, onImportFull, autoLoadMore, setAutoLoadMore, contentMode = false, onOpenSecureSettings, onOpenAccountSettings, themeName, themeOptions = [], onThemeChange, language, languageOptions = {}, onLanguageChange, onFeedback, onLogout, maxConnections }) {
  const [tab, setTab] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get("settingsTab");
    return ["general", "account", "data"].includes(requested) ? requested : "general";
  });
  const [importErr, setImportErr] = useState("");
  const [importOk, setImportOk] = useState("");
  const [emailInput, setEmailInput] = useState(authUser?.email || "");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailMsg, setEmailMsg] = useState("");
  const [analyticsConsent, setAnalyticsConsentState] = useState(getAnalyticsConsent);
  const fileRef = useRef(null);
  const analyticsConsentLabel = { granted: 'Enabled', denied: 'Disabled' }[analyticsConsent] || 'Not selected';

  React.useEffect(() => subscribeAnalyticsConsent(setAnalyticsConsentState), []);

  async function updateProfile() {
    setEmailMsg(""); setEmailLoading(true);
    try {
      const res = await fetch(`${API}/api/user/profile`, {
        method: "POST", headers: {
          "Content-Type": "application/json",
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
    const storedConnections = await db.get("sv-connections", []);
    const data = {
      _portal_heaven_export: true,
      version: 1,
      exported_at: new Date().toISOString(),
      user: authUser ? { username: authUser.username, role: authUser.role } : { guest: true },
      connections: mergeConnectionSnapshots(storedConnections, connections),
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
        const resultMsg = await onImportFull(data);
        setImportOk(`Imported: ${resultMsg}. Refresh to apply.`);
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
          <div style={{background:"var(--s2)",border:"1px solid var(--b2)",borderRadius:10,padding:"1.2rem",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:".8rem"}}>
            <div>
              <div style={{fontSize:".95rem",fontWeight:700,color:"var(--t1)"}}>Account Plan & Subscriptions</div>
              <div style={{fontSize:".78rem",color:"var(--t3)",marginTop:".2rem"}}>Manage your active subscription, 30-day pass, connection slots, and billing history.</div>
            </div>
            <button
              type="button"
              className="btn-go"
              style={{padding:".5rem 1.2rem",fontSize:".82rem",fontWeight:600}}
              onClick={() => onOpenAccountSettings?.("billing")}
            >
              Billing & Plans
            </button>
          </div>

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
            <>
              <div style={{background:"var(--s2)",border:"1px solid var(--b2)",borderRadius:10,padding:"1.2rem",marginTop:"1rem"}}>
                <div style={{fontSize:".7rem",textTransform:"uppercase",letterSpacing:".08em",color:"var(--t3)",marginBottom:".35rem",fontWeight:600}}>Connected accounts</div>
                <div style={{fontSize:".78rem",color:"var(--t3)",marginBottom:".8rem"}}>Link a social account for easier sign-in and account recovery.</div>
                <div style={{display:"flex",gap:".6rem",flexWrap:"wrap"}}>
                  <button type="button" className="btn-sm" onClick={() => { window.location.href = API + "/api/auth/google"; }}><span aria-hidden="true" style={{fontWeight:800,color:"#4285F4",fontSize:"1rem",lineHeight:1}}>G</span> Link Google</button>
                  <button type="button" className="btn-sm" onClick={() => { window.location.href = API + "/api/auth/github"; }}><svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.44 9.8 8.21 11.39.6.11.82-.26.82-.57v-2.23c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.75.08-.74.08-.74 1.2.08 1.83 1.23 1.83 1.23 1.07 1.83 2.8 1.3 3.49 1 .11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.94 0-1.31.47-2.38 1.23-3.22-.12-.3-.53-1.53.12-3.19 0 0 1-.32 3.3 1.23.96-.27 1.98-.4 3-.41 1.02.01 2.04.14 3 .41 2.3-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.89.12 3.19.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.64-5.48 5.94.43.37.81 1.1.81 2.22v3.3c0 .32.22.69.83.57A12 12 0 0 0 24 12C24 5.37 18.63 0 12 0Z"/></svg> Link GitHub</button>
                </div>
              </div>
            </>
            {emailMsg && <div style={{marginTop:".8rem",fontSize:".8rem",color:emailMsg.includes("⚠")?"var(--danger)":"var(--accent)"}}>{emailMsg}</div>}
          </div>
        </div>
      )}

      {tab === "general" && (
        <div style={{color:"var(--t2)",fontSize:".9rem"}}>
          {(themeOptions.length > 0 || Object.keys(languageOptions).length > 0) && (
            <div style={{padding:"1.2rem",background:"var(--s2)",borderRadius:10,border:"1px solid var(--b2)"}}>
              <div style={{fontSize:".7rem",textTransform:"uppercase",fontWeight:600,color:"var(--t3)",marginBottom:".8rem",letterSpacing:".05em"}}>Appearance</div>
              {themeOptions.length > 0 && <div className="fg"><label className="fl" htmlFor="settings-theme">Theme</label><select id="settings-theme" className="fi" value={themeName} onChange={e => onThemeChange?.(e.target.value)}>{themeOptions.map(name => <option key={name} value={name}>{name}</option>)}</select></div>}
              {Object.keys(languageOptions).length > 0 && <div className="fg"><label className="fl" htmlFor="settings-language">Language</label><select id="settings-language" className="fi" value={language} onChange={e => onLanguageChange?.(e.target.value)}>{Object.entries(languageOptions).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></div>}
            </div>
          )}

          <div style={{marginTop:"1rem",padding:"1.2rem",background:"var(--s2)",borderRadius:10,border:"1px solid var(--b2)"}}>
            <div style={{fontSize:".7rem",textTransform:"uppercase",fontWeight:600,color:"var(--t3)",marginBottom:".8rem",letterSpacing:".05em"}}>Playback & Content</div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div>
                <div style={{fontSize:".88rem",color:"var(--t1)",fontWeight:600}}>Auto-load next page</div>
                <div style={{fontSize:".72rem",color:"var(--t3)",marginTop:".2rem"}}>Automatically load more items when scrolling in Movies/Series.</div>
              </div>
              <button
                className={`c-btn ${autoLoadMore ? "active" : ""}`}
                style={{minWidth:"100px"}}
                onClick={() => setAutoLoadMore(v => !v)}
              >
                {autoLoadMore ? "Enabled" : "Disabled"}
              </button>
            </div>
          </div>

          {(onFeedback || onLogout) && (
            <div style={{marginTop:"1rem",padding:"1.2rem",background:"var(--s2)",borderRadius:10,border:"1px solid var(--b2)"}}>
              <div style={{fontSize:".7rem",textTransform:"uppercase",fontWeight:600,color:"var(--t3)",marginBottom:".8rem",letterSpacing:".05em"}}>Account Actions</div>
              <div style={{display:"flex",gap:".6rem",flexWrap:"wrap"}}>
                {onFeedback && <button className="btn-sm" onClick={onFeedback}>Send Feedback</button>}
                {onLogout && <button className="btn-sm danger" onClick={onLogout}>{authUser ? "Logout" : "Login"}</button>}
              </div>
            </div>
          )}

          <div style={{marginTop:"1rem",padding:"1.2rem",background:"var(--s2)",borderRadius:10,border:"1px solid var(--b2)"}}>
            <div style={{fontSize:".7rem",textTransform:"uppercase",fontWeight:600,color:"var(--t3)",marginBottom:".5rem",letterSpacing:".05em"}}>Connections</div>
            <div style={{fontSize:".85rem",color:"var(--t1)"}}>{connections.length}{Number.isFinite(maxConnections) ? ` / ${maxConnections}` : ""} saved</div>
          </div>
          {isAnalyticsAvailable() && <div style={{marginTop:"1rem",padding:"1.2rem",background:"var(--s2)",borderRadius:10,border:"1px solid var(--b2)"}}>
            <div style={{fontSize:".7rem",textTransform:"uppercase",fontWeight:600,color:"var(--t3)",marginBottom:".7rem",letterSpacing:".05em"}}>Privacy</div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:"1rem"}}>
              <div>
                <div style={{fontSize:".88rem",color:"var(--t1)",fontWeight:600}}>Anonymous product analytics</div>
                <div style={{fontSize:".72rem",color:"var(--t3)",marginTop:".2rem",lineHeight:1.45}}>
                  Shares setup and playback reliability categories. Provider details, searches, titles, and account data are excluded.
                </div>
                <div aria-live='polite' style={{fontSize:'.72rem',color:'var(--accent)',marginTop:'.5rem',fontWeight:600}}>
                  Consent: {analyticsConsentLabel}
                </div>
              </div>
              <div style={{display:'flex',gap:'.45rem',flexWrap:'wrap',justifyContent:'flex-end'}}>
                <button type='button' className={analyticsConsent === 'granted' ? 'c-btn active' : 'c-btn'} onClick={() => setAnalyticsConsent('granted')}>
                  Allow analytics
                </button>
                <button type='button' className={analyticsConsent === 'denied' ? 'c-btn active' : 'c-btn'} onClick={() => setAnalyticsConsent('denied')}>
                  Disable analytics
                </button>
              </div>
            </div>
          </div>}
          <div style={{marginTop:"1rem",padding:"1.2rem",background:"var(--s2)",borderRadius:10,border:"1px solid var(--b2)"}}>
            <div style={{fontSize:".7rem",textTransform:"uppercase",fontWeight:600,color:"var(--t3)",marginBottom:".5rem",letterSpacing:".05em"}}>Active Connection</div>
            <div style={{fontSize:".85rem",color:"var(--t1)"}}>
              {connections.find(c=>c.id===activeConnId)?.label || "None"}
            </div>
          </div>
        </div>
      )}

      {tab === "data" && (
        <div style={{display:"flex",flexDirection:"column",gap:"1.2rem"}}>
          {contentMode ? (
            <div style={{background:"var(--s2)",border:"1px solid var(--b2)",borderRadius:10,padding:"1rem"}}>
              <div style={{fontSize:".7rem",textTransform:"uppercase",letterSpacing:".08em",color:"var(--t3)",marginBottom:".5rem",fontWeight:600}}>Secure Backup Management</div>
              <div style={{fontSize:".78rem",color:"var(--t2)",marginBottom:".7rem"}}>
                The HTTP player only has access to the active connection. Export and import backups from the secure app to include every saved connection.
              </div>
              <button className="btn-primary" style={{padding:".5rem 1.2rem",fontSize:".82rem"}} onClick={onOpenSecureSettings}>
                Manage Backups Securely
              </button>
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
