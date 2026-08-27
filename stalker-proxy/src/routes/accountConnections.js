"use strict";

const express = require("express");

function createAccountConnectionsRouter(deps) {
  const { auth, connectionAccessService } = deps;
  const router = express.Router();

  router.post("/reconcile", auth.requireAuth, express.json(), (req, res) => {
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

  router.post("/select", auth.requireAuth, express.json(), (req, res) => {
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
