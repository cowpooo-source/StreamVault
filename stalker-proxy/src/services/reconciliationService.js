"use strict";

function createReconciliationService(deps) {
  const { db, store, entitlementService, stripeGateway, connectionAccessService, supportService, now = Date.now } = deps;

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
  }

  let isReconciling = false;

  function syncUserEntitlementsAndLocks(userId, ts) {
    if (!entitlementService) return;
    const effective = entitlementService.getEffectiveAccess(userId, ts);

    // Enforce connection limits and locks for demoted or adjusted tiers without modifying users.role
    if (connectionAccessService && typeof connectionAccessService.reconcileUser === "function") {
      connectionAccessService.reconcileUser(userId);
    }
    return effective;
  }

  async function reconcileScheduledEntitlements({ userId = null } = {}) {
    const ts = getNow();
    if (!store || typeof store.listDueScheduledEntitlements !== "function") {
      return { activatedCount: 0 };
    }

    const scheduled = store.listDueScheduledEntitlements(ts);
    const filtered = userId ? scheduled.filter((e) => e.user_id === Number(userId)) : scheduled;
    let activatedCount = 0;

    for (const ent of filtered) {
      store.updateEntitlementStatus(ent.id, "active");
      syncUserEntitlementsAndLocks(ent.user_id, ts);
      activatedCount++;
    }

    return { activatedCount };
  }

  async function reconcileExpiredGrants({ userId = null } = {}) {
    const ts = getNow();
    const activeEntitlements = store.listActiveEntitlements();
    const filtered = userId ? activeEntitlements.filter((e) => e.user_id === Number(userId)) : activeEntitlements;

    let expiredCount = 0;
    const demotedUserIds = new Set();

    for (const ent of filtered) {
      if (ent.ends_at !== null && ent.ends_at <= ts) {
        store.updateEntitlementStatus(ent.id, "expired");
        expiredCount++;

        syncUserEntitlementsAndLocks(ent.user_id, ts);
        demotedUserIds.add(ent.user_id);
      }
    }

    return {
      expiredCount,
      demotedUserIds: Array.from(demotedUserIds),
    };
  }

  async function reconcileGracePeriods({ userId = null } = {}) {
    const ts = getNow();
    if (!store || typeof store.listExpiredGraceSubscriptions !== "function") {
      return { expiredGraceCount: 0 };
    }

    const expiredSubs = store.listExpiredGraceSubscriptions(ts);
    const filtered = userId ? expiredSubs.filter((s) => s.user_id === Number(userId)) : expiredSubs;
    let expiredGraceCount = 0;

    for (const sub of filtered) {
      store.updateSubscriptionStatus(sub.stripe_subscription_id, {
        status: "canceled",
        cancelAtPeriodEnd: 1,
      });

      const ent = store.getEntitlementBySource("subscription", sub.stripe_subscription_id);
      if (ent && ent.status === "active") {
        store.updateEntitlementStatus(ent.id, "expired");
      }

      syncUserEntitlementsAndLocks(sub.user_id, ts);
      expiredGraceCount++;
    }

    return { expiredGraceCount };
  }

  async function reconcileStripeSubscriptions({ userId = null, stripeSubscriptionId = null, batchSize = 50 } = {}) {
    const ts = getNow();
    let subs = [];

    if (stripeSubscriptionId) {
      const single = store.getSubscriptionByStripeId(stripeSubscriptionId);
      if (single) subs = [single];
    } else if (userId) {
      const userSub = store.getSubscriptionByUserId(Number(userId));
      if (userSub) subs = [userSub];
    } else {
      subs = store.listSubscriptionsByStatus ? store.listSubscriptionsByStatus(batchSize) : store.listAllSubscriptions();
    }

    let syncedCount = 0;
    let resolvedDriftCount = 0;

    for (const sub of subs) {
      if (!sub.stripe_subscription_id || !stripeGateway || typeof stripeGateway.retrieveSubscription !== "function") {
        continue;
      }

      try {
        const stripeSub = await stripeGateway.retrieveSubscription(sub.stripe_subscription_id);
        if (!stripeSub) continue;
        syncedCount++;

        if (stripeSub.status === "canceled" && sub.status !== "canceled") {
          store.updateSubscriptionStatus(sub.stripe_subscription_id, {
            status: "canceled",
            cancelAtPeriodEnd: 1,
          });

          // Expire active subscription entitlement if period ended
          const ent = store.getEntitlementBySource("subscription", sub.stripe_subscription_id);
          if (ent && ent.status === "active") {
            store.updateEntitlementStatus(ent.id, "expired");
          }

          syncUserEntitlementsAndLocks(sub.user_id, ts);
          resolvedDriftCount++;
        }
      } catch (err) {
        console.warn(`Failed to reconcile subscription ${sub.stripe_subscription_id}:`, err.message);
      }
    }

    return { syncedCount, resolvedDriftCount };
  }

  async function reconcileStaleOrdersAndWebhooks({ orderId = null } = {}) {
    const ts = getNow();
    const oneDayAgo = ts - 24 * 3600 * 1000;
    let staleOrdersFlagged = 0;
    let staleWebhooksFlagged = 0;

    if (orderId) {
      const ord = store.getOrder(orderId);
      if (ord && (ord.status === "created" || ord.status === "pending") && ord.created_at <= oneDayAgo) {
        store.updateOrderStatus(ord.id, "abandoned");
        staleOrdersFlagged++;
      }
    } else if (store && typeof store.listStaleOrders === "function") {
      const staleOrders = store.listStaleOrders(oneDayAgo);
      for (const order of staleOrders) {
        store.updateOrderStatus(order.id, "abandoned");
        staleOrdersFlagged++;
      }
    }

    // Reconcile stale or unacknowledged webhook events
    if (store && typeof store.listStaleWebhookEvents === "function") {
      const staleEvents = store.listStaleWebhookEvents(ts, 50);
      for (const ev of staleEvents) {
        if (typeof store.markEventDeadLetter === "function") {
          store.markEventDeadLetter(ev.stripe_event_id || ev.id);
        }
        staleWebhooksFlagged++;
      }
    }

    return { staleOrdersFlagged, staleWebhooksFlagged };
  }

  async function runFullReconciliation(target = {}) {
    if (isReconciling) {
      return { skipped: true, reason: "reconciliation_already_running", timestamp: getNow() };
    }
    isReconciling = true;

    try {
      const { userId = null, orderId = null, stripeSubscriptionId = null, subscriptionId = null } = target || {};
      const subId = stripeSubscriptionId || subscriptionId;

      const scheduledResult = await reconcileScheduledEntitlements({ userId });
      const grantsResult = await reconcileExpiredGrants({ userId });
      const graceResult = await reconcileGracePeriods({ userId });
      const subsResult = await reconcileStripeSubscriptions({ userId, stripeSubscriptionId: subId });
      const staleResult = await reconcileStaleOrdersAndWebhooks({ orderId });

      let outboxResult = { sentCount: 0, failedCount: 0 };
      if (!userId && !orderId && !subId && supportService && typeof supportService.processOutbox === "function") {
        outboxResult = await supportService.processOutbox();
      }

      const summary = {
        target: userId ? `user:${userId}` : orderId ? `order:${orderId}` : subId ? `sub:${subId}` : "global",
        activatedScheduled: scheduledResult.activatedCount,
        expiredGrants: grantsResult.expiredCount,
        demotedUsers: grantsResult.demotedUserIds.length,
        expiredGrace: graceResult.expiredGraceCount,
        syncedSubs: subsResult.syncedCount,
        resolvedDrifts: subsResult.resolvedDriftCount,
        staleOrdersFlagged: staleResult.staleOrdersFlagged,
        staleWebhooksFlagged: staleResult.staleWebhooksFlagged,
        outboxSent: outboxResult.sentCount,
        timestamp: getNow(),
      };

      if (store && typeof store.recordAuditLog === "function") {
        store.recordAuditLog({
          action: "reconciliation_sweep",
          targetType: summary.target === "global" ? "system" : "target",
          targetId: summary.target,
          details: summary,
        });
      }

      return summary;
    } finally {
      isReconciling = false;
    }
  }

  return {
    reconcileScheduledEntitlements,
    reconcileExpiredGrants,
    reconcileGracePeriods,
    reconcileStripeSubscriptions,
    reconcileStaleOrdersAndWebhooks,
    runFullReconciliation,
  };
}

module.exports = {
  createReconciliationService,
};
