// User authentication module — bcrypt + JWT + SQLite
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = "7d";

// Role limits
const ROLE_LIMITS = {
  admin:   { maxConnections: 999, maxVod: Infinity, epg: true, sync: true, maxLogins: 999 },
  pro:     { maxConnections: 10,  maxVod: Infinity, epg: true, sync: true, maxLogins: 5 },
  regular: { maxConnections: 5,   maxVod: Infinity, epg: true, sync: true, maxLogins: 3 },
  free:    { maxConnections: 2,   maxVod: 500,      epg: true, sync: true, maxLogins: 1 },
  guest:   { maxConnections: 2,   maxVod: 500,      epg: true, sync: false, maxLogins: 1 },
};

// Promo: new registrations get this role (validated against allowed set)
const ALLOWED_DEFAULT_ROLES = new Set(["pro", "regular", "free"]);
const DEFAULT_ROLE = ALLOWED_DEFAULT_ROLES.has(process.env.DEFAULT_ROLE) ? process.env.DEFAULT_ROLE : "regular";

let db;
let jwtSecret;

// Prepared statements
let stmts = {};

async function init(database) {
  db = database;

  // Create tables
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'free' CHECK(role IN ('admin','pro','regular','free')),
    subscription_cycle TEXT CHECK(subscription_cycle IN ('monthly', 'yearly')),
    subscription_expires_at INTEGER,
    max_connections INTEGER NOT NULL DEFAULT 2,
    created_at INTEGER NOT NULL,
    last_login INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0,
    email_verified INTEGER NOT NULL DEFAULT 0
  )`);

  // Add columns if upgrading from older schema
  try { db.exec("ALTER TABLE users ADD COLUMN email TEXT"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN subscription_cycle TEXT"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN subscription_expires_at INTEGER"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL"); } catch {}

  db.exec(`CREATE TABLE IF NOT EXISTS email_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id)");

  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)");

  db.exec(`CREATE TABLE IF NOT EXISTS failed_logins (
    ip TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt INTEGER NOT NULL
  )`);

  // Prepare statements
  stmts.getUserByUsername = db.prepare("SELECT * FROM users WHERE username = ?");
  stmts.getUserByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
  stmts.getUserById = db.prepare("SELECT id, username, email, role, subscription_cycle, subscription_expires_at, max_connections, created_at, last_login, disabled, email_verified FROM users WHERE id = ?");
  stmts.createUser = db.prepare("INSERT INTO users (username, email, password_hash, role, max_connections, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  stmts.updateLastLogin = db.prepare("UPDATE users SET last_login = ? WHERE id = ?");
  stmts.listUsers = db.prepare("SELECT id, username, email, role, subscription_cycle, subscription_expires_at, max_connections, created_at, last_login, disabled, email_verified FROM users ORDER BY created_at DESC");
  stmts.updateUser = db.prepare("UPDATE users SET role = ?, max_connections = ?, disabled = ?, subscription_cycle = ?, subscription_expires_at = ? WHERE id = ?");
  stmts.deleteUser = db.prepare("DELETE FROM users WHERE id = ?");
  stmts.countUsers = db.prepare("SELECT COUNT(*) as cnt FROM users");
  stmts.changePassword = db.prepare("UPDATE users SET password_hash = ? WHERE id = ?");
  stmts.setEmailVerified = db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?");
  stmts.updateEmail = db.prepare("UPDATE users SET email = ?, email_verified = 0 WHERE id = ?");

  stmts.createEmailToken = db.prepare("INSERT INTO email_tokens (token, user_id, type, expires_at) VALUES (?, ?, ?, ?)");
  stmts.getEmailToken = db.prepare("SELECT * FROM email_tokens WHERE token = ? AND expires_at > ?");
  stmts.deleteEmailToken = db.prepare("DELETE FROM email_tokens WHERE token = ?");
  stmts.deleteUserEmailTokens = db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND type = ?");
  stmts.cleanupEmailTokens = db.prepare("DELETE FROM email_tokens WHERE expires_at <= ?");

  stmts.createSession = db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)");
  stmts.getSession = db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > ?");
  stmts.deleteSession = db.prepare("DELETE FROM sessions WHERE token = ?");
  stmts.deleteUserSessions = db.prepare("DELETE FROM sessions WHERE user_id = ?");
  stmts.cleanupSessions = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");
  stmts.countActiveUserSessions = db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE user_id = ? AND expires_at > ?");

  stmts.trackFailedLogin = db.prepare("INSERT INTO failed_logins (ip, attempts, last_attempt) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET attempts = attempts + 1, last_attempt = ?");
  stmts.getFailedLogins = db.prepare("SELECT * FROM failed_logins WHERE ip = ?");
  stmts.clearFailedLogins = db.prepare("DELETE FROM failed_logins WHERE ip = ?");
  stmts.cleanupFailedLogins = db.prepare("DELETE FROM failed_logins WHERE last_attempt < ?");

  // JWT secret: from env, or generate and store in DB
  jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    const row = db.prepare("SELECT value FROM cache WHERE key = 'jwt_secret'").get();
    if (row) {
      jwtSecret = JSON.parse(row.value);
    } else {
      jwtSecret = crypto.randomBytes(32).toString("hex");
      db.prepare("INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)").run(
        "jwt_secret", JSON.stringify(jwtSecret), Date.now() + 100 * 365 * 24 * 60 * 60 * 1000
      );
    }
  }

  // Seed admin user if none exists
  await seedAdmin();

  console.log(`   Auth: ${stmts.countUsers.get().cnt} users, JWT ${process.env.JWT_SECRET ? "env" : "auto"}-secret`);
}

