"use strict";

const crypto = require("node:crypto");

function createBillingStore({ db, now = Date.now, identityHmacKey = "" }) {
  if (!db) {
    throw new Error("better-sqlite3 db instance is required for billingStore");
  }

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
  }

  function hashConnectionId(rawConnectionId) {
    if (!identityHmacKey) {
      // Fallback to SHA-256 digest if no identityHmacKey configured
      return crypto.createHash("sha256").update(String(rawConnectionId)).digest("hex");
    }
    return crypto
      .createHmac("sha256", Buffer.from(identityHmacKey))
      .update(String(rawConnectionId))
      .digest("hex");
  }

  let stmts = null;

  function init() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS billing_customers (
        user_id INTEGER PRIMARY KEY,
        stripe_customer_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_billing_customers_stripe ON billing_customers(stripe_customer_id);

      CREATE TABLE IF NOT EXISTS billing_orders (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        product_code TEXT NOT NULL,
        checkout_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        stripe_price_id TEXT NOT NULL,
        stripe_checkout_session_id TEXT UNIQUE,
        stripe_payment_intent_id TEXT UNIQUE,
        stripe_invoice_id TEXT,
        stripe_subscription_id TEXT,
        stripe_schedule_id TEXT,
        currency TEXT NOT NULL DEFAULT 'usd',
        amount_subtotal INTEGER,
        amount_tax INTEGER,
        amount_total INTEGER,
        requested_start_at INTEGER,
        access_start_at INTEGER,
        access_end_at INTEGER,
        refundable_until INTEGER,
        refunded_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_billing_orders_user ON billing_orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_billing_orders_session ON billing_orders(stripe_checkout_session_id);
      CREATE INDEX IF NOT EXISTS idx_billing_orders_payment_intent ON billing_orders(stripe_payment_intent_id);

      CREATE TABLE IF NOT EXISTS billing_subscriptions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        product_code TEXT NOT NULL,
        stripe_subscription_id TEXT UNIQUE,
        stripe_schedule_id TEXT UNIQUE,
        status TEXT NOT NULL,
        current_period_start INTEGER,
        current_period_end INTEGER,
        scheduled_start_at INTEGER,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        grace_until INTEGER,
        last_stripe_event_created INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_billing_subs_user ON billing_subscriptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_billing_subs_stripe ON billing_subscriptions(stripe_subscription_id);

      CREATE TABLE IF NOT EXISTS billing_entitlements (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        tier TEXT NOT NULL DEFAULT 'standard',
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(source_type, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_billing_entitlements_user ON billing_entitlements(user_id);
      CREATE INDEX IF NOT EXISTS idx_billing_entitlements_status ON billing_entitlements(status, starts_at, ends_at);

      CREATE TABLE IF NOT EXISTS billing_events (
        stripe_event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        livemode INTEGER NOT NULL,
        stripe_created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        received_at INTEGER NOT NULL,
        processed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_billing_events_status ON billing_events(status);

      CREATE TABLE IF NOT EXISTS policy_versions (
        policy_type TEXT NOT NULL,
        version TEXT NOT NULL,
        public_url TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        retired_at INTEGER,
        PRIMARY KEY (policy_type, version)
      );

      CREATE TABLE IF NOT EXISTS purchase_agreements (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL,
        terms_version TEXT NOT NULL,
        privacy_version TEXT NOT NULL,
        refund_version TEXT NOT NULL,
        terms_sha256 TEXT NOT NULL,
        privacy_sha256 TEXT NOT NULL,
        refund_sha256 TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        stripe_checkout_session_id TEXT UNIQUE,
        stripe_terms_accepted INTEGER NOT NULL DEFAULT 0,
        stripe_consent_recorded_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_purchase_agreements_user ON purchase_agreements(user_id);

      CREATE TABLE IF NOT EXISTS connection_access (
        user_id INTEGER NOT NULL,
        connection_key TEXT NOT NULL,
        last_used_at INTEGER,
        selected_at INTEGER,
        locked_at INTEGER,
        PRIMARY KEY (user_id, connection_key)
      );
      CREATE INDEX IF NOT EXISTS idx_connection_access_user ON connection_access(user_id);

      CREATE TABLE IF NOT EXISTS support_tickets (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        stripe_customer_id TEXT,
        stripe_order_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id);

      CREATE TABLE IF NOT EXISTS notification_outbox (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        template TEXT NOT NULL,
        recipient TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notification_outbox_status ON notification_outbox(status, next_attempt_at);
    `);

    // Prepare statements
    stmts = {
      // Customers
      upsertCustomer: db.prepare(`
        INSERT INTO billing_customers (user_id, stripe_customer_id, created_at, updated_at)
        VALUES (@userId, @stripeCustomerId, @createdAt, @updatedAt)
        ON CONFLICT(user_id) DO UPDATE SET
          stripe_customer_id = excluded.stripe_customer_id,
          updated_at = excluded.updated_at
      `),
      getCustomerByUserId: db.prepare(`SELECT * FROM billing_customers WHERE user_id = ?`),
      getUserByStripeCustomerId: db.prepare(`SELECT * FROM billing_customers WHERE stripe_customer_id = ?`),

      // Orders
      insertOrder: db.prepare(`
        INSERT INTO billing_orders (
          id, user_id, product_code, checkout_mode, status, stripe_price_id,
          stripe_checkout_session_id, stripe_payment_intent_id, stripe_invoice_id,
          stripe_subscription_id, stripe_schedule_id, currency, amount_subtotal,
          amount_tax, amount_total, requested_start_at, access_start_at,
          access_end_at, refundable_until, refunded_at, created_at, updated_at
        ) VALUES (
          @id, @userId, @productCode, @checkoutMode, @status, @priceId,
          @stripeCheckoutSessionId, @stripePaymentIntentId, @stripeInvoiceId,
          @stripeSubscriptionId, @stripeScheduleId, @currency, @amountSubtotal,
          @amountTax, @amountTotal, @requestedStartAt, @accessStartAt,
          @accessEndAt, @refundableUntil, @refundedAt, @createdAt, @updatedAt
        )
      `),
      getOrder: db.prepare(`SELECT * FROM billing_orders WHERE id = ?`),
      getOrderBySessionId: db.prepare(`SELECT * FROM billing_orders WHERE stripe_checkout_session_id = ?`),
      getOrderByPaymentIntent: db.prepare(`SELECT * FROM billing_orders WHERE stripe_payment_intent_id = ?`),
      listOrdersForUser: db.prepare(`SELECT * FROM billing_orders WHERE user_id = ? ORDER BY created_at DESC`),
      updateOrderStatus: db.prepare(`
        UPDATE billing_orders SET
          status = @status,
          stripe_checkout_session_id = COALESCE(@stripeCheckoutSessionId, stripe_checkout_session_id),
          stripe_payment_intent_id = COALESCE(@stripePaymentIntentId, stripe_payment_intent_id),
          stripe_invoice_id = COALESCE(@stripeInvoiceId, stripe_invoice_id),
          stripe_subscription_id = COALESCE(@stripeSubscriptionId, stripe_subscription_id),
          stripe_schedule_id = COALESCE(@stripeScheduleId, stripe_schedule_id),
          amount_subtotal = COALESCE(@amountSubtotal, amount_subtotal),
          amount_tax = COALESCE(@amountTax, amount_tax),
          amount_total = COALESCE(@amountTotal, amount_total),
          access_start_at = COALESCE(@accessStartAt, access_start_at),
          access_end_at = COALESCE(@accessEndAt, access_end_at),
          refundable_until = COALESCE(@refundableUntil, refundable_until),
          refunded_at = COALESCE(@refundedAt, refunded_at),
          updated_at = @updatedAt
        WHERE id = @id
      `),

      // Agreements
      insertAgreement: db.prepare(`
        INSERT INTO purchase_agreements (
          id, order_id, user_id, terms_version, privacy_version, refund_version,
          terms_sha256, privacy_sha256, refund_sha256, accepted_at,
          stripe_checkout_session_id, stripe_terms_accepted, stripe_consent_recorded_at
        ) VALUES (
          @id, @orderId, @userId, @termsVersion, @privacyVersion, @refundVersion,
          @termsSha256, @privacySha256, @refundSha256, @acceptedAt,
          @stripeCheckoutSessionId, @stripeTermsAccepted, @stripeConsentRecordedAt
        )
      `),
      getAgreementByOrderId: db.prepare(`SELECT * FROM purchase_agreements WHERE order_id = ?`),

      // Subscriptions
      upsertSubscription: db.prepare(`
        INSERT INTO billing_subscriptions (
          id, user_id, product_code, stripe_subscription_id, stripe_schedule_id,
          status, current_period_start, current_period_end, scheduled_start_at,
          cancel_at_period_end, grace_until, last_stripe_event_created, created_at, updated_at
        ) VALUES (
          @id, @userId, @productCode, @stripeSubscriptionId, @stripeScheduleId,
          @status, @currentPeriodStart, @currentPeriodEnd, @scheduledStartAt,
          @cancelAtPeriodEnd, @graceUntil, @lastStripeEventCreated, @createdAt, @updatedAt
        )
        ON CONFLICT(stripe_subscription_id) DO UPDATE SET
          product_code = excluded.product_code,
          status = excluded.status,
          current_period_start = excluded.current_period_start,
          current_period_end = excluded.current_period_end,
          scheduled_start_at = excluded.scheduled_start_at,
          cancel_at_period_end = excluded.cancel_at_period_end,
          grace_until = excluded.grace_until,
          last_stripe_event_created = excluded.last_stripe_event_created,
          updated_at = excluded.updated_at
      `),
      getSubscription: db.prepare(`SELECT * FROM billing_subscriptions WHERE id = ?`),
      getSubscriptionByStripeId: db.prepare(`SELECT * FROM billing_subscriptions WHERE stripe_subscription_id = ?`),
      getSubscriptionByUserId: db.prepare(`SELECT * FROM billing_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`),

      // Entitlements
      insertEntitlement: db.prepare(`
        INSERT INTO billing_entitlements (
          id, user_id, tier, source_type, source_id, status, starts_at, ends_at, created_at, updated_at
        ) VALUES (
          @id, @userId, @tier, @sourceType, @sourceId, @status, @startsAt, @endsAt, @createdAt, @updatedAt
        )
      `),
      getEntitlement: db.prepare(`SELECT * FROM billing_entitlements WHERE id = ?`),
      getEntitlementBySource: db.prepare(`SELECT * FROM billing_entitlements WHERE source_type = ? AND source_id = ?`),
      listEntitlementsForUser: db.prepare(`SELECT * FROM billing_entitlements WHERE user_id = ? ORDER BY starts_at DESC`),
      updateEntitlementStatus: db.prepare(`
        UPDATE billing_entitlements SET
          status = @status,
          starts_at = COALESCE(@startsAt, starts_at),
          ends_at = COALESCE(@endsAt, ends_at),
          updated_at = @updatedAt
        WHERE id = @id
      `),

      // Events
      claimEvent: db.prepare(`
        INSERT INTO billing_events (
          stripe_event_id, event_type, livemode, stripe_created_at, status, payload_sha256, attempt_count, received_at
        ) VALUES (
          @stripeEventId, @eventType, @livemode, @stripeCreatedAt, 'received', @payloadSha256, 1, @receivedAt
        )
        ON CONFLICT(stripe_event_id) DO NOTHING
      `),
      getEvent: db.prepare(`SELECT * FROM billing_events WHERE stripe_event_id = ?`),
      updateEventStatus: db.prepare(`
        UPDATE billing_events SET
          status = @status,
          attempt_count = attempt_count + 1,
          last_error_code = @lastErrorCode,
          processed_at = @processedAt
        WHERE stripe_event_id = @stripeEventId
      `),

      // Policies
      upsertPolicyVersion: db.prepare(`
        INSERT INTO policy_versions (
          policy_type, version, public_url, content_sha256, published_at, retired_at
        ) VALUES (
          @policyType, @version, @publicUrl, @contentSha256, @publishedAt, @retiredAt
        )
        ON CONFLICT(policy_type, version) DO UPDATE SET
          public_url = excluded.public_url,
          content_sha256 = excluded.content_sha256,
          published_at = excluded.published_at,
          retired_at = excluded.retired_at
      `),
      getPolicyVersion: db.prepare(`SELECT * FROM policy_versions WHERE policy_type = ? AND version = ?`),
      listActivePolicies: db.prepare(`SELECT * FROM policy_versions WHERE retired_at IS NULL`),

      // Connection Access
      upsertConnectionUse: db.prepare(`
        INSERT INTO connection_access (user_id, connection_key, last_used_at)
        VALUES (@userId, @connectionKey, @lastUsedAt)
        ON CONFLICT(user_id, connection_key) DO UPDATE SET
          last_used_at = excluded.last_used_at
      `),
      getConnectionAccess: db.prepare(`SELECT * FROM connection_access WHERE user_id = ? AND connection_key = ?`),
      listConnectionAccessForUser: db.prepare(`SELECT * FROM connection_access WHERE user_id = ? ORDER BY last_used_at DESC`),
      updateConnectionLock: db.prepare(`
      INSERT INTO connection_access (user_id, connection_key, locked_at, selected_at)
      VALUES (@userId, @connectionKey, @lockedAt, @selectedAt)
      ON CONFLICT(user_id, connection_key) DO UPDATE SET
        locked_at = excluded.locked_at,
        selected_at = excluded.selected_at
    `),

      // Support Tickets
      insertTicket: db.prepare(`
        INSERT INTO support_tickets (
          id, user_id, category, message, status, stripe_customer_id, stripe_order_id, created_at, updated_at
        ) VALUES (
          @id, @userId, @category, @message, @status, @stripeCustomerId, @stripeOrderId, @createdAt, @updatedAt
        )
      `),
      getTicket: db.prepare(`SELECT * FROM support_tickets WHERE id = ?`),
      listTicketsForUser: db.prepare(`SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC`),
      updateTicketStatus: db.prepare(`UPDATE support_tickets SET status = @status, updated_at = @updatedAt WHERE id = @id`),

      // Notification Outbox
      insertOutbox: db.prepare(`
        INSERT INTO notification_outbox (
          id, channel, template, recipient, payload_json, status, attempt_count, next_attempt_at, created_at, updated_at
        ) VALUES (
          @id, @channel, @template, @recipient, @payloadJson, @status, @attemptCount, @nextAttemptAt, @createdAt, @updatedAt
        )
      `),
      getDueOutbox: db.prepare(`
        SELECT * FROM notification_outbox
        WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? AND attempt_count < 5
        ORDER BY next_attempt_at ASC LIMIT ?
      `),
      updateOutboxSuccess: db.prepare(`UPDATE notification_outbox SET status = 'sent', updated_at = ? WHERE id = ?`),
      updateOutboxFailure: db.prepare(`
        UPDATE notification_outbox SET
          status = 'failed',
          attempt_count = attempt_count + 1,
          next_attempt_at = @nextAttemptAt,
          last_error_code = @lastErrorCode,
          updated_at = @updatedAt
        WHERE id = @id
      `),
    };
  }

  // Customer methods
  function upsertCustomer({ userId, stripeCustomerId }) {
    if (!stmts) init();
    const ts = getNow();
    stmts.upsertCustomer.run({
      userId,
      stripeCustomerId,
      createdAt: ts,
      updatedAt: ts,
    });
    return getCustomerByUserId(userId);
  }

  function getCustomerByUserId(userId) {
    if (!stmts) init();
    return stmts.getCustomerByUserId.get(userId);
  }

  function getUserByStripeCustomerId(stripeCustomerId) {
    if (!stmts) init();
    return stmts.getUserByStripeCustomerId.get(stripeCustomerId);
  }

  // Order methods
  function createOrder(orderData) {
    if (!stmts) init();
    const ts = getNow();
    const id = orderData.id || `ord_${crypto.randomBytes(12).toString("hex")}`;
    stmts.insertOrder.run({
      id,
      userId: orderData.userId,
      productCode: orderData.productCode,
      checkoutMode: orderData.checkoutMode,
      status: orderData.status || "created",
      priceId: orderData.priceId,
      stripeCheckoutSessionId: orderData.stripeCheckoutSessionId || null,
      stripePaymentIntentId: orderData.stripePaymentIntentId || null,
      stripeInvoiceId: orderData.stripeInvoiceId || null,
      stripeSubscriptionId: orderData.stripeSubscriptionId || null,
      stripeScheduleId: orderData.stripeScheduleId || null,
      currency: orderData.currency || "usd",
      amountSubtotal: orderData.amountSubtotal !== undefined ? orderData.amountSubtotal : null,
      amountTax: orderData.amountTax !== undefined ? orderData.amountTax : null,
      amountTotal: orderData.amountTotal !== undefined ? orderData.amountTotal : null,
      requestedStartAt: orderData.requestedStartAt || null,
      accessStartAt: orderData.accessStartAt || null,
      accessEndAt: orderData.accessEndAt || null,
      refundableUntil: orderData.refundableUntil || null,
      refundedAt: orderData.refundedAt || null,
      createdAt: orderData.createdAt || ts,
      updatedAt: ts,
    });
    return getOrder(id);
  }

  function getOrder(id) {
    if (!stmts) init();
    return stmts.getOrder.get(id);
  }

  function getOrderByCheckoutSessionId(sessionId) {
    if (!stmts) init();
    return stmts.getOrderBySessionId.get(sessionId);
  }

  function getOrderByPaymentIntentId(intentId) {
    if (!stmts) init();
    return stmts.getOrderByPaymentIntent.get(intentId);
  }

  function listOrdersForUser(userId) {
    if (!stmts) init();
    return stmts.listOrdersForUser.all(userId);
  }

  function updateOrderStatus(id, status, extra = {}) {
    if (!stmts) init();
    const ts = getNow();
    stmts.updateOrderStatus.run({
      id,
      status,
      stripeCheckoutSessionId: extra.stripeCheckoutSessionId || null,
      stripePaymentIntentId: extra.stripePaymentIntentId || null,
      stripeInvoiceId: extra.stripeInvoiceId || null,
      stripeSubscriptionId: extra.stripeSubscriptionId || null,
      stripeScheduleId: extra.stripeScheduleId || null,
      amountSubtotal: extra.amountSubtotal !== undefined ? extra.amountSubtotal : null,
      amountTax: extra.amountTax !== undefined ? extra.amountTax : null,
      amountTotal: extra.amountTotal !== undefined ? extra.amountTotal : null,
      accessStartAt: extra.accessStartAt !== undefined ? extra.accessStartAt : null,
      accessEndAt: extra.accessEndAt !== undefined ? extra.accessEndAt : null,
      refundableUntil: extra.refundableUntil !== undefined ? extra.refundableUntil : null,
      refundedAt: extra.refundedAt !== undefined ? extra.refundedAt : null,
      updatedAt: ts,
    });
    return getOrder(id);
  }

  // Agreement methods
  function createAgreement(agreementData) {
    if (!stmts) init();
    const ts = getNow();
    const id = agreementData.id || `agr_${crypto.randomBytes(12).toString("hex")}`;
    stmts.insertAgreement.run({
      id,
      orderId: agreementData.orderId,
      userId: agreementData.userId,
      termsVersion: agreementData.termsVersion,
      privacyVersion: agreementData.privacyVersion,
      refundVersion: agreementData.refundVersion,
      termsSha256: agreementData.termsSha256,
      privacySha256: agreementData.privacySha256,
      refundSha256: agreementData.refundSha256,
      acceptedAt: agreementData.acceptedAt || ts,
      stripeCheckoutSessionId: agreementData.stripeCheckoutSessionId || null,
      stripeTermsAccepted: agreementData.stripeTermsAccepted ? 1 : 0,
      stripeConsentRecordedAt: agreementData.stripeConsentRecordedAt || null,
    });
    return getAgreementByOrderId(agreementData.orderId);
  }

  function getAgreementByOrderId(orderId) {
    if (!stmts) init();
    return stmts.getAgreementByOrderId.get(orderId);
  }

  // Transaction: Create Order with Agreement
  function createOrderWithAgreement({ order, agreement }) {
    if (!stmts) init();
    const tx = db.transaction(() => {
      const createdOrder = createOrder(order);
      const createdAgreement = createAgreement({
        ...agreement,
        orderId: createdOrder.id,
        userId: createdOrder.user_id,
      });
      return { order: createdOrder, agreement: createdAgreement };
    });
    return tx();
  }

  // Subscriptions
  function upsertSubscription(subData) {
    if (!stmts) init();
    const ts = getNow();
    const id = subData.id || `sub_${crypto.randomBytes(12).toString("hex")}`;
    stmts.upsertSubscription.run({
      id,
      userId: subData.userId,
      productCode: subData.productCode,
      stripeSubscriptionId: subData.stripeSubscriptionId,
      stripeScheduleId: subData.stripeScheduleId || null,
      status: subData.status,
      currentPeriodStart: subData.currentPeriodStart || null,
      currentPeriodEnd: subData.currentPeriodEnd || null,
      scheduledStartAt: subData.scheduledStartAt || null,
      cancelAtPeriodEnd: subData.cancelAtPeriodEnd ? 1 : 0,
      graceUntil: subData.graceUntil || null,
      lastStripeEventCreated: subData.lastStripeEventCreated || 0,
      createdAt: subData.createdAt || ts,
      updatedAt: ts,
    });
    return getSubscriptionByStripeId(subData.stripeSubscriptionId);
  }

  function getSubscription(id) {
    if (!stmts) init();
    return stmts.getSubscription.get(id);
  }

  function getSubscriptionByStripeId(stripeSubscriptionId) {
    if (!stmts) init();
    return stmts.getSubscriptionByStripeId.get(stripeSubscriptionId);
  }

  function getSubscriptionByUserId(userId) {
    if (!stmts) init();
    return stmts.getSubscriptionByUserId.get(userId);
  }

  function updateSubscriptionStatus(stripeSubscriptionId, fields) {
    if (!stmts) init();
    const existing = getSubscriptionByStripeId(stripeSubscriptionId);
    if (!existing) return null;
    const ts = getNow();
    stmts.upsertSubscription.run({
      id: existing.id,
      userId: existing.user_id,
      productCode: existing.product_code,
      stripeSubscriptionId,
      stripeScheduleId: fields.stripeScheduleId !== undefined ? fields.stripeScheduleId : existing.stripe_schedule_id,
      status: fields.status !== undefined ? fields.status : existing.status,
      currentPeriodStart: fields.currentPeriodStart !== undefined ? fields.currentPeriodStart : existing.current_period_start,
      currentPeriodEnd: fields.currentPeriodEnd !== undefined ? fields.currentPeriodEnd : existing.current_period_end,
      scheduledStartAt: fields.scheduledStartAt !== undefined ? fields.scheduledStartAt : existing.scheduled_start_at,
      cancelAtPeriodEnd: fields.cancelAtPeriodEnd !== undefined ? (fields.cancelAtPeriodEnd ? 1 : 0) : existing.cancel_at_period_end,
      graceUntil: fields.graceUntil !== undefined ? fields.graceUntil : existing.grace_until,
      lastStripeEventCreated: fields.lastStripeEventCreated !== undefined ? fields.lastStripeEventCreated : existing.last_stripe_event_created,
      createdAt: existing.created_at,
      updatedAt: ts,
    });
    return getSubscriptionByStripeId(stripeSubscriptionId);
  }

  // Entitlements
  function createEntitlement(entData) {
    if (!stmts) init();
    const ts = getNow();
    const id = entData.id || `ent_${crypto.randomBytes(12).toString("hex")}`;
    stmts.insertEntitlement.run({
      id,
      userId: entData.userId,
      tier: entData.tier || "standard",
      sourceType: entData.sourceType,
      sourceId: entData.sourceId,
      status: entData.status || "active",
      startsAt: entData.startsAt,
      endsAt: entData.endsAt !== undefined ? entData.endsAt : null,
      createdAt: entData.createdAt || ts,
      updatedAt: ts,
    });
    return getEntitlement(id);
  }

  function getEntitlement(id) {
    if (!stmts) init();
    return stmts.getEntitlement.get(id);
  }

  function getEntitlementBySource(sourceType, sourceId) {
    if (!stmts) init();
    return stmts.getEntitlementBySource.get(sourceType, sourceId);
  }

  function listEntitlementsForUser(userId) {
    if (!stmts) init();
    return stmts.listEntitlementsForUser.all(userId);
  }

  function updateEntitlementStatus(id, status, extra = {}) {
    if (!stmts) init();
    const ts = getNow();
    stmts.updateEntitlementStatus.run({
      id,
      status,
      startsAt: extra.startsAt !== undefined ? extra.startsAt : null,
      endsAt: extra.endsAt !== undefined ? extra.endsAt : null,
      updatedAt: ts,
    });
    return getEntitlement(id);
  }

  // Events
  function claimEvent({ stripeEventId, eventType, livemode, stripeCreatedAt, payloadSha256 }) {
    if (!stmts) init();
    const ts = getNow();
    const result = stmts.claimEvent.run({
      stripeEventId,
      eventType,
      livemode: livemode ? 1 : 0,
      stripeCreatedAt,
      payloadSha256,
      receivedAt: ts,
    });
    return result.changes > 0;
  }

  function getEvent(stripeEventId) {
    if (!stmts) init();
    return stmts.getEvent.get(stripeEventId);
  }

  function updateEventStatus(stripeEventId, status, { lastErrorCode = null, processedAt = null } = {}) {
    if (!stmts) init();
    stmts.updateEventStatus.run({
      stripeEventId,
      status,
      lastErrorCode,
      processedAt: processedAt || (status === "processed" ? getNow() : null),
    });
    return getEvent(stripeEventId);
  }

  // Policies
  function upsertPolicyVersion({ policyType, version, publicUrl, contentSha256, publishedAt, retiredAt = null }) {
    if (!stmts) init();
    stmts.upsertPolicyVersion.run({
      policyType,
      version,
      publicUrl,
      contentSha256,
      publishedAt: publishedAt || getNow(),
      retiredAt,
    });
    return getPolicyVersion(policyType, version);
  }

  function getPolicyVersion(policyType, version) {
    if (!stmts) init();
    return stmts.getPolicyVersion.get(policyType, version);
  }

  function listActivePolicies() {
    if (!stmts) init();
    return stmts.listActivePolicies.all();
  }

  // Connection Access
  function recordConnectionUse(userId, rawConnectionId, usedAt = null) {
    if (!stmts) init();
    const connectionKey = hashConnectionId(rawConnectionId);
    const ts = usedAt || getNow();
    stmts.upsertConnectionUse.run({
      userId,
      connectionKey,
      lastUsedAt: ts,
    });
  }

  function getConnectionAccess(userId, rawConnectionId) {
    if (!stmts) init();
    const connectionKey = hashConnectionId(rawConnectionId);
    return stmts.getConnectionAccess.get(userId, connectionKey);
  }

  function listConnectionAccessForUser(userId) {
    if (!stmts) init();
    return stmts.listConnectionAccessForUser.all(userId);
  }

  function updateConnectionLock(userId, rawConnectionId, { lockedAt = null, selectedAt = null }) {
    if (!stmts) init();
    const connectionKey = hashConnectionId(rawConnectionId);
    stmts.updateConnectionLock.run({
      userId,
      connectionKey,
      lockedAt,
      selectedAt,
    });
  }

  // Support Tickets
  function createTicket(ticketData) {
    if (!stmts) init();
    const ts = getNow();
    const id = ticketData.id || `tkt_${crypto.randomBytes(8).toString("hex")}`;
    stmts.insertTicket.run({
      id,
      userId: ticketData.userId,
      category: ticketData.category,
      message: ticketData.message,
      status: ticketData.status || "open",
      stripeCustomerId: ticketData.stripeCustomerId || null,
      stripeOrderId: ticketData.stripeOrderId || null,
      createdAt: ticketData.createdAt || ts,
      updatedAt: ts,
    });
    return getTicket(id);
  }

  function getTicket(id) {
    if (!stmts) init();
    return stmts.getTicket.get(id);
  }

  function listTicketsForUser(userId) {
    if (!stmts) init();
    return stmts.listTicketsForUser.all(userId);
  }

  function updateTicketStatus(id, status) {
    if (!stmts) init();
    const ts = getNow();
    stmts.updateTicketStatus.run({ id, status, updatedAt: ts });
    return getTicket(id);
  }

  // Notification Outbox
  function enqueueNotification(outboxData) {
    if (!stmts) init();
    const ts = getNow();
    const id = outboxData.id || `notif_${crypto.randomBytes(10).toString("hex")}`;
    stmts.insertOutbox.run({
      id,
      channel: outboxData.channel,
      template: outboxData.template,
      recipient: outboxData.recipient || null,
      payloadJson: outboxData.payloadJson,
      status: outboxData.status || "pending",
      attemptCount: outboxData.attemptCount || 0,
      nextAttemptAt: outboxData.nextAttemptAt || ts,
      createdAt: outboxData.createdAt || ts,
      updatedAt: ts,
    });
    return id;
  }

  function getDueNotifications(nowTs = null, limit = 50) {
    if (!stmts) init();
    const ts = nowTs !== null ? nowTs : getNow();
    return stmts.getDueOutbox.all(ts, limit);
  }

  function markNotificationSent(id) {
    if (!stmts) init();
    stmts.updateOutboxSuccess.run(getNow(), id);
  }

  function markNotificationFailed(id, { nextAttemptAt, lastErrorCode = null }) {
    if (!stmts) init();
    stmts.updateOutboxFailure.run({
      id,
      nextAttemptAt,
      lastErrorCode,
      updatedAt: getNow(),
    });
  }

  // Transaction: Create Ticket with Outbox Notifications
  function createTicketWithNotifications({ ticket, notifications = [] }) {
    if (!stmts) init();
    const tx = db.transaction(() => {
      const createdTicket = createTicket(ticket);
      const createdNotifications = [];
      for (const notif of notifications) {
        const notifId = enqueueNotification(notif);
        createdNotifications.push(notifId);
      }
      return { ticket: createdTicket, notifications: createdNotifications };
    });
    return tx();
  }

  return {
    init,
    hashConnectionId,
    // Customers
    upsertCustomer,
    getCustomerByUserId,
    getUserByStripeCustomerId,
    // Orders & Agreements
    createOrder,
    getOrder,
    getOrderByCheckoutSessionId,
    getOrderByPaymentIntentId,
    listOrdersForUser,
    updateOrderStatus,
    createAgreement,
    getAgreementByOrderId,
    createOrderWithAgreement,
    // Subscriptions
    upsertSubscription,
    getSubscription,
    getSubscriptionByStripeId,
    getSubscriptionByUserId,
    updateSubscriptionStatus,
    // Entitlements
    createEntitlement,
    getEntitlement,
    getEntitlementBySource,
    listEntitlementsForUser,
    updateEntitlementStatus,
    // Events
    claimEvent,
    getEvent,
    updateEventStatus,
    // Policies
    upsertPolicyVersion,
    getPolicyVersion,
    listActivePolicies,
    // Connection Access
    recordConnectionUse,
    getConnectionAccess,
    listConnectionAccessForUser,
    updateConnectionLock,
    // Support Tickets
    createTicket,
    getTicket,
    listTicketsForUser,
    updateTicketStatus,
    // Notification Outbox
    enqueueNotification,
    getDueNotifications,
    markNotificationSent,
    markNotificationFailed,
    createTicketWithNotifications,
  };
}

module.exports = {
  createBillingStore,
};
