import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";

// Use a temp DB for tests
const TEST_DB = path.join(os.tmpdir(), `streamvault-test-auth-${process.pid}.db`);

let auth;
let db;

beforeAll(async () => {
  // Clean previous test DB
  try { fs.unlinkSync(TEST_DB); } catch {}

  // Create fresh DB
  db = new Database(TEST_DB);
  db.pragma("journal_mode = WAL");

  // Create the cache table that auth.js expects for JWT secret storage
  db.exec("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)");

  // Set env vars
  process.env.ADMIN_PASS = "admin123";
  process.env.ADMIN_USER = "admin";
  process.env.JWT_SECRET = "test-secret-key";
  process.env.DEFAULT_ROLE = "free";

  // Import and init auth
  auth = require("../src/auth");
  await auth.init(db);
});

afterAll(() => {
  db?.close();
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_DB + "-wal"); } catch {}
  try { fs.unlinkSync(TEST_DB + "-shm"); } catch {}
});

describe("Auth — User Creation", () => {
  it("seeds admin user on init", () => {
    const users = auth.listUsers();
    const admin = users.find(u => u.username === "admin");
    expect(admin).toBeDefined();
    expect(admin.role).toBe("admin");
  });

  it("creates a free user by default", async () => {
    const user = await auth.createUser("testuser", "pass1234");
    expect(user.username).toBe("testuser");
    expect(user.role).toBe("free");
  });

  it("creates a user with specific role", async () => {
    const user = await auth.createUser("freeuser", "pass1234", "free");
    expect(user.role).toBe("free");
  });

  it("rejects duplicate username", async () => {
    await expect(auth.createUser("testuser", "pass1234")).rejects.toThrow("Username already taken");
  });

  it("rejects short username", async () => {
    await expect(auth.createUser("ab", "pass1234")).rejects.toThrow("at least 3 characters");
  });

  it("rejects short password", async () => {
    await expect(auth.createUser("newuser1", "123")).rejects.toThrow("at least 8 characters");
  });

  it("rejects empty username", async () => {
    await expect(auth.createUser("", "pass1234")).rejects.toThrow("Username and password required");
  });

  it("creates user with email", async () => {
    const user = await auth.createUser("emailuser", "pass1234", "regular", "test@example.com");
    expect(user.email).toBe("test@example.com");
  });

  it("rejects invalid email", async () => {
    await expect(auth.createUser("badmail", "pass1234", "regular", "notanemail")).rejects.toThrow("Invalid email");
  });

  it("rejects duplicate email", async () => {
    await expect(auth.createUser("another", "pass1234", "regular", "test@example.com")).rejects.toThrow("Email already registered");
  });
});

describe("Auth — Authentication", () => {
  it("authenticates with correct credentials", async () => {
    const session = await auth.authenticate("testuser", "pass1234");
    expect(session.token).toBeDefined();
    expect(session.user.username).toBe("testuser");
    expect(session.user.role).toBe("free");
    expect(session.user.limits).toBeDefined();
  });

  it("rejects wrong password", async () => {
    await expect(auth.authenticate("testuser", "wrongpass")).rejects.toThrow("Invalid username or password");
  });

  it("rejects non-existent user", async () => {
    await expect(auth.authenticate("nobody", "pass1234")).rejects.toThrow("Invalid username or password");
  });

  it("rejects disabled user", async () => {
    auth.updateUser(auth.listUsers().find(u => u.username === "freeuser").id, { disabled: 1 });
    await expect(auth.authenticate("freeuser", "pass1234")).rejects.toThrow("Account is disabled");
    // Re-enable
    auth.updateUser(auth.listUsers().find(u => u.username === "freeuser").id, { disabled: 0 });
  });

  it("returns correct limits per role", async () => {
    const adminSession = await auth.authenticate("admin", "admin123");
    expect(adminSession.user.limits.maxConnections).toBe(999);
    expect(adminSession.user.limits.maxVod).toBe(Infinity);

    const regularUser = await auth.createUser("regularuser", "pass1234", "regular");
    const regularSession = await auth.authenticate(regularUser.username, "pass1234");
    expect(regularSession.user.limits.maxConnections).toBe(5);

    const freeSession = await auth.authenticate("freeuser", "pass1234");
    expect(freeSession.user.limits.maxConnections).toBe(2);
    expect(freeSession.user.limits.maxVod).toBe(500);
  });
});

