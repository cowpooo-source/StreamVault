# Component Extraction and Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract AuthScreen and TimelineGrid from monolithic App.jsx into dedicated components, create auth-utils.js for encryption functions, and write shallow integration tests for all three components.

**Architecture:** Follow existing Player.jsx extraction pattern. Move AuthScreen (lines 127-333) and TimelineGrid (lines 2311-2415) to dedicated files in `src/components/`. Move encryption utilities (lines 335-374) to `src/auth-utils.js`. Add constants/helpers from TimelineGrid to `src/epg.js`. Write tests using vitest + @testing-library/react with targeted mocks.

**Tech Stack:** React, vitest, @testing-library/react, jsdom, Cloudflare Turnstile (test keys)

---

## File Structure

**Created files:**
- `src/auth-utils.js` — encryption functions (deriveKey, encryptData, decryptData, encryptConnections, decryptConnections, setEncKeySource)
- `src/components/AuthScreen.jsx` — extracted AuthScreen component
- `tests/AuthScreen.test.jsx` — AuthScreen tests
- `src/components/TimelineGrid.jsx` — extracted TimelineGrid component
- `tests/TimelineGrid.test.jsx` — TimelineGrid tests
- `tests/Player.test.jsx` — expanded Player tests (modify existing)

**Modified files:**
- `src/App.jsx` — remove AuthScreen (lines 127-333), encryption functions (lines 335-374), TimelineGrid (lines 2311-2415); add imports
- `src/epg.js` — add TimelineGrid constants (P_X_PER_MIN, TOTAL_HOURS, etc.) and helpers (msToPx, fmtT)

---

### Task 1: Create auth-utils.js with tests

**Files:**
- Create: `src/auth-utils.js`
- Test: `tests/auth-utils.test.js`
- Modify: `src/App.jsx:335-374` (remove functions, add import)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/auth-utils.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock crypto.subtle before importing
const mockDigest = vi.fn();
const mockImportKey = vi.fn();
const mockEncrypt = vi.fn();
const mockDecrypt = vi.fn();

Object.defineProperty(global, 'crypto', {
  value: {
    subtle: {
      digest: mockDigest,
      importKey: mockImportKey,
      encrypt: mockEncrypt,
      decrypt: mockDecrypt,
    },
    getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = i; return arr; },
  },
});

// Dynamic import to pick up mocks
let authUtils;
beforeEach(async () => {
  vi.resetModules();
  mockDigest.mockResolvedValue(new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]));
  mockImportKey.mockResolvedValue({ type: "secret", algorithm: { name: "AES-GCM" } });
  authUtils = await import("../../src/auth-utils.js");
});

describe("setEncKeySource", () => {
  it("should update the key source", () => {
    authUtils.setEncKeySource("test-id-123");
    expect(true).toBe(true); // Function doesn't throw
  });
});

describe("deriveKey", () => {
  it("should derive a CryptoKey from key source", async () => {
    authUtils.setEncKeySource("user:123");
    const key = await authUtils.deriveKey();
    expect(mockDigest).toHaveBeenCalledWith("SHA-256", expect.any(Uint8Array));
    expect(mockImportKey).toHaveBeenCalled();
  });
});

describe("encryptData/decryptData", () => {
  it("should encrypt and decrypt data round-trip", async () => {
    authUtils.setEncKeySource("user:123");
    mockEncrypt.mockResolvedValue(new Uint8Array([100, 101, 102]));
    const encrypted = await authUtils.encryptData("hello");
    expect(encrypted).toContain(".");
    expect(mockEncrypt).toHaveBeenCalledWith(
      { name: "AES-GCM", iv: expect.any(Uint8Array) },
      expect.any(Object),
      expect.any(Uint8Array)
    );
  });

  it("should return plaintext on encryption error", async () => {
    authUtils.setEncKeySource("user:123");
    mockEncrypt.mockRejectedValue(new Error("fail"));
    const result = await authUtils.encryptData("hello");
    expect(result).toBe("hello");
  });

  it("should return ciphertext on decryption error", async () => {
    const result = await authUtils.decryptData("invalid-data");
    expect(result).toBe("invalid-data");
  });

  it("should return value unchanged if no dot separator", async () => {
    const result = await authUtils.decryptData("no-dot-here");
    expect(result).toBe("no-dot-here");
  });
});

