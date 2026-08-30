"use strict";

const express = require("express");

function createAccountConnectionsRouter(deps) {
  const { auth, connectionAccessService } = deps;
  const router = express.Router();

  function validateConnectionsCsrf(req, res, next) {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      return next();
    }
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return next();
    }
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const host = req.headers.host;

    if (origin) {
      try {
        const parsed = new URL(origin);
        if (parsed.host !== host) {
          return res.status(403).json({ error: "Cross-origin connection request rejected", code: "csrf_rejected" });
        }
        if (parsed.protocol !== "https:" && process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
          return res.status(403).json({ error: "HTTPS control plane required for connection operations", code: "https_required" });
        }
      } catch {
        return res.status(403).json({ error: "Invalid origin", code: "csrf_rejected" });
      }
    } else if (referer) {
      try {
        const parsed = new URL(referer);
        if (parsed.host !== host) {
          return res.status(403).json({ error: "Cross-origin connection request rejected", code: "csrf_rejected" });
        }
        if (parsed.protocol !== "https:" && process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
          return res.status(403).json({ error: "HTTPS control plane required for connection operations", code: "https_required" });
        }
      } catch {
        return res.status(403).json({ error: "Invalid referer", code: "csrf_rejected" });
      }
    } else {
      return res.status(403).json({ error: "Missing origin headers", code: "csrf_rejected" });
    }
    next();
  }

  router.post("/reconcile", auth.requireAuth, validateConnectionsCsrf, express.json(), (req, res) => {
    try {
      const { connectionIds, clientOrder } = req.body;
      const result = connectionAccessService.reconcileConnections({
        userId: req.user.id,
        connectionIds,
        clientOrder,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/select", auth.requireAuth, validateConnectionsCsrf, express.json(), (req, res) => {
    try {
      const { selectConnectionId, deselectConnectionId } = req.body;
      const result = connectionAccessService.selectConnection({
        userId: req.user.id,
        selectConnectionId,
        deselectConnectionId,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = {
  createAccountConnectionsRouter,
};
