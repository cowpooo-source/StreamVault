# Standard Billing, Entitlements, Refunds, and Support Design

## Status

Approved architecture design for implementation planning. This document defines the first paid Standard tier, Stripe billing, automatic refunds, entitlement enforcement, support tickets, notification delivery, and the HTTPS/HTTP settings boundary.

## Goal

Add a safe, auditable self-service upgrade system for logged-in Portal Heaven users without coupling payment state directly to permanent account roles or exposing account operations on the HTTP content player.

The initial release sells Standard access in USD through Stripe-hosted Checkout:

| Product | Price | Billing behavior |
| --- | ---: | --- |
| Standard 30-Day Pass | $3.99 USD | One-time payment, 30 days of access |
| Standard Monthly | $2.99 USD | Renews monthly until canceled |
| Standard Yearly | $29.99 USD | Renews annually until canceled |

Stripe Checkout collects the billing address, applies Stripe Tax, requires Terms of Service acceptance, and displays the Privacy and refund policies. Taxes are added according to the customer's billing location and configured Stripe Tax registrations.

## User-Facing Terminology

- `Free` is the default registered-user tier.
- `Standard` is the only paid tier shown to customers in this release.
- Internally, active Standard access receives the existing `regular` limits.
- `Friend & Family` is an internal, admin-granted, indefinite Standard entitlement. It is never shown in registration, pricing, checkout, or plan-selection lists. Recipients see `Standard`.
- `Pro` remains an internal reserved role for a future higher-priced product. It is not shown or purchasable in this release.
- Existing `regular` users remain grandfathered and do not need Stripe records.
- Existing internal `pro` users retain their limits but are not offered or listed as a customer-selectable plan.

The initial Standard limits remain the existing Regular limits:

- Five active saved connections.
- Unlimited VOD within existing provider and application constraints.
- EPG enabled.
- Sync enabled.
- Three concurrent authenticated logins.
- No ads.

Free limits remain unchanged:

- Two active saved connections.
- Existing Free VOD limit.
- One concurrent authenticated login.
- Existing Free advertising behavior.

## Architectural Decision

Use a local entitlement ledger synchronized from verified Stripe webhooks.

Stripe is the authority for customers, charges, invoices, refunds, subscriptions, and payment methods. The local SQLite database is the authority for application access after it has processed those Stripe events. User requests never query Stripe on every login or playback request.

Permanent account roles and temporary billing access remain separate:

- `users.role` remains the permanent/base role.
- A paid purchase creates or updates Standard entitlements.
- Friend & Family creates an indefinite Standard entitlement without Stripe.
- Effective access is calculated from the base role plus current entitlements.
- Subscription expiry or refund never overwrites a grandfathered Regular, Pro, or Admin base role.
- Free users return to Free when no active or grace-period Standard entitlement remains.

This replaces the existing prototype billing implementation. The prototype must not be extended because it trusts browser-supplied user, plan, and Price IDs; assumes subscription mode for every purchase; depends on optional PostgreSQL; lacks the required schema; and does not safely mount a raw-body Stripe webhook before the global JSON parser.

## System Boundaries

### HTTPS Control Plane

`https://media.portalheaven.stream/app` owns:

- Authentication and registration.
- Account and profile management.
- Connection creation, import, switching, and plan-lock management.
- Pricing and Checkout initiation.
- Billing status, cancellation, scheduled purchases, and Customer Portal access.
- Refund eligibility and automatic refund initiation.
- Purchase agreements, receipts, and invoices.
- Support tickets and dispute requests.
- Privacy and analytics consent.
- Logout and administrative controls.

### HTTP Content Plane

`http://playerportal.hopto.org/content` owns only browsing and playback concerns:

- Playback and reconnect controls.
- Audio and subtitle preferences.
- Appearance and language.
- Catalog layout.
- Local catalog/cache controls.

The HTTP content plane must not load Stripe, accept support messages, change account state, expose billing records, or process refunds. Its Settings entry is renamed `Player Settings` and includes a locked `Account, Billing & Support` link to the HTTPS application.

No account JWT, provider credentials, content-session token, or return token is placed in that HTTPS link. Returning to content requires selecting a connection and creating a fresh content session.

## Component Boundaries

The implementation keeps payment concerns out of the existing authentication and playback modules:

