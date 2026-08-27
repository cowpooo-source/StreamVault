import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createBillingStore } from "../../src/services/billingStore.js";
import { createEntitlementService } from "../../src/services/entitlementService.js";

describe("entitlementService", () => {
  let db;
  let store;
  let service;
  let fixedNow = 1_700_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    db = new Database(":memory:");
    // Setup users table
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT,
        password_hash TEXT NOT NULL DEFAULT 'dummy',
        role TEXT NOT NULL DEFAULT 'free',
        max_connections INTEGER NOT NULL DEFAULT 2,
        created_at INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        email_verified INTEGER NOT NULL DEFAULT 0
      );
    `);

    store = createBillingStore({
      db,
      now: () => fixedNow,
      identityHmacKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    store.init();

    service = createEntitlementService({
      store,
      db,
      now: () => fixedNow,
      gracePeriodHours: 72,
    });
  });

  afterEach(() => {
    db?.close();
  });

  function createUser(username, role = "free") {
    const info = db.prepare("INSERT INTO users (username, role) VALUES (?, ?)").run(username, role);
    return { id: Number(info.lastInsertRowid), username, role };
  }

  describe("effective role and access precedence", () => {
    it("returns free limits and plan for free user without entitlements", () => {
      const freeUser = createUser("free_user", "free");
      const access = service.getEffectiveAccess(freeUser.id, fixedNow);

      expect(access).toMatchObject({
        role: "free",
        baseRole: "free",
        plan: "free",
        planSource: "base_role",
        billingStatus: "none",
        accessStartsAt: null,
        accessEndsAt: null,
        cancelAtPeriodEnd: false,
      });
      expect(access.limits.maxConnections).toBe(2);
      expect(access.limits.maxLogins).toBe(1);
    });

    it("returns admin access for base admin user regardless of entitlements", () => {
      const admin = createUser("admin_user", "admin");
      const access = service.getEffectiveAccess(admin.id, fixedNow);

      expect(access).toMatchObject({
        role: "admin",
        baseRole: "admin",
        plan: "admin",
        planSource: "base_role",
        billingStatus: "none",
      });
      expect(access.limits.maxConnections).toBe(999);
      expect(access.limits.maxLogins).toBe(999);
    });

    it("returns pro access for base pro user", () => {
      const pro = createUser("pro_user", "pro");
      const access = service.getEffectiveAccess(pro.id, fixedNow);

      expect(access).toMatchObject({
        role: "pro",
        baseRole: "pro",
        plan: "pro",
        planSource: "base_role",
        billingStatus: "none",
      });
      expect(access.limits.maxConnections).toBe(10);
      expect(access.limits.maxLogins).toBe(5);
    });

    it("returns grandfathered standard for base regular user", () => {
      const regular = createUser("regular_user", "regular");
      const access = service.getEffectiveAccess(regular.id, fixedNow);

      expect(access).toMatchObject({
        role: "regular",
        baseRole: "regular",
        plan: "standard",
        planSource: "grandfathered",
        billingStatus: "none",
      });
      expect(access.limits.maxConnections).toBe(5);
      expect(access.limits.maxLogins).toBe(3);
    });

    it("calculates effective regular role for free user with active pass", () => {
      const freeUser = createUser("pass_user", "free");
      service.activatePass({
        userId: freeUser.id,
        orderId: "ord_pass_1",
        startsAt: fixedNow,
        endsAt: fixedNow + 30 * DAY_MS,
      });

      const access = service.getEffectiveAccess(freeUser.id, fixedNow);
      expect(access).toMatchObject({
        role: "regular",
        baseRole: "free",
        plan: "standard",
        planSource: "paid",
        billingStatus: "active",
        accessStartsAt: fixedNow,
        accessEndsAt: fixedNow + 30 * DAY_MS,
        cancelAtPeriodEnd: false,
      });
      expect(access.limits.maxConnections).toBe(5);
      expect(access.limits.maxLogins).toBe(3);
    });

    it("calculates canceling status for active subscription with cancel_at_period_end", () => {
      const freeUser = createUser("sub_user", "free");
      service.activateSubscription({
        userId: freeUser.id,
        subscriptionId: "sub_1",
        productCode: "standard_monthly",
        currentPeriodStart: fixedNow,
        currentPeriodEnd: fixedNow + 30 * DAY_MS,
        cancelAtPeriodEnd: true,
      });

      const access = service.getEffectiveAccess(freeUser.id, fixedNow);
      expect(access).toMatchObject({
        role: "regular",
        baseRole: "free",
        plan: "standard",
        planSource: "paid",
        billingStatus: "canceling",
        cancelAtPeriodEnd: true,
      });
    });

    it("calculates grace status during active grace period", () => {
      const freeUser = createUser("grace_user", "free");
      service.activateSubscription({
        userId: freeUser.id,
        subscriptionId: "sub_grace_1",
        productCode: "standard_monthly",
        currentPeriodStart: fixedNow - 30 * DAY_MS,
        currentPeriodEnd: fixedNow,
        cancelAtPeriodEnd: false,
      });

      service.startGrace({
        userId: freeUser.id,
        subscriptionId: "sub_grace_1",
        graceUntil: fixedNow + 72 * 3600 * 1000,
      });

      const access = service.getEffectiveAccess(freeUser.id, fixedNow + 1000);
      expect(access).toMatchObject({
        role: "regular",
        baseRole: "free",
        plan: "standard",
        planSource: "paid",
        billingStatus: "grace",
      });
    });

    it("calculates complimentary standard for Friend & Family grant", () => {
      const freeUser = createUser("fnf_user", "free");
      service.grantFriendFamily({ userId: freeUser.id });

      const access = service.getEffectiveAccess(freeUser.id, fixedNow);
      expect(access).toMatchObject({
        role: "regular",
        baseRole: "free",
        plan: "standard",
        planSource: "complimentary",
        billingStatus: "active",
        accessEndsAt: null,
      });
    });

    it("returns guest access for non-existent/null userId", () => {
      const access = service.getEffectiveAccess(null, fixedNow);
      expect(access).toMatchObject({
        role: "guest",
        baseRole: "guest",
        plan: "free",
        planSource: "base_role",
        billingStatus: "none",
      });
      expect(access.limits.maxConnections).toBe(2);
    });
  });

  describe("lifecycle transitions and expiration", () => {
    it("expires elapsed entitlements when past ends_at", () => {
      const freeUser = createUser("exp_user", "free");
      service.activatePass({
        userId: freeUser.id,
        orderId: "ord_exp_1",
        startsAt: fixedNow - 31 * DAY_MS,
        endsAt: fixedNow - 1 * DAY_MS,
      });

      // Before running expiration sweep, effective access already recognizes end of validity
      expect(service.getEffectiveAccess(freeUser.id, fixedNow).role).toBe("free");

      // Run expiration sweep
      const expiredCount = service.expireElapsed(fixedNow);
      expect(expiredCount).toBeGreaterThanOrEqual(1);

      const ent = store.getEntitlementBySource("pass", "ord_exp_1");
      expect(ent.status).toBe("expired");
    });

    it("revokes entitlement on full refund", () => {
      const freeUser = createUser("ref_user", "free");
      service.activatePass({
        userId: freeUser.id,
        orderId: "ord_ref_1",
        startsAt: fixedNow,
        endsAt: fixedNow + 30 * DAY_MS,
      });

      service.revokeRefundedEntitlement({
        userId: freeUser.id,
        orderId: "ord_ref_1",
      });

      const access = service.getEffectiveAccess(freeUser.id, fixedNow);
      expect(access.role).toBe("free");

      const ent = store.getEntitlementBySource("pass", "ord_ref_1");
      expect(ent.status).toBe("refunded");
    });
  });
});
