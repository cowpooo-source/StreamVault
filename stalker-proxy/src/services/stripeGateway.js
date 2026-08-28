"use strict";

function createStripeGateway({ stripe, catalog, appUrl = "https://media.portalheaven.stream/app" }) {
  if (!stripe) {
    throw new Error("Stripe SDK client instance is required for stripeGateway");
  }

  function buildUrl(pathOrUrl, queryParams = {}) {
    let cleanPath = String(pathOrUrl || "/app?settingsTab=billing").trim();
    if (cleanPath.startsWith("http://") || cleanPath.startsWith("https://")) {
      try {
        const parsed = new URL(cleanPath);
        const appParsed = new URL(appUrl);
        if (parsed.origin !== appParsed.origin) {
          cleanPath = "/app?settingsTab=billing";
        } else {
          cleanPath = parsed.pathname + parsed.search;
        }
      } catch {
        cleanPath = "/app?settingsTab=billing";
      }
    }
    const base = `${appUrl.replace(/\/$/, "")}/${cleanPath.replace(/^\//, "")}`;
    const url = new URL(base);
    for (const [key, val] of Object.entries(queryParams)) {
      if (val !== undefined && val !== null) {
        url.searchParams.set(key, String(val));
      }
    }
    return url.toString();
  }

  async function createCustomer({ userId, email = null, username = null }) {
    return await stripe.customers.create(
      {
        email: email || undefined,
        metadata: {
          user_id: String(userId),
          username: username || "",
        },
      },
      {
        idempotencyKey: `customer:${userId}`,
      }
    );
  }

  async function createCheckout({ order, customerId, returnPath = "/app?settingsTab=billing" }) {
    const product = catalog.getProduct(order.productCode);
    const mode = product.mode; // "payment" or "subscription"
    const priceId = order.priceId || product.priceId;
    const userId = String(order.userId || order.user_id || "");

    const successUrl = buildUrl(returnPath, {
      session_id: "{CHECKOUT_SESSION_ID}",
      order_id: order.id,
    });
    const cancelUrl = buildUrl(returnPath, {
      cancel: "true",
      order_id: order.id,
    });

    const session = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        mode,
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        billing_address_collection: "required",
        automatic_tax: {
          enabled: Boolean(catalog?.taxEnabled !== false),
        },
        consent_collection: {
          terms_of_service: "required",
        },
        metadata: {
          order_id: String(order.id),
          user_id: userId,
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      {
        idempotencyKey: `checkout:${order.id}`,
      }
    );

    return {
      sessionId: session.id,
      checkoutUrl: session.url,
    };
  }

  async function createSetupCheckout({ order, customerId, returnPath = "/app?settingsTab=billing" }) {
    const userId = String(order.userId || order.user_id || "");

    const successUrl = buildUrl(returnPath, {
      session_id: "{CHECKOUT_SESSION_ID}",
      order_id: order.id,
      mode: "setup",
    });
    const cancelUrl = buildUrl(returnPath, {
      cancel: "true",
      order_id: order.id,
    });

    const session = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        mode: "setup",
        setup_intent_data: {
          metadata: {
            order_id: String(order.id),
            user_id: userId,
          },
        },
        billing_address_collection: "required",
        consent_collection: {
          terms_of_service: "required",
        },
        metadata: {
          order_id: String(order.id),
          user_id: userId,
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      {
        idempotencyKey: `setup:${order.id}`,
      }
    );

    return {
      sessionId: session.id,
      checkoutUrl: session.url,
    };
  }

  async function createPortalSession({ customerId, returnUrl = appUrl }) {
    return await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
  }

  async function cancelAtPeriodEnd({ subscriptionId }) {
    return await stripe.subscriptions.update(
      subscriptionId,
      { cancel_at_period_end: true },
      { idempotencyKey: `cancel:${subscriptionId}` }
    );
  }

  async function cancelSchedule({ scheduleId }) {
    return await stripe.subscriptionSchedules.cancel(
      scheduleId,
      {},
      { idempotencyKey: `cancel_schedule:${scheduleId}` }
    );
  }

  async function resolvePaymentMethodFromSetupIntent(setupIntentIdOrObj) {
    if (!setupIntentIdOrObj) return null;
    if (typeof setupIntentIdOrObj === "object") {
      if (setupIntentIdOrObj.payment_method) {
        const pm = typeof setupIntentIdOrObj.payment_method === "string"
          ? setupIntentIdOrObj.payment_method
          : setupIntentIdOrObj.payment_method.id || null;
        if (pm && String(pm).startsWith("pm_")) return String(pm);
      }
      if (setupIntentIdOrObj.id) {
        setupIntentIdOrObj = setupIntentIdOrObj.id;
      }
    }
    const idStr = String(setupIntentIdOrObj || "").trim();
    if (idStr.startsWith("pm_")) {
      return idStr;
    }
    if (idStr.startsWith("seti_")) {
      if (stripe.setupIntents && typeof stripe.setupIntents.retrieve === "function") {
        try {
          const setupIntent = await stripe.setupIntents.retrieve(idStr);
          const pm = typeof setupIntent?.payment_method === "string"
            ? setupIntent.payment_method
            : setupIntent?.payment_method?.id || null;
          if (pm && String(pm).startsWith("pm_")) {
            return String(pm);
          }
        } catch {}
      }
    }
    return null;
  }

  async function createScheduleAfterPass({
    customerId,
    priceId,
    startDate,
    orderId = null,
    userId = null,
    productCode = null,
    interval = null,
    intervalCount = 1,
    paymentMethodId = null,
    setupIntentId = null,
  }) {
    const startSeconds = typeof startDate === "number" && startDate > 1e11 ? Math.floor(startDate / 1000) : startDate;

    let resolvedPaymentMethodId = paymentMethodId;
    if (!resolvedPaymentMethodId && setupIntentId) {
      resolvedPaymentMethodId = setupIntentId;
    }
    if (resolvedPaymentMethodId && (typeof resolvedPaymentMethodId === "object" || String(resolvedPaymentMethodId).startsWith("seti_"))) {
      resolvedPaymentMethodId = await resolvePaymentMethodFromSetupIntent(resolvedPaymentMethodId);
    }

    let resolvedInterval = interval;
    if (!resolvedInterval && productCode && catalog?.getProduct) {
      try {
        resolvedInterval = catalog.getProduct(productCode)?.interval;
      } catch {}
    }
    if (!resolvedInterval && priceId && catalog?.listProducts) {
      try {
        const found = catalog.listProducts().find((p) => p.priceId === priceId || p.code === productCode);
        if (found?.interval) resolvedInterval = found.interval;
      } catch {}
    }
    if (!resolvedInterval || (resolvedInterval !== "year" && resolvedInterval !== "month")) {
      resolvedInterval = "month";
    }

    const metadata = {};
    if (orderId) metadata.order_id = String(orderId);
    if (userId) metadata.user_id = String(userId);
    if (productCode) metadata.product_code = String(productCode);

    const phase = {
      items: [{ price: priceId, quantity: 1 }],
      duration: {
        interval: resolvedInterval,
        interval_count: intervalCount || 1,
      },
    };
    if (Object.keys(metadata).length > 0) {
      phase.metadata = metadata;
    }

    const params = {
      customer: customerId,
      start_date: startSeconds,
      end_behavior: "release",
      phases: [phase],
    };

    if (Object.keys(metadata).length > 0) {
      params.metadata = metadata;
    }

    if (resolvedPaymentMethodId && String(resolvedPaymentMethodId).startsWith("pm_")) {
      params.default_settings = {
        default_payment_method: String(resolvedPaymentMethodId),
      };
    }

    return await stripe.subscriptionSchedules.create(params, {
      idempotencyKey: `schedule:${orderId || customerId + "_" + startSeconds}`,
    });
  }

  async function createFullRefund({ paymentIntentId, orderId }) {
    return await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        metadata: {
          order_id: String(orderId),
        },
      },
      {
        idempotencyKey: `refund:${orderId}`,
      }
    );
  }

  async function retrieveForReconciliation({ customerId = null, subscriptionId = null, paymentIntentId = null, scheduleId = null }) {
    const results = {};
    if (customerId) {
      try {
        results.customer = await stripe.customers.retrieve(customerId);
      } catch (err) {
        results.customerError = err.message;
      }
    }
    if (subscriptionId) {
      try {
        results.subscription = await stripe.subscriptions.retrieve(subscriptionId);
      } catch (err) {
        results.subscriptionError = err.message;
      }
    }
    if (paymentIntentId) {
      try {
        results.paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      } catch (err) {
        results.paymentIntentError = err.message;
      }
    }
    if (scheduleId) {
      try {
        results.schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
      } catch (err) {
        results.scheduleError = err.message;
      }
    }
    return results;
  }

  return {
    createCustomer,
    createCheckout,
    createSetupCheckout,
    createPortalSession,
    cancelAtPeriodEnd,
    cancelSchedule,
    createScheduleAfterPass,
    resolvePaymentMethodFromSetupIntent,
    createFullRefund,
    retrieveForReconciliation,
  };
}

module.exports = {
  createStripeGateway,
};