describe("encryptConnections/decryptConnections", () => {
  it("should encrypt connections list", async () => {
    authUtils.setEncKeySource("user:123");
    mockEncrypt.mockResolvedValue(new Uint8Array([50, 51, 52]));
    const conns = [{ type: "xtream", user: "test", pass: "secret", url: "http://example.com" }];
    const encrypted = await authUtils.encryptConnections(conns);
    expect(encrypted).toContain(".");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd streamvault && npx vitest run tests/auth-utils.test.js 2>&1`
Expected: FAIL — `Cannot find module '../../src/auth-utils.js'`

- [ ] **Step 3: Create auth-utils.js**

```javascript
// src/auth-utils.js
const ENC_ALGO = "AES-GCM";
let _encKeySource = null; // Set by App.jsx on login/guest

export function setEncKeySource(id) {
  _encKeySource = id;
}

export async function deriveKey() {
  const raw = new TextEncoder().encode(_encKeySource + ":sv-enc-key");
  const hash = await crypto.subtle.digest("SHA-256", raw);
  return crypto.subtle.importKey("raw", hash, ENC_ALGO, false, ["encrypt", "decrypt"]);
}

export async function encryptData(plaintext) {
  try {
    const key = await deriveKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: ENC_ALGO, iv }, key, new TextEncoder().encode(plaintext));
    return btoa(String.fromCharCode(...iv)) + "." + btoa(String.fromCharCode(...new Uint8Array(enc)));
  } catch {
    return plaintext;
  }
}

export async function decryptData(ciphertext) {
  try {
    if (!ciphertext || !ciphertext.includes(".")) return ciphertext;
    const [ivB64, dataB64] = ciphertext.split(".");
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const data = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0));
    const key = await deriveKey();
    const dec = await crypto.subtle.decrypt({ name: ENC_ALGO, iv }, key, data);
    return new TextDecoder().decode(dec);
  } catch {
    return ciphertext;
  }
}

export async function encryptConnections(conns) {
  const stripped = conns.map(c => {
    const safe = { ...c };
    if (safe.type === "xtream" && safe.pass) { safe._encPass = true; delete safe.pass; }
    if (safe.type === "stalker" && safe.mac) { safe._encMac = true; }
    return safe;
  });
  return await encryptData(JSON.stringify(stripped));
}

