# Standard Billing, Entitlements, Refunds, and Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a disabled-by-default, Stripe-backed Standard subscription system with auditable entitlement enforcement, safe downgrades, refunds, and authenticated support on the HTTPS application.

**Architecture:** Stripe is authoritative for payment objects; SQLite stores a local, idempotent billing projection and entitlement ledger that every request can read without calling Stripe. The HTTPS app owns billing, account, connection management, and support; the HTTP content app remains playback-only and links back to HTTPS without credentials. Existing `users.role` stays the permanent base role while the effective role is calculated from base role plus active entitlements.

**Tech Stack:** Node.js 22, Express 4, better-sqlite3, Stripe Node SDK, Brevo email, Discord webhook outbox, React 19, Vite, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-27-standard-billing-support-design.md`

## Global Constraints

- Preserve all existing working-tree changes; stage only files belonging to each task.
- Do not route provider media, playback, provider credentials, or content tokens through billing services.
- `BILLING_ENABLED=false` is the default. Missing or incomplete billing configuration must not break login, setup, content sessions, or playback.
- Accept only server-defined product codes: `standard_pass_30d`, `standard_monthly`, and `standard_yearly`; never accept browser price IDs, amounts, currencies, user IDs, or dates.
- Public UI lists only `Free` and `Standard`; never expose `Friend & Family` or `Pro` as public choices.
- Use USD prices: pass `$3.99`, monthly `$2.99`, yearly `$29.99`; Stripe Checkout collects billing address, uses automatic tax, and requires terms consent.
- Keep `users.role` unchanged during billing migrations. Existing `regular`, `pro`, and `admin` users retain their current access; new registrations remain `free`.
- State-changing HTTPS routes require current authentication, same-origin validation, and CSRF validation. The Stripe webhook instead requires raw-body signature verification.
- Never persist or log raw connection IDs, Stripe secrets, raw webhook payloads, Discord webhook URLs, payment methods, provider credentials, or content-session tokens.
- Use `SUPPORT_EMAIL=support@portalheaven.stream`; keep `SUPPORT_DISCORD_WEBHOOK_URL` distinct from `ALERT_WEBHOOK_URL`.
- Keep HTTP `playerportal.hopto.org/content` free of Stripe SDK loading, billing/support API calls, account mutations, and account JWTs.
- Do not deploy or enable `BILLING_ENABLED` during implementation. Use Stripe test mode only for the manual verification task.

---

## File Structure

### Backend

- Create `stalker-proxy/src/services/billingCatalog.js` - fixed public product metadata and validated environment-to-Price-ID mapping.
- Create `stalker-proxy/src/services/billingStore.js` - additive SQLite schema and all billing prepared statements/transactions.
- Create `stalker-proxy/src/services/entitlementService.js` - effective access calculation and state transitions independent of Stripe.
- Create `stalker-proxy/src/services/connectionAccessService.js` - HMAC connection identities, limit locks, selection, and session enforcement.
- Create `stalker-proxy/src/services/stripeGateway.js` - sole Stripe SDK adapter.
- Create `stalker-proxy/src/services/stripeEventProcessor.js` - signature-safe, idempotent Stripe event projection.
- Create `stalker-proxy/src/services/notificationOutboxService.js` - persistent, sanitized Brevo/Discord delivery with retry.
- Create `stalker-proxy/src/services/supportService.js` - ticket validation, persistence, and outbox enqueueing.
- Create `stalker-proxy/src/services/billingReconciler.js` - startup/periodic local expiry, grace, schedule, lock, and outbox work.
- Replace `stalker-proxy/src/routes/billing.js` - authenticated billing API only; webhook is mounted separately in `app.js`.
- Create `stalker-proxy/src/routes/accountConnections.js` and `stalker-proxy/src/routes/support.js` - HTTPS-only account APIs.
- Modify `stalker-proxy/src/app.js`, `src/index.js`, `src/auth.js`, `src/routes/contentSession.js`, `src/email.js`, `.env.example` - dependency wiring, raw webhook order, effective access, connection checks, templates, and safe configuration logging.

### Frontend

- Create `streamvault/src/billing-api.js` - normalized same-origin billing/support client.
- Create `streamvault/src/components/AccountStatusCard.jsx`, `BillingSettings.jsx`, and `SupportSettings.jsx` - secure account UI.
- Modify `streamvault/src/components/SettingsView.jsx` and `streamvault/src/App.jsx` - HTTPS settings tabs, content-mode reduction, entitlement-aware connection UI, and secure redirects.
- Create versioned static policy pages under `streamvault/public/legal/` and modify the landing/app routes only to link to stable HTTPS policy URLs.

### Tests and Operations

- Replace `stalker-proxy/tests/routes/billing.test.js` and add focused service/router tests under `stalker-proxy/tests/services/` and `stalker-proxy/tests/routes/`.
- Add frontend component/API tests under `streamvault/tests/` and billing Playwright coverage under `streamvault/e2e/` using mocked Stripe/test fixtures only.
- Modify `stalker-proxy/.env.example`, `stalker-proxy/README.md`, `streamvault/README.md`, and add `docs/runbooks/stripe-standard-billing.md` for operations, Stripe configuration, rollback, and reconciliation.

## Shared Contracts

```js
// entitlementService.js
getEffectiveAccess(userId, now = Date.now())
// => { role, baseRole, plan, planSource, billingStatus, accessStartsAt,
//      accessEndsAt, nextBillingAt, cancelAtPeriodEnd, limits }

// connectionAccessService.js
assertConnectionAllowed(userId, connectionId)
// throws { code: "connection_plan_locked", status: 403 } for a locked ID

reconcileConnections({ userId, connectionIds, clientOrder })
// => { connections: [{ index, status: "active" | "locked_by_plan_limit" }], maxActive }

// billingCatalog.js
getProduct(productCode)
// => { code, mode, priceId, currency: "usd", amount, interval, display }

