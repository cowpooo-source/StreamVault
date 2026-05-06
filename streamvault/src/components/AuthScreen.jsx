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
  const formRef = useRef(null);
  const turnstileContainerRef = useRef(null);

  useEffect(() => {
    if (siteKey && window.turnstile && turnstileContainerRef.current) {
      turnstileContainerRef.current.innerHTML = "";
      try {
        window.turnstile.render(turnstileContainerRef.current, {
          sitekey: siteKey,
          theme: 'dark'
        });
      } catch (e) {
        console.error("Turnstile render error", e);
      }
    }
  }, [mode, siteKey]);

  async function submit(e) {
    e?.preventDefault();
    setErr(""); setMsg(""); setLoading(true);

    const formData = formRef.current ? new FormData(formRef.current) : new FormData();
    const turnstileResponse = formData.get("cf-turnstile-response");

    try {
      if (mode === "forgot") {
        if (!emailInput) throw new Error("Email is required");
        const res = await fetch(`${api}/api/auth/forgot-password`, {
          method: "POST", headers: { "Content-Type": "application/json" },
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

      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = { username, password, "cf_turnstile_response": turnstileResponse };
      if (mode === "register") body.email = emailInput;
      if (forceLogin) body.force = true;

      let res = await fetch(`${api}${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let data = await res.json();
      
      if (!res.ok) {
        if (data.code === 'MAX_LOGINS_REACHED') {
          // Reset turnstile as the token is now consumed
          if (window.turnstile) window.turnstile.reset();
          
          if (window.confirm("Max login reached. Do you want to force login which will logout previous user? (You will need to re-verify CAPTCHA)")) {
            setForceLogin(true);
            setErr("Please re-verify CAPTCHA and click Login again to force login.");
            return;
          } else {
            throw new Error(data.error || "Failed");
          }
        } else {
          throw new Error(data.error || "Failed");
        }
      }
      
      onAuth(data.user);
    } catch (e) {
      setErr(e.message);
      if (window.turnstile) window.turnstile.reset();
    }
    finally { setLoading(false); }
  }

  async function submitGuest(e) {
    e?.preventDefault();
    setErr(""); setMsg(""); setLoading(true);

    try {
      const res = await fetch(`${api}/api/auth/guest`, {
        method: "POST", headers: { "Content-Type": "application/json" },
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
                    {showPassword ? "🙈" : "👁"}
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
                <div 
                  ref={turnstileContainerRef}
                  style={{ marginBottom: "1rem", display: "flex", justifyContent: "center" }}
                ></div>
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
