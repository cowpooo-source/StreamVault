"use strict";

const express = require("express");

function createStripeWebhookRouter(deps) {
  const { stripe, processor, webhookSecret = process.env.STRIPE_WEBHOOK_SECRET } = deps;
  const router = express.Router();

  router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
    if (!stripe || !stripe.webhooks || typeof stripe.webhooks.constructEvent !== "function" || !webhookSecret) {
      return res.status(500).json({ error: "Stripe webhook cryptographic verification is not configured" });
    }

    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).json({ error: "Missing stripe-signature header" });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
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
