const express = require("express");
const router = express.Router();
const auth = require("../auth");
const email = require("../email");
const rateLimit = require("express-rate-limit");

function setAuthCookie(res, token) {
  res.cookie("sv_auth", token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000, path: "/",
  });
}

// ── Auth rate limiting ──
const loginLimiter = rateLimit({ windowMs: 900000, max: 15, message: { error: "Too many login attempts, try again later" } });
const registerLimiter = rateLimit({ windowMs: 3600000, max: 10, message: { error: "Too many registrations, try again later" } });

// ── POST /api/auth/register ──
router.post("/auth/register", registerLimiter, express.json(), async (req, res) => {
  const open = process.env.REGISTRATION_OPEN !== "false";
  if (!open) return res.status(403).json({ error: "Registration is currently closed" });
  try {
    const { username, password, email: userEmail } = req.body;
    await auth.createUser(username, password, undefined, userEmail);
    const session = await auth.authenticate(username, password);
    setAuthCookie(res, session.token);
    res.json(session);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/auth/login ──
router.post("/auth/login", loginLimiter, express.json(), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const session = await auth.authenticate(username, password);
    setAuthCookie(res, session.token);
    res.json(session);
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// ── POST /api/auth/logout ──
router.post("/auth/logout", auth.requireAuth, (req, res) => {
  const token = req.headers.authorization?.slice(7) || req.cookies?.sv_auth;
  if (token) auth.revokeToken(token);
  res.clearCookie("sv_auth", { path: "/" });
  res.json({ ok: true });
});

// ── GET /api/auth/me ──
router.get("/auth/me", auth.requireAuth, (req, res) => {
  const limits = auth.ROLE_LIMITS[req.user.role] || auth.ROLE_LIMITS.free;
  res.json({
    id: req.user.id, username: req.user.username, email: req.user.email,
    role: req.user.role, emailVerified: !!req.user.email_verified,
    maxConnections: req.user.max_connections, limits,
  });
});

// ── PUT /api/auth/password ──
router.put("/auth/password", auth.requireAuth, express.json(), async (req, res) => {
  try {
    await auth.changePassword(req.user.id, req.body.password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/auth/forgot-password ──
router.post("/auth/forgot-password", express.json(), async (req, res) => {
  try {
    const { email: userEmail } = req.body;
    if (!userEmail) return res.status(400).json({ error: "Email is required" });
    const result = auth.requestPasswordReset(userEmail);
    if (result) {
      const { user, token } = result;
      await email.sendPasswordReset(user.email, user.username, token);
    }
    // Always return success to prevent email enumeration
    res.json({ ok: true, message: "If an account with that email exists, a reset link has been sent." });
  } catch (e) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/auth/reset-password ──
router.post("/auth/reset-password", express.json(), async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Token and password required" });
    await auth.resetPassword(token, password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Admin: user management ──
router.get("/admin/users", auth.requireAuth, auth.requireRole("admin"), (req, res) => {
  res.json(auth.listUsers());
});

router.post("/admin/users", auth.requireAuth, auth.requireRole("admin"), express.json(), async (req, res) => {
  try {
    const { username, password, role } = req.body;
    const user = await auth.createUser(username, password, role || "regular");
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put("/admin/users/:id", auth.requireAuth, auth.requireRole("admin"), express.json(), (req, res) => {
  try {
    const user = auth.updateUser(parseInt(req.params.id, 10), req.body);
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/admin/users/:id", auth.requireAuth, auth.requireRole("admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
  auth.deleteUser(id);
  res.json({ ok: true });
});

// ── User: profile management ──
router.post("/user/profile", auth.requireAuth, express.json(), async (req, res) => {
  try {
    const { email } = req.body;
    auth.updateUserEmail(req.user.id, email);
    res.json({ ok: true, message: "Profile updated" });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;