describe("Auth — JWT Tokens", () => {
  let multiSessionUser;

  beforeAll(async () => {
    multiSessionUser = await auth.createUser("multisession", "pass1234", "regular");
  });

  beforeEach(async () => {
    auth.revokeAllUserTokens(multiSessionUser.id);
  });

  it("verifies a valid token", async () => {
    const session = await auth.authenticate(multiSessionUser.username, "pass1234");
    const user = auth.verifyToken(session.token);
    expect(user).not.toBeNull();
    expect(user.username).toBe(multiSessionUser.username);
  });

  it("rejects an invalid token", () => {
    const user = auth.verifyToken("invalid-garbage-token");
    expect(user).toBeNull();
  });

  it("generates unique tokens for same user", async () => {
    const s1 = await auth.authenticate(multiSessionUser.username, "pass1234");
    const s2 = await auth.authenticate(multiSessionUser.username, "pass1234");
    expect(s1.token).not.toBe(s2.token);
  });

  it("revokes a token", async () => {
    const session = await auth.authenticate(multiSessionUser.username, "pass1234");
    expect(auth.verifyToken(session.token)).not.toBeNull();
    auth.revokeToken(session.token);
    expect(auth.verifyToken(session.token)).toBeNull();
  });

  it("revokes all user tokens", async () => {
    const s1 = await auth.authenticate(multiSessionUser.username, "pass1234");
    const s2 = await auth.authenticate(multiSessionUser.username, "pass1234");
    auth.revokeAllUserTokens(s1.user.id);
    expect(auth.verifyToken(s1.token)).toBeNull();
    expect(auth.verifyToken(s2.token)).toBeNull();
  });
});

describe("Auth — User Management", () => {
  beforeEach(async () => {
    const user = auth.listUsers().find(u => u.username === "testuser");
    if (user) auth.revokeAllUserTokens(user.id);
  });

  it("lists all users", () => {
    const users = auth.listUsers();
    expect(users.length).toBeGreaterThanOrEqual(3);
    expect(users[0].password_hash).toBeUndefined(); // should not expose hash
  });

  it("gets user by id", () => {
    const users = auth.listUsers();
    const user = auth.getUser(users[0].id);
    expect(user).toBeDefined();
    expect(user.username).toBeDefined();
  });

  it("updates user role", () => {
    const user = auth.listUsers().find(u => u.username === "testuser");
    auth.updateUser(user.id, { role: "free" });
    const updated = auth.getUser(user.id);
    expect(updated.role).toBe("free");
    // Restore
    auth.updateUser(user.id, { role: "regular" });
  });

  it("disabling user revokes sessions", async () => {
    const session = await auth.authenticate("testuser", "pass1234");
    expect(auth.verifyToken(session.token)).not.toBeNull();
    const user = auth.listUsers().find(u => u.username === "testuser");
    auth.updateUser(user.id, { disabled: 1 });
    expect(auth.verifyToken(session.token)).toBeNull();
    auth.updateUser(user.id, { disabled: 0 });
  });

  it("changes password", async () => {
    const user = auth.listUsers().find(u => u.username === "testuser");
    await auth.changePassword(user.id, "newpass123");
    const session = await auth.authenticate("testuser", "newpass123");
    expect(session.token).toBeDefined();
    // Restore
    await auth.changePassword(user.id, "pass1234");
  });

  it("change password rejects short password", async () => {
    const user = auth.listUsers().find(u => u.username === "testuser");
    await expect(auth.changePassword(user.id, "ab")).rejects.toThrow("at least 8 characters");
  });

  it("deletes user", async () => {
    const user = await auth.createUser("todelete", "pass1234");
    const before = auth.listUsers().length;
    auth.deleteUser(user.id);
    expect(auth.listUsers().length).toBe(before - 1);
    expect(auth.getUser(user.id)).toBeUndefined();
  });
});