// billingRouter request body
{ productCode, acceptedPolicyVersions: { terms, privacy, refund } }
```

### Task 1: Add Billing Configuration and Fixed Product Catalog

**Files:**
- Create: `stalker-proxy/src/services/billingCatalog.js`
- Create: `stalker-proxy/tests/services/billingCatalog.test.js`
- Modify: `stalker-proxy/.env.example`
- Modify: `stalker-proxy/src/index.js`

**Interfaces:**
- Produces `createBillingCatalog(env)` and `billingConfigStatus(env)`.
- `createBillingCatalog` throws only at billing-route initialization when enabled configuration is incomplete; disabled mode returns `{ enabled: false, products: [] }`.

- [ ] **Step 1: Write failing catalog tests for fixed products and disabled mode.**

```js
expect(createBillingCatalog({ BILLING_ENABLED: "false" })).toMatchObject({ enabled: false });
expect(createBillingCatalog(enabledEnv).getProduct("standard_monthly")).toMatchObject({
  mode: "subscription", currency: "usd", amount: 299, interval: "month",
});
expect(() => createBillingCatalog({ ...enabledEnv, STRIPE_PRICE_STANDARD_MONTHLY: "" }))
  .toThrow(/STRIPE_PRICE_STANDARD_MONTHLY/);
expect(() => catalog.getProduct("price_from_browser")).toThrow(/billing_product_invalid/);
```

- [ ] **Step 2: Run the focused test to verify it fails.**

Run: `cd stalker-proxy; npm test -- tests/services/billingCatalog.test.js`

Expected: FAIL because `billingCatalog.js` does not exist.

- [ ] **Step 3: Implement the fixed catalog.**

```js
const PRODUCTS = Object.freeze({
  standard_pass_30d: { mode: "payment", amount: 399, interval: null },
  standard_monthly: { mode: "subscription", amount: 299, interval: "month" },
  standard_yearly: { mode: "subscription", amount: 2999, interval: "year" },
});

function getProduct(code) {
  const product = products[code];
  if (!product) throw billingError("Invalid billing product", "billing_product_invalid", 400);
  return product;
}
```

Require `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, all three Price IDs, policy versions/URLs, and `STRIPE_LIVE_MODE` only when `BILLING_ENABLED=true`. Add placeholder names only to `.env.example`. Make `index.js` log booleans/capability names, never secret values.

- [ ] **Step 4: Run focused tests.**

Run: `cd stalker-proxy; npm test -- tests/services/billingCatalog.test.js`

Expected: PASS.

- [ ] **Step 5: Commit only this task.**

```bash
git add stalker-proxy/src/services/billingCatalog.js stalker-proxy/tests/services/billingCatalog.test.js stalker-proxy/.env.example stalker-proxy/src/index.js
git commit -m "feat: add fixed standard billing catalog"
```

### Task 2: Add Additive SQLite Billing Storage and Policy Records

**Files:**
- Create: `stalker-proxy/src/services/billingStore.js`
- Create: `stalker-proxy/tests/services/billingStore.test.js`
- Modify: `stalker-proxy/src/auth.js`

**Interfaces:**
- Consumes a `better-sqlite3` database initialized by `auth.init(cache.db)`.
- Produces `createBillingStore({ db, now, identityHmacKey })` with transactional order/event/entitlement/customer/subscription/connection/ticket/outbox methods.

- [ ] **Step 1: Write failing schema and idempotency tests.**

```js
const store = createBillingStore({ db, now: () => 1_700_000_000_000, identityHmacKey: "a".repeat(64) });
store.init(); store.init();
const order = store.createOrder({ userId: 7, productCode: "standard_pass_30d", checkoutMode: "payment", priceId: "price_pass" });
expect(store.claimEvent({ stripeEventId: "evt_1", eventType: "invoice.paid", livemode: false, stripeCreatedAt: 1 })).toBe(true);
expect(store.claimEvent({ stripeEventId: "evt_1", eventType: "invoice.paid", livemode: false, stripeCreatedAt: 1 })).toBe(false);
expect(store.getOrder(order.id).currency).toBe("usd");
```

- [ ] **Step 2: Run the focused test to verify it fails.**

Run: `cd stalker-proxy; npm test -- tests/services/billingStore.test.js`

Expected: FAIL because the store is absent.

- [ ] **Step 3: Implement idempotent additive schema and prepared statements.**

Create exactly the tables and constraints in the approved spec: `billing_customers`, `billing_orders`, `billing_subscriptions`, `billing_entitlements`, `billing_events`, `policy_versions`, `purchase_agreements`, `connection_access`, `support_tickets`, and `notification_outbox`. Seed immutable current policy rows from server configuration only. Store currency amounts in cents. Do not alter `users.role`; retain legacy subscription columns as read-only compatibility data.

```js
const claimEvent = db.prepare(`
  INSERT INTO billing_events (stripe_event_id, event_type, livemode, stripe_created_at, status, payload_sha256, received_at)
  VALUES (@stripeEventId, @eventType, @livemode, @stripeCreatedAt, 'received', @payloadSha256, @receivedAt)
  ON CONFLICT(stripe_event_id) DO NOTHING
`);
```

- [ ] **Step 4: Add transaction rollback and sensitive-data tests.**

Test that failed order/agreement insertion rolls back both records, event payload columns do not exist, and stored connection references are HMAC digests rather than supplied raw IDs.

- [ ] **Step 5: Run focused tests.**

Run: `cd stalker-proxy; npm test -- tests/services/billingStore.test.js tests/auth.test.js`

Expected: PASS.

- [ ] **Step 6: Commit only this task.**

```bash
git add stalker-proxy/src/services/billingStore.js stalker-proxy/tests/services/billingStore.test.js stalker-proxy/src/auth.js
git commit -m "feat: add billing ledger storage"
```

