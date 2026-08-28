"use strict";

function createReconciliationService(deps) {
  const { db, store, entitlementService, stripeGateway, connectionAccessService, supportService, now = Date.now } = deps;

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
  }

  function syncUserRoleAndLimits(userId, ts) {
    if (!entitlementService) return;
    const effective = entitlementService.getEffectiveAccess(userId, ts);
    if (db && typeof db.prepare === "function") {
      try {
        const limits = effective.limits || { maxConnections: 2 };
        db.prepare("UPDATE users SET role = @role, max_connections = @maxConnections WHERE id = @id").run({
          role: effective.role,
          maxConnections: limits.maxConnections || 2,
          id: userId,
        });
      } catch {}
    }

    if (connectionAccessService && typeof connectionAccessService.reconcileUser === "function") {
      connectionAccessService.reconcileUser(userId);
    }
    return effective;
  }

  async function reconcileScheduledEntitlements() {
    const ts = getNow();
    if (!store || typeof store.listDueScheduledEntitlements !== "function") {
      return { activatedCount: 0 };
    }

    const scheduled = store.listDueScheduledEntitlements(ts);
    let activatedCount = 0;

    for (const ent of scheduled) {
      store.updateEntitlementStatus(ent.id, "active");
      syncUserRoleAndLimits(ent.user_id, ts);
      activatedCount++;
    }

    return { activatedCount };
  }

  async function reconcileExpiredGrants() {
    const ts = getNow();
    const activeEntitlements = store.listActiveEntitlements();

    let expiredCount = 0;
    const demotedUserIds = new Set();

    for (const ent of activeEntitlements) {
      if (ent.ends_at !== null && ent.ends_at <= ts) {
        store.updateEntitlementStatus(ent.id, "expired");
        expiredCount++;

        syncUserRoleAndLimits(ent.user_id, ts);
        demotedUserIds.add(ent.user_id);
      }
    }

    return {
      expiredCount,
      demotedUserIds: Array.from(demotedUserIds),
    };
  }

  async function reconcileGracePeriods() {
    const ts = getNow();
    if (!store || typeof store.listExpiredGraceSubscriptions !== "function") {
      return { expiredGraceCount: 0 };
    }

    const expiredSubs = store.listExpiredGraceSubscriptions(ts);
    let expiredGraceCount = 0;

    for (const sub of expiredSubs) {
      store.updateSubscriptionStatus(sub.stripe_subscription_id, {
        status: "canceled",
        cancelAtPeriodEnd: 1,
      });

      const ent = store.getEntitlementBySource("subscription", sub.stripe_subscription_id);
      if (ent && ent.status === "active") {
        store.updateEntitlementStatus(ent.id, "expired");
      }

      syncUserRoleAndLimits(sub.user_id, ts);
      expiredGraceCount++;
    }

    return { expiredGraceCount };
  }

  async function reconcileStripeSubscriptions({ batchSize = 50 } = {}) {
    const ts = getNow();
    const subs = store.listSubscriptionsByStatus ? store.listSubscriptionsByStatus(batchSize) : store.listAllSubscriptions();

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

          syncUserRoleAndLimits(sub.user_id, ts);
          resolvedDriftCount++;
        }
      } catch (err) {
        console.warn(`Failed to reconcile subscription ${sub.stripe_subscription_id}:`, err.message);
      }
    }

    return { syncedCount, resolvedDriftCount };
  }

  async function reconcileStaleOrdersAndWebhooks() {
    const ts = getNow();
    const oneDayAgo = ts - 24 * 3600 * 1000;
    let staleOrdersFlagged = 0;

    if (store && typeof store.listStaleOrders === "function") {
      const staleOrders = store.listStaleOrders(oneDayAgo);
      for (const order of staleOrders) {
        store.updateOrderStatus(order.id, "abandoned");
        staleOrdersFlagged++;
      }
    }

    return { staleOrdersFlagged };
  }

  async function runFullReconciliation() {
    const scheduledResult = await reconcileScheduledEntitlements();
    const grantsResult = await reconcileExpiredGrants();
    const graceResult = await reconcileGracePeriods();
    const subsResult = await reconcileStripeSubscriptions();
    const staleResult = await reconcileStaleOrdersAndWebhooks();

    let outboxResult = { sentCount: 0, failedCount: 0 };
    if (supportService && typeof supportService.processOutbox === "function") {
      outboxResult = await supportService.processOutbox();
    }

    const summary = {
      activatedScheduled: scheduledResult.activatedCount,
      expiredGrants: grantsResult.expiredCount,
      demotedUsers: grantsResult.demotedUserIds.length,
      expiredGrace: graceResult.expiredGraceCount,
      syncedSubs: subsResult.syncedCount,
      resolvedDrifts: subsResult.resolvedDriftCount,
      staleOrdersFlagged: staleResult.staleOrdersFlagged,
      outboxSent: outboxResult.sentCount,
      timestamp: getNow(),
    };

    if (store && typeof store.recordAuditLog === "function") {
      store.recordAuditLog({
        action: "reconciliation_sweep",
        targetType: "system",
        details: summary,
      });
    }

    return summary;
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
