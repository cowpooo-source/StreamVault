import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "http";

// We'll test the API by starting the actual Express app
// but with a test database
const TEST_PORT = 9876;
let server;
let baseUrl;

beforeAll(async () => {
  // Set test env before requiring the app
  process.env.PORT = TEST_PORT;
  process.env.CACHE_DB = require("path").join(__dirname, "test-api.db");
  process.env.ADMIN_PASS = "admintest";
  process.env.ADMIN_USER = "admin";
  process.env.JWT_SECRET = "api-test-secret";
  process.env.DEFAULT_ROLE = "regular";

  // Clean old test DB
  try { require("fs").unlinkSync(process.env.CACHE_DB); } catch {}

  baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  // Wait for server to be ready
  await new Promise((resolve, reject) => {
    // The app starts listening on require
    try {
      require("../src/index");
      // Give it a moment
      setTimeout(resolve, 500);
    } catch (e) {
      reject(e);
    }
  });
}, 10000);

afterAll(() => {
  try { require("fs").unlinkSync(process.env.CACHE_DB); } catch {}
  try { require("fs").unlinkSync(process.env.CACHE_DB + "-wal"); } catch {}
  try { require("fs").unlinkSync(process.env.CACHE_DB + "-shm"); } catch {}
});

async function api(path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function apiJson(path, body, token = null) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return api(path, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("API — Health", () => {
  it("GET /health returns ok", async () => {
    const { status, json } = await api("/health");
    expect(status).toBe(200);
    expect(json.status).toBe("ok");
  });
});

describe("API — Auth Registration", () => {
  it("registers a new user", async () => {
    const { status, json } = await apiJson("/api/auth/register", { username: "newuser", password: "pass1234" });
    expect(status).toBe(200);
    expect(json.token).toBeDefined();
    expect(json.user.username).toBe("newuser");
    expect(json.user.role).toBe("regular");
  });

  it("rejects duplicate username", async () => {
    const { status, json } = await apiJson("/api/auth/register", { username: "newuser", password: "pass1234" });
    expect(status).toBe(400);
    expect(json.error).toContain("already taken");
  });

  it("rejects short password", async () => {
    const { status, json } = await apiJson("/api/auth/register", { username: "shortpw", password: "ab" });
    expect(status).toBe(400);
  });
});

describe("API — Auth Login", () => {
  it("logs in with correct credentials", async () => {
    const { status, json } = await api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admintest" }),
    });
    expect(status).toBe(200);
    expect(json.token).toBeDefined();
    expect(json.user.role).toBe("admin");
  });

  it("rejects wrong password", async () => {
    const { status } = await apiJson("/api/auth/login", { username: "admin", password: "wrong" });
    expect(status).toBe(401);
  });

  it("rejects missing fields", async () => {
    const { status } = await apiJson("/api/auth/login", { username: "admin" });
    expect(status).toBe(400);
  });
});

describe("API — Auth Me", () => {
  it("returns user info with valid token", async () => {
    const login = await apiJson("/api/auth/login", { username: "admin", password: "admintest" });
    const { status, json } = await api("/api/auth/me", {
      headers: { "Authorization": `Bearer ${login.json.token}` },
    });
    expect(status).toBe(200);
    expect(json.username).toBe("admin");
    expect(json.role).toBe("admin");
  });

  it("rejects without token", async () => {
    const { status } = await api("/api/auth/me");
    expect(status).toBe(401);
  });

  it("rejects invalid token", async () => {
    const { status } = await api("/api/auth/me", {
      headers: { "Authorization": "Bearer invalid-token" },
    });
    expect(status).toBe(401);
  });
});

describe("API — Auth Logout", () => {
  it("revokes token on logout", async () => {
    const login = await apiJson("/api/auth/login", { username: "newuser", password: "pass1234" });
    const token = login.json.token;

    // Verify token works
    const me1 = await api("/api/auth/me", { headers: { "Authorization": `Bearer ${token}` } });
    expect(me1.status).toBe(200);

    // Logout
    const logout = await api("/api/auth/logout", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
    });
    expect(logout.status).toBe(200);

    // Token should be revoked
    const me2 = await api("/api/auth/me", { headers: { "Authorization": `Bearer ${token}` } });
    expect(me2.status).toBe(401);
  });
});

