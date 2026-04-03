// User authentication module — bcrypt + JWT + SQLite
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = "7d";

// Role limits
const ROLE_LIMITS = {
  admin:   { maxConnections: 999, maxVod: Infinity, epg: true, sync: true },
  regular: { maxConnections: 5,   maxVod: Infinity, epg: true, sync: true },
  free:    { maxConnections: 2,   maxVod: 500,      epg: true, sync: true },
  guest:   { maxConnections: 2,   maxVod: 500,      epg: true, sync: false },
};

// Promo: new registrations get this role
const DEFAULT_ROLE = process.env.DEFAULT_ROLE || "regular";

let db;
let jwtSecret;

// Prepared statements
let stmts = {};

function init(database) {
  db = database;

  // Create tables
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'free' CHECK(role IN ('admin','regular','free')),
    max_connections INTEGER NOT NULL DEFAULT 2,
    created_at INTEGER NOT NULL,
    last_login INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)");

  // Prepare statements
  stmts.getUserByUsername = db.prepare("SELECT * FROM users WHERE username = ?");
  stmts.getUserById = db.prepare("SELECT id, username, role, max_connections, created_at, last_login, disabled FROM users WHERE id = ?");
  stmts.createUser = db.prepare("INSERT INTO users (username, password_hash, role, max_connections, created_at) VALUES (?, ?, ?, ?, ?)");
  stmts.updateLastLogin = db.prepare("UPDATE users SET last_login = ? WHERE id = ?");
  stmts.listUsers = db.prepare("SELECT id, username, role, max_connections, created_at, last_login, disabled FROM users ORDER BY created_at DESC");
  stmts.updateUser = db.prepare("UPDATE users SET role = ?, max_connections = ?, disabled = ? WHERE id = ?");
  stmts.deleteUser = db.prepare("DELETE FROM users WHERE id = ?");
  stmts.countUsers = db.prepare("SELECT COUNT(*) as cnt FROM users");
  stmts.changePassword = db.prepare("UPDATE users SET password_hash = ? WHERE id = ?");

  stmts.createSession = db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)");
  stmts.getSession = db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > ?");
  stmts.deleteSession = db.prepare("DELETE FROM sessions WHERE token = ?");
  stmts.deleteUserSessions = db.prepare("DELETE FROM sessions WHERE user_id = ?");
  stmts.cleanupSessions = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");

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
  seedAdmin();

  console.log(`   Auth: ${stmts.countUsers.get().cnt} users, JWT ${process.env.JWT_SECRET ? "env" : "auto"}-secret`);
}

function seedAdmin() {
  const adminUser = process.env.ADMIN_USER || "admin";
  const adminPass = process.env.ADMIN_PASS;
  if (!adminPass) return;

  const existing = stmts.getUserByUsername.get(adminUser);
  if (!existing) {
    const hash = bcrypt.hashSync(adminPass, SALT_ROUNDS);
    stmts.createUser.run(adminUser, hash, "admin", 999, Date.now());
    console.log(`   Auth: seeded admin user "${adminUser}"`);
  } else if (existing.role !== "admin") {
    stmts.updateUser.run("admin", 999, 0, existing.id);
  }
}

// ── User CRUD ──

function createUser(username, password, role = DEFAULT_ROLE) {
  if (!username || !password) throw new Error("Username and password required");
  if (username.length < 3) throw new Error("Username must be at least 3 characters");
  if (password.length < 4) throw new Error("Password must be at least 4 characters");
  if (stmts.getUserByUsername.get(username)) throw new Error("Username already taken");

  const limits = ROLE_LIMITS[role] || ROLE_LIMITS.free;
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  const result = stmts.createUser.run(username, hash, role, limits.maxConnections, Date.now());
  return { id: result.lastInsertRowid, username, role };
}

function authenticate(username, password) {
  const user = stmts.getUserByUsername.get(username);
  if (!user) throw new Error("Invalid username or password");
  if (user.disabled) throw new Error("Account is disabled");
  if (!bcrypt.compareSync(password, user.password_hash)) throw new Error("Invalid username or password");

  stmts.updateLastLogin.run(Date.now(), user.id);

  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    jwtSecret,
    { expiresIn: TOKEN_EXPIRY }
  );

  // Store session for server-side revocation
  const decoded = jwt.decode(token);
  stmts.createSession.run(token, user.id, Date.now(), decoded.exp * 1000);

  const limits = ROLE_LIMITS[user.role] || ROLE_LIMITS.free;
  return {
    token,
    user: {
      id: user.id, username: user.username, role: user.role,
      maxConnections: user.max_connections, limits,
    }
  };
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, jwtSecret);
    // Check server-side session exists (allows revocation)
    const session = stmts.getSession.get(token, Date.now());
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
  stmts.deleteSession.run(token);
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

function updateUser(id, { role, maxConnections, disabled }) {
  const user = stmts.getUserById.get(id);
  if (!user) throw new Error("User not found");
  stmts.updateUser.run(
    role ?? user.role,
    maxConnections ?? user.max_connections,
    disabled ?? user.disabled,
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

function changePassword(id, newPassword) {
  if (!newPassword || newPassword.length < 4) throw new Error("Password must be at least 4 characters");
  const hash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
  stmts.changePassword.run(hash, id);
  revokeAllUserTokens(id);
}

function cleanupSessions() {
  const result = stmts.cleanupSessions.run(Date.now());
  if (result.changes > 0) console.log(`Auth: cleaned ${result.changes} expired sessions`);
}

// ── Express Middleware ──

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication required" });
  const token = header.slice(7);
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: "Invalid or expired token" });
  req.user = user;
  next();
}

// Optional auth — sets req.user if token present, but doesn't block
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7);
    req.user = verifyToken(token);
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

module.exports = {
  init, ROLE_LIMITS, DEFAULT_ROLE,
  createUser, authenticate, verifyToken, revokeToken, revokeAllUserTokens,
  listUsers, getUser, updateUser, deleteUser, changePassword, cleanupSessions,
  requireAuth, optionalAuth, requireRole,
};