- `billingCatalog` owns the fixed product-code-to-Stripe-Price mapping and public display metadata. It never accepts a Price ID or amount from a request.
- `billingStore` owns additive SQLite schema, prepared statements, and short transactions for customers, orders, subscriptions, entitlements, agreements, events, and outbox records.
- `entitlementService` calculates effective access and performs activation, scheduling, grace, expiry, refund, and complimentary-grant transitions.
- `stripeGateway` is the only module that calls the Stripe SDK. It creates Checkout, Customer Portal, refunds, cancellations, schedules, and explicit reconciliation reads.
- `stripeEventProcessor` verifies event applicability, enforces idempotency and event ordering, and translates Stripe state into local billing transitions.
- `billingRouter` exposes authenticated HTTPS billing APIs and the separately mounted raw-body webhook.
- `connectionAccessService` HMACs connection identities, tracks successful use, chooses the active limit set, and enforces locks during content-session creation.
- `supportService` validates and stores tickets without depending on email or Discord availability.
- `notificationOutboxService` renders allowlisted templates and performs bounded retry delivery to Brevo and Discord.
- `billingReconciler` runs startup/periodic local transitions and explicit, bounded Stripe reconciliation.
- Frontend `billingApi` normalizes billing responses and errors without embedding Stripe SDK logic.
- Frontend `BillingSettings`, `SupportSettings`, and `AccountStatusCard` own the secure UI. `PlayerSettings` owns the reduced HTTP-only settings surface.

Authentication consumes one stable `getEffectiveAccess(userId, now)` interface. Playback and content-session code consume one stable `assertConnectionAllowed(userId, connectionId)` interface. Neither module reads Stripe objects directly.

## Effective Access Model

Effective access uses this precedence:

1. Base `admin`.
2. Base `pro`.
3. Base `regular`.
4. Active or grace-period Standard entitlement.
5. Indefinite Friend & Family Standard entitlement.
6. Base `free`.
7. Anonymous `guest`.

For backward compatibility, authenticated API responses retain `role` as the effective role used by current frontend limit and advertising logic. They add:

- `baseRole`: the stored permanent role.
- `plan`: `free` or `standard` for this release.
- `planSource`: `paid`, `grandfathered`, `complimentary`, or `base_role`.
- `billingStatus`: `none`, `scheduled`, `active`, `grace`, `canceling`, `refund_pending`, or `expired`.
- `accessStartsAt` and `accessEndsAt` when applicable.
- `nextBillingAt` when applicable.
- `cancelAtPeriodEnd`.
- `limits`: limits derived from effective access.

JWT role claims are informational only. Every authenticated request already resolves the current database user; effective access must be calculated from current database state so billing changes do not require waiting for JWT expiry.

## Data Model

Billing uses the same SQLite database as `users`, sessions, synchronized connections, and content sessions. Optional PostgreSQL remains isolated to its existing synchronization features. All schema changes are additive and idempotent.

### `billing_customers`

Maps one Portal Heaven account to one Stripe Customer.

- `user_id INTEGER PRIMARY KEY`
- `stripe_customer_id TEXT NOT NULL UNIQUE`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

### `billing_orders`

Records every Checkout intent and its resulting payment state.

- `id TEXT PRIMARY KEY`, generated server-side UUID.
- `user_id INTEGER NOT NULL`
- `product_code TEXT NOT NULL`, one of `standard_pass_30d`, `standard_monthly`, or `standard_yearly`.
- `checkout_mode TEXT NOT NULL`, one of `payment`, `subscription`, or `setup`.
- `status TEXT NOT NULL`, one of `created`, `checkout_open`, `scheduled`, `paid`, `payment_failed`, `refund_pending`, `refunded`, `refund_failed`, `canceled`, or `expired`.
- `stripe_price_id TEXT NOT NULL`, copied from server configuration.
- `stripe_checkout_session_id TEXT UNIQUE`
- `stripe_payment_intent_id TEXT UNIQUE`
- `stripe_invoice_id TEXT`
- `stripe_subscription_id TEXT`
- `stripe_schedule_id TEXT`
- `currency TEXT NOT NULL DEFAULT 'usd'`
- `amount_subtotal INTEGER`
- `amount_tax INTEGER`
- `amount_total INTEGER`
- `requested_start_at INTEGER`
- `access_start_at INTEGER`
- `access_end_at INTEGER`
- `refundable_until INTEGER`
- `refunded_at INTEGER`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

Money is stored in the smallest currency unit. Browser-supplied amounts, currencies, Stripe Price IDs, user IDs, and access dates are never trusted.

### `billing_subscriptions`

Stores the current local projection of recurring Stripe state.

- `id TEXT PRIMARY KEY`
- `user_id INTEGER NOT NULL`
- `product_code TEXT NOT NULL`
- `stripe_subscription_id TEXT UNIQUE`
- `stripe_schedule_id TEXT UNIQUE`
- `status TEXT NOT NULL`
- `current_period_start INTEGER`
- `current_period_end INTEGER`
- `scheduled_start_at INTEGER`
- `cancel_at_period_end INTEGER NOT NULL DEFAULT 0`
- `grace_until INTEGER`
- `last_stripe_event_created INTEGER NOT NULL DEFAULT 0`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

