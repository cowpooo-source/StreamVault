# Stripe Standard Billing & Support Operational Runbook

This runbook documents the configuration, deployment, verification, reconciliation, and emergency rollback procedures for StreamVault Standard Billing and Entitlements.

---

## 1. Architecture & Security Guarantees

- **Disabled by Default**: `BILLING_ENABLED=false` is default. The system operates fully in free/legacy mode without Stripe.
- **Client-Side Encryption**: Portal credentials, passwords, and MAC addresses remain strictly AES-GCM encrypted in the client; server never handles or persists raw credentials.
- **Connection Privacy**: Connections stored in SQLite are identified solely via irreversible HMAC-SHA256 digests.
- **HTTPS Control Plane**: Billing, checkout, cancellation, refunds, customer portal, and support are exclusively accessible via the secure HTTPS app (`https://media.portalheaven.stream`). The HTTP player (`http://playerportal.hopto.org`) remains restricted to playback.
- **Permanent Base Roles**: `users.role` represents permanent account roles (`regular`, `admin`, `free`). Effective access is dynamically calculated from base roles + active entitlements without destructive SQL writes.

---

## 2. Stripe Dashboard Configuration

### A. Create Products & Prices (USD)

1. **Standard 30-Day Pass**
   - Name: `StreamVault Standard (30-Day Pass)`
   - Pricing model: One-off / Standard pricing
   - Amount: `$3.99 USD`
   - Set environment variable: `STRIPE_PRICE_STANDARD_PASS_30D=price_...`

2. **Standard Monthly Subscription**
   - Name: `StreamVault Standard (Monthly)`
   - Pricing model: Recurring / Monthly
   - Amount: `$2.99 USD / month`
   - Set environment variable: `STRIPE_PRICE_STANDARD_MONTHLY=price_...`

3. **Standard Yearly Subscription**
   - Name: `StreamVault Standard (Yearly)`
   - Pricing model: Recurring / Yearly
   - Amount: `$29.99 USD / year`
   - Set environment variable: `STRIPE_PRICE_STANDARD_YEARLY=price_...`

### B. Customer Portal Configuration

In Stripe Dashboard > Settings > Billing > Customer Portal:
- Enable "Cancel subscriptions" > **Cancel at end of billing period**.
- Enable "Update payment methods".
- Enable "View invoice history".
- Terms of service URL: `https://media.portalheaven.stream/legal/terms-v1.html`
- Privacy policy URL: `https://media.portalheaven.stream/legal/privacy-v1.html`

### C. Webhook Endpoint Setup

Create a webhook destination pointing to:
`https://media.portalheaven.stream/api/billing/webhook`

Subscribe to the following events:
- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `charge.refunded`
- `charge.dispute.created`

Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.

---

## 3. Environment Configuration

Add the following environment variables to `/etc/stalker-proxy.env` (or VPS `.env` file):

```bash
# Feature Flag (Default: false)
BILLING_ENABLED=true

# Stripe API Keys
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_LIVE_MODE=true
STRIPE_TAX_ENABLED=true

# Fixed Price IDs
STRIPE_PRICE_STANDARD_PASS_30D=price_...
STRIPE_PRICE_STANDARD_MONTHLY=price_...
STRIPE_PRICE_STANDARD_YEARLY=price_...

# Policy URLs & Versions
POLICY_TERMS_VERSION=v1
POLICY_TERMS_URL=https://media.portalheaven.stream/legal/terms-v1.html
POLICY_PRIVACY_VERSION=v1
POLICY_PRIVACY_URL=https://media.portalheaven.stream/legal/privacy-v1.html
POLICY_REFUND_VERSION=v1
POLICY_REFUND_URL=https://media.portalheaven.stream/legal/refund-v1.html

# Support & Notifications
SUPPORT_EMAIL=support@portalheaven.stream
SUPPORT_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

---

## 4. Operational Procedures

### A. Database Backup (Pre-deployment)

Before running migrations or enabling billing on VPS:
```bash
sqlite3 /var/lib/stalker-proxy/data.db ".backup '/var/backups/stalker-proxy-data-$(date +%Y%m%d%H%M%S).db'"
```

### B. Startup & Periodic Reconciliation

The server automatically runs:
- **Startup Sweep**: On service boot, activates scheduled passes, expires ended grants, sweeps past-due subscriptions with expired grace, and flushes outbox notifications.
- **Periodic Interval (10m)**: Reconciles local drift against bounded Stripe queries (`LIMIT 50`) and flags abandoned checkout orders older than 24 hours.
- **Outbox Interval (1m)**: Processes pending support emails and Discord alerts with exponential backoff.

### C. Targeted Manual & Administrative Reconciliation

Admins can trigger target-scoped reconciliation without impacting full server load:

```bash
# Reconcile specific user
curl -X POST https://media.portalheaven.stream/api/admin/reconcile \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"userId": 123}'

# Reconcile specific Stripe subscription
curl -X POST https://media.portalheaven.stream/api/admin/reconcile \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"stripeSubscriptionId": "sub_123"}'
```

### D. Emergency Rollback

If unexpected billing or webhook issues occur:
1. Edit `/etc/stalker-proxy.env` and set:
   ```bash
   BILLING_ENABLED=false
   ```
2. Restart the backend service:
   ```bash
   sudo systemctl restart stalker-proxy
   ```
3. Billing endpoints immediately return safe `billing_disabled` status (`503` / `400`), webhooks respond `404`, and existing IPTV streaming, login, and content sessions remain completely unaffected.

---

## 5. Verification & Release Gate Evidence

- **Backend Test Verification**: 38 test suites, 504/504 tests passing (`npm test` in `stalker-proxy`).
- **Frontend Test Verification**: 58 test suites, 516/516 tests passing (`npm test` in `streamvault`).
- **Linter Verification**: 0 errors across frontend codebase (`npm run lint` in `streamvault`).
- **Production Build**: Verified clean bundle generation with static policy asset emission (`npm run build` with `VITE_SECURE_APP_BASE_URL`).
- **End-to-End Coverage**: Verified mock-backed journeys covering Free checkout return, 30-Day Pass policy agreements, self-service refunds, Support ticket submission, and locked connection protection (`streamvault/e2e/billing-standard.spec.js`).
- **Zero Raw Credential Retention**: Verified AES-GCM client-side encryption and HMAC-SHA256 connection digests.
- **Fail-Safe Disabled Default**: Verified that with `BILLING_ENABLED=false`, all existing login, setup, content sessions, Stalker, Xtream, and M3U playback remain 100% operational.