async function seedAdmin() {
  const adminUser = process.env.ADMIN_USER || "admin";
  const adminPass = process.env.ADMIN_PASS;
  if (!adminPass) return;

  const existing = stmts.getUserByUsername.get(adminUser);
  if (!existing) {
    const hash = await bcrypt.hash(adminPass, SALT_ROUNDS);
    stmts.createUser.run(adminUser, null, hash, "admin", 999, Date.now());
    console.log(`   Auth: seeded admin user "${adminUser}"`);
  } else if (existing.role !== "admin") {
    stmts.updateUser.run("admin", 999, 0, existing.subscription_cycle, existing.subscription_expires_at, existing.id);
  }
}

// ── User CRUD ──

async function createUser(username, password, role = DEFAULT_ROLE, email = null) {
  if (!username || !password) throw new Error("Username and password required");
  if (username.length < 3) throw new Error("Username must be at least 3 characters");
  if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) throw new Error("Password must be at least 8 characters with letters and numbers");
  if (stmts.getUserByUsername.get(username)) throw new Error("Username already taken");
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid email address");
    if (stmts.getUserByEmail.get(email)) throw new Error("Email already registered");
  }

  const limits = ROLE_LIMITS[role] || ROLE_LIMITS.free;
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const result = stmts.createUser.run(username, email || null, hash, role, limits.maxConnections, Date.now());
  return { id: result.lastInsertRowid, username, email, role };
}

// ── Email token operations ──

function createEmailToken(userId, type, expiresIn = 24 * 60 * 60 * 1000) {
  // Delete old tokens of same type
  stmts.deleteUserEmailTokens.run(userId, type);
  const token = crypto.randomBytes(32).toString("hex");
  stmts.createEmailToken.run(token, userId, type, Date.now() + expiresIn);
  return token;
}

function verifyEmailToken(token, type) {
  const row = stmts.getEmailToken.get(token, Date.now());
  if (!row || row.type !== type) return null;
  return row;
}

function consumeEmailToken(token) {
  stmts.deleteEmailToken.run(token);
}

function activateEmail(userId) {
  stmts.setEmailVerified.run(userId);
}

function requestPasswordReset(usernameOrEmail) {
  const user = stmts.getUserByUsername.get(usernameOrEmail) || stmts.getUserByEmail.get(usernameOrEmail);
  if (!user || !user.email) return null;
  const token = createEmailToken(user.id, "reset", 60 * 60 * 1000); // 1 hour
  return { user, token };
}

async function resetPassword(token, newPassword) {
  const row = verifyEmailToken(token, "reset");
  if (!row) throw new Error("Invalid or expired reset link");
  if (!newPassword || newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) throw new Error("Password must be at least 8 characters with letters and numbers");
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  stmts.changePassword.run(hash, row.user_id);
  consumeEmailToken(token);
  revokeAllUserTokens(row.user_id);
  return stmts.getUserById.get(row.user_id);
}

async function authenticate(username, password, ip = "unknown") {
  const user = stmts.getUserByUsername.get(username);
  if (!user) {
    stmts.trackFailedLogin.run(ip, Date.now(), Date.now());
    throw new Error("Invalid username or password");
  }
  
  if (user.disabled) throw new Error("Account is disabled");

  if (!(await bcrypt.compare(password, user.password_hash))) {
    stmts.trackFailedLogin.run(ip, Date.now(), Date.now());
    throw new Error("Invalid username or password");
  }

  // Check concurrent login limits
  const limits = ROLE_LIMITS[user.role] || ROLE_LIMITS.free;
  const activeSessions = stmts.countActiveUserSessions.get(user.id, Date.now()).cnt;
  
  if (activeSessions >= (limits.maxLogins || 1)) {
    throw new Error(`Maximum concurrent logins reached (${limits.maxLogins}). Please log out from another device.`);
  }

  // Success — clear failed attempts for this IP
  stmts.clearFailedLogins.run(ip);

  stmts.updateLastLogin.run(Date.now(), user.id);

  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role, jti: crypto.randomBytes(8).toString("hex") },
    jwtSecret,
    { expiresIn: TOKEN_EXPIRY }
  );

  // Store session hash for server-side revocation (not raw JWT)
  const decoded = jwt.decode(token);
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  stmts.createSession.run(tokenHash, user.id, Date.now(), decoded.exp * 1000);

  return {
    token,
    user: {
      id: user.id, username: user.username, email: user.email, role: user.role,
      maxConnections: user.max_connections, emailVerified: !!user.email_verified,
      subscription_cycle: user.subscription_cycle, subscription_expires_at: user.subscription_expires_at,
      limits,
    }
  };
}