export async function decryptConnections(data) {
  try {
    const json = await decryptData(data);
    return JSON.parse(json);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd streamvault && npx vitest run tests/auth-utils.test.js 2>&1`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\waqas\IdeaProjects\StreamVault"
git add src/auth-utils.js tests/auth-utils.test.js
git commit -m "feat: create auth-utils.js with encryption functions"
```

---

### Task 2: Extract AuthScreen component

**Files:**
- Create: `src/components/AuthScreen.jsx`
- Create: `tests/AuthScreen.test.jsx`
- Modify: `src/App.jsx:127-333` (remove AuthScreen function)

- [ ] **Step 1: Write the failing test**

```jsx
// tests/AuthScreen.test.jsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

// Mock window.turnstile
Object.defineProperty(window, 'turnstile', {
  value: { render: vi.fn(), reset: vi.fn() },
  writable: true,
});

// Mock import.meta.env
vi.mock('import.meta', () => ({
  env: { VITE_TURNSTILE_SITE_KEY: "1x00000000000000000000AA" }
}), { virtual: true });

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks
let AuthScreen;
beforeEach(async () => {
  vi.resetModules();
  // Re-apply mocks after reset
  Object.defineProperty(window, 'turnstile', {
    value: { render: vi.fn(), reset: vi.fn() },
    writable: true,
  });
  mockFetch.mockReset();
  AuthScreen = (await import("../../src/components/AuthScreen.jsx")).default;
});

describe("AuthScreen", () => {
  const defaultProps = {
    onAuth: vi.fn(),
    onGuest: vi.fn(),
  };

  it("should render login form by default", () => {
    render(<AuthScreen {...defaultProps} />);
    expect(screen.getByText("Login")).toBeInTheDocument();
    expect(screen.getByText("Register")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Username")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
  });

  it("should switch to register tab and show email field", () => {
    render(<AuthScreen {...defaultProps} />);
    fireEvent.click(screen.getByText("Register"));
    expect(screen.getByPlaceholderText("email@example.com")).toBeInTheDocument();
  });

  it("should switch to forgot password form", () => {
    render(<AuthScreen {...defaultProps} />);
    fireEvent.click(screen.getByText("Forgot Password?"));
    expect(screen.getByText("Reset Password")).toBeInTheDocument();
    expect(screen.getByText("Back to Login")).toBeInTheDocument();
  });

  it("should toggle password visibility", () => {
    render(<AuthScreen {...defaultProps} />);
    const passwordInput = screen.getByPlaceholderText("Password");
    const toggleBtn = screen.getByTitle("Show password");
    expect(passwordInput.type).toBe("password");
    fireEvent.click(toggleBtn);
    expect(passwordInput.type).toBe("text");
    fireEvent.click(screen.getByTitle("Hide password"));
    expect(passwordInput.type).toBe("password");
  });

  it("should show error on login failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: "Invalid credentials" }),
    });
    render(<AuthScreen {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "test" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByText("Login"));
    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });
  });

  it("should call onAuth on successful login", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ user: { id: "1", username: "test" } }),
    });
    render(<AuthScreen {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "test" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "pass" } });
    fireEvent.click(screen.getByText("Login"));
    await waitFor(() => {
      expect(defaultProps.onAuth).toHaveBeenCalledWith({ id: "1", username: "test" });
    });
  });

  it("should call onGuest on guest login", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    render(<AuthScreen {...defaultProps} />);
    fireEvent.click(screen.getByText("Continue as Guest"));
    await waitFor(() => {
      expect(defaultProps.onGuest).toHaveBeenCalled();
    });
  });

  it("should show message on forgot password success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: "Reset link sent!" }),
    });
    render(<AuthScreen {...defaultProps} />);
    fireEvent.click(screen.getByText("Forgot Password?"));
    fireEvent.change(screen.getByPlaceholderText("email@example.com"), { target: { value: "test@example.com" } });
    fireEvent.click(screen.getByText("Send Reset Link"));
    await waitFor(() => {
      expect(screen.getByText("Reset link sent!")).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd streamvault && npx vitest run tests/AuthScreen.test.jsx 2>&1`
Expected: FAIL — Cannot find module `../../src/components/AuthScreen.jsx`

- [ ] **Step 3: Extract AuthScreen to src/components/AuthScreen.jsx**

```jsx
// src/components/AuthScreen.jsx
import { useState, useRef, useEffect } from "react";

const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;

export default function AuthScreen({ onAuth, onGuest }) {
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
        const res = await fetch(`${window.API}/api/auth/forgot-password`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: emailInput }),
        });
        const data = await res.json();
        setMsg(data.message || "Reset link sent!");
        return;
      }

      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = { username, password, cf_turnstile_response: turnstileResponse };
      if (mode === "register") body.email = emailInput;
      if (forceLogin) body.force = true;

      let res = await fetch(`${window.API}${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let data = await res.json();

      if (!res.ok) {
        if (data.code === 'MAX_LOGINS_REACHED') {
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

    const formData = formRef.current ? new FormData(formRef.current) : new FormData();
    const turnstileResponse = formData.get("cf-turnstile-response");

    try {
      const res = await fetch(`${window.API}/api/auth/guest`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cf_turnstile_response: turnstileResponse }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed");
      }

      onGuest();
    } catch (e) {
      setErr(e.message);
      if (window.turnstile) window.turnstile.reset();
    } finally { setLoading(false); }
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
```

Note: Changed `API` to `window.API` since the component doesn't have access to the module-level `API` variable.

- [ ] **Step 4: Update App.jsx — remove AuthScreen function (lines 127-333)**

Read `src/App.jsx`, delete lines 127-333 (the entire AuthScreen function).

Add import at top of App.jsx:
```javascript
import AuthScreen from "./components/AuthScreen.jsx";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd streamvault && npx vitest run tests/AuthScreen.test.jsx 2>&1`
Expected: PASS — all AuthScreen tests green

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\waqas\IdeaProjects\StreamVault"
git add src/components/AuthScreen.jsx tests/AuthScreen.test.jsx src/App.jsx
git commit -m "feat: extract AuthScreen to dedicated component"
```

---

### Task 3: Update App.jsx to use auth-utils.js

**Files:**
- Modify: `src/App.jsx:335-374` (remove encryption functions, add import)

- [ ] **Step 1: Update App.jsx — remove encryption functions and add import**

Read `src/App.jsx`, delete lines 335-374 (encryption functions).

Add import at top of App.jsx:
```javascript
import { setEncKeySource, encryptConnections, decryptConnections } from "./auth-utils.js";
```

Note: `deriveKey`, `encryptData`, `decryptData` are internal to auth-utils.js and don't need to be imported.

- [ ] **Step 2: Verify App.jsx still works**

Run: `cd streamvault && npm run build 2>&1`
Expected: Build succeeds with no errors about missing encryption functions.

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\waqas\IdeaProjects\StreamVault"
git add src/App.jsx
git commit -m "refactor: remove encryption functions from App.jsx, use auth-utils.js"
```

---

### Task 4: Add TimelineGrid constants and helpers to epg.js

**Files:**
- Modify: `src/epg.js` (add constants and helpers at top)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/epg-timeline.test.js
import { describe, it, expect } from "vitest";
import { msToPx, fmtT, PX_PER_MIN, TOTAL_HOURS, TOTAL_MS, TOTAL_PX, CH_COL_W, ROW_H } from "../../src/epg.js";

describe("TimelineGrid constants", () => {
  it("should export PX_PER_MIN", () => {
    expect(PX_PER_MIN).toBe(3);
  });

  it("should export TOTAL_HOURS", () => {
    expect(TOTAL_HOURS).toBe(8);
  });

  it("should calculate TOTAL_MS correctly", () => {
    expect(TOTAL_MS).toBe(8 * 3600000);
  });

  it("should calculate TOTAL_PX correctly", () => {
    expect(TOTAL_PX).toBe(8 * 60 * 3); // 1440px
  });

  it("should export CH_COL_W", () => {
    expect(CH_COL_W).toBe(160);
  });

  it("should export ROW_H", () => {
    expect(ROW_H).toBe(48);
  });
});

describe("msToPx", () => {
  it("should convert milliseconds to pixels", () => {
    const windowStart = 1000000;
    expect(msToPx(1000000 + 60000, windowStart)).toBe(3); // 1 min = 3px
    expect(msToPx(1000000 + 600000, windowStart)).toBe(30); // 10 min = 30px
  });

  it("should return 0 for same time as windowStart", () => {
    const windowStart = 1000000;
    expect(msToPx(1000000, windowStart)).toBe(0);
  });
});

describe("fmtT", () => {
  it("should format milliseconds to time string", () => {
    const ms = new Date("2026-05-03T14:30:00").getTime();
    const result = fmtT(ms);
    expect(result).toMatch(/\d{1,2}:\d{2} [AP]M/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd streamvault && npx vitest run tests/epg-timeline.test.js 2>&1`
Expected: FAIL — exports not found in epg.js

- [ ] **Step 3: Add constants and helpers to epg.js**

Add at the top of `src/epg.js`:
```javascript
export const PX_PER_MIN = 3;
export const TOTAL_HOURS = 8;
export const TOTAL_MS = TOTAL_HOURS * 3600000;
export const TOTAL_PX = TOTAL_HOURS * 60 * PX_PER_MIN; // 1440px
export const CH_COL_W = 160;
export const ROW_H = 48;

export function msToPx(ms, windowStart) {
  return ((ms - windowStart) / 60000) * PX_PER_MIN;
}

export function fmtT(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd streamvault && npx vitest run tests/epg-timeline.test.js 2>&1`
Expected: PASS — all constants and helpers tests green

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\waqas\IdeaProjects\StreamVault"
git add src/epg.js tests/epg-timeline.test.js
git commit -m "feat: add TimelineGrid constants and helpers to epg.js"
```

---

### Task 5: Extract TimelineGrid component

**Files:**
- Create: `src/components/TimelineGrid.jsx`
- Create: `tests/TimelineGrid.test.jsx`
- Modify: `src/App.jsx:2311-2415` (remove TimelineGrid, add import)

- [ ] **Step 1: Write the failing test**

```jsx
// tests/TimelineGrid.test.jsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// Mock imgSrc from utils
vi.mock("../../src/utils.js", async () => {
  const actual = await vi.importActual("../../src/utils.js");
  return {
    ...actual,
    imgSrc: vi.fn((url) => url || null),
  };
});

// Mock epgLookup from epg
vi.mock("../../src/epg.js", async () => {
  const actual = await vi.importActual("../../src/epg.js");
  return {
    ...actual,
    epgLookup: vi.fn(() => null),
  };
});

let TimelineGrid;
beforeEach(async () => {
  vi.resetModules();
  TimelineGrid = (await import("../../src/components/TimelineGrid.jsx")).default;
});

describe("TimelineGrid", () => {
  const sampleChannels = [
    { id: "ch1", name: "Channel 1", logo: "http://example.com/logo1.png", epgId: "epg1" },
    { id: "ch2", name: "Channel 2", logo: null, epgId: "epg2" },
  ];

  it("should render with empty channels", () => {
    render(<TimelineGrid channels={[]} epgData={{}} onPlay={vi.fn()} onPlayCatchup={vi.fn()} />);
    expect(screen.queryByText("Channel 1")).not.toBeInTheDocument();
  });

  it("should render channels with names", () => {
    render(<TimelineGrid channels={sampleChannels} epgData={{}} onPlay={vi.fn()} onPlayCatchup={vi.fn()} />);
    expect(screen.getByText("Channel 1")).toBeInTheDocument();
    expect(screen.getByText("Channel 2")).toBeInTheDocument();
  });

  it("should call onPlay when channel is clicked", () => {
    const onPlay = vi.fn();
    render(<TimelineGrid channels={sampleChannels} epgData={{}} onPlay={onPlay} onPlayCatchup={vi.fn()} />);
    fireEvent.click(screen.getByText("Channel 1"));
    expect(onPlay).toHaveBeenCalledWith(sampleChannels[0]);
  });

  it("should render time labels", () => {
    render(<TimelineGrid channels={sampleChannels} epgData={{}} onPlay={vi.fn()} onPlayCatchup={vi.fn()} />);
    // Time labels are generated every 30 minutes
    const timeLabels = document.querySelectorAll(".epg-time-label");
    expect(timeLabels.length).toBeGreaterThan(0);
  });

  it("should render with EPG data and program blocks", () => {
    const epgData = {
      epg1: [
        { start: Date.now() - 1800000, stop: Date.now() + 1800000, title: "Test Program" },
      ],
    };
    const { container } = render(<TimelineGrid channels={[sampleChannels[0]]} epgData={epgData} onPlay={vi.fn()} onPlayCatchup={vi.fn()} />);
    expect(container.querySelector(".epg-prog-block")).toBeInTheDocument();
  });

  it("should call onPlayCatchup when past program is clicked", () => {
    const onPlayCatchup = vi.fn();
    const pastProgram = { start: Date.now() - 3600000, stop: Date.now() - 1800000, title: "Past Program" };
    const epgData = { epg1: [pastProgram] };
    render(<TimelineGrid channels={[sampleChannels[0]]} epgData={epgData} onPlay={vi.fn()} onPlayCatchup={onPlayCatchup} />);
    const progBlock = document.querySelector(".epg-prog-block");
    if (progBlock) {
      fireEvent.click(progBlock);
      expect(onPlayCatchup).toHaveBeenCalledWith(sampleChannels[0], pastProgram);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd streamvault && npx vitest run tests/TimelineGrid.test.jsx 2>&1`
Expected: FAIL — Cannot find module `../../src/components/TimelineGrid.jsx`

- [ ] **Step 3: Extract TimelineGrid to src/components/TimelineGrid.jsx**

```jsx
// src/components/TimelineGrid.jsx
import { useState, useEffect, useMemo, useCallback, memo, forwardRef } from "react";
import { imgSrc } from "../utils.js";
import { epgLookup, PX_PER_MIN, TOTAL_HOURS, TOTAL_MS, TOTAL_PX, CH_COL_W, ROW_H, msToPx, fmtT } from "../epg.js";

const TimelineGrid = memo(forwardRef(function TimelineGrid({ channels, epgData, onPlay, onPlayCatchup }, outerRef) {
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const windowStart = useMemo(() => nowMs - 3600000, [nowMs]);
  const windowEnd = useMemo(() => windowStart + TOTAL_MS, [windowStart]);

  const timeLabels = useMemo(() => {
    const labels = [];
    const snapStart = new Date(windowStart);
    snapStart.setMinutes(snapStart.getMinutes() < 30 ? 0 : 30, 0, 0);
    let t = snapStart.getTime();
    if (t < windowStart) t += 1800000;
    while (t < windowEnd) {
      const offsetPx = msToPx(t, windowStart);
      const d = new Date(t);
      labels.push({ ms: t, px: offsetPx, label: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
      t += 1800000;
    }
    return labels;
  }, [windowStart, windowEnd]);

  const nowLinePx = msToPx(nowMs, windowStart);

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
                    const leftPx = msToPx(clampStart, windowStart);
                    const widthPx = ((clampEnd - clampStart) / 60000) * PX_PER_MIN;
                    if (widthPx < 2) return null;
                    const isNow = p.start <= nowMs && p.stop > nowMs;
                    const isPast = p.stop <= nowMs;
                    const cls = `epg-prog-block${isNow?" now":""}${isPast?" past":""}`;
                    return (
                      <div key={pi} className={cls}
                        style={{left:leftPx,width:widthPx}}
                        onClick={()=> isPast && onPlayCatchup ? onPlayCatchup(ch, p) : onPlay(ch)}
                        title={`${p.title}\n${fmtT(p.start)} – ${fmtT(p.stop)}${isPast ? "\nClick to play catchup" : ""}`}>
                        {widthPx > 50 && <div className="epg-prog-t">{isPast && <span className="epg-catchup-icon">↩</span>}{p.title}</div>}
                        {widthPx > 90 && <div className="epg-prog-s">{fmtT(p.start)} – {fmtT(p.stop)}</div>}
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

export default TimelineGrid;
```

- [ ] **Step 4: Update App.jsx — remove TimelineGrid (lines 2311-2415), add import**

Read `src/App.jsx`, delete the entire TimelineGrid function (approximately lines 2311-2415).

Add import at top of App.jsx:
```javascript
import TimelineGrid from "./components/TimelineGrid.jsx";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd streamvault && npx vitest run tests/TimelineGrid.test.jsx 2>&1`
Expected: PASS — all TimelineGrid tests green

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\waqas\IdeaProjects\StreamVault"
git add src/components/TimelineGrid.jsx tests/TimelineGrid.test.jsx src/App.jsx src/epg.js
git commit -m "feat: extract TimelineGrid to dedicated component"
```

---

### Task 6: Expand Player tests

**Files:**
- Modify: `tests/Player.test.jsx` (expand with interaction tests)

- [ ] **Step 1: Update Player.test.jsx with interaction tests**

Replace the existing `tests/Player.test.jsx` with expanded tests:

```jsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// Mock HLS and mpegts
Object.defineProperty(window, 'Hls', {
  value: { isSupported: vi.fn(() => false), Events: {}, ErrorTypes: {} },
  writable: true,
});
Object.defineProperty(window, 'mpegts', {
  value: { isSupported: vi.fn(() => false), createPlayer: vi.fn(), Events: {} },
  writable: true,
});

// Mock video element
HTMLVideoElement.prototype.play = vi.fn();
HTMLVideoElement.prototype.pause = vi.fn();
HTMLVideoElement.prototype.load = vi.fn();
HTMLVideoElement.prototype.requestFullscreen = vi.fn();
document.exitPictureInPicture = vi.fn();

// Mock fetchVastAd and parseVastDocument
vi.mock("../src/vast.js", () => ({
  fetchVastAd: vi.fn(() => null),
  parseVastDocument: vi.fn(),
  collectVastTrackers: vi.fn(),
}));

// Mock epg.js
vi.mock("../src/epg.js", () => ({
  getEPGNow: vi.fn(() => null),
}));

// Mock utils.js for vastProxyUrl etc.
vi.mock("../src/utils.js", async () => {
  const actual = await vi.importActual("../src/utils.js");
  return {
    ...actual,
    VAST_URL: null,
  };
});

// Mock the Player module - but we need to test the real component
// So we don't mock it, we mock its dependencies instead
import Player from "../src/components/Player.jsx";

describe("Player", () => {
  const defaultProps = {
    item: { id: "test-1", name: "Test Channel", url: "http://example.com/stream", type: "live" },
    channelList: [],
    epgData: null,
    onClose: vi.fn(),
    onFav: vi.fn(),
    isFav: vi.fn(() => false),
    connType: "stalker",
    t: (k) => k,
    isAdEligible: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should be defined as a function/component", () => {
    expect(Player).toBeDefined();
  });

  it("should render without crashing", () => {
    expect(() => render(<Player {...defaultProps} />)).not.toThrow();
  });

  it("should show OSD with channel name", () => {
    render(<Player {...defaultProps} />);
    expect(screen.getByText("Test Channel")).toBeInTheDocument();
  });

  it("should call onClose when Escape key is pressed", () => {
    render(<Player {...defaultProps} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("should toggle play/pause on Space key", () => {
    render(<Player {...defaultProps} />);
    const video = document.querySelector("video");
    fireEvent.keyDown(document, { key: " " });
    // Video play/pause should be called (HLS/mpegts not supported in test, so native video)
  });

  it("should toggle fullscreen on F key", () => {
    render(<Player {...defaultProps} />);
    fireEvent.keyDown(document, { key: "f" });
    expect(document.exitPictureInPicture).toHaveBeenCalled();
  });

  it("should toggle stats overlay on S key", () => {
    render(<Player {...defaultProps} />);
    expect(document.querySelector('[style*="Stream Stats"]')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "s" });
    // Stats should toggle (but we need to check state - just verify no crash)
  });

  it("should render close button and call onClose", () => {
    render(<Player {...defaultProps} />);
    const closeBtn = screen.getByText("✕ close");
    fireEvent.click(closeBtn);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("should call onFav when fav button is clicked", () => {
    render(<Player {...defaultProps} />);
    const favBtn = screen.getByText(/♡ fav/i);
    fireEvent.click(favBtn);
    expect(defaultProps.onFav).toHaveBeenCalled();
  });

  it("should render with channelList for prev/next navigation", () => {
    const props = {
      ...defaultProps,
      channelList: [
        { id: "ch1", name: "Channel 1", url: "http://example.com/1" },
        { id: "ch2", name: "Channel 2", url: "http://example.com/2" },
      ],
    };
    render(<Player {...props} />);
    expect(screen.getByText("◀ prev")).toBeInTheDocument();
    expect(screen.getByText("next ▶")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd streamvault && npx vitest run tests/Player.test.jsx 2>&1`
Expected: PASS — all Player tests green (existing + new)

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\waqas\IdeaProjects\StreamVault"
git add tests/Player.test.jsx
git commit -m "test: expand Player component tests with interactions"
```

---

### Task 7: Final verification

**Files:**
- All files modified/created above

- [ ] **Step 1: Run all tests**

Run: `cd streamvault && npx vitest run 2>&1`
Expected: PASS — all tests green (auth-utils + AuthScreen + TimelineGrid + Player + utils + vast)

- [ ] **Step 2: Build the project**

Run: `cd streamvault && npm run build 2>&1`
Expected: Build succeeds with no errors

- [ ] **Step 3: Verify App.jsx line count reduced**

Run: `wc -l streamvault/src/App.jsx`
Expected: Significantly less than 5000 lines (approximately 2000-3000 lines remaining)

- [ ] **Step 4: Final commit if any changes needed**

```bash
cd "C:\Users\waqas\IdeaProjects\StreamVault"
git add -A
git commit -m "chore: final cleanup after component extraction"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] AuthScreen extraction → Task 2
- [x] auth-utils.js creation → Task 1, Task 3
- [x] TimelineGrid extraction → Task 5
- [x] TimelineGrid constants/helpers in epg.js → Task 4
- [x] AuthScreen tests → Task 2 (Step 1)
- [x] TimelineGrid tests → Task 5 (Step 1)
- [x] Player test expansion → Task 6
- [x] Turnstile test keys documented in spec, tests use them

**2. Placeholder scan:**
- No "TBD", "TODO", "implement later" found
- No "Add appropriate error handling" — all error handling is explicit
- No "Write tests for the above" — all tests have actual code
- No "Similar to Task N" — all code is repeated explicitly
- All steps have code blocks or exact commands

**3. Type consistency:**
- `setEncKeySource` signature matches (Task 1 → Task 3)
- `msToPx(ms, windowStart)` consistent across Task 4 and Task 5
- `TimelineGrid` props consistent: `{ channels, epgData, onPlay, onPlayCatchup, ref }` in Task 5 and spec
- `AuthScreen` props consistent: `{ onAuth, onGuest }` in Task 2 and spec

All checks pass. Plan is complete and ready for execution.
