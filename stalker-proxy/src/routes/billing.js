"use strict";

const express = require("express");
const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");

function createBillingRouter(deps) {
  const { auth, catalog, store, entitlementService, stripeGateway, now = Date.now } = deps;
  const router = express.Router();

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
  }

  // Seed active policy versions into store if not already present
  if (store && catalog && catalog.enabled) {
    try {
      const policies = catalog.currentPolicies();
      for (const [type, info] of Object.entries(policies)) {
        const existing = store.getPolicyVersion(type, info.version);
        const contentSha256 = catalog.getPolicyContentSha256 ? catalog.getPolicyContentSha256(type, info.version) : crypto.createHash("sha256").update(`${type}:${info.version}`).digest("hex");
        if (!existing) {
          store.upsertPolicyVersion({
            policyType: type,
            version: info.version,
            publicUrl: info.publicUrl,
            contentSha256,
            publishedAt: getNow(),
            retiredAt: null,
          });
        }
      }
    } catch {}
  }

  // Dedicated Rate Limiters for Billing Endpoints
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const billingCheckoutLimiter = rateLimit({
    windowMs: 60000,
    max: isTest ? 1000 : 10,
    message: { error: "Too many checkout requests. Please wait a minute.", code: "billing_rate_limited" },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const billingMutationLimiter = rateLimit({
    windowMs: 60000,
    max: isTest ? 1000 : 20,
    message: { error: "Too many billing requests. Please wait a minute.", code: "billing_rate_limited" },
    standardHeaders: true,
    legacyHeaders: false,
  });

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

  function sanitizeReturnPath(urlOrPath, appUrl = "https://media.portalheaven.stream/app") {
    if (!urlOrPath) return "/app?settingsTab=billing";
    const str = String(urlOrPath).trim();
    if (str.startsWith("/")) {
      return str;
    }
    try {
      const parsed = new URL(str);
      const appParsed = new URL(appUrl);
      if (parsed.origin === appParsed.origin) {
        return parsed.pathname + parsed.search + parsed.hash;
      }
    } catch {}
    return "/app?settingsTab=billing";
  }

  function getPolicyHashes(acceptedPolicies) {
    const termsVer = acceptedPolicies.terms || acceptedPolicies.termsVersion || "v1";
    const privVer = acceptedPolicies.privacy || acceptedPolicies.privacyVersion || "v1";
    const refVer = acceptedPolicies.refund || acceptedPolicies.refundVersion || "v1";

    let termsSha256;
    let privacySha256;
    let refundSha256;

    if (catalog && typeof catalog.getPolicyContentSha256 === "function") {
      termsSha256 = catalog.getPolicyContentSha256("terms", termsVer);
      privacySha256 = catalog.getPolicyContentSha256("privacy", privVer);
      refundSha256 = catalog.getPolicyContentSha256("refund", refVer);
    } else {
      const termsRow = store.getPolicyVersion("terms", termsVer);
      const privRow = store.getPolicyVersion("privacy", privVer);
      const refRow = store.getPolicyVersion("refund", refVer);

      termsSha256 = termsRow?.content_sha256 || crypto.createHash("sha256").update(`terms:${termsVer}`).digest("hex");
      privacySha256 = privRow?.content_sha256 || crypto.createHash("sha256").update(`privacy:${privVer}`).digest("hex");
      refundSha256 = refRow?.content_sha256 || crypto.createHash("sha256").update(`refund:${refVer}`).digest("hex");
    }

    return {
      termsVersion: termsVer,
      privacyVersion: privVer,
      refundVersion: refVer,
      termsSha256,
      privacySha256,
      refundSha256,
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
  router.post(
    "/checkout",
    billingCheckoutLimiter,
    auth.requireAuth,
    validateBillingCsrf,
    requireBillingEnabled,
    async (req, res) => {
      const { productCode, returnUrl } = req.body;
      const acceptedPolicies = req.body.acceptedPolicyVersions || req.body.acceptedPolicies || {};

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

      const policyData = getPolicyHashes(acceptedPolicies);
      const cleanReturnPath = sanitizeReturnPath(returnUrl, catalog.appUrl);
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
              termsVersion: policyData.termsVersion,
              privacyVersion: policyData.privacyVersion,
              refundVersion: policyData.refundVersion,
              termsSha256: policyData.termsSha256,
              privacySha256: policyData.privacySha256,
              refundSha256: policyData.refundSha256,
              stripeTermsAccepted: 1,
            },
          });

          const checkoutResult = await stripeGateway.createCheckout({
            order: orderData,
            customerId: stripeCustomerId,
            returnPath: cleanReturnPath,
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
              termsVersion: policyData.termsVersion,
              privacyVersion: policyData.privacyVersion,
              refundVersion: policyData.refundVersion,
              termsSha256: policyData.termsSha256,
              privacySha256: policyData.privacySha256,
              refundSha256: policyData.refundSha256,
              stripeTermsAccepted: 1,
            },
          });

          const setupResult = await stripeGateway.createSetupCheckout({
            order: orderData,
            customerId: stripeCustomerId,
            returnPath: cleanReturnPath,
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
            termsVersion: policyData.termsVersion,
            privacyVersion: policyData.privacyVersion,
            refundVersion: policyData.refundVersion,
            termsSha256: policyData.termsSha256,
            privacySha256: policyData.privacySha256,
            refundSha256: policyData.refundSha256,
            stripeTermsAccepted: 1,
          },
        });

        const checkoutResult = await stripeGateway.createCheckout({
          order: orderData,
          customerId: stripeCustomerId,
          returnPath: cleanReturnPath,
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
    }
  );

  // POST /api/billing/portal — Customer Portal Session
  router.post(
    "/portal",
    billingMutationLimiter,
    auth.requireAuth,
    validateBillingCsrf,
    requireBillingEnabled,
    async (req, res) => {
      const customer = store.getCustomerByUserId(req.user.id);
      if (!customer || !customer.stripe_customer_id) {
        return res.status(400).json({
          error: "No billing customer found for this account",
          code: "no_billing_customer",
        });
      }

      const returnUrl = sanitizeReturnPath(req.body.returnUrl, catalog.appUrl);
      const resolvedReturnUrl = returnUrl.startsWith("http")
        ? returnUrl
        : new URL(returnUrl, catalog.appUrl).toString();

      try {
        const portalResult = await stripeGateway.createPortalSession({
          customerId: customer.stripe_customer_id,
          returnUrl: resolvedReturnUrl,
        });
        res.json({ portalUrl: portalResult.url || portalResult.portalUrl });
      } catch (err) {
        console.error("Billing portal error:", err.message);
        res.status(500).json({ error: err.message, code: "portal_error" });
      }
    }
  );

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

  router.post(
    "/subscription/cancel",
    billingMutationLimiter,
    auth.requireAuth,
    validateBillingCsrf,
    requireBillingEnabled,
    handleCancelSubscription
  );
  router.post(
    "/cancel",
    billingMutationLimiter,
    auth.requireAuth,
    validateBillingCsrf,
    requireBillingEnabled,
    handleCancelSubscription
  );

  // POST /api/billing/subscription/scheduled/cancel — Cancel Queued Future Schedule
  router.post(
    "/subscription/scheduled/cancel",
    billingMutationLimiter,
    auth.requireAuth,
    validateBillingCsrf,
    requireBillingEnabled,
    async (req, res) => {
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
    }
  );

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

      // Status becomes refund_pending, refunded_at is NOT written until Stripe confirms via webhook
      store.updateOrderStatus(order.id, "refund_pending", { refundedAt: null });

      res.json({ ok: true, status: "refund_pending", orderId: order.id });
    } catch (err) {
      console.error("Billing refund error:", err.message);
      res.status(500).json({ error: err.message, code: "refund_error" });
    }
  };

  router.post(
    "/refunds",
    billingMutationLimiter,
    auth.requireAuth,
    validateBillingCsrf,
    requireBillingEnabled,
    handleRefund
  );
  router.post(
    "/refund",
    billingMutationLimiter,
    auth.requireAuth,
    validateBillingCsrf,
    requireBillingEnabled,
    handleRefund
  );

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