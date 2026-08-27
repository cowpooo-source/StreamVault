"use strict";

function createConnectionAccessService({ store, entitlementService, identityHmacKey = "", now = Date.now }) {
  if (!store) {
    throw new Error("store is required for connectionAccessService");
  }

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
  }

  function assertConnectionAllowed(userId, rawConnectionId) {
    if (!userId || String(userId).startsWith("guest:")) {
      return; // Guest connections handled by guest quotas
    }

    const numUserId = Number(userId);
    if (!numUserId || isNaN(numUserId)) return;

    if (entitlementService) {
      const effective = entitlementService.getEffectiveAccess(numUserId);
      const maxActive = effective?.limits?.maxConnections || 2;

      const connRecord = store.getConnectionAccess(numUserId, rawConnectionId);
      if (connRecord && connRecord.locked_at !== null) {
        const err = new Error("Connection is locked by plan limit");
        err.code = "connection_plan_locked";
        err.status = 403;
        throw err;
      }
    }
  }

  function recordSuccessfulConnectionUse(userId, rawConnectionId, usedAt = null) {
    if (!userId || String(userId).startsWith("guest:")) return;
    const numUserId = Number(userId);
    if (!numUserId || isNaN(numUserId)) return;

    store.recordConnectionUse(numUserId, rawConnectionId, usedAt || getNow());
  }

  function reconcileConnections({ userId, connectionIds = [], clientOrder = [] }) {
    const numUserId = Number(userId);
    const effective = entitlementService ? entitlementService.getEffectiveAccess(numUserId) : null;
    const maxActive = effective?.limits?.maxConnections || 2;
    const ts = getNow();

    const ids = Array.isArray(connectionIds) ? connectionIds : [];
    const clientOrderArr = Array.isArray(clientOrder) ? clientOrder : [];

    const items = ids.map((id, index) => {
      const rec = store.getConnectionAccess(numUserId, id);
      const clientIdx = clientOrderArr.indexOf(id);
      return {
        id,
        index,
        lastUsedAt: rec?.last_used_at || 0,
        selectedAt: rec?.selected_at || 0,
        clientOrderIdx: clientIdx >= 0 ? clientIdx : index,
        lockedAt: rec?.locked_at || null,
      };
    });

    if (items.length <= maxActive) {
      for (const item of items) {
        item.status = "active";
        if (item.lockedAt !== null) {
          store.updateConnectionLock(numUserId, item.id, { lockedAt: null, selectedAt: item.selectedAt });
        }
      }
    } else {
      // Sort to determine active vs locked
      const sorted = [...items].sort((a, b) => {
        // Priority 1: selectedAt (if user explicitly selected it recently)
        if (a.selectedAt !== b.selectedAt) {
          return b.selectedAt - a.selectedAt;
        }
        // Priority 2: lastUsedAt descending
        if (a.lastUsedAt !== b.lastUsedAt) {
          return b.lastUsedAt - a.lastUsedAt;
        }
        // Priority 3: clientOrderIdx ascending
        return a.clientOrderIdx - b.clientOrderIdx;
      });

      const activeSet = new Set(sorted.slice(0, maxActive).map((i) => i.id));

      for (const item of items) {
        if (activeSet.has(item.id)) {
          item.status = "active";
          if (item.lockedAt !== null) {
            store.updateConnectionLock(numUserId, item.id, { lockedAt: null, selectedAt: item.selectedAt });
          }
        } else {
          item.status = "locked_by_plan_limit";
          const lockTime = item.lockedAt || ts;
          store.updateConnectionLock(numUserId, item.id, { lockedAt: lockTime, selectedAt: null });
        }
      }
    }

    return {
      connections: items.map((item) => ({
        index: item.index,
        connectionId: item.id,
        status: item.status,
      })),
      maxActive,
    };
  }

  function selectConnection({ userId, selectConnectionId, deselectConnectionId }) {
    const numUserId = Number(userId);
    const ts = getNow();

    if (selectConnectionId) {
      store.updateConnectionLock(numUserId, selectConnectionId, { lockedAt: null, selectedAt: ts });
    }
    if (deselectConnectionId) {
      store.updateConnectionLock(numUserId, deselectConnectionId, { lockedAt: ts, selectedAt: null });
    }
    return { ok: true };
  }

  return {
    assertConnectionAllowed,
    recordSuccessfulConnectionUse,
    reconcileConnections,
    selectConnection,
  };
}

module.exports = {
  createConnectionAccessService,
};