describe("Auth — Email Tokens", () => {
  it("creates and verifies activation token", () => {
    const user = auth.listUsers().find(u => u.username === "testuser");
    const token = auth.createEmailToken(user.id, "activation");
    expect(token).toBeDefined();
    expect(token.length).toBe(64); // 32 bytes hex

    const row = auth.verifyEmailToken(token, "activation");
    expect(row).not.toBeNull();
    expect(row.user_id).toBe(user.id);
    expect(row.type).toBe("activation");
  });

  it("rejects wrong token type", () => {
    const user = auth.listUsers().find(u => u.username === "testuser");
    const token = auth.createEmailToken(user.id, "activation");
    expect(auth.verifyEmailToken(token, "reset")).toBeNull();
  });

  it("consumes token (single use)", () => {
    const user = auth.listUsers().find(u => u.username === "testuser");
    const token = auth.createEmailToken(user.id, "activation");
    auth.consumeEmailToken(token);
    expect(auth.verifyEmailToken(token, "activation")).toBeNull();
  });

  it("replaces old tokens of same type", () => {
    const user = auth.listUsers().find(u => u.username === "testuser");
    const token1 = auth.createEmailToken(user.id, "activation");
    const token2 = auth.createEmailToken(user.id, "activation");
    expect(auth.verifyEmailToken(token1, "activation")).toBeNull();
    expect(auth.verifyEmailToken(token2, "activation")).not.toBeNull();
  });
});

describe("Auth — Password Reset", () => {
  it("returns null for user without email", () => {
    const result = auth.requestPasswordReset("testuser");
    expect(result).toBeNull();
  });

  it("returns reset token for user with email", () => {
    const result = auth.requestPasswordReset("emailuser");
    expect(result).not.toBeNull();
    expect(result.token).toBeDefined();
    expect(result.user.username).toBe("emailuser");
  });

  it("resets password with valid token", async () => {
    const result = auth.requestPasswordReset("emailuser");
    await auth.resetPassword(result.token, "newpass999");
    const session = await auth.authenticate("emailuser", "newpass999");
    expect(session.token).toBeDefined();
  });

  it("rejects expired/invalid reset token", async () => {
    await expect(auth.resetPassword("fake-token", "newpass")).rejects.toThrow("Invalid or expired");
  });
});

describe("Auth — Role Limits", () => {
  it("defines limits for all roles", () => {
    expect(auth.ROLE_LIMITS.admin).toBeDefined();
    expect(auth.ROLE_LIMITS.regular).toBeDefined();
    expect(auth.ROLE_LIMITS.free).toBeDefined();
    expect(auth.ROLE_LIMITS.guest).toBeDefined();
  });

  it("guest has correct limits", () => {
    const g = auth.ROLE_LIMITS.guest;
    expect(g.maxConnections).toBe(2);
    expect(g.maxVod).toBe(500);
    expect(g.epg).toBe(true);
    expect(g.sync).toBe(true);
  });

  it("regular has unlimited VOD", () => {
    expect(auth.ROLE_LIMITS.regular.maxVod).toBe(Infinity);
    expect(auth.ROLE_LIMITS.regular.maxConnections).toBe(5);
  });

  it("admin has unlimited everything", () => {
    expect(auth.ROLE_LIMITS.admin.maxConnections).toBe(999);
    expect(auth.ROLE_LIMITS.admin.maxVod).toBe(Infinity);
  });
});