Events older than `last_stripe_event_created` remain recorded in the event ledger but cannot regress the subscription projection.

### `billing_entitlements`

Represents application access independently of payment mechanics.

- `id TEXT PRIMARY KEY`
- `user_id INTEGER NOT NULL`
- `tier TEXT NOT NULL`, initially `standard`.
- `source_type TEXT NOT NULL`, one of `pass`, `subscription`, `friend_family`, `grandfathered`, or `admin`.
- `source_id TEXT NOT NULL`
- `status TEXT NOT NULL`, one of `scheduled`, `active`, `grace`, `expired`, `revoked`, or `refunded`.
- `starts_at INTEGER NOT NULL`
- `ends_at INTEGER`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- Unique constraint on `source_type, source_id`.

Friend & Family uses `source_type=friend_family` and `ends_at=NULL`. Existing Regular/Pro/Admin users do not need synthetic entitlement rows because their base roles already preserve access.

### `billing_events`

Provides webhook idempotency and operational evidence without storing complete webhook payloads.

- `stripe_event_id TEXT PRIMARY KEY`
- `event_type TEXT NOT NULL`
- `livemode INTEGER NOT NULL`
- `stripe_created_at INTEGER NOT NULL`
- `status TEXT NOT NULL`, one of `received`, `processed`, `ignored`, or `failed`.
- `payload_sha256 TEXT NOT NULL`
- `attempt_count INTEGER NOT NULL DEFAULT 0`
- `last_error_code TEXT`
- `received_at INTEGER NOT NULL`
- `processed_at INTEGER`

Full Stripe events remain retrievable from Stripe. Logs and database rows contain no card details or unredacted payload dumps.

### `policy_versions`

Defines immutable published policy versions.

- `policy_type TEXT NOT NULL`, one of `terms`, `privacy`, or `refund`.
- `version TEXT NOT NULL`
- `public_url TEXT NOT NULL`
- `content_sha256 TEXT NOT NULL`
- `published_at INTEGER NOT NULL`
- `retired_at INTEGER`
- Primary key on `policy_type, version`.

The referenced policy content is versioned in source control and served from stable HTTPS URLs.

### `purchase_agreements`

Records proof of the user's agreement for each Checkout or future-payment setup.

- `id TEXT PRIMARY KEY`
- `order_id TEXT NOT NULL UNIQUE`
- `user_id INTEGER NOT NULL`
- `terms_version TEXT NOT NULL`
- `privacy_version TEXT NOT NULL`
- `refund_version TEXT NOT NULL`
- `terms_sha256 TEXT NOT NULL`
- `privacy_sha256 TEXT NOT NULL`
- `refund_sha256 TEXT NOT NULL`
- `accepted_at INTEGER NOT NULL`
- `stripe_checkout_session_id TEXT UNIQUE`
- `stripe_terms_accepted INTEGER NOT NULL DEFAULT 0`
- `stripe_consent_recorded_at INTEGER`

The evidence combines authenticated Portal Heaven intent, exact policy versions and hashes, Stripe Checkout consent, Stripe Checkout Session ID, the processed Stripe event ID, and Stripe's invoice or receipt. Card data is never stored.

### `connection_access`

Stores connection usage and plan-lock selection without storing raw connection IDs or provider information.

- `user_id INTEGER NOT NULL`
- `connection_key TEXT NOT NULL`, an HMAC-SHA256 of the current connection ID using a dedicated server secret.
- `last_used_at INTEGER`
- `selected_at INTEGER`
- `locked_at INTEGER`
- Primary key on `user_id, connection_key`.

### `support_tickets`

- `id TEXT PRIMARY KEY`, a user-visible non-sequential ticket ID.
- `user_id INTEGER NOT NULL`
- `category TEXT NOT NULL`, one of `billing_refund`, `payment_failed`, `account`, `technical`, or `other`.
- `message TEXT NOT NULL`
- `status TEXT NOT NULL`, initially `open`, then `in_progress`, `resolved`, or `closed`.
- `stripe_customer_id TEXT`
- `stripe_order_id TEXT`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

Tickets never contain passwords, provider credentials, card data, or complete Stripe payment objects. V1 has no attachments and no in-app conversation thread.

### `notification_outbox`

Persists email and Discord notifications independently from payment and ticket transactions.

- `id TEXT PRIMARY KEY`
- `channel TEXT NOT NULL`, `email` or `discord`.
- `template TEXT NOT NULL`
- `recipient TEXT`
- `payload_json TEXT NOT NULL`, containing only template-specific sanitized fields.
- `status TEXT NOT NULL`, `pending`, `sending`, `sent`, or `failed`.
- `attempt_count INTEGER NOT NULL DEFAULT 0`
- `next_attempt_at INTEGER NOT NULL`
- `last_error_code TEXT`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

