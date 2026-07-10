import { useState, useRef, useEffect } from "react";

const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;

export default function AuthScreen({ onAuth, onGuest, api }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [forceLogin, setForceLogin] = useState(false);
  const [turnstileState, setTurnstileState] = useState(siteKey ? "loading" : "unavailable");
  const formRef = useRef(null);
  const turnstileContainerRef = useRef(null);
  const turnstileWidgetIdRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errorParam = params.get("error");
    if (errorParam === "email_exists") {
      const p = params.get("provider") || "another provider";
      setErr(`That email is already registered. Please log in with your password to link your ${p} account.`);
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (errorParam === "already_linked") {
      setErr("That account is already linked to another user.");
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (errorParam === "sso_failed") {
      setErr("Single Sign-On failed. Please try again.");
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (errorParam === "not_configured") {
      setErr("This login method is not fully configured on the server yet.");
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeoutTimer = null;
    const scriptSelector = 'script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]';
    const scriptEl = typeof document !== "undefined" ? document.querySelector(scriptSelector) : null;

    const cleanupWidget = () => {
      const existingWidgetId = turnstileWidgetIdRef.current;
      if (existingWidgetId !== null && existingWidgetId !== undefined && window.turnstile?.remove) {
        try {
          window.turnstile.remove(existingWidgetId);
        } catch (e) {
          console.warn("Turnstile cleanup skipped:", e?.message || e);
        }
      }
      if (turnstileContainerRef.current) {
        turnstileContainerRef.current.innerHTML = "";
      }
      turnstileWidgetIdRef.current = null;
    };

    const renderWidget = () => {
      if (cancelled || !siteKey || !turnstileContainerRef.current) return false;
      if (!window.turnstile?.render) return false;

      cleanupWidget();
      try {
        turnstileWidgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
          sitekey: siteKey,
          theme: "dark",
        });
        setTurnstileState("ready");
        return true;
      } catch (e) {
        console.error("Turnstile render error", e);
        setTurnstileState("unavailable");
        return false;
      }
    };

    const markUnavailable = () => {
      if (!cancelled) setTurnstileState("unavailable");
    };

    if (!siteKey) {
      setTurnstileState("unavailable");
      cleanupWidget();
      return () => {};
    }

    setTurnstileState("loading");
    if (renderWidget()) {
      return () => {
        cancelled = true;
        if (timeoutTimer) window.clearTimeout(timeoutTimer);
        cleanupWidget();
      };
    }

    const onLoad = () => {
      if (!cancelled) renderWidget();
    };
    const onError = () => {
      markUnavailable();
    };

    timeoutTimer = window.setTimeout(() => {
      markUnavailable();
    }, 5000);

    if (scriptEl) {
      scriptEl.addEventListener("load", onLoad, { once: true });
      scriptEl.addEventListener("error", onError, { once: true });
    } else if (window.turnstile?.render) {
      renderWidget();
    }

    return () => {
      cancelled = true;
      if (timeoutTimer) window.clearTimeout(timeoutTimer);
      if (scriptEl) {
        scriptEl.removeEventListener("load", onLoad);
        scriptEl.removeEventListener("error", onError);
      }
      cleanupWidget();
    };
  }, [mode, siteKey]);

  function resetTurnstile() {
    if (!window.turnstile?.reset) return;
    const widgetId = turnstileWidgetIdRef.current;
    if (widgetId === null || widgetId === undefined) return;
    try {
      window.turnstile.reset(widgetId);
    } catch (e) {
      console.warn("Turnstile reset skipped:", e?.message || e);
    }
  }

  async function submit(e) {
    e?.preventDefault();
    setErr(""); setMsg(""); setLoading(true);

    const formData = formRef.current ? new FormData(formRef.current) : new FormData();
    const turnstileResponse = formData.get("cf-turnstile-response");

    try {
      if (mode === "forgot") {
        if (!emailInput) throw new Error("Email is required");
        const res = await fetch(`${api}/api/auth/forgot-password`, {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: emailInput }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to send reset email");
        }
        const data = await res.json();
        setMsg(data.message || "Reset link sent!");
        return;
      }

      if (siteKey && turnstileState === "unavailable" && !turnstileResponse) {
        throw new Error("CAPTCHA is temporarily unavailable. Please try again later.");
      }

      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = { username, password };
      if (turnstileResponse) body.cf_turnstile_response = turnstileResponse;
      if (mode === "register") body.email = emailInput;
      if (forceLogin) body.force = true;

      let res = await fetch(`${api}${endpoint}`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let data = await res.json();

      if (data.code === 'MAX_LOGINS_REACHED') {
        resetTurnstile();
        if (window.confirm("Max login reached. Do you want to force login which will logout previous user? (You will need to re-verify CAPTCHA)")) {
          setForceLogin(true);
          setErr("Please re-verify CAPTCHA and click Login again to force login.");
          return;
        } else {
          throw new Error(data.error || "Failed");
        }
      }

      if (!res.ok) {
        throw new Error(data.error || "Failed");
      }

      onAuth(data.user);
    } catch (e) {
      setErr(e.message);
      resetTurnstile();
    }
    finally { setLoading(false); }
  }

  async function submitGuest(e) {
    e?.preventDefault();
    setErr(""); setMsg(""); setLoading(true);

    try {
      const res = await fetch(`${api}/api/auth/guest`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed");
      }

      onGuest();
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
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
              <button className={`tab ${mode==="login"?"on":""}`} onClick={() => {setMode("login");setErr("");setMsg("");setForceLogin(false);}}>Login</button>
              <button className={`tab ${mode==="register"?"on":""}`} onClick={() => {setMode("register");setErr("");setMsg("");setForceLogin(false);}}>Register</button>
            </div>
            {err && <div className="err" style={{marginBottom:".8rem"}}>⚠ {err}</div>}
            <form ref={formRef} onSubmit={submit}>
              <div className="fg">
                <label className="fl">Username</label>
                <input className="fi" placeholder="Username" name="username" value={username} onChange={e => {setUsername(e.target.value); if(forceLogin) setForceLogin(false);}} autoFocus />
              </div>
              {mode === "register" && (
                <div className="fg">
                  <label className="fl">Email Address</label>
                  <input className="fi" type="email" placeholder="email@example.com" name="email" value={emailInput} onChange={e => setEmailInput(e.target.value)} />
                </div>
              )}
              <div className="fg">
                <label className="fl">Password</label>
                <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                  <input className="fi" type={showPassword ? "text" : "password"} placeholder="Password" name="password" value={password}
                    onChange={e => {setPassword(e.target.value); if(forceLogin) setForceLogin(false);}}
                    style={{ paddingRight: "2.5rem" }} />
                  <button type="button" onClick={() => setShowPassword(!showPassword)}
                    style={{ position: "absolute", right: "0.5rem", background: "none", border: "none", color: "var(--t2)", cursor: "pointer", padding: "0.2rem" }}
                    title={showPassword ? "Hide password" : "Show password"}>
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              {mode === "login" && (
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:"-0.5rem",marginBottom:"0.8rem"}}>
                  <label style={{display:"flex",alignItems:"center",gap:".4rem",fontSize:".75rem",color:"var(--t2)",cursor:"pointer"}}>
                    <input type="checkbox" checked={forceLogin} onChange={e => setForceLogin(e.target.checked)} style={{accentColor:"var(--accent)"}} />
                    Force Login
                  </label>
                  <button type="button" onClick={() => setMode("forgot")} style={{background:"none",border:"none",color:"var(--accent)",fontSize:".75rem",cursor:"pointer",padding:0}}>Forgot Password?</button>
                </div>
              )}
              {siteKey && (
                <div style={{ marginBottom: "0.5rem" }}>
                  <div
                    ref={turnstileContainerRef}
                    style={{ marginBottom: "0.25rem", display: "flex", justifyContent: "center" }}
                  />
                  {turnstileState === "loading" && (
                    <div style={{ fontSize: ".72rem", color: "var(--t3)", textAlign: "center" }}>Loading verification...</div>
                  )}
                  {turnstileState === "unavailable" && (
                    <div style={{ fontSize: ".72rem", color: "var(--danger)", textAlign: "center" }}>
                      Verification is temporarily unavailable.
                    </div>
                  )}
                </div>
              )}
              <button type="submit" className="btn-primary" disabled={loading} style={{width:"100%"}}>
                {loading ? "..." : mode === "login" ? "Login" : "Create Account"}
              </button>

              <div style={{ display: "flex", alignItems: "center", margin: "1.2rem 0" }}>
                <div style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.1)" }} />
                <div style={{ padding: "0 10px", fontSize: ".75rem", color: "var(--t3)", textTransform: "uppercase" }}>Or continue with</div>
                <div style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.1)" }} />
              </div>
              <div style={{ display: "flex", gap: ".5rem" }}>
                <button type="button" onClick={() => window.location.href = `${api}/api/auth/google`} disabled={loading}
                  style={{ flex: 1, padding: ".6rem", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "var(--t1)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: ".5rem", fontSize: ".85rem", transition: "all .2s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}
                  onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}>
                  Google
                </button>
                <button type="button" onClick={() => window.location.href = `${api}/api/auth/github`} disabled={loading}
                  style={{ flex: 1, padding: ".6rem", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "var(--t1)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: ".5rem", fontSize: ".85rem", transition: "all .2s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}
                  onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}>
                  GitHub
                </button>
              </div>

            </form>
          </>
        ) : (
          <>
            <div style={{fontSize:"1.1rem",fontWeight:600,marginBottom:"0.5rem",textAlign:"center"}}>Reset Password</div>
            <p style={{fontSize:".8rem",color:"var(--t2)",marginBottom:"1.2rem",textAlign:"center"}}>Enter your email address and we'll send you a link to reset your password.</p>
            {err && <div className="err" style={{marginBottom:".8rem"}}>⚠ {err}</div>}
            {msg && <div style={{background:"rgba(0,212,255,0.1)",color:"var(--accent)",padding:".8rem",borderRadius:8,fontSize:".8rem",marginBottom:"1rem",border:"1px solid var(--accent-22)"}}>{msg}</div>}
            <form ref={formRef} onSubmit={submit}>
              <div className="fg">
                <label className="fl">Email Address</label>
                <input className="fi" type="email" name="email" placeholder="email@example.com" value={emailInput} onChange={e => setEmailInput(e.target.value)} autoFocus />
              </div>
              <button type="submit" className="btn-primary" disabled={loading || !!msg} style={{width:"100%",marginTop:".5rem"}}>
                {loading ? "..." : "Send Reset Link"}
              </button>
              <button type="button" onClick={() => setMode("login")} style={{width:"100%",background:"none",border:"1px solid var(--b2)",color:"var(--t2)",padding:".6rem",borderRadius:8,fontSize:".85rem",marginTop:".8rem",cursor:"pointer"}}>Back to Login</button>
            </form>
          </>
        )}

        <div style={{textAlign:"center",marginTop:"1.2rem"}}>
          <button onClick={submitGuest} disabled={loading} style={{width:"100%",padding:".65rem",background:"transparent",
            border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,color:"var(--t2)",cursor:"pointer",
            fontSize:".88rem",fontWeight:500,fontFamily:"'DM Sans',sans-serif",transition:"all .2s"}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--accent)";e.currentTarget.style.color="var(--accent)"}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.15)";e.currentTarget.style.color="var(--t2)"}}>
            {loading ? "..." : "Continue as Guest"}
          </button>
          <div style={{fontSize:".65rem",color:"var(--t3)",marginTop:".4rem"}}>No account needed - some features limited</div>
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