### Task 3: Implement Effective Entitlements and Backward-Compatible Auth Responses

**Files:**
- Create: `stalker-proxy/src/services/entitlementService.js`
- Create: `stalker-proxy/tests/services/entitlementService.test.js`
- Modify: `stalker-proxy/src/auth.js`
- Modify: `stalker-proxy/src/routes/auth.js`

**Interfaces:**
- Produces `getEffectiveAccess(userId, now)`, `activatePass`, `activateSubscription`, `scheduleSubscription`, `startGrace`, `expireElapsed`, `revokeRefundedEntitlement`, and `grantFriendFamily`.
- Auth response retains `role` as effective role and adds the fields defined in the spec.

- [ ] **Step 1: Write failing precedence and expiry tests.**

```js
expect(service.getEffectiveAccess(freeUser.id).role).toBe("free");
service.activatePass({ userId: freeUser.id, startsAt: now, endsAt: now + DAY * 30 });
expect(service.getEffectiveAccess(freeUser.id).toMatchObject({ role: "regular", plan: "standard", planSource: "paid" }));
expect(service.getEffectiveAccess(grandfatheredRegular.id).toMatchObject({ role: "regular", planSource: "grandfathered" }));
expect(service.getEffectiveAccess(admin.id).role).toBe("admin");
```

- [ ] **Step 2: Run the focused test to verify it fails.**

Run: `cd stalker-proxy; npm test -- tests/services/entitlementService.test.js`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement effective access without mutating base roles.**

Use precedence Admin, Pro, Regular, paid/grace Standard, Friend & Family Standard, Free, Guest. Return existing role limits for effective `regular`; do not expose complimentary internals in public `planSource`. Make grace last `BILLING_GRACE_PERIOD_HOURS` and scheduled entitlements non-active until `starts_at`.

- [ ] **Step 4: Integrate the service into authentication.**

At login, `/api/auth/me`, token verification, and profile responses, load current access from SQLite and return:

```js
{ role, baseRole, plan, planSource, billingStatus, accessStartsAt, accessEndsAt,
  nextBillingAt, cancelAtPeriodEnd, limits }
```

Keep JWT role claims informational; do not change token format or invalidate sessions merely for a billing state change.

- [ ] **Step 5: Run focused tests.**

Run: `cd stalker-proxy; npm test -- tests/services/entitlementService.test.js tests/auth.test.js tests/routes/auth.test.js`

Expected: PASS.

- [ ] **Step 6: Commit only this task.**

```bash
git add stalker-proxy/src/services/entitlementService.js stalker-proxy/tests/services/entitlementService.test.js stalker-proxy/src/auth.js stalker-proxy/src/routes/auth.js
git commit -m "feat: calculate effective standard entitlements"
```

### Task 4: Enforce Connection Limits Without Deleting Saved Connections

**Files:**
- Create: `stalker-proxy/src/services/connectionAccessService.js`
- Create: `stalker-proxy/src/routes/accountConnections.js`
- Create: `stalker-proxy/tests/services/connectionAccessService.test.js`
- Create: `stalker-proxy/tests/routes/accountConnections.test.js`
- Modify: `stalker-proxy/src/routes/contentSession.js`
- Modify: `stalker-proxy/src/app.js`

**Interfaces:**
- `assertConnectionAllowed(userId, connectionId)` throws `connection_plan_locked` (403).
- `recordSuccessfulConnectionUse(userId, connectionId, now)` is invoked only after successful content-session creation/open.

- [ ] **Step 1: Write failing downgrade and selection tests.**

```js
const result = service.reconcileConnections({ userId: 7, connectionIds: ["a", "b", "c"], clientOrder: ["c", "b", "a"] });
expect(result.connections.map(x => x.status)).toEqual(["locked_by_plan_limit", "active", "active"]);
expect(() => service.assertConnectionAllowed(7, "a")).toThrowObject({ code: "connection_plan_locked" });
```

- [ ] **Step 2: Run focused tests to verify failure.**

Run: `cd stalker-proxy; npm test -- tests/services/connectionAccessService.test.js tests/routes/accountConnections.test.js`

Expected: FAIL because the service/routes are absent.

- [ ] **Step 3: Implement HMAC identity and reconcile/select APIs.**

Use `HMAC-SHA-256(connectionId, CONNECTION_IDENTITY_HMAC_KEY)` before persistence. Reconcile receives raw IDs only over authenticated HTTPS, returns status by input index, and never logs input IDs. Rank by successful `last_used_at`; for first unknown ties use `clientOrder`. Lock overflow only when a previously higher limit is reduced; do not let a Free user add/import new locked overflow. `select` atomically swaps one active and one saved locked digest.

- [ ] **Step 4: Gate content sessions and revoke locks.**

Before creating a content session for an authenticated user, call `assertConnectionAllowed`. On a downgrade, revoke content sessions associated with newly locked digests. Update usage only after a session has been successfully persisted. Preserve guest flow and existing content-token validation.

- [ ] **Step 5: Run focused regression tests.**

Run: `cd stalker-proxy; npm test -- tests/services/connectionAccessService.test.js tests/routes/accountConnections.test.js tests/routes/contentSession.test.js`

Expected: PASS, including guest content-session coverage.

- [ ] **Step 6: Commit only this task.**

```bash
git add stalker-proxy/src/services/connectionAccessService.js stalker-proxy/src/routes/accountConnections.js stalker-proxy/tests/services/connectionAccessService.test.js stalker-proxy/tests/routes/accountConnections.test.js stalker-proxy/src/routes/contentSession.js stalker-proxy/src/app.js
git commit -m "feat: enforce entitlement connection locks"
```

### Task 5: Add a Stripe Gateway With Safe Checkout and Scheduling

**Files:**
- Create: `stalker-proxy/src/services/stripeGateway.js`
- Create: `stalker-proxy/tests/services/stripeGateway.test.js`
- Delete: `stalker-proxy/src/stripe.js`