Webhook URLs and email provider secrets stay in environment configuration and never enter outbox payloads.

## Product and Scheduling Rules

Self-service Standard purchases are available only when the user's effective Standard access is Free or comes from an existing paid Standard order. Base Regular, Admin, Pro, and complimentary Standard accounts cannot create redundant Standard Checkout sessions. Their Billing UI shows that Standard-equivalent access is already included.

An administrator cannot add complimentary Standard to an account with an actively renewing paid subscription without first scheduling or confirming cancellation. This prevents an admin grant from silently leaving an unnecessary recurring charge active.

### 30-Day Pass

- A Free user pays immediately and receives 30 days of Standard access after verified payment.
- A user with an active or scheduled pass can buy another pass; each successful payment adds exactly 30 days after the latest pass entitlement end.
- A pass purchased behind a subscription with `cancel_at_period_end=true` starts at the current subscription period end.
- An actively renewing subscriber cannot buy a pass.
- The UI explains that cancellation must be scheduled before purchasing a pass.
- A queued pass can be purchased only during the final 30 days of the ending subscription period. Earlier attempts show the exact date on which pass purchase becomes available, avoiding a charge many months before access can start.
- Once a paid pass is queued behind a subscription, the application preserves the subscription's end-of-period cancellation. If Stripe reports cancellation reversal, reconciliation re-applies `cancel_at_period_end=true` and notifies the user.

### Monthly and Yearly Subscriptions

- Monthly renews every month until canceled.
- Yearly is charged once per year and renews annually until canceled.
- A Free user enters normal Stripe subscription Checkout.
- Access activates only after a verified paid invoice event.
- A user with an active pass uses Stripe Setup Checkout to authenticate and save a payment method without being charged immediately.
- After successful Setup Checkout, the server creates a Stripe Subscription Schedule whose `start_date` equals the current pass entitlement end.
- The scheduled subscription's first charge occurs on its start date.
- The secure Billing UI clearly states `No charge today` and shows the first charge amount and date before Setup Checkout.
- A scheduled subscription can be canceled from Portal Heaven before it begins.
- Canceling the future schedule does not affect the active pass.
- Monthly/yearly plan changes use Stripe Customer Portal and take effect at the next billing cycle without mid-cycle proration.

### Normal Cancellation

- Cancellation sets `cancel_at_period_end=true`.
- Standard access remains active through the paid period.
- The user may buy a 30-day pass once cancellation is scheduled; that pass is queued after the paid subscription period.
- Canceling a scheduled future subscription prevents its first charge.

### Payment Failure and Grace

- Initial subscription payment failure grants no Standard entitlement.
- Renewal failure changes the entitlement to `grace` for 72 hours.
- The Billing UI shows the failed payment, grace deadline, and Stripe Customer Portal action.
- `invoice.paid` during grace returns the entitlement to `active`.
- If the grace deadline passes without payment, the entitlement expires and effective access is recalculated.
- The grace sweep runs at process startup and periodically; it is based on persisted timestamps and is safe across restarts.

## Stripe Checkout and Webhook Flow

### Checkout Creation

1. A logged-in user opens the HTTPS Billing tab.
2. The frontend requests current billing status and product eligibility.
3. The frontend submits a fixed `productCode` and explicit policy acceptance to the same-origin backend.
4. The backend validates authentication, CSRF, eligibility, product conflicts, and active policy versions.
5. The backend creates a pending order and purchase agreement transactionally.
6. The backend maps the product code to server-side Stripe Price configuration.
7. The backend creates or reuses the user's Stripe Customer.
8. The backend creates a Stripe Checkout Session with billing-address collection, automatic tax, required Terms consent, safe metadata, success URL, and cancel URL.
9. The browser navigates to the returned Stripe-hosted URL.

Stripe metadata contains only opaque Portal Heaven order and user IDs. It contains no provider data, secrets, raw connection IDs, or authorization tokens.

### Checkout Return

Stripe returns to the HTTPS Billing tab with only the Checkout Session identifier. The page displays `Payment received - verifying with Stripe` and polls local billing status. A successful browser redirect never activates access by itself.

### Webhook Mounting

`POST /api/billing/webhook` is mounted with `express.raw({type: 'application/json'})` before the global JSON parser. It does not use normal user authentication or CSRF. It requires a valid Stripe signature and rejects live/test mode mismatch.

### Required Events

