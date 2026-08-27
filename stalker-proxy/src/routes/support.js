"use strict";

const express = require("express");

function createSupportRouter(deps) {
  const { auth, supportService } = deps;
  const router = express.Router();

  function validateCsrf(req, res, next) {
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
        if (new URL(origin).host !== host) {
          return res.status(403).json({ error: "Cross-origin support request rejected", code: "csrf_rejected" });
        }
      } catch {
        return res.status(403).json({ error: "Invalid origin", code: "csrf_rejected" });
      }
    } else if (referer) {
      try {
        if (new URL(referer).host !== host) {
          return res.status(403).json({ error: "Cross-origin support request rejected", code: "csrf_rejected" });
        }
      } catch {
        return res.status(403).json({ error: "Invalid referer", code: "csrf_rejected" });
      }
    } else {
      return res.status(403).json({ error: "Missing origin headers", code: "csrf_rejected" });
    }
    next();
  }

  // GET /api/support/tickets — List user's tickets
  router.get("/tickets", auth.requireAuth, (req, res) => {
    try {
      const tickets = supportService.listTickets(req.user.id);
      res.json({ tickets });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/support/tickets — Create a new ticket
  router.post("/tickets", auth.requireAuth, validateCsrf, async (req, res) => {
    const { category, message, orderId } = req.body;

    try {
      const ticket = await supportService.createTicket({
        userId: req.user.id,
        userEmail: req.user.email || null,
        category,
        message,
        orderId,
      });

      res.status(201).json({
        ticketId: ticket.id,
        status: ticket.status,
        category: ticket.category,
        createdAt: ticket.created_at,
      });
    } catch (err) {
      res.status(err.status || 400).json({
        error: err.message,
        code: err.code || "ticket_creation_failed",
      });
    }
  });

  // GET /api/support/tickets/:id — Get ticket by ID
  router.get("/tickets/:id", auth.requireAuth, (req, res) => {
    const ticket = supportService.getTicket(req.user.id, req.params.id);
    if (!ticket) {
      return res.status(404).json({ error: "Support ticket not found", code: "ticket_not_found" });
    }
    res.json({ ticket });
  });

  return router;
}

module.exports = {
  createSupportRouter,
};
