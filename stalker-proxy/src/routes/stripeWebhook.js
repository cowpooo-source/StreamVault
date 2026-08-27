"use strict";

const express = require("express");

function createStripeWebhookRouter(deps) {
  const { stripe, processor, webhookSecret = process.env.STRIPE_WEBHOOK_SECRET } = deps;
  const router = express.Router();

  router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).json({ error: "Missing stripe-signature header" });
    }

    let event;
    try {
      if (stripe && stripe.webhooks && typeof stripe.webhooks.constructEvent === "function") {
        event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
      } else {
        event = JSON.parse(req.body.toString("utf8"));
      }
    } catch (err) {
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }

    try {
      const result = await processor.processEvent(event);
      res.json(result);
    } catch (err) {
      console.error("Stripe webhook processing error:", err.message);
      res.status(500).json({ error: "Internal webhook processing error" });
    }
  });

  return router;
}

module.exports = {
  createStripeWebhookRouter,
};