**Interfaces:**
- Produces `createStripeGateway({ stripe, catalog, appUrl })`.
- Methods: `createCheckout`, `createSetupCheckout`, `createPortalSession`, `cancelAtPeriodEnd`, `cancelSchedule`, `createScheduleAfterPass`, `createFullRefund`, `retrieveForReconciliation`.

- [ ] **Step 1: Write failing Stripe parameter tests.**

```js
await gateway.createCheckout({ order, customerId: "cus_1", policies, returnPath: "/app?settingsTab=billing" });
expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
  mode: "payment", billing_address_collection: "required",
  automatic_tax: { enabled: true }, consent_collection: { terms_of_service: "required" },
  metadata: { order_id: order.id, user_id: String(order.userId) },
}));
```

- [ ] **Step 2: Run the focused test to verify failure.**

Run: `cd stalker-proxy; npm test -- tests/services/stripeGateway.test.js`

Expected: FAIL because the gateway is absent.

- [ ] **Step 3: Implement gateway-only SDK calls.**

Map product code through Task 1 catalog. Use server-generated idempotency keys such as `checkout:${order.id}`, `refund:${order.id}`, `cancel:${subscriptionId}`, and `schedule:${order.id}`. Use Checkout `payment` for pass, `subscription` for Free-user recurring purchases, and `setup` for pass-to-subscription transition. Build success/cancel URLs from configured HTTPS `APP_URL`; include only `session_id={CHECKOUT_SESSION_ID}` and `order` opaque IDs.

- [ ] **Step 4: Implement queued scheduling rules.**

For an active pass, Setup Checkout must not charge today. After verified setup success, create a Subscription Schedule starting at the pass end. For subscription-to-pass purchases, reject unless `cancel_at_period_end=true` and start date is within 30 days. Do not apply proration; portal changes take effect next cycle.

- [ ] **Step 5: Run focused tests.**

Run: `cd stalker-proxy; npm test -- tests/services/stripeGateway.test.js`

Expected: PASS for pass, monthly, yearly, setup, cancellation, schedule, portal, and refund parameters.

- [ ] **Step 6: Commit only this task.**

```bash
git add stalker-proxy/src/services/stripeGateway.js stalker-proxy/tests/services/stripeGateway.test.js stalker-proxy/src/stripe.js
git commit -m "feat: add safe stripe billing gateway"
```

### Task 6: Project Stripe Webhooks Into the Local Ledger

**Files:**
- Create: `stalker-proxy/src/services/stripeEventProcessor.js`
- Create: `stalker-proxy/tests/services/stripeEventProcessor.test.js`
- Modify: `stalker-proxy/src/app.js`
- Modify: `stalker-proxy/src/index.js`

**Interfaces:**
- `processVerifiedEvent({ rawBody, signature })` verifies before parsing and returns `{ received: true }` only after persistent processing or idempotent duplicate detection.
- Requires raw parser mounted before global `express.json`.

- [ ] **Step 1: Write failing webhook security and idempotency tests.**

