"use strict";

const ROLE_LIMITS = Object.freeze({
  admin:   { maxConnections: 999, maxVod: Infinity, epg: true, sync: true, maxLogins: 999 },
  pro:     { maxConnections: 10,  maxVod: Infinity, epg: true, sync: true, maxLogins: 5 },
  regular: { maxConnections: 5,   maxVod: Infinity, epg: true, sync: true, maxLogins: 3 },
  free:    { maxConnections: 2,   maxVod: 500,      epg: true, sync: true, maxLogins: 1 },
  guest:   { maxConnections: 2,   maxVod: 500,      epg: true, sync: true, maxLogins: 1 },
});

function createEntitlementService({ store, db, now = Date.now, gracePeriodHours = 72 }) {
  if (!store) {
    throw new Error("store is required for entitlementService");
  }

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
  }

  function getUserRecord(userId) {
    if (!userId) return null;
    if (db) {
      return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    }
    return null;
  }

  function getEffectiveAccess(userId, currentNow = null) {
    const ts = currentNow !== null ? currentNow : getNow();

    if (!userId) {
      return {
        role: "guest",
        baseRole: "guest",
        plan: "free",
        planSource: "base_role",
        billingStatus: "none",
        accessStartsAt: null,
        accessEndsAt: null,
        nextBillingAt: null,
        cancelAtPeriodEnd: false,
        limits: ROLE_LIMITS.guest,
      };
    }

    const user = getUserRecord(userId);
    if (!user) {
      return {
        role: "guest",
        baseRole: "guest",
        plan: "free",
        planSource: "base_role",
        billingStatus: "none",
        accessStartsAt: null,
        accessEndsAt: null,
        nextBillingAt: null,
        cancelAtPeriodEnd: false,
        limits: ROLE_LIMITS.guest,
      };
    }

    const baseRole = user.role || "free";

    // 1. Admin
    if (baseRole === "admin") {
      return {
        role: "admin",
        baseRole: "admin",
        plan: "admin",
        planSource: "base_role",
        billingStatus: "none",
        accessStartsAt: user.created_at || null,
        accessEndsAt: null,
        nextBillingAt: null,
        cancelAtPeriodEnd: false,
        limits: ROLE_LIMITS.admin,
      };
    }

    // 2. Pro
    if (baseRole === "pro") {
      return {
        role: "pro",
        baseRole: "pro",
        plan: "pro",
        planSource: "base_role",
        billingStatus: "none",
        accessStartsAt: user.created_at || null,
        accessEndsAt: null,
        nextBillingAt: null,
        cancelAtPeriodEnd: false,
        limits: ROLE_LIMITS.pro,
      };
    }

    // 3. Regular (Grandfathered)
    if (baseRole === "regular") {
      return {
        role: "regular",
        baseRole: "regular",
        plan: "standard",
        planSource: "grandfathered",
        billingStatus: "none",
        accessStartsAt: user.created_at || null,
        accessEndsAt: null,
        nextBillingAt: null,
        cancelAtPeriodEnd: false,
        limits: ROLE_LIMITS.regular,
      };
    }

    // 4. Base Free user — evaluate local entitlements ledger
    const entitlements = store.listEntitlementsForUser(user.id);
    const subscription = store.getSubscriptionByUserId(user.id);

    // Active entitlements (currently valid in time)
    const activeEntitlement = entitlements.find(
      (e) =>
        e.status === "active" &&
        e.starts_at <= ts &&
        (e.ends_at === null || e.ends_at > ts)
    );

    if (activeEntitlement) {
      const isFnF = activeEntitlement.source_type === "friend_family";
      const isCanceling = Boolean(subscription && subscription.cancel_at_period_end);
      const nextBillingAt =
        subscription && !isCanceling && subscription.current_period_end && subscription.current_period_end > ts
          ? subscription.current_period_end
          : null;

      return {
        role: "regular",
        baseRole: "free",
        plan: "standard",
        planSource: isFnF ? "complimentary" : "paid",
        billingStatus: isCanceling ? "canceling" : "active",
        accessStartsAt: activeEntitlement.starts_at,
        accessEndsAt: activeEntitlement.ends_at,
        nextBillingAt,
        cancelAtPeriodEnd: isCanceling,
        limits: ROLE_LIMITS.regular,
      };
    }

    // Grace entitlements
    const graceEntitlement = entitlements.find(
      (e) =>
        e.status === "grace" &&
        e.starts_at <= ts &&
        (e.ends_at === null || e.ends_at > ts)
    );

    if (graceEntitlement) {
      return {
        role: "regular",
        baseRole: "free",
        plan: "standard",
        planSource: "paid",
        billingStatus: "grace",
        accessStartsAt: graceEntitlement.starts_at,
        accessEndsAt: graceEntitlement.ends_at,
        nextBillingAt: null,
        cancelAtPeriodEnd: Boolean(subscription && subscription.cancel_at_period_end),
        limits: ROLE_LIMITS.regular,
      };
    }

    // Scheduled entitlement / subscription in the future
    const scheduledEntitlement = entitlements.find(
      (e) => e.status === "scheduled" || (e.status === "active" && e.starts_at > ts)
    );

    const hasPastEntitlements = entitlements.some(
      (e) => e.status === "expired" || (e.ends_at !== null && e.ends_at <= ts)
    );

    let billingStatus = "none";
    if (scheduledEntitlement || (subscription && subscription.status === "scheduled")) {
      billingStatus = "scheduled";
    } else if (hasPastEntitlements) {
      billingStatus = "expired";
    }

    return {
      role: "free",
      baseRole: "free",
      plan: "free",
      planSource: "base_role",
      billingStatus,
      accessStartsAt: null,
      accessEndsAt: null,
      nextBillingAt: null,
      cancelAtPeriodEnd: false,
      limits: ROLE_LIMITS.free,
    };
  }

  function activatePass({ userId, orderId, startsAt = null, endsAt = null }) {
    const ts = getNow();
    const start = startsAt || ts;
    const end = endsAt || start + 30 * 24 * 60 * 60 * 1000;

    // Check if entitlement already exists
    const existing = store.getEntitlementBySource("pass", orderId);
    if (existing) {
      store.updateEntitlementStatus(existing.id, "active", { startsAt: start, endsAt: end });
      return store.getEntitlement(existing.id);
    }

    return store.createEntitlement({
      userId,
      tier: "standard",
      sourceType: "pass",
      sourceId: orderId,
      status: "active",
      startsAt: start,
      endsAt: end,
    });
  }

  function activateSubscription({
    userId,
    subscriptionId,
    stripeSubscriptionId,
    productCode = "standard_monthly",
    currentPeriodStart,
    currentPeriodEnd,
    startsAt,
    endsAt,
    cancelAtPeriodEnd = false,
    lastStripeEventCreated = 0,
  }) {
    const subId = subscriptionId || stripeSubscriptionId;
    const start = startsAt !== undefined ? startsAt : currentPeriodStart || getNow();
    const end = endsAt !== undefined ? endsAt : currentPeriodEnd || null;

    store.upsertSubscription({
      userId,
      productCode,
      stripeSubscriptionId: subId,
      status: "active",
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: cancelAtPeriodEnd ? 1 : 0,
      lastStripeEventCreated,
    });

    const existing = store.getEntitlementBySource("subscription", subId);
    if (existing) {
      store.updateEntitlementStatus(existing.id, "active", {
        startsAt: start,
        endsAt: end,
      });
      return store.getEntitlement(existing.id);
    }

    return store.createEntitlement({
      userId,
      tier: "standard",
      sourceType: "subscription",
      sourceId: subId,
      status: "active",
      startsAt: start,
      endsAt: end,
    });
  }

  function scheduleSubscription({ userId, subscriptionId, scheduleId, productCode, scheduledStartAt }) {
    store.upsertSubscription({
      userId,
      productCode,
      stripeSubscriptionId: subscriptionId,
      stripeScheduleId: scheduleId,
      status: "scheduled",
      scheduledStartAt,
      cancelAtPeriodEnd: 0,
    });

    const existing = store.getEntitlementBySource("subscription", subscriptionId);
    if (existing) {
      store.updateEntitlementStatus(existing.id, "scheduled", {
        startsAt: scheduledStartAt,
        endsAt: null,
      });
      return store.getEntitlement(existing.id);
    }

    return store.createEntitlement({
      userId,
      tier: "standard",
      sourceType: "subscription",
      sourceId: subscriptionId,
      status: "scheduled",
      startsAt: scheduledStartAt,
      endsAt: null,
    });
  }

  function startGrace({ userId, subscriptionId, graceUntil = null }) {
    const ts = getNow();
    const graceEnd = graceUntil || ts + gracePeriodHours * 3600 * 1000;

    store.updateSubscriptionStatus(subscriptionId, {
      status: "grace",
      graceUntil: graceEnd,
    });

    const existing = store.getEntitlementBySource("subscription", subscriptionId);
    if (existing) {
      store.updateEntitlementStatus(existing.id, "grace", {
        endsAt: graceEnd,
      });
      return store.getEntitlement(existing.id);
    }

    return null;
  }

  function expireElapsed(currentNow = null) {
    const ts = currentNow !== null ? currentNow : getNow();
    let count = 0;

    // Find all active or grace entitlements where ends_at <= ts
    if (db) {
      const dueEntitlements = db
        .prepare(
          `SELECT id FROM billing_entitlements
           WHERE status IN ('active', 'grace') AND ends_at IS NOT NULL AND ends_at <= ?`
        )
        .all(ts);

      for (const ent of dueEntitlements) {
        store.updateEntitlementStatus(ent.id, "expired");
        count++;
      }
    }
    return count;
  }

  function revokeRefundedEntitlement({ userId, orderId, subscriptionId }) {
    if (orderId) {
      const ent = store.getEntitlementBySource("pass", orderId);
      if (ent) {
        store.updateEntitlementStatus(ent.id, "refunded");
      }
    }
    if (subscriptionId) {
      const ent = store.getEntitlementBySource("subscription", subscriptionId);
      if (ent) {
        store.updateEntitlementStatus(ent.id, "refunded");
      }
      store.updateSubscriptionStatus(subscriptionId, {
        status: "canceled",
        cancelAtPeriodEnd: 1,
      });
    }
  }

  function grantFriendFamily({ userId, role = "regular", durationDays = null, reason = "Admin grant", grantedBy = null }) {
    const ts = getNow();
    const sourceId = `admin_grant:${userId}`;
    const endsAt = typeof durationDays === "number" && durationDays > 0 ? ts + durationDays * 86400 * 1000 : null;
    const existing = store.getEntitlementBySource("friend_family", sourceId);

    let ent;
    if (existing) {
      store.updateEntitlementStatus(existing.id, "active", { startsAt: ts, endsAt });
      ent = store.getEntitlement(existing.id);
    } else {
      ent = store.createEntitlement({
        userId,
        tier: role === "pro" ? "pro" : "standard",
        sourceType: "friend_family",
        sourceId,
        status: "active",
        startsAt: ts,
        endsAt,
      });
    }

    if (store && typeof store.recordAuditLog === "function") {
      store.recordAuditLog({
        action: "grant_friend_family",
        targetType: "user",
        targetId: userId,
        actorId: grantedBy,
        details: { role, durationDays, reason },
      });
    }

    return ent;
  }

  function revokeFriendFamily({ userId, revokedBy = null, reason = "Admin revoke" }) {
    const sourceId = `admin_grant:${userId}`;
    const existing = store.getEntitlementBySource("friend_family", sourceId);
    if (existing) {
      store.updateEntitlementStatus(existing.id, "revoked");
      if (store && typeof store.recordAuditLog === "function") {
        store.recordAuditLog({
          action: "revoke_friend_family",
          targetType: "user",
          targetId: userId,
          actorId: revokedBy,
          details: { reason },
        });
      }
      return store.getEntitlement(existing.id);
    }
    return null;
  }

  return {
    ROLE_LIMITS,
    getEffectiveAccess,
    activatePass,
    activateSubscription,
    scheduleSubscription,
    startGrace,
    expireElapsed,
    revokeRefundedEntitlement,
    grantFriendFamily,
    revokeFriendFamily,
  };
}

module.exports = {
  ROLE_LIMITS,
  createEntitlementService,
};
