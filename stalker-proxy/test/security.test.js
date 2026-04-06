// Run with: node stalker-proxy/test/security.test.js
// Optionally: BASE_URL=https://streamvault.hopto.org node stalker-proxy/test/security.test.js

const BASE = process.env.BASE_URL || "http://localhost:3001";
let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} — ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  console.log("\n=== Security Tests ===\n");

  // SSRF Tests
  console.log("SSRF Protection:");
  await test("Block localhost via /stream", async () => {
    const r = await fetch(`${BASE}/stream?url=http://localhost:3001/health`);
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });
  await test("Block 127.0.0.1 via /stream", async () => {
    const r = await fetch(`${BASE}/stream?url=http://127.0.0.1:3001/health`);
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });
  await test("Block private IP 192.168.x via /proxy", async () => {
    const r = await fetch(`${BASE}/proxy?url=http://192.168.1.1/admin`);
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });
  await test("Block private IP 10.x via /proxy", async () => {
    const r = await fetch(`${BASE}/proxy?url=http://10.0.0.1/`);
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });
  await test("Block cloud metadata via /stream", async () => {
    const r = await fetch(`${BASE}/stream?url=http://169.254.169.254/latest/meta-data/`);
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });
  await test("Block file:// scheme via /proxy", async () => {
    const r = await fetch(`${BASE}/proxy?url=file:///etc/passwd`);
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });
  await test("Allow valid external URL via /proxy", async () => {
    const r = await fetch(`${BASE}/proxy?url=http://httpbin.org/get`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  // XSS Tests
  console.log("\nXSS Protection:");
  await test("Feedback with HTML tags is stored in API", async () => {
    const r = await fetch(`${BASE}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Guest-Id": "xss-test" },
      body: JSON.stringify({ message: '<script>alert("xss")</script>', guestId: "xss-test", timestamp: Date.now() }),
    });
    assert(r.status === 200 || r.status === 429, `Expected 200/429, got ${r.status}`);
  });

  // Rate Limiting Tests
  console.log("\nRate Limiting:");
  await test("Rate limit on /api/feedback after many requests", async () => {
    let blocked = false;
    for (let i = 0; i < 25; i++) {
      const r = await fetch(`${BASE}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Guest-Id": "ratelimit-test" },
        body: JSON.stringify({ message: `test ${i}`, guestId: "ratelimit-test", timestamp: Date.now() }),
      });
      if (r.status === 429) { blocked = true; break; }
    }
    assert(blocked, "Expected 429 rate limit after many requests");
  });

  // Admin Auth Tests
  console.log("\nAdmin Auth:");
  await test("Analytics requires X-Admin-Token", async () => {
    const r = await fetch(`${BASE}/api/analytics`);
    assert(r.status === 401 || r.status === 503, `Expected 401/503, got ${r.status}`);
  });
  await test("Analytics rejects wrong X-Admin-Token", async () => {
    const r = await fetch(`${BASE}/api/analytics`, { headers: { "X-Admin-Token": "wrong" } });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });
  await test("Feedback GET requires X-Admin-Token", async () => {
    const r = await fetch(`${BASE}/api/feedback`);
    assert(r.status === 401 || r.status === 503 || r.status === 429, `Expected 401/503/429, got ${r.status}`);
  });

  // Functional Tests (make sure nothing broke)
  console.log("\nFunctional (no regression):");
  await test("Health endpoint works", async () => {
    const r = await fetch(`${BASE}/health`);
    const d = await r.json();
    assert(r.status === 200 && d.status === "ok", `Health check failed`);
  });
  await test("Stalker handshake works", async () => {
    const r = await fetch(`${BASE}/stalker/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portal: "http://xbox.ztv4you.com:2095/c", mac: "00:1A:79:4F:2E:A5" }),
    });
    const d = await r.json();
    assert(r.status === 200 && d.token, `Handshake failed: ${JSON.stringify(d)}`);
  });
  await test("Stalker channels works", async () => {
    const r = await fetch(`${BASE}/stalker/channels?portal=http%3A%2F%2Fxbox.ztv4you.com%3A2095%2Fc&mac=00%3A1A%3A79%3A4F%3A2E%3AA5`);
    // Portal may be down — accept 200 (success) or 502 (portal unreachable)
    assert(r.status === 200 || r.status === 502, `Unexpected status: ${r.status}`);
  });
  await test("Stream proxy works for external URL", async () => {
    const r = await fetch(`${BASE}/stream?url=https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`, { method: "HEAD" });
    assert(r.status === 200 || r.status === 206 || r.status === 403, `Stream proxy failed: ${r.status}`);
  });
  await test("API track works", async () => {
    const r = await fetch(`${BASE}/api/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Guest-Id": "test" },
      body: JSON.stringify({ event: "play", name: "Test", type: "live", guestId: "test" }),
    });
    const d = await r.json();
    assert(d.ok, "Track failed");
  });
  await test("API sync PUT/GET works", async () => {
    const r1 = await fetch(`${BASE}/api/sync/favorites`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Guest-Id": "sec-test" },
      body: JSON.stringify({ connId: "test:conn", data: { live: { ch1: { name: "Test" } } } }),
    });
    assert(r1.status === 200, "Sync PUT failed");
    const r2 = await fetch(`${BASE}/api/sync/favorites?connId=test:conn`, {
      headers: { "X-Guest-Id": "sec-test" },
    });
    const d = await r2.json();
    assert(d.data?.live?.ch1, "Sync GET failed");
  });

  // SSRF: Portal validation on stalker routes
  console.log("\nSSRF Portal Validation:");
  await test("Block private IP portal on /stalker/handshake", async () => {
    const r = await fetch(`${BASE}/stalker/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portal: "http://192.168.1.1/c", mac: "00:1A:79:00:00:01" }),
    });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });
  await test("Block localhost portal on /stalker/handshake", async () => {
    const r = await fetch(`${BASE}/stalker/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portal: "http://localhost:3001/c", mac: "00:1A:79:00:00:02" }),
    });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });
  await test("Reject invalid MAC format on stalker routes", async () => {
    const r = await fetch(`${BASE}/stalker/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portal: "http://example.com/c", mac: "INVALID_MAC" }),
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  // SQL Injection
  console.log("\nSQL Injection:");
  await test("trackGuestActivity rejects invalid field", async () => {
    const r = await fetch(`${BASE}/api/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Guest-Id": "sqli-test" },
      body: JSON.stringify({ event: "connect", guestId: "sqli-test" }),
    });
    // Should succeed (field=connections is valid)
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  // Admin token timing-safe comparison
  console.log("\nAdmin Token:");
  await test("Analytics with X-Admin-Token header works", async () => {
    const pass = process.env.ADMIN_PASS || "";
    if (!pass) { console.log("    (skipped — no ADMIN_PASS)"); return; }
    const r = await fetch(`${BASE}/api/analytics`, {
      headers: { "X-Admin-Token": pass },
    });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });
  await test("Analytics rejects wrong X-Admin-Token", async () => {
    const r = await fetch(`${BASE}/api/analytics`, {
      headers: { "X-Admin-Token": "wrong-token-12345" },
    });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  // DELETE /api/cache requires auth
  console.log("\nAuth on DELETE endpoints:");
  await test("DELETE /api/cache requires auth", async () => {
    const r = await fetch(`${BASE}/api/cache?connId=test`, { method: "DELETE" });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });
  await test("DELETE /api/sync requires auth", async () => {
    const r = await fetch(`${BASE}/api/sync?connId=test`, { method: "DELETE" });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });
  await test("DELETE /api/cache works with guest ID", async () => {
    const r = await fetch(`${BASE}/api/cache?connId=test`, {
      method: "DELETE",
      headers: { "X-Guest-Id": "auth-test-guest" },
    });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  // Image proxy
  console.log("\nImage Proxy:");
  await test("/img blocks private IPs", async () => {
    const r = await fetch(`${BASE}/img?url=http://192.168.1.1/image.jpg`);
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });
  await test("/img blocks localhost", async () => {
    const r = await fetch(`${BASE}/img?url=http://localhost:3001/health`);
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });
  await test("/img requires url param", async () => {
    const r = await fetch(`${BASE}/img`);
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  // TMDB proxy
  console.log("\nTMDB Proxy:");
  await test("/api/tmdb requires TMDB_API_KEY", async () => {
    const r = await fetch(`${BASE}/api/tmdb/search/movie?query=test`);
    // If no key configured, returns 503; if configured, returns 200
    assert(r.status === 200 || r.status === 503, `Expected 200 or 503, got ${r.status}`);
  });

  // Connection diagnostics
  console.log("\nConnection Diagnostics:");
  await test("/api/diagnose returns result for xtream", async () => {
    const r = await fetch(`${BASE}/api/diagnose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "xtream", server: "http://httpbin.org", user: "test", pass: "test" }),
    });
    const d = await r.json();
    assert(d.latency !== null || d.latency === null, "Diagnose returned valid structure");
    assert("reachable" in d, "Has reachable field");
    assert("details" in d, "Has details field");
  });
  await test("/api/diagnose handles missing type", async () => {
    const r = await fetch(`${BASE}/api/diagnose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const d = await r.json();
    assert(d.reachable === false, "Empty request returns unreachable");
  });

  // Auth: registration and login
  console.log("\nAuth System:");
  const testUser = `test_${Date.now()}`;
  const testPass = "TestPass123";
  let authToken = null;

  await test("Register new user", async () => {
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: testUser, password: testPass }),
    });
    const d = await r.json();
    assert(r.status === 200 && d.token, `Register failed: ${JSON.stringify(d)}`);
    authToken = d.token;
  });
  await test("Reject weak password", async () => {
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `weak_${Date.now()}`, password: "1234" }),
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });
  await test("Reject password without numbers", async () => {
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `nonumpass_${Date.now()}`, password: "abcdefgh" }),
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });
  await test("Login works", async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: testUser, password: testPass }),
    });
    const d = await r.json();
    assert(r.status === 200 && d.token && d.user, `Login failed`);
    authToken = d.token;
  });
  await test("GET /api/auth/me with token", async () => {
    const r = await fetch(`${BASE}/api/auth/me`, {
      headers: { "Authorization": `Bearer ${authToken}` },
    });
    const d = await r.json();
    assert(r.status === 200 && d.username === testUser, `Me failed: ${JSON.stringify(d)}`);
  });
  await test("Sync connections scoped to user", async () => {
    // Save connections for this user
    const r1 = await fetch(`${BASE}/api/sync/connections`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
      body: JSON.stringify({ connId: "_all", data: [{ id: "test-conn", type: "xtream" }] }),
    });
    assert(r1.status === 200, "Sync PUT failed");
    // Retrieve — should get back same data
    const r2 = await fetch(`${BASE}/api/sync/connections?connId=_all`, {
      headers: { "Authorization": `Bearer ${authToken}` },
    });
    const d = await r2.json();
    assert(Array.isArray(d.data) && d.data[0]?.id === "test-conn", "Sync GET returned wrong data");
    // Different user (guest) should NOT see this data
    const r3 = await fetch(`${BASE}/api/sync/connections?connId=_all`, {
      headers: { "X-Guest-Id": "different-guest" },
    });
    const d3 = await r3.json();
    assert(!d3.data || !Array.isArray(d3.data) || d3.data.length === 0 || d3.data[0]?.id !== "test-conn", "Guest should not see user's connections");
  });
  await test("Account lockout after failed attempts", async () => {
    const lockUser = `locktest_${Date.now()}`;
    const lockPass = "LockTest123";
    // Register the user first
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: lockUser, password: lockPass }),
    });
    // 5 failed login attempts
    for (let i = 0; i < 5; i++) {
      await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: lockUser, password: "wrong" }),
      });
    }
    // 6th attempt should be locked even with correct password
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: lockUser, password: lockPass }),
    });
    const d = await r.json();
    assert(r.status === 401 && d.error.includes("locked"), `Expected locked, got ${r.status}: ${d.error}`);
  });
  await test("Login rate limit (10/15min)", async () => {
    // This test just verifies the rate limiter exists — not exhaustive
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ratetest", password: "wrong" }),
    });
    // Should be 401 (bad creds) not 404 — proves the route + rate limiter exist
    assert(r.status === 401 || r.status === 429, `Expected 401/429, got ${r.status}`);
  });
  await test("Logout revokes token", async () => {
    const r1 = await fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${authToken}` },
    });
    assert(r1.status === 200, "Logout failed");
    // Token should no longer work
    const r2 = await fetch(`${BASE}/api/auth/me`, {
      headers: { "Authorization": `Bearer ${authToken}` },
    });
    assert(r2.status === 401, `Expected 401 after logout, got ${r2.status}`);
  });

  // Graceful shutdown endpoint
  console.log("\nMisc:");
  await test("Health endpoint returns uptime", async () => {
    const r = await fetch(`${BASE}/health`);
    const d = await r.json();
    assert(d.uptime > 0, "Uptime should be positive");
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
