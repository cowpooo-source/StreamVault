"use strict";

const express = require("express");
const crypto = require("node:crypto");

function createBillingRouter(deps) {
  const { auth, catalog, store, entitlementService, stripeGateway, now = Date.now } = deps;
  const router = express.Router();

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
  }

  function requireBillingEnabled(req, res, next) {
    if (!catalog || !catalog.enabled || !stripeGateway) {
      return res.status(503).json({
        error: "Billing is not enabled on this instance",
        code: "billing_disabled",
      });
    }
    next();
  }

  function validateBillingCsrf(req, res, next) {
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
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          return res.status(403).json({ error: "Cross-origin billing request rejected", code: "csrf_rejected" });
        }
      } catch {
        return res.status(403).json({ error: "Invalid request origin", code: "csrf_rejected" });
      }
    } else if (referer) {
      try {
        const refererHost = new URL(referer).host;
        if (refererHost !== host) {
          return res.status(403).json({ error: "Cross-origin billing request rejected", code: "csrf_rejected" });
        }
      } catch {
        return res.status(403).json({ error: "Invalid request referer", code: "csrf_rejected" });
      }
    } else {
      return res.status(403).json({ error: "Missing origin headers on state-changing request", code: "csrf_rejected" });
    }

    next();
  }

  function getPolicyHashes(acceptedPolicies) {
    const policies = catalog.currentPolicies();
    const termsPayload = `terms:${acceptedPolicies.termsVersion || policies.terms.version}:${policies.terms.publicUrl}`;
    const privacyPayload = `privacy:${acceptedPolicies.privacyVersion || policies.privacy.version}:${policies.privacy.publicUrl}`;
    const refundPayload = `refund:${acceptedPolicies.refundVersion || policies.refund.version}:${policies.refund.publicUrl}`;

    return {
      termsSha256: crypto.createHash("sha256").update(termsPayload).digest("hex"),
      privacySha256: crypto.createHash("sha256").update(privacyPayload).digest("hex"),
      refundSha256: crypto.createHash("sha256").update(refundPayload).digest("hex"),
    };
  }

  // GET /api/billing/config — Public configuration and policies
  router.get("/config", (req, res) => {
    if (!catalog || !catalog.enabled) {
      return res.json({
        enabled: false,
        testMode: false,
        products: [],
        currency: "usd",
        policies: null,
        legalNotice: null,
        supportEmail: null,
      });
    }

    try {
      res.json({
        enabled: true,
        testMode: !catalog.livemode,
        products: catalog.listProducts(),
        currency: catalog.currency || "usd",
        policies: catalog.currentPolicies(),
        legalNotice: catalog.legalNotice,
        supportEmail: catalog.supportEmail,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/billing/checkout — Create Checkout or Setup Session
  router.post("/checkout", auth.requireAuth, validateBillingCsrf, requireBillingEnabled, async (req, res) => {
    const { productCode, acceptedPolicies = {}, returnUrl } = req.body;

    if (!productCode) {
      return res.status(400).json({ error: "productCode is required", code: "invalid_product" });
    }

    try {
      catalog.validatePurchaseAgreement(acceptedPolicies);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code || "invalid_agreement" });
    }

    let product;
    try {
      product = catalog.getProduct(productCode);
    } catch (err) {
      return res.status(400).json({ error: err.message, code: "invalid_product" });
    }

    const userId = req.user.id;
    const customer = store.getCustomerByUserId(userId);
    const stripeCustomerId = customer ? customer.stripe_customer_id : undefined;
    const ts = getNow();

    const { termsSha256, privacySha256, refundSha256 } = getPolicyHashes(acceptedPolicies);
    const orderId = `ord_${crypto.randomBytes(12).toString("hex")}`;

    try {
      if (productCode === "standard_pass_30d") {
        const orderData = {
          id: orderId,
          userId,
          productCode,
          checkoutMode: "payment",
          status: "created",
          priceId: product.priceId,
          currency: catalog.currency || "usd",
          amountTotal: product.amount,
          refundableUntil: ts + 72 * 3600 * 1000,
        };

        store.createOrderWithAgreement({
          order: orderData,
          agreement: {
            orderId,
            userId,
            termsVersion: acceptedPolicies.termsVersion,
            privacyVersion: acceptedPolicies.privacyVersion,
            refundVersion: acceptedPolicies.refundVersion,
            termsSha256,
            privacySha256,
            refundSha256,
            stripeTermsAccepted: 1,
          },
        });

        const checkoutResult = await stripeGateway.createCheckout({
          order: orderData,
          customerId: stripeCustomerId,
          returnPath: returnUrl,
        });

        store.updateOrderStatus(orderId, "created", {
          stripeCheckoutSessionId: checkoutResult.sessionId,
        });

        return res.json({
          checkoutUrl: checkoutResult.checkoutUrl,
          orderId,
          mode: "payment",
        });
      }

      // Monthly or Yearly subscription
      const entitlements = store.listEntitlementsForUser(userId);
      const activePass = entitlements.find(
        (e) => e.source_type === "pass" && e.status === "active" && (e.ends_at === null || e.ends_at > ts)
      );

      if (activePass) {
        // Pass-to-subscription transition via Setup Session
        const orderData = {
          id: orderId,
          userId,
          productCode,
          checkoutMode: "setup",
          status: "created",
          priceId: product.priceId,
          currency: catalog.currency || "usd",
        };

        store.createOrderWithAgreement({
          order: orderData,
          agreement: {
            orderId,
            userId,
            termsVersion: acceptedPolicies.termsVersion,
            privacyVersion: acceptedPolicies.privacyVersion,
            refundVersion: acceptedPolicies.refundVersion,
            termsSha256,
            privacySha256,
            refundSha256,
            stripeTermsAccepted: 1,
          },
        });

        const setupResult = await stripeGateway.createSetupCheckout({
          order: orderData,
          customerId: stripeCustomerId,
          returnPath: returnUrl,
        });

        store.updateOrderStatus(orderId, "created", {
          stripeCheckoutSessionId: setupResult.sessionId,
        });

        return res.json({
          checkoutUrl: setupResult.checkoutUrl,
          orderId,
          mode: "setup",
        });
      }

      // Standard recurring subscription checkout
      const orderData = {
        id: orderId,
        userId,
        productCode,
        checkoutMode: "subscription",
        status: "created",
        priceId: product.priceId,
        currency: catalog.currency || "usd",
        amountTotal: product.amount,
      };

      store.createOrderWithAgreement({
        order: orderData,
        agreement: {
          orderId,
          userId,
          termsVersion: acceptedPolicies.termsVersion,
          privacyVersion: acceptedPolicies.privacyVersion,
          refundVersion: acceptedPolicies.refundVersion,
          termsSha256,
          privacySha256,
          refundSha256,
          stripeTermsAccepted: 1,
        },
      });

      const checkoutResult = await stripeGateway.createCheckout({
        order: orderData,
        customerId: stripeCustomerId,
        returnPath: returnUrl,
      });

      store.updateOrderStatus(orderId, "created", {
        stripeCheckoutSessionId: checkoutResult.sessionId,
      });

      return res.json({
        checkoutUrl: checkoutResult.checkoutUrl,
        orderId,
        mode: "subscription",
      });
    } catch (err) {
      console.error("Billing checkout error:", err.message);
      return res.status(500).json({ error: err.message, code: "checkout_error" });
    }
  });

  // POST /api/billing/portal — Customer Portal Session
  router.post("/portal", auth.requireAuth, validateBillingCsrf, requireBillingEnabled, async (req, res) => {
    const customer = store.getCustomerByUserId(req.user.id);
    if (!customer || !customer.stripe_customer_id) {
      return res.status(400).json({
        error: "No billing customer found for this account",
        code: "no_billing_customer",
      });
    }

    try {
      const portalResult = await stripeGateway.createPortalSession({
        customerId: customer.stripe_customer_id,
        returnUrl: req.body.returnUrl || catalog.appUrl,
      });
      res.json({ portalUrl: portalResult.url || portalResult.portalUrl });
    } catch (err) {
      console.error("Billing portal error:", err.message);
      res.status(500).json({ error: err.message, code: "portal_error" });
    }
  });

  // POST /api/billing/subscription/cancel (and /cancel) — Subscription Cancellation
  const handleCancelSubscription = async (req, res) => {
    const sub = store.getSubscriptionByUserId(req.user.id);
    if (!sub || sub.status !== "active") {
      return res.status(400).json({
        error: "No active subscription found for this account",
        code: "no_active_subscription",
      });
    }

    try {
      await stripeGateway.cancelAtPeriodEnd({
        subscriptionId: sub.stripe_subscription_id,
      });
      store.updateSubscriptionStatus(sub.stripe_subscription_id, { cancelAtPeriodEnd: 1 });
      res.json({ ok: true, cancelAtPeriodEnd: true });
    } catch (err) {
      console.error("Billing cancellation error:", err.message);
      res.status(500).json({ error: err.message, code: "cancel_error" });
    }
  };

  router.post("/subscription/cancel", auth.requireAuth, validateBillingCsrf, requireBillingEnabled, handleCancelSubscription);
  router.post("/cancel", auth.requireAuth, validateBillingCsrf, requireBillingEnabled, handleCancelSubscription);

  // POST /api/billing/subscription/scheduled/cancel — Cancel Queued Future Schedule
  router.post("/subscription/scheduled/cancel", auth.requireAuth, validateBillingCsrf, requireBillingEnabled, async (req, res) => {
    const sub = store.getSubscriptionByUserId(req.user.id);
    let scheduleId = sub?.stripe_schedule_id;

    if (!scheduleId) {
      const orders = store.listOrdersForUser(req.user.id);
      const setupOrder = orders.find((o) => o.stripe_schedule_id);
      scheduleId = setupOrder?.stripe_schedule_id;
    }

    if (!scheduleId) {
      return res.status(400).json({
        error: "No scheduled subscription found for this account",
        code: "no_scheduled_subscription",
      });
    }

    try {
      await stripeGateway.cancelSchedule({ scheduleId });
      if (sub && sub.stripe_schedule_id === scheduleId) {
        store.updateSubscriptionStatus(sub.stripe_subscription_id, { stripeScheduleId: null });
      }
      res.json({ ok: true, canceled: true, scheduleId });
    } catch (err) {
      console.error("Scheduled subscription cancellation error:", err.message);
      res.status(500).json({ error: err.message, code: "cancel_schedule_error" });
    }
  });

  // POST /api/billing/refunds (and /refund) — 72-Hour Automated Refund
  const handleRefund = async (req, res) => {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "orderId is required", code: "invalid_request" });
    }

    const order = store.getOrder(orderId);
    if (!order || order.user_id !== req.user.id) {
      return res.status(404).json({ error: "Order not found", code: "order_not_found" });
    }

    if (order.status !== "paid") {
      return res.status(400).json({ error: "Order is not in paid status", code: "order_not_refundable" });
    }

    if (!order.stripe_payment_intent_id) {
      return res.status(400).json({
        error: "Order has no associated payment intent for automatic refund",
        code: "no_payment_intent",
      });
    }

    if (order.checkout_mode !== "payment") {
      return res.status(400).json({
        error: "Only pass orders can be refunded automatically",
        code: "invalid_checkout_mode",
      });
    }

    const ts = getNow();
    const refundLimit = order.refundable_until || order.created_at + 72 * 3600 * 1000;
    if (ts > refundLimit) {
      return res.status(400).json({
        error: "Refund window has expired (72 hours)",
        code: "refund_window_expired",
      });
    }

    try {
      await stripeGateway.createFullRefund({
        paymentIntentId: order.stripe_payment_intent_id,
        orderId: order.id,
      });

      store.updateOrderStatus(order.id, "refund_pending", { refundedAt: ts });

      res.json({ ok: true, status: "refund_pending", orderId: order.id });
    } catch (err) {
      console.error("Billing refund error:", err.message);
      res.status(500).json({ error: err.message, code: "refund_error" });
    }
  };

  router.post("/refunds", auth.requireAuth, validateBillingCsrf, requireBillingEnabled, handleRefund);
  router.post("/refund", auth.requireAuth, validateBillingCsrf, requireBillingEnabled, handleRefund);

  // GET /api/billing/orders — User Orders
  router.get("/orders", auth.requireAuth, (req, res) => {
    const orders = store.listOrdersForUser(req.user.id);
    res.json({ orders });
  });

  // GET /api/billing/history — Orders, Subscription, Active Pass, Entitlements
  router.get("/history", auth.requireAuth, (req, res) => {
    const ts = getNow();
    const orders = store.listOrdersForUser(req.user.id);
    const entitlements = store.listEntitlementsForUser(req.user.id);
    const subscription = store.getSubscriptionByUserId(req.user.id);
    const activePass =
      entitlements.find(
        (e) => e.source_type === "pass" && e.status === "active" && (e.ends_at === null || e.ends_at > ts)
      ) || null;

    res.json({
      orders,
      subscription: subscription || null,
      activePass,
      entitlements,
    });
  });

  return router;
}

module.exports = {
  createBillingRouter,
};