```js
await request(app).post("/api/billing/webhook").set("stripe-signature", "sig").send(payload);
expect(constructEvent).toHaveBeenCalledWith(expect.any(Buffer), "sig", webhookSecret);
expect(await processor.process(event)).toEqual({ received: true });
expect(await processor.process(event)).toEqual({ received: true });
expect(activatePass).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run tests to verify failure.**

Run: `cd stalker-proxy; npm test -- tests/services/stripeEventProcessor.test.js tests/routes/billing.test.js`

Expected: FAIL because the current route parses JSON first and uses the obsolete prototype.

- [ ] **Step 3: Implement verified event processing.**

Handle the spec event set: Checkout completed/async success/async failure, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, subscription updates/deletes, relevant schedule lifecycle events, and refund lifecycle events. First claim `stripe_event_id`; record payload SHA-256 only. Reject event `livemode` mismatch. Use per-subscription `last_stripe_event_created` to prevent old events from regressing state. Return non-2xx after recording `failed` when application processing fails so Stripe retries.

- [ ] **Step 4: Mount the webhook correctly.**

Mount `POST /api/billing/webhook` using `express.raw({ type: "application/json" })` before all JSON parsers, CORS/CSRF user middleware, and authenticated API routers. Keep the handler reachable only when billing is fully configured; otherwise return safe `404` without exposing configuration state.

- [ ] **Step 5: Run focused tests.**

Run: `cd stalker-proxy; npm test -- tests/services/stripeEventProcessor.test.js tests/routes/billing.test.js tests/index.test.js`

Expected: PASS; raw webhook body and application JSON routes both work.

- [ ] **Step 6: Commit only this task.**

```bash
git add stalker-proxy/src/services/stripeEventProcessor.js stalker-proxy/tests/services/stripeEventProcessor.test.js stalker-proxy/src/app.js stalker-proxy/src/index.js stalker-proxy/tests/routes/billing.test.js
git commit -m "feat: project verified stripe webhooks"
```

### Task 7: Replace the Billing Router With Authenticated Lifecycle APIs

**Files:**
- Modify: `stalker-proxy/src/routes/billing.js`
- Create: `stalker-proxy/tests/routes/billingLifecycle.test.js`
- Modify: `stalker-proxy/src/app.js`

**Interfaces:**
- Implements exactly the `/api/billing` API surface in the spec.
- Consumes `req.user`, entitlement service, store, gateway, and policy configuration; never consumes a client user ID.

- [ ] **Step 1: Write failing authorization, CSRF, and eligibility tests.**

```js
expect((await request(app).post("/api/billing/checkout").send({ productCode: "standard_monthly" })).status).toBe(401);
expect((await authenticatedPost("/api/billing/checkout", { productCode: "price_123" })).body.code).toBe("billing_product_invalid");
expect((await authenticatedPost("/api/billing/checkout", validMonthly)).body.code).toBe("billing_product_conflict");
```

- [ ] **Step 2: Run tests to verify failure.**

Run: `cd stalker-proxy; npm test -- tests/routes/billingLifecycle.test.js`

Expected: FAIL because current prototype accepts arbitrary browser fields.

- [ ] **Step 3: Implement status, checkout, portal, cancellation, refund, and orders.**

Use dedicated route limiters for Checkout, Portal, refunds, and support. `POST /checkout` accepts only the shared contract. Transactionally create pending order and agreement before gateway creation; update order session ID after creation. `POST /portal` returns only a Stripe-hosted short-lived URL. `POST /subscription/cancel` schedules period-end cancellation. `POST /subscription/scheduled/cancel` cancels only a future schedule. `GET /orders` returns safe IDs, states, policy version summaries, and Stripe-hosted URLs only.

- [ ] **Step 4: Implement full-refund eligibility and state transitions.**

Reject non-owner, unpaid, wrong-mode, disputed, previously refunded, pending, partial, and late orders with exact safe codes. Within seven calendar days, create one idempotent full Stripe refund. Keep entitlement access while `refund_pending`; on verified success revoke only the refunded entitlement, immediately cancel current recurring subscription, recalculate access, and reconcile connection locks.

- [ ] **Step 5: Run focused tests.**

Run: `cd stalker-proxy; npm test -- tests/routes/billingLifecycle.test.js tests/routes/billing.test.js`

Expected: PASS, including safe `billing_disabled` behavior and no Stripe calls while disabled.

- [ ] **Step 6: Commit only this task.**

```bash
git add stalker-proxy/src/routes/billing.js stalker-proxy/tests/routes/billingLifecycle.test.js stalker-proxy/tests/routes/billing.test.js stalker-proxy/src/app.js
git commit -m "feat: add authenticated billing lifecycle api"
```

### Task 8: Add Support Tickets and Reliable Notification Delivery

**Files:**
- Create: `stalker-proxy/src/services/notificationOutboxService.js`
- Create: `stalker-proxy/src/services/supportService.js`
- Create: `stalker-proxy/src/routes/support.js`
- Create: `stalker-proxy/tests/services/notificationOutboxService.test.js`
- Create: `stalker-proxy/tests/services/supportService.test.js`
- Create: `stalker-proxy/tests/routes/support.test.js`
- Modify: `stalker-proxy/src/email.js`
- Modify: `stalker-proxy/src/app.js`

**Interfaces:**
- `createSupportTicket({ user, category, message, orderId })` returns `{ ticketId, status: "received" }` after ticket and outbox transaction.
- `deliverDueNotifications(now)` returns counters only; it never exposes provider response text to users.

- [ ] **Step 1: Write failing ticket validation tests.**

```js
expect(() => service.createSupportTicket({ category: "Billing/Refund", message: "4111 1111 1111 1111" }))
  .toThrowObject({ code: "support_sensitive_content" });
expect(() => service.createSupportTicket({ category: "Other", message: "x".repeat(2001) }))
  .toThrowObject({ code: "support_sensitive_content" });
```

- [ ] **Step 2: Run tests to verify failure.**

Run: `cd stalker-proxy; npm test -- tests/services/supportService.test.js tests/routes/support.test.js`

Expected: FAIL because support service/routes are absent.

- [ ] **Step 3: Implement support validation and durable enqueueing.**

Allow exactly `Billing/Refund`, `Payment Failed`, `Account`, `Technical`, and `Other`; maximum 2,000 characters. Detect card-like numbers, password phrases, URLs with embedded credentials, and content token signatures. Insert ticket plus user-confirmation email and sanitized Discord alert in one store transaction. The Discord payload may contain ticket ID, username, category, timestamp, and secure admin URL only.

- [ ] **Step 4: Implement outbox retry and email templates.**

Use a bounded exponential schedule (for example 1, 5, 30, 120 minutes, maximum five attempts). Treat email/Discord failures as `notification_delivery_pending` while retaining ticket/order state. Add application messages for activation, grace, expiry, pass scheduling, and connection locking; do not duplicate Stripe receipts.

- [ ] **Step 5: Run focused tests.**

Run: `cd stalker-proxy; npm test -- tests/services/notificationOutboxService.test.js tests/services/supportService.test.js tests/routes/support.test.js`

Expected: PASS, including a failed Discord delivery that does not lose the ticket.

- [ ] **Step 6: Commit only this task.**

```bash
git add stalker-proxy/src/services/notificationOutboxService.js stalker-proxy/src/services/supportService.js stalker-proxy/src/routes/support.js stalker-proxy/tests/services/notificationOutboxService.test.js stalker-proxy/tests/services/supportService.test.js stalker-proxy/tests/routes/support.test.js stalker-proxy/src/email.js stalker-proxy/src/app.js
git commit -m "feat: add secure support ticket delivery"
```

### Task 9: Add Reconciliation, Grace Sweeps, and Administrative Grants

**Files:**
- Create: `stalker-proxy/src/services/billingReconciler.js`
- Create: `stalker-proxy/tests/services/billingReconciler.test.js`
- Create: `stalker-proxy/src/routes/adminBilling.js`
- Create: `stalker-proxy/tests/routes/adminBilling.test.js`
- Modify: `stalker-proxy/src/index.js`
- Modify: `stalker-proxy/src/app.js`

**Interfaces:**
- `runBillingMaintenance(now)` is bounded, local-first, and safe at startup and on an interval.
- Admin route requires current effective `admin` role.

- [ ] **Step 1: Write failing maintenance tests.**

```js
await reconciler.runBillingMaintenance(nowAfterGrace);
expect(store.getEntitlement(entitlement.id).status).toBe("expired");
expect(connectionAccess.reconcileUser).toHaveBeenCalledWith(user.id);
expect(gateway.retrieveForReconciliation).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the focused test to verify failure.**

