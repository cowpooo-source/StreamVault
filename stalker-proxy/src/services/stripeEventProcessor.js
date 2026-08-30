"use strict";

const crypto = require("node:crypto");

const HANDLED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "subscription_schedule.created",
  "subscription_schedule.canceled",
  "subscription_schedule.completed",
  "subscription_schedule.released",
  "subscription_schedule.aborted",
  "charge.refunded",
  "charge.refund.updated",
  "refund.created",
  "refund.updated",
]);

function createStripeEventProcessor({ store, entitlementService, catalog, stripeGateway, getUserById, now = Date.now }) {
  if (!store) {
    throw new Error("store is required for stripeEventProcessor");
  }

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
  }

  function queueLifecycleNotifications({ notificationKey, template, userId, payload = {} }) {
    if (typeof store.enqueueNotification !== "function") return;

    const user = typeof getUserById === "function" ? getUserById(userId) : null;
    const discordWebhook = catalog?.billingDiscordWebhookUrl ||
      catalog?.discordWebhookUrl ||
      catalog?.supportDiscordWebhookUrl ||
      process.env.BILLING_DISCORD_WEBHOOK_URL ||
      process.env.SUPPORT_DISCORD_WEBHOOK_URL ||
      null;
    const notificationPayload = JSON.stringify({
      ...payload,
      eventType: template,
      userId,
      createdAt: getNow(),
    });
    const recipients = [];
    if (user?.email) recipients.push({ channel: "email", recipient: user.email });
    if (discordWebhook) recipients.push({ channel: "discord", recipient: discordWebhook });

    for (const { channel, recipient } of recipients) {
      const id = `notif_${crypto.createHash("sha256")
        .update(`${notificationKey}:${template}:${channel}`)
        .digest("hex")
        .slice(0, 32)}`;
      store.enqueueNotification({
        id,
        channel,
        template,
        recipient,
        payloadJson: notificationPayload,
        status: "queued",
        nextAttemptAt: getNow(),
      });
    }
  }

  async function processEvent(event) {
    const eventId = event.id;
    const eventType = event.type;
    const eventCreated = event.created || Math.floor(getNow() / 1000);
    const eventLivemode = Boolean(event.livemode);

    if (catalog && catalog.livemode !== undefined && eventLivemode !== Boolean(catalog.livemode)) {
      const err = new Error(
        `Livemode mismatch: event livemode=${eventLivemode} but server livemode=${Boolean(catalog.livemode)}`
      );
      err.code = "livemode_mismatch";
      err.status = 400;
      throw err;
    }

    const payloadJson = JSON.stringify(event);
    const payloadSha256 = crypto.createHash("sha256").update(payloadJson).digest("hex");

    const claim = store.claimEvent({
      stripeEventId: eventId,
      eventType,
      livemode: event.livemode ? 1 : 0,
      stripeCreatedAt: eventCreated,
      payloadSha256,
    });
    if (!claim.claimed) {
      return { received: true, duplicate: true };
    }

    try {
      if (!HANDLED_EVENT_TYPES.has(eventType)) {
        store.updateEventStatus(eventId, "ignored");
        return { received: true, duplicate: false, ignored: true };
      }

      switch (eventType) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded": {
          const session = event.data?.object || {};
          const orderId = session.metadata?.order_id || session.metadata?.orderId || session.client_reference_id;
          const userId = session.metadata?.user_id
            ? Number(session.metadata.user_id)
            : session.metadata?.userId
            ? Number(session.metadata.userId)
            : null;
          const customerId = session.customer;

          let order = null;
          if (orderId) {
            order = store.getOrder(orderId);
          }
          if (!order && session.id) {
            order = store.getOrderByCheckoutSessionId(session.id);
          }

          const effectiveUserId = userId || order?.user_id;

          if (!effectiveUserId) {
            const err = new Error(`Unresolvable user for checkout session: ${session.id || "unknown"}`);
            err.code = "unresolvable_user";
            err.status = 422;
            throw err;
          }

          if (customerId) {
            store.upsertCustomer({ userId: effectiveUserId, stripeCustomerId: customerId });
          }

          // Checkout completion is not proof that a delayed payment succeeded.
          // Leave the order pending until Stripe sends a confirmed payment event.
          if (
            eventType === "checkout.session.completed" &&
            (session.mode === "payment" || session.mode === "subscription") &&
            !["paid", "no_payment_required"].includes(session.payment_status)
          ) {
            store.updateEventStatus(eventId, "processed");
            return { received: true, duplicate: false, pending: true };
          }

          if (session.mode === "payment") {
            const productCode = order?.product_code || session.metadata?.product_code || "standard_pass_30d";
            const startsAt = getNow();
            const endsAt = startsAt + 30 * 86400000;
            entitlementService.activatePass({
              userId: effectiveUserId,
              orderId: order?.id || session.id,
              startsAt,
              endsAt,
            });
            if (order) {
              store.updateOrderStatus(order.id, "paid", {
                stripeCustomerId: customerId,
                stripePaymentIntentId: session.payment_intent,
                stripeCheckoutSessionId: session.id,
              });
            }
          } else if (session.mode === "subscription") {
            if (!session.subscription) {
              const err = new Error("Stripe subscription is missing from checkout session");
              err.code = "subscription_missing";
              err.status = 422;
              throw err;
            }

            if (typeof stripeGateway?.retrieveSubscription !== "function") {
              const err = new Error("Stripe subscription retrieval is unavailable");
              err.code = "subscription_period_unavailable";
              err.status = 503;
              throw err;
            }

            let stripeSubscription;
            try {
              stripeSubscription = await stripeGateway.retrieveSubscription(session.subscription);
            } catch (cause) {
              const err = new Error("Stripe subscription period retrieval failed");
              err.code = "subscription_period_unavailable";
              err.status = 503;
              err.cause = cause;
              throw err;
            }
            const currentPeriodStart = stripeSubscription?.current_period_start
              ? stripeSubscription.current_period_start * 1000
              : getNow();
            const currentPeriodEnd = stripeSubscription?.current_period_end
              ? stripeSubscription.current_period_end * 1000
              : null;
            if (!currentPeriodEnd) {
              const err = new Error("Stripe subscription period end is unavailable");
              err.code = "subscription_period_unavailable";
              err.status = 502;
              throw err;
            }

            store.upsertSubscription({
              stripeSubscriptionId: session.subscription,
              userId: effectiveUserId,
              status: stripeSubscription.status || "active",
              stripeCustomerId: customerId,
              productCode: order?.product_code || session.metadata?.product_code || "standard_monthly",
              currentPeriodStart,
              currentPeriodEnd,
              lastStripeEventCreated: eventCreated,
            });
            entitlementService.activateSubscription({
              userId: effectiveUserId,
              stripeSubscriptionId: session.subscription,
              startsAt: currentPeriodStart,
              endsAt: currentPeriodEnd,
              productCode: order?.product_code || session.metadata?.product_code || "standard_monthly",
            });
            if (order) {
              store.updateOrderStatus(order.id, "paid", {
                stripeCustomerId: customerId,
                stripeSubscriptionId: session.subscription,
                stripeCheckoutSessionId: session.id,
              });
            }
          } else if (session.mode === "setup") {
            if (order) {
              store.updateOrderStatus(order.id, "setup_completed", {
                stripeCustomerId: customerId,
                stripeCheckoutSessionId: session.id,
              });
            }

            if (stripeGateway?.createScheduleAfterPass) {
              const entitlements = store.listEntitlementsForUser(effectiveUserId);
              const activePass = entitlements.find((e) => e.source_type === "pass" && e.status === "active");
              const startDateSeconds = activePass?.ends_at
                ? Math.floor(activePass.ends_at / 1000)
                : Math.floor((getNow() + 30 * 86400000) / 1000);

              const prodCode = order?.product_code || session.metadata?.product_code || "standard_monthly";
              let priceId = null;
              try {
                priceId = catalog.getProduct(prodCode).priceId;
              } catch {}

              if (priceId && customerId) {
                let paymentMethodId = null;
                if (session.setup_intent) {
                  if (typeof stripeGateway.resolvePaymentMethodFromSetupIntent === "function") {
                    try {
                      paymentMethodId = await stripeGateway.resolvePaymentMethodFromSetupIntent(session.setup_intent);
                    } catch {}
                  } else if (typeof session.setup_intent === "object" && session.setup_intent.payment_method) {
                    paymentMethodId =
                      typeof session.setup_intent.payment_method === "string"
                        ? session.setup_intent.payment_method
                        : session.setup_intent.payment_method.id || null;
                  } else if (typeof session.setup_intent === "string" && session.setup_intent.startsWith("pm_")) {
                    paymentMethodId = session.setup_intent;
                  }
                }

                // A setup intent is not a payment method. Do not create a
                // schedule unless Stripe returned a concrete pm_ reference.
                if (!paymentMethodId || !String(paymentMethodId).startsWith("pm_")) {
                  const err = new Error("Setup intent did not produce a payment method");
                  err.code = "setup_payment_method_unavailable";
                  err.status = 502;
                  throw err;
                }

                const schedule = await stripeGateway.createScheduleAfterPass({
                  customerId,
                  priceId,
                  startDate: startDateSeconds,
                  orderId: order?.id || session.id,
                  userId: effectiveUserId,
                  productCode: prodCode,
                  paymentMethodId,
                  setupIntentId: typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id || null,
                });

                if (schedule?.id) {
                  if (order?.id) {
                    store.updateOrderStatus(order.id, "setup_completed", {
                      stripeScheduleId: schedule.id,
                    });
                  }
                  store.upsertSubscription({
                    stripeSubscriptionId: schedule.subscription || `sched_sub_${schedule.id}`,
                    stripeScheduleId: schedule.id,
                    userId: effectiveUserId,
                    productCode: prodCode,
                    status: "scheduled",
                    scheduledStartAt: startDateSeconds * 1000,
                    lastStripeEventCreated: eventCreated,
                  });
                }
              }
            }
          }
          break;
        }

        case "checkout.session.async_payment_failed": {
          const session = event.data?.object || {};
          const orderId = session.metadata?.order_id || session.metadata?.orderId || session.client_reference_id;
          let order = null;
          if (orderId) {
            order = store.getOrder(orderId);
          }
          if (!order && session.id) {
            order = store.getOrderByCheckoutSessionId(session.id);
          }
          if (order) {
            store.updateOrderStatus(order.id, "payment_failed");
          }
          break;
        }

        case "checkout.session.expired": {
          const session = event.data?.object || {};
          const orderId = session.metadata?.order_id || session.metadata?.orderId || session.client_reference_id;
          let order = null;
          if (orderId) {
            order = store.getOrder(orderId);
          }
          if (!order && session.id) {
            order = store.getOrderByCheckoutSessionId(session.id);
          }
          if (order && ["created", "pending", "checkout_open"].includes(order.status)) {
            store.updateOrderStatus(order.id, "expired");
          }
          break;
        }

        case "invoice.paid": {
          const invoice = event.data?.object || {};
          const subscriptionId = invoice.subscription;
          if (subscriptionId) {
            let sub = store.getSubscriptionByStripeId(subscriptionId);
            if (!sub) {
              const scheduleId = invoice.subscription_details?.metadata?.schedule_id || invoice.metadata?.schedule_id;
              if (scheduleId) {
                sub = store.getSubscriptionByScheduleId
                  ? store.getSubscriptionByScheduleId(scheduleId)
                  : store.listAllSubscriptions?.().find((s) => s.stripe_schedule_id === scheduleId);
              }
            }

            if (!sub) {
              const err = new Error(`Subscription not found for invoice: ${subscriptionId}`);
              err.code = "subscription_not_found";
              err.status = 422;
              throw err;
            }

            if (sub.last_stripe_event_created && eventCreated < sub.last_stripe_event_created) {
              break;
            }

            const periodEnd = invoice.lines?.data?.[0]?.period?.end
              ? invoice.lines.data[0].period.end * 1000
              : null;

            store.updateSubscriptionStatus(sub.stripe_subscription_id, {
              stripeSubscriptionId: subscriptionId,
              status: "active",
              currentPeriodEnd: periodEnd,
              lastStripeEventCreated: eventCreated,
            });

            entitlementService.activateSubscription({
              userId: sub.user_id,
              stripeSubscriptionId: subscriptionId,
              endsAt: periodEnd,
              productCode: sub.product_code || "standard_monthly",
            });
          }
          break;
        }

        case "invoice.payment_failed":
        case "invoice.payment_action_required": {
          const invoice = event.data?.object || {};
          const subscriptionId = invoice.subscription;
          if (subscriptionId) {
            let sub = store.getSubscriptionByStripeId(subscriptionId);
            if (!sub) {
              const scheduleId = invoice.subscription_details?.metadata?.schedule_id || invoice.metadata?.schedule_id;
              if (scheduleId) {
                sub = store.getSubscriptionByScheduleId
                  ? store.getSubscriptionByScheduleId(scheduleId)
                  : store.listAllSubscriptions?.().find((s) => s.stripe_schedule_id === scheduleId);
              }
            }

            if (!sub) {
              const err = new Error(`Subscription not found for invoice failure: ${subscriptionId}`);
              err.code = "subscription_not_found";
              err.status = 422;
              throw err;
            }

            if (sub.last_stripe_event_created && eventCreated < sub.last_stripe_event_created) {
              break;
            }

            store.updateSubscriptionStatus(sub.stripe_subscription_id, {
              stripeSubscriptionId: subscriptionId,
              status: "past_due",
              lastStripeEventCreated: eventCreated,
            });
            entitlementService.startGrace({ subscriptionId });
          }
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const subObj = event.data?.object || {};
          const subscriptionId = subObj.id;
          let existingSub = store.getSubscriptionByStripeId(subscriptionId);

          if (!existingSub) {
            const scheduleId = subObj.schedule || subObj.metadata?.schedule_id;
            if (scheduleId) {
              existingSub = store.getSubscriptionByScheduleId
                ? store.getSubscriptionByScheduleId(scheduleId)
                : store.listAllSubscriptions?.().find((s) => s.stripe_schedule_id === scheduleId);
            }
            if (!existingSub && (subObj.metadata?.order_id || subObj.metadata?.orderId)) {
              const orderId = subObj.metadata.order_id || subObj.metadata.orderId;
              const order = store.getOrder(orderId);
              if (order?.stripe_schedule_id) {
                existingSub = store.getSubscriptionByScheduleId
                  ? store.getSubscriptionByScheduleId(order.stripe_schedule_id)
                  : store.listAllSubscriptions?.().find((s) => s.stripe_schedule_id === order.stripe_schedule_id);
              }
            }
            if (!existingSub && (subObj.metadata?.user_id || subObj.metadata?.userId)) {
              const uId = Number(subObj.metadata.user_id || subObj.metadata.userId);
              const userSub = store.getSubscriptionByUserId(uId);
              if (userSub && userSub.status === "scheduled") {
                existingSub = userSub;
              }
            }
          }

          if (!existingSub) {
            const err = new Error(`Subscription not found for event: ${subscriptionId || "unknown"}`);
            err.code = "subscription_not_found";
            err.status = 422;
            throw err;
          }

          if (existingSub.last_stripe_event_created && eventCreated < existingSub.last_stripe_event_created) {
            break;
          }

          const currentPeriodStart = subObj.current_period_start ? subObj.current_period_start * 1000 : null;
          const currentPeriodEnd = subObj.current_period_end ? subObj.current_period_end * 1000 : null;

          store.updateSubscriptionStatus(existingSub.stripe_subscription_id, {
            stripeSubscriptionId: subscriptionId,
            status: subObj.status,
            cancelAtPeriodEnd: subObj.cancel_at_period_end ? 1 : 0,
            currentPeriodStart,
            currentPeriodEnd,
            lastStripeEventCreated: eventCreated,
          });

          if (subObj.status === "active" || subObj.status === "trialing") {
            entitlementService.activateSubscription({
              userId: existingSub.user_id,
              stripeSubscriptionId: subscriptionId,
              currentPeriodStart,
              currentPeriodEnd,
              endsAt: currentPeriodEnd,
              productCode: existingSub.product_code || subObj.metadata?.product_code || "standard_monthly",
            });
          } else if (subObj.status === "past_due" || subObj.status === "unpaid") {
            entitlementService.startGrace({ subscriptionId });
          } else if (subObj.status === "canceled") {
            const ent = store.getEntitlementBySource("subscription", subscriptionId) ||
              store.getEntitlementBySource("subscription", existingSub.stripe_subscription_id);
            if (ent) {
              store.updateEntitlementStatus(ent.id, "expired");
            }
          }
          if (subObj.cancel_at_period_end) {
            queueLifecycleNotifications({
              notificationKey: `subscription-canceled:${subscriptionId}`,
              template: "billing_subscription_canceled",
              userId: existingSub.user_id,
              payload: {
                subscriptionId,
                productCode: existingSub.product_code || subObj.metadata?.product_code || "standard_monthly",
                accessEndsAt: currentPeriodEnd,
                cancellationType: "period_end",
              },
            });
          } else if (eventType === "customer.subscription.created") {
            queueLifecycleNotifications({
              notificationKey: `subscription-created:${subscriptionId}`,
              template: "billing_subscription_created",
              userId: existingSub.user_id,
              payload: {
                subscriptionId,
                productCode: existingSub.product_code || subObj.metadata?.product_code || "standard_monthly",
                accessEndsAt: currentPeriodEnd,
              },
            });
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subObj = event.data?.object || {};
          const subscriptionId = subObj.id;
          let existingSub = store.getSubscriptionByStripeId(subscriptionId);
          if (!existingSub) {
            const scheduleId = subObj.schedule || subObj.metadata?.schedule_id;
            if (scheduleId) {
              existingSub = store.getSubscriptionByScheduleId
                ? store.getSubscriptionByScheduleId(scheduleId)
                : store.listAllSubscriptions?.().find((s) => s.stripe_schedule_id === scheduleId);
            }
          }

          if (!existingSub) {
            const err = new Error(`Subscription not found for deletion: ${subscriptionId || "unknown"}`);
            err.code = "subscription_not_found";
            err.status = 422;
            throw err;
          }

          if (existingSub.last_stripe_event_created && eventCreated < existingSub.last_stripe_event_created) {
            break;
          }

          store.updateSubscriptionStatus(existingSub.stripe_subscription_id, {
            stripeSubscriptionId: subscriptionId,
            status: "canceled",
            cancelAtPeriodEnd: 1,
            lastStripeEventCreated: eventCreated,
          });
          const ent = store.getEntitlementBySource("subscription", subscriptionId) ||
            store.getEntitlementBySource("subscription", existingSub.stripe_subscription_id);
          if (ent) {
            store.updateEntitlementStatus(ent.id, "expired");
          }
          queueLifecycleNotifications({
            notificationKey: `subscription-canceled:${subscriptionId}`,
            template: "billing_subscription_canceled",
            userId: existingSub.user_id,
            payload: {
              subscriptionId,
              productCode: existingSub.product_code || "standard_monthly",
              accessEndsAt: null,
              cancellationType: "immediate",
            },
          });
          break;
        }

        case "subscription_schedule.created": {
          const schedule = event.data?.object || {};
          const orderId = schedule.metadata?.order_id || schedule.metadata?.orderId;
          if (orderId && schedule.id) {
            const order = store.getOrder(orderId);
            if (order) {
              store.updateOrderStatus(order.id, order.status, {
                stripeScheduleId: schedule.id,
              });
            }
          }
          break;
        }

        case "subscription_schedule.canceled":
        case "subscription_schedule.aborted": {
          const schedule = event.data?.object || {};
          const scheduleId = schedule.id;
          if (scheduleId) {
            const allSubs = store.listAllSubscriptions ? store.listAllSubscriptions() : [];
            const matchingSub = allSubs.find((s) => s.stripe_schedule_id === scheduleId);
            if (matchingSub && matchingSub.status === "scheduled") {
              store.updateSubscriptionStatus(matchingSub.stripe_subscription_id, {
                status: "canceled",
              });
            }
          }
          break;
        }

        case "subscription_schedule.completed":
        case "subscription_schedule.released": {
          const schedule = event.data?.object || {};
          const targetSubscriptionId = schedule.released_subscription || schedule.subscription;
          const scheduleId = schedule.id;

          let matchingSub = null;
          if (scheduleId) {
            matchingSub = store.getSubscriptionByScheduleId
              ? store.getSubscriptionByScheduleId(scheduleId)
              : store.listAllSubscriptions?.().find((s) => s.stripe_schedule_id === scheduleId);
          }
          if (!matchingSub && targetSubscriptionId) {
            matchingSub = store.getSubscriptionByStripeId(targetSubscriptionId);
          }

          if (matchingSub) {
            const activeSubId = targetSubscriptionId || matchingSub.stripe_subscription_id;
            store.updateSubscriptionStatus(matchingSub.stripe_subscription_id, {
              stripeSubscriptionId: activeSubId,
              status: "active",
              lastStripeEventCreated: eventCreated,
            });
            entitlementService.activateSubscription({
              userId: matchingSub.user_id,
              stripeSubscriptionId: activeSubId,
              startsAt: getNow(),
              productCode: matchingSub.product_code || "standard_monthly",
            });
          } else if (scheduleId) {
            const err = new Error(`Subscription schedule not found: ${scheduleId}`);
            err.code = "schedule_not_found";
            err.status = 422;
            throw err;
          }
          break;
        }

        case "charge.refunded": {
          const charge = event.data?.object || {};
          const paymentIntentId = charge.payment_intent;
          const isFullRefund =
            Boolean(charge.refunded) ||
            (typeof charge.amount === "number" &&
              typeof charge.amount_refunded === "number" &&
              charge.amount_refunded >= charge.amount);

          if (paymentIntentId) {
            const order = store.getOrderByPaymentIntentId(paymentIntentId);
            if (order) {
              if (isFullRefund) {
                store.updateOrderStatus(order.id, "refunded", { refundedAt: getNow() });
                entitlementService.revokeRefundedEntitlement({
                  userId: order.user_id,
                  orderId: order.id,
                  subscriptionId: order.stripe_subscription_id,
                });
                queueLifecycleNotifications({
                  notificationKey: `refund:${order.id}`,
                  template: "billing_refund_completed",
                  userId: order.user_id,
                  payload: {
                    orderId: order.id,
                    productCode: order.product_code,
                    amountTotal: order.amount_total,
                    subscriptionId: order.stripe_subscription_id || null,
                  },
                });
              } else {
                // Partial refund: retain active entitlement access
                store.updateOrderStatus(order.id, order.status, {
                  amountTotal: typeof charge.amount === "number" && typeof charge.amount_refunded === "number"
                    ? charge.amount - charge.amount_refunded
                    : order.amount_total,
                });
              }
            }
          }
          break;
        }

        case "charge.refund.updated":
        case "refund.created":
        case "refund.updated": {
          const refundObj = event.data?.object || {};
          const paymentIntentId = refundObj.payment_intent;
          if (paymentIntentId) {
            const order = store.getOrderByPaymentIntentId(paymentIntentId);
            if (order) {
              if (refundObj.status === "succeeded") {
                const isFullRefund =
                  typeof order.amount_total === "number" && typeof refundObj.amount === "number"
                    ? refundObj.amount >= order.amount_total
                    : false;

                if (isFullRefund) {
                  store.updateOrderStatus(order.id, "refunded", { refundedAt: getNow() });
                  entitlementService.revokeRefundedEntitlement({
                    userId: order.user_id,
                    orderId: order.id,
                    subscriptionId: order.stripe_subscription_id,
                  });
                }
              } else if (refundObj.status === "failed" && order.status === "refund_pending") {
                store.updateOrderStatus(order.id, "refund_failed");
              }
            }
          }
          break;
        }
      }

      store.updateEventStatus(eventId, "processed");
      return { received: true, duplicate: false };
    } catch (err) {
      store.updateEventStatus(eventId, "failed", { lastErrorCode: err.message });
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
