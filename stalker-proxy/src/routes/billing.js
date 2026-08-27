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
        currency: catalog.currency,
        policies: catalog.currentPolicies(),
        legalNotice: catalog.legalNotice,
        supportEmail: catalog.supportEmail,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/billing/checkout — Create Checkout or Setup Session
  router.post("/checkout", auth.requireAuth, requireBillingEnabled, async (req, res) => {
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
    const username = req.user.username;
    const email = req.user.email || undefined;
    const customer = store.getCustomerByUserId(userId);
    const stripeCustomerId = customer ? customer.stripe_customer_id : null;
    const ts = getNow();

    const termsSha256 = crypto.createHash("sha256").update(acceptedPolicies.termsVersion || "v1").digest("hex");
    const privacySha256 = crypto.createHash("sha256").update(acceptedPolicies.privacyVersion || "v1").digest("hex");
    const refundSha256 = crypto.createHash("sha256").update(acceptedPolicies.refundVersion || "v1").digest("hex");

    const orderId = `ord_${crypto.randomBytes(12).toString("hex")}`;

    try {
      if (productCode === "standard_pass_30d") {
        store.createOrderWithAgreement({
          order: {
            id: orderId,
            userId,
            productCode,
            checkoutMode: "payment",
            status: "created",
            priceId: product.priceId,
            currency: catalog.currency,
            amountTotal: product.amount,
            refundableUntil: ts + 72 * 3600 * 1000,
          },
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
          userId,
          username,
          email,
          customerId: stripeCustomerId,
          priceId: product.priceId,
          orderId,
          returnUrl: returnUrl || catalog.appUrl,
          mode: "payment",
        });

        store.updateOrderStatus(orderId, "created", {
          stripeCheckoutSessionId: checkoutResult.sessionId,
          stripeCustomerId: checkoutResult.customerId,
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
        store.createOrderWithAgreement({
          order: {
            id: orderId,
            userId,
            productCode,
            checkoutMode: "setup",
            status: "created",
            priceId: product.priceId,
            currency: catalog.currency,
          },
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
          userId,
          username,
          email,
          customerId: stripeCustomerId,
          orderId,
          returnUrl: returnUrl || catalog.appUrl,
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
      store.createOrderWithAgreement({
        order: {
          id: orderId,
          userId,
          productCode,
          checkoutMode: "subscription",
          status: "created",
          priceId: product.priceId,
          currency: catalog.currency,
          amountTotal: product.amount,
        },
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
        userId,
        username,
        email,
        customerId: stripeCustomerId,
        priceId: product.priceId,
        orderId,
        returnUrl: returnUrl || catalog.appUrl,
        mode: "subscription",
      });

      store.updateOrderStatus(orderId, "created", {
        stripeCheckoutSessionId: checkoutResult.sessionId,
        stripeCustomerId: checkoutResult.customerId,
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
  router.post("/portal", auth.requireAuth, requireBillingEnabled, async (req, res) => {
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
      res.json({ portalUrl: portalResult.portalUrl });
    } catch (err) {
      console.error("Billing portal error:", err.message);
      res.status(500).json({ error: err.message, code: "portal_error" });
    }
  });

  // POST /api/billing/cancel — Subscription Cancellation
  router.post("/cancel", auth.requireAuth, requireBillingEnabled, async (req, res) => {
    const sub = store.getSubscriptionByUserId(req.user.id);
    if (!sub || sub.status !== "active") {
      return res.status(400).json({
        error: "No active subscription found for this account",
        code: "no_active_subscription",
      });
    }

    try {
      await stripeGateway.cancelSubscription({
        subscriptionId: sub.stripe_subscription_id,
        idempotencyKey: `cancel_${sub.stripe_subscription_id}_${req.user.id}`,
      });
      store.updateSubscriptionStatus(sub.stripe_subscription_id, { cancelAtPeriodEnd: 1 });
      res.json({ ok: true, cancelAtPeriodEnd: true });
    } catch (err) {
      console.error("Billing cancellation error:", err.message);
      res.status(500).json({ error: err.message, code: "cancel_error" });
    }
  });

  // POST /api/billing/refund — 72-Hour Automated Refund
  router.post("/refund", auth.requireAuth, requireBillingEnabled, async (req, res) => {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "orderId is required", code: "invalid_request" });
    }

    const order = store.getOrder(orderId);
    if (!order || order.user_id !== req.user.id) {
      return res.status(404).json({ error: "Order not found", code: "order_not_found" });
    }

    if (order.status !== "paid") {
      return res.status(400).json({ error: "Order is not in paid status", code: "order_not_paid" });
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
      if (order.stripe_payment_intent_id) {
        await stripeGateway.createRefund({
          paymentIntentId: order.stripe_payment_intent_id,
          idempotencyKey: `refund_${order.id}`,
        });
      }

      store.updateOrderStatus(order.id, "refunded", { refundedAt: ts });
      entitlementService.revokeRefundedEntitlement({
        userId: req.user.id,
        orderId: order.id,
        subscriptionId: order.stripe_subscription_id,
      });

      res.json({ ok: true, refunded: true, orderId: order.id });
    } catch (err) {
      console.error("Billing refund error:", err.message);
      res.status(500).json({ error: err.message, code: "refund_error" });
    }
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