Run: `cd stalker-proxy; npm test -- tests/services/billingReconciler.test.js tests/routes/adminBilling.test.js`

Expected: FAIL because reconciliation/admin routes are absent.

- [ ] **Step 3: Implement local maintenance.**

At startup and a bounded periodic interval: activate due pass entitlements, expire ended entitlements, end overdue grace, reconcile connection locks, retry due outbox rows, and flag stale webhook/order records. Never iterate every Stripe customer or run an unbounded network scan.

- [ ] **Step 4: Implement explicit admin actions.**

Provide admin-only grant/revoke Friend & Family Standard and a bounded explicit Stripe reconciliation action for one safe user/order/subscription target. Reject grant while an actively renewing subscription exists unless cancellation has been scheduled/confirmed. Do not include Friend & Family/Pro in public responses.

- [ ] **Step 5: Run focused tests.**

Run: `cd stalker-proxy; npm test -- tests/services/billingReconciler.test.js tests/routes/adminBilling.test.js`

Expected: PASS.

- [ ] **Step 6: Commit only this task.**

```bash
git add stalker-proxy/src/services/billingReconciler.js stalker-proxy/tests/services/billingReconciler.test.js stalker-proxy/src/routes/adminBilling.js stalker-proxy/tests/routes/adminBilling.test.js stalker-proxy/src/index.js stalker-proxy/src/app.js
git commit -m "feat: reconcile billing access safely"
```

### Task 10: Build the Secure Billing and Support Frontend API

**Files:**
- Create: `streamvault/src/billing-api.js`
- Create: `streamvault/tests/billing-api.test.js`

**Interfaces:**
- Produces `getBillingStatus`, `startCheckout`, `openPortal`, `cancelSubscription`, `cancelScheduledSubscription`, `requestRefund`, `getOrders`, `createSupportTicket`, and `getSupportTickets`.
- Every method maps backend `{ error, code, retryable }` into a typed `BillingApiError` without rendering server text as HTML.

- [ ] **Step 1: Write failing success and error-normalization tests.**

```js
await expect(startCheckout({ productCode: "standard_monthly", acceptedPolicyVersions })).resolves.toEqual({ checkoutUrl: "https://checkout.stripe.com/...", orderId: "ord_1" });
await expect(requestRefund({ orderId: "ord_1", confirmFullRefund: true })).rejects.toMatchObject({ code: "refund_window_expired", retryable: false });
```

- [ ] **Step 2: Run the focused test to verify failure.**

Run: `cd streamvault; npm test -- tests/billing-api.test.js`

Expected: FAIL because the API module is absent.

- [ ] **Step 3: Implement same-origin secure API wrapper.**

Use existing `API` base and authenticated same-origin fetch conventions. Include CSRF headers/tokens through the application’s existing mechanism. Never load Stripe.js and never call these methods from HTTP content mode.

- [ ] **Step 4: Run focused tests.**

Run: `cd streamvault; npm test -- tests/billing-api.test.js`

Expected: PASS.

- [ ] **Step 5: Commit only this task.**

```bash
git add streamvault/src/billing-api.js streamvault/tests/billing-api.test.js
git commit -m "feat: add secure billing frontend api"
```

### Task 11: Add Account Status, Billing, and Support Components

**Files:**
- Create: `streamvault/src/components/AccountStatusCard.jsx`
- Create: `streamvault/src/components/BillingSettings.jsx`
- Create: `streamvault/src/components/SupportSettings.jsx`
- Create: `streamvault/tests/AccountStatusCard.test.jsx`
- Create: `streamvault/tests/BillingSettings.test.jsx`
- Create: `streamvault/tests/SupportSettings.test.jsx`

**Interfaces:**
- `AccountStatusCard({ access, onOpenBilling })` displays only Free/Standard terminology.
- `BillingSettings({ status, onCheckout, onPortal, onCancel, onRefund })` renders product eligibility from server status.

- [ ] **Step 1: Write failing UI tests for public-plan and refund copy.**

```jsx
render(<BillingSettings status={freeStatus} onCheckout={vi.fn()} />);
expect(screen.getByText("Standard 30-Day Pass")).toBeInTheDocument();
expect(screen.queryByText(/Friend & Family|Pro/)).not.toBeInTheDocument();
fireEvent.click(screen.getByRole("button", { name: /eligible full refund/i }));
expect(screen.getByText(/ends only after the refund succeeds/i)).toBeInTheDocument();
```

- [ ] **Step 2: Run focused tests to verify failure.**

Run: `cd streamvault; npm test -- tests/AccountStatusCard.test.jsx tests/BillingSettings.test.jsx tests/SupportSettings.test.jsx`

Expected: FAIL because the components are absent.

- [ ] **Step 3: Implement secure UI states.**

Show server-calculated plan/status, prices, `Tax calculated at checkout`, renewal/grace/expiry/scheduled dates, exact product-ineligibility reason, portal actions, cancellation, refund confirmation, safe order/agreement/invoice links, and checkout-return polling. Use a one-time dismissible upgrade notice instead of repeated popups. Support form must expose the five categories and 2,000-character limit with a safe sensitive-information warning.

- [ ] **Step 4: Test loading, failed, and delayed-verification states.**

Test `billing_disabled`, `billing_verification_pending`, `refund_pending`, `support_rate_limited`, and a scheduled subscription showing `No charge today` with first charge date. Confirm server response, not query parameters, determines activation copy.

- [ ] **Step 5: Run focused tests.**

Run: `cd streamvault; npm test -- tests/AccountStatusCard.test.jsx tests/BillingSettings.test.jsx tests/SupportSettings.test.jsx`

Expected: PASS.

- [ ] **Step 6: Commit only this task.**

