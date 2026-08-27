"use strict";

const crypto = require("node:crypto");

function createStripeEventProcessor({ store, entitlementService, catalog, stripeGateway, now = Date.now }) {
  if (!store) {
    throw new Error("store is required for stripeEventProcessor");
  }

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
  }

  async function processEvent(event) {
    const eventId = event.id;
    const eventType = event.type;
    const eventCreated = event.created || Math.floor(getNow() / 1000);
    const payloadJson = JSON.stringify(event);
    const payloadSha256 = crypto.createHash("sha256").update(payloadJson).digest("hex");

    const claimed = store.claimEvent({
      stripeEventId: eventId,
      eventType,
      livemode: event.livemode ? 1 : 0,
      stripeCreatedAt: eventCreated,
      payloadSha256,
    });
    if (!claimed) {
      return { received: true, duplicate: true };
    }

    try {
      switch (eventType) {
        case "checkout.session.completed": {
          const session = event.data?.object || {};
          const orderId = session.metadata?.order_id;
          const userId = session.metadata?.user_id ? Number(session.metadata.user_id) : null;
          const customerId = session.customer;

          if (userId && customerId) {
            store.upsertCustomer({ userId, stripeCustomerId: customerId });
          }

          let order = null;
          if (orderId) {
            order = store.getOrder(orderId);
          }
          if (!order && session.id) {
            order = store.getOrderByCheckoutSessionId(session.id);
          }

          const effectiveUserId = userId || order?.user_id;

          if (session.mode === "payment") {
            if (order) {
              store.updateOrderStatus(order.id, "paid", {
                stripeCustomerId: customerId,
                stripePaymentIntentId: session.payment_intent,
                stripeCheckoutSessionId: session.id,
              });
            }

            if (effectiveUserId) {
              const productCode = order?.product_code || "standard_pass_30d";
              const startsAt = getNow();
              const endsAt = startsAt + 30 * 86400000;
              entitlementService.activatePass({
                userId: effectiveUserId,
                orderId: order?.id || session.id,
                startsAt,
                endsAt,
              });
            }
          } else if (session.mode === "subscription") {
            if (order) {
              store.updateOrderStatus(order.id, "paid", {
                stripeCustomerId: customerId,
                stripeSubscriptionId: session.subscription,
                stripeCheckoutSessionId: session.id,
              });
            }

            if (effectiveUserId && session.subscription) {
              store.upsertSubscription({
                stripeSubscriptionId: session.subscription,
                userId: effectiveUserId,
                status: "active",
                stripeCustomerId: customerId,
                productCode: order?.product_code || "standard_monthly",
                lastStripeEventCreated: eventCreated,
              });
              entitlementService.activateSubscription({
                userId: effectiveUserId,
                stripeSubscriptionId: session.subscription,
                startsAt: getNow(),
              });
            }
          } else if (session.mode === "setup") {
            if (order) {
              store.updateOrderStatus(order.id, "paid", {
                stripeCustomerId: customerId,
                stripeCheckoutSessionId: session.id,
              });
            }

            if (effectiveUserId && stripeGateway?.createScheduleAfterPass) {
              const entitlements = store.listEntitlementsForUser(effectiveUserId);
              const activePass = entitlements.find((e) => e.source_type === "pass" && e.status === "active");
              const startDateSeconds = activePass?.ends_at
                ? Math.floor(activePass.ends_at / 1000)
                : Math.floor((getNow() + 30 * 86400000) / 1000);

              const prodCode = order?.product_code || "standard_monthly";
              let priceId = null;
              try {
                priceId = catalog.getProduct(prodCode).priceId;
              } catch {}

              if (priceId && customerId) {
                await stripeGateway.createScheduleAfterPass({
                  customerId,
                  priceId,
                  startDate: startDateSeconds,
                  orderId: order?.id || session.id,
                  paymentMethodId: session.setup_intent,
                });
              }
            }
          }
          break;
        }

        case "invoice.paid": {
          const invoice = event.data?.object || {};
          const subscriptionId = invoice.subscription;
          if (subscriptionId) {
            const sub = store.getSubscriptionByStripeId(subscriptionId);
            const periodEnd = invoice.lines?.data?.[0]?.period?.end
              ? invoice.lines.data[0].period.end * 1000
              : null;

            store.updateSubscriptionStatus(subscriptionId, {
              status: "active",
              currentPeriodEnd: periodEnd,
              lastStripeEventCreated: eventCreated,
            });

            if (sub) {
              entitlementService.activateSubscription({
                userId: sub.user_id,
                stripeSubscriptionId: subscriptionId,
                endsAt: periodEnd,
              });
            }
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data?.object || {};
          const subscriptionId = invoice.subscription;
          if (subscriptionId) {
            store.updateSubscriptionStatus(subscriptionId, {
              status: "past_due",
              lastStripeEventCreated: eventCreated,
            });
            entitlementService.startGrace({ subscriptionId });
          }
          break;
        }

        case "customer.subscription.updated": {
          const subObj = event.data?.object || {};
          const subscriptionId = subObj.id;
          const existingSub = store.getSubscriptionByStripeId(subscriptionId);

          if (existingSub) {
            if (!existingSub.last_stripe_event_created || eventCreated >= existingSub.last_stripe_event_created) {
              const currentPeriodEnd = subObj.current_period_end ? subObj.current_period_end * 1000 : null;
              store.updateSubscriptionStatus(subscriptionId, {
                status: subObj.status,
                cancelAtPeriodEnd: subObj.cancel_at_period_end ? 1 : 0,
                currentPeriodEnd,
                lastStripeEventCreated: eventCreated,
              });

              if (subObj.status === "active") {
                entitlementService.activateSubscription({
                  userId: existingSub.user_id,
                  stripeSubscriptionId: subscriptionId,
                  endsAt: currentPeriodEnd,
                });
              } else if (subObj.status === "past_due" || subObj.status === "unpaid") {
                entitlementService.startGrace({ subscriptionId });
              } else if (subObj.status === "canceled") {
                const ent = store.getEntitlementBySource("subscription", subscriptionId);
                if (ent) {
                  store.updateEntitlementStatus(ent.id, "expired");
                }
              }
            }
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subObj = event.data?.object || {};
          const subscriptionId = subObj.id;
          store.updateSubscriptionStatus(subscriptionId, {
            status: "canceled",
            cancelAtPeriodEnd: 1,
            lastStripeEventCreated: eventCreated,
          });
          const ent = store.getEntitlementBySource("subscription", subscriptionId);
          if (ent) {
            store.updateEntitlementStatus(ent.id, "expired");
          }
          break;
        }

        case "charge.refunded": {
          const charge = event.data?.object || {};
          const paymentIntentId = charge.payment_intent;
          if (paymentIntentId) {
            const order = store.getOrderByPaymentIntentId(paymentIntentId);
            if (order) {
              store.updateOrderStatus(order.id, "refunded");
              entitlementService.revokeRefundedEntitlement({
                userId: order.user_id,
                orderId: order.id,
                subscriptionId: order.stripe_subscription_id,
              });
            }
          }
          break;
        }
      }

      store.updateEventStatus(eventId, "processed");
      return { received: true, duplicate: false };
    } catch (err) {
      store.updateEventStatus(eventId, "failed", { error: err.message });
      throw err;
    }
  }

  return {
    processEvent,
  };
}

module.exports = {
  createStripeEventProcessor,
};
