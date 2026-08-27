const express = require("express");
const rateLimit = require("express-rate-limit");

function createAuthRouter(deps) {
  const { auth, email, fetch } = deps;
  const router = express.Router();

  const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY?.trim();
  // Never silently disable CAPTCHA in a production process. Local/test runs may
  // omit the secret, but production must fail closed until it is configured.
  const turnstileRequired = process.env.TURNSTILE_REQUIRED === "true"
    || Boolean(TURNSTILE_SECRET_KEY)
    || process.env.NODE_ENV === "production";

  async function verifyTurnstile(token, ip) {
    if (!TURNSTILE_SECRET_KEY) return false;
    if (!token) return false;
    const formData = new URLSearchParams();
    formData.append('secret', TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    formData.append('remoteip', ip);
    try {
      const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { body: formData, method: 'POST' });
      const outcome = await result.json();
      return outcome.success;
    } catch (err) {
      console.error("Turnstile verification failed:", err);
      return false;
    }
  }

  async function requireTurnstile(req, res) {
    if (!turnstileRequired) return true;
    if (!TURNSTILE_SECRET_KEY) {
      res.status(503).json({ error: "CAPTCHA is not configured", code: "captcha_unavailable" });
      return false;
    }

    const token = req.body?.cf_turnstile_response;
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    if (!(await verifyTurnstile(token, ip))) {
      res.status(403).json({ error: "CAPTCHA failed", code: "captcha_failed" });
      return false;
    }
    return true;
  }

  function setAuthCookie(res, token) {
    res.cookie("sv_auth", token, {
      httpOnly: true, secure: process.env.NODE_ENV === "production" || process.env.APP_URL?.startsWith("https"),
      sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000, path: "/",
    });
  }

  const loginLimiter = rateLimit({ windowMs: 900000, max: 15, message: { error: "Too many attempts" } });

  router.post("/auth/register", rateLimit({ windowMs: 3600000, max: 10 }), express.json(), async (req, res) => {
    if (!(await requireTurnstile(req, res))) return;
    if (process.env.REGISTRATION_OPEN === "false") return res.status(403).json({ error: "Closed" });

    try {
      const { username, password, email: userEmail } = req.body;
      await auth.createUser(username, password, undefined, userEmail);
      const session = await auth.authenticate(username, password);
      setAuthCookie(res, session.token);
      res.json(session);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post("/auth/login", loginLimiter, express.json(), async (req, res) => {
    if (!(await requireTurnstile(req, res))) return;

    try {
      const { username, password, force } = req.body;
      if (!username || !password) return res.status(400).json({ error: "Required" });
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
      const session = await auth.authenticate(username, password, ip, force === true);
      setAuthCookie(res, session.token);
      res.json(session);
    } catch (e) {
      if (e.code === 'MAX_LOGINS_REACHED') res.status(403).json({ error: e.message, code: 'MAX_LOGINS_REACHED' });
      else res.status(401).json({ error: e.message });
    }
  });

  router.post("/auth/guest", express.json(), async (req, res) => {
    res.json({ ok: true });
  });

  router.post("/auth/logout", auth.requireAuth, (req, res) => {
    const token = req.headers.authorization?.slice(7) || req.cookies?.sv_auth;
    if (token) auth.revokeToken(token);
    res.clearCookie("sv_auth", { path: "/" });
    res.json({ ok: true });
  });

  router.get("/auth/me", auth.requireAuth, (req, res) => {
    const effective = auth.getEffectiveAccess ? auth.getEffectiveAccess(req.user.id) : {
      role: req.user.role,
      baseRole: req.user.baseRole || req.user.role,
      plan: req.user.plan || "free",
      planSource: req.user.planSource || "base_role",
      billingStatus: req.user.billingStatus || "none",
      accessStartsAt: req.user.accessStartsAt || null,
      accessEndsAt: req.user.accessEndsAt || null,
      nextBillingAt: req.user.nextBillingAt || null,
      cancelAtPeriodEnd: req.user.cancelAtPeriodEnd || false,
      limits: req.user.limits || auth.ROLE_LIMITS[req.user.role] || auth.ROLE_LIMITS.free,
    };
    res.json({
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      role: effective.role,
      baseRole: effective.baseRole,
      plan: effective.plan,
      planSource: effective.planSource,
      billingStatus: effective.billingStatus,
      accessStartsAt: effective.accessStartsAt,
      accessEndsAt: effective.accessEndsAt,
      nextBillingAt: effective.nextBillingAt,
      cancelAtPeriodEnd: effective.cancelAtPeriodEnd,
      emailVerified: !!req.user.email_verified,
      maxConnections: req.user.max_connections,
      limits: effective.limits,
    });
  });

  router.put("/auth/password", auth.requireAuth, express.json(), async (req, res) => {
    try {
      await auth.changePassword(req.user.id, req.body.password);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post("/auth/forgot-password", express.json(), async (req, res) => {
    try {
      const { email: userEmail } = req.body;
      const result = auth.requestPasswordReset(userEmail);
      if (result) await email.sendPasswordReset(result.user.email, result.user.username, result.token);
      res.json({ ok: true, message: "Sent" });
    } catch (e) { res.status(500).json({ error: "Error" }); }
  });

  router.post("/auth/reset-password", express.json(), async (req, res) => {
    try {
      const { token, password } = req.body;
      await auth.resetPassword(token, password);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.get("/admin/users", auth.requireAuth, auth.requireRole("admin"), (req, res) => {
    res.json(auth.listUsers());
  });

  router.post("/admin/users", auth.requireAuth, auth.requireRole("admin"), express.json(), async (req, res) => {
    try {
      const { username, password, role } = req.body;
      const user = await auth.createUser(username, password, role || "regular");
      res.json(user);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.put("/admin/users/:id", auth.requireAuth, auth.requireRole("admin"), express.json(), (req, res) => {
    try {
      const user = auth.updateUser(parseInt(req.params.id, 10), req.body);
      res.json(user);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.delete("/admin/users/:id", auth.requireAuth, auth.requireRole("admin"), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
    auth.deleteUser(id);
    res.json({ ok: true });
  });

  router.post("/user/profile", auth.requireAuth, express.json(), async (req, res) => {
    try {
      auth.updateUserEmail(req.user.id, req.body.email);
      res.json({ ok: true, message: "Updated" });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createAuthRouter };