function getAuthStats() {
  const now = Date.now();
  const oneHourAgo = now - 3600000;

  const activeSessions = stmts.countActiveUserSessions.all ? 0 : db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE expires_at > ?").get(now).cnt;
  const roles = db.prepare("SELECT role, COUNT(*) as cnt FROM users GROUP BY role").all();
  const unactivated = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE email_verified = 0 AND role != 'admin'").get().cnt;
  const totalGuests = db.prepare("SELECT COUNT(*) as cnt FROM guests").get().cnt;
  const failed = db.prepare("SELECT SUM(attempts) as total, COUNT(ip) as ips FROM failed_logins WHERE last_attempt > ?").get(oneHourAgo);

  const roleDist = Object.fromEntries(roles.map(r => [r.role, r.cnt]));
  roleDist.guest = totalGuests;
  roleDist.unactivated = unactivated;

  return {
    active_sessions: activeSessions,
    role_distribution: roleDist,
    failed_logins_1h: {
      total_attempts: failed.total || 0,
      unique_ips: failed.ips || 0
    }
  };
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, jwtSecret);
    // Check server-side session exists (allows revocation) — stored as hash
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const session = stmts.getSession.get(tokenHash, Date.now());
    if (!session) return null;

    const user = stmts.getUserById.get(payload.sub);
    if (!user || user.disabled) return null;

    const limits = ROLE_LIMITS[user.role] || ROLE_LIMITS.free;
    return { ...user, limits };
  } catch {
    return null;
  }
}

function revokeToken(token) {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  stmts.deleteSession.run(tokenHash);
}

function revokeAllUserTokens(userId) {
  stmts.deleteUserSessions.run(userId);
}

function listUsers() {
  return stmts.listUsers.all();
}

function getUser(id) {
  return stmts.getUserById.get(id);
}

function updateUser(id, { role, maxConnections, disabled, subscription_cycle, subscription_expires_at }) {
  const user = stmts.getUserById.get(id);
  if (!user) throw new Error("User not found");
  stmts.updateUser.run(
    role ?? user.role,
    maxConnections ?? user.max_connections,
    disabled ?? user.disabled,
    subscription_cycle !== undefined ? subscription_cycle : user.subscription_cycle,
    subscription_expires_at !== undefined ? subscription_expires_at : user.subscription_expires_at,
    id
  );
  // If disabled, revoke all sessions
  if (disabled) revokeAllUserTokens(id);
  return stmts.getUserById.get(id);
}

function deleteUser(id) {
  revokeAllUserTokens(id);
  stmts.deleteUser.run(id);
}

async function changePassword(id, newPassword) {
  if (!newPassword || newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) throw new Error("Password must be at least 8 characters with letters and numbers");
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  stmts.changePassword.run(hash, id);
  revokeAllUserTokens(id);
}

function cleanupSessions() {
  const result = stmts.cleanupSessions.run(Date.now());
  if (result.changes > 0) console.log(`Auth: cleaned ${result.changes} expired sessions`);
  stmts.cleanupEmailTokens.run(Date.now());
}

// ── Express Middleware ──

function extractToken(req) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return req.cookies?.sv_auth || null;
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: "Invalid or expired token" });
  req.user = user;
  next();
}

// Optional auth — sets req.user if token present, but doesn't block
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (token) req.user = verifyToken(token);
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

function updateUserEmail(userId, email) {
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Invalid email address format");
  }

  // Check if email is already taken by another user
  if (email) {
    const existing = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, userId);
    if (existing) throw new Error("Email address already in use by another account");
  }

  db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, userId);
}

module.exports = {
  init,
  SALT_ROUNDS, ROLE_LIMITS, DEFAULT_ROLE,
  createUser, authenticate, verifyToken, revokeToken, revokeAllUserTokens,
  listUsers, getUser, updateUser, deleteUser, changePassword, cleanupSessions,
  getAuthStats,
  requireAuth, optionalAuth, requireRole,
  createEmailToken, verifyEmailToken, consumeEmailToken, activateEmail,
  requestPasswordReset, resetPassword,
  updateUserEmail,
};
