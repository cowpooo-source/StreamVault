# Subscription & Tier-Based User Accounts Plan

## Overview

Integrate a subscription-based payment system into StreamVault, allowing users to upgrade their accounts via monthly subscriptions. The system will include:

1. **Subscription Plans**: Define tier limits (connections, VOD, features) and pricing.
2. **Payment Integration**: Stripe for handling payments, subscriptions, and webhooks.
3. **User Subscription Management**: Frontend pages for users to view/upgrade/cancel subscriptions, view billing history.
4. **Admin Management**: Admin panel to manage plans, view subscriptions, and handle refunds.
5. **Backend APIs**: New endpoints for plans, subscriptions, payment intents, webhooks.

## Current User System Analysis

The existing `auth.js` defines:
- Roles: `admin`, `regular`, `free`, `guest`
- Role limits: `maxConnections`, `maxVod`, `epg`, `sync`
- Database: SQLite with `users` table

We will extend this with subscription plans while maintaining backward compatibility.

## Database Schema Additions

### Table: `plans`
```sql
CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, -- e.g., "Free", "Basic", "Premium"
  description TEXT,
  price INTEGER NOT NULL, -- in cents (USD)
  interval TEXT NOT NULL DEFAULT 'month', -- 'month' or 'year'
  stripe_price_id TEXT UNIQUE, -- Stripe Price ID
  max_connections INTEGER NOT NULL DEFAULT 2,
  max_vod INTEGER, -- NULL = unlimited
  epg BOOLEAN NOT NULL DEFAULT 1,
  sync BOOLEAN NOT NULL DEFAULT 1,
  features JSON, -- extra features list
  active BOOLEAN NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
```

### Table: `subscriptions`
```sql
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT NOT NULL,
  status TEXT NOT NULL, -- 'active', 'canceled', 'past_due', 'unpaid', 'incomplete'
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);
```

### Table: `payments`
```sql
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subscription_id INTEGER REFERENCES subscriptions(id),
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_invoice_id TEXT,
  amount INTEGER NOT NULL, -- in cents
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL, -- 'succeeded', 'failed', 'processing'
  description TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_payments_user ON payments(user_id);
CREATE INDEX idx_payments_subscription ON payments(subscription_id);
```

### Table: `webhook_events` (optional for idempotency)
```sql
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id TEXT UNIQUE,
  type TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  data JSON
);
```

## Backend API Endpoints

### 1. Plans
- `GET /api/plans` – list active plans (public)
- `GET /api/admin/plans` – list all plans (admin)
- `POST /api/admin/plans` – create plan (admin)
- `PUT /api/admin/plans/:id` – update plan (admin)
- `DELETE /api/admin/plans/:id` – deactivate plan (admin)

### 2. Subscriptions
- `GET /api/user/subscription` – get current subscription (user)
- `POST /api/user/subscription` – create/update subscription (user)
- `DELETE /api/user/subscription` – cancel subscription (user)
- `GET /api/admin/subscriptions` – list all subscriptions (admin)

### 3. Payment
- `POST /api/user/create-payment-intent` – create Stripe PaymentIntent for one-time upgrade?
- `POST /api/user/create-setup-intent` – create SetupIntent for saving payment method

### 4. Webhook
- `POST /api/webhooks/stripe` – handle Stripe events (subscription updates, payment success/failure)

## Stripe Integration

### Environment Variables
Add to `.env`:
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
```

### Flow
1. **User selects a plan** → Frontend calls `/api/user/subscription` with `plan_id`.
2. **Backend creates Stripe Checkout Session** (or Subscription) and returns session ID.
3. **Frontend redirects to Stripe Checkout**.
4. **After payment**, Stripe redirects back to frontend success/cancel URLs.
5. **Stripe webhook** updates subscription status in DB.

### Webhook Events to Handle
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

## Frontend Components

### New Components
1. **PlanCard** – displays plan details, price, features, subscribe button.
2. **SubscriptionStatus** – shows current plan, renewal date, cancel/upgrade options.
3. **BillingHistory** – table of past payments.
4. **PaymentMethod** – manage saved payment methods (via Stripe Elements).
5. **UpgradeFlow** – checkout page embedding Stripe Elements.

### Integration into Existing Pages
- **Settings Page**: Add a "Subscription" tab.
- **Admin Dashboard**: Add "Plans" and "Subscriptions" sections.

## User Experience Flow

1. **Free user** sees upgrade prompts (e.g., "Upgrade to unlock more connections").
2. **Click upgrade** → plan selection page.
3. **Select plan** → enter payment details via Stripe Checkout.
4. **Success** → redirect back to app with updated limits.
5. **Manage subscription** via settings page: cancel, change plan, update payment method.

## Admin Features

1. **Create/Edit Plans**: Set price, limits, features.
2. **View Subscriptions**: Filter by status, user.
3. **Manual Overrides**: Ability to assign a plan to a user manually (e.g., promo).
4. **Revenue Dashboard**: Monthly recurring revenue (MRR), churn.

## Security Considerations

1. **Webhook signature verification** – ensure events are from Stripe.
2. **Idempotency** – prevent duplicate processing of webhook events.
3. **User isolation** – users can only access their own subscription data.
4. **API rate limiting** – protect payment endpoints.
5. **No sensitive data in logs** – mask Stripe keys.

## Implementation Steps

### Phase 1: Database & Backend Core
1. Add new tables to SQLite schema (in `auth.js` init).
2. Create `stripe.js` module with Stripe client and helper functions.
3. Implement plans CRUD endpoints (admin).
4. Implement subscription endpoints (user).
5. Implement webhook endpoint with signature verification.

### Phase 2: Frontend Components
1. Create PlanCard, SubscriptionStatus components.
2. Add Subscription tab to Settings page.
3. Integrate Stripe.js for checkout.
4. Add admin pages for plans and subscriptions.

### Phase 3: Testing & Deployment
1. Test with Stripe test keys.
2. Simulate webhook events using Stripe CLI.
3. Deploy to staging, verify integration.
4. Go live with production Stripe keys.

## Migration Plan

1. Existing users keep their current role (`free`, `regular`, `admin`). Their limits are derived from role until they subscribe.
2. On subscription, user's effective limits become plan limits (role remains same? could keep role for admin purposes).
3. Add `plan_id` column to `users` table as cache (optional).
4. Write script to migrate existing `regular` users to a "Basic" plan.

## Cost Considerations

- Stripe charges 2.9% + $0.30 per transaction.
- No additional infrastructure cost.
- Consider VAT/tax handling (Stripe Tax).

## Timeline Estimate

- **Phase 1**: 3-5 days
- **Phase 2**: 2-3 days
- **Phase 3**: 1-2 days

Total: ~1.5 weeks of development.

## Next Steps

1. **Finalize plan details** with stakeholders (pricing, tiers).
2. **Set up Stripe account** and obtain API keys.
3. **Begin implementation** starting with database schema.

## Appendix: Example Plan Tiers

| Plan   | Price/mo | Connections | VOD Limit | EPG | Sync | Features |
|--------|----------|-------------|-----------|-----|------|----------|
| Free   | $0       | 2           | 500       | Yes | No   | Basic streaming |
| Basic  | $4.99    | 5           | Unlimited | Yes | Yes  | Favorites sync |
| Premium| $9.99    | 10          | Unlimited | Yes | Yes  | Priority support, No ads |