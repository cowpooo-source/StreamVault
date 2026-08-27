"use strict";

function createReconciliationService(deps) {
  const { db, store, entitlementService, stripeGateway, connectionAccessService, now = Date.now } = deps;

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
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

        // Recompute effective access for user
        const effective = entitlementService.getEffectiveAccess(ent.user_id, ts);
        demotedUserIds.add(ent.user_id);

        if (db && typeof db.prepare === "function") {
          try {
            const limits = effective.limits || { maxConnections: 2 };
            db.prepare("UPDATE users SET role = @role, max_connections = @maxConnections WHERE id = @id").run({
              role: effective.role,
              maxConnections: limits.maxConnections || 2,
              id: ent.user_id,
            });
          } catch {}
        }

        if (connectionAccessService && typeof connectionAccessService.reconcileUser === "function") {
          connectionAccessService.reconcileUser(ent.user_id);
        }
      }
    }

    return {
      expiredCount,
      demotedUserIds: Array.from(demotedUserIds),
    };
  }

  async function reconcileStripeSubscriptions() {
    const ts = getNow();
    const subs = store.listAllSubscriptions();

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

          entitlementService.getEffectiveAccess(sub.user_id, ts);
          if (connectionAccessService && typeof connectionAccessService.reconcileUser === "function") {
            connectionAccessService.reconcileUser(sub.user_id);
          }
          resolvedDriftCount++;
        }
      } catch (err) {
        console.warn(`Failed to reconcile subscription ${sub.stripe_subscription_id}:`, err.message);
      }
    }

    return { syncedCount, resolvedDriftCount };
  }

  async function runFullReconciliation() {
    const grantsResult = await reconcileExpiredGrants();
    const subsResult = await reconcileStripeSubscriptions();

    const summary = {
      expiredGrants: grantsResult.expiredCount,
      demotedUsers: grantsResult.demotedUserIds.length,
      syncedSubs: subsResult.syncedCount,
      resolvedDrifts: subsResult.resolvedDriftCount,
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
    reconcileExpiredGrants,
    reconcileStripeSubscriptions,
    runFullReconciliation,
  };
}

module.exports = {
  createReconciliationService,
};