```bash
git add streamvault/src/components/AccountStatusCard.jsx streamvault/src/components/BillingSettings.jsx streamvault/src/components/SupportSettings.jsx streamvault/tests/AccountStatusCard.test.jsx streamvault/tests/BillingSettings.test.jsx streamvault/tests/SupportSettings.test.jsx
git commit -m "feat: add secure standard billing settings"
```

### Task 12: Split Secure Account Settings From HTTP Player Settings

**Files:**
- Modify: `streamvault/src/components/SettingsView.jsx`
- Modify: `streamvault/src/App.jsx`
- Modify: `streamvault/tests/SettingsView.test.jsx`
- Create: `streamvault/tests/billing-settings-boundary.test.jsx`

**Interfaces:**
- HTTPS settings tabs: General, Account, Billing, Support, Data.
- HTTP content settings contains only Player Settings/General controls and a safe `Account, Billing & Support` HTTPS link.

- [ ] **Step 1: Write failing boundary tests.**

```jsx
render(<SettingsView contentMode authUser={{ role: "free" }} onOpenSecureSettings={openSecure} />);
expect(screen.getByText("Player Settings")).toBeInTheDocument();
expect(screen.queryByRole("tab", { name: "Billing" })).not.toBeInTheDocument();
expect(screen.queryByText("Send Support Request")).not.toBeInTheDocument();
fireEvent.click(screen.getByRole("button", { name: /account, billing & support/i }));
expect(openSecure).toHaveBeenCalledWith("billing");
```

- [ ] **Step 2: Run focused tests to verify failure.**

Run: `cd streamvault; npm test -- tests/SettingsView.test.jsx tests/billing-settings-boundary.test.jsx`

Expected: FAIL because content mode still renders Account/Data-oriented controls.

- [ ] **Step 3: Implement the boundary and secure handoff.**

On HTTPS, inject Tasks 10-11 components and account-status card into Setup and Settings. On HTTP, render only theme, language, playback, catalog/cache, and local analytics preference. Rename heading to `Player Settings`. The secure URL is fixed to `https://media.portalheaven.stream/app?settingsTab=billing`; omit account JWTs, content token, connection ID, return URL, and provider data.

- [ ] **Step 4: Integrate connection lock UI.**

On secure Setup, reconcile encrypted saved connections over HTTPS, show locked state, prevent content session creation for locked entries, provide select/swap flow, and retain all locked cards. Do not remove snapshots locally or server-side. HTTP content shows only its current allowed connection.

- [ ] **Step 5: Run focused tests.**

Run: `cd streamvault; npm test -- tests/SettingsView.test.jsx tests/billing-settings-boundary.test.jsx tests/Setup.test.jsx`

Expected: PASS.

- [ ] **Step 6: Commit only this task.**

```bash
git add streamvault/src/components/SettingsView.jsx streamvault/src/App.jsx streamvault/tests/SettingsView.test.jsx streamvault/tests/billing-settings-boundary.test.jsx
git commit -m "feat: separate secure account and player settings"
```

### Task 13: Publish Versioned Policies and Operational Documentation

**Files:**
- Create: `streamvault/public/legal/terms-v1.html`
- Create: `streamvault/public/legal/privacy-v1.html`
- Create: `streamvault/public/legal/refund-v1.html`
- Create: `docs/runbooks/stripe-standard-billing.md`
- Modify: `stalker-proxy/.env.example`
- Modify: `stalker-proxy/README.md`
- Modify: `streamvault/README.md`

**Interfaces:**
- Policy URLs configured in Task 1 must match deployed stable HTTPS routes and SHA-256 content hashes recorded by Task 2.

- [ ] **Step 1: Write failing policy metadata tests.**

```js
expect(catalog.currentPolicies()).toEqual(expect.objectContaining({
  terms: expect.objectContaining({ version: "v1", publicUrl: "https://media.portalheaven.stream/legal/terms-v1.html" }),
}));
```

- [ ] **Step 2: Run the focused test to verify failure.**

Run: `cd stalker-proxy; npm test -- tests/services/billingCatalog.test.js`

Expected: FAIL until policy configuration and content hashes agree.

- [ ] **Step 3: Add immutable public policy pages and runbook.**

Write customer-facing Terms, Privacy, and Refund Policy v1 pages with effective date, service description, Standard products, cancellation, seven-day full-refund rule, support address, and Stripe tax/receipt roles. The runbook must document Stripe Dashboard product/Price creation, Checkout Terms URL, Tax registration, Customer Portal configuration, webhook endpoint, test-vs-live switch, env injection, database backup, rollback by disabling billing, and explicit reconciliation.

- [ ] **Step 4: Run focused tests and preview build.**

Run: `cd stalker-proxy; npm test -- tests/services/billingCatalog.test.js`

Run: `cd streamvault; npm run build`

Expected: PASS and policy assets emitted.

- [ ] **Step 5: Commit only this task.**

```bash
git add streamvault/public/legal stalker-proxy/.env.example stalker-proxy/README.md streamvault/README.md docs/runbooks/stripe-standard-billing.md stalker-proxy/tests/services/billingCatalog.test.js
git commit -m "docs: publish billing policy and stripe runbook"
```

### Task 14: Add End-to-End Coverage and Stripe Test-Mode Verification

**Files:**
- Create: `streamvault/e2e/billing-standard.spec.js`
- Modify: `streamvault/e2e/fixtures/*` only if existing fixture conventions require it
- Modify: `stalker-proxy/tests/routes/billingLifecycle.test.js`
- Modify: `docs/runbooks/stripe-standard-billing.md`

**Interfaces:**
- E2E uses mocked backend/Stripe URLs for deterministic UI tests; a separate manual checklist uses Stripe test mode and test cards.

- [ ] **Step 1: Write failing E2E scenarios.**