The event processor handles at least:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.payment_action_required`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- Subscription schedule created, updated, completed, canceled, and released events used by the installed Stripe API version.
- `refund.created`
- `refund.updated`
- `refund.failed`

Every event is inserted into `billing_events` before processing. Repeated event IDs return success without reapplying side effects. Failed processing returns non-2xx so Stripe retries. State changes and event completion occur in one SQLite transaction where possible.

Out-of-order events are recorded but cannot regress newer subscription state. Periodic reconciliation can retrieve current Stripe objects and repair local projections explicitly.

## Automatic Refunds

### Eligibility

The customer-facing Refund button offers one full refund only when:

- The order belongs to the authenticated user.
- The payment succeeded.
- The request is within seven calendar days of the charge timestamp.
- The remaining refundable amount equals the full original charge.
- No full or partial refund already exists.
- No unresolved dispute or chargeback exists.
- The order is not already refund-pending.
- The configured Stripe mode matches the order.

Partial refunds and refunds outside the window remain administrator/support actions in Stripe.

### Confirmation

The HTTPS confirmation dialog shows:

- Full amount and currency.
- The effect on subscription renewal.
- That Standard access ends only after the refund succeeds unless another entitlement applies.
- That the account returns to Free when no other entitlement applies.
- That the two most recently used connections remain active and all others stay saved but locked.
- The expected bank processing delay.

The user must check a final confirmation before submission.

### Processing

1. The server re-evaluates eligibility in a SQLite transaction.
2. It creates a Stripe full refund using a stable idempotency key derived from the order.
3. `pending` remains visible and blocks duplicate requests; entitlement remains unchanged.
4. On confirmed refund success, the related entitlement becomes `refunded`.
5. If the refund is for the current recurring period, the server cancels the subscription immediately and prevents future renewal.
6. Effective access is recalculated.
7. If another active entitlement exists, access continues under that entitlement.
8. If no qualifying entitlement remains, the account downgrades to its base role.
9. Refund failure restores the order to `refund_failed`, leaves access unchanged, and exposes a support action.

A refunded queued pass is removed without affecting the current subscription. Refunding an active pass does not silently accelerate and charge a future scheduled subscription; the future schedule keeps its disclosed start date unless the user separately confirms an earlier start.

## Connection Downgrade Behavior

Saved connection snapshots remain encrypted and are never deleted or rewritten merely because account limits decrease.

When effective access changes from Standard/Regular limits to Free limits:

1. The server ranks known connection HMACs by `last_used_at` descending.
2. The two most recently used become the active allowlist.
3. Remaining known connections become `locked_at` by plan limit.
4. Unknown/tied legacy connections use stable client order as the fallback selection during the first secure reconciliation.
5. Content sessions for newly locked connections are revoked.
6. New content sessions for locked connections are rejected with `connection_plan_locked`.
7. The secure Setup screen shows every saved connection and identifies locked entries.
8. The user can replace one active connection with one locked connection through a same-origin HTTPS action.
9. Deleting an active connection promotes the most recently used locked connection when one exists.
10. Re-upgrade removes plan locks automatically while preserving user-selected ordering.

Plan-locked overflow is available only to preserve connections that existed before a downgrade. A Free user at the two-connection limit cannot add or import additional connections as locked overflow.

The backend stores only HMAC connection identities. The secure frontend may send current raw connection IDs over HTTPS for reconciliation, but they are immediately HMACed and never persisted or logged in raw form.

Connection usage updates only when a connection is successfully opened or a content session is successfully created. Failed validation does not make a connection one of the two most recently used.

## Support Workflow

Support is available only to authenticated users on HTTPS.

The V1 form contains:

- Category: Billing/Refund, Payment Failed, Account, Technical, or Other.
- Message, maximum 2,000 characters.
- Account identity attached server-side.
- Safe Stripe customer/order references attached server-side when relevant.

Submission flow:

1. Validate authentication, CSRF, category, length, and support-specific rate limit.
2. Reject likely passwords, card numbers, provider URLs with embedded credentials, and known token formats with a safe correction message.
3. Insert the ticket and two notification-outbox rows transactionally.
4. Return the ticket ID immediately.
5. Email `support@portalheaven.stream`.
6. Email the user a confirmation containing the ticket ID.
7. Send a sanitized Discord alert containing only ticket ID, username, category, timestamp, and a secure admin/support link.

V1 replies occur through the support mailbox. There are no attachments and no in-app conversation thread. Email or Discord delivery failure never loses the ticket.

## Notification Ownership

Stripe handles configured payment communications:

- Receipts and invoices.
- Failed-payment notices.
- Required payment authentication.
- Renewal reminders and expiring-card notices.
- Cancellation confirmations.
- Refund confirmation when enabled in Stripe settings.

Portal Heaven handles application communications:

- Standard access activated.
- Future subscription scheduled or canceled.
- Pass scheduled or extended.
- Grace period started and access expired.
- Effective downgrade and connection locking.
- Friend & Family grant changes.
- Support ticket confirmation.

Portal Heaven does not duplicate Stripe receipts or expose card details. Email templates include plan, relevant date, account action link, and support link.

## API Surface

All endpoints except the Stripe webhook require same-origin HTTPS authentication and CSRF validation.

### Billing

- `GET /api/billing/status`
  - Returns effective plan, billing status, current/scheduled entitlements, next billing date, cancellation state, refund eligibility, agreement/receipt summaries, and fixed public product display data.
- `POST /api/billing/checkout`
  - Accepts only `{productCode, acceptedPolicyVersions}`.
  - Returns `{checkoutUrl, orderId}`.
- `POST /api/billing/portal`
  - Creates a short-lived Stripe Customer Portal session.
- `POST /api/billing/subscription/cancel`
  - Schedules end-of-period cancellation.
- `POST /api/billing/subscription/scheduled/cancel`
  - Cancels a future subscription schedule before its first charge.
- `POST /api/billing/refunds`
  - Accepts only `{orderId, confirmFullRefund: true}`.
  - Returns normalized refund-pending or completed status.
- `GET /api/billing/orders`
  - Returns the authenticated user's safe order/agreement history and Stripe-hosted receipt/invoice links.
- `POST /api/billing/webhook`
  - Stripe-signed raw-body endpoint.

### Connection Access

- `POST /api/account/connections/reconcile`
  - Accepts current connection IDs over HTTPS, HMACs them, and returns active/locked status by input index.
- `POST /api/account/connections/select`
  - Replaces one active connection with one saved locked connection while enforcing the effective limit.

### Support

- `POST /api/support/tickets`
  - Creates an authenticated support ticket.
- `GET /api/support/tickets`
  - Returns the user's ticket IDs, categories, status, and timestamps without message-thread features.

### Administration

- Admin-only action to grant or revoke complimentary Standard access.
- Friend & Family and Pro are not public plan-list values.
- Admin billing views expose safe Stripe object IDs and reconciliation status, not payment credentials.

## UI Design

### Secure Settings

HTTPS Settings uses these tabs:

- General.
- Account.
- Billing.
- Support.
- Data.

The account-status card appears on Setup and in Settings. Public plan lists contain only Free and Standard. The Billing tab includes:

- Current plan and status.
- The three Standard products.
- `Tax calculated at checkout`.
- Next renewal, expiration, grace, or scheduled-start date.
- Manage Payment Method and Manage Billing.
- Cancel Subscription or Cancel Scheduled Subscription.
- Eligible Full Refund.
- Order, agreement, receipt, and invoice history.

The current repeated upgrade popup becomes a dismissible one-time notice. Persistent Upgrade actions remain in the account-status card and near reached connection limits.

### Plan Cards

- 30-Day Pass: `$3.99 one-time`.
- Monthly: `$2.99 per month`.
- Yearly: `$29.99 per year`, with `$2.50/month equivalent` and `Best Value`.

If a product is not eligible, the card remains understandable but its action is replaced with the exact reason and next valid action. Active subscribers see that the pass requires scheduled cancellation. Active-pass users see the future subscription start and first-charge date.

### Checkout Return

Success return states:

- `Verifying payment` while waiting for the local webhook projection.
- `Standard activated` after verified payment.
- `Subscription scheduled for <date>` after future-payment setup.
- A retry/status action if webhook confirmation is delayed.

Cancel return preserves the user's previous plan and pending order history without showing an error.

### HTTP Player Settings

The HTTP page shows no Account or Data mutation tabs. It displays a secure-link card:

> Account, Billing & Support - opens secure settings at media.portalheaven.stream

Free users may see `Upgrade Securely`, which navigates to the HTTPS Billing tab. No Stripe scripts or billing API calls run on the HTTP origin.

## Security Requirements

- Authenticate all customer billing, refund, support, and connection-access routes.
- Validate Origin and CSRF token for state-changing authenticated routes.
- Select users from `req.user`; never accept user IDs from the browser.
- Map product codes to server-side Stripe Price IDs.
- Verify webhook signatures against the raw body.
- Reject webhook live/test mode mismatch.
- Use Stripe idempotency keys for Checkout, refunds, subscription cancellation, and schedule creation.
- Apply dedicated rate limits to Checkout, portal creation, refunds, and support.
- Sanitize logs and notifications.
- Never log Stripe secrets, webhook payloads, payment method details, provider credentials, raw connection IDs, content tokens, or Discord webhook URLs.
- Keep support and operational Discord webhook URLs in environment files outside Git.
- Use stable policy URLs, versions, and hashes.
- Keep Stripe success/cancel redirect parameters non-authoritative.
- Return structured error codes and safe user messages.
- Preserve existing direct-play behavior and never route media through billing services.

## Error Contract

Billing and support errors use `{error, code, retryable}` and optional safe metadata such as `retryAfterSeconds` or `eligibleAt`.

Required codes include:

- `billing_disabled`
- `billing_not_authenticated`
- `billing_product_invalid`
- `billing_product_conflict`
- `billing_checkout_pending`
- `billing_provider_unavailable`
- `billing_verification_pending`
- `subscription_already_active`
- `subscription_schedule_not_found`
- `refund_not_eligible`
- `refund_window_expired`
- `refund_already_requested`
- `refund_pending`
- `refund_failed`
- `connection_plan_locked`
- `support_rate_limited`
- `support_sensitive_content`
- `notification_delivery_pending`

Stripe or email provider errors are never passed verbatim to customers.

## Background Reconciliation

At startup and on a bounded periodic schedule, the billing service:

- Activates scheduled local pass entitlements whose predecessor ended.
- Expires elapsed pass and subscription entitlements.
- Ends unpaid grace periods.
- Recalculates effective access for affected users.
- Reconciles connection locks after a limit decrease.
- Retries pending notification-outbox rows with bounded exponential backoff.
- Detects stale webhook/order states and marks them for explicit Stripe reconciliation.

It does not poll every Stripe customer. An admin-only reconciliation operation retrieves specific Stripe customers, subscriptions, orders, or a bounded recent-failure set and produces an audit report before applying repairs.

## Configuration

Required production configuration includes:

- `BILLING_ENABLED=false` by default.
- `STRIPE_SECRET_KEY`.
- `STRIPE_WEBHOOK_SECRET`.
- `STRIPE_PRICE_STANDARD_PASS_30D`.
- `STRIPE_PRICE_STANDARD_MONTHLY`.
- `STRIPE_PRICE_STANDARD_YEARLY`.
- `STRIPE_LIVE_MODE`.
- `STRIPE_TAX_ENABLED=true`.
- `BILLING_REFUND_WINDOW_DAYS=7`.
- `BILLING_GRACE_PERIOD_HOURS=72`.
- Current Terms, Privacy, and refund policy versions and HTTPS URLs.
- `SUPPORT_EMAIL=support@portalheaven.stream`.
- `SUPPORT_DISCORD_WEBHOOK_URL`, stored only in the protected service environment.
- A dedicated connection-identity HMAC secret or a versioned derivation from an existing protected master key.

The environment example contains names and safe placeholders only. Production startup reports which billing capabilities are configured without printing values. Login, setup, and playback remain available when billing is disabled or incompletely configured.

## Migration and Backward Compatibility

- Back up and verify the active SQLite database before deployment.
- Create all new tables idempotently before enabling routes.
- Do not change existing `users.role` values during schema migration.
- Existing Regular, Pro, and Admin users retain current access.
- New registrations remain Free.
- Existing `subscription_cycle` and `subscription_expires_at` columns remain readable during transition but stop being authoritative after ledger rollout.
- A one-time migration may translate valid legacy subscription dates into ledger entitlements only after a dry-run report and manual approval.
- The current prototype Stripe route and service are replaced, not run beside the new processor.
- Existing PostgreSQL synchronization remains independent.
- Existing HTTP content sessions and direct playback remain unchanged except for connection plan-lock enforcement.

## Testing Strategy

### Backend Unit Tests

- Effective-role precedence for Admin, Pro, Regular, Standard, Friend & Family, Free, and Guest.
- Active, scheduled, grace, expired, revoked, and refunded entitlement calculations.
- Pass extension and queue ordering.
- Subscription/pass product-conflict rules.
- Seven-day refund boundary and full-refund-only enforcement.
- Connection ranking, locking, promotion, and restoration.
- Policy-version and agreement evidence.
- Support validation and sensitive-content rejection.
- Notification retry/backoff and payload sanitization.
- Out-of-order Stripe event protection.

### Backend Integration Tests

- Raw webhook signature verification and JSON parser ordering.
- Duplicate webhook idempotency.
- Test/live mode rejection.
- Authenticated Checkout with fixed server-side prices.
- Browser-supplied price/user/amount rejection.
- One-time, monthly, yearly, and future-scheduled subscription flows.
- Automatic tax and billing-address Checkout parameters.
- Customer Portal creation and plan-change behavior.
- Cancellation and three-day grace recovery.
- Refund pending, succeeded, failed, and duplicate requests.
- Support ticket persistence when email or Discord fails.
- Billing-disabled behavior without login/playback regression.

### Frontend Tests

- Public plan labels and fixed prices.
- Friend & Family and Pro absent from all plan-selection lists.
- Billing status and eligibility rendering.
- One-time upgrade notice behavior.
- Checkout verification state.
- Refund confirmation copy and disabled duplicate action.
- Locked connection visibility and selection.
- Secure Support form and ticket confirmation.
- HTTP Player Settings contains no billing/support mutation UI.

### Playwright and Stripe Test Mode

- Free logged-in user starts one-time Checkout.
- Monthly and yearly Checkout configuration.
- Active pass schedules future subscription without immediate charge.
- Active subscriber cannot buy a pass.
- Canceling renewal enables queued-pass purchase.
- Verified webhook activates Standard.
- Normal cancellation preserves access until period end.
- Failed renewal enters grace and expiry downgrades safely.
- Full refund transitions through pending/success and locks excess connections.
- Friend & Family can only be granted administratively and appears as Standard to the recipient.
- Support creates a ticket and tolerates notification failure.
- HTTP settings redirect securely to HTTPS.

Before live enablement, use Stripe test mode and Stripe CLI forwarding to exercise the exact production webhook route and event set. No live payment is used as an automated test.

## Rollout

1. Add schema and billing services with `BILLING_ENABLED=false`.
2. Run migration dry-run, backup/restore verification, unit tests, integration tests, frontend tests, and Playwright.
3. Configure Stripe test products, prices, Tax, Customer Portal, legal policies, customer emails, and test webhook.
4. Enable billing only in sandbox and complete manual one-time, monthly, yearly, cancellation, failed-payment, refund, and support checks.
5. Deploy disabled code to production and verify login, setup, sync, HTTP content, and direct playback.
6. Configure production Stripe live products, Price IDs, Tax registrations, support details, webhook secret, and policies.
7. Enable production billing for an admin/test cohort.
8. Verify audit records, emails, Discord sanitization, refunds, entitlement transitions, CPU, errors, and database backups.
9. Expand to all logged-in users.

Rollback disables new Checkout and refund initiation while leaving webhook processing enabled. This allows already-created payments, refunds, and subscriptions to finish reconciling safely. Existing entitlements remain available from SQLite during a Stripe outage.

## Acceptance Criteria

- Only logged-in users can purchase, manage billing, request refunds, or create support tickets.
- Public UI offers only Free and Standard.
- Base Regular, Admin, Pro, and complimentary Standard accounts cannot create redundant Standard purchases.
- Standard products and prices match the approved USD catalog.
- Checkout uses server-side prices, billing-address collection, automatic tax, and required Terms consent.
- Browser redirects never grant access without verified Stripe events.
- Existing Regular, Pro, and Admin access survives payment expiry and refund operations.
- Friend & Family is admin-only, non-expiring by default, and shown to the recipient as Standard.
- Monthly and yearly subscriptions renew until canceled.
- Normal cancellation preserves access through the paid period.
- Active subscribers cannot buy a pass until cancellation is scheduled.
- A queued pass can be purchased only within 30 days of the ending subscription period.
- Active pass users can schedule a subscription whose first charge occurs after the pass ends.
- Additional passes extend or queue without overlapping entitlement time.
- Renewal failures receive exactly 72 hours of grace.
- Eligible customers can request one full automatic refund within seven calendar days.
- Successful current-period refunds stop renewal and recalculate access.
- Refund failure does not remove paid access.
- Downgrade keeps two most recently used connections active and preserves all others as locked.
- Re-upgrade restores plan-locked connections without re-import.
- Billing and support remain unavailable on the HTTP content origin.
- Support tickets survive email or Discord delivery failure.
- Stripe events are signature-verified, idempotent, and resistant to out-of-order regression.
- Billing can be disabled without breaking login, setup, sync, content browsing, or playback.

## Non-Goals

- Launching the future Pro product.
- Public Friend & Family enrollment.
- Guest checkout.
- Partial self-service refunds.
- Purchasing a pass more than 30 days before an ending subscription period.
- Refunds outside the seven-day window without administrator review.
- Support attachments or in-app support conversations.
- Moving billing, account management, or support onto HTTP.
- Storing card data.
- Replacing Stripe Customer Portal with a custom payment-method form.
- Changing direct-play or provider streaming architecture.

## Official Stripe References

- [Checkout Session consent](https://docs.stripe.com/api/checkout/sessions/object)
- [Create a Checkout Session](https://docs.stripe.com/api/checkout/sessions/create)
- [Automatic tax](https://docs.stripe.com/tax/checkout)
- [Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Subscription schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules)
- [Save payment details for future payments](https://docs.stripe.com/payments/checkout/save-and-reuse)
- [Customer Portal](https://docs.stripe.com/customer-management)
- [Refunds](https://docs.stripe.com/refunds)
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Checkout policies and support information](https://docs.stripe.com/get-started/account/branding)