describe("API — Admin Users", () => {
  let adminToken;

  beforeAll(async () => {
    const login = await apiJson("/api/auth/login", { username: "admin", password: "admintest" });
    adminToken = login.json.token;
  });

  it("lists users (admin only)", async () => {
    const { status, json } = await api("/api/admin/users", {
      headers: { "Authorization": `Bearer ${adminToken}` },
    });
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects non-admin", async () => {
    const login = await apiJson("/api/auth/login", { username: "newuser", password: "pass1234" });
    const { status } = await api("/api/admin/users", {
      headers: { "Authorization": `Bearer ${login.json.token}` },
    });
    expect(status).toBe(403);
  });

  it("creates user as admin", async () => {
    const { status, json } = await api("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${adminToken}` },
      body: JSON.stringify({ username: "admincreated", password: "pass1234", role: "free" }),
    });
    expect(status).toBe(200);
    expect(json.role).toBe("free");
  });

  it("updates user role", async () => {
    const users = await api("/api/admin/users", { headers: { "Authorization": `Bearer ${adminToken}` } });
    const user = users.json.find(u => u.username === "admincreated");
    const { status, json } = await api(`/api/admin/users/${user.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${adminToken}` },
      body: JSON.stringify({ role: "regular" }),
    });
    expect(status).toBe(200);
    expect(json.role).toBe("regular");
  });

  it("deletes user", async () => {
    const users = await api("/api/admin/users", { headers: { "Authorization": `Bearer ${adminToken}` } });
    const user = users.json.find(u => u.username === "admincreated");
    const { status } = await api(`/api/admin/users/${user.id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${adminToken}` },
    });
    expect(status).toBe(200);
  });

  it("cannot delete self", async () => {
    const me = await api("/api/auth/me", { headers: { "Authorization": `Bearer ${adminToken}` } });
    const { status, json } = await api(`/api/admin/users/${me.json.id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${adminToken}` },
    });
    expect(status).toBe(400);
    expect(json.error).toContain("Cannot delete yourself");
  });
});

describe("API — SSRF Protection", () => {
  it("blocks localhost URLs on /img", async () => {
    const { status } = await api("/img?url=http://127.0.0.1/secret");
    expect(status).toBe(403);
  });

  it("blocks private IPs on /img", async () => {
    const { status } = await api("/img?url=http://192.168.1.1/secret");
    expect(status).toBe(403);
  });

  it("blocks localhost on /stream", async () => {
    const { status } = await api("/stream?url=http://localhost:3001/health");
    expect(status).toBe(403);
  });

  it("blocks 10.x.x.x on /proxy", async () => {
    const { status } = await api("/proxy?url=http://10.0.0.1/metadata");
    expect(status).toBe(403);
  });
});

describe("API — Sync", () => {
  let userToken;

  beforeAll(async () => {
    const login = await apiJson("/api/auth/login", { username: "newuser", password: "pass1234" });
    userToken = login.json.token;
  });

  it("saves and retrieves favorites", async () => {
    const save = await api("/api/sync/favorites", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${userToken}` },
      body: JSON.stringify({ connId: "test-conn", data: { live: { ch1: true } } }),
    });
    expect(save.status).toBe(200);

    const get = await api("/api/sync/favorites?connId=test-conn", {
      headers: { "Authorization": `Bearer ${userToken}` },
    });
    expect(get.status).toBe(200);
    expect(get.json.data).toEqual({ live: { ch1: true } });
  });

  it("saves and retrieves connections", async () => {
    const conns = [{ id: "c1", type: "stalker", label: "Test" }];
    const save = await api("/api/sync/connections", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${userToken}` },
      body: JSON.stringify({ connId: "_all", data: conns }),
    });
    expect(save.status).toBe(200);

    const get = await api("/api/sync/connections", {
      headers: { "Authorization": `Bearer ${userToken}` },
    });
    expect(get.status).toBe(200);
    expect(get.json.data).toEqual(conns);
  });

  it("rejects invalid sync type", async () => {
    const { status } = await api("/api/sync/invalid", {
      headers: { "Authorization": `Bearer ${userToken}` },
    });
    expect(status).toBe(400);
  });
});