```js
test("free user can open Standard Checkout without exposing a Stripe price ID", async ({ page }) => {
  await page.route("**/api/billing/checkout", route => route.fulfill({ json: { checkoutUrl: "https://checkout.stripe.test/session", orderId: "ord_1" } }));
  await page.getByRole("button", { name: /standard monthly/i }).click();
  await expect(page).toHaveURL(/checkout\.stripe\.test/);
});
```

- [ ] **Step 2: Run E2E test to verify failure.**

Run: `cd streamvault; npx playwright test e2e/billing-standard.spec.js`

Expected: FAIL until secure Billing UI exists.

- [ ] **Step 3: Cover required user journeys.**

Cover Free checkout return waiting for webhook, activated Standard status, monthly/yearly cancellation at period end, pass-to-subscription `No charge today`, scheduled cancellation, refund confirmation/pending/success downgrade, locked connection swap, grandfathered Regular no purchase, HTTP settings no billing/support request, and support success/error states. Assert neither `Friend & Family` nor `Pro` appears.

- [ ] **Step 4: Execute Stripe test-mode manual checklist.**

Use Stripe test keys in a non-production environment: complete pass, monthly, yearly, setup/schedule, failed renewal/grace, cancellation, refund, duplicate webhook delivery, out-of-order webhook, customer portal plan change, and support notifications. Record only test IDs and timestamps in the runbook; never commit keys, webhook URLs, or card data.

- [ ] **Step 5: Run E2E and focused backend tests.**

Run: `cd streamvault; npx playwright test e2e/billing-standard.spec.js`

Run: `cd stalker-proxy; npm test -- tests/routes/billingLifecycle.test.js tests/services/stripeEventProcessor.test.js`

Expected: PASS.

- [ ] **Step 6: Commit only this task.**

```bash
git add streamvault/e2e/billing-standard.spec.js stalker-proxy/tests/routes/billingLifecycle.test.js docs/runbooks/stripe-standard-billing.md
git commit -m "test: cover standard billing journeys"
```

### Task 15: Full Regression, Security Review, and Release Gate

**Files:**
- Modify only files required to fix verified failures from Tasks 1-14.
- Modify: `docs/runbooks/stripe-standard-billing.md` with final evidence.

**Interfaces:**
- No behavior is accepted unless disabled billing leaves current login, setup, direct content, Stalker, Xtream, M3U, and playback flows unchanged.

- [ ] **Step 1: Run complete backend test suite.**

Run: `cd stalker-proxy; npm test`

Expected: PASS.

- [ ] **Step 2: Run complete frontend unit, lint, and production build suites.**

Run: `cd streamvault; npm test`

Run: `cd streamvault; npm run lint`

Run: `cd streamvault; $env:VITE_SECURE_APP_BASE_URL='https://media.portalheaven.stream'; npm run build`

Expected: all PASS with no lint errors.

- [ ] **Step 3: Run the selected Playwright suite against a healthy local Docker backend.**

Run: `cd streamvault; npx playwright test e2e/billing-standard.spec.js e2e/auth.spec.js e2e/guest-flow.spec.js`

Expected: PASS. If local backend is unavailable, mark this task BLOCKED with the exact unavailable service and do not claim release readiness.

- [ ] **Step 4: Perform a manual disabled-billing smoke test.**

Set `BILLING_ENABLED=false` in non-production. Verify login, registration, guest usage, content-session creation, HTTP player navigation, Xtream playback, M3U playback, Stalker playback, and existing free/regular connection limits. Verify billing APIs return safe `billing_disabled` and no Stripe network call is made.

- [ ] **Step 5: Review security and migration evidence.**

Confirm raw webhook registration precedes `express.json`; every billing/support/connection mutation uses auth/origin/CSRF; errors are structured/safe; Price IDs are server-only; SQLite schema is additive/idempotent; base roles remain unchanged; logs/outbox contain no sensitive data; and media requests do not enter billing modules.

- [ ] **Step 6: Commit verified fixes and release evidence.**

```bash
git add <only verified billing files changed by test fixes> docs/runbooks/stripe-standard-billing.md
git commit -m "test: verify standard billing release gate"
```

Do not enable billing or deploy in this task. Create a separate deployment change only after Stripe Dashboard configuration, production database backup, and the manual checklist are approved.

## Acceptance-Criteria Coverage

- [x] Fixed Standard products, public terminology, tax, policy agreement, and disabled-by-default setup: Tasks 1, 5, 7, 11, 13.
- [x] Additive ledger, role compatibility, effective access, grandfathering, Friend & Family admin handling: Tasks 2, 3, 9.
- [x] Pass, recurring subscription, queued pass, Setup Checkout/schedule, cancellation, grace, and refunds: Tasks 3, 5, 6, 7, 9, 14.
- [x] Webhook raw-body verification, event dedupe, mode check, ordering, and reconciliation: Tasks 5, 6, 9, 14.
- [x] Safe downgrade, two active connections, lock/swap/re-upgrade behavior: Tasks 3, 4, 7, 12, 14.
- [x] Secure support tickets, email confirmation, sanitized Discord alert, durable delivery: Task 8.
- [x] HTTPS account/billing/support versus HTTP player-only settings boundary: Tasks 10, 11, 12, 14.
- [x] Policy proof, operational runbook, test-mode validation, regression/security gate: Tasks 13, 14, 15.

## Plan Self-Review

- **Spec coverage:** Every acceptance criterion from the approved design maps to at least one task above. The implementation deliberately excludes public Pro/Friend & Family plans, in-app support threads, attachments, and media routing because they are non-goals.
- **Compatibility:** Tasks 1, 3, 4, 12, and 15 explicitly cover disabled billing, current role behavior, guest/content sessions, and HTTP content mode.
- **Security:** Tasks 4-8 and 15 cover raw webhook handling, route auth/CSRF, fixed catalog mapping, idempotency, secret/log hygiene, and no raw connection IDs at rest.
- **No placeholders:** This plan uses concrete files, interfaces, tests, commands, expected results, and commit scopes for each task.
